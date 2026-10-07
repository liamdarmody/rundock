'use strict';
// The filesystem adapter between the pure import evaluator and the atomic
// write primitive: it reads the real workspace and package source into the
// exact snapshot shape the evaluator validates, refuses bytes it cannot
// verify against the approval, and hands the complete eligible write set to
// writeAsUnit as one transaction. It never reinterprets a decision.
//
// The canonical content digests are defined HERE and exported, so the future
// plan module computes approval digests with the same functions this adapter
// uses to observe the filesystem. A digest never covers timestamps, inode
// identity or traversal order.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { evaluateImport, ABSENT_DIGEST } = require('./import-evaluate.js');
const { writeAsUnit, recoverPendingWrites } = require('../workspace/atomic-write.js');
const {
  readNormalisedFile, parseAgentFrontmatter, agentIsDefault, extractFrontmatterText, parseRoutines,
} = require('../agents/discovery.js');
const { parseRoutineBlocks, replaceApprovals, normalizeRoutine } = require('../agents/routines.js');
const { authoredDigest } = require('./package-fingerprint.js');
const { withRoutineState } = require('./routine-carry.js');
const { isDisplayName } = require('./display-name.js');

const DIGEST_VERSION = 'rundock-content-v1';
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function sha256(update) {
  const hash = crypto.createHash('sha256');
  update(hash);
  return `sha256:${hash.digest('hex')}`;
}

// A file digest covers its exact bytes plus the canonical file marker, so a
// file and a directory with coinciding content can never share a digest.
function digestFile(bytes) {
  return sha256((hash) => {
    hash.update(`${DIGEST_VERSION}:file\0`);
    hash.update(bytes);
  });
}

// A directory digest covers the sorted relative path and exact bytes of
// every regular file. Empty directories are not represented: the write
// primitive replaces a directory with exactly the files it is given, so an
// empty directory cannot survive an import and must not influence identity.
// Symlinks, devices and other entry types are refused, never followed.
function walkDirectory(root) {
  const files = [];
  const stack = [''];
  while (stack.length) {
    const relative = stack.pop();
    const absolute = path.join(root, relative.split('/').join(path.sep));
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new TypeError(`unsupported symlink at ${root}/${childRelative}`);
      if (entry.isDirectory()) stack.push(childRelative);
      else if (entry.isFile()) files.push(childRelative);
      else throw new TypeError(`unsupported filesystem entry type at ${root}/${childRelative}`);
    }
  }
  return files.sort();
}

function digestDirectory(root) {
  return digestTree(walkDirectory(root).map((relative) => ({
    relative, bytes: fs.readFileSync(path.join(root, relative.split('/').join(path.sep))),
  })));
}

// The directory digest over files already in memory, as `{ relative, bytes }`
// with forward-slash relative paths. digestDirectory reads the disk into
// exactly this, so a skill's fingerprint taken from the bytes a transaction
// writes and one taken from the folder afterwards are the same function.
function digestTree(files) {
  const sorted = files.slice().sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
  return sha256((hash) => {
    hash.update(`${DIGEST_VERSION}:dir\0`);
    for (const { relative, bytes } of sorted) {
      hash.update(`${relative}\0`);
      hash.update(digestFile(bytes));
      hash.update('\n');
    }
  });
}

// One fingerprint per routine an agent's bytes carry, in the order
// routinesCarried discloses them (both read the same parsed blocks). Taken
// over the routine's own parsed fields, keys sorted, under its own domain
// marker, so it changes when the routine is edited (in the Routines view or
// by hand) and not when the agent's body around it is, and it can never equal
// a file or directory digest.
function routineFingerprints(agentText) {
  return parseRoutineBlocks(extractFrontmatterText(String(agentText).replace(/\r\n/g, '\n')))
    .map((block) => sha256((hash) => {
      hash.update(`${DIGEST_VERSION}:routine\0`);
      hash.update(JSON.stringify(Object.keys(block).sort().map((key) => [key, block[key]])));
    }));
}

