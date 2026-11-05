#!/usr/bin/env node
'use strict';
// WHETHER A ROUTINE RUN'S TOKEN REACHES THE HOOKS OF THE WORK THE RUN STARTS,
// MEASURED.
//
// A routine run is started with a hook token of its own in RUNDOCK_HOOK_TOKEN
// (lib/auth issueRunHookToken, passed by lib/runtime/claude.js getSpawnEnv),
// and the server files a card on the run only when the hook's request carries
// that token. A run can start work of its own: a subagent, through its Agent
// tool (Task, in older releases), and another `claude`, from its shell, which
// inherits the shell's environment. This runs the real, installed Claude Code
// and records which token, if any, each hook request carried, and which
// session it named. test/integration/routine-run-token.test.js holds the test
// stub to this record.
//
// THE CASES. A run that reads a file outside its workspace and then starts a
// general-purpose subagent, which reads another; a run that starts
// `claude -p` from its shell, and that claude reads a file outside the
// workspace; and the control, a run started with no token that reads one.
//
// HOW EACH CASE RUNS. In a fresh folder set up as a Notes-mode workspace is
// (in Code mode the hook approves every shell call without asking): its
// .claude/settings.local.json registers Rundock's real permission hook
// (scripts/permission-hook.js) for Bash through a launcher in .rundock, as
// lib/workspace/scaffold.js does. The real CLI is spawned with the arguments a
// routine is given there: getBareArgs (--add-dir and --settings), the Notes
// mode --disallowed-tools list, then routineArgv from
// claude-cli-agent-load-probe.js (held to the scheduler's own spawn by its
// unit test), with no --agent. Its environment is getSpawnEnv's
// for a routine run, carrying a token made for the case (none for the
// control), with RUNDOCK_PORT pointing at a stand-in for Rundock on
// 127.0.0.1 that records each hook request's token and body and answers
// allow. Then, as claude-cli-agent-load-probe.js does: its own empty home and
// config folders, a placeholder API key, and ANTHROPIC_BASE_URL pointed at a
// stand-in for the messages API on 127.0.0.1, which answers each turn with the
// case's tool calls. No account is used and no model is called. Every folder
// the case made is removed afterwards.
//
// WHAT IS RECORDED, per hook request: who asked (the run, the subagent, or the
// nested claude, told apart by the file the call reads), the token it carried
// (the run's, none, or another), and the session it named (the run's, another,
// or none). No token, session id or path is written.
//
// RUN BY HAND, NEVER BY THE SUITE OR CI: it needs a real Claude Code install,
// and it is not a *.test.js file, so `npm test` does not collect it.
//
//   node test/tools/claude-cli-run-token-probe.js           measure, compare with the record
//   node test/tools/claude-cli-run-token-probe.js --write   measure, and write the record
//
// CLAUDE_BIN names the binary; otherwise the `claude` on PATH. The test stub is
// refused. A record that would carry one of this machine's names is refused
// rather than written. Exits 0 when the measurement matches the record (or was
// written), 1 otherwise.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const config = require('../../lib/config.js');
const claudeRt = require('../../lib/runtime/claude.js');
const { NOTES_DISALLOWED_TOOLS } = require('../../lib/workspace/mode.js');
const { routineArgv, PROMPT } = require('./claude-cli-agent-load-probe.js');

const RECORD = path.join(__dirname, '..', 'fixtures', 'claude-cli-run-token.json');
const STUB_DIR = path.join(__dirname, '..', 'helpers', 'stub-claude');
const HOOK = path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');
const SUBAGENT_PROMPT = 'PROBE-SUBAGENT: read the subagent notes';
const NESTED_PROMPT = 'PROBE-NESTED: read the nested notes';
const CASE_TIMEOUT_MS = 180000;
// Who asked, by the file outside the workspace the call reads.
const READS = { 'run.md': 'the run', 'subagent.md': 'the subagent', 'nested.md': 'the nested claude' };

const CASES = [
  { name: 'a Task subagent started by the run', token: true, run: (o) => [read(o, 'run.md'), { tool: 'subagent', input: { description: 'Read the notes', prompt: SUBAGENT_PROMPT, subagent_type: 'general-purpose' } }] },
  { name: 'a claude started with -p from the run\'s shell', token: true, run: (o, bin) => [{ tool: 'Bash', input: { command: `"${bin}" -p "${NESTED_PROMPT}"`, description: 'probe' } }] },
  { name: 'the control: a run started with no token', token: false, run: (o) => [read(o, 'run.md')] },
];
function read(outside, file) {
  return { tool: 'Bash', input: { command: `cat "${path.join(outside, file)}"`, description: 'probe' } };
}

function resolveClaude() {
  const bin = process.env.CLAUDE_BIN || execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
  if (fs.realpathSync(bin).startsWith(fs.realpathSync(STUB_DIR))) {
    throw new Error('refusing to run: this resolves to the test stub, not to Claude Code');
  }
  return bin;
}

