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
const { readNormalisedFile, parseAgentFrontmatter, agentIsDefault } = require('../agents/discovery.js');

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
  const files = walkDirectory(root);
  return sha256((hash) => {
    hash.update(`${DIGEST_VERSION}:dir\0`);
    for (const relative of files) {
      hash.update(`${relative}\0`);
      hash.update(digestFile(fs.readFileSync(path.join(root, relative.split('/').join(path.sep)))));
      hash.update('\n');
    }
  });
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

function itemRelativePath(kind, slug) {
  return kind === 'agent' ? `.claude/agents/${slug}.md` : `.claude/skills/${slug}`;
}

function toAbsolute(root, relative) {
  return path.join(root, relative.split('/').join(path.sep));
}

// The provenance transformation an imported agent receives: a `source:` line
// recording where it came from, informational only. An existing source value
// is never overwritten, and the transformation is deterministic so the plan
// side derives the approved digest from exactly these bytes.
function withProvenance(text, sourceId) {
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
    destinations.push({ destination: item.destination, digest: digestAt(toAbsolute(workspace, item.destination)) });
  }
  const sources = [];
  for (const entry of approval.manifest) {
    if (!entry || typeof entry.id !== 'string') continue;
    const absolute = toAbsolute(sourceRoot, itemRelativePath(entry.kind, entry.slug));
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
  const absolute = toAbsolute(sourceRoot, write.destination);
  if (write.kind === 'agent') {
    const bytes = fs.readFileSync(absolute);
    if (digestFile(bytes) !== write.sourceDigest) {
      throw new Error(`source for ${write.id} changed after approval; refusing to write`);
    }
    const transformed = Buffer.from(withProvenance(bytes.toString('utf8'), sourceId), 'utf8');
    if (digestFile(transformed) !== write.approvedDigest) {
      throw new Error(`bytes for ${write.id} do not match the approved digest; refusing to write`);
    }
    return { file: transformed };
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
function applyImport(workspace, sourceRoot, approval, options = {}) {
  recoverPendingWrites(workspace);
  const current = snapshotCurrent(workspace, sourceRoot, approval);
  const evaluation = evaluateImport(approval, current);
  if (evaluation.status !== 'ready') return { ...evaluation, written: [] };

  const writes = [];
  const replaceDirs = [];
  for (const write of evaluation.writes) {
    const payload = materialise(sourceRoot, approval.source.id, write);
    const destination = toAbsolute(workspace, write.destination);
    if (payload.file) writes.push({ path: destination, content: payload.file });
    else replaceDirs.push({ path: destination, files: payload.files });
  }
  const result = writeAsUnit(workspace, writes, { replaceDirs, afterStep: options.afterStep });
  return { ...evaluation, written: result.written };
}

module.exports = {
  applyImport,
  snapshotCurrent,
  digestFile,
  digestDirectory,
  withProvenance,
};
