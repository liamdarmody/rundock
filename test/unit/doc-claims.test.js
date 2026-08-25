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
const { statusesTheSchedulerRecords } = require('../helpers/scheduler-statuses.js');

const ROOT = path.join(__dirname, '..', '..');
after(cleanup);

function useWorkspace(opts) {
  const dir = makeWorkspace(opts);
  srv.setWorkspace(dir);
  return dir;
}

const routinesDoc = fs.readFileSync(path.join(ROOT, 'docs', 'ROUTINES.md'), 'utf-8');
const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf-8');
// Only the entry being shipped. Matching the whole file lets an unrelated
// release from two years ago satisfy a claim about this one: the exemption
// pin below passed while the current entry named five of the six exempt
// directories, because a 0.9 entry about PATH detection happened to mention
// the sixth.
const unreleased = changelog.slice(
  changelog.indexOf('## Unreleased'),
  changelog.indexOf('## 0.11.8'),
);
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

  test('both documents name every platform the operating-system half does NOT cover', () => {
    // Asserted per platform rather than by matching one phrase, because a
    // phrase can survive a rewrite that drops a platform. Windows and Linux
    // are the two where the approval card is the whole boundary, and a
    // reader on either must not have to infer that from silence.
    for (const [name, doc] of [['release notes', changelog], ['audit section', architecture]]) {
      assert.match(doc, /Windows/, `${name} names Windows`);
      assert.match(doc, /Linux/, `${name} names Linux`);
      assert.match(doc, /macOS/, `${name} names macOS as the one that has it`);
    }
  });

  test('the operating-system half is described as governing writes, not reads', () => {
    // Measured: under the shipped block a command can still read ~/.ssh,
    // ~/.gitconfig and /etc/hosts, and a read whose target is worked out
    // while the command runs is caught on no platform. Copy that folds reads
    // into the operating-system guarantee is the overclaim this whole change
    // exists to remove, and it would be this change committing it.
    assert.match(changelog, /governs writes, not reads|writes, not reads/i,
      'the release notes say which act the operating system half covers');
    assert.match(changelog, /read anything on the machine|caught by nothing/i,
      'and say plainly that reads are not covered');
    assert.match(architecture, /governs writes and not reads|writes and not reads/i,
      'the audit section says the same');
  });

  test('the exemption the code enforces is the exemption the release notes state', () => {
    // The hook deliberately does not card the system executable directories
    // or the device paths, and for three rounds the release notes said a
    // visible target is always carded. Read together, the enforcement and the
    // statement disagreed, which is the defect this whole change removes.
    // Read the list from the CODE so the two cannot drift apart silently.
    const hook = fs.readFileSync(path.join(ROOT, 'scripts', 'permission-hook.js'), 'utf-8');
    const declared = hook.match(/const EXEC_DIRS = \[([^\]]+)\]/);
    assert.ok(declared, 'the hook declares the exempt directories in one place');
    const dirs = declared[1].split(',').map(d => d.trim().replace(/^'|'$/g, '')).filter(Boolean);
    assert.ok(dirs.length >= 3, 'sanity: the list was parsed');
    for (const d of dirs) {
      assert.ok(unreleased.includes(d), `the release notes name ${d}, which the code does not card`);
    }
    assert.match(unreleased, /\/dev\/null/, 'and the device paths');
  });

  test('the copy does not claim the command check sees every visible target', () => {
    // Four review rounds failed the same criterion, each on a different
    // spelling written plainly in the command and not carded. The
    // implementation improved every round and the claim kept failing, because
    // reading a shell command without running it has no complete answer. What
    // changed is the claim: the guarantee is the operating-system half, and
    // the card is a best effort that names where it stops.
    assert.match(unreleased, /best effort/i, 'the release notes call the check what it is');
    assert.match(unreleased, /raise no card|raises no card/i,
      'and say plainly that some targets raise nothing');
    assert.match(unreleased, /~someone\/file|-C\/tmp/,
      'with at least one named example of a spelling it does not recognise');
    assert.match(architecture, /best-effort check over common spellings/i,
      'the audit section separates the guarantee from the best effort');
    assert.match(architecture, /Not recognised/,
      'and lists examples rather than implying completeness');
  });

  test('the audit section states the boundary per platform AND per act', () => {
    // A sentence cannot carry this: the answer differs by platform, by
    // whether the target is visible in the command, and by read versus
    // write. Three rounds of review found the stated boundary wider than the
    // enforced one, every time in a cell nobody had written down.
    assert.match(architecture, /How the target is written/, 'the table exists');
    assert.match(architecture, /a form the check does not recognise/,
      'and the unrecognised-spelling case is a row, not an omission');
    assert.match(architecture, /system executable directory/,
      'and carries the exemption as a row rather than leaving it to the code');
    for (const cell of ['macOS', 'Windows', 'Linux', 'computed while the command runs']) {
      assert.ok(architecture.includes(cell), `the table covers ${cell}`);
    }
  });

  test('the enforced macOS boundary is described as additive, not as a sealed machine', () => {
    // The allowlist adds to the runtime's own default writable roots, so the
    // enforced set is wider than the two Rundock names. Copy that says
    // otherwise is the overclaim this whole change exists to remove, and it
    // would be this change committing it.
    assert.match(changelog, /npm cache/i, 'the release notes name what else is writable');
    assert.match(changelog, /runtime's own default|default locations|does not remove/i,
      'and say the runtime keeps defaults of its own');
    assert.doesNotMatch(changelog, /the rest of the machine is not/i,
      'the sentence that claimed a sealed machine must not come back');
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
// docs/ROUTINES.md: what the permission-hook experiment found
// ---------------------------------------------------------------------------

describe('ROUTINES.md: the hook experiment reports the capture\'s own numbers', () => {
  // The claim names a runtime version, a call count and a list of tools. Those
  // are facts about an artefact in this repository, and they were copied into
  // the prose by hand: a re-capture moves the JSON and leaves the sentence
  // saying what used to be true, which is the quiet rot this file exists to
  // stop. The sentence beside it about the output being discarded is pinned to
  // the spawn; this one was pinned to nothing.
  //
  // So the sentence is COMPOSED here from the capture and asserted whole,
  // rather than matched loosely. A looser check would pass while the numbers
  // drifted, which is the failure being prevented.
  const captured = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'scripts', 'transcript-truth', 'captured-transcript.json'), 'utf-8'));

  test('the version, the call count and the tools are the ones the capture recorded', () => {
    const hook = captured.permissionHook;
    assert.ok(hook && Array.isArray(hook.tools) && hook.tools.length > 1 && hook.calls > 1,
      'the capture carries the experiment, so there is something to pin the prose to');
    const tools = hook.tools.map(t => `\`${t}\``);
    const list = `${tools.slice(0, -1).join(', ')} and ${tools[tools.length - 1]}`;
    const sentence = `On Claude Code ${captured.runtimeVersion} the hook was consulted ${hook.calls} times, `
      + `about ${list}, including the write that then failed.`;
    assert.ok(routinesDoc.includes(sentence),
      `ROUTINES.md must state the capture's own numbers. Expected the sentence:\n  ${sentence}`);
  });

  test('the delegation limit is stated, because a delegating run reports no list at all', () => {
    // A user reading this page to find out what a run changed would otherwise
    // meet an empty answer with no explanation. The reason code is named so
    // the page and the record use the same word.
    assert.match(routinesDoc, /reports `delegated`/,
      'ROUTINES.md must name the reason a delegating run reports, so the page and the run record agree');
  });

  // The vocabulary is documented in one list on that page and written in one
  // file, and a word in either that is missing from the other is how a reader
  // ends up meeting a status the page told them could not happen. Read out of
  // the scheduler rather than named here, so a word added to the file with no
  // line on the page fails, and a line on the page for a word nothing writes
  // fails too.
  test('every status the scheduler can record is named on the page, and every one named is recorded', () => {
    const written = statusesTheSchedulerRecords();
    assert.ok(written.length >= 5, `sanity: only ${written.length} statuses were read out of the scheduler`);

    const listed = routinesDoc.match(/The routine's `status` \(([^)]*)\)/);
    assert.ok(listed, 'ROUTINES.md must list the statuses a routine can carry');
    const named = new Set([...listed[1].matchAll(/`(\w+)`/g)].map(m => m[1]));
    assert.deepStrictEqual([...named].sort(), written,
      'the statuses the scheduler records and the statuses the page names have to be the same set');
  });

  test('a run somebody stopped is described, and told apart from one that failed', () => {
    assert.match(routinesDoc, /reports `cancelled`/,
      'ROUTINES.md must name the word a stopped run reports, so the page and the run record agree');
    assert.match(routinesDoc, /runs again at its next slot/,
      'and must say the routine is released, because a routine that could be stopped and never ran '
      + 'again would be worse than one that could not be stopped');
  });

  test('the word a restart-orphaned record reports is the routine state\'s own', () => {
    // The page and the two stores have to use ONE word here. A run cut off by
    // a restart is described in three places (the routine's status, the run's
    // record, and this page), and the whole point of the startup close is that
    // they agree.
    assert.match(routinesDoc, /the record reports `interrupted`/,
      'ROUTINES.md must name the word a record left open by a restart reports');
    assert.match(routinesDoc, /rather than reporting an empty list/,
      'and must keep saying that an unknown list is not an empty one, which is the distinction the record carries');
  });
});

