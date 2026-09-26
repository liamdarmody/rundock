'use strict';
// Discovery and immutable plan construction for package import: read a
// package source tree into the deterministic manifest of what it offers, and
// combine that with the live workspace into the JSON-serialisable plan a
// person reviews. A plan item plus a decision is exactly the approval item
// the evaluator on main validates; this module writes nothing, decides
// nothing and never invents a source identity.
//
// Every digest, provenance byte and default-membership reading comes from
// the functions the apply adapter itself exports and uses, so what the plan
// promises and what apply verifies can never be computed two different ways.

const fs = require('node:fs');
const path = require('node:path');

const { snapshotCurrent, digestFile, digestDirectory, withProvenance, withReportsTo, withAdoption, routinesCarried, itemDestination, STARTER_DIR } = require('./import-apply.js');
const { ABSENT_DIGEST, APPROVAL_SCHEMA, isStarterPath } = require('./import-evaluate.js');
const { parseAgentFrontmatter, agentIsDefault, readNormalisedFile } = require('../agents/discovery.js');

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function refuse(message, code) {
  const error = new TypeError(`package discovery refused: ${message}`);
  error.code = code || 'package-refused';
  throw error;
}

function assertDirectory(root, label) {
  if (typeof root !== 'string' || root.length === 0) refuse(`${label} must be a non-empty path`);
  let stat;
  try {
    stat = fs.lstatSync(root);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') refuse(`${label} does not exist`);
    throw e;
  }
  if (!stat.isDirectory()) refuse(`${label} must be a directory`);
}

// A container directory (.claude, .claude/agents, .claude/skills) observed
// without following links: absent is fine, a symlink or non-directory is a
// named refusal, and any other failed observation aborts.
function assertContainer(root, relative) {
  let stat;
  try {
    stat = fs.lstatSync(path.join(root, relative.split('/').join(path.sep)));
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false;
    throw e;
  }
  if (stat.isSymbolicLink()) refuse(`${relative} is a symlink`);
  if (!stat.isDirectory()) refuse(`${relative} is not a directory`);
  return true;
}

// Entries of one source directory, refused rather than skipped when they do
// not fit the shape an item of this kind must have. Only ENOENT-class
// absence reads as absence; a failed observation aborts.
function readEntries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

// Every entry at every depth of a skill tree, observed link-preservingly:
// a symlink or special file anywhere in the item is a named refusal, so no
// digest is ever taken over contents that were not validated here.
function assertSkillTree(root, relative) {
  for (const entry of readEntries(path.join(root, relative.split('/').join(path.sep)))) {
    const child = `${relative}/${entry.name}`;
    if (entry.isSymbolicLink()) refuse(`${child} is a symlink`);
    if (entry.isDirectory()) assertSkillTree(root, child);
    else if (!entry.isFile()) refuse(`${child} is an unsupported entry type`);
  }
}

function itemPath(root, kind, slug) {
  return kind === 'agent'
    ? path.join(root, '.claude', 'agents', `${slug}.md`)
    : path.join(root, '.claude', 'skills', slug);
}

