'use strict';
// Pins survive a server restart.
//
// THE REAL SERVER, TWICE, against one disposable workspace. The in-process
// harness boots server.js once per test file by design, and a restart is
// exactly the thing a single require cannot stage: module state survives it.
// So this file starts server.js as its own process, twice in sequence. A pin
// sent over the socket to the first server has to be read back over the
// socket from the second, with nothing in between but the file the store
// wrote at `.rundock/pins.json` inside that workspace.
//
// HOME IS STILL POINTED AT A DISPOSABLE DIRECTORY, and no longer because the
// pins live there. It is the e2e launcher's precedent, so that anything else
// the runtime writes to a home directory during the boot lands in the
// throwaway one rather than in the home of whoever ran the suite.
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

test('a pin sent to one server is read back from the next one booted against the same workspace', async () => {
  const first = bootChild();
  let client;
  try {
    const port = await first.port;
    client = await connect(port);
    assert.deepStrictEqual((await client.ask({ type: 'get_pins' }, 'pins')).pins, [], 'a fresh workspace starts with no pins');
    assert.deepStrictEqual((await client.ask({ type: 'pin_file', path: 'notes/backlog.md' }, 'pins')).pins, ['notes/backlog.md']);
    assert.deepStrictEqual((await client.ask({ type: 'pin_file', path: 'Roadmap.md' }, 'pins')).pins, ['notes/backlog.md', 'Roadmap.md']);
    client.close();
  } finally {
    await stopChild(first.child);
  }

  // The file is in the workspace now, not under HOME. Both halves are still
  // worth asserting: that something was actually written, and that it landed
  // in `.rundock/` rather than loose in the workspace where a reader's own
  // files are.
  const written = path.join(workspace, '.rundock', 'pins.json');
  assert.ok(fs.existsSync(written), 'the first server wrote no pins file in the workspace');
  assert.ok(!fs.existsSync(path.join(workspace, 'pins.json')), 'pins were written loose in the workspace root');
  // WHAT IS IN THE FILE IS pins-store.test.js's CLAIM, not this one. Reading it
  // here would duplicate that assertion and, because a test that opens a file
  // and compares its contents looks like a source-walking extraction, would
  // owe the enumerations registry an entry for a check that already exists
  // elsewhere. What only this file can prove is that a SECOND process reads
  // the first one's pins back, which is what follows.
  assert.ok(!fs.existsSync(path.join(home, '.rundock-pins.json')), 'pins were written under HOME, where nothing reads them now');

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
