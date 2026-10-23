'use strict';
// LAUNCHCTL CHANGES WHAT EVERY LATER PROGRAM INHERITS, IN EITHER MODE.
//
// `launchctl setenv`, `unsetenv` and `config` change the environment programs
// started from then on inherit, Rundock included the next time it is opened
// from the Dock; `load`, `bootstrap` and `submit` start a program under
// launchd. In Notes mode they were graded medium under the key `Bash:launchctl`,
// so an Always allow given for `launchctl list` answered a later `setenv`. They
// are now graded high in Notes mode (card ahead of any saved allow, no Always
// allow, refused when nobody can be asked), and Code mode grades `config` with
// the rest. Reading it with `print`, `list` or `getenv` is unchanged.
//
// No fixture: the grading reads only the command text.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const RP = require('../../public/permissions.js');
const { codeModeVerdict } = require('../../scripts/code-mode-verdict.js');
const HOOK = path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');

const CHANGES = ['launchctl setenv X 1', 'launchctl unsetenv PATH', 'launchctl load -w agent.plist', 'launchctl bootstrap gui/501 agent.plist',
  'launchctl submit -l x -- /bin/sh -c true', 'launchctl config user path /tmp/bin', 'launchctl asuser 501 launchctl setenv X 1',
  'true && launchctl setenv X 1', '/bin/launchctl setenv X 1'];
const READS = ['launchctl list', 'launchctl print gui/501', 'launchctl getenv PATH'];

let ws, closed;
before(async () => {
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'launchctl-asks-')));
  const s = http.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  closed = s.address().port;
  await new Promise(r => s.close(r));
});
after(() => { if (ws) fs.rmSync(ws, { recursive: true, force: true }); });

function notesHook(command) {
  const env = { ...process.env, RUNDOCK: '1', RUNDOCK_WORKSPACE: ws, RUNDOCK_PORT: String(closed), RUNDOCK_EXTRA_DIRS: '' };
  delete env.RUNDOCK_CODE_MODE;
  delete env.NODE_V8_COVERAGE;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => { try { resolve(JSON.parse(out).hookSpecificOutput.permissionDecision); } catch (e) { resolve('none'); } });
    child.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', cwd: ws, tool_name: 'Bash', tool_input: { command } }));
  });
}

describe('launchctl in Notes mode', () => {
  test('a change is graded high: carded ahead of any saved allow, with no Always allow', () => {
    for (const command of CHANGES) {
      const risk = RP.classifyRisk('Bash', { command });
      assert.strictEqual(risk, 'high', command);
      assert.strictEqual(RP.offersAlwaysAllow(risk), false, `${command}: no Always allow`);
      const saved = new Set(['Bash:launchctl', RP.toolAllowKey('Bash', { command: 'launchctl list' })]);
      assert.deepStrictEqual(RP.decidePermission(risk, RP.toolAllowKey('Bash', { command }), saved), { action: 'card' },
        `${command}: an Always allow given for launchctl list does not answer it`);
    }
  });

  test('reading it is graded as before', () => {
    for (const command of READS) assert.notStrictEqual(RP.classifyRisk('Bash', { command }), 'high', command);
  });

  test('through the real hook, a change is refused when nobody can be asked, and a read is not', async () => {
    for (const command of ['launchctl setenv X 1', 'launchctl config user path /tmp/bin']) assert.strictEqual(await notesHook(command), 'deny', command);
    assert.strictEqual(await notesHook('launchctl list'), 'allow');
  });
});

describe('launchctl in Code mode', () => {
  test('config always asks, like the other changes', () => {
    const v = codeModeVerdict({ toolName: 'Bash', command: 'launchctl config user path /tmp/bin', cwd: ws, workspaceRoot: ws, home: os.homedir() });
    assert.strictEqual(v.verdict, 'always-asks');
    assert.strictEqual(v.reason, 'launch-environment');
  });
});
