'use strict';
// The desktop app's server answers its own window's key and nothing a browser
// could hold: no session token, no cookie. Its window never has either, so
// accepting them would only give a program that writes the sessions file a
// way in. Each probe runs in a fresh process, so the setting cannot leak into
// the rest of the suite.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const AUTH = path.join(__dirname, '..', '..', 'lib', 'auth', 'index.js');

function probe(desktop) {
  const script = `
    const a = require(${JSON.stringify(AUTH)});
    a.setLinkPrinter(() => {});
    let token = null, media = null;
    a.exchangeCode(a.codeOf(a.signInLink(4300)), 4300, (t, m) => { token = t; media = m; });
    // Tokens a browser really holds, issued before the switch: the desktop
    // must refuse them, not merely never have made them.
    ${desktop ? 'a.setDesktopOnly(true);' : ''}
    const req = (headers, url = '/api/agents') => ({ headers: { host: 'localhost:4300', ...headers }, url, method: 'GET' });
    process.stdout.write(JSON.stringify({
      key: a.authenticate(req({ [a.KEY_HEADER]: a.launchKey() }), 4300),
      session: a.authenticate(req({ [a.SESSION_HEADER]: token }), 4300),
      protocol: a.authenticate(req({ 'sec-websocket-protocol': 'rundock, rundock.session.' + token }), 4300),
      media: a.authenticate(req({ cookie: media }, '/workspace-file?path=a.png'), 4300),
    }));`;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf-8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('in browser mode a session token and the media cookie are accepted where they apply', () => {
  assert.deepStrictEqual(probe(false), { key: true, session: true, protocol: true, media: true });
});

test('on the desktop only the window\'s key is accepted', () => {
  assert.deepStrictEqual(probe(true), { key: true, session: false, protocol: false, media: false });
});
