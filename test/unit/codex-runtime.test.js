'use strict';
// Unit tests for the Codex runtime adapter: line parsing, argv construction,
// binary/auth detection, and quota-error classification.
//
// Everything here is pure or dependency-injected; no processes are spawned
// and no real home directory is read.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const fx = require('../fixtures/codex-jsonl.js');
const codex = require('../../codex.js');

describe('parseCodexLine', () => {
  test('thread.started -> session event with thread id', () => {
    const ev = codex.parseCodexLine(JSON.stringify(fx.threadStarted('thr_abc123')));
    assert.deepStrictEqual(ev, { type: 'session', threadId: 'thr_abc123' });
  });

  test('item.completed agent_message -> text event', () => {
    const ev = codex.parseCodexLine(JSON.stringify(fx.agentMessage('Hello from Codex.')));
    assert.deepStrictEqual(ev, { type: 'text', text: 'Hello from Codex.' });
  });

  test('item.completed with a non-message item is skipped', () => {
    assert.strictEqual(codex.parseCodexLine(JSON.stringify(fx.otherItem())), null);
    assert.strictEqual(codex.parseCodexLine(JSON.stringify(fx.otherItem('reasoning'))), null);
  });

  test('turn.completed -> done event carrying normalised usage', () => {
    const ev = codex.parseCodexLine(JSON.stringify(fx.turnCompleted({ input: 1200, cached: 800, output: 340 })));
    assert.deepStrictEqual(ev, {
      type: 'done',
      usage: { inputTokens: 1200, cachedInputTokens: 800, outputTokens: 340 },
    });
  });

  test('turn.completed with missing usage fields still emits done with zeroed usage', () => {
    const ev = codex.parseCodexLine(JSON.stringify({ type: 'turn.completed' }));
    assert.deepStrictEqual(ev, {
      type: 'done',
      usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    });
  });

  test('turn.failed -> error event with the message', () => {
    const ev = codex.parseCodexLine(JSON.stringify(fx.turnFailed('sandbox denied write')));
    assert.deepStrictEqual(ev, { type: 'error', message: 'sandbox denied write' });
  });

  test('turn.failed without an error object falls back to a generic message', () => {
    const ev = codex.parseCodexLine(JSON.stringify({ type: 'turn.failed' }));
    assert.deepStrictEqual(ev, { type: 'error', message: 'Codex turn failed' });
  });

  test('bare error event -> error event', () => {
    const ev = codex.parseCodexLine(JSON.stringify(fx.bareError('boom')));
    assert.deepStrictEqual(ev, { type: 'error', message: 'boom' });
  });

  test('unknown event types are skipped', () => {
    assert.strictEqual(codex.parseCodexLine(JSON.stringify({ type: 'turn.started' })), null);
    assert.strictEqual(codex.parseCodexLine(JSON.stringify({ type: 'item.started', item: {} })), null);
  });

  test('malformed JSON, empty and whitespace lines are skipped, never throw', () => {
    assert.strictEqual(codex.parseCodexLine('{not json'), null);
    assert.strictEqual(codex.parseCodexLine(''), null);
    assert.strictEqual(codex.parseCodexLine('   '), null);
    assert.strictEqual(codex.parseCodexLine('null'), null);
    assert.strictEqual(codex.parseCodexLine('42'), null);
  });
});

describe('buildCodexArgs', () => {
  test('fresh turn: exec --json with sandbox, git check skipped, prompt on stdin', () => {
    assert.deepStrictEqual(codex.buildCodexArgs({}), [
      'exec', '--json',
      '--sandbox', 'workspace-write',
      '--skip-git-repo-check',
      '-',
    ]);
  });

  test('model flag only when a model is set', () => {
    assert.deepStrictEqual(codex.buildCodexArgs({ model: 'gpt-5.3-codex' }), [
      'exec', '--json',
      '--sandbox', 'workspace-write',
      '--skip-git-repo-check',
      '--model', 'gpt-5.3-codex',
      '-',
    ]);
  });

  test('resume turn: resume subcommand with the thread id', () => {
    assert.deepStrictEqual(codex.buildCodexArgs({ resumeThreadId: 'thr_abc123' }), [
      'exec', '--json',
      '--sandbox', 'workspace-write',
      '--skip-git-repo-check',
      'resume', 'thr_abc123',
      '-',
    ]);
  });

  test('never emits approval or sandbox bypass flags', () => {
    const variants = [
      codex.buildCodexArgs({}),
      codex.buildCodexArgs({ model: 'gpt-5.3-codex' }),
      codex.buildCodexArgs({ resumeThreadId: 'thr_x' }),
    ];
    for (const args of variants) {
      for (const a of args) {
        assert.ok(!/bypass|yolo|full-auto|dangerously/i.test(a), `forbidden flag in argv: ${a}`);
      }
    }
  });
});

