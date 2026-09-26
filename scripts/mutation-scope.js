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
 *   - The changed set is measured against the LAST TREE A PASSING GATE
 *     CERTIFIED, not against the merge base with main. A gate record certifies
 *     a tree, so a harness that passed against an earlier tree, whose files
 *     have not changed since that tree, proves nothing by running again. The
 *     merge base remains the fallback whenever the record cannot be trusted,
 *     and the output names which base was used, because the two look identical
 *     from the harness list alone.
 *   - What was skipped is named, with its reason, in this tool's own output and
 *     in the record the gate writes.
 *
 * PARALLELISM IS STILL NOT HERE, FOR A DIFFERENT REASON THAN IT FIRST WAS.
 * The crash marker that made concurrency impossible is per-run now (one record
 * per process under `.mutation-runs/`, see test/tools/mutation-run.js), so two
 * runs can no longer destroy each other's recovery record, and a run that
 * would hold a file another run holds is refused by name. What keeps this list
 * sequential is what the harnesses touch: several rewrite the same source files
 * (app.js, files.js, the packages modules), so running those together would
 * only trade one wait for a refusal, and each harness already runs a suite per
 * row, which is the machine's whole capacity on the laptops this gate runs on.
 * Running disjoint harnesses together is the open change, not a blocked one.
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

// A git runner bound to one repository, with stderr dropped: every caller
// below treats a failed command as "fall back", so the error text has nowhere
// useful to go.
function gitAt(root) {
  return (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

// The record the pre-commit gate writes after every step passes. Its format
// belongs to scripts/precommit-gate.js; this tool only reads the `tree` field,
// which names the hash `git write-tree` produced for the index the checks ran
// against.
const GATE_RECORD = '.precommit-gate.json';

/**
 * The tree the last passing gate certified, when this branch can still lean on
 * it. Returns { tree } when it can, or { fallback } naming why it cannot.
 *
 * WHY THE GATE RECORD AND NOT THE MERGE BASE. The base used to be
 * `merge-base HEAD origin/main`, which is the right question on a short-lived
 * branch and the wrong one on a long branch: everything since the divergence
 * stays in the changed set forever, and once that set contains `package.json`,
 * which any integration branch's does, the narrowing degrades to no narrowing
 * at all. Measured on the branch that surfaced this: sixteen gate runs, 3.4
 * hours of mutation testing, and every one of them reported the same honest,
 * useless reason, because the reason read like a fact about the change rather
 * than an artifact of the branch being long. A gate record certifies a TREE.
 * If a harness passed against an earlier tree and the files it watches have
 * not changed since that tree, running it again proves nothing, so the last
 * gated tree is the base that matches what the record actually claims.
 *
 * EVERY UNCERTAIN ANSWER IS A FALLBACK, never a guess. A record that is
 * missing, that cannot be parsed, that names no tree, whose tree this
 * repository cannot resolve, or whose tree no commit reachable from HEAD ever
 * captured, all mean the merge base serves instead and every harness runs,
 * exactly as before this base existed. A narrowing that guesses is worse than
 * one that does not narrow, because the whole value of this tool is that a
 * skipped harness was genuinely unaffected.
 *
 * THE ANCESTRY CHECK IS ON TREES, NOT COMMITS, because the record names a
 * write-tree hash rather than a commit: the tree qualifies when some commit
 * reachable from HEAD captured exactly it, which is what following the gate's
 * own usage produces, since the commit made right after a pass has precisely
 * the tree the record names. A record from another branch, or from a pass
 * whose tree was never committed, fails this test and correctly falls back:
 * a certificate for a tree that is not in this branch's history says nothing
 * about what this branch has changed.
 */
function lastGatedTree(root = ROOT, git = gitAt(root)) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(root, GATE_RECORD), 'utf8');
  } catch (e) {
    return { fallback: 'no gate record has been written' };
  }
  let record;
  try {
    record = JSON.parse(raw);
  } catch (e) {
    return { fallback: 'the gate record could not be parsed' };
  }
  // A hash and nothing else reaches git. The record is a local, writable file,
  // and a string that is not a hash has no business becoming an argument.
  const tree = record && typeof record.tree === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(record.tree)
    ? record.tree
    : null;
  if (!tree) return { fallback: 'the gate record names no tree' };
  try {
    if (git(['cat-file', '-t', tree]).trim() !== 'tree') {
      return { fallback: `the recorded object ${tree.slice(0, 12)} is not a tree` };
    }
  } catch (e) {
    return { fallback: `the recorded tree ${tree.slice(0, 12)} cannot be resolved here` };
  }
  try {
    const trees = git(['log', '--format=%T', 'HEAD']).split('\n').map(s => s.trim());
    if (!trees.includes(tree)) {
      return { fallback: `the recorded tree ${tree.slice(0, 12)} is not an ancestor of HEAD` };
    }
  } catch (e) {
    return { fallback: 'the recorded tree\'s ancestry could not be established' };
  }
  return { tree };
}

