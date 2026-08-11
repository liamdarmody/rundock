'use strict';
// lib/config.js owns the workspace root for extracted lib/ modules. Two
// contracts matter: reads see writes immediately (live state, read at use
// time), and server.js's mirror variable can never drift because every
// assignment there goes through the one helper that writes both.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const config = require('../../lib/config.js');

describe('lib/config workspace root', () => {
  test('setWorkspace is visible to the next getWorkspace call', () => {
    const prev = config.getWorkspace();
    config.setWorkspace('/tmp/rundock-config-test');
    assert.strictEqual(config.getWorkspace(), '/tmp/rundock-config-test');
    config.setWorkspace(null);
    assert.strictEqual(config.getWorkspace(), null);
    config.setWorkspace(prev);
  });

  test('seeds from process.env.WORKSPACE at load', () => {
    // Fresh process so the env is read at require time, not inherited state.
    const out = execFileSync(process.execPath, [
      '-e', "process.stdout.write(String(require('./lib/config.js').getWorkspace()))",
    ], { cwd: ROOT, env: { ...process.env, WORKSPACE: '/tmp/rundock-config-seed' } });
    assert.strictEqual(out.toString(), '/tmp/rundock-config-seed');
  });

  test('server.js mirror cannot drift: every assignment goes through setWorkspaceRoot', () => {
    // The root keeps a local WORKSPACE mirror while its read sites are
    // converted slice by slice. A bare assignment anywhere else would update
    // one copy and not the other; extracted modules would then operate on a
    // stale workspace. Allowed assignments: the declaration (seeded FROM
    // config) and the single helper body.
    const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf-8');
    const assignments = src.match(/^\s*(?:let )?WORKSPACE = .*$/gm) || [];
    assert.deepStrictEqual(assignments.map(s => s.trim()), [
      'let WORKSPACE = config.getWorkspace();',
      'WORKSPACE = dir;',
    ], 'assign the workspace root via setWorkspaceRoot(), never directly');
  });
});