// ---------------------------------------------------------------------------
// docs/ROUTINES.md: what an upgrade does to routines that already existed
// ---------------------------------------------------------------------------

describe('ROUTINES.md: an upgrade starts nothing, and rewrites no schedule', () => {
  const { normalizeRoutine, migrateAgentRoutines } = require('../../lib/agents/routines.js');

  // THE CLAIM, in the doc's own words: a routine whose block has no `enabled`
  // key reads as not enabled. Pinned behaviourally, by calling the reader,
  // because the sentence is the whole reason an upgrade does not start five
  // routines at once and a source-shape pin would only prove the words are
  // still on the page.
  test('a block with no enabled key reads as not enabled, as the page says', () => {
    assert.strictEqual(normalizeRoutine({ name: 'r', schedule: 'every day at 05:00' }).enabled, false);
    assert.match(routinesDoc, /A routine whose block has no `enabled` key reads as not enabled/,
      'ROUTINES.md must state what an upgrade does to a routine that predates the scheduler');
  });

  // And the other two rows of the same list, which are what stop the rule
  // being applied as a blanket switch-off.
  test('an enabled the file already carries is left alone in both directions', () => {
    assert.strictEqual(normalizeRoutine({ name: 'r', enabled: 'true' }).enabled, true);
    assert.strictEqual(normalizeRoutine({ name: 'r', enabled: 'false' }).enabled, false);
  });

  // The cron claim, which is the one a contributor is most likely to act on:
  // if migration DID rewrite schedules, somebody reading this page would go
  // looking for the translation and find none.
  test('migration leaves a cron schedule exactly as it was written', () => {
    const dir = useWorkspace({
      agents: {
        piper: [
          '---', 'name: piper', 'type: specialist', 'order: 1',
          'routines:',
          '  - name: cron-briefing',
          '    schedule: 0 5 * * *',
          '    prompt: Run it',
          '---', '', '# Piper', '',
        ].join('\n'),
      },
    });
    const file = path.join(dir, '.claude', 'agents', 'piper.md');
    const before = fs.readFileSync(file, 'utf-8');
    const after = migrateAgentRoutines(file, before, { owner: 'piper' });
    assert.match(after, /schedule: 0 5 \* \* \*/,
      'the migration rewrote a schedule, which this page promises it never does');
    assert.match(routinesDoc, /Migration never touches a `schedule`/,
      'ROUTINES.md must state what an upgrade does to a cron-scheduled routine');
    // And it is still held back, which is the other half of the same sentence.
    assert.match(after, /enabled: false/);
  });
});

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

