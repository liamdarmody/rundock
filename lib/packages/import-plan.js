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

const { snapshotCurrent, digestFile, digestDirectory, withProvenance } = require('./import-apply.js');
const { ABSENT_DIGEST, APPROVAL_SCHEMA } = require('./import-evaluate.js');
const { parseAgentFrontmatter, agentIsDefault } = require('../agents/discovery.js');

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
  if (entries.length === 0) refuse('the package contains no agents and no skills', 'empty-package');
  return entries.sort((a, b) => (a.id < b.id ? -1 : 1));
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
    items: manifest.map(({ kind, slug }) => ({
      destination: kind === 'agent' ? `.claude/agents/${slug}.md` : `.claude/skills/${slug}`,
    })),
    manifest,
  };
  const current = snapshotCurrent(workspace, sourceRoot, pseudo);
  const destinationDigests = new Map(current.destinations.map((d) => [d.destination, d.digest]));
  const currentAgents = new Map(current.agents.map((a) => [a.destination, a.isDefault]));

  const items = manifest.map(({ id, kind, slug, sourceDigest }) => {
    const destination = kind === 'agent' ? `.claude/agents/${slug}.md` : `.claude/skills/${slug}`;
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
    }
    return { id, kind, slug, destination, collision, plannedDigest, approvedDigest, sourceDigest, agent };
  });

  return {
    schema: APPROVAL_SCHEMA,
    source: { id: source.id, reference: source.reference },
    manifest,
    items,
  };
}

// The decision step lives in public/packages-decide.js, shared verbatim with
// the browser install flow, and is re-exported here unchanged so server-side
// callers and the plan suite keep one import site.
const { decide } = require('../../public/packages-decide.js');

module.exports = { discoverPackage, buildPlan, decide };
