#!/usr/bin/env node
'use strict';
// WHAT THE INSTALLED CLAUDE CODE DOES WITH A SHELL CALL OUTSIDE ITS SANDBOX, MEASURED.
//
// A Bash or PowerShell call with `dangerouslyDisableSandbox: true` meets a
// second check in Claude Code after the PreToolUse hooks have answered. The
// suite proves Rundock's answer to that check on the stub `claude`, so the
// stub's model of the exchange is the thing those tests rest on. This runs the
// real, installed Claude Code through the cases below and records what it did:
// which hooks it asked, in what order and with what payload, whether the
// command ran, what the tool result said, and every system line it wrote. So
// the model is held to a measurement rather than to a reading of the CLI's
// documentation. test/unit/stub-claude-sandbox-override-matches-cli.test.js
// holds the stub to the record this writes.
//
// HOW EACH CASE RUNS. The real CLI, spawned as server.js spawns a conversation
// (stream-json in and out, --include-partial-messages, and the permission mode,
// allowed tools and Notes-mode disallowed tools the server passes), in a fresh
// empty folder, with its own empty home folder, a placeholder API key, and
// ANTHROPIC_BASE_URL pointed at a stand-in for the messages API on 127.0.0.1.
// The stand-in asks for one Bash call, `echo ran>>marker.txt`, and records the
// tool result the CLI sends back. No account is used and no model is called.
// User, project and local settings, plugins and MCP servers are kept out
// (--setting-sources "", --strict-mcp-config), and the one --settings value is
// the case's own: the sandbox block Rundock writes for a Knowledge-mode
// workspace on macOS (sandboxSettings in lib/workspace/scaffold.js), built for
// the case's folders; a PreToolUse hook for Bash|PowerShell that answers allow,
// as Rundock's hook does once a card is approved; and, where the case has one,
// a PermissionRequest hook for Bash|PowerShell that gives the case's answer.
// Both hooks are sh scripts that record what they were asked. Afterwards the
// marker file's lines are counted: one line is one run of the command.
//
// THE CONTROL. One case runs the same command without the flag, inside the
// sandbox. If it does not run and leave one marker line, the CLI could not run
// a sandboxed command (as when this runs inside another sandbox), so nothing
// else it measured means anything, and nothing is written. The control shows
// that the command ran; it does not show that Claude Code's sandbox (Seatbelt,
// on macOS) was on while it ran.
//
// RUN BY HAND, ON macOS, NEVER BY THE SUITE OR CI: it needs a real Claude Code
// install and the operating system's sandbox, and it is not a *.test.js file,
// so `npm test` does not collect it. Run it from a terminal that is not itself
// sandboxed.
//
//   node test/tools/claude-cli-sandbox-override-probe.js           measure, compare with the record
//   node test/tools/claude-cli-sandbox-override-probe.js --write   measure, and write the record
//
// CLAUDE_BIN names the binary; otherwise the `claude` on PATH. The test stub is
// refused. The record holds no path, id, user or machine name: paths are
// written relative to the case's folder, an id that names the call is written
// as whether it matched the call, other ids are left out, and a record that
// would carry one of this machine's names is refused rather than written.
// Exits 0 when the measurement matches the record (or was written), 1
// otherwise.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { NOTES_DISALLOWED_TOOLS } = require('../../lib/workspace/mode.js');
const { sandboxSettings, tempRoots } = require('../../lib/workspace/scaffold.js');

const RECORD = path.join(__dirname, '..', 'fixtures', 'claude-cli-sandbox-override.json');
const STUB_DIR = path.join(__dirname, '..', 'helpers', 'stub-claude');
const REPO = path.resolve(__dirname, '..', '..');
const PROMPT = 'do the work';
const CASE_TIMEOUT_MS = 120000;

