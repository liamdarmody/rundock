'use strict';
// Seams introduced by the signal-layer extraction: lib/signals.js owns the
// event writer, retention, the skill-usage sidecar, and docs-gap topic
// normalization. Contracts, matching the earlier extractions:
// 1. IDENTITY: _internal re-exports the module's own function objects, so the
//    existing signals.test.js pins keep driving the real implementation.
// 2. LIVE WORKSPACE: the events directory and the skill-usage sidecar are
//    resolved from getWorkspace() at use time, so signals always land in the
//    CURRENT workspace.
// Behavioral pins for the functions themselves stay in signals.test.js.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { _internal: srv } = require('../../server.js');
const signals = require('../../lib/signals.js');
const { makeWorkspace, cleanup } = require('../helpers/workspace.js');

after(cleanup);

async function waitFor(pred, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise(r => setTimeout(r, 25));
  }
  return pred();
}

function monthStamp(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

describe('lib/signals module seams', () => {
  test('_internal re-exports the module functions BY IDENTITY', () => {
    for (const name of ['recordEvent', 'bumpSkillUsage', 'normalizeDocsGapTopic']) {
      assert.strictEqual(srv[name], signals[name], `${name} must be the signals module's own function`);
    }
  });

  test('events land in the CURRENT workspace, resolved at use time', async () => {
    const dirA = makeWorkspace({});
    const dirB = makeWorkspace({});
    const eventsFile = (dir) => path.join(dir, '.rundock', 'state', `events-${monthStamp()}.jsonl`);
    const readNames = (dir) => fs.existsSync(eventsFile(dir))
      ? fs.readFileSync(eventsFile(dir), 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l).e)
      : [];
    srv.setWorkspace(dirA);
    signals.recordEvent('turn', { conv: 'seam-a', d: {} });
    assert.ok(await waitFor(() => readNames(dirA).includes('turn')), 'event recorded in workspace A');
    srv.setWorkspace(dirB);
    signals.recordEvent('handback', { conv: 'seam-b', d: {} });
    assert.ok(await waitFor(() => readNames(dirB).includes('handback')), 'event recorded in workspace B');
    assert.ok(!readNames(dirA).includes('handback'),
      'the second event followed the switch: nothing leaked into workspace A');
  });

  test('the skill-usage sidecar follows the workspace switch', () => {
    const dirA = makeWorkspace({});
    const dirB = makeWorkspace({});
    const sidecar = (dir) => path.join(dir, '.rundock', 'state', 'skill-usage.json');
    srv.setWorkspace(dirA);
    signals.bumpSkillUsage('demo-skill');
    assert.ok(fs.existsSync(sidecar(dirA)), 'sidecar written in workspace A');
    srv.setWorkspace(dirB);
    signals.bumpSkillUsage('demo-skill');
    const usageB = JSON.parse(fs.readFileSync(sidecar(dirB), 'utf-8'));
    assert.strictEqual(usageB['demo-skill'].useCount, 1,
      'workspace B starts its own count: the sidecar path resolved at use time');
    const usageA = JSON.parse(fs.readFileSync(sidecar(dirA), 'utf-8'));
    assert.strictEqual(usageA['demo-skill'].useCount, 1, 'workspace A count unchanged');
  });
});
