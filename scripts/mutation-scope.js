#!/usr/bin/env node
'use strict';

/**
 * Run the mutation harnesses a change can actually affect, and SAY WHICH IT DID
 * NOT.
 *
 * Every change ran all eighteen harnesses, whatever it touched. A change to one
 * file ran the seventeen that cannot see it, and a documentation-only edit ran
 * the lot. Measured on the release this was written for: thirty-seven gate runs,
 * roughly twenty minutes each, and the mutation step is nearly all of it.
 *
 * THE DANGER IS THE WHOLE POINT. A gate that skips work is a gate that can
 * report green without having looked, and a false green here is worth far more
 * than the twenty minutes it saves. So every rule below is written to make
 * skipping conservative and visible rather than convenient and silent:
 *
 *   - Targets are read STATICALLY. Requiring a harness module executes at least
 *     one of them (measured), so this never loads them to ask what they touch.
 *   - A harness whose targets cannot be determined RUNS. Ambiguity resolves to
 *     running, always.
 *   - A change to the gate, to the shared mutation machinery, to test helpers,
 *     or to any harness file runs EVERYTHING, because those can change what any
 *     harness proves.
 *   - What was skipped is named, with its reason, in this tool's own output and
 *     in the record the gate writes.
 *
 * PARALLELISM IS DELIBERATELY NOT HERE. All eighteen share one
 * `.mutation-run.json` crash marker at the repository root, and two running at
 * once destroy each other's record. That record is what recovers a mutation
 * left behind by a killed run, and it did so twice during the session this was
 * written in. Concurrency waits until the marker is per-run.
 *
 *   node scripts/mutation-scope.js              # scoped to the branch's changes
 *   node scripts/mutation-scope.js --all        # every harness, no selection
 *   node scripts/mutation-scope.js --explain    # decide and print, run nothing
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TOOLS = path.join(ROOT, 'test', 'tools');

// A change to any of these can change what ANY harness proves, so none of them
// permit a selection: the run is all or nothing. `test/helpers` is here because
// a harness's verdict comes from the suite it drives, and every suite reaches
// for those. `package.json` is here because it holds the full chain this tool
// exists to narrow, and a change to it may be adding a harness.
const RUN_EVERYTHING_WHEN_TOUCHED = [
  'package.json',
  'scripts/precommit-gate.js',
  'scripts/mutation-scope.js',
  'test/tools/mutation-run.js',
  'test/helpers/',
];

// A HARNESS'S OWN FILE IS A TRIGGER FOR THAT HARNESS, NOT FOR ALL OF THEM.
//
// `test/tools/` used to sit in the list above, on the reasoning that a harness
// file decides what that harness proves. True, and it does not follow that it
// decides what the other seventeen prove. Editing the boundary harness cannot
// change what the renderer harness asserts about anything.
//
// The cost of conflating those was the whole point of the scoping work: every
// card that adds a guard edits a harness, so in practice real feature work
// almost never benefited from the selection at all. Measured on the release
// this comment was written during: twenty-five minutes per run, on eighteen
// harnesses, for a change that touched one.
//
// Fail-safe is unchanged. This makes a harness run in one MORE case than its
// targets alone would, never one fewer.
function isOwnHarnessFile(file, tool) {
  return file === `test/tools/${tool}`;
}

// `path.join(ROOT, 'a', 'b')` with string literals only. A harness that names a
// target any other way yields nothing here and is therefore RUN, which is the
// safe direction and the reason this pattern may stay simple.
const TARGET_RE = /path\.join\(ROOT,\s*((?:'[^']*'\s*,\s*)*'[^']*')\s*\)/g;

// A harness's verdict comes from the SUITE it drives, not only from the file it
// mutates: break a guard, run the suite, require a test to go red. So a change
// to that suite can change what the harness proves even when the mutated file
// is untouched, and the suite is a trigger exactly as its targets are. Declared
// as `suite: 'test/unit/x.test.js'` beside each target.
const SUITE_RE = /suite:\s*'([^']+)'/g;

function harnessFiles(toolsDir = TOOLS) {
  return fs.readdirSync(toolsDir)
    .filter(n => /^mutate-.*-guards\.js$/.test(n))
    .sort();
}

/**
 * The repository-relative files a harness depends on: the ones it mutates AND
 * the suites whose verdicts it reads, both read from its source.
 *
 * Returns null when nothing could be read, which is NOT an empty list: an empty
 * list would mean "touches nothing, safe to skip", and the two must never be
 * confused. A caller that cannot tell what a harness touches runs it.
 */
function harnessTargets(source) {
  if (typeof source !== 'string' || !source) return null;
  const targets = new Set();
  let m;
  TARGET_RE.lastIndex = 0;
  while ((m = TARGET_RE.exec(source)) !== null) {
    const parts = m[1].split(',').map(p => p.trim().replace(/^'|'$/g, '')).filter(Boolean);
    if (parts.length) targets.add(parts.join('/'));
  }
  SUITE_RE.lastIndex = 0;
  while ((m = SUITE_RE.exec(source)) !== null) targets.add(m[1]);
  return targets.size ? [...targets] : null;
}

