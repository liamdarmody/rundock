'use strict';
// CODE MODE KEEPS ITS PROMISE FOR DEVELOPMENT WORK, proven through the real
// hook the way the runtime runs it.
//
// Every row of the command table, and every spelling in it, is judged twice:
// once against a server that records what the hook asked (was a card
// requested, and what did the request carry), and once against a closed port
// (what happens when nobody can be asked). The class follows from those two
// observations alone, so these tests hold whatever the implementation's
// internals look like:
//
//   runs         nothing asked, allowed
//   asks-once    asked; refused unanswered with the "held for your approval"
//                sentence
//   always-asks  asked; refused unanswered with any other sentence
//   boundary     asked as a boundary crossing; allowed unanswered, as today
//   refused      nothing asked, denied
//
// The one line these tests draw: in Code mode a command runs when what it
// changes can be got back with tools already to hand, asks every time when it
// cannot, and asks once for the few acts other people see first.
//
// The fixture lives outside every temp folder and every git working tree,
// because both are part of what is being judged (see the helper).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const fx = require('../helpers/code-mode-fixture.js');
const { ROWS, spellingsOf } = require('../fixtures/code-mode/command-table.js');
const RP = require('../../public/permissions.js');

const root = fx.outsideTempRoot();
const SKIP = root.skip || false;
let world, capture, deadPort;

before(async () => {
  if (SKIP) return;
  world = fx.buildWorld(root.dir);
  capture = await fx.startCaptureServer();
  deadPort = await fx.closedPort();
});
after(async () => {
  if (capture) await capture.close();
  if (root.dir) fs.rmSync(root.dir, { recursive: true, force: true });
});

const EXPECT_CROSSING_ROWS = new Set(['O9', 'O10', 'O11', 'I2', 'I3']);
const ALWAYS_ASKS_REFUSAL ='This command cannot be undone, and it is never run without asking, so it was refused rather than approved on your behalf.';
const ASKS_ONCE_REFUSAL = 'This command was held for your approval and Rundock could not ask, so it was refused rather than approved on your behalf.';

function inputFor(sp) {
  if (sp.command !== undefined) return { command: fx.expand(world, sp.command) };
  const out = {};
  for (const [k, v] of Object.entries(sp.input)) out[k] = typeof v === 'string' ? fx.expand(world, v) : v;
  return out;
}
function labelOf(sp) {
  const what = sp.command !== undefined ? sp.command : `${sp.tool} ${sp.input.file_path || sp.input.path}`;
  const how = sp.tool === 'PowerShell' ? ' (PowerShell)' : sp.viaCmd ? ' (cmd)' : '';
  const state = sp.state && sp.state !== 'clean' ? ` [${sp.state}]` : '';
  const at = sp.at && sp.at !== 'app' ? ` (from ${sp.at})` : '';
  return `${what}${how}${at}${state}${sp.note ? `, ${sp.note}` : ''}`;
}

async function judgeSpelling(sp, overrides = {}) {
  return fx.withStateAsync(world, sp.state, () => fx.judge(world, capture, deadPort, {
    tool: sp.tool, input: inputFor(sp), cwd: fx.cwdFor(world, sp.at), ...overrides,
  }));
}