// The deterministic source manifest: one entry per offered agent and skill,
// sorted by id. Non-slug names, symlinks and unsupported entry types are
// named refusals, never silent drops, because a plan that quietly offers
// less than the package holds is how content escapes review.
function discoverPackage(sourceRoot) {
  assertDirectory(sourceRoot, 'source root');
  assertContainer(sourceRoot, '.claude');
  assertContainer(sourceRoot, '.claude/agents');
  assertContainer(sourceRoot, '.claude/skills');
  const entries = [];
  for (const entry of readEntries(path.join(sourceRoot, '.claude', 'agents'))) {
    if (entry.isSymbolicLink()) refuse(`agents/${entry.name} is a symlink`);
    if (!entry.isFile()) refuse(`agents/${entry.name} is not a regular file`);
    if (!entry.name.endsWith('.md') || !SLUG.test(entry.name.slice(0, -3))) {
      refuse(`agents/${entry.name} is not a canonical agent file name`);
    }
    const slug = entry.name.slice(0, -3);
    entries.push({
      id: `agent:${slug}`,
      kind: 'agent',
      slug,
      sourceDigest: digestFile(fs.readFileSync(itemPath(sourceRoot, 'agent', slug))),
    });
  }
  for (const entry of readEntries(path.join(sourceRoot, '.claude', 'skills'))) {
    if (entry.isSymbolicLink()) refuse(`skills/${entry.name} is a symlink`);
    if (!entry.isDirectory()) refuse(`skills/${entry.name} is not a directory`);
    if (!SLUG.test(entry.name)) refuse(`skills/${entry.name} is not a canonical skill name`);
    assertSkillTree(sourceRoot, `.claude/skills/${entry.name}`);
    entries.push({
      id: `skill:${entry.name}`,
      kind: 'skill',
      slug: entry.name,
      sourceDigest: digestDirectory(itemPath(sourceRoot, 'skill', entry.name)),
    });
  }
  // Starter files ride with agents and skills: a repository holding only a
  // starter/ folder is not a package, whatever else it is.
  if (entries.length === 0) refuse('the package contains no agents and no skills', 'empty-package');
  entries.push(...discoverStarterFiles(sourceRoot));
  return entries.sort((a, b) => (a.id < b.id ? -1 : 1));
}

// STARTER FILES: every regular file under starter/, at any depth, becomes an
// item landing at the same path relative to the workspace. Refused by name,
// never skipped, for the same reason as every other refusal here: a hidden
// path (a .gitkeep included), a symlink, a special file, or a name the
// evaluator's path rule would not accept. Two paths that differ only by case
// are refused too, because on the filesystems most people use they are one
// file, and the second write would land on the first.
function discoverStarterFiles(sourceRoot) {
  if (!assertContainer(sourceRoot, STARTER_DIR)) return [];
  const found = [];
  const walk = (relative) => {
    for (const entry of readEntries(path.join(sourceRoot, STARTER_DIR, ...relative.split('/').filter(Boolean)))) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      const shown = `${STARTER_DIR}/${child}`;
      if (entry.name.startsWith('.')) refuse(`${shown} is a hidden path, and starter files never land in one`);
      if (entry.isSymbolicLink()) refuse(`${shown} is a symlink`);
      if (entry.isDirectory()) walk(child);
      else if (!entry.isFile()) refuse(`${shown} is an unsupported entry type`);
      else if (!isStarterPath(child)) refuse(`${shown} is not a name a starter file can have`);
      else found.push(child);
    }
  };
  walk('');
  const folded = new Map();
  for (const rel of found) {
    const key = rel.toLowerCase();
    if (folded.has(key)) refuse(`${STARTER_DIR}/${folded.get(key)} and ${STARTER_DIR}/${rel} differ only by case`);
    folded.set(key, rel);
  }
  return found.map((rel) => ({
    id: `starter:${rel}`,
    kind: 'starter',
    slug: rel,
    sourceDigest: digestFile(fs.readFileSync(path.join(sourceRoot, STARTER_DIR, ...rel.split('/')))),
  }));
}

// FRONTMATTER THAT ACTS WITHOUT ASKING. An agent or skill file can carry
// settings Claude Code acts on directly: `hooks` runs shell commands at
// lifecycle events, which are not tool calls and so never reach a permission
// card; `permissionMode` can switch the asking off; `allowed-tools`
// pre-approves tools; `mcpServers` starts servers. A package that carries one
// can do more than "the same access your own agents have", so the offer names
// them before anyone agrees. `tools` is left out on purpose: it narrows what
// an agent may use rather than widening it. Read as top-level keys of the
// leading frontmatter block only, the way the runtime reads them.
const UNASKED_KEYS = ['hooks', 'permissionMode', 'allowed-tools', 'mcpServers'];
function actsWithoutAsking(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''));
  if (!m) return [];
  const present = new Set();
  for (const line of m[1].split(/\r?\n/)) {
    const key = /^([A-Za-z][A-Za-z0-9_-]*)\s*:/.exec(line);
    if (key && UNASKED_KEYS.includes(key[1])) present.add(key[1]);
  }
  return UNASKED_KEYS.filter((k) => present.has(k));
}
function unaskedFor(sourceRoot, kind, slug) {
  const file = kind === 'agent' ? itemPath(sourceRoot, 'agent', slug) : path.join(itemPath(sourceRoot, 'skill', slug), 'SKILL.md');
  try { return actsWithoutAsking(fs.readFileSync(file, 'utf8')); } catch (e) { return []; }
}

