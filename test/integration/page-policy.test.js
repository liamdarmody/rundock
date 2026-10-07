'use strict';
// The app page's own Content-Security-Policy.
//
// The browser session token lives in the page's own storage, so a script that
// ever found its way into the page could read it. The policy keeps such a
// script from sending it anywhere the page itself does not talk to: the page
// connects only to its own server, embeds no plugins, cannot have its base
// address moved, submits no forms elsewhere, and frames only its own origin.
//
// It does not restrict which scripts run: the page's markup carries inline
// handlers, so `script-src 'self'` would stop the app working. Moving those
// handlers out is what that directive waits on.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('../helpers/harness.js');

before(async () => { await h.boot(); });
after(async () => h.shutdown());

function directives(header) {
  return Object.fromEntries(String(header || '').split(';').map((d) => d.trim()).filter(Boolean)
    .map((d) => { const [name, ...values] = d.split(/\s+/); return [name, values.join(' ')]; }));
}

for (const url of ['/', '/rundock-ui/gallery']) {
  test(`${url} names where the page may connect, embed, submit and frame`, async () => {
    const res = await fetch(`http://127.0.0.1:${h.port}${url}`);
    assert.strictEqual(res.status, 200);
    const d = directives(res.headers.get('content-security-policy'));
    assert.strictEqual(d['frame-src'], "'self'");
    assert.strictEqual(d['connect-src'], "'self'", 'fetch and the WebSocket reach only this server');
    assert.strictEqual(d['object-src'], "'none'");
    assert.strictEqual(d['base-uri'], "'none'");
    assert.strictEqual(d['form-action'], "'self'");
  });
}