// The one call each case makes, and the id the stand-in gives it.
const CALL_ID = 'toolu_probe_0';
const COMMAND = 'echo ran>>marker.txt';
const FLAG = 'dangerouslyDisableSandbox';
function bashInput(flag) {
  const input = { command: COMMAND, description: 'probe' };
  if (flag !== undefined) input[FLAG] = flag;
  return input;
}

// The matcher Rundock's scaffold writes for its PermissionRequest entry, used
// for both entries here.
const MATCHER = 'Bash|PowerShell';
// What Rundock's PreToolUse hook prints once a person approves the card.
const PRE_TOOL_USE_ALLOW = '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"Approved in Rundock"}}';
// What Rundock's PermissionRequest branch prints when it spends a grant
// (SANDBOX_OVERRIDE_ALLOW in scripts/permission-hook.js), byte for byte.
const PERMISSION_REQUEST_ALLOW = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}';
// What it prints for anything else: no decision.
const NO_DECISION = '{}';

// The cases. Each is one CLI run making one Bash call with `input`.
// `permissionRequest` is the exact text the PermissionRequest hook prints, or
// null for no PermissionRequest entry at all. The control's hook gives no
// decision, as Rundock's does for a call without the flag.
const CASES = [
  {
    name: 'a sandbox-off call, no PermissionRequest entry',
    input: bashInput(true), permissionRequest: null,
  },
  {
    name: 'a sandbox-off call, the PermissionRequest hook answering allow as Rundock\'s does',
    input: bashInput(true), permissionRequest: PERMISSION_REQUEST_ALLOW,
  },
  {
    name: 'a sandbox-off call, the PermissionRequest hook giving no decision',
    input: bashInput(true), permissionRequest: NO_DECISION,
  },
  {
    name: 'the control: the same call without the flag, inside the sandbox, the PermissionRequest entry present',
    input: bashInput(), permissionRequest: NO_DECISION, control: true,
  },
  {
    name: 'the flag given as the string "true", the PermissionRequest hook answering allow',
    input: bashInput('true'), permissionRequest: PERMISSION_REQUEST_ALLOW,
  },
];

// A conversation's spawn, as server.js builds it today, read from the server
// rather than copied. The disallowed list is the one a Knowledge-mode (Notes)
// workspace's spawn carries, the mode whose sandbox block this measures.
function conversationShape() {
  const srv = require('../../server.js')._internal;
  return {
    permissionMode: srv.getPermissionMode(),
    allowedTools: srv.getAllowedToolsInteractive(),
    disallowedTools: NOTES_DISALLOWED_TOOLS,
  };
}

function conversationArgs(shape) {
  return ['--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--permission-mode', shape.permissionMode, '--allowed-tools', shape.allowedTools, '--disallowed-tools', shape.disallowedTools];
}
const ISOLATION_ARGS = ['--setting-sources', '', '--strict-mcp-config', '--no-chrome', '--no-session-persistence'];

// THE SANDBOX BLOCK. Rundock's Knowledge-mode block for a workspace on macOS,
// built for the given folders with no extra working folders and no moved
// runtime home. Three variables of the machine running this would change the
// block's deny list (ZDOTDIR and XDG_CONFIG_HOME move or add shell startup
// entries, RUNDOCK_ELECTRON moves the startup-file record), so they are set
// aside while it is built, and the block is the same on every machine.
const MACHINE_VARS = ['ZDOTDIR', 'XDG_CONFIG_HOME', 'RUNDOCK_ELECTRON'];
function knowledgeBlock(work, home, tmp) {
  const saved = {};
  for (const k of MACHINE_VARS) {
    if (Object.prototype.hasOwnProperty.call(process.env, k)) { saved[k] = process.env[k]; delete process.env[k]; }
  }
  try {
    return sandboxSettings(work, 'darwin', home, tempRoots(tmp), [], 'knowledge', []);
  } finally {
    Object.assign(process.env, saved);
  }
}

