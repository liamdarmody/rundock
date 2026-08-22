'use strict';
// Doc claims pinned to behaviour.
//
// Three of four docs audited on 2026-08-13 carried claims that had been false
// for weeks. The one that had not rotted is docs/RUNTIME-ADAPTER.md, whose
// claims are pinned by test/unit/runtime-adapter.test.js reading its needles.
// That is the only mechanism in this repository that has PREVENTED rot rather
// than found it afterwards. A link checker catches a broken reference; it
// cannot catch a sentence that quietly stopped being true.
//
// These pins are behavioural. They call the code the claim is about and assert
// the claim, rather than asserting that a string appears in a source file. A
// source-shape pin can only tell you the words are still there, which is the
// half that was never in doubt.
//
// Scope is deliberate: the card says pick the claims whose falsity would
// mislead a contributor most, and do not attempt to pin prose wholesale.

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const promptLib = require('../../lib/agents/prompt.js');
const { _internal: srv } = require('../../server.js');
const { makeWorkspace, standardTeam, cleanup } = require('../helpers/workspace.js');

const ROOT = path.join(__dirname, '..', '..');
after(cleanup);

function useWorkspace(opts) {
  const dir = makeWorkspace(opts);
  srv.setWorkspace(dir);
  return dir;
}

const routinesDoc = fs.readFileSync(path.join(ROOT, 'docs', 'ROUTINES.md'), 'utf-8');
const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf-8');
const architecture = fs.readFileSync(path.join(ROOT, 'ARCHITECTURE.md'), 'utf-8');
const skillsDoc = fs.readFileSync(path.join(ROOT, 'docs', 'SKILLS.md'), 'utf-8');

// ---------------------------------------------------------------------------
// docs/SKILLS.md: what actually reaches the model
// ---------------------------------------------------------------------------

describe('the workspace boundary says what it enforces, per platform', () => {
  // The claim, in the release notes and in the audit section: the operating
  // system enforces the folder boundary on macOS, and on Windows the boundary
  // is the approval card alone.
  //
  // Pinned because this is the claim whose falsity would mislead most. A user
  // reading it decides how much to trust the product with their machine, and
  // the honest half is the Windows half. If the sandbox were ever quietly
  // written on a platform that has none, or quietly dropped on the one that
  // has it, the sentence would keep reading correctly while meaning something
  // else. Behavioural, not a source-shape grep: the words being there was
  // never the half in doubt.
  const { sandboxSettings } = require('../../lib/workspace/scaffold.js');
  const HOME = '/Users/someone';

  test('both documents state the macOS-only limit, in those words', () => {
    assert.match(changelog, /macOS only/i, 'the release notes say so where a user reads them');
    assert.match(architecture, /macOS only/i, 'and the audit section says so too');
  });

  test('and the code does exactly that: configured on macOS, absent on Windows', () => {
    assert.ok(sandboxSettings('/ws', 'darwin', HOME), 'macOS gets the sandbox the docs promise');
    assert.strictEqual(sandboxSettings('/ws', 'win32', HOME), null,
      'Windows gets none, which is what the docs say rather than something they hide');
  });

  test('the audit section names the file a reader would have to open', () => {
    // The section exists to be followed. A claim pointing at a name that has
    // moved is worse than no pointer, because it costs the reader the search
    // before they find out.
    const named = architecture.match(/`(lib\/workspace\/scaffold\.js)`/);
    assert.ok(named, 'the claim names a file');
    assert.ok(fs.existsSync(path.join(ROOT, named[1])), `${named[1]} exists`);
    assert.match(fs.readFileSync(path.join(ROOT, named[1]), 'utf-8'), /function sandboxSettings/,
      'and it holds the function the claim credits');
  });
});

