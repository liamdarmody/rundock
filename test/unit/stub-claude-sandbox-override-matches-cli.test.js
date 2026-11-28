'use strict';
// THE STUB `claude` TREATS A COMMAND OUTSIDE THE SANDBOX AS THE INSTALLED
// CLAUDE CODE DID, CASE BY CASE.
//
// Every test of a command run outside the sandbox runs on the stub, so what the
// stub runs, refuses and asks is what those tests prove.
// test/fixtures/claude-cli-sandbox-override.json is what the real CLI did in
// the same cases, measured by test/tools/claude-cli-sandbox-override-probe.js
// (run by hand on macOS: it needs a real install, and a stand-in for the API,
// so no account is used). This runs the stub through each recorded case, in
// the same spawn shape with the same settings, and holds it to the record: the
// call refused or run, in the same words; the command run as many times; the
// same hooks asked, in the same order, about the same call; the
// PermissionRequest payload carrying the same keys; and the same system lines,
// each naming its call.
//
// When the CLI changes, the probe is run again and its record replaces this
// fixture; any case the stub then answers differently fails here, by name.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeTempDir, cleanup } = require('../helpers/workspace.js');
const { NOTES_DISALLOWED_TOOLS } = require('../../lib/workspace/mode.js');
const probe = require('../tools/claude-cli-sandbox-override-probe.js');

after(cleanup);

const RECORD_FILE = path.join(__dirname, '..', 'fixtures', 'claude-cli-sandbox-override.json');
const RECORD = JSON.parse(fs.readFileSync(RECORD_FILE, 'utf8'));
const STUB = path.join(__dirname, '..', 'helpers', 'stub-claude', 'claude');
const PROMPT = 'do the work';
const SETTINGS_SLOT = '<the case\'s settings>';
// The stub keeps its session files under $HOME, so it gets its own.
const HOME = makeTempDir('rundock-stub-sandbox-cli-home-');

// A recording hook, as the probe's: one shared log, in call order, each call
// written as the settings entry that ran it, then the payload as given, then
// an end line. It prints the entry's answer. Run by Node, with no shell.
function recordingHook(aux, log, entry, answer) {
  const file = path.join(aux, `${entry}.js`);
  fs.writeFileSync(file, `let s = '';
process.stdin.on('data', d => { s += d; });
process.stdin.on('end', () => {
  require('fs').appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(entry)} + '\\n' + s + '\\n' + ${JSON.stringify(probe.END_OF_CALL)} + '\\n');
  process.stdout.write(${JSON.stringify(answer)} + '\\n');
});
`);
  return { matcher: RECORD.settings.matcher, hooks: [{ type: 'command', command: `"${process.execPath}" "${file}"` }] };
}

// One recorded case, run on the stub in the record's spawn shape, and read
// back the way the probe read the CLI's run. `asked` adds fields to the
// stub's call, as a scenario sets them.
function runStub(c, asked = {}) {
  const dir = makeTempDir('rundock-stub-sandbox-cli-');
  const [work, aux, home, tmp] = ['work', 'aux', 'home', 'tmp'].map(d => path.join(dir, d));
  for (const d of [work, aux, home, tmp]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(work, 'stub-scenario.json'), JSON.stringify({
    rules: [{ match: {}, hooks: [{ tool: 'Bash', input: c.input, ...asked }], turn: [{ text: 'done' }] }],
  }));
  const log = path.join(aux, 'hook-calls.log');
  const hooks = { PreToolUse: [recordingHook(aux, log, 'PreToolUse', RECORD.settings.preToolUseAnswer)] };
  if (c.permissionRequest !== null) hooks.PermissionRequest = [recordingHook(aux, log, 'PermissionRequest', c.permissionRequest)];
  const settings = { sandbox: probe.knowledgeBlock(work, home, tmp), hooks };
  const argv = RECORD.conversation.args.map(a => (a === SETTINGS_SLOT ? JSON.stringify(settings) : a));
  const input = `${JSON.stringify({ type: 'user', message: { role: 'user', content: PROMPT } })}\n`;
  const r = spawnSync(process.execPath, [STUB, ...argv], { cwd: work, env: { ...process.env, HOME }, input, encoding: 'utf8', timeout: 20000 });

  const scrub = probe.scrubber([work, aux, home, tmp, dir]);
  const lines = String(r.stdout || '').split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
    .filter(l => l && typeof l === 'object');
  const starts = lines
    .filter(l => l.type === 'stream_event' && l.event && l.event.type === 'content_block_start')
    .map(l => l.event.content_block)
    .filter(b => b && b.type === 'tool_use');
  const callId = starts.length === 1 ? starts[0].id : null;
  const textOf = (content) => (typeof content === 'string' ? content
    : Array.isArray(content) ? content.map(b => (b && typeof b.text === 'string' ? b.text : '')).join('') : '');
  return {
    status: r.status,
    stderr: String(r.stderr || ''),
    calls: starts.map(b => b.name),
    results: lines
      .filter(l => l.type === 'user' && l.message && Array.isArray(l.message.content))
      .flatMap(l => l.message.content.filter(b => b && b.type === 'tool_result'))
      .map(b => ({ toolUseIdMatches: callId !== null && b.tool_use_id === callId, refused: b.is_error === true, text: scrub(textOf(b.content)) })),
    markerLines: probe.markerLines(path.join(work, 'marker.txt')),
    hooksAsked: probe.readHookCalls(log, scrub),
    systemLines: lines
      .filter(l => l.type === 'system' && l.subtype !== 'init')
      .map(l => ({ keys: Object.keys(l).sort(), line: probe.idFree(l, scrub, callId) })),
  };
}