// What is at a path right now, as a digest: the absent sentinel, a file
// digest, or a directory digest. A symlink or special file is refused.
function digestAt(absolute) {
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch (e) {
    // ENOENT is absence; ENOTDIR is a file where a parent dir belongs, below
    // which nothing can exist. Every other failure is a failed observation,
    // not a fact, and reporting it as absence turns a collision into an
    // unreviewed overwrite: it aborts instead.
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return ABSENT_DIGEST;
    throw e;
  }
  if (stat.isFile()) return digestFile(fs.readFileSync(absolute));
  if (stat.isDirectory()) return digestDirectory(absolute);
  throw new TypeError(`unsupported filesystem entry type at ${absolute}`);
}

// Where an item lands in the workspace, and where it is read from in the
// package. Agents and skills sit in the package exactly where they land; a
// starter file sits under the package's `starter/` folder, which mirrors the
// workspace, so `starter/Investments/Portfolio.md` lands at
// `Investments/Portfolio.md`.
const STARTER_DIR = 'starter';
function itemDestination(kind, slug) {
  if (kind === 'starter') return slug;
  return kind === 'agent' ? `.claude/agents/${slug}.md` : `.claude/skills/${slug}`;
}
function itemSourcePath(kind, slug) {
  return kind === 'starter' ? `${STARTER_DIR}/${slug}` : itemDestination(kind, slug);
}

// A starter file's path when something other than an ordinary file or an
// absence is in the way: a symlink at the path or on any folder above it, or
// a file standing where one of those folders belongs. Such a path is TAKEN,
// never written through, so it reads as a collision the plan keeps; its own
// domain marker means it can never equal the digest of real content. Observed
// by lstat all the way down, so nothing outside the workspace is ever read.
function takenDigest(relative) {
  return sha256((hash) => {
    hash.update(`${DIGEST_VERSION}:taken\0`);
    hash.update(relative);
  });
}
function starterDigestAt(workspace, relative) {
  const segments = relative.split('/');
  let current = workspace;
  for (let i = 0; i < segments.length; i++) {
    current = path.join(current, segments[i]);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (e) {
      if (e.code === 'ENOENT') return ABSENT_DIGEST;
      if (e.code === 'ENOTDIR') return takenDigest(relative);
      throw e;
    }
    const last = i === segments.length - 1;
    // lstat never follows, so a symlink is neither a directory nor a file
    // here, and the two rules below already read it as taken wherever it
    // stands: on the way down or at the path itself.
    if (!last && !stat.isDirectory()) return takenDigest(relative);
    if (last) return stat.isFile() ? digestFile(fs.readFileSync(current)) : stat.isDirectory() ? digestDirectory(current) : takenDigest(relative);
  }
  return ABSENT_DIGEST;
}

function toAbsolute(root, relative) {
  return path.join(root, relative.split('/').join(path.sep));
}

// The provenance transformation an imported agent receives: a `source:` line
// recording where it came from, informational only. An existing source value
// is never overwritten, and the transformation is deterministic so the plan
// side derives the approved digest from exactly these bytes.
//
// It also replaces every routine approval the package ships
// (withRundockApprovals), for the reason every agent path already composes
// this function last before the person's carried switches: install, re-point,
// adoption and update all land through it, so no path can reach the
// workspace carrying an approval its author wrote.
function withProvenance(text, sourceId) {
  return withRundockApprovals(addProvenance(text, sourceId));
}

