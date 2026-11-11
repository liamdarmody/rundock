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
//
// Bounded by heading structure, not by a literal version string: the release
// script renames "## Unreleased" to "## <version>: ..." the moment a release
// branch is prepared, so a pin naming today's version number would go blind
// (empty slice, every assertion failing) on the very next release. The
// topmost "## " heading is always the entry being shipped, whatever it is
// named; the second bounds it.
//
// SKIPS A LEADING "## Unreleased", IF ONE HAS SINCE BEEN ADDED. The claims
// pinned below (the workspace boundary card, the macOS sandbox) belong to the
// 0.12.0 release specifically: they were written the day it shipped, when its
// own heading was topmost. Work on the NEXT release starts by adding a fresh
// "## Unreleased" above it, same as this file's own comment already expects
// for one release out. That new section carries no claim these pins are
// about, so grabbing whatever is now topmost would blind every assertion here
// the moment that next section existed, for the same reason named above:
// an empty slice, every assertion failing, on a release these pins were never
// about. So: skip a leading "## Unreleased" and bind to the heading after it,
// which is 0.12.0 today and will be whatever ships next once 0.12.0 itself is
// no longer near the top.
// BOUND TO THE RELEASE THESE CLAIMS ARE ABOUT, by name, rather than to whatever
// heading happens to be topmost.
//
// Taking the top heading (skipping a literal "## Unreleased") worked only while
// the release in question stayed at the top, and quietly re-pointed itself at
// the next one the moment a version was named. That is a trap laid at the worst
// possible moment: the pins go red DURING a release cut, on a changelog entry
// that is perfectly correct, because they have silently started asking a new
// entry to carry claims it was never about. The file's own history records this
// being re-pointed once already, from one release to the next.
//
// Named explicitly, a release that moves these claims fails here with a message
// saying so, which is a decision someone makes rather than a mystery they debug
// while trying to ship.
const CLAIMS_BELONG_TO = '0.13.0';
const changelogHeadings = [...changelog.matchAll(/^## .*$/gm)];
const shippedIdx = changelogHeadings.findIndex(h => h[0].includes(CLAIMS_BELONG_TO));
assert.ok(shippedIdx >= 0,
  `the changelog no longer has a ${CLAIMS_BELONG_TO} section; if these claims now belong to a `
  + 'different release, move CLAIMS_BELONG_TO deliberately rather than letting the pins drift');
const shippedEntry = changelog.slice(
  changelogHeadings[shippedIdx].index,
  changelogHeadings[shippedIdx + 1]?.index ?? changelog.length,
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
      assert.ok(shippedEntry.includes(d), `the release notes name ${d}, which the code does not card`);
    }
    assert.match(shippedEntry, /\/dev\/null/, 'and the device paths');
  });

  test('the copy does not claim the command check sees every visible target', () => {
    // Four reviews failed the same criterion, each on a different
    // spelling written plainly in the command and not carded. The
    // implementation improved every round and the claim kept failing, because
    // reading a shell command without running it has no complete answer. What
    // changed is the claim: the guarantee is the operating-system half, and
    // the card is a best effort that names where it stops.
    assert.match(shippedEntry, /best effort/i, 'the release notes call the check what it is');
    assert.match(shippedEntry, /raise no card|raises no card/i,
      'and say plainly that some targets raise nothing');
    assert.match(shippedEntry, /~someone\/file|-C\/tmp/,
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

describe('ARCHITECTURE.md: what happens to a call when the permission hook fails', () => {
  // The claim: on Claude Code 2.1.295 and later a failing permission hook
  // blocks the call, earlier versions let it through with the hook's own
  // refusal the only answer, and a wrong value for the field voids the whole
  // settings file, which is why only one constant is ever written. A reader
  // trusting the first half while the field had quietly gone from the entries
  // would be trusting a block that is not there, so the value the passage
  // quotes is checked against what an open actually writes.
  const scaffoldLib = require('../../lib/workspace/scaffold.js');
  const passage = architecture.split('\n\n').find((p) => p.includes('onFailure') && p.includes('2.1.295 and later')) || '';

  test('the passage gives the outcome by version, as observed, and says why only the constant is written', () => {
    assert.ok(passage, 'a paragraph names the field and the versions that honor it');
    assert.match(passage, /2\.1\.294/, 'and the last version observed to ignore it');
    assert.match(passage, /[Oo]bserved/, 'stated as observed, not as a guess');
    assert.match(passage, /hook's own refusal is the only answer/, 'before 2.1.295 the hook alone answers');
    assert.match(passage, /skip the whole settings file/, 'a wrong value voids the file');
    assert.match(passage, /only the constant is ever written/, 'and that is why one constant is written');
    assert.match(passage, /`HOOK_ON_FAILURE`/, 'naming it');
    assert.doesNotMatch(passage, /\/Users\/|\/home\/|[A-Z]:\\/, 'with no personal paths');
    assert.doesNotMatch(architecture, /registration does not set/, 'the sentence saying Rundock does not set it is gone');
  });

  test('the value the passage quotes is the one every PreToolUse entry gets, and no PostToolUse entry', () => {
    const quoted = passage.match(/`"onFailure": "([^"]*)"`/);
    assert.ok(quoted, 'the passage quotes the field as it is written');
    assert.strictEqual(quoted[1], scaffoldLib.HOOK_ON_FAILURE, 'the quoted value is the constant');
    const dir = useWorkspace({ claudeMd: '# x' });
    srv.scaffoldWorkspace(dir, { platform: 'darwin' });
    const settings = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf-8'));
    assert.strictEqual(settings.hooks.PreToolUse.length, 4);
    for (const e of settings.hooks.PreToolUse) assert.strictEqual(e.hooks[0].onFailure, quoted[1], `${e.matcher} carries it`);
    for (const event of ['PostToolUse', 'PostToolUseFailure']) {
      for (const e of settings.hooks[event]) assert.ok(!('onFailure' in e.hooks[0]), `${event} does not`);
    }
  });

  test('going back to an earlier release keeps the field, as the record the passage names shows', () => {
    const named = passage.match(/`(scripts\/hook-on-failure-undo\/[a-z-]+\.json)`/);
    assert.ok(named, 'the passage names the record');
    const record = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', named[1]), 'utf-8'));
    assert.match(passage, new RegExp(`the ${record.release.replace(/\./g, '\\.')} release's own scaffold`), 'the release the passage names is the one recorded');
    assert.match(passage, /left the settings file byte for byte/);
    assert.strictEqual(record.releaseChangedTheFile, false, 'and the record says the release left it as it was');
    assert.deepStrictEqual(record.leftByRelease, record.written);
    assert.match(passage, /renamed over it only once that write has finished/, 'the passage says the file is written whole');
  });
});

describe('ARCHITECTURE.md: the oldest Claude Code Rundock starts', () => {
  // The number a contributor reads is the one the flag table derives, so a
  // flag that raises the floor fails here until the sentence says so.
  test('the runtime section names the floor the flag table derives, and where the table is', () => {
    const { FLOOR } = require('../../lib/runtime/claude-floor.js');
    const paragraph = architecture.split('\n').find((line) => line.includes('`lib/runtime/claude-floor.js`'));
    assert.ok(paragraph, 'the runtime section names the flag table');
    assert.ok(paragraph.includes(`below ${FLOOR}, the first release that accepts every flag Rundock passes`),
      `and the floor it derives, ${FLOOR}`);
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

describe('ROUTINES.md: the child\'s output is discarded, and its stderr kept only until the run ends', () => {
  // The claim: "The child's stdout is attached to the null device, and its
  // stderr to a file beside the run's record", read once when the child ends
  // and then removed.
  //
  // This one is load-bearing in a way the others are not: it is the claim that
  // says the hazard cannot happen. The page previously stated the opposite,
  // that the pipes were open but unread and that this was a deliberate choice,
  // and that sentence was true for as long as it took a routine to print
  // 160 KB, after which the routine hung and never ran again. Put 'pipe' back
  // in any slot and this sentence is false with nothing noticing: the
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

  // What the scheduler asks of each spawn when it starts a routine, and what
  // was beside the run's record at that moment. `drive` stands in for each
  // child in turn: it is handed the arguments, the options and the stand-in
  // child, and may write to the child's stderr and end it.
  //
  // lib/scheduler.js destructures spawnClaude at load, so a copy required
  // after the export is swapped closes over the stand-in, and the swap is
  // undone before the shared instance the rest of the suite runs against can
  // see it. Same technique as test/unit/scheduler-lib.test.js, and the same
  // reason: a spawn dep on the wiring surface would be a seam in production
  // code that only tests would ever use.
  function whatTheSpawnIsAskedFor(agent = { id: 'runner', name: 'Runner' }, drive = () => {}) {
    const claude = require(CLAUDE_KEY);
    const realSpawn = claude.spawnClaude;
    const prevClaudeDeps = claude.wireClaudeRuntimeDeps({ getActualPort: () => 0 });
    const cached = require.cache[SCHEDULER_KEY];
    const spawns = [];
    let sched = null;
    let dir = null;
    claude.spawnClaude = (args, options) => {
      const runs = path.join(dir, '.rundock', 'runs');
      // A child that reports nothing unless `drive` makes it. One that is never
      // ended leaves its run held, which is why the workspace is this test's own.
      const child = new (require('node:events').EventEmitter)();
      spawns.push({ args, options, beside: fs.existsSync(runs) ? fs.readdirSync(runs) : [] });
      drive(spawns.length, { args, options, child });
      return child;
    };
    try {
      delete require.cache[SCHEDULER_KEY];
      sched = require(SCHEDULER_KEY);
      delete require.cache[SCHEDULER_KEY];
      sched.wireSchedulerDeps({ getWssClients: () => [] });
      dir = useWorkspace({ agents: standardTeam() });
      sched.executeRoutine(agent, { name: 'r', prompt: 'p' }, `${agent.id}:r`);
    } finally {
      claude.spawnClaude = realSpawn;
      claude.wireClaudeRuntimeDeps(prevClaudeDeps);
      if (cached) require.cache[SCHEDULER_KEY] = cached;
    }
    assert.ok(spawns.length, 'the scheduler reached the spawn, so there is a configuration to read');
    return { ...spawns[0], spawns, sched, dir };
  }

  test('the spawn discards stdout and gives stderr a file, never a pipe, which is what the page promises', () => {
    const { options, beside, sched } = whatTheSpawnIsAskedFor();
    const [stdin, stdout, stderr] = options.stdio;
    assert.strictEqual(stdin, 'ignore');
    assert.strictEqual(stdout, 'ignore', 'stdout is discarded: an unread pipe in ANY slot hangs the child');
    assert.strictEqual(typeof stderr, 'number', 'stderr is a file descriptor, which no reader has to drain');
    assert.ok(!options.stdio.includes('pipe'), 'and no slot is a pipe');
    const [run] = sched.runningRuns();
    assert.ok(beside.includes(`${run.id}.stderr`), 'the file is beside the run\'s record, named for the run');
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.fstatSync(stderr).mode & 0o777, 0o600, 'and readable by its user alone');
    }
    assert.match(routinesDoc, /The file is created new, readable by your user alone, and never opened through a link or over a file already there\. Only its last 4 KB are kept/,
      'which the page says, with the bound');
    assert.match(routinesDoc, /The file is cut back, not capped as it is written/, 'and what the bound does not promise');

    // The page's half of the same claim. Read as the sentence a user meets,
    // not as a keyword, because "discarded" appears elsewhere on the page.
    assert.match(routinesDoc, /The child's stdout is attached to the null device, and its stderr to a file beside the run's record/,
      'ROUTINES.md must state what the spawn does, and it is this sentence that says it');
    assert.match(routinesDoc, /\*\*Rundock discards stdout, and keeps stderr in a file only until the run ends\.\*\*/,
      'and say it in the paragraph a reader looking for routine output would land on');
    assert.doesNotMatch(routinesDoc, /\*\*Rundock discards both\.\*\*/, 'the old sentence, which is no longer true, is gone');
  });

  test('the file is gone once the child has ended, as the page says', () => {
    const { dir } = whatTheSpawnIsAskedFor(undefined, (n, { child }) => setImmediate(() => child.emit('close', 0)));
    return new Promise(resolve => setImmediate(resolve)).then(() => new Promise(resolve => setImmediate(resolve))).then(() => {
      const left = fs.readdirSync(path.join(dir, '.rundock', 'runs')).filter(f => !f.endsWith('.json'));
      assert.deepStrictEqual(left, [], 'nothing but the record is left in the runs folder');
      assert.match(routinesDoc, /and removes it, whether the run finished, failed, crashed or never started/);
    });
  });

  test('the doc says it is pinned, and names this file', () => {
    // Named beside the claim itself rather than only once in the file, so an
    // editor rewriting this paragraph is told where its behaviour is asserted.
    const paragraph = routinesDoc.split('\n').find(l => l.includes('Rundock discards stdout, and keeps stderr in a file'));
    assert.ok(paragraph, 'the claim is in the page');
    assert.match(paragraph, /doc-claims\.test\.js/,
      'the paragraph making the claim must name the test that pins it, so the next editor moves both');
  });

  // The claim: "A routine loads its agent's file", and when Claude Code cannot
  // load it, the run goes ahead once as a plain session and its record says
  // so. Read off the spawns the scheduler really makes when the first child
  // says what Claude Code says and ends as Claude Code ends.
  test('a routine is started as its agent, and falls back once, with a notice, when Claude Code cannot load the file', async () => {
    const agent = { id: 'runner', name: 'Runner', fileName: 'runner.md', description: '' };
    const { spawns, sched } = whatTheSpawnIsAskedFor(agent, (n, { options, child }) => {
      if (n === 1) fs.writeSync(options.stdio[2], "--agent 'Runner' not found. Available agents: claude, Explore\n");
      setImmediate(() => child.emit('close', n === 1 ? 1 : 0));
    });
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(spawns.length, 2, 'the agent, then one plain session');
    const flag = (args) => (args.includes('--agent') ? args[args.indexOf('--agent') + 1] : null);
    assert.strictEqual(flag(spawns[0].args), 'Runner', 'started as the agent, by its name');
    assert.strictEqual(flag(spawns[1].args), null, 'then as a plain session');
    const [record] = sched.readRunRecords();
    assert.strictEqual(record.status, 'succeeded');
    assert.match(record.notice, /instructions and its tools: line were not applied/);
    assert.match(record.notice, /Claude Code said: --agent 'Runner' not found\./);
    assert.match(record.notice, /\.claude\/agents\/runner\.md/);
    const { describeRun, WITHOUT_AGENT_STATE } = require('../../public/run-detail-model.js');
    assert.strictEqual(describeRun(record).state.chip, WITHOUT_AGENT_STATE.chip);

    // And the line alone is not enough: naming another agent, it starts
    // nothing else.
    const other = whatTheSpawnIsAskedFor(agent, (n, { options, child }) => {
      fs.writeSync(options.stdio[2], "--agent 'Someone else' not found. Available agents: claude, Explore\n");
      setImmediate(() => child.emit('close', 1));
    });
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(other.spawns.length, 1, 'a refusal of another agent is not a refusal of this one');
    assert.strictEqual(other.sched.readRunRecords()[0].status, 'failed');

    const loads = routinesDoc.split('\n').find(l => l.includes("**A routine loads its agent's file.**"));
    assert.ok(loads, 'ROUTINES.md says what a routine loads');
    assert.match(loads, /its instructions, and any `tools:` line in it, apply to the routine/);
    const fallback = routinesDoc.split('\n').find(l => l.startsWith('**If Claude Code cannot load the agent file, the run goes ahead once without it, and its record says so.**'));
    assert.ok(fallback, 'and how it falls back');
    assert.match(fallback, /`--agent '<name>' not found`/, 'naming the line Claude Code writes, which is the line the scheduler recognizes');
    assert.ok(fallback.includes(`**${WITHOUT_AGENT_STATE.chip}**`), 'and the words the run screen shows');
    assert.match(fallback, /a `notice`/, 'and the field the record carries');
    assert.match(fallback, /at most once/);
    assert.match(fallback, /It falls back only when both hold: no session was started, and the line names this agent\./);
    assert.match(fallback, /If they load it, nothing is guessed: the run is recorded as failed, once, with the reason that Claude Code stopped before the session started and Rundock could not read why, and with no notice\./);
    assert.match(fallback, /If the file holds YAML those rules do not cover, or Rundock fails to read it, that is deliberately a failed run too, and not a fallback/);
    assert.match(fallback, /`claude --print --agent '<name>' "say hello"`, run in the workspace, answers `--agent '<name>' not found` when it cannot\./);
    assert.match(fallback, /doc-claims\.test\.js/, 'the paragraph names the test that pins it');
  });

  // The claim: every routine run is told that nobody is watching, in its
  // system prompt, in the words scripts/refusal-notice.js keeps beside the line
  // a refused step is given. Read off the arguments the scheduler really hands
  // the spawn, the same stand-in the stdio claim above is read through.
  test('every routine is told nobody is watching, in its system prompt, as the page says', () => {
    const { UNATTENDED_RUN, FAILED_LINE } = require('../../scripts/refusal-notice.js');
    const { args } = whatTheSpawnIsAskedFor();
    assert.strictEqual(args[args.indexOf('--append-system-prompt') + 1], UNATTENDED_RUN,
      'the line goes in the system prompt');
    assert.strictEqual(args[args.length - 1], 'p', 'and the routine prompt is sent as it was written');

    const paragraph = routinesDoc.split('\n').find(l => l.startsWith('**Every routine run is told that nobody is watching.**'));
    assert.ok(paragraph, 'ROUTINES.md says every routine run is told');
    assert.match(paragraph, /`--append-system-prompt`/);
    assert.match(paragraph, /On Codex it is the thread's developer instructions/);
    assert.match(paragraph, /The routine prompt itself is never changed/);
    assert.match(paragraph, /A conversation never gets it\./);
    assert.match(paragraph, /`scripts\/refusal-notice\.js`/);
    assert.ok(UNATTENDED_RUN.endsWith(FAILED_LINE), 'and both lines end on the same failure line, as it says');
    assert.match(paragraph, /doc-claims\.test\.js/, 'the paragraph names the test that pins it');
  });

  // The claim: a Claude Code routine is also told to change workspace files
  // with its file tools, word for word as the page quotes it, and a Codex
  // routine is not. The page quotes the sentence, so a rewording on either
  // side fails here. The Codex half is read through the real spawn path in
  // test/integration/routine-unattended-line.test.js.
  test('a Claude Code routine is told to use its file tools, and a Codex routine is not, as the page says', () => {
    const { UNATTENDED_RUN, UNATTENDED_RUN_CODEX, FAILED_LINE } = require('../../scripts/refusal-notice.js');
    const FILE_TOOLS = 'To create, change or copy a file in the workspace, use your file tools (Write and Edit) rather than the shell: a shell command that changes files can need an approval that nobody here can give.';
    const { args } = whatTheSpawnIsAskedFor();
    const line = args[args.indexOf('--append-system-prompt') + 1];
    assert.ok(line.includes(`Save the work in the workspace as you go. ${FILE_TOOLS} End your final message`),
      'the Claude Code line carries the sentence, straight after saving the work');
    assert.ok(!UNATTENDED_RUN_CODEX.includes(FILE_TOOLS), 'the Codex line does not');

    const paragraph = routinesDoc.split('\n').find(l => l.startsWith('**Every routine run is told that nobody is watching.**'));
    assert.ok(paragraph, 'ROUTINES.md says what every routine run is told');
    assert.ok(paragraph.includes(`A Claude Code routine's line also says, straight after the part about saving its work: "${FILE_TOOLS}"`),
      'the page quotes the sentence word for word, and says where it sits');
    assert.match(paragraph, /In Notes mode a shell command that changes files asks for approval/, 'and why it is said');
    assert.match(paragraph, /A Codex routine is not told this: its thread runs with approvals set to never, so nothing it runs asks, and its tools are not called Write and Edit\./,
      'and that Codex is not told it, and why');
    assert.ok(UNATTENDED_RUN.endsWith(FAILED_LINE) && UNATTENDED_RUN_CODEX.endsWith(FAILED_LINE),
      'both routine lines end on the same failure line');
    assert.match(paragraph, /both routine lines end on the same failure line it does\./, 'as it says');
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

  test('a run that used the shell is said to be one, on the record and on the run screen', () => {
    // A shell write is not on the list, and the page used to stop there. The
    // record now says when the shell was used, under the field name the
    // scheduler writes, and the run screen says what that means for the list.
    assert.match(routinesDoc, /The record says when the run used the shell \(`usedShell: true`\), and the run screen says so under the list/,
      'ROUTINES.md must say the run screen tells you when a run used the shell');
    assert.ok(fs.readFileSync(path.join(ROOT, 'lib', 'scheduler.js'), 'utf-8').includes('{ usedShell: true }'),
      'the field the page names is the one the scheduler writes');
    assert.doesNotMatch(routinesDoc, /shell command is invisible/,
      'the page no longer says only that shell writes are invisible');
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
// docs/ROUTINES.md: the run guard, said by time
// ---------------------------------------------------------------------------

describe('ROUTINES.md: the run guard holds a slot by time, not by hour', () => {
  const { getNextRun, wireSchedulerDeps } = require('../../lib/scheduler.js');
  // The paragraph that says what the guard does, found by its first words.
  const paragraph = routinesDoc.split('\n').find(line => line.startsWith('Each routine has a `lastRun` guard.')) || '';

  // The claim, asked of getNextRun at a fixed instant rather than the wall
  // clock, so it says the same thing whenever the suite runs. Friday 3 July
  // 2026, built from local components.
  const friday = (hour, minute) => new Date(2026, 6, 3, hour, minute);
  function askedAt(now, schedule, lastRun) {
    const previous = wireSchedulerDeps({ now: () => now });
    try {
      return getNextRun(schedule, lastRun.toISOString());
    } finally {
      wireSchedulerDeps(previous);
    }
  }

  test('the doc states the guard by time and says what a later time on the same day does', () => {
    assert.match(paragraph, /Daily and weekly routines do not re-fire once they have run at or after their scheduled time in that period/,
      'ROUTINES.md must state the guard by time');
    assert.match(paragraph, /Moving one to a later time on a day it has already run makes it run again at the new time, including a later time that has already gone/,
      'ROUTINES.md must say what a move to a later time on the same day does');
    assert.match(paragraph, /A run still going at the new time counts for it/);
    assert.doesNotMatch(paragraph, /scheduled hour|same weekday/,
      'ROUTINES.md must not keep the rule by hour, or by weekday alone, beside it');
  });

  for (const schedule of ['every day at 20:30', 'every friday at 20:30']) {
    test(`a run stamped at 20:03 does not hold a 20:30 slot: ${schedule}`, () => {
      assert.deepStrictEqual(askedAt(friday(20, 30), schedule, friday(20, 3)), friday(20, 30),
        'moved to 20:30 after a run at 20:01, it runs at 20:30');
    });

    test(`a run stamped at 20:31 holds the 20:30 slot: ${schedule}`, () => {
      assert.strictEqual(askedAt(friday(20, 45), schedule, friday(20, 31)), null,
        'having run at 20:30, it does not re-fire that day');
    });
  }
});

// ---------------------------------------------------------------------------
// docs/ROUTINES.md: a monthly schedule, and its window
// ---------------------------------------------------------------------------

describe('ROUTINES.md: a monthly routine runs once a month and catches up within it', () => {
  const { getNextRun, wireSchedulerDeps } = require('../../lib/scheduler.js');
  const section = (heading) => {
    const start = routinesDoc.indexOf(`\n## ${heading}\n`);
    const end = routinesDoc.indexOf('\n## ', start + 1);
    return start === -1 ? '' : routinesDoc.slice(start, end === -1 ? undefined : end);
  };
  const format = section('Schedule format');
  const behaviour = section('Scheduler behaviour');

  // Asked at fixed instants in October 2026, built from local components.
  const october = (day, hour, minute = 0) => new Date(2026, 9, day, hour, minute);
  function askedAt(now, schedule, lastRun) {
    const previous = wireSchedulerDeps({ now: () => now });
    try {
      return getNextRun(schedule, lastRun ? lastRun.toISOString() : null);
    } finally {
      wireSchedulerDeps(previous);
    }
  }
  const DAY_15 = 'on day 15 of every month at 09:00';

  test('the format table gives both monthly forms, and says why 29 to 31 are refused', () => {
    assert.match(format, /\| `on day N of every month at HH:MM` \|.*N is a day from 1 to 28/,
      'ROUTINES.md must give the day-of-month form with its range');
    assert.match(format, /\| `on the last day of every month at HH:MM` \|/, 'and the last-day form');
    assert.match(format, /Days 29, 30 and 31 are refused, because they are not in every month, and Rundock will not move a slot to another date/,
      'and why the days some months lack are refused');
  });

  test('both forms parse, and day 31 does not', () => {
    assert.ok(askedAt(october(1, 8), DAY_15, null), 'the day-of-month form is read');
    assert.ok(askedAt(october(1, 8), 'on the last day of every month at 18:00', null), 'and the last-day form');
    assert.strictEqual(askedAt(october(1, 8), 'on day 31 of every month at 09:00', null), null, 'day 31 is not');
  });

  test('the catch-up section gives the monthly window, and what is never owed', () => {
    assert.match(behaviour, /A monthly routine catches up within its month\./);
    assert.match(behaviour, /runs once, at the first tick Rundock is open later in the same month, and its row marks the run as late/);
    assert.match(behaviour, /If the month ends first, it does not run, and the slot is recorded as missed/);
    assert.match(behaviour, /not owed at all if it passed before the routine existed, while it was paused or switched off, or before its plan was approved/);
    assert.match(behaviour, /A monthly routine does not re-fire once it has run at or after its scheduled time in that month/,
      'and the guard sentence covers the monthly period');
  });

  // What a late monthly run carries is its record's dueAt, and its row marks it
  // late, naming when it was due.
  test('the catch-up section says the record carries dueAt, and the row marks a late run', () => {
    assert.match(behaviour, /Its run record names the slot it was due at, in a `dueAt` field, on every scheduled run/);
    assert.match(behaviour, /its row marks the run as late, naming when it was due/);
  });

  test('a slot earlier this month is still due', () => {
    assert.deepStrictEqual(askedAt(october(20, 10), DAY_15, null), october(15, 9),
      'on the 20th, the 15th is still owed and the next tick fires it');
  });

  test("last month's slot is not", () => {
    const next = askedAt(october(2, 10), DAY_15, null);
    assert.deepStrictEqual(next, october(15, 9), "on 2 October, the next run is this month's, not September's");
  });

  test('one that ran this month is suppressed', () => {
    assert.strictEqual(askedAt(october(25, 10), DAY_15, october(20, 10, 5)), null,
      'having caught up on the 20th, it is not due again that month');
  });

  // The row's word for a late run is the model's own lead, read off it, so the
  // page and the row cannot part company on it.
  test('the page calls a late run what the row calls it', () => {
    const { OUTCOMES, CATCH_UP_AFTER_MS } = require('../../public/routines-model.js');
    const lead = OUTCOMES['caught-up'].lead;
    assert.strictEqual(lead, 'Ran late');
    assert.match(routinesDoc, /The row's on-time, ran-late and missed verdicts are computed from scheduled runs only/,
      'the verdict words follow the row');
    assert.ok(behaviour.includes(`its row then leads with **${lead}**, naming when it started and when it was due`),
      'and so does the description of a late run');
    assert.match(behaviour, new RegExp(`A run counts as late from ${CATCH_UP_AFTER_MS / 60000} minutes after its slot\\.`));
    assert.doesNotMatch(routinesDoc, /caught-up verdict|Caught up:/, 'the old word is gone from the page');
  });

  test('the page no longer says there are only two forms, or a run once per day or week', () => {
    assert.doesNotMatch(routinesDoc, /only two patterns|the two forms that work|both forms that work|two accepted forms|once per day or week/,
      'every sentence that counted two forms follows the change');
  });
});

// ---------------------------------------------------------------------------
// docs/ROUTINES.md: a routine on a set of days
// ---------------------------------------------------------------------------

describe('ROUTINES.md: a routine on a set of days', () => {
  const { getNextRun, parseSchedule, wireSchedulerDeps } = require('../../lib/scheduler.js');
  const editor = require('../../public/routine-editor-model.js');
  const section = (heading) => {
    const start = routinesDoc.indexOf(`\n## ${heading}\n`);
    const end = routinesDoc.indexOf('\n## ', start + 1);
    return start === -1 ? '' : routinesDoc.slice(start, end === -1 ? undefined : end);
  };
  const format = section('Schedule format');
  const behaviour = section('Scheduler behaviour');

  test('the format table gives the weekday form and the list form, and the examples parse', () => {
    assert.match(format, /\| Every weekday \| `every weekday at HH:MM` \| Monday to Friday\./);
    assert.match(format, /\| A list of days \| `every <day>, <day> and <day> at HH:MM` \| Full day names, in any order, joined by commas and a final `and`/);
    for (const schedule of ['every weekday at 08:30', 'every monday, wednesday and friday at 18:00',
      'every saturday and sunday at 10:00', 'every monday, wednesday and sunday at 09:00']) {
      assert.ok(format.includes(schedule), `the format section no longer gives ${schedule}`);
      assert.ok(parseSchedule(schedule), `${schedule} is given as working and does not parse`);
    }
    for (const schedule of ['every mon and fri at 18:00', 'every monday, friday at 18:00']) {
      assert.ok(format.includes(`schedule: ${schedule}`), `the format section no longer warns about ${schedule}`);
      assert.strictEqual(parseSchedule(schedule), null, `${schedule} is given as never firing and parses`);
    }
  });

  // The page says the catch-up in the editor's own words, read off the model,
  // so the two cannot say it differently.
  test('the page says the catch-up as the editor does, and no longer as "the same day"', () => {
    const said = editor.WORKSPACE_CAVEAT.slice(editor.WORKSPACE_CAVEAT.lastIndexOf('A missed slot'));
    assert.strictEqual(said, 'A missed slot is caught up if Rundock is open again that day.');
    assert.ok(behaviour.includes(said), 'the catch-up sentence is the editor\'s');
    assert.doesNotMatch(routinesDoc, /caught up the same day/);
  });

  test('the page never mentions public holidays', () => {
    assert.doesNotMatch(routinesDoc, /holiday/i);
  });

  // Asked at fixed instants in November 2026, built from local components.
  // 6 November is a Friday.
  const november = (day, hour, minute = 0) => new Date(2026, 10, day, hour, minute);
  function askedAt(now, schedule) {
    const previous = wireSchedulerDeps({ now: () => now });
    try {
      return getNextRun(schedule, null);
    } finally {
      wireSchedulerDeps(previous);
    }
  }

  test('the catch-up section says what a set of days does on a day it leaves out, and it does', () => {
    assert.match(behaviour, /A routine on a set of days catches up on each chosen day, as a weekly one does\./);
    assert.match(behaviour, /A day the set leaves out has no slot: the routine does not run that day, catches nothing up on it, and the day is never recorded as missed\./);
    assert.match(behaviour, /closed through Friday's slot and opened on Saturday does not run on Saturday: its row says Friday's slot was missed, and names Monday as the next run/);
    assert.deepStrictEqual(askedAt(november(6, 14), 'every weekday at 09:00'), november(6, 9),
      'on Friday afternoon, Friday\'s slot is still owed');
    assert.deepStrictEqual(askedAt(november(7, 10), 'every weekday at 09:00'), november(9, 9),
      'on Saturday, the next is Monday\'s');
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

  // THE MECHANISM, NAMED FOR WHAT IT CHECKS AND NOTHING MORE.
  //
  // This asserts one link in the chain: that writing the shared file does not
  // put anything into the object the tick decides with. It does NOT tick, so
  // it cannot on its own prove that the tick path never reloads. The test that
  // proves that is 'two instances on one workspace both fire the routine,
  // sharing one state file' in test/unit/scheduler-lib.test.js, which ticks
  // both instances and watches both spawn. An earlier version of this test
  // claimed the tick-path conclusion while checking only the link below, so it
  // would have passed unchanged against a scheduler that re-read the file on
  // every pass.
  //
  // Kept beside the doc claims rather than folded into that file because it is
  // the link the PAGE's wording rests on: the page says the guard is filled at
  // start and on a workspace switch and not otherwise, and this is the "not
  // otherwise".
  test('writing the shared file puts nothing into the object the tick decides with', () => {
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
        'the file changed under a running instance and the loaded copy moved with it');

      const state = srv.routineState[KEY];
      assert.notStrictEqual(srv.getNextRun(SCHEDULE, state && state.lastRun), null,
        'so this instance still has a run due');
      assert.strictEqual(srv.getNextRun(SCHEDULE, RAN_AT.toISOString()), null,
        'and the recorded run WOULD have suppressed it, so it is the not-reading and not the schedule that decides');
    });
  });

  // THE OTHER HALF OF THE PAGE'S WORDING, WHICH IS AN ABSENCE.
  //
  // The page says an instance fires whether or not the state file reached it.
  // That rests on nothing outside loadRoutineState ever reading the file: a
  // watcher on .rundock/ would reload it as a synced copy arrived and the
  // sentence would stop being true without a line of the scheduler changing.
  //
  // ASSERTED AGAINST THE SOURCE BECAUSE THE CLAIM IS THAT NOTHING EXISTS, and
  // a behavioural test can only ever show that one particular thing did not
  // happen. Read at the time of writing: the file is named in lib/scheduler.js
  // in comments, in one read inside loadRoutineState, in one write inside the
  // save, and in one read of a workspace that is NOT open, for a run of it that
  // ends with no state carried. That last read fills only the state carried for
  // that workspace, which the tick never decides with. No watcher anywhere in
  // the server names the file.
  test('nothing but the load ever reads the open workspace\'s state file', () => {
    const scheduler = fs.readFileSync(path.join(ROOT, 'lib', 'scheduler.js'), 'utf-8');
    // Code lines only: a comment naming the file is prose, not a reader.
    const touches = scheduler.split('\n')
      .filter(line => line.includes('routine-state.json') && !line.trim().startsWith('//'));
    assert.strictEqual(touches.length, 3,
      `the state file is named in ${touches.length} code lines, not the read, the write and the read for a workspace not open:\n${touches.join('\n')}`);

    // And each sits in the one function it belongs to, so none can be reached
    // except by loading the state, saving it, or building a closed workspace's.
    const between = (from, to) => scheduler.slice(scheduler.indexOf(from), scheduler.indexOf(to));
    const load = between('function loadRoutineState()', 'function saveRoutineState()');
    const save = between('function saveRoutineState()', '// ===== SLOTS THAT PASSED UNSERVED =====');
    assert.match(load, /readFileSync[\s\S]{0,80}routine-state\.json|routine-state\.json[\s\S]{0,80}readFileSync/,
      'the only read of the open workspace\'s file is inside the load, which runs at boot and on a workspace switch');
    assert.match(save, /routine-state\.json/, 'and the only write is inside the save');
    const built = between('function stateInItsFile(', '// ===== RUN RECORDS =====');
    assert.match(built, /routine-state\.json[\s\S]{0,80}readFileSync/, 'the other read builds the state of a workspace');
    const routed = between('function statesFor(', 'function stateInItsFile(');
    assert.match(routed,
      /if \(workspace === getWorkspace\(\)\) return routineState;\n\s*if \(!carriedStates\.has\(workspace\)\) carriedStates\.set\(workspace, stateInItsFile\(workspace\)\);/,
      'only one that is not open, into the state carried for it, never into the one the tick reads');
    assert.strictEqual(scheduler.split('stateInItsFile(').length, 3, 'and it is built there and nowhere else');
    // And nothing watches the folder it lives in.
    for (const file of ['lib/scheduler.js', 'server.js']) {
      const src = fs.readFileSync(path.join(ROOT, file), 'utf-8');
      assert.doesNotMatch(src, /fs\.watch\s*\(|fs\.watchFile\s*\(/,
        `${file} watches files, so a synced state file could arrive and be reloaded`);
    }
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

  // The claim is scoped, and the scope is the half that makes it true. An
  // instance started or switched after a synced file lands DOES read it. The
  // page must not promise that no sequence can ever avoid the double run.
  test('the always-on section scopes the claim to instances that are both already up', () => {
    const alwaysOn = routinesDoc.slice(routinesDoc.indexOf('## Always-on routines'));
    assert.match(alwaysOn, /already running|already up/i,
      'the page must say which case the claim covers');
    assert.match(alwaysOn, /does read that file|is held for that slot/i,
      'and must not leave a reader thinking a restart ignores the file too');
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

// docs/ROUTINES.md: the switch that turns routines off on one computer. Each
// claim the page makes is bound to the code that keeps it: the words to the
// model's own, the record to the store, and where the check sits to the tick.
describe('ROUTINES.md: turning routines off on one computer', () => {
  const here = require('../../lib/agents/routines-here.js');
  const routinesModel = require('../../public/routines-model.js');
  const editorModel = require('../../public/routine-editor-model.js');
  const schedulerSrc = fs.readFileSync(path.join(ROOT, 'lib', 'scheduler.js'), 'utf-8');
  const section = (() => {
    const start = routinesDoc.indexOf('\n### Turning routines off on one computer\n');
    const end = routinesDoc.indexOf('\n## ', start + 1);
    return start === -1 ? '' : routinesDoc.slice(start, end);
  })();
  const between = (src, from, to) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));

  /** Run `fn` against a record of its own, so the checkout's is never touched. */
  function withRecord(fn) {
    const previous = here.storePath();
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'doc-routines-here-'));
    here.configureRoutinesHere(path.join(dir, 'routines-here.json'));
    try { return fn(dir); } finally {
      here.configureRoutinesHere(previous);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  test('the page names the switch and its words as the list draws them', () => {
    assert.ok(section.length > 0, 'the page has no section on turning routines off on one computer');
    assert.ok(section.includes(`**${routinesModel.HERE.label}**`), 'the switch is named in other words than its label');
    assert.ok(section.includes(`**${routinesModel.HERE.row}**`), 'the row\'s words are not the model\'s');
    assert.ok(section.includes('**Paused**'), 'and a paused routine still says Paused');
    assert.match(section, /It sits under the Routines header whether or not the workspace has routines yet/);
    assert.match(section, /a routine nobody has turned on still offers \*\*Turn on\*\*, because that writes the agent file every computer reads/);
    // The empty pane draws the switch the list does, and Turn on is offered
    // whatever the switch says.
    const viewSrc = fs.readFileSync(path.join(ROOT, 'public', 'views', 'routines.js'), 'utf-8');
    assert.match(between(viewSrc, 'function emptyHtml()', 'function confirmHtml('), /headerHtml\(null, null, hereHtml\(\)\)/,
      'the empty pane draws no switch');
    const offer = { enabled: false, refusal: 'enabled', schedule: 'every day at 07:00', prompt: 'p', workspace: '/w/a',
      servingWorkspace: '/w/a', nextRun: '2026-10-07T06:00:00.000Z', now: '2026-10-06T08:00:00.000Z' };
    assert.deepStrictEqual(!!routinesModel.enableOffer({ ...offer, offHere: true }), !!routinesModel.enableOffer(offer),
      'Turn on is offered differently while routines are off here');
    assert.ok(routinesModel.enableOffer(offer), 'sanity: the routine is offered Turn on');
  });

  test('it covers this workspace on this computer, is kept outside every workspace, and does not sync', () => {
    assert.match(section, /turns routines off for this workspace on this computer only, and it does not sync/);
    assert.match(section, /outside every workspace, beside the record of where routine approvals were given, keyed by the workspace's path on this computer/);
    assert.match(section, /It is on until you turn it off\. A workspace moved to a new path starts on/);
    withRecord((dir) => {
      const a = path.join(dir, 'a');
      const b = path.join(dir, 'b');
      fs.mkdirSync(a);
      fs.mkdirSync(b);
      assert.strictEqual(here.offHere(a), false, 'on is not the default');
      here.setOffHere(a, true);
      assert.strictEqual(here.offHere(b), false, 'another workspace on this computer was turned off');
      assert.deepStrictEqual(fs.readdirSync(a), [], 'something was written into the workspace');
    });
  });

  test('while off, nothing runs on a schedule, and Run now still does', () => {
    assert.match(section, /While it is off, this computer starts no routine of that workspace on a schedule/);
    assert.match(section, /It takes effect at the next tick, with no restart/);
    assert.match(section, /not recorded as missed and is not owed as a catch-up/);
    assert.match(section, /Run now still works while it is off/);
    assert.match(section, /its record says `trigger: manual`/);
    // The check reads the record on every tick, inside the tick, and the
    // pressed path does not pass through it.
    const tick = between(schedulerSrc, 'function startScheduler()', 'function stopScheduler()');
    assert.match(tick, /routinesHere\.offHere\(getWorkspace\(\)\)/, 'the tick does not read the record');
    assert.match(tick, /if \(offHere\) continue;/, 'the tick does not stop a due routine while off');
    const pressed = between(schedulerSrc, 'function runRoutineNow(', 'function recordFailedStart(');
    assert.doesNotMatch(pressed, /offHere/, 'Run now is held back by the switch');
    assert.match(pressed, /'manual'\)/, 'and a pressed run is still marked manual');
  });

  test('turning it back on is turning a routine on', () => {
    assert.match(section, /Turning it back on is turning a routine on/);
    assert.match(section, /A daily or weekly routine whose time has already gone today runs shortly after/);
    assert.match(section, /A monthly routine carries nothing across the time it was off/);
    assert.match(section, /Nothing that passed while it was off shows as missed/);
  });

  test('a record that cannot be read reads on, and a failed save changes nothing', () => {
    assert.match(section, /set aside under a dated name beside it, as the scheduler's state files are, and the switch reads on/);
    assert.match(section, /set aside the same way before the next change is written in its place, so the entries it holds for other workspaces are never written over; if it cannot be set aside, the change is not saved/);
    assert.match(section, /the record is left as it was, the switch stays where it was, and a short line under it says the change did not happen, until it is pressed again or a change made in another window arrives/);
    withRecord((dir) => {
      const a = path.join(dir, 'a');
      fs.mkdirSync(a);
      fs.writeFileSync(here.storePath(), '{ not json');
      const error = console.error;
      console.error = () => {};
      try { assert.strictEqual(here.offHere(a), false, 'a record nobody can read turned routines off'); } finally { console.error = error; }
      // A record of the wrong shape reads on, and is kept rather than written over.
      const held = JSON.stringify({ workspaces: [] });
      fs.writeFileSync(here.storePath(), held);
      console.error = () => {};
      try {
        assert.strictEqual(here.offHere(a), false);
        here.setOffHere(a, true);
      } finally { console.error = error; }
      const kept = fs.readdirSync(dir).filter(n => n.startsWith('routines-here.json.unparsed-'));
      assert.ok(kept.some(n => fs.readFileSync(path.join(dir, n), 'utf-8') === held), 'the record was written over');
    });
  });

  test('no sentence says a routine runs on the machine it was made on', () => {
    const untrue = /runs? on the machine (it was|they were) made on/i;
    assert.doesNotMatch(routinesDoc, untrue);
    assert.doesNotMatch(editorModel.RUN_ON_CAVEAT, untrue);
    assert.match(routinesDoc, /unless routines are off on one of them/,
      'the always-on section does not name the switch as the way to run them on one computer');
  });
});

// docs/ROUTINES.md: running a routine now, and the two paused states.
// Bound to the code's own words and lists, never to a sentence of the page:
// a sentence rewritten for clarity moves nothing here.

describe('ROUTINES.md: running a routine now, and consent as change-consent', () => {
  const scheduler = require('../../lib/scheduler.js');
  const model = require('../../public/routines-model.js');
  const runDetail = require('../../public/run-detail-model.js');
  const section = routinesDoc.slice(
    routinesDoc.indexOf('### Running a routine now'),
    routinesDoc.indexOf('### Routines run for the workspace that is open'),
  );

  test('the section exists and names the control the row draws', () => {
    assert.ok(section.length > 0, 'ROUTINES.md must carry the running-now section');
    assert.match(section, /Run/, 'and name the control');
    assert.match(section, /disabled/i, 'and say the control is disabled while a run is in flight');
    assert.strictEqual(model.runControl({ running: { trigger: 'manual' } }).disabled, true);
    assert.strictEqual(model.runControl({ paused: true, refusal: 'paused' }).disabled, false, 'and nothing but a run in flight disables it');
  });

  test('the refusals the page describes are exactly the ones the scheduler declares, and the tick\'s three consents are not among them', () => {
    const phrases = { runOn: /run target/, prompt: /no prompt/, running: /already going|already running/ };
    assert.deepStrictEqual(Object.keys(phrases).sort(), scheduler.MANUAL_RUN_REFUSALS.slice().sort(),
      'a refusal the scheduler grows needs a phrase here and on the page');
    for (const [word, phrase] of Object.entries(phrases)) assert.match(section, phrase, `the page must describe the "${word}" refusal`);
    const ok = { runOn: 'local', prompt: 'go', enabled: true };
    for (const held of [{ paused: true }, { enabled: false }, { planApprovedHash: 'pending' }]) {
      assert.strictEqual(scheduler.manualRunRefusal({ ...ok, ...held }, 'k'), null, 'a press ignores what only holds the tick');
    }
    assert.match(section, /unattended/, 'and the page gives the reason: those three are consent to run unattended');
  });

  test('the record words the page names are the ones the run-detail model reads, absence included', () => {
    assert.match(section, /`trigger`/, 'the page names the field');
    for (const word of ['manual', 'scheduled']) {
      assert.match(section, new RegExp('`' + word + '`'), `and the "${word}" value`);
      assert.strictEqual(runDetail.triggerOf({ trigger: word }), word);
    }
    assert.strictEqual(runDetail.triggerOf({}), 'scheduled', 'a record with no field reads as scheduled, as the page says');
    assert.ok(section.includes(model.RUNNING_WORDS.manual) && section.includes(model.RUNNING_WORDS.scheduled),
      'the page carries the row\'s own words for a run in flight, from the model');
  });

  test('a manual run moves no schedule: the page says so, and the scheduler\'s own answers are the same before, during and after', () => {
    assert.match(section, /moves no schedule/i);
    // The run is driven through the entry the row's message uses, in a
    // private scheduler whose child is a fake, and the guard is read back
    // from the scheduler itself: a trigger that stopped reaching the writers
    // as manual would move both answers.
    const key = require.resolve('../../lib/scheduler.js');
    const claude = require('../../lib/runtime/claude.js');
    const dir = useWorkspace({ agents: { piper: require('../helpers/workspace.js').agentFile({ name: 'piper', type: 'specialist', order: 1,
      routines: [{ name: 'digest', schedule: 'every day at 07:00', prompt: 'go', enabled: true }] }) } });
    const cached = require.cache[key]; delete require.cache[key];
    const realSpawn = claude.spawnClaude;
    const prevDeps = claude.wireClaudeRuntimeDeps({ getActualPort: () => 0 });
    const children = [];
    claude.spawnClaude = () => { const c = new (require('node:events').EventEmitter)(); c.kill = () => {}; children.push(c); return c; };
    try {
      const sched = require(key);
      sched.wireSchedulerDeps({ now: () => new Date(2026, 7, 20, 6, 30), getWssClients: () => [] });
      sched.recordRoutineRun('piper:digest', { lastRun: new Date(2026, 7, 19, 7, 0, 5).toISOString(), status: 'completed', duration: 3 });
      require('../../lib/agents/discovery.js').invalidateAgentCache();
      const agent = require('../../lib/agents/discovery.js').discoverAgents().find(a => a.id === 'piper');
      const read = () => [JSON.stringify(sched.routineState['piper:digest']), String(sched.nextRunFor('piper:digest', 'every day at 07:00'))];
      const before = read();
      assert.strictEqual(sched.runRoutineNow(agent, agent.routines[0], 'piper:digest').started, true);
      assert.deepStrictEqual(read(), before, 'while the pressed run is going');
      children[0].emit('close', 0);
      assert.deepStrictEqual(read(), before, 'and after it closed');
      assert.strictEqual(sched.readRunRecords()[0].trigger, 'manual', 'and the run that happened is on record as pressed');
    } finally {
      claude.spawnClaude = realSpawn; claude.wireClaudeRuntimeDeps(prevDeps);
      delete require.cache[key]; if (cached) require.cache[key] = cached;
    }
  });

  test('the two paused states on the page carry the model\'s own labels, and bind to different acts', () => {
    const words = model.PAUSED_WORDS;
    for (const label of [words.self, words.selfAction, words.consentAction]) {
      assert.ok(section.includes(`**${label}**`), `the page must carry the label "${label}"`);
    }
    const self = model.pausedState({ paused: true, refusal: 'paused' });
    const consent = model.pausedState({ refusal: 'approval' });
    assert.notStrictEqual(self.text, consent.text);
    assert.notStrictEqual(self.action, consent.action);
    assert.strictEqual(consent.action, 'approve_routine_plan');
    assert.match(section, /changed/, 'and the page says the consent pause names a change');
  });

  test('what lapses approval on the page is what lapses it in the hash', () => {
    const { PLAN_FIELDS, planApproved, computePlanHash } = require('../../lib/agents/routines.js');
    const base = { prompt: 'go', skill: 'ops', runOn: 'local', schedule: 'every day at 07:00', enabled: true };
    const approved = { ...base, planApprovedHash: computePlanHash(base) };
    for (const field of PLAN_FIELDS) assert.strictEqual(planApproved({ ...approved, [field]: 'other' }), false);
    assert.strictEqual(planApproved({ ...approved, schedule: 'every day at 09:00' }), true);
    assert.deepStrictEqual(PLAN_FIELDS.slice().sort(), ['prompt', 'runOn', 'skill']);
    assert.match(section, /prompt/, 'the page names the prompt');
    assert.match(section, /skill/, 'the skill');
    assert.match(section, /where it runs/, 'and the run target as what lapses it');
  });
});

// ---------------------------------------------------------------------------
// docs/ROUTINES.md: whose clock a schedule follows
//
// The page used to say there was no timezone field on a routine, which was
// false, and said the schedule followed "the machine running Rundock" without
// saying which machine that is when the window is on another one. Both halves
// are pinned to the behavior they describe: a declared zone changes nothing
// about when a routine is due, and the process's own zone changes everything.
// ---------------------------------------------------------------------------

describe('ROUTINES.md: a schedule follows the clock of the computer Rundock runs on', () => {
  const scheduler = require('../../lib/scheduler.js');
  const CLOCK = 'A schedule follows the clock of the computer Rundock runs on. For a Rundock on a server '
    + 'reached through a tunnel, that is the server\'s clock, whatever zone the computer showing the window is in.';
  const FIELD = 'A routine can carry a `timezone` field that names a zone as words, like `Europe/London`. '
    + 'Rundock checks that it is written that way, and doesn\'t read it when deciding when the routine runs. '
    + 'Firing in a routine\'s own zone is not supported.';
  const SERVER = 'Routine times follow the server\'s clock:';

  /** Run `fn` with the process in `zone` and the scheduler's clock held still. */
  function inZone(zone, now, fn) {
    const was = process.env.TZ;
    process.env.TZ = zone;
    const previous = scheduler.wireSchedulerDeps({ now: () => now });
    try { return fn(); } finally {
      scheduler.wireSchedulerDeps(previous);
      if (was === undefined) delete process.env.TZ; else process.env.TZ = was;
    }
  }

  test('the page no longer says a routine has no timezone field', () => {
    assert.doesNotMatch(routinesDoc, /There is no timezone field/i);
  });

  test('the page says whose clock it is, what the field is, and says it on the server section too', () => {
    assert.ok(routinesDoc.includes(`${CLOCK} ${FIELD}`), 'ROUTINES.md must say whose clock a schedule follows');
    const server = routinesDoc.slice(routinesDoc.indexOf('#### Reaching a Rundock on a server'));
    assert.ok(server.includes(SERVER), 'and the server section must say routine times follow the server\'s clock');
  });

  // "Doesn't read it when deciding when the routine runs", as behavior.
  //
  // HANDED THE ROUTINES THEMSELVES, never their schedule strings. Two routines
  // with one schedule hand the scheduler the same string, so a comparison of
  // what it makes of the strings cannot see a scheduler that starts reading
  // the routine's own zone. Here both routines are read out of an agent file
  // by discovery, one declaring Pacific/Auckland and one declaring nothing,
  // and the tick and the row are each given the routine objects, as they are
  // in the product. Each must decide the same for both: the slot, whether it
  // fires, and the next run after it.
  //
  // The process is in London, where 08:00 on 7 October 2026 is 07:00 UTC.
  // 08:00 in Auckland that day was 19:00 UTC the evening before, so a
  // scheduler that read the declared zone would find that routine already due
  // at half past six in London, and fire it an hour and a half early.
  test('a routine declaring Pacific/Auckland is judged due exactly as one declaring nothing', () => {
    const { agentFile } = require('../helpers/workspace.js');
    const discovery = require('../../lib/agents/discovery.js');
    const claude = require('../../lib/runtime/claude.js');
    const key = require.resolve('../../lib/scheduler.js');
    const SCHEDULE = 'every day at 08:00';
    const KEYS = ['piper:declared', 'piper:plain'];
    const SLOT = '2026-10-07T07:00:00.000Z';
    const TOMORROW = '2026-10-08T07:00:00.000Z';
    useWorkspace({ agents: { piper: agentFile({ name: 'piper', type: 'specialist', order: 1, routines: [
      { name: 'declared', schedule: SCHEDULE, prompt: 'go', enabled: true, timezone: 'Pacific/Auckland' },
      { name: 'plain', schedule: SCHEDULE, prompt: 'go', enabled: true },
    ] }) } });

    // A private scheduler whose children are stand-ins, loaded after the spawn
    // is swapped because it takes the spawn when it loads, and whose tick is
    // the interval it arms, run by hand.
    const was = process.env.TZ;
    process.env.TZ = 'Europe/London';
    const cached = require.cache[key]; delete require.cache[key];
    const realSpawn = claude.spawnClaude;
    const realSetInterval = global.setInterval;
    const prevDeps = claude.wireClaudeRuntimeDeps({ getActualPort: () => 0 });
    const children = [];
    claude.spawnClaude = () => { const c = new (require('node:events').EventEmitter)(); c.kill = () => {}; children.push(c); return c; };
    let sched = null;
    try {
      sched = require(key);
      const clock = { at: new Date(Date.UTC(2026, 9, 7, 5, 30)) }; // 06:30 in London
      sched.wireSchedulerDeps({ now: () => clock.at, getWssClients: () => [] });
      let tick = null;
      global.setInterval = (fn) => { tick = fn; return { unref() {} }; };
      try { sched.startScheduler(); } finally { global.setInterval = realSetInterval; }
      const tickAt = (at) => { clock.at = at; tick(); };

      discovery.invalidateAgentCache();
      const routines = discovery.discoverAgents().find(a => a.id === 'piper').routines;
      const byKey = Object.fromEntries(routines.map(r => [`piper:${r.name}`, r]));
      assert.strictEqual(byKey['piper:declared'].timezone, 'Pacific/Auckland', 'sanity: discovery kept the declared zone');
      assert.ok(!byKey['piper:plain'].timezone, 'sanity: and the other routine declares none');
      const each = (fn) => KEYS.map(k => fn(k, byKey[k]));
      const nextRuns = () => each((k, r) => sched.routineDisplayFacts(k, r.schedule, r).nextRun);
      const ran = () => each(k => (sched.routineState[k] ? sched.routineState[k].lastRun : null));

      assert.deepStrictEqual(nextRuns(), [SLOT, SLOT], 'the row names the same next run for both before the slot');
      tickAt(new Date(Date.UTC(2026, 9, 7, 5, 30)));
      assert.strictEqual(children.length, 0, 'neither fired at 06:30, before its slot');
      assert.deepStrictEqual(ran(), [null, null]);
      assert.deepStrictEqual(each(k => sched.routineSlots.routines[k].due), [SLOT, SLOT],
        'the tick placed both slots at the same instant');

      tickAt(new Date(SLOT));
      assert.strictEqual(children.length, 2, 'both fired at 08:00 in London');
      assert.deepStrictEqual(ran(), [SLOT, SLOT]);
      const dueAt = Object.fromEntries(sched.readRunRecords().map(rec => [`${rec.agent}:${rec.routine}`, rec.dueAt]));
      assert.deepStrictEqual(each(k => dueAt[k]), [SLOT, SLOT], 'and each run is on record as due at that slot');

      clock.at = new Date(Date.UTC(2026, 9, 7, 7, 5));
      for (const child of children) child.emit('close', 0);
      assert.deepStrictEqual(nextRuns(), [TOMORROW, TOMORROW], 'and the row names tomorrow\'s 08:00 for both');
      tickAt(new Date(Date.UTC(2026, 9, 7, 7, 30)));
      assert.strictEqual(children.length, 2, 'and neither fired again that morning');
    } finally {
      if (sched) sched.stopScheduler();
      global.setInterval = realSetInterval;
      claude.spawnClaude = realSpawn;
      claude.wireClaudeRuntimeDeps(prevDeps);
      delete require.cache[key]; if (cached) require.cache[key] = cached;
      discovery.invalidateAgentCache();
      if (was === undefined) delete process.env.TZ; else process.env.TZ = was;
    }
  });

  // "The clock of the computer Rundock runs on", as behavior: the same
  // schedule at the same instant is a different slot in a different zone.
  test('the same schedule gives different slot instants under two values of the process zone', () => {
    const now = new Date(Date.UTC(2026, 9, 7, 5, 0));
    const london = inZone('Europe/London', now, () => scheduler.getNextRun('every day at 08:00', null));
    const newYork = inZone('America/New_York', now, () => scheduler.getNextRun('every day at 08:00', null));
    assert.strictEqual(london.toISOString(), '2026-10-07T07:00:00.000Z');
    assert.strictEqual(newYork.toISOString(), '2026-10-07T12:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// docs/PACKAGES.md: what a receipt records
// ---------------------------------------------------------------------------

describe('PACKAGES.md: the receipt and its fingerprints', () => {
  // The page names where receipts live and says written and unchanged entries
  // carry a fingerprint of the bytes as written. Both halves are read from
  // the code that writes them: the directory from the writer's own constant,
  // and the fingerprint from a real apply, recomputed from disk.
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'PACKAGES.md'), 'utf8');
  const apply = require('../../lib/packages/import-apply.js');

  test('the receipts directory the page names is the one the writer uses', () => {
    assert.ok(doc.includes(`\`${apply.RECEIPTS_DIR}/<date>-<run>.json\``), 'the page names the writer\'s directory');
  });

  test('a written entry carries the fingerprint of what landed, and a skipped one carries none', () => {
    assert.match(doc, /\(`written` or `unchanged`\) also records `fingerprint`/);
    assert.match(doc, /A skipped or blocked entry has none/);
    const workspace = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'doc-fp-ws-'));
    const source = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'doc-fp-src-'));
    try {
      fs.mkdirSync(path.join(source, '.claude', 'skills', 'notes'), { recursive: true });
      fs.writeFileSync(path.join(source, '.claude', 'skills', 'notes', 'SKILL.md'), 'Take notes.\n');
      fs.mkdirSync(path.join(source, '.claude', 'skills', 'kept'), { recursive: true });
      fs.writeFileSync(path.join(source, '.claude', 'skills', 'kept', 'SKILL.md'), 'New.\n');
      fs.mkdirSync(path.join(workspace, '.claude', 'skills', 'kept'), { recursive: true });
      fs.writeFileSync(path.join(workspace, '.claude', 'skills', 'kept', 'SKILL.md'), 'Mine.\n');
      const { buildPlan, decide } = require('../../lib/packages/import-plan.js');
      const plan = buildPlan(workspace, source, { id: 'github.com/example/doc', reference: 'v1.0.0' });
      const result = apply.applyImport(workspace, source, decide(plan, { 'skill:notes': 'add', 'skill:kept': 'skip' }), { receipt: {} });
      const receipt = JSON.parse(fs.readFileSync(path.join(workspace, result.receipt), 'utf8'));
      const byId = Object.fromEntries(receipt.items.map((i) => [i.id, i]));
      assert.strictEqual(byId['skill:notes'].fingerprint, apply.digestDirectory(path.join(workspace, '.claude', 'skills', 'notes')));
      assert.ok(!('fingerprint' in byId['skill:kept']));
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(source, { recursive: true, force: true });
    }
  });
});

describe('PACKAGES.md: the starter file consent wording is the offer\'s own', () => {
  // The page quotes what the offer says about starter files. Both quotes are
  // produced here by the install model from a real plan, so a change to the
  // wording on screen without the page (or the reverse) fails.
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'PACKAGES.md'), 'utf8');
  const model = require('../../public/packages-install-model.js');
  const quoted = (line) => doc.includes(`> ${line}`);

  test('both quoted sentences are what the offer says', () => {
    const offerFor = (starters) => model.offerCopy({ agents: 1, skills: 0, routines: [], starters, plan: { items: [] } }).body;
    const arriving = offerFor([{ path: 'Investments/Portfolio.md', kept: false }, { path: 'Investments/Watchlist.md', kept: false }]);
    const kept = offerFor([{ path: 'Investments/Portfolio.md', kept: true }]);
    const first = arriving.slice(arriving.indexOf('Starter files:'));
    const second = kept.slice(kept.indexOf('Already in your workspace'));
    assert.ok(quoted(first), `the page quotes the offer: ${first}`);
    assert.ok(quoted(second), `the page quotes the kept line: ${second}`);
  });

  test('the folder the page names is the one discovery reads', () => {
    const { STARTER_DIR } = require('../../lib/packages/import-apply.js');
    assert.ok(doc.includes(`\`${STARTER_DIR}/<path>\``));
  });
});

// ---------------------------------------------------------------------------
// docs/AGENTS.md and docs/SKILLS.md: what Notes mode holds, and for whom
// ---------------------------------------------------------------------------

describe('AGENTS.md and SKILLS.md: Notes mode holds routines as well as conversations', () => {
  // The Notes row of the modes table in AGENTS.md says what the mode refuses
  // and that it holds for routines as well as conversations. SKILLS.md says a
  // skill inherits the mode of the agent that runs it, and a skill can be run
  // by a routine. Both are pinned to the one list a conversation spawn and a
  // routine spawn are handed (lib/workspace/mode.js), read through each
  // spawn's own reader, and the rename and delete sentence to what the
  // installed CLI was measured to do (test/fixtures/claude-cli-notes-mode.json).
  const { NOTES_BLOCKED_EXTENSIONS, NOTES_DISALLOWED_TOOLS } = require('../../lib/workspace/mode.js');
  const scheduler = require('../../lib/scheduler.js');
  const record = require('../fixtures/claude-cli-notes-mode.json');
  const agentsDoc = fs.readFileSync(path.join(ROOT, 'docs', 'AGENTS.md'), 'utf-8');
  const notesRow = agentsDoc.split('\n').find(l => l.startsWith('| **Notes**')) || '';
  const modeSection = (() => {
    const from = skillsDoc.indexOf('## Workspace mode');
    const to = skillsDoc.indexOf('\n## ', from + 1);
    return from < 0 ? '' : skillsDoc.slice(from, to < 0 ? undefined : to);
  })();

  // The list each spawn would be handed in a workspace in this mode: the
  // conversation's reader in the server, and the routine's, which the server
  // wires into the scheduler.
  function listsFor(mode) {
    const dir = useWorkspace();
    srv.writeState({ ...srv.readState(), workspaceMode: mode });
    const wired = scheduler.wireSchedulerDeps({});
    return { dir, conversation: srv.getDisallowedTools(), routine: wired.getDisallowedTools() };
  }

  test('the Notes row names only extensions the list blocks, and blocks notebook editing as it says', () => {
    assert.ok(notesRow, 'AGENTS.md has a Notes row in its modes table');
    const named = [...notesRow.matchAll(/`\.([a-z]+)`/g)].map(m => m[1]);
    assert.ok(named.length >= 5, 'the row names extensions');
    for (const ext of named) assert.ok(NOTES_BLOCKED_EXTENSIONS.includes(ext), `.${ext} is one the list blocks`);
    assert.match(notesRow, /turns off notebook editing/);
    assert.ok(NOTES_DISALLOWED_TOOLS.split(',').includes('NotebookEdit'));
  });

  test('"It holds for routines as well as conversations": both spawns read the same list in Notes mode, and none in Code mode', () => {
    assert.match(notesRow, /It holds for routines as well as conversations\./);
    const notes = listsFor('notes');
    assert.strictEqual(notes.conversation, NOTES_DISALLOWED_TOOLS, 'a conversation is handed the Notes list');
    assert.strictEqual(notes.routine, NOTES_DISALLOWED_TOOLS, 'and a routine the same one');
    const code = listsFor('code');
    assert.strictEqual(code.conversation, '');
    assert.strictEqual(code.routine, '', 'the Code row: no restriction, for either');
  });

  test('the rename and delete sentence is what Claude Code was measured to do, with the card approved', () => {
    assert.match(notesRow, /renaming or deleting one of those files with `mv` or `rm`, even when its card is approved; renaming or deleting a note is unaffected/);
    for (const c of record.cases.filter(k => k.hook === 'allow' && k.steps.some(s => s.tool === 'Bash'))) {
      const answer = cmd => c.observed.results[c.steps.findIndex(s => s.command === cmd)];
      assert.strictEqual(answer('rm tool.py').refused, true, `${c.name}: an executable file's delete is refused after the hook allowed it`);
      assert.strictEqual(answer('mv other.sh other.md').refused, true, `${c.name}: and its rename`);
      assert.strictEqual(answer('rm gone.md').refused, false, `${c.name}: a note's delete goes ahead`);
      assert.strictEqual(answer('mv old.md new.md').refused, false, `${c.name}: and its rename`);
    }
  });

  test('SKILLS.md makes no claim about routines in its own words; its claim covers them through the mode a skill inherits', () => {
    assert.match(modeSection, /Skills inherit the workspace mode of the agent that invokes them\. If the workspace is in Notes mode, write restrictions on executable file types apply to anything the skill instructs the agent to do\./);
    // Said outright, so nobody reads this pin as one on a sentence that is not
    // there: the section never mentions routines. A skill run by a routine is
    // run by the routine's agent, which is handed the Notes list (above).
    assert.doesNotMatch(modeSection, /routine/i, 'SKILLS.md\'s workspace mode section has no routine claim of its own');
    assert.strictEqual(listsFor('notes').routine, NOTES_DISALLOWED_TOOLS);
  });
});

// ---------------------------------------------------------------------------
// ARCHITECTURE.md: a write to a stopped process never ends the server
// ---------------------------------------------------------------------------

describe('ARCHITECTURE.md: a write to a stopped process is logged, left to its close, and never ends the server', () => {
  // The claim a contributor relies on when adding a write to an agent's
  // stdin: that it needs no handler of its own. Pinned by doing it, to a real
  // child that stops before reading, through the handler the page names, and
  // by asking each start path the page names whether the stdin it hands back
  // has that handler. The code is required inside each test, so a missing
  // module fails that test rather than the whole block before it registers.
  const { spawn } = require('node:child_process');
  const runtime = architecture.slice(architecture.indexOf('### Runtime subprocesses'),
    architecture.indexOf('### Conversations: resume vs spawn fresh'));

  test('the page says it, where it describes how agent processes run, and names the handler and both start paths', () => {
    assert.ok(runtime.length > 0, 'the runtime subprocesses section is there');
    assert.match(runtime, /A write to a stopped process is logged and handled by that process's close, and never ends the server\./);
    assert.match(runtime, /`lib\/runtime\/child-stdin\.js`, called from `spawnClaude` in `lib\/runtime\/claude\.js` and from the Codex app-server's spawn in `codex-appserver\.js`/);
    assert.match(runtime, /logs one line per failed write, naming the process and the error/);
  });

  test('and it is so: a write to a child that stops before reading logs one line, throws nothing, and the close still runs', { timeout: 20000 }, async () => {
    const { guardChildStdin } = require('../../lib/runtime/child-stdin.js');
    const uncaught = [];
    const monitor = (err) => uncaught.push(err);
    process.on('uncaughtExceptionMonitor', monitor);
    const lines = [];
    try {
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 200);'], { stdio: ['pipe', 'pipe', 'pipe'] });
      guardChildStdin(child, 'a child that never reads', { log: (l) => lines.push(l) });
      // Bounded, and the child let go however it ends: a broken handler throws
      // out of the stream's teardown, its pipe stays open and 'close' never
      // comes, which must fail this test rather than hold the file open.
      const closed = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("the child's close did not come within eight seconds")), 8000);
        child.once('close', (code) => { clearTimeout(timer); resolve(code); });
      });
      try {
        child.stdin.write('x'.repeat(1024 * 1024) + '\n');
        assert.strictEqual(await closed, 0, "the child's own close runs, as it does for any process that stops");
        await new Promise((r) => setTimeout(r, 50));
      } finally {
        try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
        for (const s of [child.stdin, child.stdout, child.stderr]) { try { s.unref(); } catch (e) { /* nothing to let go */ } }
        child.unref();
      }
    } finally {
      process.removeListener('uncaughtExceptionMonitor', monitor);
    }
    assert.deepStrictEqual(uncaught, [], 'nothing reaches the server as an uncaught exception');
    assert.strictEqual(lines.length, 1, 'one line, for the one failed write');
    assert.match(lines[0], /a child that never reads pid=\d+: a write failed \((EPIPE|ECONNRESET): /, 'naming the process and the error');
  });

  test('both start paths hand back a stdin that already has its handler', { timeout: 30000 }, async () => {
    const claude = require('../../lib/runtime/claude.js');
    const { createCodexAppServer } = require('../../codex-appserver.js');
    const prev = claude.wireClaudeRuntimeDeps({ onClaudeSpawn: () => {} });
    let proc;
    try {
      proc = claude.spawnClaude(['--version'], { cwd: ROOT, env: process.env, stdio: ['pipe', 'ignore', 'ignore'] });
    } finally { claude.wireClaudeRuntimeDeps(prev); }
    try {
      assert.strictEqual(proc.stdin.listenerCount('error'), 1, 'spawnClaude: an agent process\'s stdin has its error handler before anyone writes to it');
    } finally {
      const gone = new Promise((resolve) => proc.once('close', resolve));
      try { proc.kill('SIGKILL'); } catch (e) { /* already gone */ }
      await gone;
    }

    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'doc-claims-codex-'));
    fs.writeFileSync(path.join(dir, 'stub-codex-scenario.json'), JSON.stringify({ appServer: {} }));
    const server = createCodexAppServer({ binPath: path.join(ROOT, 'test', 'helpers', 'stub-codex', 'codex'), cwd: dir, shutdownGraceMs: 1000 });
    try {
      await server.start();
      assert.strictEqual(server._proc.stdin.listenerCount('error'), 1, "the Codex app-server's stdin has its error handler too");
    } finally {
      await server.shutdown();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('and each logs a failed write in one line, naming the process and the error, with no log of its own', { timeout: 30000 }, async () => {
    // Neither start path is given a log here, which is how each runs when
    // nothing asks for its lines: the line still comes, on stderr.
    const claude = require('../../lib/runtime/claude.js');
    const { createCodexAppServer } = require('../../codex-appserver.js');
    const epipe = () => Object.assign(new Error('write EPIPE'), { code: 'EPIPE', errno: -32, syscall: 'write' });
    const lines = [];
    const realError = console.error;
    console.error = (...args) => {
      const line = args.map(String).join(' ');
      if (line.startsWith('[Stdin]')) lines.push(line); else realError(...args);
    };
    try {
      const prev = claude.wireClaudeRuntimeDeps({ onClaudeSpawn: () => {} });
      let proc;
      try {
        proc = claude.spawnClaude(['--version', '--agent', 'some-agent'], { cwd: ROOT, env: { ...process.env, RUNDOCK_CONVO_ID: 'convo-1' }, stdio: ['pipe', 'ignore', 'ignore'] });
      } finally { claude.wireClaudeRuntimeDeps(prev); }
      try {
        proc.stdin.emit('error', epipe());
        assert.deepStrictEqual(lines.length, 1, `spawnClaude: one line: ${JSON.stringify(lines)}`);
        assert.match(lines[0], new RegExp(`^\\[Stdin\\] claude \\(agent some-agent, conversation convo-1\\) pid=${proc.pid}: a write failed \\(EPIPE: write EPIPE\\)`));
      } finally {
        const gone = new Promise((resolve) => proc.once('close', resolve));
        try { proc.kill('SIGKILL'); } catch (e) { /* already gone */ }
        await gone;
      }

      const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'doc-claims-codex-'));
      fs.writeFileSync(path.join(dir, 'stub-codex-scenario.json'), JSON.stringify({ appServer: {} }));
      const server = createCodexAppServer({ binPath: path.join(ROOT, 'test', 'helpers', 'stub-codex', 'codex'), cwd: dir, shutdownGraceMs: 1000 });
      try {
        await server.start();
        server._proc.stdin.emit('error', epipe());
        assert.deepStrictEqual(lines.length, 2, `the Codex app-server: one line: ${JSON.stringify(lines)}`);
        assert.match(lines[1], new RegExp(`^\\[Stdin\\] codex app-server pid=${server._proc.pid}: a write failed \\(EPIPE: write EPIPE\\)`));
      } finally {
        await server.shutdown();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      console.error = realError;
    }
  });
});

// docs/ROUTINES.md: what a pause you applied looks like on its row
describe('ROUTINES.md: a pause you applied dims the avatar, not the row', () => {
  test('the doc says the avatar dims and the text stays at full strength, which is what the stylesheet does', () => {
    const paragraph = routinesDoc.split('\n').find(l => l.includes('A pause you applied is quieter'));
    assert.ok(paragraph, 'ROUTINES.md describes a pause you applied');
    assert.ok(paragraph.includes('A pause you applied is quieter: its avatar dims while its text stays at full strength'),
      'ROUTINES.md must say what a pause you applied dims');
    assert.ok(!paragraph.includes('the row dims'), 'the old sentence, which is no longer true, is gone');
    const css = fs.readFileSync(path.join(ROOT, 'public', 'styles', 'views', 'routines.css'), 'utf-8');
    assert.ok(css.includes('.routine-row.paused .avatar { opacity: 0.5; }'), 'the sentence is true of the stylesheet');
    assert.ok(!css.includes('.routine-row.paused { opacity'), 'and nothing dims the row as a whole');
  });
});

// ---------------------------------------------------------------------------
// scaffold/rundock-guide.md: what happens to a long conversation
// ---------------------------------------------------------------------------

describe('rundock-guide.md: a long conversation is summarized automatically and stays on screen', () => {
  // What Doc answers when someone asks what happens once a conversation grows
  // past what the agent can hold. The runtime's half, that Claude Code and
  // Codex summarize a long session on their own and the agent then works
  // from the summary, is theirs: it is stated here, not run. Rundock's half
  // is pinned by doing it: a session holding a summary is read back through
  // the history the chat is drawn from, and everything said before the
  // summary is still there, without the summary itself.
  const guide = fs.readFileSync(path.join(ROOT, 'scaffold', 'rundock-guide.md'), 'utf-8');
  const section = (() => {
    const from = guide.indexOf('### Conversations');
    const to = guide.indexOf('\n#', from + 1);
    return from < 0 ? '' : guide.slice(from, to < 0 ? undefined : to);
  })();

  test('the guide says it where it explains conversations, and names no limit or number', () => {
    assert.ok(section.length > 0, 'the guide has a Conversations section among what Doc knows');
    assert.ok(guide.indexOf('### Conversations') > guide.indexOf('## What you know'), 'and it is among what Doc knows');
    assert.match(section, /A long conversation is summarized automatically so the agent can carry on: Claude Code and Codex each do this on their own when a conversation grows past what the agent can hold at once\./);
    assert.match(section, /The whole conversation stays on screen in Rundock, but from then on the agent works from the summary rather than every earlier message, so details from early on can be lost\./);
    assert.match(section, /A new topic is best started in a new conversation\./);
    assert.doesNotMatch(section, /\d/, 'the section names no limit or number');
  });

  test('and the whole conversation stays on screen: the history keeps every message before a summary, and not the summary', async () => {
    const home = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'doc-claims-home-'));
    const was = process.env.HOME;
    try {
      process.env.HOME = home;
      const dir = useWorkspace();
      const sessions = path.join(home, '.claude', 'projects', dir.replace(/\//g, '-'));
      fs.mkdirSync(sessions, { recursive: true });
      const at = (n) => `2026-01-14T09:${String(n).padStart(2, '0')}:00.000Z`;
      const said = (role, text, n) => (role === 'user'
        ? { type: 'user', message: { role: 'user', content: text }, timestamp: at(n) }
        : { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, timestamp: at(n) });
      // Claude Code's own lines when it summarizes a session: a boundary, and
      // the summary written as the person's message.
      const lines = [
        said('user', 'Plan the launch.', 0),
        said('assistant', 'Here is the plan.', 1),
        { type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', timestamp: at(2) },
        { type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true, timestamp: at(3),
          message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context. The conversation is summarized below: planning the launch.' } },
        said('user', 'Add a timeline.', 4),
        said('assistant', 'Timeline added.', 5),
      ];
      fs.writeFileSync(path.join(sessions, 'doc-claims-summarized.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      const history = await srv.parseSessionHistory('doc-claims-summarized', 50);
      assert.deepStrictEqual(history.messages.map((m) => m.content),
        ['Plan the launch.', 'Here is the plan.', 'Add a timeline.', 'Timeline added.']);
    } finally {
      if (was === undefined) delete process.env.HOME; else process.env.HOME = was;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('ARCHITECTURE.md: a PowerShell command runs with no card only when every part of it is a read Rundock can name', () => {
  // The claim a reader on Windows relies on, where no sandbox sits under the
  // card. Pinned by asking the reading the page names about the very cmdlets
  // and constructs the page lists, so the page cannot keep saying it after the
  // code stops doing it.
  const shell = require('../../public/read-only-shell.js');
  const P = require('../../public/permissions.js');
  const LEAD = '**A PowerShell command runs with no card only when every part of it is a read Rundock can name.**';
  const at = architecture.indexOf(LEAD);
  const passage = at >= 0 ? architecture.slice(at, architecture.indexOf('\n', at)) : '';
  const sharedSrc = fs.readFileSync(path.join(ROOT, 'public', 'read-only-shell.js'), 'utf-8');
  const graderSrc = fs.readFileSync(path.join(ROOT, 'public', 'permissions.js'), 'utf-8');

  test('the audit section says what a PowerShell read is, why the list is named, and that anything not read all the way cards', () => {
    assert.ok(passage.length > LEAD.length, 'the paragraph is in the audit section');
    assert.ok(passage.includes('`isReadOnlyPowerShellCommand` in `public/read-only-shell.js`'), 'it names the one reading');
    assert.ok(passage.includes('every part of it, split at `;`, `|`, `&&`, `||` and each new line, starts with one of these, in any case:'),
      'it says what a read is');
    assert.ok(passage.includes('named one cmdlet at a time and not matched by verb'), 'it says why the list is named');
    assert.ok(passage.includes('Anything the reading cannot follow all the way is not a read, and cards'), 'it says what cards');
  });

  test('the comments beside the list say the same three things', () => {
    for (const said of ['A POWERSHELL READ IS A COMMAND WHOSE EVERY PART STARTS WITH A NAME ON THIS', 'NAMED, NOT MATCHED BY VERB.',
      'ANYTHING NOT READ ALL THE WAY CARDS.']) {
      assert.ok(sharedSrc.includes(said), `the shared definition says: ${said}`);
    }
    assert.ok(!graderSrc.includes('SCOPED TO BASH'), 'and the grader no longer says its PowerShell answer is its own');
    assert.ok(graderSrc.includes('ONE ANSWER FOR EACH SHELL, AND NO LIST HERE.'), 'it says there is one answer for each shell');
  });

  test('the cmdlets the page names are the list the code reads, and each is a read', () => {
    const named = /starts with one of these, in any case: ([^.]+)\./.exec(passage);
    assert.ok(named, 'the page names the list');
    const onPage = [...named[1].matchAll(/`([A-Za-z-]+)`/g)].map(m => m[1].toLowerCase()).sort();
    const declared = /var READ_ONLY_POWERSHELL_COMMANDS = \[([^\]]+)\]/.exec(sharedSrc);
    assert.ok(declared, 'the shared definition declares the list');
    const inCode = [...declared[1].matchAll(/'([a-z-]+)'/g)].map(m => m[1]).sort();
    assert.ok(inCode.length >= 20, `the list was read whole: ${inCode.length} names`);
    assert.deepStrictEqual(onPage, inCode, 'the page names exactly the list');
    for (const name of onPage) {
      assert.strictEqual(shell.isReadOnlyPowerShellCommand(name), true, `${name} is a read`);
      assert.strictEqual(P.classifyRisk('PowerShell', { command: name }), 'low', `${name} runs with no card`);
    }
  });

  test('what the page says cards does card', () => {
    for (const command of ['Get-Clipboard', 'Get-Credential', 'Get-Content (Remove-Item notes.md)', 'Write-Output "$(Set-Content notes.md x)"',
      'Write-Output @(Set-Content notes.md x)', 'Get-ChildItem | Where-Object { Remove-Item notes.md }', 'Get-Date; & Set-Content notes.md x',
      'Get-Date; . .\\setup.ps1', "Write-Output `'x", 'Get-Date --% x', 'Get-Date # x', 'Get-Content notes.md > copy.md',
      'Gеt-Date', '$cmd notes.md', "Get-Content 'notes.md", 'Get-Date; powershell -c x', 'Get-Date; cmd /c x']) {
      assert.strictEqual(shell.isReadOnlyPowerShellCommand(command), false, command);
      assert.notStrictEqual(P.classifyRisk('PowerShell', { command }), 'low', command);
    }
  });
});

describe('ARCHITECTURE.md: sort and date run with no card only in the forms that read', () => {
  // The claim an unattended routine relies on, and the one a person relies on
  // that a writing form still asks. Pinned by asking the shared definition and
  // the grader about every form the page names, and by reading the comment the
  // module keeps beside its list, so neither can keep saying it after the code
  // stops doing it.
  const shell = require('../../public/read-only-shell.js');
  const P = require('../../public/permissions.js');
  const LEAD = '**`sort` and `date` run with no card only in the forms that read.**';
  const at = architecture.indexOf(LEAD);
  const passage = at >= 0 ? architecture.slice(at, architecture.indexOf('\n', at)) : '';
  // The module's comments as running text, so a sentence is found wherever
  // its lines wrap.
  const sharedSrc = fs.readFileSync(path.join(ROOT, 'public', 'read-only-shell.js'), 'utf-8').replace(/\n\s*\/\/ ?/g, ' ');
  const reads = (command) => shell.isReadOnlyShellCommand(command) && P.classifyRisk('Bash', { command }) === 'low';

  test('the audit section says what makes either one a read, and that any other option asks', () => {
    assert.ok(passage.length > LEAD.length, 'the paragraph is in the audit section');
    for (const said of [
      '`isReadOnlyShellCommand` in `public/read-only-shell.js` reads each of them option by option, as it reads `find`',
      'a `sort` or `date` is a read only when every option on the line is on its list of reading options, and any other option asks',
      'The options are read as getopt reads them, a short bundle letter by letter (`-rno out` is `-r -n -o out`)',
      'checked against both the macOS and the GNU manuals',
      'a reading `sort` or `date` of a file under the runtime\'s own home is freed exactly as `cat` and `stat` of it are',
    ]) assert.ok(passage.includes(said), `the page says: ${said}`);
  });

  test('the comment beside the list says which forms read and why the rest ask, and no longer that both are left out', () => {
    for (const said of ['SORT AND DATE READ ONLY IN THE FORMS THAT READ.', 'any other option asks',
      '`sort -o FILE` writes FILE with no redirection on the line', 'set the system clock']) {
      assert.ok(sharedSrc.includes(said), `the shared definition says: ${said}`);
    }
    assert.ok(!sharedSrc.includes('those are NOT carried across'), 'it no longer says the grader\'s other words were not carried across');
    assert.ok(!sharedSrc.includes('Two of them are why: `sort -o FILE`'), 'nor that sort is one of the reasons');
    assert.ok(sharedSrc.includes('CHECKED AGAINST TWO MANUALS'), 'and it says which manuals the lists were checked against');
    // The words the comment says are left out are only the words really left
    // out: neither `sort` nor `date` is among them.
    const leftOut = (/The card grader also recognized ([^.]*?), and none of them is on this list\./.exec(sharedSrc) || [])[1] || '';
    assert.ok(leftOut.includes('`uniq`'), `the comment names what is left out: ${leftOut}`);
    assert.ok(!/`sort`|`date`/.test(leftOut), `and names neither sort nor date among them: ${leftOut}`);
  });

  test('every form the page says reads, reads, and every one it says asks, asks', () => {
    // Each entry: the words the page names, and a command spelling each one.
    const READS = [['`sort`', 'ls notes | sort'], ['ordering', 'sort -rn x'], ['key', 'sort -k2,2n x'], ['field separator', 'sort -t, x'],
      ['buffer size', 'sort -S 1M x'], ['check', 'sort -c x'], ['merge', 'sort -m a b'], ['unique', 'sort -u x'],
      ['`date` reads alone', 'date'], ['a `+` format', 'date +%Y-%m-%d'], ['`-u`', 'date -u'], ['`-R`', 'date -R'], ['`-I`', 'date -I'],
      ['`-r`', 'date -r notes.md'], ['`-z`', 'date -z UTC'], ['`-v`', 'date -v+1d'], ['`-d`', 'date -d yesterday'], ['`-j`', 'date -j 0101'],
      ['GNU long forms', 'date --utc --date=yesterday']];
    const ASKS = [['`sort -o`', 'sort -o x y'], ['`--output`', 'sort --output=x y'], ['`-T`', 'sort -T /tmp x'],
      ['`--temporary-directory`', 'sort --temporary-directory=/tmp x'], ['`--compress-program`', 'sort --compress-program=sh x'],
      ['`date -s`', 'date -s 2026-01-01'], ['`--set`', 'date --set=2026-01-01'], ['a time operand', 'date 010112002026'],
      ['`-f` without `-j`', 'date -f %Y%m%d 20260101'], ['any other option asks', 'sort --bogus x'],
      ['`\'-o\'` is `-o`', "sort '-o' x y"], ['a `$`', 'sort $X x'], ['a glob', 'sort *'], ['a brace', 'sort {-o,x} y'], ['a redirection', 'sort < x']];
    for (const [named, command] of READS) {
      assert.ok(passage.includes(named), `the page names ${named}`);
      assert.strictEqual(reads(command), true, `${command} runs with no card`);
    }
    for (const [named, command] of ASKS) {
      assert.ok(passage.includes(named), `the page names ${named}`);
      assert.strictEqual(shell.isReadOnlyShellCommand(command), false, `${command} is not a read`);
      assert.notStrictEqual(P.classifyRisk('Bash', { command }), 'low', `${command} asks`);
    }
  });

  test('the tests the page names exist', () => {
    for (const file of ['test/unit/permissions.test.js', 'test/unit/sort-date-reads-hook.test.js', 'test/unit/sort-date-read-cards.test.js']) {
      assert.ok(passage.includes(`\`${file}\``), `the page names ${file}`);
      assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} exists`);
    }
  });
});

describe('ARCHITECTURE.md: an option is judged as the shell hands it to the program', () => {
  // The claim a person relies on that a quoted or escaped writing option still
  // asks. Pinned by asking the shared definition and the grader about every
  // spelling the page names, and by reading the comments the module keeps
  // beside its reader, find's lists and the named flags, so neither can keep
  // saying it after the code stops doing it.
  const shell = require('../../public/read-only-shell.js');
  const P = require('../../public/permissions.js');
  const LEAD = '**An option is judged as the shell hands it to the program, so quoting or escaping an option that writes or runs never makes it a read.**';
  const at = architecture.indexOf(LEAD);
  const passage = at >= 0 ? architecture.slice(at, architecture.indexOf('\n', at)) : '';
  const sharedSrc = fs.readFileSync(path.join(ROOT, 'public', 'read-only-shell.js'), 'utf-8').replace(/\n\s*\/\/ ?/g, ' ');
  const reads = (command) => shell.isReadOnlyShellCommand(command) && P.classifyRisk('Bash', { command }) === 'low';
  const asks = (command) => !shell.isReadOnlyShellCommand(command) && P.classifyRisk('Bash', { command }) !== 'low';

  test('the audit section says options are judged as the shell reads them, and that a reading that cannot be known asks', () => {
    assert.ok(passage.length > LEAD.length, 'the paragraph is in the audit section');
    for (const said of [
      'judges the options of `find`, `rg`, `tree`, `file`, `sort` and `date` on the words the shell hands the program',
      'after it has taken quotes and backslashes away',
      'is not a read, so it asks',
      'Commands split where the shell splits them',
      'Only a space, a tab and a newline separate words, as in bash',
      'a quoted writing option keeps its crossing as a write in Notes mode and in Code mode',
      'A wildcard after a plain first character other than `-` still reads for `find`, `rg`, `tree` and `file`',
      '**Nothing the earlier reading asked about reads now.**',
      'a line reads only when both readings read it',
      'are the only two exceptions to the rule that a character outside the plain set makes the segment not a read',
      'No quote character that opens nothing in bash hides a command either',
      'every reading reads the line that way as well as as written',
      'is not a read, and neither is one with a `(` or `)` outside its quotes',
      'In Code mode the verdict reads the line both ways as well',
      'checked against the graders at that base wherever history holds it',
      'the hook reads the paths in a bash command as it always did and in the line\'s view as well',
      'so none of them hides a path from its crossing check and no path it saw before is lost',
    ]) assert.ok(passage.includes(said), `the page says: ${said}`);
  });

  test('the module says it beside its reader, find\'s lists and the named flags', () => {
    for (const said of [
      'Every command whose options are judged is judged on these words',
      'segment is not a read, and it asks',
      'EACH FLAG IS JUDGED AS THE SHELL HANDS IT TO find, never as it is written',
      'A line whose words the text alone does not show is not a read, so it asks.',
      'WHETHER A WORD IS ONE OF THESE OPTIONS, judged as the shell hands the word over',
      'A BACKSLASH OUTSIDE SINGLE QUOTES TAKES THE NEXT CHARACTER WITH IT',
      'READ BOTH WAYS. find, rg, tree and file were judged on their words as written',
      'a segment reads only when both readings say it reads',
      'SPLIT AS WRITTEN TOO, with each quote taken as written and a backslash as text',
      'A line reads only when every piece of both splits reads',
      'A WILDCARD THAT CANNOT START WITH A DASH.',
      'makes the only two exceptions to the plain set',
      'EVERY READING HERE FINDS A QUOTE BY PAIRING QUOTE CHARACTERS',
      'shellView gives the line back with each of those characters made a space',
      'A FAILURE INSIDE THIS READING IS AN ANSWER',
    ]) assert.ok(sharedSrc.includes(said), `the shared definition says: ${said}`);
    const hookSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'permission-hook.js'), 'utf-8').replace(/\n\s*\/\/ ?/g, ' ');
    assert.ok(hookSrc.includes('which the crossing check reads as well (shellCrossings), so none of them hides a path'), 'the hook says where an escaped quote is read');
  });

  test('every spelling the page names asks, and the reads beside them read', () => {
    const ASKS = [["`'-fprintf'`", "find . -maxdepth 0 '-fprintf' out x"], ['`"--pre"`', 'rg "--pre" sh x .'], ['`\\-o`', 'tree \\-o out'],
      ["`-fpr'int'f`", "find . -fpr'int'f out x"], ['`file --comp` is `--compile`', 'file --comp -m x'], ['a `$`', 'rg $X x .'],
      ['a backtick', 'tree `echo -o` out'], ["`$'…'`", "tree $'-o' out"], ['a wildcard at the start of a word', 'file *'], ['a brace', 'tree {-o,out}'],
      ['a quote left open', "rg 'x ."], ['a backslash with nothing after it', 'tree -L 2 \\'], ['a control character', 'file x\u0001'],
      ['more than 8,192 characters', 'rg' + ' x'.repeat(4200)], ['`\\"` and `\\\'` open no quote', 'ls \\"\ncp a b\necho \\"'],
      ['a form feed', 'tree -L\f2'], ['a vertical tab', 'rg -n\vx .'], ['a no-break space', 'file -b\u00a0x'],
      ['a carriage return on its line', 'rg -e \rcat --pre sh x .'], ['`rg "x --pre" .`', 'rg "x --pre" .'],
      ["`find . -na'me' x`", "find . -na'me' x"], ['`grep "a\\"; rm x" f`', 'grep "a\\"; rm x" f'],
      ['a quote in a comment', "ls # it's\ncp a b\nls # '"], ["one escaped inside `$'…'`", "ls $'\\''; cp a b"],
      ["one in a here-document's body", "cat <<EOF\n'\nEOF\ncp a b\necho \"'\""], ['the quotes inside a substitution held in double quotes', 'echo "$(echo "\'")"\ncp a b\necho "$(echo "\'")"'],
      ["zsh's glob qualifiers", "ls *(e:'cp a b':)"], ['its `=( )`', 'cat =(cp a b)'], ['a `case` pattern', 'case x in x) cp a b;; esac'],
      ['`find . ! -name x`', 'find . !x -name y']];
    for (const [named, command] of ASKS) {
      assert.ok(passage.includes(named), `the page names ${named}`);
      assert.ok(asks(command), `${JSON.stringify(command.slice(0, 60))} asks`);
    }
    for (const command of ["find . -name '*.md'", "rg 'two words' notes", 'tree -L 2', 'file notes.md', 'echo "a\nb"', "rg 'TODO' notes/*.md",
      'find . ! -name x', "ls # it's here", "grep -rn \"it's\" notes", "echo $'a\\tb'"]) {
      assert.ok(reads(command), `${command} still reads`);
    }
  });

  // A ( INSIDE A WORD IS HIGH IN NOTES MODE, SO NO SAVED ANSWER COVERS IT.
  // Pinned by asking the grader and the decision path about lines the page
  // names, with a saved answer for their leading command, and by reading the
  // comment the grader keeps beside the rule.
  test('the page and the grader say a ( inside a word is high in Notes mode, so no saved answer covers it, and it is', () => {
    for (const said of [
      'In Notes mode a line with a `(` inside a word, outside its quotes, is graded high risk by `classifyBashRisk` in `public/permissions.js`',
      'however the word starts and wherever it sits',
      'and so is a line whose view fails or nests deeper than the view follows',
      'Such a line is carded every time and never offers "Always allow", so no saved answer covers it',
    ]) assert.ok(passage.includes(said), `the page says: ${said}`);
    const graderSrc = fs.readFileSync(path.join(ROOT, 'public', 'permissions.js'), 'utf-8').replace(/\n\s*\/\/ ?/g, ' ');
    assert.ok(graderSrc.includes('A `(` INSIDE A WORD, OUTSIDE QUOTES, IS HIGH, SO NO SAVED ANSWER COVERS IT.'), 'the grader says it beside the rule');
    assert.ok(graderSrc.includes('a view that fails or cannot be read counts as marked'), 'and that a view that fails counts');
    for (const [named, command] of [["`ls 'a'*(e:'cmd':)`", "ls 'a'*(e:'cp a b':)"], ['`cat =(cmd)`', 'cat =(cp a b)'], ["`echo $(ls *(e:'cmd':))`", "echo $(ls *(e:'cp a b':))"]]) {
      assert.ok(passage.includes(named), `the page names ${named}`);
      const risk = P.classifyRisk('Bash', { command });
      const key = P.toolAllowKey('Bash', { command });
      assert.strictEqual(risk, 'high', command);
      assert.deepStrictEqual(P.decidePermission(risk, key, new Set([key])), { action: 'card' }, `a saved ${key} covers ${command}`);
      assert.strictEqual(P.offersAlwaysAllow(risk), false, command);
      const { summary, context } = P.describeToolRequest('Bash', { command });
      assert.doesNotMatch(`${summary} ${context}`, /delet|destructi/i, `the card never calls ${command} a delete or destructive`);
    }
  });

  // THE CARD SAYS WHY. Pinned by reading the sentences off the page and
  // asking describeToolRequest for the context of lines that carry each one,
  // so the page and the card cannot drift apart.
  test('the page quotes the sentence the card gives for each reason, and the card gives it', () => {
    const quoted = (lead) => {
      const at = passage.indexOf(lead);
      assert.ok(at >= 0, `the page says: ${lead}`);
      const m = passage.slice(at + lead.length).match(/^"([^"]+)"/);
      assert.ok(m, `the page quotes a sentence after: ${lead}`);
      return m[1];
    };
    const pattern = quoted('The card says why it asks, in the context sentence `describeToolRequest` gives: ');
    const unread = quoted('or, for a line whose view failed or stopped short, ');
    assert.ok(passage.includes('A line graded high as destructive first keeps the sentence its leading command gives.'), 'the page names the exception');
    const contextOf = (command) => P.describeToolRequest('Bash', { command }).context;
    for (const command of ["ls 'a'*(e:'cp a b':)", 'cat =(cp a b)', 'f() { echo hi; }; f']) assert.strictEqual(contextOf(command), pattern, command);
    assert.strictEqual(contextOf(`echo ${'$('.repeat(40)}x${')'.repeat(40)}`), unread, 'a line nested past what the view follows');
    assert.strictEqual(contextOf("rm *(e:'cp a b':)"), 'This will permanently delete files', 'a destructive line keeps its own');
    for (const sentence of [pattern, unread]) assert.doesNotMatch(sentence, /delet|destructi/i, sentence);
  });

  test('the page says a function definition is graded high with them, and it is', () => {
    assert.ok(passage.includes('A function definition (`f() { echo hi; }; f`) puts a `(` inside a word too, and is graded high with them; Code mode already asks about it.'),
      'the page says it');
    assert.strictEqual(P.classifyRisk('Bash', { command: 'f() { echo hi; }; f' }), 'high');
  });

  test('the tests the page names exist', () => {
    for (const file of ['test/unit/permissions.test.js', 'test/unit/quoted-options-hook.test.js', 'test/unit/hook-never-crashes.test.js',
      'test/unit/read-only-on-main.test.js', 'test/tools/record-read-only-on-main.js', 'test/unit/shell-view.test.js', 'test/unit/shell-view-hook.test.js',
      'test/unit/zsh-pattern-cards.test.js', 'test/integration/zsh-pattern-saved-answer.test.js', 'test/unit/shell-view-shells.test.js',
      'test/tools/zsh-pattern-grade-moves.js']) {
      assert.ok(passage.includes(`\`${file}\``), `the page names ${file}`);
      assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} exists`);
    }
  });
});

describe('ARCHITECTURE.md and the hook header: a request the hook cannot name, or whose input it cannot read, is refused inside Rundock', () => {
  // The claim a reader of either relies on when the runtime's request changes
  // shape. Pinned by running the hook on such requests, so neither can keep
  // saying it after the hook stops doing it.
  const { spawnSync } = require('node:child_process');
  const HOOK = path.join(ROOT, 'scripts', 'permission-hook.js');
  const LEAD = '**A permission hook that cannot answer, or cannot read what it was asked, refuses the call.**';
  const at = architecture.indexOf(LEAD);
  const passage = at >= 0 ? architecture.slice(at, architecture.indexOf('\n', at)) : '';
  const hookSrc = fs.readFileSync(HOOK, 'utf-8');
  const header = hookSrc.slice(0, hookSrc.indexOf('*/')).split('\n').map(line => line.replace(/^\s*\*\s?/, '')).join(' ').replace(/\s+/g, ' ');
  const COULD_NOT_CHECK = 'Rundock could not check this request, so it was refused rather than approved on your behalf.';
  const hook = (raw, env) => {
    const r = spawnSync(process.execPath, [HOOK], {
      input: raw,
      encoding: 'utf8',
      env: { ...process.env, NODE_V8_COVERAGE: '', RUNDOCK: '1', RUNDOCK_PORT: '1', RUNDOCK_WORKSPACE: ROOT, RUNDOCK_CONVO_ID: 'c1', RUNDOCK_CODE_MODE: '', ...env },
    });
    let answer = null;
    try { answer = JSON.parse(r.stdout); } catch (e) { /* asserted below */ }
    return answer;
  };
  const request = (fields) => JSON.stringify({ hook_event_name: 'PreToolUse', cwd: ROOT, session_id: 's', ...fields });

  test('the audit section and the hook header both say it', () => {
    assert.ok(passage.length > LEAD.length, 'the paragraph is in the audit section');
    assert.ok(passage.includes('A request the hook cannot name, or whose input it cannot read, is refused inside Rundock the same way, before anything is asked of the server'),
      'the audit section says it');
    assert.ok(passage.includes('a file, shell or connector tool whose `tool_input` is missing or is not an object'), 'and which input it means');
    assert.ok(header.includes('A request the hook cannot name (no tool name, or one that is not a string, is empty or is only spaces), or whose input it cannot read (a file, shell or connector tool whose input is missing or is not an object), is refused inside Rundock'),
      'the hook header says it');
  });

  test('and the hook does it: each is refused inside Rundock with nobody to ask, and passes through outside it', () => {
    for (const raw of ['{}', request({ tool_name: 7 }), request({ tool_name: '' }), request({ tool_name: '  ' }),
      request({ tool_name: 'Bash' }), request({ tool_name: 'Write', tool_input: 'x' }), request({ tool_name: 'mcp__example__update_thing', tool_input: null })]) {
      const inside = hook(raw, {});
      assert.strictEqual(inside && inside.hookSpecificOutput && inside.hookSpecificOutput.permissionDecision, 'deny', `${raw}: ${JSON.stringify(inside)}`);
      assert.strictEqual(inside.hookSpecificOutput.permissionDecisionReason, COULD_NOT_CHECK, raw);
      assert.deepStrictEqual(hook(raw, { RUNDOCK: '' }), {}, `${raw}, outside Rundock`);
    }
    const named = hook(request({ tool_name: 'WebFetch' }), {});
    assert.strictEqual(named && named.hookSpecificOutput && named.hookSpecificOutput.permissionDecision, 'allow',
      `a tool named properly whose checks read no input is judged as before: ${JSON.stringify(named)}`);
  });
});

// ---------------------------------------------------------------------------
// docs/RUNDOCK-UI.md: one rule for a destructive button that acts at once
// ---------------------------------------------------------------------------

describe('RUNDOCK-UI.md: the danger rule says the same thing in both places', () => {
  // The button section names "Stop this run" as a destructive button that
  // acts at once and is drawn as a neutral outline. The design rules near
  // the end of the page state the danger rule again, and a reader who meets
  // only that statement must not be told every such button is solid.
  const uiDoc = fs.readFileSync(path.join(ROOT, 'docs', 'RUNDOCK-UI.md'), 'utf-8');
  const ruleOf = (start) => uiDoc.split('\n').find(line => line.startsWith(start)) || '';

  test('the design rule names the outline exception the button section makes', () => {
    const button = ruleOf('The rule is about where the click lands');
    const design = ruleOf('- **Danger differs by form as well as colour.**');
    assert.ok(button && design, 'both statements of the danger rule are on the page');
    for (const [where, text] of [['the button section', button], ['the design rules', design]]) {
      assert.match(text, /Stop this run/, `${where} names the control the exception is for`);
      assert.match(text, /neutral outline that takes the danger colors on hover and keyboard focus/,
        `${where} says how that control is drawn`);
    }
  });
});

// The server's own answers, read and saved, pinned by putting requests to a
// router with no window wired to it.
const auth = require('../../lib/auth/index.js');
const { EventEmitter } = require('node:events');
// A router with nothing connected to it, as Rundock on a server runs: what
// it answers, what it sends toward a window, and what it leaves waiting.
function routerWithNoWindow() {
  const key = require.resolve('../../lib/http-router.js');
  const shared = require.cache[key];
  delete require.cache[key];
  const router = require(key);
  delete require.cache[key];
  if (shared) require.cache[key] = shared;
  const pending = new Map();
  const sent = [];
  router.wireHttpRouterDeps({
    pendingPermissionRequests: () => pending, safeSend: (s) => sent.push(JSON.parse(s)),
    getPermissionTimeoutMs: () => 60000, routineRun: () => null, noteRefusedCard: () => false,
  });
  const token = auth.issueHookToken('doc-claims-read');
  const put = (body) => new Promise((resolve) => {
    const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/api/permission-request', headers: { [auth.HOOK_HEADER]: token } });
    const res = Object.assign(new EventEmitter(), {
      writeHead() {}, writableEnded: false,
      end(payload) { this.writableEnded = true; resolve(JSON.parse(payload)); },
    });
    router.handleHttpRequest(req, res);
    req.emit('data', JSON.stringify(body));
    req.emit('end');
    if (!res.writableEnded) resolve(null);
  });
  return { put, pending, sent, done: () => { for (const p of pending.values()) clearTimeout(p.timer); } };
}

describe('ARCHITECTURE.md: the server answers a low-risk read itself, with or without a window', () => {
  // The claim a person running Rundock with no window open relies on: a
  // routine's read gets the answer a conversation's does. Pinned by putting a
  // request to a router with no window wired to it, so the page cannot keep
  // saying it after the server stops doing it.
  const LEAD = '**The server answers a low-risk read itself, with or without a window.**';
  const at = architecture.indexOf(LEAD);
  const passage = at >= 0 ? architecture.slice(at, architecture.indexOf('\n', at)) : '';
  const routerSrc = fs.readFileSync(path.join(ROOT, 'lib', 'http-router.js'), 'utf-8');
  const graderSrc = fs.readFileSync(path.join(ROOT, 'public', 'permissions.js'), 'utf-8');
  const chatSrc = fs.readFileSync(path.join(ROOT, 'public', 'views', 'chat.js'), 'utf-8');
  const flat = (src) => src.replace(/\n\s*\/\/ ?/g, ' ').replace(/\s+/g, ' ');
  const waitFor = async (ok) => {
    for (let i = 0; i < 50; i++) { if (ok()) return true; await new Promise((r) => setTimeout(r, 20)); }
    return ok();
  };
  // What the routines page says the server answers before any card, besides a
  // read, and what still cards. The router's standing-folder-grant branch
  // answers a crossing it covers ahead of the read and the card, so the page
  // cannot say every place outside the workspace raises a card.
  const GRANT_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
  const GRANT_SENTENCE = `A place outside the workspace that a file tool (${GRANT_TOOLS.slice(0, -1).join(', ')} or ${GRANT_TOOLS[GRANT_TOOLS.length - 1]}) `
    + 'reaches inside a folder you chose "Always allow this folder" for is answered by the server with no card, as it already was: '
    + 'that grant covers everything under the folder except a secrets-tier path, an answer file, a shell startup file '
    + '(and a write to a folder that holds one) and Rundock\'s console folder, and it never answers a shell command.';
  const STILL_CARDS_SENTENCE = 'Every other place outside the workspace the hook graded (any a shell command reaches, and any a file tool '
    + 'reaches that no such grant covers), an answer file, a shell startup file, a Keychain line, a secrets-tier path, '
    + 'and anything not low risk that no saved answer covers still raises a card, as below.';

  test('the audit section, the routines page and the comments say it', () => {
    assert.ok(passage.length > LEAD.length, 'the paragraph is in the audit section');
    assert.ok(passage.includes('`serverAnswer` in `lib/http-router.js` requires that same module'), 'it names where the server answers');
    assert.ok(passage.includes('whether or not a window is connected'), 'it says a window is not needed');
    assert.ok(passage.includes('is never answered this way, nor is one whose `code_mode_verdict` decides otherwise (a Keychain line carries one that always asks), nor anything not low risk that no saved answer covers, and any error falls through to the card'), 'it says what still cards');
    assert.ok(passage.includes('The window\'s own branch now sees only what the server did not answer.'), 'it says what the window still sees');
    assert.ok(routinesDoc.includes('the server answers it itself, from the decision the window makes, whether or not a Rundock window is open'),
      'the routines page says a read raises no card with no window');
    assert.ok(routinesDoc.includes(GRANT_SENTENCE), 'the routines page says which crossings a standing folder grant answers with no card');
    assert.ok(routinesDoc.includes(STILL_CARDS_SENTENCE), 'and that everything else the hook graded still raises a card');
    assert.ok(!routinesDoc.includes('Anything the hook graded (a place outside the workspace'),
      'and no longer says every place outside the workspace raises a card, which a standing folder grant answers without one');
    assert.ok(!graderSrc.includes('client-side, and nowhere else'), 'the module no longer says the policy runs only in the browser');
    assert.ok(flat(graderSrc).includes('two layers read it: the window, and the server bridge (serverAnswer in lib/http-router.js)'), 'it says who reads it');
    assert.ok(flat(chatSrc).includes('answers a low-risk read and a saved "Always allow" itself, so either reaches this branch only when the server did not answer it'), 'the window says what reaches it');
    assert.ok(routerSrc.includes("require('../public/permissions.js')"), 'the server requires the module the window loads');
  });

  test('and the server does it: a router with no window answers a read with no card, and cards what is not one', async () => {
    const dir = useWorkspace({});
    const { put, pending, sent, done } = routerWithNoWindow();
    try {
      assert.deepStrictEqual(await put({ tool_name: 'Bash', tool_input: { command: 'ls -la' } }), { allow: true, reason: 'read-only' }, 'a read is answered');
      assert.deepStrictEqual(sent, [], 'with no card sent toward a window');
      assert.strictEqual(pending.size, 0, 'and nothing left waiting');
      for (const body of [
        { tool_name: 'Bash', tool_input: { command: 'npm run build' } },
        { tool_name: 'Bash', tool_input: { command: 'cat /elsewhere/notes.md' }, boundary: true, crossings: [{ path: '/elsewhere/notes.md' }] },
      ]) {
        assert.strictEqual(await put(body), null, `waits for a card: ${JSON.stringify(body)}`);
      }
      assert.strictEqual(pending.size, 2, 'both wait');
      assert.deepStrictEqual(sent.map((m) => m.type), ['control_request', 'control_request'], 'each as a card');
      const month = new Date().toISOString().slice(0, 7);
      const events = path.join(dir, '.rundock', 'state', `events-${month}.jsonl`);
      assert.ok(await waitFor(() => fs.existsSync(events) && fs.readFileSync(events, 'utf-8').includes('"reason":"read-only"')),
        'and the allow is recorded with its reason');
    } finally {
      done();
    }
  });

  test('and a standing folder grant answers only the crossings the routines page says, with no card', async () => {
    // The tools the page names are the hook's file tools, the ones whose
    // crossing a stored grant may answer, and a shell command's crossing never
    // is one: the hook marks it not grantable.
    const hook = require('../../scripts/permission-hook.js');
    const hookSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'permission-hook.js'), 'utf-8');
    const map = hookSrc.match(/const FILE_TOOL_PATH_FIELD = \{([\s\S]*?)\};/);
    assert.ok(map, 'the hook still keeps its file tools in FILE_TOOL_PATH_FIELD');
    assert.deepStrictEqual([...map[1].matchAll(/(\w+):/g)].map((m) => m[1]).sort(), [...GRANT_TOOLS].sort(), 'the page names every file tool and no other');
    const dir = useWorkspace({});
    const granted = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'doc-claims-grant-'));
    const file = path.join(granted, 'notes.md');
    for (const tool of GRANT_TOOLS) {
      const access = hook.classifyFileAccess(tool, { file_path: file, notebook_path: file, path: file }, dir);
      assert.ok(access && access.where === 'outside' && access.grantable !== false, `${tool}: a crossing a grant may answer`);
    }
    const shell = hook.classifyShellAccess('Bash', { command: `cat ${file}` }, dir);
    assert.ok(shell && shell.where === 'outside' && shell.grantable === false, 'a shell command\'s crossing is never one');

    // And the router does it: with the folder granted, a file tool's crossing
    // into it is answered with no card, while the same place reached by a
    // shell command, and a place the grant does not cover, wait for a card.
    require('../../lib/workspace/boundary.js').addBoundaryGrant(granted);
    const { put, pending, sent, done } = routerWithNoWindow();
    try {
      const crossing = (p) => ({ boundary: true, resolved_path: p, crossings: [{ path: p }] });
      assert.deepStrictEqual(await put({ tool_name: 'Read', tool_input: { file_path: file }, ...crossing(file) }),
        { allow: true, reason: 'standing-folder-grant' }, 'a file tool\'s crossing the grant covers is answered');
      assert.deepStrictEqual(sent, [], 'with no card sent toward a window');
      const elsewhere = path.join(path.dirname(granted), 'not-granted', 'notes.md');
      for (const body of [
        { tool_name: 'Bash', tool_input: { command: `cat ${file}` }, ...crossing(file), grantable: false },
        { tool_name: 'Read', tool_input: { file_path: elsewhere }, ...crossing(elsewhere) },
      ]) {
        assert.strictEqual(await put(body), null, `waits for a card: ${JSON.stringify(body)}`);
      }
      assert.deepStrictEqual(sent.map((m) => m.type), ['control_request', 'control_request'], 'each as a card');
      assert.strictEqual(pending.size, 2, 'and both wait');
    } finally {
      done();
      fs.rmSync(granted, { recursive: true, force: true });
    }
  });
});

describe('ARCHITECTURE.md: the server applies a saved "Always allow" itself, with or without a window', () => {
  // The claim a person who saved an answer relies on: a routine with no
  // window open is not left waiting on a card they already answered, and
  // nothing but what Rundock saved is applied. Pinned by a router with no
  // window wired to it, a turn held on the answer-file guard, and a key saved
  // through the store's own writer.
  const guard = require('../../lib/workspace/answer-file-guard.js');
  const boundary = require('../../lib/workspace/boundary.js');
  const config = require('../../lib/config.js');
  const LEAD = '**The server applies a saved "Always allow" itself, with or without a window, and only as Rundock wrote it.**';
  const at = architecture.indexOf(LEAD);
  const passage = at >= 0 ? architecture.slice(at, architecture.indexOf('\n', at)) : '';
  const routerSrc = fs.readFileSync(path.join(ROOT, 'lib', 'http-router.js'), 'utf-8');
  const graderSrc = fs.readFileSync(path.join(ROOT, 'public', 'permissions.js'), 'utf-8');
  const chatSrc = fs.readFileSync(path.join(ROOT, 'public', 'views', 'chat.js'), 'utf-8');
  const flat = (src) => src.replace(/\n\s*\/\/ ?/g, ' ').replace(/\s+/g, ' ');

  test('the audit section, the routines page and the comments say it', () => {
    assert.ok(passage.length > LEAD.length, 'the paragraph is in the audit section');
    assert.ok(passage.includes('`serverAnswer` gives `decidePermission` those saved answers and the request\'s `code_mode_verdict` exactly as the window gives them'),
      'it says the server makes the window\'s decision');
    assert.ok(passage.includes("answered `{ allow: true, reason: 'always-allowed' }` at once, whether or not a window is connected"), 'it says a window is not needed');
    assert.ok(passage.includes('a high-risk command still cards, ahead of every saved answer in `decidePermission`'), 'it says high risk still cards');
    assert.ok(passage.includes('an Asks-once verdict is answered only by its own saved rule key, never by a binary key such as `Bash:git`'), 'it says what answers an Asks once');
    assert.ok(passage.includes('So `savedAnswers` applies none while no turn\'s guard watches the workspace, runs `checkAnswerFilesNow` first'), 'it says the check comes first');
    assert.ok(passage.includes('and then reads that baseline (`answerFileBaseline` in `lib/workspace/answer-file-guard.js`) rather than the file'), 'it says what is read');
    assert.ok(passage.includes("Rundock's own writes of the file build on what the guard has accepted, never on the file as it stands (`answerFileToBuildOn`"), 'it says what a writer builds on');
    assert.ok(routinesDoc.includes('the server applies that answer itself, whether or not a Rundock window is open, so a routine never waits on a card for something you already allowed'),
      'the routines page says a saved answer holds with no window');
    assert.ok(flat(graderSrc).includes('auto-allow POLICY for low-risk read-only commands and saved "Always allow" answers lives here and only here'), 'the module says the policy covers saved answers');
    assert.ok(flat(chatSrc).includes('and a request a saved "Always allow" covers, are answered by the server before they get here, with or without a window'),
      'the approvals dock\'s branch says what reaches it');
    // The order the paragraph states is the order the code keeps.
    const body = routerSrc.slice(routerSrc.indexOf('function savedAnswers()'), routerSrc.indexOf('function serverAnswer('));
    const order = ['guard.answerFilesWatched(workspace)', 'guard.checkAnswerFilesNow(workspace)', 'guard.answerFileBaseline('].map((n) => body.indexOf(n));
    assert.ok(order.every((i) => i > 0) && order[0] < order[1] && order[1] < order[2], `watched, then checked, then the baseline read: ${order}`);
    assert.ok(!body.includes('readToolAllows'), 'and never the file as it stands');
  });

  test('and the server does it: a router with no window applies a saved key while a turn is guarded, never a key planted before a save, and nothing once no turn is guarded', async () => {
    // A turn's guard watches the home folder's shell startup files, and the
    // test preload fails the run if any of them is the account's own
    // (test/helpers/account-home-refused.js). So the guard is given a made-up
    // home for this test only, as made-up-home.js gives a whole file one:
    // HOME, the desktop layout that puts Rundock's record there too, and no
    // ZDOTDIR or XDG_CONFIG_HOME. Put back once the turn is released.
    const home = fs.realpathSync(fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'doc-claims-home-')));
    const ENV = ['HOME', 'RUNDOCK_ELECTRON', 'ZDOTDIR', 'XDG_CONFIG_HOME'];
    const was = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    process.env.HOME = home;
    process.env.RUNDOCK_ELECTRON = '1';
    delete process.env.ZDOTDIR;
    delete process.env.XDG_CONFIG_HOME;
    const restore = () => {
      for (const k of ENV) { if (was[k] === undefined) delete process.env[k]; else process.env[k] = was[k]; }
      fs.rmSync(home, { recursive: true, force: true });
    };
    useWorkspace({});
    const ws = config.getWorkspace();
    const command = { tool_name: 'Bash', tool_input: { command: 'python3 tools/report.py' } };
    const { put, pending, sent, done } = routerWithNoWindow();
    let turn;
    try { turn = guard.acquireAnswerFileGuard(ws, () => {}, { intervalMs: 60 * 60 * 1000 }); } catch (e) { restore(); throw e; }
    let released = false;
    try {
      assert.strictEqual(await put(command), null, 'with nothing saved, it waits for a card');
      boundary.addToolAllow('Bash:python3');
      assert.deepStrictEqual(await put(command), { allow: true, reason: 'always-allowed' }, 'once saved, it is answered');
      assert.deepStrictEqual(await put({ tool_name: 'Bash', tool_input: { command: 'python3 tools/report.py && rm -rf build' } }), null, 'a high-risk line under the same key waits');
      // A key written straight to the file, as a script would, and then a
      // save of another key through the store's own writer: the save never
      // carries the planted key, so the router never answers it.
      const file = boundary.boundaryPermissionsPath();
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      fs.writeFileSync(file, JSON.stringify({ ...data, allowedTools: [...data.allowedTools, 'Bash:node'] }, null, 2));
      boundary.addToolAllow('Bash:echo');
      assert.strictEqual(await put({ tool_name: 'Bash', tool_input: { command: 'node scripts/build.js' } }), null, 'a command under the planted key waits');
      assert.ok(!boundary.readToolAllows().includes('Bash:node') && boundary.readToolAllows().includes('Bash:echo'), 'the save wrote the file without the planted key');
      turn.release();
      released = true;
      assert.strictEqual(await put(command), null, 'with no turn guarded, the saved key answers nothing');
      assert.strictEqual(pending.size, 4, 'each one it did not answer waits on a card');
      assert.deepStrictEqual(sent.map((m) => m.type), ['control_request', 'control_request', 'control_request', 'control_request']);
    } finally {
      if (!released) turn.release();
      boundary.removeToolAllow('Bash:python3');
      boundary.removeToolAllow('Bash:echo');
      done();
      restore();
    }
  });
});
