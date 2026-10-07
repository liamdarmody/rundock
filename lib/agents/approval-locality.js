'use strict';
// The workspace side of lib/agents/approval-store.js: reading a workspace's
// agent files to decide, the first time this install opens it, whether its
// approvals are carried over or held, and recording an approval given here.
//
// Kept apart from the store so the store stays a plain record and this file
// is the only one that reads agent files for it.

const fs = require('node:fs');
const path = require('node:path');
const store = require('./approval-store.js');
const {
  parseRoutineBlocks, normalizeRoutine, computePlanHash, planApproved, approvedBefore,
  isRunOnSupported, hasRunnablePrompt, approvalFeatureRan,
} = require('./routines.js');

const AGENTS_DIR = path.join('.claude', 'agents');

function unquote(value) {
  return String(value == null ? '' : value).trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').trim();
}

function frontmatterOf(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text).replace(/\r\n/g, '\n'));
  return m ? m[1] : null;
}

function topLevel(fm, key) {
  const m = new RegExp(`^${key}:[ \\t]*(.+)$`, 'm').exec(fm);
  return m ? unquote(m[1]) : null;
}

// Every routine in a workspace's agent files, each with its identity (file,
// name, which namesake), its normalised form, and its raw block.
function routinesIn(dir) {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(path.join(dir, AGENTS_DIR)).filter((f) => f.endsWith('.md')).sort(); } catch (e) { return out; }
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(path.join(dir, AGENTS_DIR, file), 'utf-8'); } catch (e) { continue; }
    const fm = frontmatterOf(text);
    if (!fm) continue;
    const blocks = parseRoutineBlocks(fm);
    const fileHasApproval = blocks.some((b) => b.planApprovedHash !== undefined);
    const agentName = topLevel(fm, 'displayName') || topLevel(fm, 'name') || file.replace(/\.md$/, '');
    const seen = new Map();
    for (const raw of blocks) {
      const name = unquote(raw.name);
      const occurrence = seen.get(name) || 0;
      seen.set(name, occurrence + 1);
      out.push({
        file: `.claude/agents/${file}`, name, occurrence, agentId: file.replace(/\.md$/, ''), agentName,
        raw, routine: normalizeRoutine(raw), fileHasApproval,
      });
    }
  }
  return out;
}

// Would this routine have counted as approved under the rules before this
// install kept its own record? A matching hash in the file, or a file written
// before approvals existed in a workspace the feature had never passed over.
function approvedByOldRules(entry, markerPresent) {
  if (planApproved(entry.routine)) return true;
  return !entry.fileHasApproval && !markerPresent;
}

function wouldRunUnattended(routine) {
  return routine.enabled === true && !routine.paused && !!unquote(routine.schedule)
    && isRunOnSupported(routine.runOn) && hasRunnablePrompt(routine);
}

const identity = (e) => ({ file: e.file, name: e.name, occurrence: e.occurrence });

// Called each time a workspace is opened, with the path this machine last
// opened it at (from its own .rundock/state.json), before anything reads its
// routines. Decides the workspace's state the first time; moves its records
// when it has been moved; otherwise does nothing.
function noteWorkspaceOpened(dir, previousPath) {
  if (!dir) return null;
  if (store.workspaceState(dir)) return store.workspaceState(dir);
  if (previousPath && previousPath !== dir && !fs.existsSync(previousPath) && store.moveWorkspace(previousPath, dir)) {
    return store.workspaceState(dir);
  }
  const markerPresent = approvalFeatureRan(dir);
  const all = () => routinesIn(dir).filter((e) => approvedByOldRules(e, markerPresent));
  return store.noteWorkspaceOpened(dir, {
    // Opened here before by this machine: the workspace's own file says so,
    // AND this install's record of recent workspaces from before it kept
    // approvals agrees. The file alone is something a repository can ship.
    seenHere: previousPath === dir && store.wasRecentBeforeStore(dir),
    // The hash each was approved over: the recorded one where the file has
    // one (so a plan changed since still asks, and still reads as approved
    // before), the current one for a routine from before approvals existed.
    adopt: () => routinesIn(dir).flatMap((e) => {
      if (approvedBefore(e.routine)) return [{ ...identity(e), hash: e.routine.planApprovedHash }];
      return approvedByOldRules(e, markerPresent) ? [{ ...identity(e), hash: computePlanHash(e.routine) }] : [];
    }),
    // Each with the plan it had when the strip named it: Allow approves that
    // plan and no other.
    wouldHaveRun: () => all().filter((e) => wouldRunUnattended(e.routine))
      .map((e) => ({ ...identity(e), agentId: e.agentId, agentName: e.agentName, hash: computePlanHash(e.routine) })),
  }).state;
}

// Record as given here, at `at`, the approvals a package install card gave:
// `only` names the routines (by name and namesake) the card said would run
// themselves (lib/packages/import-apply.js), and each is recorded only while
// the file carries Rundock's approval of its current plan.
function recordFileApprovals(dir, relFile, at, only) {
  const granted = Array.isArray(only) ? only : [];
  for (const e of routinesIn(dir)) {
    if (e.file !== relFile || !planApproved(e.routine)) continue;
    if (!granted.some((g) => g.name === e.name && g.occurrence === e.occurrence)) continue;
    store.recordApproval(dir, identity(e), computePlanHash(e.routine), at);
  }
}

// The strip's Allow: every routine it names, approved here, at `at` so no
// slot before the click is owed, over the plan it had when the strip named
// it. A routine whose plan has changed since is not approved: it waits in
// Routines, whose approve step shows the plan as it now stands.
function allowHeld(dir, at) {
  const held = store.heldRoutines(dir);
  const now = routinesIn(dir);
  for (const h of held) {
    const e = now.find((x) => x.file === h.file && x.name === h.name && x.occurrence === h.occurrence);
    if (!e || typeof h.hash !== 'string' || computePlanHash(e.routine) !== h.hash) continue;
    store.recordApproval(dir, identity(e), h.hash, at);
  }
  store.closeStrip(dir);
}

// What the strip shows: the routines still held, by name and agent.
function heldForStrip(dir) {
  return store.heldRoutines(dir).map((h) => ({ name: h.name, agentId: h.agentId, agent: h.agentName }));
}

module.exports = { routinesIn, noteWorkspaceOpened, recordFileApprovals, allowHeld, heldForStrip };