function addProvenance(text, sourceId) {
  // A leading byte-order mark is dropped in every branch: the product's
  // frontmatter reader does not tolerate one, and an imported agent must be
  // readable by the product that imported it.
  const rest = text.startsWith('\ufeff') ? text.slice(1) : text;
  const open = /^---\r?\n/.exec(rest);
  if (!open) return `---\nsource: ${sourceId}\n---\n\n${rest}`;
  const eol = open[0].slice(3); // the file's own line ending
  const close = /\r?\n---(\r?\n|$)/.exec(rest.slice(open[0].length));
  if (!close) throw new Error('agent frontmatter opens but never closes; refusing to transform');
  const closeIndex = open[0].length + close.index;
  if (/^source:/m.test(rest.slice(open[0].length, closeIndex))) return rest;
  return `${rest.slice(0, closeIndex)}${eol}source: ${sourceId}${rest.slice(closeIndex)}`;
}

// APPROVALS NEVER TRAVEL WITH A PACKAGE. A routine's approval is a field in
// the agent file, so an author could ship one that matches the plan and the
// routine would run unattended in every workspace without anybody agreeing
// to it. Whatever the package carries is replaced: a routine the install or
// update card says will run itself (switched on, with a schedule: the card's
// own "runs itself" sentence) is approved by Rundock, over the plan that
// lands, because agreeing to that card is agreeing to it running; every other
// routine waits for its first approval in Routines. On an update, the
// person's own approval is carried over this afterwards (routine-carry.js),
// so a plan the author changed no longer matches it and waits. Deterministic,
// so the plan side's approved digest covers it. A file with no routines is
// returned byte for byte.
function withRundockApprovals(text) {
  const crlf = text.includes('\r\n');
  const normal = crlf ? text.replace(/\r\n/g, '\n') : text;
  const fm = /^---\n([\s\S]*?)\n---/.exec(normal);
  if (!fm || parseRoutineBlocks(fm[1]).length === 0) return text;
  if (crlf && /(^|[^\r])\n/.test(text)) {
    throw new Error('agent mixes line endings around its routines; refusing to transform');
  }
  const next = replaceApprovals(normal, runsItself);
  return crlf ? next.replace(/\n/g, '\r\n') : next;
}

// THE CARD'S "RUNS ITSELF": a routine its author switched on, with a
// schedule. The same test the disclosure makes (routinesCarried), so the
// card's sentence and the approval can never disagree.
function runsItself(routine) {
  const unquote = (value) => String(value).trim()
    .replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').trim();
  return routine.enabled === true
    && typeof routine.schedule === 'string' && unquote(routine.schedule) !== '';
}

// Which routines in an author's agent file the card says will run
// themselves, by name and which namesake: the only ones agreeing to the card
// approves.
function routinesRunningThemselves(text) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(String(text).replace(/\r\n/g, '\n'));
  if (!fm) return [];
  const seen = new Map();
  const out = [];
  for (const raw of parseRoutineBlocks(fm[1])) {
    const routine = normalizeRoutine(raw);
    const occurrence = seen.get(routine.name) || 0;
    seen.set(routine.name, occurrence + 1);
    if (runsItself(routine)) out.push({ name: routine.name, occurrence });
  }
  return out;
}

// The org-chart re-point, a SIBLING transform to withProvenance: rewrite the
// frontmatter's reportsTo value to name the workspace's existing leader, so
// a dependant arriving without its own orchestrator hangs under that leader
// instead of floating to the root as its peer. Deterministic for the same
// reason as withProvenance: the plan side derives a re-pointed dependant's
// approved digest from exactly these bytes, composed in the same order the
// writer composes them (re-point first, then provenance). The same care too:
// a leading BOM is dropped in every branch, the file's own line endings are
// kept (the matched line stops before its own terminator), and an agent this
// cannot transform is a refusal, never a silent pass-through.
function withReportsTo(text, leader) {
  const rest = text.startsWith('\ufeff') ? text.slice(1) : text;
  const open = /^---\r?\n/.exec(rest);
  if (!open) throw new Error('agent has no frontmatter carrying reportsTo; refusing to re-point');
  const close = /\r?\n---(\r?\n|$)/.exec(rest.slice(open[0].length));
  if (!close) throw new Error('agent frontmatter opens but never closes; refusing to transform');
  const closeIndex = open[0].length + close.index;
  const line = /^reportsTo:[^\r\n]*/m.exec(rest.slice(open[0].length, closeIndex));
  if (!line) throw new Error('agent carries no reportsTo line; refusing to re-point');
  const at = open[0].length + line.index;
  return `${rest.slice(0, at)}reportsTo: ${leader}${rest.slice(at + line[0].length)}`;
}

