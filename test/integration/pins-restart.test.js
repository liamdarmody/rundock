'use strict';
// Pins survive a server restart.
//
// THE REAL SERVER, TWICE, against one temporary HOME and one workspace. The
// in-process harness boots server.js once per test file by design, and a
// restart is exactly the thing a single require cannot stage: module state
// survives it. So this file does what the e2e launcher does, points HOME at a
// disposable directory and starts server.js as its own process, and does it
// twice in sequence. A pin sent over the socket to the first server has to
// be read back over the socket from the second, with nothing in between but
// the file the store wrote under that HOME.
//
// The scheduler is left on, as it is in production; nothing here needs an
// agent, so the stub claude on PATH is never reached.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { makeWorkspace, standardTeam } = require('../helpers/workspace.js');

const SERVER = path.join(__dirname, '..', '..', 'server.js');
const BANNER_TIMEOUT_MS = 20000;
const STUB_DIR = path.join(__dirname, '..', 'helpers', 'stub-claude');
const CODEX_STUB_DIR = path.join(__dirname, '..', 'helpers', 'stub-codex');

let home;
let workspace;

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-pins-restart-home-'));
  workspace = makeWorkspace({ agents: standardTeam(), claudeMd: '# Pins restart\n' });
  fs.writeFileSync(path.join(workspace, 'Roadmap.md'), '# Roadmap\n');
  fs.mkdirSync(path.join(workspace, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'notes', 'backlog.md'), '- one\n');
});
after(() => { fs.rmSync(home, { recursive: true, force: true }); });

// Boot server.js as a child and resolve with its port, read from the banner.
function bootChild() {
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PATH: STUB_DIR + path.delimiter + CODEX_STUB_DIR + path.delimiter + process.env.PATH,
      PORT: '0', HOME: home, USERPROFILE: home, RUNDOCK_ELECTRON: '1', WORKSPACE: workspace,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const port = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no banner within ${BANNER_TIMEOUT_MS}ms:\n${out}`)), BANNER_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
      const m = /running at http:\/\/localhost:(\d+)/.exec(out);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.stderr.on('data', (chunk) => { out += chunk.toString(); });
    child.once('error', (err) => { clearTimeout(timer); reject(err); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited with ${code} before its banner:\n${out}`)); });
  });
  return { child, port };
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
  });
}

// A socket client that answers one question: what did the server reply to
// this message, of this type.
async function connect(port) {
  const WebSocket = require('ws');
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  const ask = (msg, type) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${type} reply to ${msg.type}`)), 8000);
    const onMessage = (data) => {
      const parsed = JSON.parse(data.toString());
      if (parsed.type !== type) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(parsed);
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify(msg));
  });
  return { ask, close: () => ws.close() };
}

test('a pin sent to one server is read back from the next one booted against the same HOME and workspace', async () => {
  const first = bootChild();
  let client;
  try {
    const port = await first.port;
    client = await connect(port);
    assert.deepStrictEqual((await client.ask({ type: 'get_pins' }, 'pins')).pins, [], 'a fresh HOME starts with no pins');
    assert.deepStrictEqual((await client.ask({ type: 'pin_file', path: 'notes/backlog.md' }, 'pins')).pins, ['notes/backlog.md']);
    assert.deepStrictEqual((await client.ask({ type: 'pin_file', path: 'Roadmap.md' }, 'pins')).pins, ['notes/backlog.md', 'Roadmap.md']);
    client.close();
  } finally {
    await stopChild(first.child);
  }

  const written = path.join(home, '.rundock-pins.json');
  assert.ok(fs.existsSync(written), 'the first server wrote no pins file under HOME');
  assert.ok(!fs.existsSync(path.join(workspace, '.rundock-pins.json')), 'the first server wrote pins under the workspace');

  const second = bootChild();
  try {
    const port = await second.port;
    client = await connect(port);
    assert.deepStrictEqual((await client.ask({ type: 'get_pins' }, 'pins')).pins, ['notes/backlog.md', 'Roadmap.md'],
      'the pins did not survive the restart, or came back in another order');
    assert.deepStrictEqual((await client.ask({ type: 'unpin_file', path: 'notes/backlog.md' }, 'pins')).pins, ['Roadmap.md']);
    client.close();
  } finally {
    await stopChild(second.child);
  }
});
