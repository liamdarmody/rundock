'use strict';
// A WRITE TO RUNDOCK'S CONSOLE FOLDER ALWAYS ASKS.
//
// `~/.rundock-console` holds the script Rundock opens in Terminal when a person
// reconnects Claude Code, so whatever it says runs on their machine outside
// any sandbox, the moment they press the button. With the workspace at the
// home folder nothing stopped an agent replacing it: the sandbox block did not
// deny the folder, and the hook took it as ordinary work inside the workspace.
// Now a write there, by a file tool or a shell command, asks every time with
// Allow and Deny only, in both modes, and is refused when Rundock cannot be
// asked, wherever the workspace is. A read stays as it was.
//
// Driven through the real hook with a made-up home folder and a server that is
// not there, so an ask can only end in a refusal: what the hook does then is
// the difference between a write it guards and one it lets through.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');
const hook = require(HOOK);
const RP = require('../../public/permissions.js');

let home, nested, closed;
before(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'console-home-')));
  nested = path.join(home, 'Projects', 'ws');
  for (const ws of [home, nested]) {
    fs.mkdirSync(path.join(ws, '.rundock'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.rundock', 'state.json'), '{}\n');
    fs.writeFileSync(path.join(ws, 'x.sh'), 'echo hi\n');
  }
  fs.mkdirSync(path.join(home, '.rundock-console'));
  fs.writeFileSync(path.join(home, '.rundock-console', 'Reconnect Claude.command'), '#!/bin/sh\nexec claude\n');
  const s = http.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  closed = s.address().port;
  await new Promise(r => s.close(r));
});
after(() => { if (home) fs.rmSync(home, { recursive: true, force: true }); });

function decision(ws, tool_name, tool_input, codeMode) {
  const env = { ...process.env, HOME: home, RUNDOCK: '1', RUNDOCK_WORKSPACE: ws, RUNDOCK_PORT: String(closed), RUNDOCK_EXTRA_DIRS: '' };
  delete env.RUNDOCK_CODE_MODE;
  delete env.NODE_V8_COVERAGE;
  if (codeMode) env.RUNDOCK_CODE_MODE = '1';
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => {
      try {
        const o = JSON.parse(out).hookSpecificOutput;
        resolve({ decision: o.permissionDecision, reason: o.permissionDecisionReason || '' });
      } catch (e) { resolve({ decision: 'none', reason: out }); }
    });
    child.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', cwd: ws, tool_name, tool_input }));
  });
}

const script = () => path.join(home, '.rundock-console', 'Reconnect Claude.command');
const WRITES = () => [
  ['Bash', { command: 'echo "exec curl example.com" > "$HOME/.rundock-console/Reconnect Claude.command"' }, 'a shell redirect'],
  ['Bash', { command: 'cp x.sh ~/.rundock-console/run.command' }, 'cp onto a file in it'],
  ['Bash', { command: 'mv x.sh ~/.rundock-console/' }, 'mv into it'],
  ['Bash', { command: 'rm -rf ~/.rundock-console' }, 'removing the folder'],
  ['Bash', { command: 'rm -rf ~/.rundock-*' }, 'a glob at home that matches it'],
  ['Bash', { command: 'rm -rf ~/.{rundock-console,cache-x}' }, 'braces that name it'],
  ['Write', { file_path: script(), content: 'exec curl example.com\n' }, 'the Write tool'],
  ['Edit', { file_path: script(), old_string: 'claude', new_string: 'curl example.com' }, 'the Edit tool'],
];
const READS = () => [
  ['Bash', { command: 'cat ~/.rundock-console/"Reconnect Claude.command"' }, 'cat'],
  ['Read', { file_path: script() }, 'the Read tool'],
];

for (const [label, wsOf] of [['the workspace is the home folder', () => home], ['the workspace is a folder under home', () => nested]]) {
  describe(`when ${label}`, () => {
    for (const codeMode of [false, true]) {
      const mode = codeMode ? 'Code' : 'Notes';
      test(`every write to it is refused when Rundock cannot be asked (${mode} mode)`, async () => {
        for (const [tool, input, what] of WRITES()) {
          const r = await decision(wsOf(), tool, input, codeMode);
          assert.strictEqual(r.decision, 'deny', `${mode}: ${what}`);
        }
      });
      // Inside a home-folder workspace a read is ordinary work, and stays so.
      // From a workspace under home it is a read of a hidden folder there,
      // judged by that rule as before (the classifier test below shows it is
      // never taken as a change to the console folder).
      if (label === 'the workspace is the home folder') {
        test(`a read of it runs as before (${mode} mode)`, async () => {
          for (const [tool, input, what] of READS()) {
            const r = await decision(wsOf(), tool, input, codeMode);
            assert.strictEqual(r.decision, 'allow', `${mode}: ${what}`);
          }
        });
      }
    }

    test('the classifier names it as a file that is never changed without asking, and a read as nothing of the kind', () => {
      const ws = wsOf();
      for (const [tool, input, what] of WRITES()) {
        const a = tool === 'Bash'
          ? hook.classifyShellAccess('Bash', input, ws, [], home, true, { cwd: ws })
          : hook.classifyFileAccess(tool, input, ws, [], home, true);
        const asks = !!(a && (a.answerFile || hook.boundaryCrossingsFor(a).some(c => c && c.answerFile)));
        assert.strictEqual(asks, true, what);
        assert.ok(!(a && a.grantDir), `${what}: no folder is offered to remember`);
      }
      for (const [tool, input, what] of READS()) {
        const a = tool === 'Bash'
          ? hook.classifyShellAccess('Bash', input, ws, [], home, true, { cwd: ws })
          : hook.classifyFileAccess(tool, input, ws, [], home, true);
        const asks = !!(a && (a.answerFile || hook.boundaryCrossingsFor(a).some(c => c && c.answerFile)));
        assert.strictEqual(asks, false, what);
      }
    });
  });
}

