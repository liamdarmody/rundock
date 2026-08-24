'use strict';
// Temp-workspace fixture builder for the test suite.
// Creates disposable workspace directories and removes them again. Never
// touches the repo or the user's real workspaces.
//
// WHY REMOVAL IS NOT LEFT TO THE CALLER ANY MORE
//
// It used to be. `cleanup()` was exported and each test file could wire it
// with `after(cleanup)`. Of the 79 files that build fixtures, 20 did and 59
// did not, including every file in the integration suite, which builds the
// most. Opt-in tidying means the DEFAULT is a leak, so each new test file
// leaked by default and looked exactly like the ones that did not. One suite
// run left 160 directories and 103 MB behind, and nothing ever removed any of
// them, so every run of anything added to the pile permanently. A day of that
// filled the disk twice and made two mutation runs report out-of-space
// failures as unguarded guards.
//
// So the process that creates the fixtures removes them, and no test file has
// to remember anything. Every fixture is nested inside ONE root per process,
// named with that process's pid, and the root goes when the process does.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PREFIX, sweepStale } = require('./temp-root.js');

const created = [];

// Leftovers from runs that never got the chance to tidy up. A process killed
// outright runs no handler, so somebody else has to finish the job, and the
// next run is the only party that ever looks. Runs at load, before any fixture
// is made, and skips any root whose owning process is still alive.
sweepStale(os.tmpdir());

let processRoot = null;
let removersInstalled = false;

// Remove the whole root in one call. Cheap enough to run from a signal
// handler, which is the point: no walking a list that a crash may have left
// half written.
function removeProcessRoot() {
  const dir = processRoot;
  if (!dir) return;
  processRoot = null;
  created.length = 0;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function installRemovers() {
  if (removersInstalled) return;
  removersInstalled = true;

  // Covers ordinary completion, an uncaught throw, and an explicit
  // process.exit. Must stay synchronous: nothing asynchronous scheduled here
  // ever runs.
  process.on('exit', removeProcessRoot);

  // A `finally` is not enough and neither is 'exit' alone, because Node's
  // DEFAULT handling of these signals terminates without unwinding anything.
  // Installing a listener is what disables that default. The signal is then
  // re-raised with the default disposition restored, so the exit status still
  // reads "killed by <signal>" rather than a plain zero from a swallowed one,
  // which is what a test runner and a CI job go on.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const onSignal = () => {
      removeProcessRoot();
      // Stand down, then re-raise ONLY if nobody else was listening. Clearing
      // every listener would be simpler and would silently disarm a handler
      // some other module installed for its own tidying, which is the same
      // class of bug as the one being fixed here.
      process.off(signal, onSignal);
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    };
    process.on(signal, onSignal);
  }
}