describe('SKILLS.md: only slugs are injected into the prompt', () => {
  // The claim: "Rundock injects a bare list of slugs into the agent's prompt
  // (`Skills: alpha, beta`) and nothing else: no description, no summary."
  //
  // This one matters because the doc builds advice on top of it. It tells
  // authors to open the body with a clear trigger sentence and to name the
  // skill so the slug alone carries a hint, BECAUSE the slug is all the model
  // sees when deciding whether to open it. If a description ever started
  // reaching the prompt, that advice would be wrong and nothing would say so.
  test('a skill name and description do not reach the roster line', () => {
    const roster = (() => {
      useWorkspace({ agents: standardTeam() });
      const prev = promptLib.wirePromptDeps({
        discoverSkills: () => [{
          slug: 'linkedin-hooks',
          name: 'LinkedIn Hook Generator',
          description: 'SENTINEL_DESCRIPTION_MUST_NOT_REACH_THE_PROMPT',
          assignedAgents: [{ id: 'content-lead' }],
        }],
      });
      try {
        return promptLib.buildTeamRoster('chief-of-staff');
      } finally {
        promptLib.wirePromptDeps(prev);
      }
    })();

    assert.match(roster, /Skills: linkedin-hooks/, 'the slug is injected');
    // The half nothing asserted before, and the half the doc's advice rests
    // on: authors are told the slug is all the model sees when deciding
    // whether to open a skill. If a description started arriving, that advice
    // would be wrong and nothing would say so.
    assert.doesNotMatch(roster, /SENTINEL_DESCRIPTION/, 'no description reaches the prompt');
    assert.doesNotMatch(roster, /LinkedIn Hook Generator/, 'no display name reaches the prompt');
  });

  test('the doc says it is pinned, and names this file', () => {
    assert.match(skillsDoc, /doc-claims\.test\.js/,
      'SKILLS.md must name the test that pins it, so the next editor moves both');
  });
});

// ---------------------------------------------------------------------------
// docs/ROUTINES.md: where a routine's output goes
// ---------------------------------------------------------------------------

describe('ROUTINES.md: the child\'s output is discarded', () => {
  // The claim: "The child's stdout and stderr are attached to the null device,
  // so a routine can print as much as it likes and every write completes."
  //
  // This one is load-bearing in a way the others are not: it is the claim that
  // says the hazard cannot happen. The page previously stated the opposite,
  // that the pipes were open but unread and that this was a deliberate choice,
  // and that sentence was true for as long as it took a routine to print
  // 160 KB, after which the routine hung and never ran again. Put 'pipe' back
  // in either slot and this sentence is false with nothing noticing: the
  // integration test would catch the hang, and nothing at all would catch the
  // prose drifting from the spawn.
  //
  // So both halves are read here. The configuration is taken from what the
  // scheduler REALLY passes to the spawn, by standing in for the spawn and
  // catching it, rather than from the shape of the source: a source-shape pin
  // can only say the words are still there, which is the half that was never
  // in doubt.
  const CLAUDE_KEY = require.resolve('../../lib/runtime/claude.js');
  const SCHEDULER_KEY = require.resolve('../../lib/scheduler.js');

  // The stdio the scheduler asks for when it starts a routine.
  //
  // lib/scheduler.js destructures spawnClaude at load, so a copy required
  // after the export is swapped closes over the stand-in, and the swap is
  // undone before the shared instance the rest of the suite runs against can
  // see it. Same technique as test/unit/scheduler-lib.test.js, and the same
  // reason: a spawn dep on the wiring surface would be a seam in production
  // code that only tests would ever use.
  function stdioTheSpawnAsksFor() {
    const claude = require(CLAUDE_KEY);
    const realSpawn = claude.spawnClaude;
    const prevClaudeDeps = claude.wireClaudeRuntimeDeps({ getActualPort: () => 0 });
    const cached = require.cache[SCHEDULER_KEY];
    let seen = null;
    claude.spawnClaude = (args, options) => {
      seen = options;
      // A child that reports nothing and is never driven. The run is left
      // held, which is why the workspace below is this test's own.
      return new (require('node:events').EventEmitter)();
    };
    try {
      delete require.cache[SCHEDULER_KEY];
      const sched = require(SCHEDULER_KEY);
      delete require.cache[SCHEDULER_KEY];
      sched.wireSchedulerDeps({ getWssClients: () => [] });
      useWorkspace({ agents: standardTeam() });
      sched.executeRoutine({ id: 'runner', name: 'Runner' }, { name: 'r', prompt: 'p' }, 'runner:r');
    } finally {
      claude.spawnClaude = realSpawn;
      claude.wireClaudeRuntimeDeps(prevClaudeDeps);
      if (cached) require.cache[SCHEDULER_KEY] = cached;
    }
    assert.ok(seen, 'the scheduler reached the spawn, so there is a configuration to read');
    return seen.stdio;
  }

  test('the spawn asks for no output pipes at all, which is what the page promises', () => {
    const stdio = stdioTheSpawnAsksFor();
    assert.deepStrictEqual(stdio, ['ignore', 'ignore', 'ignore'],
      'stdin, stdout and stderr are all discarded: an unread pipe in ANY slot hangs the child');

    // The page's half of the same claim. Read as the sentence a user meets,
    // not as a keyword, because "discarded" appears elsewhere on the page.
    assert.match(routinesDoc, /stdout and stderr are attached to the null device/,
      'ROUTINES.md must state what the spawn does, and it is this sentence that says it');
    assert.match(routinesDoc, /\*\*Rundock discards both\.\*\*/,
      'and say it in the paragraph a reader looking for routine output would land on');
  });

  test('the doc says it is pinned, and names this file', () => {
    // Named beside the claim itself rather than only once in the file, so an
    // editor rewriting this paragraph is told where its behaviour is asserted.
    const paragraph = routinesDoc.split('\n').find(l => l.includes('Rundock discards both'));
    assert.ok(paragraph, 'the claim is in the page');
    assert.match(paragraph, /doc-claims\.test\.js/,
      'the paragraph making the claim must name the test that pins it, so the next editor moves both');
  });
});

