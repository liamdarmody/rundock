'use strict';
// A HOOK THAT FAILS BLOCKS THE READ, THROUGH THE INSTALLED CLAUDE CODE.
//
// credential-read-registered.test.js checks that the PreToolUse entries a
// workspace open writes say to block a call when the hook fails, and runs the
// registered command through sh. Whether a failing hook really blocks the call
// is decided by the runtime, so this hands the entries to the installed Claude
// Code itself.
//
// Each case opens a fresh workspace the way Rundock opens one, so
// `.claude/settings.local.json` holds the real PreToolUse entries: the shell
// launcher `.rundock/permission-hook.sh`, a 300 second timeout, and block on
// failure. A dummy file shaped like a sign-in credential, holding a made-up
// marker, sits in the workspace at `home/.claude/.credentials.json`. It is
// inside the workspace, so nothing but the hook can stop a Read of it. The
// launcher is then replaced by one that fails in a known way, after first
// noting in the workspace that it ran and which mode it was given:
//
//   crash:   exits non-zero and prints nothing;
//   cut-off: prints the first half of a valid allow answer and exits 2, as
//            the hook does when its whole answer cannot be written
//            (`undelivered`). A half answer with exit 0 is read by the
//            runtime as no objection, which is why the hook never ends so;
//   stall:   sleeps past the registered 300 second timeout. This case waits
//            five minutes or more, so it runs in Code mode only;
//   control: prints a whole allow answer, so the Read runs and the marker
//            comes back, which shows what a Read that ran looks like.
//
// The real `claude` runs once per case, non-interactively, in the workspace,
// with project and local settings only and the Read tool only, under the
// permission mode Rundock's conversations use, and with the variables
// Rundock gives a spawned agent (Code mode is RUNDOCK_CODE_MODE=1, as the
// runtime sets it). The port it names has nothing listening. The prompt asks
// for one Read of the dummy file. For each failing case: the launcher ran,
// exactly one Read was attempted, its result is an error or a block, and the
// marker appears nowhere in the stream. Crash and cut-off run in Notes mode
// and in Code mode.
//
// The run signs in as the account running it, so Claude Code keeps that
// account's home. Every file the agent is pointed at is under a made-up home
// in the temp folder, and this process reads no credential file of its own.
//
// RUN BY HAND, NEVER IN CI: macOS only, and skipped unless
// RUNDOCK_LIVE_CLAUDE_CODE=1. It makes one model call per case, and must run
// with no other sandbox around it.
const ownEnv = { ...process.env };
const { home } = require('../helpers/made-up-home.js');
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const skip = process.platform !== 'darwin' ? 'this run through the installed Claude Code is made on macOS only'
  : process.env.RUNDOCK_LIVE_CLAUDE_CODE !== '1' ? 'set RUNDOCK_LIVE_CLAUDE_CODE=1 to run it through the installed Claude Code'
    : false;

const STUB_DIR = path.join(__dirname, '..', 'helpers', 'stub-claude');
const HOOK = path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');
const MARKER = `dummy-credential-${crypto.randomBytes(12).toString('hex')}`;
const ALLOW = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Allowed by the test launcher.' } });

// What each replaced launcher does after noting that it ran.
const CASES = {
  crash: { fails: true, body: 'exit 3' },
  'cut-off': { fails: true, body: `printf '%s' '${ALLOW.slice(0, Math.floor(ALLOW.length / 2))}'\nexit 2` },
  stall: { fails: true, body: 'exec sleep 330' },
  control: { fails: false, body: `printf '%s\\n' '${ALLOW}'\nexit 0` },
};
const RUNS = [
  ['Notes mode', '', 'crash'], ['Notes mode', '', 'cut-off'], ['Notes mode', '', 'control'],
  ['Code mode', '1', 'crash'], ['Code mode', '1', 'cut-off'], ['Code mode', '1', 'control'],
  ['Code mode', '1', 'stall'],
];