const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.map(b => (b && typeof b.text === 'string' ? b.text : '')).join('') : '');
const firstUserText = (json) => { const m = (json.messages || []).find(x => x && x.role === 'user'); return m ? textOf(m.content) : ''; };

// The stand-in for the messages API. A request offering tools is a turn of the
// run, the subagent or the nested claude, told apart by its first user
// message; each is answered with its next tool call, and once every call has
// a result, with text. Anything else gets a plain answer.
function standInApi(script) {
  const sse = (res, events) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const [type, data] of events) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    res.end();
  };
  const start = (id) => ['message_start', { message: { id, type: 'message', role: 'assistant', model: 'stand-in', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }];
  const text = (res, t) => sse(res, [
    start('msg_text'),
    ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: t } }],
    ['content_block_stop', { index: 0 }],
    ['message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', {}],
  ]);
  const seen = { turns: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body); } catch (e) { /* not JSON */ }
      if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{}'); }
      if (req.url.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ input_tokens: 1 })); }
      const first = firstUserText(json);
      const key = first.includes(SUBAGENT_PROMPT) ? 'subagent' : first.includes(NESTED_PROMPT) ? 'nested' : first.includes(PROMPT) ? 'run' : null;
      if (!key || !Array.isArray(json.tools) || json.tools.length === 0) return text(res, 'ok');
      seen.turns++;
      const steps = script[key] || [];
      const answered = new Set();
      for (const m of json.messages || []) {
        for (const b of Array.isArray(m.content) ? m.content : []) if (b.type === 'tool_result') answered.add(b.tool_use_id);
      }
      const next = steps.findIndex((s, i) => !answered.has(`toolu_${key}_${i}`));
      if (next === -1) return text(res, key === 'run' ? 'RUN STATUS: succeeded' : 'Done.');
      const step = steps[next];
      // The subagent tool by whichever name this release offers it under.
      const offered = json.tools.map(t => t.name);
      const name = step.tool === 'subagent' ? (offered.includes('Agent') ? 'Agent' : 'Task') : step.tool;
      return sse(res, [
        start(`msg_${key}_${next}`),
        ['content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_${key}_${next}`, name, input: {} } }],
        ['content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.input) } }],
        ['content_block_stop', { index: 0 }],
        ['message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } }],
        ['message_stop', {}],
      ]);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen })));
}

// The stand-in for Rundock: every hook request is recorded, its token header
// and its body, and answered allow so the case runs on.
function standInRundock() {
  const captured = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let json = null;
      try { json = JSON.parse(body); } catch (e) { /* kept as null */ }
      captured.push({ method: req.method, url: req.url, token: req.headers['x-rundock-hook-token'] || null, body: json });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(req.url === '/api/permission-request' ? JSON.stringify({ allow: true }) : '{}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, captured })));
}

// The workspace's settings, as the scaffold writes them for Bash: Rundock's
// own hook, run through a launcher in .rundock.
function writeWorkspace(dir) {
  fs.mkdirSync(path.join(dir, '.rundock'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.rundock', 'state.json'), '{"workspaceMode":"knowledge"}\n');
  const launcher = path.join(dir, '.rundock', 'permission-hook.sh');
  fs.writeFileSync(launcher, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${HOOK}" "$@"\n`);
  fs.chmodSync(launcher, 0o755);
  const entry = { matcher: 'Bash', hooks: [{ type: 'command', command: `sh "${launcher}"`, timeout: 300 }] };
  fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { PreToolUse: [entry] } }, null, 2));
}

// getSpawnEnv's environment for a routine run, with nothing of this machine's
// own Claude Code: its own home, its own config folder, and none of the
// variables that would point elsewhere.
function routineEnv(token, apiPort, home, configDir, tmp) {
  const env = {};
  for (const [k, v] of Object.entries(claudeRt.getSpawnEnv(null, token))) {
    if (!/^(CLAUDE|ANTHROPIC)/.test(k)) env[k] = v;
  }
  return {
    ...env,
    HOME: home,
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_API_KEY: 'placeholder-not-a-key',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${apiPort}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_TMPDIR: tmp,
  };
}

async function runCase(bin, c) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-run-token-probe-'));
  const [work, outside, home, configDir, tmp] = ['work', 'outside', 'home', 'config', 'tmp'].map(d => path.join(root, d));
  for (const d of [work, outside, home, configDir, tmp]) fs.mkdirSync(d, { recursive: true });
  const dir = fs.realpathSync(work);
  const out = fs.realpathSync(outside);
  for (const f of Object.keys(READS)) fs.writeFileSync(path.join(out, f), '# notes\n');
  writeWorkspace(dir);

  const rundock = await standInRundock();
  const api = await standInApi({ run: c.run(out, bin), subagent: [read(out, 'subagent.md')], nested: [read(out, 'nested.md')] });
  const token = c.token ? crypto.randomBytes(24).toString('base64url') : null;
  const sessionId = crypto.randomUUID();
  config.setWorkspace(dir);
  claudeRt.wireClaudeRuntimeDeps({ getActualPort: () => rundock.port });
  const argv = [...claudeRt.getBareArgs(), '--disallowed-tools', NOTES_DISALLOWED_TOOLS, ...routineArgv(dir, sessionId, null).slice(2)];

  const child = spawn(bin, argv, { cwd: dir, env: routineEnv(token, api.port, home, configDir, tmp), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.resume();
  child.stderr.resume();
  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('timeout'); }, CASE_TIMEOUT_MS);
    child.on('close', (code) => { clearTimeout(timer); resolve(code); });
  });
  api.server.close();
  rundock.server.close();

  const requests = rundock.captured.filter(r => r.method === 'POST' && r.url === '/api/permission-request').map((r) => {
    const command = String(r.body && r.body.tool_input && r.body.tool_input.command || '');
    const file = Object.keys(READS).find(f => command.includes(path.join(out, f)));
    const session = r.body && r.body.session_id;
    return {
      from: file ? READS[file] : (command.includes(NESTED_PROMPT) ? 'the run, starting claude' : 'the run, something else'),
      token: r.token === null ? 'none' : (r.token === token ? 'the run\'s' : 'another'),
      session: !session ? 'none' : (session === sessionId ? 'the run\'s' : 'another'),
    };
  });
  fs.rmSync(root, { recursive: true, force: true });
  return { exitCode, modelTurnsServed: api.seen.turns > 0, requests };
}

