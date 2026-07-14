'use strict';
// Option F: write-request markers for Windows Codex agents.
// The Codex CLI cannot enforce its write sandbox on Windows (silent
// downgrade to read-only), so win32 Codex agents emit WRITE_FILE markers
// and Rundock performs the write itself after a permission card.
// Parser lives in codex.js; validation lives in server.js (_internal).
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const codex = require('../../codex.js');
const { _internal: srv } = require('../../server.js');
const { makeWorkspace, cleanup } = require('../helpers/workspace.js');

after(cleanup);

const MARKER = (p, c) => `<!-- RUNDOCK:WRITE_FILE path="${p}" -->\n${c}\n<!-- /RUNDOCK:WRITE_FILE -->`;

describe('parseWriteMarkers', () => {
  test('extracts a single request and substitutes a plain-language line', () => {
    const text = `I prepared the synthesis.\n\n${MARKER('Research Notes/Synthesis.md', '# Synthesis\n\nBody.')}\n\nDone describing.`;
    const { cleanText, requests } = codex.parseWriteMarkers(text);
    assert.strictEqual(requests.length, 1);
    assert.strictEqual(requests[0].path, 'Research Notes/Synthesis.md');
    assert.strictEqual(requests[0].content, '# Synthesis\n\nBody.');
    assert.ok(!cleanText.includes('RUNDOCK:WRITE_FILE'), 'marker stripped from display text');
    assert.ok(cleanText.includes('[write requested: Research Notes/Synthesis.md]'));
    assert.ok(cleanText.includes('I prepared the synthesis.'));
    assert.ok(cleanText.includes('Done describing.'));
  });

  test('extracts multiple requests in order', () => {
    const text = `${MARKER('a.md', 'A')}\nmiddle\n${MARKER('b.md', 'B')}`;
    const { requests } = codex.parseWriteMarkers(text);
    assert.deepStrictEqual(requests.map(r => r.path), ['a.md', 'b.md']);
    assert.deepStrictEqual(requests.map(r => r.content), ['A', 'B']);
  });

  test('content keeps interior blank lines and markdown exactly', () => {
    const body = '# Title\n\npara one\n\n- list\n- items\n';
    const { requests } = codex.parseWriteMarkers(MARKER('x.md', body));
    // Trailing newline inside the block is preserved minus the final separator
    assert.ok(requests[0].content.startsWith('# Title\n\npara one'));
    assert.ok(requests[0].content.includes('- items'));
  });

  test('text without markers passes through untouched', () => {
    const text = 'Nothing to see here.\nJust prose.';
    const out = codex.parseWriteMarkers(text);
    assert.strictEqual(out.cleanText, text);
    assert.deepStrictEqual(out.requests, []);
  });

  test('null/empty input is safe', () => {
    assert.deepStrictEqual(codex.parseWriteMarkers(''), { cleanText: '', requests: [] });
    assert.deepStrictEqual(codex.parseWriteMarkers(null), { cleanText: '', requests: [] });
  });
});

describe('hasWindowsSandboxConfig', () => {
  // Presence-only scan of the Codex config for a [windows] sandbox
  // declaration. When present, the CLI grants a real workspace-write policy
  // (in-process patch writes, workspace-bounded), so the write-marker
  // fallback stands down. Verified live: an unconfigured CLI silently
  // downgrades to read-only; a configured one writes directly.
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

describe('validateWriteRequest', () => {
  const ws = makeWorkspace({ claudeMd: '# x' });

  test('accepts a relative markdown path inside the workspace', () => {
    const v = srv.validateWriteRequest(ws, 'Research Notes/Synthesis.md', 'content', false);
    assert.strictEqual(v.ok, true);
    assert.strictEqual(v.fullPath, path.join(ws, 'Research Notes', 'Synthesis.md'));
  });

  test('rejects traversal and absolute paths without exception', () => {
    assert.strictEqual(srv.validateWriteRequest(ws, '../outside.md', 'x', false).ok, false);
    assert.strictEqual(srv.validateWriteRequest(ws, 'notes/../../outside.md', 'x', false).ok, false);
    assert.strictEqual(srv.validateWriteRequest(ws, path.join(ws, '..', 'abs.md'), 'x', false).ok, false);
    assert.strictEqual(srv.validateWriteRequest(ws, '/etc/hosts.md', 'x', false).ok, false);
  });

  test('knowledge mode enforces the supported file types; code mode does not', () => {
    assert.strictEqual(srv.validateWriteRequest(ws, 'notes/a.md', 'x', false).ok, true);
    assert.strictEqual(srv.validateWriteRequest(ws, 'data.yaml', 'x', false).ok, true);
    assert.strictEqual(srv.validateWriteRequest(ws, 'data.json', 'x', false).ok, true);
    assert.strictEqual(srv.validateWriteRequest(ws, 'plain.txt', 'x', false).ok, true);
    assert.strictEqual(srv.validateWriteRequest(ws, 'script.ps1', 'x', false).ok, false);
    assert.strictEqual(srv.validateWriteRequest(ws, 'tool.js', 'x', false).ok, false);
    assert.strictEqual(srv.validateWriteRequest(ws, 'tool.js', 'x', true).ok, true, 'code mode allows code files');
  });

  test('rejects oversized content and empty paths', () => {
    const big = 'x'.repeat(1024 * 1024 + 1);
    assert.strictEqual(srv.validateWriteRequest(ws, 'big.md', big, false).ok, false);
    assert.strictEqual(srv.validateWriteRequest(ws, '', 'x', false).ok, false);
    assert.strictEqual(srv.validateWriteRequest(ws, '   ', 'x', false).ok, false);
  });

  test('rejects writes into the managed .claude and .rundock directories', () => {
    assert.strictEqual(srv.validateWriteRequest(ws, '.claude/agents/evil.md', 'x', false).ok, false);
    assert.strictEqual(srv.validateWriteRequest(ws, '.rundock/state.json', 'x', false).ok, false);
  });

  test('managed-directory check is case-insensitive (Windows filesystems are)', () => {
    assert.strictEqual(srv.validateWriteRequest(ws, '.Claude/agents/evil.md', 'x', false).ok, false);
    assert.strictEqual(srv.validateWriteRequest(ws, '.RUNDOCK/state.json', 'x', false).ok, false);
    assert.strictEqual(srv.validateWriteRequest(ws, '.ClAuDe/skills/x.md', 'x', false).ok, false);
  });
});