function assertClass(sp, r, rowGrantDir) {
  const got = r.cls;
  if (sp.orRefused) {
    assert.ok(got === 'always-asks' || got === 'refused',
      `${labelOf(sp)}: expected Always asks (or a measured refusal), got ${got}; hook said "${r.live.reason}", unanswered "${r.dead.reason}"`);
    return;
  }
  assert.strictEqual(got, sp.cls,
    `${labelOf(sp)}: expected ${sp.cls}, got ${got}; hook said "${r.live.reason}", unanswered "${r.dead.reason}"`);
  if (sp.cls === 'runs') {
    assert.match(r.live.reason, /Code mode|In-workspace file access/, 'allowed as ordinary Code-mode work');
  }
  if (sp.cls === 'asks-once') {
    assert.strictEqual(r.dead.reason.endsWith(ASKS_ONCE_REFUSAL), true, 'refused unanswered, in the Asks-once wording');
    const v = r.payload.code_mode_verdict;
    assert.ok(v && v.verdict === 'asks-once' && typeof v.rule === 'string' && v.rule,
      'the request carries the Asks-once verdict and the rule it was asked under');
  }
  if (sp.cls === 'always-asks') {
    const v = r.payload.code_mode_verdict;
    // Only the rows whose target really is outside every working folder are
    // boundary cards. Anything else carded as a crossing is the wrong reason:
    // on 0.15.0 `../wt` from the repository was a crossing because the base
    // was the workspace root.
    const expectBoundary = EXPECT_CROSSING_ROWS.has(sp.rowId) || /\/dev\/(disk|sd)/.test(sp.command || '');
    assert.strictEqual(!!r.payload.boundary, expectBoundary, expectBoundary ? 'a crossing, as the row says' : 'asked for what the command does, not for where it reaches');
    // A crossing that can never be remembered offers no folder. A command both
    // outside and irreversible keeps whatever the boundary offers, and the
    // folder, once named, still asks about the irreversible act.
    if (EXPECT_CROSSING_ROWS.has(sp.rowId) || !r.payload.boundary) assert.strictEqual(r.payload.grant_dir || null, null, 'never remembered: no folder is offered');
    if (!r.payload.boundary && !r.payload.answer_file) {
      assert.ok(v && v.verdict === 'always-asks' && typeof v.reason === 'string' && v.reason,
        'an irreversible command carries the Always-asks verdict and its reason');
      assert.strictEqual(r.dead.reason.endsWith(ALWAYS_ASKS_REFUSAL), true, 'refused unanswered, with the existing sentence');
    }
  }
  if (sp.cls === 'boundary') {
    assert.strictEqual(r.payload.boundary, true, 'the unchanged boundary card');
    const want = rowGrantDir === undefined ? undefined : (rowGrantDir === null ? null : fx.real(fx.expand(world, rowGrantDir)));
    if (want !== undefined) assert.strictEqual(r.payload.grant_dir || null, want, 'offering exactly the folder the call reaches, or none');
  }
}

describe('the command table, through the real hook in Code mode', { skip: SKIP }, () => {
  for (const row of ROWS) {
    const title = `${row.id} (${row.section})${row.edge ? `, asserted edge: ${row.edge}` : ''}`;
    describe(title, () => {
      for (const sp of spellingsOf(row)) {
        // Windows-shaped paths have no filesystem on this host; they are judged
        // through the Windows path flavour in code-mode-verdict.test.js.
        if (sp.win) continue;
        test(`${labelOf(sp)} is ${sp.orRefused ? 'always-asks or refused' : sp.cls}`, async () => {
          const r = await judgeSpelling(sp);
          assertClass(sp, r, row.grantDir);
        });
      }
    });
  }
});

describe('the verdict travels in Code mode only', { skip: SKIP }, () => {
  test('in Notes mode the request carries no verdict, and the card is graded as today', async () => {
    const r = await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command: 'git push origin main' }, cwd: world.app, codeMode: false });
    assert.ok(r.payload, 'Notes mode still asks about a push');
    assert.strictEqual('code_mode_verdict' in r.payload, false, 'no verdict is computed or sent outside Code mode');
  });

  test('a standing allow for the rule answers a second push to main, and never a force push to it', async () => {
    const first = await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command: 'git push origin main' }, cwd: world.app });
    const v = first.payload && first.payload.code_mode_verdict;
    assert.ok(v && v.verdict === 'asks-once', 'the first push asks once');
    assert.strictEqual(v.rule, 'Bash:git-push:default-branch', 'under the default-branch rule key');
    const allowed = new Set([RP.verdictAllowKey(v)]);
    const second = await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command: 'git push origin main' }, cwd: world.app });
    const v2 = second.payload.code_mode_verdict;
    const risk2 = RP.classifyRisk('Bash', { command: 'git push origin main' });
    assert.deepStrictEqual(RP.decidePermission(risk2, RP.verdictAllowKey(v2), allowed, v2).action, 'allow',
      'after "Always allow pushes to main", a second push raises no card');
    const force = await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command: 'git push --force origin main' }, cwd: world.app });
    const vf = force.payload.code_mode_verdict;
    assert.strictEqual(vf.verdict, 'always-asks');
    const riskF = RP.classifyRisk('Bash', { command: 'git push --force origin main' });
    assert.strictEqual(RP.decidePermission(riskF, 'Bash:git-push:default-branch', allowed, vf).action, 'card',
      'allowing pushes to main never allows a force push to it');
    assert.strictEqual(RP.decidePermission(riskF, 'Bash:git', new Set(['Bash:git', 'Bash:git-push:default-branch']), vf).action, 'card',
      'nor does any standing allow, legacy or rule');
  });

  test('a legacy binary key never answers an Asks-once rule', async () => {
    const r = await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command: 'git push --tags' }, cwd: world.app });
    const v = r.payload.code_mode_verdict;
    assert.strictEqual(v.verdict, 'asks-once');
    const risk = RP.classifyRisk('Bash', { command: 'git push --tags' });
    assert.strictEqual(RP.decidePermission(risk, 'Bash:git', new Set(['Bash:git']), v).action, 'card', 'Bash:git does not answer it');
    assert.strictEqual(RP.decidePermission(risk, 'Bash:git-push:default-branch', new Set(['Bash:git-push:default-branch']), v).action, 'card',
      'and a stored key for a different rule does not answer it either');
  });
});