function tokenize(text, pairs) {
  return pairs.slice().sort((a, b) => b[0].length - a[0].length)
    .reduce((out, [from, to]) => out.split(from).join(to), text);
}
function repoPairs() {
  return [...new Set([REPO, fs.realpathSync(REPO)])].map(p => [p, '<repo>']);
}
// The block with its folders written as <work>, <home>, <tmp> and <repo>, as
// one string: what every case's block must equal once its own folders are
// written that way, and what the record's digest is taken over.
function canonicalSandboxText() {
  return tokenize(JSON.stringify(knowledgeBlock('<work>', '<home>', '<tmp>')), repoPairs());
}
// What the record says of the block. Its lists carry fixed runtime paths that
// a committed file must not, so the record keeps the settings beside them, the
// length of each list, and a digest of the whole block in its token form.
function describeSandbox() {
  const block = knowledgeBlock('<work>', '<home>', '<tmp>');
  const settings = {};
  for (const [k, v] of Object.entries(block)) if (k !== 'filesystem') settings[k] = v;
  const filesystemEntries = {};
  for (const [k, v] of Object.entries(block.filesystem || {})) filesystemEntries[k] = v.length;
  return {
    built: 'sandboxSettings(<work>, \'darwin\', <home>, tempRoots(<tmp>), [], \'knowledge\', []) from lib/workspace/scaffold.js, with ZDOTDIR, XDG_CONFIG_HOME and RUNDOCK_ELECTRON unset while it was built; every case passed it as the `sandbox` key of its --settings value, with the case\'s own folders in place of the tokens. The digest is sha256 over JSON.stringify of the block with its folders written as <work>, <home>, <tmp> and <repo> (the repository root).',
    settings,
    filesystemEntries,
    sha256: crypto.createHash('sha256').update(canonicalSandboxText()).digest('hex'),
  };
}

function resolveClaude() {
  const bin = process.env.CLAUDE_BIN || execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
  if (fs.realpathSync(bin).startsWith(fs.realpathSync(STUB_DIR))) {
    throw new Error('refusing to run: this resolves to the test stub, not to Claude Code');
  }
  return bin;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(b => (b && typeof b.text === 'string' ? b.text : '')).join('');
  return '';
}

// The stand-in for the messages API. The main loop (a request that offers
// tools) is answered with the next tool call, and once every call has a
// result, with text. Anything else gets a plain answer.
function standIn(calls) {
  const results = new Map();
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
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let json = {};
      try { json = JSON.parse(body); } catch (e) { /* not JSON */ }
      if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end('{}');
      }
      if (req.url.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ input_tokens: 1 }));
      }
      if (!Array.isArray(json.tools)) return text(res, 'ok');
      for (const m of json.messages || []) {
        for (const b of Array.isArray(m.content) ? m.content : []) {
          if (b.type === 'tool_result') results.set(b.tool_use_id, { isError: !!b.is_error, text: textOf(b.content) });
        }
      }
      const next = calls.findIndex((s, i) => !results.has(`toolu_probe_${i}`));
      if (next === -1) return text(res, 'done');
      return sse(res, [
        start(`msg_${next}`),
        ['content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_probe_${next}`, name: calls[next].tool, input: {} } }],
        ['content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(calls[next].input) } }],
        ['content_block_stop', { index: 0 }],
        ['message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } }],
        ['message_stop', {}],
      ]);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, results })));
}

// Every path the CLI says back is the case's own folder, written as one word.
function scrubber(dirs) {
  const forms = [...new Set(dirs.flatMap(d => [d, fs.realpathSync(d)]))].sort((a, b) => b.length - a.length);
  return (s) => forms.reduce((out, d) => out.split(`${d}${path.sep}`).join('').split(d).join('.'), String(s));
}