// The adoption transform, the third sibling: turn a package's own leader
// into a specialist reporting to the workspace's existing leader, leaving
// its dependants exactly as their author wrote them. Three frontmatter facts
// change and nothing else does: an existing type line becomes specialist (so
// the prompt builder stops handing it the orchestrator manual), an order
// line leaves 0 (which is what makes an agent the default), an isDefault
// line becomes false for the same reason, and reportsTo names the leader,
// rewritten in place or added before the close. Deterministic like its
// siblings: same BOM drop, same kept line endings, and the plan side derives
// the adopted digest from exactly these bytes composed in the writer's
// order. The postcondition is the transform's whole point, so bytes it
// cannot make non-default are a refusal, never a silent pass-through.
function withAdoption(text, leader) {
  const rest = text.startsWith('\ufeff') ? text.slice(1) : text;
  const open = /^---\r?\n/.exec(rest);
  if (!open) throw new Error('agent has no frontmatter to adopt through; refusing to adopt');
  const eol = open[0].slice(3);
  const close = /\r?\n---(\r?\n|$)/.exec(rest.slice(open[0].length));
  if (!close) throw new Error('agent frontmatter opens but never closes; refusing to transform');
  const head = rest.slice(open[0].length, open[0].length + close.index)
    .replace(/^type:[^\r\n]*/m, 'type: specialist')
    .replace(/^order:[^\r\n]*/m, 'order: 1')
    .replace(/^isDefault:[^\r\n]*/m, 'isDefault: false');
  const pointed = /^reportsTo:/m.test(head)
    ? head.replace(/^reportsTo:[^\r\n]*/m, `reportsTo: ${leader}`)
    : `${head}${eol}reportsTo: ${leader}`;
  const adopted = `${open[0]}${pointed}${rest.slice(open[0].length + close.index)}`;
  if (agentIsDefault(parseAgentFrontmatter(adopted.replace(/\r\n/g, '\n')))) {
    throw new Error('adopted agent still reads as a default; refusing to adopt');
  }
  return adopted;
}

// The routines an agent's bytes carry, in the shape every disclosure of them
// uses: the plan's offer, the extension trust step's facts, and the receipt
// all read through this one function, so what is disclosed can never be
// computed three different ways. The parser is the scheduler's own
// (parseRoutines, reached through agent discovery), which is the point: a
// routine the scheduler would run is a routine the person was told about,
// and a block the scheduler cannot read is not presented as one that runs.
// Only the fields a disclosure states are kept; the schedule is unquoted the
// way the parser unquotes every other string field, because the person is
// shown words, never a file's quoting style.
function routinesCarried(agentText, owner) {
  const unquote = (value) => String(value).trim()
    .replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').trim();
  return parseRoutines(extractFrontmatterText(agentText.replace(/\r\n/g, '\n')), { owner })
    .map((routine) => ({
      name: routine.name,
      schedule: typeof routine.schedule === 'string' && unquote(routine.schedule) !== ''
        ? unquote(routine.schedule) : null,
      enabled: routine.enabled === true,
    }));
}