// What is held of each hook call: the entry that ran it, the event, tool,
// command and flag it was given, and the keys of the call's input; for a
// PermissionRequest call, the payload's own keys as well. The stub gives a
// PreToolUse hook only what Rundock's hook reads of it, so that payload's
// other keys are not held.
function hookView(h) {
  return {
    entry: h.entry, event: h.event, tool: h.tool, command: h.command, flag: h.flag, inputKeys: h.inputKeys,
    ...(h.event === 'PermissionRequest' ? { keys: h.keys } : {}),
  };
}

// Claude Code writes `status` lines around each request to the API, naming
// no call. The stub does not write them, and they are left out on both sides.
const notStatus = (s) => s.line.subtype !== 'status';

describe('the record', () => {
  test('names the Claude Code version it measured', () => {
    assert.ok(/^\d+\.\d+\.\d+$/.test(RECORD.claudeCode), `a version: ${RECORD.claudeCode}`);
  });

  test('holds no path from the machine it ran on', () => {
    const text = fs.readFileSync(RECORD_FILE, 'utf8');
    for (const re of [/\/Users\//, /\/home\//, /\/private\//, /\/tmp\//, /\/var\/folders\//, /[A-Z]:\\\\/, /[\u2013\u2014]/]) {
      assert.doesNotMatch(text, re);
    }
  });

  test('ran its cases with the permission mode, allowed tools and Notes-mode disallowed tools a conversation is spawned with', () => {
    const { _internal: srv } = require('../../server.js');
    assert.strictEqual(RECORD.conversation.permissionMode, srv.getPermissionMode());
    assert.strictEqual(RECORD.conversation.allowedTools, srv.getAllowedToolsInteractive());
    assert.strictEqual(RECORD.conversation.disallowedTools, srv.DISALLOWED_TOOLS_KNOWLEDGE);
    assert.strictEqual(RECORD.conversation.disallowedTools, NOTES_DISALLOWED_TOOLS);
    assert.deepStrictEqual(RECORD.conversation.args,
      [...probe.ISOLATION_ARGS, '--settings', SETTINGS_SLOT, ...probe.conversationArgs(probe.conversationShape()), '--max-turns', '3'],
      'the spawn has changed since the CLI was measured: run node test/tools/claude-cli-sandbox-override-probe.js --write on macOS');
  });

  // The conversation spawn in server.js is built inline, so its fixed words are
  // read from the source: the record's arguments must be the same words in the
  // same order, less the system prompt, which no case needs.
  test('ran its cases with the words server.js spawns a conversation with, in the same order', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
    const spawns = [...src.matchAll(/const args = \[([\s\S]*?)\];/g)].map(m => m[1])
      .filter(body => body.includes('\'--input-format\'') && !body.includes('\'--print\''));
    assert.strictEqual(spawns.length, 1, 'one conversation spawn in server.js');
    const words = [...spawns[0].matchAll(/'([^'\n]*)'/g)].map(m => m[1]).filter(w => w !== '--append-system-prompt');
    const valued = new Set(['--permission-mode', '--allowed-tools', '--disallowed-tools']);
    const fixed = probe.conversationArgs(probe.conversationShape()).filter((a, i, all) => !valued.has(all[i - 1]));
    assert.deepStrictEqual(words, fixed);
  });

  test('gave its hooks the matcher the scaffold writes for its PermissionRequest entry, and the PreToolUse answer of an approved card', () => {
    const scaffold = require('../../lib/workspace/scaffold.js');
    const dir = makeTempDir('rundock-stub-sandbox-cli-scaffold-');
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.rundock'), { recursive: true });
    const prev = scaffold.wireScaffoldDeps({ invalidateAgentCache() {}, rebaselineAgentsWatcher() {} });
    try {
      scaffold.scaffoldWorkspace(dir, { platform: 'darwin' });
    } finally {
      scaffold.wireScaffoldDeps(prev);
    }
    const written = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf8'));
    const ours = (written.hooks.PermissionRequest || [])
      .filter(e => (e.hooks || []).some(h => typeof h.command === 'string' && h.command.includes('permission-hook')));
    assert.deepStrictEqual(ours.map(e => e.matcher), [RECORD.settings.matcher]);
    assert.strictEqual(RECORD.settings.matcher, probe.MATCHER);
    assert.strictEqual(RECORD.settings.preToolUseAnswer, probe.PRE_TOOL_USE_ALLOW);
  });

  // The digest is over the block's paths with the repository among them; on a
  // host whose paths are not written with forward slashes the repository
  // cannot be written as its token, so only the rest is compared there.
  test('carried the sandbox block the scaffold builds for a Knowledge-mode workspace today', () => {
    const now = probe.describeSandbox();
    const was = RECORD.settings.sandbox;
    assert.strictEqual(was.built, now.built);
    assert.deepStrictEqual(was.settings, now.settings);
    assert.deepStrictEqual(was.filesystemEntries, now.filesystemEntries);
    if (path.sep === '/') {
      assert.strictEqual(was.sha256, now.sha256,
        'the sandbox block has changed since the CLI was measured: run node test/tools/claude-cli-sandbox-override-probe.js --write on macOS');
    }
  });

  test('ran the cases the probe states', () => {
    const view = c => ({ name: c.name, input: c.input, permissionRequest: c.permissionRequest, control: !!c.control });
    assert.deepStrictEqual(RECORD.cases.map(view), probe.CASES.map(view));
  });

  test('saw no tool id on a status line, so leaving those lines out drops no call', () => {
    const status = RECORD.cases.flatMap(c => c.observed.systemLines).filter(s => !notStatus(s));
    assert.ok(status.length > 0);
    for (const s of status) {
      assert.ok(!s.keys.includes('tool_use_id'), JSON.stringify(s));
      assert.ok(!Object.keys(s.line).some(k => k.endsWith('Matches')), JSON.stringify(s));
    }
  });
});