// Names of this machine that must never reach a committed file.
function leaks(text) {
  const names = [os.homedir(), os.tmpdir(), fs.realpathSync(os.tmpdir()), os.hostname(), os.userInfo().username]
    .filter(n => n && n.length > 2);
  const found = names.filter(n => text.includes(n));
  for (const re of [/\/Users\//, /\/home\//, /\/private\//, /\/tmp\//, /\/var\/folders\//, /[A-Z]:\\/, /[\u2013\u2014]/]) {
    if (re.test(text)) found.push(String(re));
  }
  return found;
}

async function main() {
  const write = process.argv.includes('--write');
  const bin = resolveClaude();
  // `claude --version` prints the version first: "2.1.318 (Claude Code)".
  const version = execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim().split(/\s+/)[0] || null;
  const cases = [];
  for (const c of CASES) {
    process.stderr.write(`[probe] ${c.name}\n`);
    cases.push({ name: c.name, token: c.token, observed: await runCase(bin, c) });
  }
  const record = {
    about: 'Which token each hook request carried, and which session it named, when a routine run started a subagent and a nested claude, measured by test/tools/claude-cli-run-token-probe.js. test/integration/routine-run-token.test.js holds the test stub to it.',
    claudeCode: version,
    method: 'The real CLI spawned as the scheduler spawns a routine in a Notes-mode workspace (getBareArgs: --add-dir and --settings; the Notes-mode --disallowed-tools list; then --print, --output-format stream-json, --verbose, --dangerously-skip-permissions, --append-system-prompt, --session-id, no --agent, the prompt last), with getSpawnEnv\'s environment for a routine run carrying a token made for the case, or none for the control. The workspace\'s .claude/settings.local.json registered Rundock\'s own permission hook for Bash through a launcher, as the scaffold does, and RUNDOCK_PORT pointed at a stand-in for Rundock on 127.0.0.1 that recorded each hook request and answered allow. Empty home and config folders, a placeholder API key, and a stand-in for the messages API on 127.0.0.1 that answered every turn with the case\'s tool calls. No account was used and no model was called. The nested claude was started from the Bash tool with -p and no other flag, so it had only what it inherited.',
    cases,
  };
  const body = `${JSON.stringify(record, null, 2)}\n`;
  const found = leaks(body);
  if (found.length) {
    process.stderr.write(`[probe] refusing: the record would carry ${found.join(', ')}\n`);
    process.exit(1);
  }
  if (write) {
    fs.writeFileSync(RECORD, body);
    process.stderr.write(`[probe] wrote ${path.relative(process.cwd(), RECORD)} for Claude Code ${version}\n`);
    return;
  }
  const committed = fs.existsSync(RECORD) ? JSON.parse(fs.readFileSync(RECORD, 'utf8')) : null;
  const same = committed && JSON.stringify(committed.cases) === JSON.stringify(record.cases);
  process.stderr.write(same
    ? `[probe] Claude Code ${version} matches the record (made with ${committed.claudeCode})\n`
    : `[probe] Claude Code ${version} differs from the record${committed ? ` (made with ${committed.claudeCode})` : ''}: run with --write and read the diff\n${JSON.stringify(record.cases, null, 2)}\n`);
  process.exit(same ? 0 : 1);
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`[probe] ${e.stack || e.message}\n`);
    process.exit(1);
  });
}