// The one directory this process owns. Created lazily, so a test file that
// builds no fixtures leaves nothing at all and installs no handlers.
function rootDir() {
  if (processRoot) return processRoot;
  processRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${PREFIX}p${process.pid}-`));
  installRemovers();
  return processRoot;
}

// The prefix is now a label inside this process's root rather than a name in
// the shared temp root, so callers that pass their own keep their readable
// directory names and cost nothing.
function makeTempDir(prefix = 'ws-') {
  const dir = fs.mkdtempSync(path.join(rootDir(), prefix));
  created.push(dir);
  return dir;
}

/**
 * Build a workspace directory.
 * @param {object} opts
 * @param {Object<string,string>} [opts.agents] - slug -> agent .md content
 * @param {Object<string,string>} [opts.skills] - slug -> SKILL.md content
 * @param {string|null} [opts.claudeMd] - CLAUDE.md content (null = none)
 * @param {Object<string,string>} [opts.files] - relative path -> content
 */
function makeWorkspace(opts = {}) {
  const dir = makeTempDir();
  if (opts.agents) {
    const agentsDir = path.join(dir, '.claude', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    for (const [slug, content] of Object.entries(opts.agents)) {
      fs.writeFileSync(path.join(agentsDir, `${slug}.md`), content);
    }
  }
  if (opts.skills) {
    for (const [slug, content] of Object.entries(opts.skills)) {
      const skillDir = path.join(dir, '.claude', 'skills', slug);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content);
    }
  }
  if (opts.claudeMd) {
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), opts.claudeMd);
  }
  if (opts.files) {
    for (const [rel, content] of Object.entries(opts.files)) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  }
  return dir;
}

// Standard team used across suites: one orchestrator, one lead with a direct
// report, two plain specialists. Mirrors the shape of a real Rundock workspace.
function agentFile({ name, displayName, role, type, order, reportsTo, model, runtime, description, prompts, routines, skills, capabilities, body }) {
  const lines = ['---', `name: ${name}`];
  if (displayName) lines.push(`displayName: ${displayName}`);
  if (role) lines.push(`role: ${role}`);
  if (description) lines.push(`description: ${description}`);
  if (type) lines.push(`type: ${type}`);
  if (order !== undefined) lines.push(`order: ${order}`);
  if (reportsTo) lines.push(`reportsTo: ${reportsTo}`);
  if (model) lines.push(`model: ${model}`);
  if (runtime) lines.push(`runtime: ${runtime}`);
  if (capabilities) {
    lines.push('capabilities:');
    for (const [k, v] of Object.entries(capabilities)) lines.push(`  ${k}: ${v}`);
  }
  if (prompts) {
    lines.push('prompts:');
    for (const p of prompts) lines.push(`  - "${p}"`);
  }
  if (skills) {
    lines.push('skills:');
    for (const s of skills) lines.push(`  - ${s}`);
  }
  if (routines) {
    lines.push('routines:');
    for (const r of routines) {
      lines.push(`  - name: ${r.name}`);
      if (r.schedule) lines.push(`    schedule: ${r.schedule}`);
      if (r.prompt) lines.push(`    prompt: ${r.prompt}`);
      // Any other key an author might write, so a fixture can declare the
      // routine fields this helper predates without knowing about each one.
      for (const [k, v] of Object.entries(r)) {
        if (k === 'name' || k === 'schedule' || k === 'prompt') continue;
        lines.push(`    ${k}: ${v}`);
      }
    }
  }
  lines.push('---', '');
  lines.push(body || `You are ${displayName || name}. ${role || ''}`);
  lines.push('');
  return lines.join('\n');
}

function standardTeam() {
  return {
    'chief-of-staff': agentFile({
      name: 'chief-of-staff', displayName: 'Cos', role: 'Chief of Staff',
      description: 'Chief orchestrator', type: 'orchestrator', order: 1,
      body: 'You are Cos, the orchestrator.\n\nRoute work to specialists.',
    }),
    'content-lead': agentFile({
      name: 'content-lead', displayName: 'Penn', role: 'Content Lead',
      description: 'Owns the content pipeline', type: 'specialist', order: 2,
      reportsTo: 'chief-of-staff',
      body: 'You are Penn, the content lead.\n\nYou own hooks, drafts and audits.',
    }),
    'content-analyst': agentFile({
      name: 'content-analyst', displayName: 'Ana', role: 'Content Analyst',
      description: 'Analyses content performance', type: 'specialist', order: 3,
      reportsTo: 'content-lead',
      body: 'You are Ana, the content analyst.\n\nYou analyse performance data.',
    }),
    'lead-designer': agentFile({
      name: 'lead-designer', displayName: 'Des', role: 'Lead Designer',
      description: 'Visual design', type: 'specialist', order: 4,
      reportsTo: 'chief-of-staff',
      body: 'You are Des, the lead designer.\n\nYou make visuals.',
    }),
  };
}

// Kept, and still exported, for the 20 files that already wire `after(cleanup)`
// and for any test that wants its fixtures gone mid-run rather than at the end.
// It is no longer what stops the leak: removing it from a file now changes when
// that file's directories go, not whether.
function cleanup() {
  for (const dir of created.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  }
}

module.exports = { makeTempDir, makeWorkspace, agentFile, standardTeam, cleanup };