// The exact `current` snapshot shape the evaluator validates: one digest per
// approval destination, one digest per present source item, and every
// canonically-named agent in the workspace with its default membership.
// The evaluator's contract admits only canonical slug destinations, so a
// non-slug agent file cannot be represented. Omitting one is provably
// harmless while it is not a default (the projection only counts defaults),
// and a refusal when it IS one, so an unrepresentable default can never let
// an import create a second default.
function snapshotCurrent(workspace, sourceRoot, approval) {
  if (!approval || !Array.isArray(approval.items) || !Array.isArray(approval.manifest)) {
    throw new TypeError('approval must carry items and manifest arrays');
  }
  const destinations = [];
  const seen = new Set();
  for (const item of approval.items) {
    if (!item || typeof item.destination !== 'string' || seen.has(item.destination)) continue;
    seen.add(item.destination);
    destinations.push({
      destination: item.destination,
      digest: item.kind === 'starter'
        ? starterDigestAt(workspace, item.destination)
        : digestAt(toAbsolute(workspace, item.destination)),
    });
  }
  const sources = [];
  for (const entry of approval.manifest) {
    if (!entry || typeof entry.id !== 'string') continue;
    const absolute = toAbsolute(sourceRoot, itemSourcePath(entry.kind, entry.slug));
    const digest = digestAt(absolute);
    if (digest !== ABSENT_DIGEST) sources.push({ id: entry.id, digest });
  }
  const agents = [];
  const agentsDir = path.join(workspace, '.claude', 'agents');
  let names = [];
  try {
    names = fs.readdirSync(agentsDir);
  } catch (e) {
    // Only a missing directory means no agents: an empty set from a failed
    // read could hide an existing default from the projection.
    if (e.code !== 'ENOENT') throw e;
  }
  for (const name of names.sort()) {
    if (!name.endsWith('.md')) continue;
    const absolute = path.join(agentsDir, name);
    let stat;
    try {
      stat = fs.lstatSync(absolute);
    } catch (e) {
      if (e.code === 'ENOENT') continue; // removed since the readdir: absent
      throw e;
    }
    if (!stat.isFile()) throw new TypeError(`unsupported filesystem entry type at ${absolute}`);
    const isDefault = agentIsDefault(parseAgentFrontmatter(readNormalisedFile(absolute)));
    if (!SLUG.test(name.slice(0, -3))) {
      if (isDefault) {
        throw new TypeError(`agent file ${name} declares default membership but is outside canonical naming, so default validity cannot be evaluated`);
      }
      continue;
    }
    agents.push({
      destination: `.claude/agents/${name}`,
      digest: digestFile(fs.readFileSync(absolute)),
      isDefault,
    });
  }
  return { destinations, sources, agents };
}

// One eligible write, turned into verified bytes. The digests recorded at
// approval time are the authority: bytes that do not hash to them are never
// written, whatever the reason for the difference.
function materialise(sourceRoot, sourceId, write) {
  const absolute = toAbsolute(sourceRoot, itemSourcePath(write.kind, write.id.slice(write.kind.length + 1)));
  if (write.kind === 'starter') {
    // Byte for byte as the author wrote it: no transform, so the approved
    // digest must be the source digest itself.
    const source = fs.readFileSync(absolute);
    if (digestFile(source) !== write.sourceDigest) {
      throw new Error(`source for ${write.id} changed after approval; refusing to write`);
    }
    if (write.approvedDigest !== write.sourceDigest) {
      throw new Error(`bytes for ${write.id} do not match the approved digest; refusing to write`);
    }
    return { file: source };
  }
  if (write.kind === 'agent') {
    const source = fs.readFileSync(absolute);
    if (digestFile(source) !== write.sourceDigest) {
      throw new Error(`source for ${write.id} changed after approval; refusing to write`);
    }
    // The re-point or adoption rides ahead of provenance, so the bytes
    // entering the provenance line below already carry it: one composition
    // order, shared with the plan side, and the approved-digest check covers
    // the result. The evaluator refuses an item carrying both, so the order
    // of these two branches decides nothing.
    const bytes = write.adoptUnder
      ? Buffer.from(withAdoption(source.toString('utf8'), write.adoptUnder), 'utf8')
      : write.attachTo
        ? Buffer.from(withReportsTo(source.toString('utf8'), write.attachTo), 'utf8')
        : source;
    const transformed = Buffer.from(withProvenance(bytes.toString('utf8'), sourceId), 'utf8');
    // An update carries the person's routine switches onto the author's
    // bytes (routine-carry.js), last, so the digest check covers it too.
    const landed = write.routineState
      ? Buffer.from(withRoutineState(transformed.toString('utf8'), write.routineState), 'utf8') : transformed;
    if (digestFile(landed) !== write.approvedDigest) {
      throw new Error(`bytes for ${write.id} do not match the approved digest; refusing to write`);
    }
    return { file: landed };
  }
  if (digestDirectory(absolute) !== write.sourceDigest) {
    throw new Error(`source for ${write.id} changed after approval; refusing to write`);
  }
  if (write.approvedDigest !== write.sourceDigest) {
    throw new Error(`bytes for ${write.id} do not match the approved digest; refusing to write`);
  }
  return {
    files: walkDirectory(absolute).map((relative) => ({
      rel: relative.split('/').join(path.sep),
      content: fs.readFileSync(path.join(absolute, relative.split('/').join(path.sep))),
    })),
  };
}