// CLAUDE_CODE_TMPDIR is where the CLI's shell keeps its working-folder file.
// It is set to the case's own folder so a shell command does not depend on
// what the machine's temporary directory allows.
function cleanEnv(port, home, tmp) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^(CLAUDE|ANTHROPIC)/.test(k)) env[k] = v;
  }
  return {
    ...env,
    HOME: home,
    ANTHROPIC_API_KEY: 'placeholder-not-a-key',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_TMPDIR: tmp,
  };
}

// A recording hook: one shared log, in call order. Each call writes the name
// of the settings entry that ran it on a line of its own, then the payload as
// the CLI gave it, then an end line, and prints the entry's answer.
const END_OF_CALL = '<<end of call>>';
function writeHook(aux, log, entry, answer) {
  const file = path.join(aux, `${entry}.sh`);
  fs.writeFileSync(file, [
    '#!/bin/sh',
    `printf '%s\\n' '${entry}' >> "${log}"`,
    `cat >> "${log}"`,
    `printf '\\n%s\\n' '${END_OF_CALL}' >> "${log}"`,
    `echo '${answer}'`,
    '',
  ].join('\n'));
  return { matcher: MATCHER, hooks: [{ type: 'command', command: `sh "${file}"` }] };
}

function readHookCalls(log, scrub) {
  if (!fs.existsSync(log)) return [];
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  return fs.readFileSync(log, 'utf8').split(`\n${END_OF_CALL}\n`).map(s => s.replace(/^\n+/, '')).filter(s => s.trim())
    .map((chunk) => {
      const nl = chunk.indexOf('\n');
      const entry = (nl === -1 ? chunk : chunk.slice(0, nl)).trim();
      let payload;
      try { payload = JSON.parse(nl === -1 ? '' : chunk.slice(nl + 1)); } catch (e) { return { entry, readable: false }; }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { entry, readable: false };
      const input = payload.tool_input && typeof payload.tool_input === 'object' && !Array.isArray(payload.tool_input) ? payload.tool_input : {};
      return {
        entry,
        event: has(payload, 'hook_event_name') ? payload.hook_event_name : null,
        tool: has(payload, 'tool_name') ? payload.tool_name : null,
        command: typeof input.command === 'string' ? scrub(input.command) : null,
        flag: has(input, FLAG) ? { given: true, value: input[FLAG], type: typeof input[FLAG] } : { given: false },
        keys: Object.keys(payload).sort(),
        inputKeys: Object.keys(input).sort(),
      };
    });
}

// A system line with its ids taken out. An id that names a tool call becomes
// whether it is this case's call, `callId` (`tool_use_id` becomes
// `toolUseIdMatches`); a session, message or any other id is left out; every
// string is scrubbed.
const LEFT_OUT = new Set(['session_id', 'uuid', 'message_id', 'request_id', 'parent_uuid']);
function camel(k) {
  return k.replace(/_([a-z])/g, (m, c) => c.toUpperCase());
}
function idFree(value, scrub, callId = CALL_ID) {
  if (Array.isArray(value)) return value.map(v => idFree(v, scrub, callId));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (LEFT_OUT.has(k)) continue;
      if (typeof v === 'string' && (k === 'tool_use_id' || v.startsWith('toolu_'))) {
        out[`${camel(k)}Matches`] = v === callId;
        continue;
      }
      if (typeof v === 'string' && /(^id$|_id$|Id$)/.test(k)) continue;
      out[k] = idFree(v, scrub, callId);
    }
    return out;
  }
  return typeof value === 'string' ? scrub(value) : value;
}

function markerLines(file) {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim()).length;
}