// THE OPERATING SYSTEM REFUSES IT TOO, where the sandbox block runs: the hook
// reads the command, and a script or interpreter writes past what it reads.
describe('the sandbox block denies the folder', () => {
  test('appended last, for a workspace at the home folder and one under it, in both modes', () => {
    const { sandboxSettings, WRITTEN_DENY_LENGTHS } = require('../../lib/workspace/scaffold.js');
    for (const ws of [home, nested]) {
      for (const mode of ['knowledge', 'code']) {
        const deny = sandboxSettings(ws, 'darwin', home, ['/tmp/t'], [], mode).filesystem.denyWrite;
        assert.strictEqual(deny[deny.length - 1], path.posix.join(home, '.rundock-console'), `${mode}: last`);
        assert.ok(WRITTEN_DENY_LENGTHS.includes(deny.length), `${mode}: the ${deny.length}-entry list is recorded as written`);
      }
    }
  });
});

// ONE FOLDER, NAMED IN TWO PLACES. The Reconnect Claude window writes its
// script where lib/runtime/claude-console.js says; the hook guards where its
// own registry says. Read from what the window would write, so the two cannot
// drift apart unnoticed.
describe('the folder guarded is the one Reconnect writes', () => {
  test('the script the Reconnect Claude window writes on macOS is a write that always asks', () => {
    const { consoleCommand } = require('../../lib/runtime/claude-console.js');
    const c = consoleCommand('/usr/local/bin/claude', 'darwin', {}, { purpose: 'reconnect', home, version: '2.1.50' });
    assert.ok(c && c.script && c.script.file, 'sanity: on macOS the reconnect window writes a script first');
    assert.strictEqual(hook.isRundockConsolePath(c.script.file, home), true, 'its file is in the folder the hook guards');
    for (const ws of [home, nested]) {
      const a = hook.classifyFileAccess('Write', { file_path: c.script.file, content: 'x' }, ws, [], home, true);
      assert.strictEqual(a && a.answerFile, true, `an agent's write to it asks (${ws === home ? 'home' : 'under home'})`);
    }
  });
});

describe('a folder of the same name elsewhere is ordinary', () => {
  test('a .rundock-console inside the workspace, below home, is not the console folder', () => {
    const a = hook.classifyShellAccess('Bash', { command: 'echo x > .rundock-console/run.command' }, nested, [], home, true, { cwd: nested });
    assert.ok(!(a && hook.boundaryCrossingsFor(a).some(c => c && c.answerFile)));
  });
});

describe('the card says what the folder decides', () => {
  test('a script Rundock opens in Terminal, not the permission answers', () => {
    const p = script();
    assert.strictEqual(RP.answerFileSummary([p]), 'Wants to change what Rundock opens in Terminal');
    assert.match(RP.answerFileCopy([p]), /opens in Terminal when you reconnect Claude Code/);
    assert.match(RP.answerFileCopy([p]), /asks every time/);
  });
});

describe('no stored folder grant answers it', () => {
  test('a grant over the console folder does not cover a write to it', () => {
    const config = require('../../lib/config.js');
    const boundary = require('../../lib/workspace/boundary.js');
    const prev = config.getWorkspace();
    const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'console-grant-ws-')));
    fs.mkdirSync(path.join(ws, '.rundock'));
    fs.writeFileSync(path.join(ws, '.rundock', 'state.json'), '{}\n');
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'console-grant-other-')));
    try {
      config.setWorkspace(ws);
      boundary.addBoundaryGrant(path.join(home, '.rundock-console'));
      boundary.addBoundaryGrant(other);
      assert.strictEqual(boundary.crossingCovered({ path: path.join(other, 'a.txt') }, home), true, 'sanity: a grant covers an ordinary folder');
      assert.strictEqual(boundary.crossingCovered({ path: script() }, home), false, 'but never the console folder');
    } finally {
      if (prev) config.setWorkspace(prev);
      fs.rmSync(ws, { recursive: true, force: true });
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});