// Snapshot, evaluate, and execute exactly what the evaluator allows, as one
// transaction. Recovery of any interrupted prior transaction comes first, so
// the snapshot never observes a half-committed workspace.
// The receipt an apply leaves behind, per the receipts addendum: history,
// never authority. One entry per item with its outcome, recorded in the
// same transaction as the content writes and only there.
const RECEIPTS_DIR = '.rundock/receipts';

// The receipt entry for an item the package no longer carries: outcome
// "kept" and inPackage false, the one shape no offered item can take.
function retiredEntries(retired) {
  return (Array.isArray(retired) ? retired : [])
    .filter((r) => r && typeof r.id === 'string' && typeof r.kind === 'string' && typeof r.destination === 'string')
    .map((r) => ({ id: r.id, kind: r.kind, destination: r.destination, outcome: 'kept', inPackage: false }));
}

// An update names the release it moved from and to; only then is it one.
function namesRelease(update) {
  return !!update && typeof update.from === 'string' && typeof update.to === 'string';
}

function buildReceipt(approval, evaluation, appliedAt, routinesById, fingerprintsById, authoredById, commit, update, displayName) {
  // Each entry records the decision that governed it, beside its outcome, so
  // a later import can say what was decided last time rather than guessing
  // from bytes. Additive to the v1 schema: readers that ignore it lose
  // nothing, and history stays history, never authority.
  //
  const decisions = new Map(approval.items.map((item) => [item.id, item.decision]));
  const transformsById = new Map(approval.items
    .filter((item) => item.kind === 'agent' && item.agent && (item.agent.adoptUnder || item.agent.attachTo))
    .map((item) => [item.id, item.agent.adoptUnder ? { adoptUnder: item.agent.adoptUnder } : { attachTo: item.agent.attachTo }]));
  const entry = (outcome) => (o) => ({ id: o.id, kind: o.kind, destination: o.destination, decision: decisions.get(o.id), outcome });
  const items = [
    ...evaluation.writes.map(entry('written')),
    ...evaluation.unchanged.map(entry('unchanged')),
    ...evaluation.skipped.map(entry('skipped')),
    ...evaluation.blocked.map(entry('blocked')),
    // What an update's new version no longer carries: kept where it
    // is, nothing written, and marked so a reader never counts it among the
    // package's contents. No fingerprint, so the last base stands.
    ...retiredEntries(update && update.retired),
  ].sort((a, b) => (a.id < b.id ? -1 : 1));
  // An arrived agent's routines ride on its entry, because the receipt links
  // them one moment after the offer disclosed them, and a receipt that lost
  // them would make that disclosure look like it was never true. Only an
  // entry that has routines carries the key: absence keeps the shape every
  // existing receipt already has, and is itself the honest record.
  for (const item of items) {
    const routines = routinesById && routinesById.get(item.id);
    if (routines && routines.length) item.routines = routines;
    // WHAT THE BYTES WERE, for the entries that are in the workspace after
    // this apply. Additive to v1, and still history rather than authority: a
    // later update uses it to tell the author's change from the person's
    // edit, and re-observes the live bytes before it acts on anything.
    const fingerprint = fingerprintsById && fingerprintsById.get(item.id);
    if (fingerprint) item.fingerprint = fingerprint;
    // What an update compares (routine state Rundock writes left out), and
    // the transform the bytes were written with, so an update re-applies it
    // rather than undoing an adoption or a re-point.
    const authored = fingerprint && authoredById && authoredById.get(item.id);
    if (authored) item.authored = authored;
    const agent = fingerprint && transformsById.get(item.id);
    if (agent) item.transform = agent;
  }
  return {
    schema: RECEIPT_SCHEMA,
    // The commit the install fetched, so an update knows exactly what is
    // installed whatever the reference was called. Only a full commit id.
    source: typeof commit === 'string' && /^[0-9a-f]{40}$/.test(commit)
      ? { ...approval.source, commit } : approval.source,
    appliedAt,
    // What the package calls itself, when its rundock.json says.
    ...(isDisplayName(displayName) ? { displayName: displayName.trim() } : {}),
    // An update names the release it moved from and to.
    ...(namesRelease(update) ? { update: { from: update.from, to: update.to } } : {}),
    items,
  };
}