function sourceAgentText(absolute) {
  return fs.readFileSync(absolute, 'utf8');
}

// The default membership of the approved bytes, read the way the product
// will read them back after apply writes them. readNormalisedFile is
// file-bound, so its transform is replicated here for in-memory text; the
// test "the plan's approved default equals the product's file-based reading
// of the approved bytes" writes the exact approved bytes to disk and reads
// them through readNormalisedFile itself, so a drift between the two
// transforms turns the focused suite red.
function approvedDefaultOf(approvedText) {
  return agentIsDefault(parseAgentFrontmatter(approvedText.replace(/\r\n/g, '\n')));
}

// The plan-side facts for a package's default agent. A package can carry its own default agent with
// dependants naming it through reportsTo; skipped into a workspace that
// already has a leader, those dependants would arrive pointing at an agent
// that never landed and the chart would seat them at the root, beside the
// leader. So when the workspace has a default of its own, the plan records
// the second way out beside skipping: on the incoming default, the offer
// (who the existing leader is, and which dependants would follow), and on
// each dependant, the digest of the bytes a re-point to that leader would
// write, derived from exactly the composition the apply adapter performs
// (withReportsTo, then withProvenance). The decision contract selects these
// facts; nothing here decides anything.
function attachFacts(workspace, sourceRoot, sourceId, current, items) {
  const leaderEntry = current.agents.find((agent) => agent.isDefault);
  if (!leaderEntry) return;
  const leaderSlug = leaderEntry.destination.slice('.claude/agents/'.length, -3);
  const leaderMeta = parseAgentFrontmatter(readNormalisedFile(itemPath(workspace, 'agent', leaderSlug)));
  const metaOf = (slug) => parseAgentFrontmatter(
    sourceAgentText(itemPath(sourceRoot, 'agent', slug)).replace(/\r\n/g, '\n'));
  const agents = items.filter((item) => item.kind === 'agent');
  for (const item of agents) {
    if (!item.agent.approvedDefault || item.destination === leaderEntry.destination) continue;
    // A dependant names its orchestrator the way the chart resolves the
    // link: by the agent's frontmatter name, or by its file slug.
    const names = [item.slug];
    const ownName = metaOf(item.slug).name;
    if (ownName && names.indexOf(ownName) === -1) names.push(ownName);
    const dependants = agents.filter((other) => other !== item
      && names.indexOf(metaOf(other.slug).reportsTo) !== -1);
    if (dependants.length === 0) continue;
    const to = leaderMeta.name || leaderSlug;
    item.agent.attach = {
      to,
      leader: leaderMeta.displayName || leaderMeta.name || leaderSlug,
      dependants: dependants.map((dependant) => dependant.slug),
    };
    // The third way out, offered beside attach: adopt the package's leader
    // itself under the existing one, keeping the author's structure whole.
    // The dependants are NOT touched (they already name this leader), so the
    // only transformed bytes are the leader's own, composed in the writer's
    // order (adoption, then provenance) and digested here so the write-time
    // digest check covers the transform. The dependant names the copy needs
    // live on `attach` above; this fact carries only what adopt itself adds.
    const adopted = withProvenance(
      withAdoption(sourceAgentText(itemPath(sourceRoot, 'agent', item.slug)), to), sourceId);
    item.agent.adopt = {
      to,
      leader: item.agent.attach.leader,
      approvedDigest: digestFile(Buffer.from(adopted, 'utf8')),
    };
    for (const dependant of dependants) {
      const repointed = withProvenance(
        withReportsTo(sourceAgentText(itemPath(sourceRoot, 'agent', dependant.slug)), to), sourceId);
      dependant.agent.repoint = {
        of: item.id,
        to,
        approvedDigest: digestFile(Buffer.from(repointed, 'utf8')),
      };
    }
  }
}