describe('the stub treats each recorded command outside the sandbox as the CLI did', () => {
  for (const c of RECORD.cases.filter(k => !k.control)) {
    test(c.name, () => {
      const run = runStub(c);
      const seen = c.observed;
      assert.strictEqual(run.status, seen.exitCode, `the run ends as the CLI's did: ${run.stderr}`);
      assert.deepStrictEqual(run.calls, ['Bash'], 'one call, the case\'s');
      assert.deepStrictEqual(run.results, seen.results, 'refused or run, in the CLI\'s words, under the call\'s id');
      assert.strictEqual(run.markerLines, seen.markerLines, 'the command ran as many times as it did under the CLI');
      assert.deepStrictEqual(run.hooksAsked.map(hookView), seen.hooksAsked.map(hookView), 'the same hooks asked, in order, about the same call');
      assert.deepStrictEqual(run.systemLines.filter(notStatus), seen.systemLines.filter(notStatus), 'the same system lines, each naming its call');
    });
  }

  // The control's own run, inside the sandbox, is not the stub's to model: a
  // call without the flag reaches no check of Claude Code's, and runs as any
  // other sandboxed call. What is held is what bears on the check: only the
  // PreToolUse hook is asked about it, and nothing refuses it.
  for (const c of RECORD.cases.filter(k => k.control)) {
    test(c.name, () => {
      const run = runStub(c);
      const seen = c.observed;
      assert.strictEqual(run.status, seen.exitCode, `the run ends as the CLI's did: ${run.stderr}`);
      assert.deepStrictEqual(run.hooksAsked.map(hookView), seen.hooksAsked.map(hookView), 'only the PreToolUse hook is asked');
      assert.ok(seen.results.every(r => !r.refused), 'the CLI refused nothing');
      assert.ok(run.results.every(r => !r.refused), 'the stub refuses nothing');
      assert.deepStrictEqual(run.systemLines.filter(notStatus), seen.systemLines.filter(notStatus), 'no line says it was refused');
    });

    // Nor does the stub put the same call to the check when a scenario says
    // it reached the check with no card of its own, unless the scenario also
    // says it goes beyond what Claude Code does.
    test('the control\'s call, put to the check with no card of its own, is not modelled', () => {
      const run = runStub(c, { noCard: true });
      assert.strictEqual(run.status, 2, `the stub stops: ${run.stderr}`);
      assert.match(run.stderr, /a call without dangerouslyDisableSandbox put to the PermissionRequest check, which Claude Code never asks about is not modelled/);
    });
  }
});