describe('detectCodex', () => {
  const fakeDeps = (overrides = {}) => ({
    execSync: overrides.execSync || (() => { throw new Error('not found'); }),
    existsSync: overrides.existsSync || (() => false),
    homedir: overrides.homedir || (() => '/home/tester'),
    env: overrides.env || {},
    platform: overrides.platform || 'darwin',
  });

  test('not installed: binary lookup fails', () => {
    const d = codex.detectCodex(fakeDeps());
    assert.deepStrictEqual(d, { installed: false, authenticated: false, version: null });
  });

  test('installed but not signed in: binary found, no auth.json', () => {
    const d = codex.detectCodex(fakeDeps({
      execSync: (cmd) => {
        if (cmd.includes('--version')) return 'codex-cli 0.48.0\n';
        return '/usr/local/bin/codex\n';
      },
    }));
    assert.deepStrictEqual(d, { installed: true, authenticated: false, version: '0.48.0' });
  });

  test('signed in: auth.json present under the default home', () => {
    const d = codex.detectCodex(fakeDeps({
      execSync: (cmd) => cmd.includes('--version') ? 'codex-cli 0.48.0\n' : '/usr/local/bin/codex\n',
      existsSync: (p) => p === path.join('/home/tester', '.codex', 'auth.json'),
    }));
    assert.deepStrictEqual(d, { installed: true, authenticated: true, version: '0.48.0' });
  });

  test('CODEX_HOME overrides the default auth location', () => {
    const d = codex.detectCodex(fakeDeps({
      execSync: (cmd) => cmd.includes('--version') ? 'codex-cli 0.48.0\n' : '/usr/local/bin/codex\n',
      env: { CODEX_HOME: '/custom/codex-home' },
      existsSync: (p) => p === path.join('/custom/codex-home', 'auth.json'),
    }));
    assert.strictEqual(d.authenticated, true);
  });

  test('version parse tolerates unexpected output', () => {
    const d = codex.detectCodex(fakeDeps({
      execSync: (cmd) => cmd.includes('--version') ? 'something odd\n' : '/usr/local/bin/codex\n',
    }));
    assert.strictEqual(d.installed, true);
    assert.strictEqual(d.version, null);
  });
});

describe('resolveCodexBin', () => {
  test('unix: returns the trimmed which output', () => {
    const bin = codex.resolveCodexBin({
      platform: 'darwin',
      execSync: () => '/opt/homebrew/bin/codex\n',
    });
    assert.strictEqual(bin, '/opt/homebrew/bin/codex');
  });

  test('windows: prefers .exe over .cmd when both are present', () => {
    const bin = codex.resolveCodexBin({
      platform: 'win32',
      execSync: () => 'C:\\Users\\t\\AppData\\Roaming\\npm\\codex.cmd\r\nC:\\tools\\codex.exe\r\n',
    });
    assert.strictEqual(bin, 'C:\\tools\\codex.exe');
  });

  test('windows: npm ships only a .cmd shim; the absolute .cmd path is used (never shell: true)', () => {
    const bin = codex.resolveCodexBin({
      platform: 'win32',
      execSync: () => 'C:\\Users\\t\\AppData\\Roaming\\npm\\codex.cmd\r\n',
    });
    assert.strictEqual(bin, 'C:\\Users\\t\\AppData\\Roaming\\npm\\codex.cmd');
  });

  test('lookup failure returns the bare command so spawn surfaces ENOENT', () => {
    const bin = codex.resolveCodexBin({
      platform: 'darwin',
      execSync: () => { throw new Error('not found'); },
    });
    assert.strictEqual(bin, 'codex');
  });
});

describe('isCodexQuotaError', () => {
  test("recognises the CLI's usage-limit wording", () => {
    assert.strictEqual(codex.isCodexQuotaError(fx.QUOTA_MESSAGE), true);
    assert.strictEqual(codex.isCodexQuotaError('usage limit reached, resets 15:00'), true);
    assert.strictEqual(codex.isCodexQuotaError('You have hit your usage limit.'), true);
  });

  test('does not classify ordinary failures as quota', () => {
    assert.strictEqual(codex.isCodexQuotaError('sandbox denied write to /etc/hosts'), false);
    assert.strictEqual(codex.isCodexQuotaError('unknown thread thr_x'), false);
    assert.strictEqual(codex.isCodexQuotaError(''), false);
    assert.strictEqual(codex.isCodexQuotaError(null), false);
  });
});