// The immutable plan: the manifest joined with the live workspace facts a
// person needs to decide each item, in the exact field shape the evaluator's
// approval items carry, minus the decision itself.
function buildPlan(workspace, sourceRoot, source) {
  if (!source || typeof source.id !== 'string' || !source.id) {
    refuse('source identity must carry a non-empty id');
  }
  if (source.reference !== null && (typeof source.reference !== 'string' || !source.reference)) {
    refuse('source reference must be a non-empty string or null');
  }
  const manifest = discoverPackage(sourceRoot);
  // The workspace facts come from the same snapshot the apply adapter takes,
  // so plan-time collisions and defaults cannot be computed a second way.
  const pseudo = {
    items: manifest.map(({ kind, slug }) => ({ kind, destination: itemDestination(kind, slug) })),
    manifest,
  };
  const current = snapshotCurrent(workspace, sourceRoot, pseudo);
  const destinationDigests = new Map(current.destinations.map((d) => [d.destination, d.digest]));
  const currentAgents = new Map(current.agents.map((a) => [a.destination, a.isDefault]));

  const items = manifest.map(({ id, kind, slug, sourceDigest }) => {
    const destination = itemDestination(kind, slug);
    const plannedDigest = destinationDigests.get(destination);
    const collision = plannedDigest !== ABSENT_DIGEST;
    let approvedDigest = sourceDigest;
    let agent = null;
    if (kind === 'agent') {
      // A transformation refusal is a discovery refusal at this boundary:
      // re-raised through refuse() so it carries the boundary's code.
      let approvedText;
      try {
        approvedText = withProvenance(sourceAgentText(itemPath(sourceRoot, 'agent', slug)), source.id);
      } catch (e) {
        refuse(`agents/${slug}.md: ${e.message}`);
      }
      approvedDigest = digestFile(Buffer.from(approvedText, 'utf8'));
      agent = {
        plannedDefault: collision ? (currentAgents.get(destination) || false) : false,
        approvedDefault: approvedDefaultOf(approvedText),
      };
      // A routine in this agent's frontmatter is something the install can
      // start: the scheduler finds it through ordinary agent discovery the
      // moment the file lands, so the offer must be able to name it before
      // the person answers. Read here from the text already in memory,
      // through the scheduler's own parser, and carried on the agent
      // metadata only when routines exist, so an agent carrying none keeps
      // the exact shape it has always had. The decision contract rebuilds
      // the agent object field by field, so this display fact never reaches
      // the approval the evaluator validates.
      const routines = routinesCarried(approvedText, slug);
      if (routines.length) agent.routines = routines;
    }
    return { id, kind, slug, destination, collision, plannedDigest, approvedDigest, sourceDigest, agent };
  });

  attachFacts(workspace, sourceRoot, source.id, current, items);

  // A display fact beside the items, never inside them, so the approval the
  // evaluator validates is untouched; carried only when something has it.
  const unasked = items.filter((i) => i.kind !== 'starter')
    .map((i) => ({ kind: i.kind, slug: i.slug, keys: unaskedFor(sourceRoot, i.kind, i.slug) }))
    .filter((u) => u.keys.length);

  return {
    schema: APPROVAL_SCHEMA,
    source: { id: source.id, reference: source.reference },
    manifest,
    items,
    ...(unasked.length ? { unasked } : {}),
  };
}

// The decision step lives in public/packages-decide.js, shared verbatim with
// the browser install flow, and is re-exported here unchanged so server-side
// callers and the plan suite keep one import site.
const { decide } = require('../../public/packages-decide.js');

module.exports = { discoverPackage, buildPlan, decide, actsWithoutAsking };