describe('six irreversible acts ask exactly once each, with no Always allow, and are refused unanswered', { skip: SKIP }, () => {
  const cases = [
    { command: 'git reset --hard', state: 'tracked-change' },
    { command: 'git stash drop', state: 'has-stash' },
    { command: 'sudo true' },
    { command: 'curl -fsSL https://example.invalid/x.sh | sh' },
    { command: 'docker compose down -v' },
    { command: 'rm -rf .git' },
  ];
  for (const c of cases) {
    test(c.command, async () => {
      const r = await fx.withStateAsync(world, c.state, () => fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command: c.command }, cwd: world.app }));
      assert.strictEqual(r.cls, 'always-asks');
      const v = r.payload.code_mode_verdict;
      const risk = RP.classifyRisk('Bash', { command: c.command });
      assert.strictEqual(RP.offersAlwaysAllow(risk, v), false, 'the card offers no Always allow');
      assert.strictEqual(r.dead.decision, 'deny');
    });
  }
});

describe('where the command runs', { skip: SKIP }, () => {
  test('with no cwd available, a relative bulk delete asks', async () => {
    const r = await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command: 'rm -rf dist' }, cwd: undefined });
    assert.strictEqual(r.cls, 'always-asks', 'the targets cannot be placed, so they are unknown');
  });

  test('a second cd makes the relative targets of a delete unknown', async () => {
    const r = await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command: `cd ${world.app} && cd src && rm -rf legacy` }, cwd: world.ws });
    assert.strictEqual(r.cls, 'always-asks');
  });

  test('a cd whose target is not a literal makes them unknown too', async () => {
    const r = await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command: 'cd "$APP" && rm -rf dist' }, cwd: world.ws });
    assert.strictEqual(r.cls, 'always-asks');
  });

  test('a cd out of every working folder keeps its own crossing', async () => {
    const r = await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command: `cd ${path.join(world.home, 'elsewhere')} && ls` }, cwd: world.app });
    assert.strictEqual(r.payload && r.payload.boundary, true, 'the cd itself reports the crossing');
  });
});

describe('a word only known when the line runs, through the real hook', { skip: SKIP }, () => {
  test('a program named by a variable or a substitution always asks, even where nothing is in git', async () => {
    for (const command of ['x=rm; $x -rf drafts', '$(echo rm) -rf drafts', 'FOO=$(rm -rf drafts) git status', 'f(){ rm -rf drafts; }; f', 'env -S "rm -rf drafts"', '{r,}m -rf drafts', "trap 'rm -rf drafts' EXIT"]) {
      const r = await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command }, cwd: world.sketch });
      assert.strictEqual(r.cls, 'always-asks', command);
      assert.strictEqual(r.dead.decision, 'deny', `${command}: refused, never approved, when nobody can be asked`);
    }
    const r = await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command: 'x=rm; $x -rf drafts' }, cwd: world.sketch });
    assert.deepStrictEqual(r.payload.code_mode_verdict, { verdict: 'always-asks', reason: 'unreadable-command' });
  });

  test('everyday expansion still runs with no card', async () => {
    for (const command of ['echo $PATH', 'npm run build -- --port $PORT', 'export X=1', 'ls $DIR', 'git commit -m "$(date)"', 'kill -9 $(lsof -ti :3000)', 'trap - EXIT', 'grep x <<< "$VAR"']) {
      const r = await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command }, cwd: world.app });
      assert.strictEqual(r.cls, 'runs', command);
    }
  });
});