async function runCase(bin, c, shape) {
  const made = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-cli-probe-'));
  // The real spelling throughout, so the block's temp root is the one folder
  // the CLI is given, under one name.
  const root = fs.realpathSync(made);
  const [work, aux, home, tmp] = ['work', 'aux', 'home', 'tmp'].map(d => path.join(root, d));
  for (const d of [work, aux, home, tmp]) fs.mkdirSync(d, { recursive: true });
  const scrub = scrubber([work, aux, home, tmp, root, made, ...['work', 'aux', 'home', 'tmp'].map(d => path.join(made, d))]);

  const block = knowledgeBlock(work, home, tmp);
  const asTokens = tokenize(JSON.stringify(block), [[work, '<work>'], [home, '<home>'], [tmp, '<tmp>'], ...repoPairs()]);
  if (asTokens !== canonicalSandboxText()) {
    throw new Error('the sandbox block built for this case is not the one the record describes');
  }
  const log = path.join(aux, 'hook-calls.log');
  const hooks = { PreToolUse: [writeHook(aux, log, 'PreToolUse', PRE_TOOL_USE_ALLOW)] };
  if (c.permissionRequest !== null) hooks.PermissionRequest = [writeHook(aux, log, 'PermissionRequest', c.permissionRequest)];
  const settings = { sandbox: block, hooks };

  const api = await standIn([{ tool: 'Bash', input: c.input }]);
  const argv = [...ISOLATION_ARGS, '--settings', JSON.stringify(settings), ...conversationArgs(shape), '--max-turns', '3'];
  const child = spawn(bin, argv, { cwd: work, env: cleanEnv(api.port, home, tmp), stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content: PROMPT } })}\n`);
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('timeout'); }, CASE_TIMEOUT_MS);
    child.on('close', (code) => { clearTimeout(timer); resolve(code); });
  });
  api.server.close();

  const lines = out.split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
    .filter(l => l && typeof l === 'object');
  const observed = { exitCode };
  const errorLine = err.split('\n').map(l => l.trim()).find(l => l.startsWith('Error:'));
  if (errorLine) observed.error = scrub(errorLine);
  // The tool result as the CLI wrote it on stdout, which is what Rundock reads.
  observed.results = lines
    .filter(l => l.type === 'user' && l.message && Array.isArray(l.message.content))
    .flatMap(l => l.message.content.filter(b => b && b.type === 'tool_result'))
    .map(b => ({ toolUseIdMatches: b.tool_use_id === CALL_ID, refused: b.is_error === true, text: scrub(textOf(b.content)) }));
  // Whether the same result reached the messages API under the call's id.
  observed.resultSentToApi = api.results.has(CALL_ID);
  observed.markerLines = markerLines(path.join(work, 'marker.txt'));
  observed.hooksAsked = readHookCalls(log, scrub);
  observed.systemLines = lines
    .filter(l => l.type === 'system' && l.subtype !== 'init')
    .map(l => ({ keys: Object.keys(l).sort(), line: idFree(l, scrub) }));
  fs.rmSync(root, { recursive: true, force: true });
  return observed;
}

// The control ran: one result for its call, not refused, and one marker line.
function controlRan(observed) {
  return observed.results.length === 1 && observed.results[0].toolUseIdMatches
    && observed.results[0].refused === false && observed.markerLines === 1;
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
  if (process.platform !== 'darwin') {
    process.stderr.write(`[probe] this measures Claude Code's own sandbox, which it starts on macOS only: run it on macOS (this is ${process.platform})\n`);
    process.exit(1);
  }
  const write = process.argv.includes('--write');
  const bin = resolveClaude();
  // `claude --version` prints the version first: "2.1.318 (Claude Code)".
  const version = execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim().split(/\s+/)[0] || null;
  const shape = conversationShape();
  const cases = [];
  for (const c of CASES) {
    process.stderr.write(`[probe] ${c.name}\n`);
    const observed = await runCase(bin, c, shape);
    const r = observed.results[0];
    process.stderr.write(`[probe]   ${r ? (r.refused ? 'refused' : 'ran') : 'no result'}, ${observed.markerLines} marker line(s), hooks asked: ${observed.hooksAsked.map(h => h.entry).join(', ') || 'none'}\n`);
    cases.push({ ...c, observed });
  }
  const control = cases.find(c => c.control);
  if (!controlRan(control.observed)) {
    process.stderr.write(`[probe] the control did not run and leave one marker line, so Claude Code could not run a sandboxed command here (is this terminal itself sandboxed?). Nothing is written. What the control saw: ${JSON.stringify(control.observed)}\n`);
    process.exit(1);
  }
  const record = {
    about: 'What the installed Claude Code did with a Bash call outside its sandbox, measured by test/tools/claude-cli-sandbox-override-probe.js. test/unit/stub-claude-sandbox-override-matches-cli.test.js holds the stub to it.',
    claudeCode: version,
    method: 'The real CLI spawned as server.js spawns a conversation (no --print, the prompt on stdin as stream-json, --include-partial-messages, and the permission mode, allowed tools and Notes-mode disallowed tools below), in a fresh empty folder with an empty home folder, with user, project and local settings, plugins and MCP servers kept out (--setting-sources "", --strict-mcp-config, --no-chrome, --no-session-persistence), a placeholder API key, and a stand-in for the messages API on 127.0.0.1 that asked for one Bash call, the case\'s input, under the id toolu_probe_0. No account was used and no model was called. Each case\'s --settings value held Rundock\'s Knowledge-mode sandbox block for the case\'s folders, a PreToolUse entry for the matcher below whose sh hook recorded its payload and printed the PreToolUse answer below, and, where the case names one, a PermissionRequest entry for the same matcher whose sh hook recorded its payload and printed the case\'s answer. A hook call lists the settings entry that ran it, the payload\'s event and tool names, the command, the flag as given, and the payload\'s and tool_input\'s top-level keys. Results are the tool_result blocks the CLI wrote on stdout; system lines are every stdout line of type system but init, with an id that names a tool call written as whether it is the case\'s call and other ids left out. markerLines counts the non-empty lines of marker.txt in the case\'s folder: one per run of the command. The control shows that the command ran in a case without the flag; it does not show that Claude Code\'s sandbox (Seatbelt) was on while it ran. Paths are relative to the case\'s folder.',
    conversation: {
      ...shape,
      args: [...ISOLATION_ARGS, '--settings', '<the case\'s settings>', ...conversationArgs(shape), '--max-turns', '3'],
      how: 'permissionMode and allowedTools are read from server.js (getPermissionMode, getAllowedToolsInteractive); disallowedTools is NOTES_DISALLOWED_TOOLS, which server.js passes for a workspace not in Code mode.',
    },
    settings: {
      matcher: MATCHER,
      preToolUseAnswer: PRE_TOOL_USE_ALLOW,
      sandbox: describeSandbox(),
    },
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
  const measured = (r) => JSON.stringify({ conversation: r.conversation, settings: r.settings, cases: r.cases });
  const same = committed && measured(committed) === measured(record);
  process.stderr.write(same
    ? `[probe] Claude Code ${version} matches the record (made with ${committed.claudeCode})\n`
    : `[probe] Claude Code ${version} differs from the record${committed ? ` (made with ${committed.claudeCode})` : ''}: run with --write and read the diff\n`);
  process.exit(same ? 0 : 1);
}

// What the matching test reads from here rather than restating: the cases,
// the answers and matcher the settings carried, the spawn's arguments and the
// server's shape for them, the sandbox block and its description, rebuilt
// from the scaffold as it is, and the readers that turned what the CLI did
// into the record, so the stub's run is read the same way.
module.exports = {
  CASES, CALL_ID, COMMAND, MATCHER, PRE_TOOL_USE_ALLOW, PERMISSION_REQUEST_ALLOW, NO_DECISION,
  ISOLATION_ARGS, conversationShape, conversationArgs, knowledgeBlock, describeSandbox,
  END_OF_CALL, readHookCalls, idFree, markerLines, scrubber,
};

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`[probe] ${e.stack || e.message}\n`);
    process.exit(1);
  });
}