// Whether a PreToolUse matcher covers a tool, read the way the runtime reads one.
const covers = (matcher, tool) => !matcher || matcher === '*' || new RegExp(`^(?:${matcher})$`).test(tool);

describe('a registered hook that fails blocks a Read, through the installed Claude Code', { skip }, () => {
  let scaffold, prevDeps, port, bin, env0, version;

  before(async () => {
    scaffold = require('../../lib/workspace/scaffold.js');
    prevDeps = scaffold.wireScaffoldDeps({ invalidateAgentCache() {}, rebaselineAgentsWatcher() {} });
    port = await require('../helpers/code-mode-fixture.js').closedPort();
    // The installed Claude Code, never the test stub. A session that launched
    // this marks its environment, and a nested launch is refused, so the mark
    // is dropped. Rundock's own variables are set below, never inherited.
    env0 = { ...ownEnv };
    for (const name of ['CLAUDECODE', 'RUNDOCK_CODE_MODE', 'RUNDOCK_CONVO_ID', 'RUNDOCK_HOOK_TOKEN', 'NODE_V8_COVERAGE']) delete env0[name];
    bin = String(spawnSync('which', ['claude'], { encoding: 'utf8', env: env0 }).stdout || '').trim();
    assert.ok(bin, 'a claude binary is on the PATH');
    assert.ok(!fs.realpathSync(bin).startsWith(fs.realpathSync(STUB_DIR)), 'the claude on the PATH is Claude Code, not the test stub');
    version = String(spawnSync(bin, ['--version'], { encoding: 'utf8', env: env0 }).stdout || '').trim();
  });

  after(() => { if (scaffold) scaffold.wireScaffoldDeps(prevDeps); });

  test('the Claude Code version', (t) => { t.diagnostic(`claude --version: ${version}`); });

  for (const [label, code, name] of RUNS) {
    const { fails, body } = CASES[name];
    const title = name === 'stall'
      ? `${label}: a launcher that stalls past the 300 second timeout blocks the Read (waits five minutes or more, Code mode only)`
      : fails ? `${label}: a launcher that ${name === 'crash' ? 'crashes' : 'gives a cut-off answer'} blocks the Read`
        : `${label}: a launcher that answers allow lets the Read run, and the marker comes back`;
    test(title, (t) => {
      // A workspace opened the way Rundock opens one.
      const ws = fs.mkdtempSync(path.join(home, `workspace-${code ? 'code' : 'notes'}-${name}-`));
      assert.ok(!/['\s]/.test(ws), 'the workspace path needs no quoting');
      fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
      fs.mkdirSync(path.join(ws, '.rundock'), { recursive: true });
      scaffold.scaffoldWorkspace(ws, { platform: process.platform });
      const settings = JSON.parse(fs.readFileSync(path.join(ws, '.claude', 'settings.local.json'), 'utf-8'));
      const launcher = path.join(ws, '.rundock', 'permission-hook.sh');
      const forRead = settings.hooks.PreToolUse.filter((e) => covers(e.matcher, 'Read'));
      assert.strictEqual(forRead.length, 1, 'one PreToolUse entry covers Read');
      assert.deepStrictEqual(forRead[0].hooks, [{ type: 'command', command: `sh "${launcher}"`, timeout: 300, onFailure: 'block' }],
        'the entry that covers Read runs the launcher, waits 300 seconds, and blocks on failure');
      assert.ok(fs.readFileSync(launcher, 'utf-8').includes(`"${HOOK}"`), 'the open wrote a launcher that runs the hook');

      // The dummy credential, and the failing launcher in place of the real one.
      const dummy = path.join(ws, 'home', '.claude', '.credentials.json');
      fs.mkdirSync(path.dirname(dummy), { recursive: true });
      fs.writeFileSync(dummy, `${JSON.stringify({ accessToken: MARKER, refreshToken: `${MARKER}-refresh` })}\n`);
      const ran = path.join(ws, 'hook-ran.txt');
      fs.writeFileSync(launcher, `#!/bin/sh\nprintf '%s\\n' "mode=\${RUNDOCK_CODE_MODE:-}" >> '${ran}'\n${body}\n`);

      const env = { ...env0, RUNDOCK: '1', RUNDOCK_PORT: String(port), RUNDOCK_WORKSPACE: ws, RUNDOCK_EXTRA_DIRS: '' };
      if (code) env.RUNDOCK_CODE_MODE = code;
      const prompt = `Use the Read tool exactly once, on this file: ${dummy}\n`
        + 'Use no other tool. If the Read fails or is blocked, do not try again. When it has finished, reply with the one word: done.';
      const run = spawnSync(bin, [
        '-p', prompt,
        '--output-format', 'stream-json', '--verbose',
        '--setting-sources', 'project,local',
        '--tools', 'Read',
        '--permission-mode', 'acceptEdits',
        '--strict-mcp-config', '--no-session-persistence',
        '--permission-prompts', 'none',
        '--max-budget-usd', '1',
      ], { cwd: ws, encoding: 'utf8', env, timeout: 600000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

      const stream = `${run.stdout || ''}\n${run.stderr || ''}`;
      const events = String(run.stdout || '').split('\n').filter((line) => line.startsWith('{'))
        .flatMap((line) => { try { return [JSON.parse(line)]; } catch (e) { return []; } });
      const content = (type) => events.filter((e) => e.type === type && e.message && Array.isArray(e.message.content))
        .flatMap((e) => e.message.content);
      const calls = content('assistant').filter((b) => b.type === 'tool_use');
      const reads = calls.filter((c) => c.name === 'Read');
      const result = reads.length ? content('user').find((b) => b.type === 'tool_result' && b.tool_use_id === reads[0].id) : null;
      const text = !result ? '' : typeof result.content === 'string' ? result.content
        : (result.content || []).map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n');
      const hookRan = fs.existsSync(ran) ? fs.readFileSync(ran, 'utf-8').split('\n').filter(Boolean) : [];
      const executed = text.includes(MARKER);
      const firstWords = text.split(ws).join('<workspace>').replace(/\s+/g, ' ').trim().slice(0, 160);

      t.diagnostic(`${label} | ${name} | hook ran: ${hookRan.length ? `yes, ${hookRan.length}x (${hookRan.join(', ')})` : 'no'}`
        + ` | Read calls: ${reads.length} | Read executed: ${executed ? 'yes' : 'no'}`
        + ` | result: ${!result ? 'none' : result.is_error ? 'error' : 'ok'}: ${firstWords || '(empty)'}`
        + ` | claude exit ${run.status}${run.signal ? `, signal ${run.signal}` : ''}`);

      const why = `exit ${run.status}, signal ${run.signal}, stderr: ${String(run.stderr || '').split(home).join('<home>').slice(0, 1000)}`;
      assert.ok(hookRan.length >= 1, `the runtime ran the launcher (${why})`);
      assert.ok(hookRan.every((l) => l === `mode=${code}`), `the launcher was given the mode Rundock sets: ${hookRan.join(', ')}`);
      assert.deepStrictEqual(calls.map((c) => c.name), ['Read'], `exactly one tool call, a Read (${why})`);
      assert.strictEqual(path.resolve(ws, String(reads[0].input && reads[0].input.file_path)), dummy, 'the Read names the dummy credential');
      assert.ok(result, 'the Read has a result');
      if (fails) {
        assert.ok(result.is_error === true || /hook|block|denied|refused/i.test(text), `the Read's result is an error or a block: ${firstWords}`);
        assert.ok(!stream.includes(MARKER), 'the dummy credential\'s marker appears nowhere in the stream');
      } else {
        assert.ok(executed, `the Read ran and the marker came back: ${firstWords}`);
      }
    });
  }
});
