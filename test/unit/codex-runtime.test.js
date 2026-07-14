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

  test('malformed thread ids are rejected: no flag smuggling through the resume positional', () => {
    // A hostile client-supplied session id must never reach argv.
    const hostile = codex.buildCodexArgs({ resumeThreadId: '--dangerously-bypass-approvals-and-sandbox' });
    assert.deepStrictEqual(hostile, ['exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-']);
    const spacey = codex.buildCodexArgs({ resumeThreadId: 'thr abc' });
    assert.ok(!spacey.includes('resume'), 'ids with spaces rejected');
    // Legitimate ids still resume.
    assert.ok(codex.buildCodexArgs({ resumeThreadId: 'cthr_01HXYZ.9-a' }).includes('resume'));
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
    assert.deepStrictEqual(d, { installed: true, authenticated: false, version: '0.48.0', windowsSandbox: null });
  });

  test('signed in: auth.json present under the default home', () => {
    const d = codex.detectCodex(fakeDeps({
      execSync: (cmd) => cmd.includes('--version') ? 'codex-cli 0.48.0\n' : '/usr/local/bin/codex\n',
      existsSync: (p) => p === path.join('/home/tester', '.codex', 'auth.json'),
    }));
    assert.deepStrictEqual(d, { installed: true, authenticated: true, version: '0.48.0', windowsSandbox: null });
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

describe('findCodexThreadFile', () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');

  test('resolves a thread id to its rollout file via the filename convention', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    const day = path.join(home, 'sessions', '2026', '07', '14');
    fs.mkdirSync(day, { recursive: true });
    const f = path.join(day, 'rollout-2026-07-14T10-00-00-019f0000-aaaa-7000-b000-c00000000001.jsonl');
    fs.writeFileSync(f, '');
    const hit = codex.findCodexThreadFile('019f0000-aaaa-7000-b000-c00000000001', { env: { CODEX_HOME: home } });
    assert.strictEqual(hit, f);
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('unknown thread ids and hostile ids resolve to null', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    assert.strictEqual(codex.findCodexThreadFile('019f0000-aaaa-7000-b000-c00000000002', { env: { CODEX_HOME: home } }), null);
    assert.strictEqual(codex.findCodexThreadFile('../../etc/passwd', { env: { CODEX_HOME: home } }), null, 'invalid ids never touch the filesystem shape');
    assert.strictEqual(codex.findCodexThreadFile('', { env: { CODEX_HOME: home } }), null);
    fs.rmSync(home, { recursive: true, force: true });
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

describe('classifyCodexError', () => {
  // Real message captured live: a ChatGPT account with an unavailable model
  // configured returns a raw invalid_request_error JSON blob.
  const MODEL_400 = '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.3-codex\' model is not supported when using Codex with a ChatGPT account."}}';
  // Real message captured live: logged-out CLI fails mid-connection with
  // reconnect/transport noise wrapping a 401.
  const AUTH_401 = 'Reconnecting... 2/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: wss://api.openai.com/v1/responses, cf-ray: a1ab5b883bdb63c9-LHR)';

  test('classifies an unavailable-model 400 and extracts the model name', () => {
    const c = codex.classifyCodexError(MODEL_400);
    assert.strictEqual(c.kind, 'model');
    assert.strictEqual(c.model, 'gpt-5.3-codex');
  });

  test('classifies model errors without an extractable name', () => {
    const c = codex.classifyCodexError('The requested model is not supported on this plan.');
    assert.strictEqual(c.kind, 'model');
    assert.strictEqual(c.model, null);
  });

  test('classifies signed-out transport failures as auth', () => {
    assert.strictEqual(codex.classifyCodexError(AUTH_401).kind, 'auth');
    assert.strictEqual(codex.classifyCodexError('Missing bearer or basic authentication in header').kind, 'auth');
    assert.strictEqual(codex.classifyCodexError('Error: not logged in. Please run codex login.').kind, 'auth');
  });

  test('classifies quota wording as quota (isCodexQuotaError agrees)', () => {
    assert.strictEqual(codex.classifyCodexError(fx.QUOTA_MESSAGE).kind, 'quota');
    assert.strictEqual(codex.isCodexQuotaError(fx.QUOTA_MESSAGE), true);
  });

  test('leaves ordinary failures unclassified', () => {
    assert.strictEqual(codex.classifyCodexError('sandbox denied write to /etc/hosts').kind, 'unknown');
    assert.strictEqual(codex.classifyCodexError('unknown thread thr_x').kind, 'unknown');
    assert.strictEqual(codex.classifyCodexError('').kind, 'unknown');
    assert.strictEqual(codex.classifyCodexError(null).kind, 'unknown');
  });

  test('a 400 mentioning 401-free auth words does not misclassify as model', () => {
    // Guard: auth match must not swallow model errors and vice versa.
    assert.strictEqual(codex.classifyCodexError(MODEL_400).kind, 'model');
    assert.strictEqual(codex.classifyCodexError(AUTH_401).kind, 'auth');
  });
});