/**
 * The files changed since the last tree a passing gate certified, or since the
 * merge base with the trunk when no such certificate can be used.
 *
 * Returns { files, base }: `files` is the changed set, or null when no base
 * could be resolved at all, which the selection above turns into running
 * everything. `base` is a sentence naming which comparison was actually made,
 * and it travels into this tool's printed reason and into the scope record,
 * because the defect this base replaced was diagnosable only through the
 * output staying honest: a reader has to be able to tell "narrowed against
 * the last gated tree" from "ran everything because there was no record"
 * without re-deriving either.
 */
function changedFiles(root = ROOT) {
  const git = gitAt(root);
  const gated = lastGatedTree(root, git);
  let base;
  let described;
  if (gated.tree) {
    base = gated.tree;
    described = `against the last gated tree ${gated.tree.slice(0, 12)}`;
  } else {
    try {
      base = git(['merge-base', 'HEAD', 'origin/main']).trim();
    } catch (e) {
      base = '';
    }
    described = `against the merge base with origin/main, because ${gated.fallback}`;
    if (!base) return { files: null, base: `no base could be resolved: ${gated.fallback}, and the merge base with origin/main could not be found either` };
  }
  try {
    const staged = git(['diff', '--name-only', '--cached']).split('\n');
    // Both bases are tree-ish, so one diff form serves them. For the merge
    // base commit this names the same files the old `base...HEAD` form did,
    // because the base IS the merge base already; for the gated tree, which is
    // a tree and not a commit, the symmetric form would not resolve at all.
    const committed = git(['diff', '--name-only', base, 'HEAD']).split('\n');
    const unstaged = git(['diff', '--name-only']).split('\n');
    // UNTRACKED FILES COUNT. A new source file, and more to the point a NEW
    // HARNESS, appears in no diff at all, so leaving them out meant a change
    // made entirely of new files looked like a change to nothing. That failed
    // safe, by running everything, but it also switched this tool off for the
    // exact change most likely to add a harness whose targets nobody has read.
    const untracked = git(['ls-files', '--others', '--exclude-standard']).split('\n');
    const seen = [...staged, ...committed, ...unstaged, ...untracked].map(s => s.trim()).filter(Boolean);
    return { files: [...new Set(seen)], base: described };
  } catch (e) {
    return { files: null, base: described };
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

  const changed = forceAll ? null : changedFiles();
  const plan = forceAll
    ? { run: harnesses.map(h => h.tool), skipped: [], reason: '--all was given' }
    : selectHarnesses((changed && changed.files) || [], harnesses);
  // THE BASE IS PART OF THE REASON. "package.json can change what any harness
  // proves" is true against any base, and against the wrong base it is true
  // forever: that sentence, honest every single time, is how a long branch
  // paid for a full run sixteen times without anyone noticing the base was the
  // problem. Naming the base is what lets a reader tell a fact about the
  // change from an artifact of what it was compared to.
  if (changed && changed.base) plan.reason = `${plan.reason} (${changed.base})`;

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
      `${JSON.stringify({
        at: new Date().toISOString(),
        reason: plan.reason,
        // The comparison base, as its own field as well as inside the reason,
        // so the record the gate folds this into can be queried for it without
        // parsing a sentence. Null when --all was given, because a forced full
        // run compared nothing to anything.
        base: (changed && changed.base) || null,
        ran: plan.run,
        skipped: plan.skipped,
      }, null, 2)}\n`);
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

module.exports = { harnessTargets, selectHarnesses, harnessFiles, changedFiles, lastGatedTree, isOwnHarnessFile, RUN_EVERYTHING_WHEN_TOUCHED };

if (require.main === module) process.exit(main());