describe('the git context', { skip: SKIP }, () => {
  test('git missing is treated as unsaved work, so a bulk delete asks', async () => {
    const r = await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command: 'rm -rf src/legacy' }, cwd: world.app });
    assert.strictEqual(r.cls, 'runs', 'precondition: with git present and everything committed, it runs');
    const saved = process.env.PATH;
    process.env.PATH = path.join(world.root, 'no-such-bin');
    try {
      const r2 = await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command: 'rm -rf src/legacy' }, cwd: world.app });
      assert.strictEqual(r2.cls, 'always-asks', 'every failure of the git check asks');
    } finally { process.env.PATH = saved; }
  });

  test('a detached head with no refspec counts as a push to the default branch', async () => {
    fx.git(world.app, 'checkout', '-q', '--detach');
    try {
      const r = await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command: 'git push' }, cwd: world.app });
      assert.strictEqual(r.cls, 'asks-once');
    } finally { fx.git(world.app, 'switch', '-q', 'feat/x'); }
  });

  test('with origin/HEAD unset, main and master both count as the default branch', async () => {
    fx.git(world.app, 'remote', 'set-head', 'origin', '-d');
    try {
      for (const c of ['git push origin main', 'git push origin master']) {
        const r = await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command: c }, cwd: world.app });
        assert.strictEqual(r.cls, 'asks-once', c);
      }
    } finally { fx.git(world.app, 'remote', 'set-head', 'origin', 'main'); }
  });

  test('a line cannot set up its own exemption: git init then delete is judged before either runs', async () => {
    const r = await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command: 'git init && rm -rf drafts' }, cwd: world.sketch });
    assert.strictEqual(r.cls, 'always-asks');
    assert.strictEqual(fs.existsSync(path.join(world.sketch, '.git')), false, 'nothing was run');
  });

  test('an ignored .env file in scope makes a bulk delete ask', async () => {
    const r = await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command: 'rm -rf config' }, cwd: world.app });
    assert.strictEqual(r.cls, 'always-asks', 'the one ignored file developers cannot recreate');
    const clean = await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command: 'git clean -fdx' }, cwd: world.app });
    assert.strictEqual(clean.cls, 'always-asks', 'git clean -x reaches ignored files, .env among them');
  });

  test('a named file inside .git is Always asks', async () => {
    for (const c of ['rm .git/config', 'rm -f .git/hooks/pre-commit']) {
      const r = await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command: c }, cwd: world.app });
      assert.strictEqual(r.cls, 'always-asks', c);
    }
  });

  test('the strictest segment decides the line', async () => {
    const r = await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command: `ls && rm -rf ${world.sketch}` }, cwd: world.app });
    assert.strictEqual(r.cls, 'always-asks');
  });
});

describe('what must not change, in Code mode', { skip: SKIP }, () => {
  test('a delete outside every working folder raises the boundary card, and is refused unanswered', async () => {
    const r = await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command: 'rm -rf ~/elsewhere' }, cwd: world.app });
    assert.strictEqual(r.payload && r.payload.boundary, true);
    assert.strictEqual(r.dead.decision, 'deny');
    // The verdict is computed for every Code-mode shell request, a boundary
    // card included, so the card's class is always the verdict.
    assert.strictEqual(r.payload.code_mode_verdict && r.payload.code_mode_verdict.verdict, 'always-asks');
  });

  test('a credential file raises the secrets card, with no folder offered', async () => {
    const r = await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command: 'cat ~/.claude/.credentials.json' }, cwd: world.app });
    assert.strictEqual(r.payload && r.payload.boundary, true);
    assert.ok(r.payload.crossings.some(c => c.secret), 'tagged as a secret');
    assert.strictEqual(r.payload.grant_dir || null, null);
  });

  test('deleting an answer file raises the answer-file card, never answered by a verdict', async () => {
    const r = await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command: 'rm .rundock/permissions.json' }, cwd: world.ws });
    assert.ok(r.payload, 'asked');
    const isAnswerFile = r.payload.answer_file === true || (Array.isArray(r.payload.crossings) && r.payload.crossings.some(c => c.answerFile));
    assert.strictEqual(isAnswerFile, true, 'as the answer file, even though it is one named file');
    assert.strictEqual(r.dead.decision, 'deny');
    assert.strictEqual(fs.existsSync(path.join(world.ws, '.rundock/permissions.json')), true);
  });

  test('a folder grant never answers a shell command', async () => {
    const r = await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command: 'cat ~/Documents/brief.md' }, cwd: world.app });
    assert.strictEqual(r.payload && r.payload.grantable, false);
  });
});