// ---------------------------------------------------------------------------
// docs/ROUTINES.md: where a routine actually runs
//
// The page RECOMMENDS keeping Rundock on a VPS with the workspace synced. Two
// things follow from that recommendation and neither used to be said: a second
// live instance fires every routine again, and the always-on machine serves
// the one workspace it has open and none of the others.
//
// THE FIRST OF THOSE WAS ONCE DESCRIBED WRONGLY HERE, which is why it is
// pinned to the mechanism rather than to its consequence. The page used to say
// the outcome depended on whether the reader's sync tool carried `.rundock/`.
// It does not: the guard the tick reads is an in-memory copy, filled once when
// an instance starts and written back in full after each of that instance's
// own runs, and nothing on the tick path reads the file again. A page that
// warns a user about a mechanism it has described wrongly is worse than one
// that stays silent, so the claim and the mechanism are asserted together.

describe('ROUTINES.md: where a routine actually runs', () => {
  const { scaffoldWorkspace } = require('../../lib/workspace/scaffold.js');
  const scheduler = require('../../lib/scheduler.js');
  const { agentFile } = require('../helpers/workspace.js');

  const KEY = 'nightly:briefing';
  const SCHEDULE = 'every day at 07:00';
  // Half past nine on a Thursday, built from local components so the pair of
  // instants below describes the code rather than the machine.
  const NOW = new Date(2026, 7, 20, 9, 30);
  const RAN_AT = new Date(2026, 7, 20, 7, 0, 40);

  /** Run `fn` with the scheduler's clock held still. */
  function atNow(fn) {
    const previous = scheduler.wireSchedulerDeps({ now: () => NOW });
    try { return fn(); } finally { scheduler.wireSchedulerDeps(previous); }
  }

  // THE MECHANISM, DRIVEN. A run recorded to the shared file by another
  // instance does not reach the value this instance's tick decides with, so
  // this instance fires the routine it would have been suppressed by.
  test("a run another instance recorded does not reach the guard this one decides with", () => {
    const dir = useWorkspace({});
    atNow(() => {
      // This instance starts. Nothing has run, so its copy is empty.
      srv.loadRoutineState();
      assert.strictEqual(srv.routineState[KEY], undefined, 'sanity: this instance knows of no run');

      // The other instance, sharing this very folder, records one. Written
      // whole, which is how saveRoutineState writes it.
      fs.mkdirSync(path.join(dir, '.rundock'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.rundock', 'routine-state.json'),
        JSON.stringify({ [KEY]: { lastRun: RAN_AT.toISOString(), status: 'completed', duration: 40 } }));

      assert.strictEqual(srv.routineState[KEY], undefined,
        'the file changed under a running instance and nothing on the tick path read it');

      const state = srv.routineState[KEY];
      assert.notStrictEqual(srv.getNextRun(SCHEDULE, state && state.lastRun), null,
        'so this instance still has a run due, which is the second fire the page warns about');
      assert.strictEqual(srv.getNextRun(SCHEDULE, RAN_AT.toISOString()), null,
        'and the recorded run WOULD have suppressed it, so it is the not-reading and not the schedule that decides');
    });
  });

  test('a workspace shared through git does not carry the guard file at all', () => {
    // The aside the page makes about git specifically, checked against the real
    // tool rather than by reading the scaffold.
    const dir = makeWorkspace({});
    scaffoldWorkspace(dir);
    const gitignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8');
    assert.match(gitignore, /^\.rundock\/$/m,
      'the scaffold must ignore the state folder, which is what makes the git aside true');
  });

  // ONE SCHEDULER, ONE WORKSPACE. The tick re-discovers agents each pass, and
  // discovery reads whichever workspace is open, so a routine in any other
  // workspace is never even considered.
  test('the roster a tick works from holds the open workspace and nothing else', () => {
    const routines = [{ name: 'briefing', schedule: SCHEDULE, prompt: 'p', enabled: true }];
    const here = useWorkspace({ agents: { nightly: agentFile({ name: 'nightly', type: 'specialist', order: 1, routines }) } });
    const elsewhere = makeWorkspace({ agents: { wren: agentFile({ name: 'wren', type: 'specialist', order: 1, routines }) } });
    assert.notStrictEqual(here, elsewhere, 'sanity: two workspaces');

    srv.invalidateAgentCache();
    const names = srv.discoverAgents().filter(a => a.routines && a.routines.length).map(a => a.id);
    assert.deepStrictEqual(names, ['nightly'],
      "the other workspace's routine is not on the roster, so no tick can reach it");
  });

  test('the always-on section says what a second live instance does, and what to do instead', () => {
    // Placement is half the claim. Stated only in the reference section, it
    // would be absent from the section a reader acts on.
    const alwaysOn = routinesDoc.slice(routinesDoc.indexOf('## Always-on routines'));
    assert.ok(alwaysOn.length > 0, 'sanity: the always-on section exists');
    assert.match(alwaysOn, /runs twice/,
      'the always-on section must say what two live instances do');
    assert.match(alwaysOn, /Four machines, four runs/,
      'and what happens at more than two');
    assert.match(alwaysOn, /viewers/,
      'and it must name the remedy rather than only the hazard');
    assert.match(alwaysOn, /one machine|one server ticking/i,
      'which is that one machine runs the routines');
  });

  test('the always-on section does not blame the sync tool for the double fire', () => {
    // The exact sentence that was wrong, and the class of sentence that would
    // be wrong again. The mechanism is above; this is the page agreeing with it.
    const alwaysOn = routinesDoc.slice(routinesDoc.indexOf('## Always-on routines'));
    assert.doesNotMatch(alwaysOn, /depends on whether your sync tool/i,
      'the outcome does not depend on the sync tool, and the page must not say it does');
    assert.match(alwaysOn, /does not change that|whether or not/i,
      'the page must say plainly that the sync tool is not the variable');
    assert.match(alwaysOn, /in-memory|memory/i,
      'and name the reason, which is the copy the tick actually reads');
  });

  test('the always-on section says the machine serves one workspace', () => {
    const alwaysOn = routinesDoc.slice(routinesDoc.indexOf('## Always-on routines'));
    assert.match(alwaysOn, /workspace it has open, not of every workspace/i,
      'a machine running Rundock for one workspace is not running another workspace\'s routines');
  });

  test('the page gives the reason for serving only the open workspace', () => {
    // A contributor meeting this behaviour must find why rather than reading it
    // as an oversight and widening it.
    const behaviour = routinesDoc.slice(
      routinesDoc.indexOf('### Routines run for the workspace that is open'),
      routinesDoc.indexOf('## Always-on routines'),
    );
    assert.ok(behaviour.length > 0, 'sanity: the section exists');
    assert.match(behaviour, /consent/i, 'the reason is named');
    assert.match(behaviour, /have not opened|not looking at/i,
      'and said in terms of what running from a closed workspace would do');
    assert.match(behaviour, /What would change it/i,
      'and what would overturn it is stated, so the decision is revisitable rather than fixed');
  });
});