// ---------------------------------------------------------------------------
// docs/ROUTINES.md: the catch-up window
// ---------------------------------------------------------------------------

describe('ROUTINES.md: same-day catch-up', () => {
  const { getNextRun } = require('../../lib/scheduler.js');

  // The claim: the catch-up window is the calendar day for daily routines and
  // the weekday for weekly ones. The scheduler fires anything still due today
  // on its next tick, because a past-due target deliberately STAYS today. The
  // previous behaviour rolled it to tomorrow, which meant a routine could only
  // fire in the single millisecond its time matched exactly.
  // Midnight, deliberately. An earlier attempt built the target from the wall
  // clock as "three hours ago" and returned early when that crossed midnight,
  // which meant the three tests below asserted NOTHING whenever the suite ran
  // between 00:00 and 02:59, while still reporting as passed. Continuous
  // integration runs at whatever time it runs.
  //
  // 00:00 has already passed on every day, at every hour, so the past-due case
  // is exercised on every run with no clock-dependent branch at all.
  const MIDNIGHT = 'every day at 00:00';
  const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

  test('a daily routine whose time passed earlier today is still due today', () => {
    const now = new Date();
    const next = getNextRun(MIDNIGHT, null);
    assert.ok(next, 'a past-due daily routine still has a next run');
    assert.strictEqual(next.toDateString(), now.toDateString(),
      'it stays TODAY rather than rolling to tomorrow, which is the catch-up');
    assert.ok(next <= now, 'and it is already due, so the next tick fires it');
  });

  test('a weekly routine on its own weekday behaves the same', () => {
    const now = new Date();
    const next = getNextRun(`every ${WEEKDAYS[now.getDay()]} at 00:00`, null);
    assert.ok(next, 'a past-due weekly routine on its weekday still has a next run');
    assert.strictEqual(next.toDateString(), now.toDateString());
    assert.ok(next <= now);
  });

  // A catch-up window without suppression is not a feature, it is a
  // double-fire. The two claims are pinned together because they are only
  // correct together.
  test('a routine that already ran today is suppressed rather than caught up', () => {
    // A run earlier TODAY, built from today's date rather than from an offset,
    // so it cannot drift into yesterday near midnight.
    const ranToday = new Date();
    ranToday.setHours(1, 0, 0, 0);
    assert.strictEqual(getNextRun(MIDNIGHT, ranToday.toISOString()), null,
      'having already run today, it is not due again');
  });

  test('the doc says it is pinned, and names this file', () => {
    assert.match(routinesDoc, /doc-claims\.test\.js/,
      'ROUTINES.md must name the test that pins it, so the next editor moves both');
  });

  test('the doc does not also claim there is no catch-up', () => {
    // It did, in the same document that described the window, for weeks. That
    // contradiction is what this card was written to catch, so it is pinned
    // rather than merely corrected.
    assert.doesNotMatch(routinesDoc, /There is no catch-up/i,
      'ROUTINES.md must not contradict the catch-up window it documents');
  });
});
