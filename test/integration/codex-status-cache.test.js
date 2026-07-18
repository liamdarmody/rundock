'use strict';
// Integration: codex detection caching on the runtime-status path (Windows
// VM Finding 5).
//
// getRuntimeStatus runs on the WebSocket handler path and detectCodex shells
// out (which/where + `codex --version`). On Windows the version probe hung
// against an open piped stdin (Finding 4) and burnt its full 5s timeout, so
// EVERY settings open re-blocked the event loop. The contract under test:
// the codex detection result is cached exactly like the claude probe (60
// seconds, and a cached "not installed" is never trusted, because a user who
// has just installed is exactly the user opening settings to check).
//
// Own file on purpose: node --test gives each file a fresh process, so the
// module-level detection cache in server.js starts cold and the call counts
// below are deterministic.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

const h = require('../helpers/harness.js');
const { standardTeam } = require('../helpers/workspace.js');

const codexModule = require('../../codex.js');
const realDetect = codexModule.detectCodex;

let client;
let calls = 0;
let fake = null; // when set, detectCodex returns this instead of probing

before(async () => {
  await h.boot({ agents: standardTeam() });
  client = await h.connect();
  // server.js calls codexRuntime.detectCodex() through the shared module
  // object, so patching the export intercepts every status probe.
  codexModule.detectCodex = (...args) => {
    calls += 1;
    return fake ? { ...fake } : realDetect(...args);
  };
});
after(async () => {
  codexModule.detectCodex = realDetect;
  await h.shutdown();
});

async function requestStatus() {
  const since = client.messages.length;
  client.send({ type: 'get_runtime_status' });
  const { msg } = await client.waitFor(m => m.type === 'runtime_status', { since, label: 'runtime_status' });
  return msg;
}

describe('codex detection cache on get_runtime_status', () => {
  test('a cached not-installed is never trusted: the next status request probes again', async () => {
    fake = { installed: false, authenticated: false, version: null };
    const first = await requestStatus();
    assert.strictEqual(first.codex.installed, false);
    assert.strictEqual(calls, 1, 'cold call probes');

    const second = await requestStatus();
    assert.strictEqual(second.codex.installed, false);
    assert.strictEqual(calls, 2, 'not-installed is re-probed every time');
  });

  test('an installed result is cached: repeat status requests within the window do not re-probe', async () => {
    fake = { installed: true, authenticated: false, version: '9.9.9-cache', windowsSandbox: null };
    const third = await requestStatus();
    assert.strictEqual(third.codex.installed, true);
    assert.strictEqual(third.codex.version, '9.9.9-cache');
    assert.strictEqual(calls, 3, 'first installed result comes from a probe');

    // The regression pin: pre-fix, every get_runtime_status ran a fresh
    // detectCodex (two execSync shell-outs on the WS handler path).
    const fourth = await requestStatus();
    assert.strictEqual(fourth.codex.installed, true);
    assert.strictEqual(fourth.codex.version, '9.9.9-cache', 'served from the cache');
    assert.strictEqual(calls, 3, 'no re-probe inside the 60s cache window');
  });
});