// Snapshot, then evaluate: the one sequence by which anything reaches the
// evaluator with live workspace facts. The evaluate handler uses it for the
// review's projection and applyImport uses it after recovery, so the two
// can never drift into judging the same approval differently. It writes
// nothing, which is why recovery stays outside it: recovery writes, and a
// projection must leave the workspace exactly as it found it.
function evaluateApproval(workspace, sourceRoot, approval) {
  const current = snapshotCurrent(workspace, sourceRoot, approval);
  return evaluateImport(approval, current);
}

function applyImport(workspace, sourceRoot, approval, options = {}) {
  recoverPendingWrites(workspace);
  const evaluation = evaluateApproval(workspace, sourceRoot, approval);
  if (evaluation.status !== 'ready') return { ...evaluation, written: [], receipt: null };

  const writes = [];
  const replaceDirs = [];
  // The routines each arriving agent carries, read for the receipt from the
  // exact bytes this transaction lands: the verified write payload for a
  // written agent, and the workspace's own file, already at the approved
  // bytes, for an unchanged one. Reading anything else here would let the
  // record drift from what actually runs.
  const routinesById = new Map();
  // The fingerprint of each item as written, taken from the verified payload
  // this transaction lands, or for an unchanged item from the workspace's own
  // bytes, which already equal the approved ones.
  const fingerprintsById = new Map();
  const authoredById = new Map();
  const withFingerprints = (text, owner) => {
    const fingerprints = routineFingerprints(text);
    return routinesCarried(text, owner).map((routine, i) => ({ ...routine, fingerprint: fingerprints[i] }));
  };
  for (const write of evaluation.writes) {
    const payload = materialise(sourceRoot, approval.source.id, write);
    const destination = toAbsolute(workspace, write.destination);
    if (payload.file) writes.push({ path: destination, content: payload.file });
    else replaceDirs.push({ path: destination, files: payload.files });
    fingerprintsById.set(write.id, payload.file
      ? digestFile(payload.file)
      : digestTree(payload.files.map((f) => ({ relative: f.rel.split(path.sep).join('/'), bytes: f.content }))));
    authoredById.set(write.id, authoredDigest(write.kind, payload.file, fingerprintsById.get(write.id)));
    if (write.kind === 'agent' && payload.file) {
      routinesById.set(write.id, withFingerprints(payload.file.toString('utf8'), write.id.split(':')[1]));
    }
  }
  for (const outcome of evaluation.unchanged) {
    const destination = toAbsolute(workspace, outcome.destination);
    fingerprintsById.set(outcome.id, outcome.kind === 'starter'
      ? starterDigestAt(workspace, outcome.destination) : digestAt(destination));
    authoredById.set(outcome.id, authoredDigest(outcome.kind,
      outcome.kind === 'agent' ? fs.readFileSync(destination) : null, fingerprintsById.get(outcome.id)));
    if (outcome.kind !== 'agent') continue;
    routinesById.set(outcome.id, withFingerprints(fs.readFileSync(destination, 'utf8'), outcome.id.split(':')[1]));
  }
  // The receipt exists exactly when the transaction that carries it lands:
  // one more file write in the same unit. It is written whenever a person
  // confirmed decisions, which is any outcome written or skipped, so an
  // all-skip apply is remembered. Only a pure replay, every item already at
  // its approved bytes, writes none: nothing was decided, and the filesystem
  // cannot prove who wrote already-approved bytes. A confirmed update is
  // always a decision, even when every item matches or only items leave: its
  // receipt is what names the new release, and without one the package keeps
  // its old version and keeps offering the update it has just applied.
  let receipt = null;
  if (options.receipt && (evaluation.writes.length > 0 || evaluation.skipped.length > 0 || namesRelease(options.receipt.update))) {
    const appliedAt = options.receipt.now || new Date().toISOString();
    const run = options.receipt.run || Math.random().toString(36).slice(2, 8);
    receipt = `${RECEIPTS_DIR}/${appliedAt.slice(0, 10)}-${run}.json`;
    writes.push({
      path: toAbsolute(workspace, receipt),
      content: `${JSON.stringify(buildReceipt(approval, evaluation, appliedAt, routinesById, fingerprintsById, authoredById, options.receipt.commit, options.receipt.update, options.receipt.displayName), null, 2)}\n`,
    });
  }
  // What an update writes beside the items (the extension, the review
  // copies, the backups), asked for only once the evaluation is ready, and
  // written in this same transaction so the update lands whole or not at all.
  if (typeof options.extra === 'function') {
    const more = options.extra(evaluation) || {};
    writes.push(...(more.writes || []));
    replaceDirs.push(...(more.replaceDirs || []));
  }
  const result = writeAsUnit(workspace, writes, { replaceDirs, afterStep: options.afterStep });
  // THE INSTALL CARD IS CONSENT HERE, to what it said, and nothing more:
  // each routine the AUTHOR's file switches on with a schedule (the card's
  // "runs itself") is recorded as approved in this workspace, now
  // (lib/agents/approval-store.js). Never an approval field carried over from
  // the workspace's own file on an update: that field is something an agent
  // could have written, and a carried routine keeps whatever this install
  // already recorded for it, which lapses by itself if the plan changed.
  // Nowhere else: a copy of this workspace has no such record.
  const consentAt = require('../scheduler.js').schedulerNow().toISOString();
  for (const write of evaluation.writes) {
    if (write.kind !== 'agent') continue;
    const authored = fs.readFileSync(toAbsolute(sourceRoot, itemSourcePath(write.kind, write.id.slice(write.kind.length + 1))), 'utf8');
    require('../agents/approval-locality.js').recordFileApprovals(workspace, String(write.destination).split(path.sep).join('/'), consentAt,
      routinesRunningThemselves(authored));
  }
  return { ...evaluation, written: result.written, receipt };
}

const RECEIPT_SCHEMA = 'rundock.package-import-receipt/v1';

module.exports = {
  RECEIPTS_DIR, RECEIPT_SCHEMA,
  applyImport,
  evaluateApproval,
  snapshotCurrent,
  digestFile,
  digestDirectory,
  withProvenance,
  withRundockApprovals,
  withReportsTo,
  withAdoption,
  routinesCarried,
  routineFingerprints,
  digestTree,
  itemDestination,
  itemSourcePath, routinesRunningThemselves,
  STARTER_DIR,
};