/**
 * Which harnesses a set of changed files requires.
 *
 * `changed` is repository-relative paths. `harnesses` is [{ tool, targets }],
 * where targets may be null for "could not be determined".
 */
function selectHarnesses(changed, harnesses) {
  const files = Array.isArray(changed) ? changed : [];
  const all = () => ({
    run: harnesses.map(h => h.tool),
    skipped: [],
    reason: 'every harness ran',
  });

  // No basis for a decision: run everything rather than guess at nothing.
  if (!files.length) return { ...all(), reason: 'no changed files could be determined, so nothing was narrowed' };

  const trigger = files.find(f => RUN_EVERYTHING_WHEN_TOUCHED.some(p => (p.endsWith('/') ? f.startsWith(p) : f === p)));
  if (trigger) return { ...all(), reason: `${trigger} can change what any harness proves` };

  const run = [];
  const skipped = [];
  for (const h of harnesses) {
    if (!h.targets) {
      run.push(h.tool);
      continue;
    }
    // Its own file, then the files it names. Either is a reason to run it.
    if (files.some(f => isOwnHarnessFile(f, h.tool))) {
      run.push(h.tool);
      continue;
    }
    const hit = h.targets.find(t => files.includes(t));
    if (hit) run.push(h.tool);
    else skipped.push({ tool: h.tool, reason: `touches none of: ${h.targets.join(', ')}` });
  }
  return { run, skipped, reason: 'scoped to the files this change touches' };
}

/**
 * The branch's changes against the trunk it will merge to, not the working tree
 * against itself: the gate certifies a tree for merging, and main was gated
 * when it merged. A base that cannot be resolved returns null, which the
 * selection above turns into running everything.
 */
function changedFiles(root = ROOT) {
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  let base;
  try {
    base = git(['merge-base', 'HEAD', 'origin/main']).trim();
  } catch (e) {
    return null;
  }
  if (!base) return null;
  try {
    const staged = git(['diff', '--name-only', '--cached']).split('\n');
    const branch = git(['diff', '--name-only', `${base}...HEAD`]).split('\n');
    const unstaged = git(['diff', '--name-only']).split('\n');
    // UNTRACKED FILES COUNT. A new source file, and more to the point a NEW
    // HARNESS, appears in no diff at all, so leaving them out meant a change
    // made entirely of new files looked like a change to nothing. That failed
    // safe, by running everything, but it also switched this tool off for the
    // exact change most likely to add a harness whose targets nobody has read.
    const untracked = git(['ls-files', '--others', '--exclude-standard']).split('\n');
    const seen = [...staged, ...branch, ...unstaged, ...untracked].map(s => s.trim()).filter(Boolean);
    return [...new Set(seen)];
  } catch (e) {
    return null;
  }
}

function main() {
  const argv = process.argv.slice(2);
  const explainOnly = argv.includes('--explain');
  const forceAll = argv.includes('--all');

  const harnesses = harnessFiles().map(tool => ({
    tool,
    targets: harnessTargets(fs.readFileSync(path.join(TOOLS, tool), 'utf8')),
  }));

  const changed = forceAll ? [] : changedFiles();
  const plan = forceAll
    ? { run: harnesses.map(h => h.tool), skipped: [], reason: '--all was given' }
    : selectHarnesses(changed || [], harnesses);

  console.log(`[mutation-scope] ${plan.run.length} of ${harnesses.length} harnesses: ${plan.reason}`);
  // NAMED, NOT COUNTED. A reader has to be able to see that a harness did not
  // run and why, without re-deriving it, or a pass that states no scope is
  // being taken on trust.
  for (const s of plan.skipped) console.log(`[mutation-scope] skipped ${s.tool}: ${s.reason}`);
  // WRITTEN DOWN, NOT JUST PRINTED. The gate folds this into its record, so a
  // pass carries the scope it ran under. A record that claims a pass without
  // naming what it skipped is a pass being taken on trust, which is the thing
  // this tool must not create.
  try {
    fs.writeFileSync(path.join(ROOT, '.mutation-scope.json'),
      `${JSON.stringify({ at: new Date().toISOString(), reason: plan.reason, ran: plan.run, skipped: plan.skipped }, null, 2)}\n`);
  } catch (e) {
    // A record that cannot be written must not silently become a run with no
    // scope recorded: refuse, rather than proceed unrecorded.
    console.error(`[mutation-scope] could not record the scope (${e.message}), refusing to run unrecorded`);
    return 1;
  }
  if (explainOnly) return 0;

  for (const tool of plan.run) {
    const r = spawnSync(process.execPath, [path.join('test', 'tools', tool), '--markdown'],
      { cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0) {
      console.error(`[mutation-scope] ${tool} failed`);
      return r.status || 1;
    }
  }
  return 0;
}

module.exports = { harnessTargets, selectHarnesses, harnessFiles, changedFiles, isOwnHarnessFile, RUN_EVERYTHING_WHEN_TOUCHED };

if (require.main === module) process.exit(main());
