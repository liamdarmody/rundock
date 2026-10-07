'use strict';
// A link is printed when the person asks for one, and at no other time.
//
// A printed link is live until it is used or expires, and whatever reads the
// terminal, a service's journal or a multiplexer's scrollback can read it. So
// nothing a program can do over the network makes Rundock print one: not the
// status route a refused page calls, not a used link. The person asks, by
// starting Rundock or by pressing Enter in the terminal it runs in; a service
// prints one only when it starts. Each probe runs in a fresh process with the
// printer captured.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const AUTH = path.join(__dirname, '..', '..', 'lib', 'auth', 'index.js');

function probe(body) {
  const script = `
    const a = require(${JSON.stringify(AUTH)});
    const printed = [];
    a.setLinkPrinter((line) => printed.push(line));
    const realNow = Date.now;
    const later = (ms) => { Date.now = () => realNow() + ms; };
    const res = () => ({ writeHead() {}, end() {} });
    const req = (headers = {}) => ({ headers: { host: 'localhost:4400', ...headers }, url: '/api/auth/status', method: 'GET' });
    const out = {};
    (async () => {
      ${body}
      await new Promise((r) => setTimeout(r, 50));
      process.stdout.write(JSON.stringify({ ...out, printed: printed.length }));
      process.exit(0);
    })();`;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf-8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('a refused page asking whether it is let in never makes a link appear, even after the last has expired', () => {
  const r = probe(`
    a.announceLink(4400);
    later(a.CODE_TTL_MS + 60000);
    for (let i = 0; i < 5; i++) a.sessionStatus(req(), res(), 4400);`);
  assert.strictEqual(r.printed, 1, 'only the link printed at start');
});

test('using a link does not print the next one', () => {
  const r = probe(`
    a.announceLink(4400);
    out.ok = !!a.exchangeCode(a.codeOf(a.signInLink(4400)), 4400);`);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.printed, 1);
});

test('the person asking in the terminal gets a fresh link, at most one a second', () => {
  const r = probe(`
    const { PassThrough } = require('node:stream');
    const input = new PassThrough();
    a.listenForLinkRequests(input, 4400);
    a.announceLink(4400);
    const first = a.codeOf(a.signInLink(4400));
    a.exchangeCode(first, 4400);
    later(2000);
    input.write('\\n');
    await new Promise((r) => setTimeout(r, 20));
    input.write('\\n');
    out.fresh = a.codeOf(a.signInLink(4400)) !== first;`);
  assert.strictEqual(r.printed, 2, 'the start link and one answer to two quick presses');
  assert.strictEqual(r.fresh, true);
});

test('asking for a new link retires the one printed before, unused or not', () => {
  const r = probe(`
    const { PassThrough } = require('node:stream');
    const input = new PassThrough();
    a.listenForLinkRequests(input, 4400);
    a.announceLink(4400);
    const old = a.codeOf(a.signInLink(4400));
    later(2000);
    input.write('\\n');
    await new Promise((r) => setTimeout(r, 20));
    out.oldStillGood = !!a.exchangeCode(old, 4400);`);
  assert.strictEqual(r.printed, 2);
  assert.strictEqual(r.oldStillGood, false);
});

test('the desktop app never prints a link', () => {
  const r = probe(`
    a.setDesktopOnly(true);
    a.announceLink(4400);
    a.sessionStatus(req(), res(), 4400);`);
  assert.strictEqual(r.printed, 0);
});
