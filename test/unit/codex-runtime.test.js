'use strict';
// Unit tests for the Codex runtime adapter: thread-id hygiene, binary/auth
// detection, failure classification, rollout resolution, and the Windows
// sandbox config scan. (Protocol-level behaviour lives in codex-appserver.js
// and its own test file.)
//
// Everything here is pure or dependency-injected; no processes are spawned
// and no real home directory is read.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { QUOTA_MESSAGE } = require('../fixtures/codex-appserver-protocol.js');
const codex = require('../../codex.js');

describe('isValidThreadId', () => {
  test('accepts UUIDs and historic exec-era ids', () => {
    assert.strictEqual(codex.isValidThreadId('019f0000-aaaa-7000-b000-c00000000001'), true);
    assert.strictEqual(codex.isValidThreadId('cthr_01HXYZ.9-a'), true);
  });

  test('rejects flag-shaped, spaced, empty and non-string ids', () => {
    // A hostile client-supplied session id must never be treated as a resume.
    assert.strictEqual(codex.isValidThreadId('--dangerously-bypass-approvals-and-sandbox'), false);
    assert.strictEqual(codex.isValidThreadId('thr abc'), false);
    assert.strictEqual(codex.isValidThreadId(''), false);
    assert.strictEqual(codex.isValidThreadId(null), false);
    assert.strictEqual(codex.isValidThreadId(42), false);
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

  test('every probe closes stdin (Windows Finding 4/5: codex --version hangs on an open piped stdin)', () => {
    // Verified live on Windows 11 / codex-cli 0.144.4: `codex.exe --version`
    // HANGS while stdin is an attached, never-closed pipe (execSync's
    // default) and returns instantly with stdin closed, so every probe burnt
    // its full 5s timeout and the first get_runtime_status blocked the event
    // loop ~13s. The probes must pass stdio ['ignore', 'pipe', 'ignore'].
    const calls = [];
    const d = codex.detectCodex(fakeDeps({
      execSync: (cmd, opts) => {
        calls.push({ cmd, opts });
        return cmd.includes('--version') ? 'codex-cli 0.48.0\n' : '/usr/local/bin/codex\n';
      },
    }));
    assert.strictEqual(d.installed, true);
    assert.ok(calls.length >= 2, 'lookup and version probes both ran');
    for (const { cmd, opts } of calls) {
      assert.deepStrictEqual(opts && opts.stdio, ['ignore', 'pipe', 'ignore'],
        `probe must close stdin (cmd: ${cmd})`);
    }
  });

  test('the second lookup probe (bare-command path) also closes stdin', () => {
    const calls = [];
    codex.detectCodex(fakeDeps({
      execSync: (cmd, opts) => { calls.push({ cmd, opts }); throw new Error('not found'); },
    }));
    assert.ok(calls.length >= 1);
    for (const { cmd, opts } of calls) {
      assert.deepStrictEqual(opts && opts.stdio, ['ignore', 'pipe', 'ignore'],
        `probe must close stdin (cmd: ${cmd})`);
    }
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

  test('the lookup probe closes stdin (Windows Finding 4/5)', () => {
    let seen = null;
    codex.resolveCodexBin({
      platform: 'win32',
      execSync: (cmd, opts) => { seen = opts; return 'C:\\tools\\codex.exe\r\n'; },
    });
    assert.deepStrictEqual(seen && seen.stdio, ['ignore', 'pipe', 'ignore'],
      'where.exe probe must close stdin');
  });
});

describe('isCodexQuotaError', () => {
  test("recognises the CLI's usage-limit wording", () => {
    assert.strictEqual(codex.isCodexQuotaError(QUOTA_MESSAGE), true);
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
    assert.strictEqual(codex.classifyCodexError(QUOTA_MESSAGE).kind, 'quota');
    assert.strictEqual(codex.isCodexQuotaError(QUOTA_MESSAGE), true);
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

describe('hasWindowsSandboxConfig', () => {
  // Presence-only scan of the Codex config for a [windows] sandbox
  // declaration. When present, the CLI grants a real workspace-write policy
  // on Windows and writes run silently inside the sandbox; when absent,
  // writes surface as per-action approval cards instead. Settings uses this
  // field to explain the difference and point at the one-line config fix.
  const withConfig = (content) => ({
    readFileSync: () => content,
    homedir: () => '/tmp/fake-home',
    env: {},
  });

  test('true when [windows] declares a sandbox', () => {
    assert.strictEqual(codex.hasWindowsSandboxConfig(withConfig('[windows]\nsandbox = "unelevated"\n')), true);
    assert.strictEqual(codex.hasWindowsSandboxConfig(withConfig('# comment\n\n[windows]\nsandbox = "elevated"\n\n[projects.x]\ntrust_level = "trusted"\n')), true);
  });

  test('false when [windows] exists without a sandbox key', () => {
    assert.strictEqual(codex.hasWindowsSandboxConfig(withConfig('[windows]\nsandbox_private_desktop = false\n')), false);
  });

  test('false when a sandbox key lives under a different section', () => {
    assert.strictEqual(codex.hasWindowsSandboxConfig(withConfig('[features]\nsandbox = "x"\n')), false);
    assert.strictEqual(codex.hasWindowsSandboxConfig(withConfig('sandbox_mode = "workspace-write"\n')), false);
  });

  test('false when the config file is missing or unreadable', () => {
    assert.strictEqual(codex.hasWindowsSandboxConfig({ readFileSync: () => { throw new Error('ENOENT'); }, homedir: () => '/x', env: {} }), false);
  });
});
