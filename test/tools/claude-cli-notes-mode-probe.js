#!/usr/bin/env node
'use strict';
// WHAT THE INSTALLED CLAUDE CODE REFUSES UNDER THE NOTES-MODE LIST, MEASURED.
//
// The suite proves the Notes-mode block on the stub `claude`, so the stub's
// model of the CLI is the thing every one of those tests rests on. This runs
// the real, installed Claude Code through the same cases and records what it
// did, so the model is held to a measurement rather than to a reading of the
// CLI's documentation. test/unit/stub-claude-matches-cli.test.js holds the
// stub to the record this writes.
//
// HOW EACH CASE RUNS. The real CLI, in a routine's spawn shape (--print
// --output-format stream-json --verbose --dangerously-skip-permissions), in a
// fresh empty folder, with its own empty home folder, a placeholder API key,
// and ANTHROPIC_BASE_URL pointed at a stand-in for the messages API on
// 127.0.0.1. The stand-in asks for the case's tool calls one at a time and
// records each tool result the CLI sends back. No account is used and no model
// is called. User, project and local settings, plugins and MCP servers are kept
// out (--setting-sources "", --strict-mcp-config), so nothing from the machine
// it runs on decides the answer. Afterwards the case's files are read off the
// disk.
//
// RUN BY HAND, NEVER BY THE SUITE OR CI: it needs a real Claude Code install,
// and it is not a *.test.js file, so `npm test` does not collect it.
//
//   node test/tools/claude-cli-notes-mode-probe.js           measure, compare with the record
//   node test/tools/claude-cli-notes-mode-probe.js --write   measure, and write the record
//
// CLAUDE_BIN names the binary; otherwise the `claude` on PATH. The test stub is
// refused. The record holds no path, user or machine name: every path is
// written relative to the case's folder, and a record that would carry one of
// this machine's names is refused rather than written. Exits 0 when the
// measurement matches the record (or was written), 1 otherwise.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { NOTES_DISALLOWED_TOOLS } = require('../../lib/workspace/mode.js');

const RECORD = path.join(__dirname, '..', 'fixtures', 'claude-cli-notes-mode.json');
const STUB_DIR = path.join(__dirname, '..', 'helpers', 'stub-claude');
const PROMPT = 'do the work';
// A conversation's spawn, as server.js builds it: no --print, the prompt on
// stdin as stream-json, the permission mode and allowed tools it passes. Held
// to the server's current values by test/unit/stub-claude-matches-cli.test.js,
// so a change there fails a test until this is measured again.
const CONVERSATION = {
  permissionMode: 'acceptEdits',
  allowedTools: 'Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,ToolSearch,Agent,Skill',
};
const CASE_TIMEOUT_MS = 120000;

// The cases. Each is one CLI run. `list` is 'notes' for the Notes-mode list,
// null for none, or a literal list. `hook: 'allow'` configures a PreToolUse
// hook that records what it was asked and answers allow, which is what a
// person approving a card sends; `hook: 'deny'` answers deny with the reason
// "Denied". Paths are relative to the case's folder.
const CASES = [
  { name: 'tool inventory, no list', list: null, recordTools: true, steps: [] },
  { name: 'tool inventory, Notes list', list: 'notes', recordTools: true, steps: [] },
  {
    name: 'a Write(path) rule alone', list: 'Write(*.py)',
    steps: [{ tool: 'Write', file: 'tool.py', content: 'print("hello")\n' }],
    observe: ['tool.py'],
  },
  {
    name: 'an Edit(path) rule alone', list: 'Edit(*.py)',
    steps: [
      { tool: 'Write', file: 'tool.py', content: 'print("hello")\n' },
      { tool: 'Write', file: 'sub/tool.py', content: 'print("hello")\n' },
      { tool: 'Write', file: 'note.md', content: 'a note\n' },
    ],
    observe: ['tool.py', 'sub/tool.py', 'note.md'],
  },
  {
    name: 'Notes list, file writes', list: 'notes',
    steps: [
      { tool: 'Write', file: 'tool.py', content: 'print("hello")\n' },
      { tool: 'Write', file: 'build.sh', content: 'echo hello\n' },
      { tool: 'Write', file: 'lib.dll', content: 'binary\n' },
      { tool: 'Write', file: 'lib.so', content: 'binary\n' },
      { tool: 'NotebookEdit', file: 'analysis.ipynb', content: 'print(1)' },
      { tool: 'Write', file: 'summary.md', content: 'a note\n' },
      { tool: 'Write', file: 'list.txt', content: 'a list\n' },
      { tool: 'Write', file: 'data.json', content: '{}\n' },
    ],
    observe: ['tool.py', 'build.sh', 'lib.dll', 'lib.so', 'analysis.ipynb', 'summary.md', 'list.txt', 'data.json'],
  },
  {
    name: 'Notes list, edits', list: 'notes',
    seed: { 'tool.py': 'print(1)\n', 'note.md': 'old text\n' },
    steps: [
      { tool: 'Read', file: 'tool.py' },
      { tool: 'Edit', file: 'tool.py', old: 'print(1)', new: 'print(2)' },
      { tool: 'Read', file: 'note.md' },
      { tool: 'Edit', file: 'note.md', old: 'old text', new: 'new text' },
    ],
    observe: ['tool.py', 'note.md'],
  },
  {
    name: 'Notes list, a retried write', list: 'notes',
    steps: [
      { tool: 'Write', file: 'tool.py', content: 'print("hello")\n' },
      { tool: 'Write', file: 'tool.py', content: 'print("hello")\n' },
      { tool: 'Write', file: 'first.md', content: 'a note\n' },
    ],
    observe: ['tool.py', 'first.md'],
  },
  {
    name: 'Notes list, the same work saved as a note', list: 'notes',
    steps: [
      { tool: 'Write', file: 'report.py', content: 'Quarterly figures\nRevenue: 12\n' },
      { tool: 'Write', file: 'report.md', content: 'Quarterly figures\nRevenue: 12\n' },
    ],
    observe: ['report.py', 'report.md'],
  },
  {
    name: 'Notes list, shell renames and deletes', list: 'notes',
    seed: { 'tool.py': 'x\n', 'other.sh': 'x\n', 'note.md': 'x\n', 'old.md': 'x\n', 'gone.md': 'x\n' },
    steps: [
      { tool: 'Bash', command: 'rm tool.py' },
      { tool: 'Bash', command: 'mv other.sh other.md' },
      { tool: 'Bash', command: 'mv note.md note.py' },
      { tool: 'Bash', command: 'mv old.md new.md' },
      { tool: 'Bash', command: 'rm gone.md' },
    ],
    observe: ['tool.py', 'other.sh', 'other.md', 'note.md', 'note.py', 'old.md', 'new.md', 'gone.md'],
  },
  {
    name: 'Notes list, shell renames and deletes, the hook answering allow', list: 'notes', hook: 'allow',
    seed: { 'tool.py': 'x\n', 'other.sh': 'x\n', 'note.md': 'x\n', 'old.md': 'x\n', 'gone.md': 'x\n' },
    steps: [
      { tool: 'Bash', command: 'rm tool.py' },
      { tool: 'Bash', command: 'mv other.sh other.md' },
      { tool: 'Bash', command: 'mv note.md note.py' },
      { tool: 'Bash', command: 'mv old.md new.md' },
      { tool: 'Bash', command: 'rm gone.md' },
    ],
    observe: ['tool.py', 'other.sh', 'other.md', 'note.md', 'note.py', 'old.md', 'new.md', 'gone.md'],
  },
  {
    name: 'Notes list, file writes, the hook answering allow', list: 'notes', hook: 'allow',
    steps: [
      { tool: 'Write', file: 'tool.py', content: 'print("hello")\n' },
      { tool: 'Write', file: 'note.md', content: 'a note\n' },
    ],
    observe: ['tool.py', 'note.md'],
  },
  {
    name: 'a conversation, Notes list, shell renames and deletes, the hook answering allow', list: 'notes', hook: 'allow', shape: 'conversation',
    seed: { 'tool.py': 'x\n', 'other.sh': 'x\n', 'note.md': 'x\n', 'old.md': 'x\n', 'gone.md': 'x\n' },
    steps: [
      { tool: 'Bash', command: 'rm tool.py' },
      { tool: 'Bash', command: 'mv other.sh other.md' },
      { tool: 'Bash', command: 'mv note.md note.py' },
      { tool: 'Bash', command: 'mv old.md new.md' },
      { tool: 'Bash', command: 'rm gone.md' },
    ],
    observe: ['tool.py', 'other.sh', 'other.md', 'note.md', 'note.py', 'old.md', 'new.md', 'gone.md'],
  },
  {
    name: 'a conversation, Notes list, file writes, the hook answering allow', list: 'notes', hook: 'allow', shape: 'conversation',
    steps: [
      { tool: 'Write', file: 'tool.py', content: 'print("hello")\n' },
      { tool: 'Write', file: 'note.md', content: 'a note\n' },
    ],
    observe: ['tool.py', 'note.md'],
  },
  {
    name: 'Notes list, a note\'s shell delete, the hook answering deny', list: 'notes', hook: 'deny',
    seed: { 'gone.md': 'x\n' },
    steps: [{ tool: 'Bash', command: 'rm gone.md' }],
    observe: ['gone.md'],
  },
  {
    name: 'no list', list: null,
    seed: { 'tool.py': 'x\n' },
    steps: [
      { tool: 'Bash', command: 'rm tool.py' },
      { tool: 'Write', file: 'lib.dll', content: 'binary\n' },
    ],
    observe: ['tool.py', 'lib.dll'],
  },
  { name: 'Notes list placed just before the prompt', list: 'notes', placement: 'before-prompt', steps: [] },
];

function resolveClaude() {
  const bin = process.env.CLAUDE_BIN || execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
  if (fs.realpathSync(bin).startsWith(fs.realpathSync(STUB_DIR))) {
    throw new Error('refusing to run: this resolves to the test stub, not to Claude Code');
  }
  return bin;
}

function toolInput(step, dir) {
  const abs = step.file ? path.join(dir, step.file) : null;
  switch (step.tool) {
    case 'Write': return { file_path: abs, content: step.content };
    case 'Read': return { file_path: abs };
    case 'Edit': return { file_path: abs, old_string: step.old, new_string: step.new };
    case 'NotebookEdit': return { notebook_path: abs, new_source: step.content, cell_type: 'code', edit_mode: 'insert' };
    case 'Bash': return { command: step.command, description: 'probe' };
    default: throw new Error(`no input shape for ${step.tool}`);
  }
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(b => (b && typeof b.text === 'string' ? b.text : '')).join('');
  return '';
}

// The stand-in for the messages API. The main loop (a request that offers
// tools) is answered with the next tool call, and once every call has a
// result, with text. Anything else gets a plain answer.
function standIn(steps, dir) {
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
      const next = steps.findIndex((s, i) => !results.has(`toolu_probe_${i}`));
      if (next === -1) return text(res, 'done');
      return sse(res, [
        start(`msg_${next}`),
        ['content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_probe_${next}`, name: steps[next].tool, input: {} } }],
        ['content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(toolInput(steps[next], dir)) } }],
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

async function runCase(bin, c) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-cli-probe-'));
  const work = path.join(root, 'work');
  const aux = path.join(root, 'aux');
  const home = path.join(root, 'home');
  const tmp = path.join(root, 'tmp');
  for (const d of [work, aux, home, tmp]) fs.mkdirSync(d, { recursive: true });
  const dir = fs.realpathSync(work);
  for (const [f, body] of Object.entries(c.seed || {})) fs.writeFileSync(path.join(dir, f), body);
  const scrub = scrubber([work, aux, home, tmp, root]);
  const api = await standIn(c.steps, dir);

  const args = ['--setting-sources', '', '--strict-mcp-config', '--no-chrome', '--no-session-persistence'];
  const hookLog = path.join(aux, 'hook-calls.jsonl');
  if (c.hook) {
    const hook = path.join(aux, 'hook.sh');
    const answer = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: c.hook, permissionDecisionReason: c.hook === 'allow' ? 'Approved' : 'Denied' } };
    fs.writeFileSync(hook, `#!/bin/sh\ncat >> "${hookLog}"\necho >> "${hookLog}"\necho '${JSON.stringify(answer)}'\n`);
    args.push('--settings', JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash|Write|Edit|NotebookEdit', hooks: [{ type: 'command', command: `sh "${hook}"` }] }] } }));
  }
  const list = c.list === 'notes' ? NOTES_DISALLOWED_TOOLS : c.list;
  const flag = list ? ['--disallowed-tools', list] : [];
  const turns = ['--max-turns', String(c.steps.length + 2)];
  const tail = ['--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', ...turns];
  const conversation = c.shape === 'conversation';
  let argv;
  if (conversation) {
    argv = [...args, '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--permission-mode', CONVERSATION.permissionMode, '--allowed-tools', CONVERSATION.allowedTools, ...flag, ...turns];
  } else if (c.placement === 'before-prompt') {
    argv = [...args, '--print', ...tail, ...flag, PROMPT];
  } else {
    argv = [...args, ...flag, '--print', ...tail, PROMPT];
  }

  const child = spawn(bin, argv, { cwd: dir, env: cleanEnv(api.port, home, tmp), stdio: [conversation ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  if (conversation) {
    child.stdin.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content: PROMPT } })}\n`);
  }
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('timeout'); }, CASE_TIMEOUT_MS);
    child.on('close', (code) => { clearTimeout(timer); resolve(code); });
  });
  api.server.close();

  const observed = { exitCode };
  const errorLine = err.split('\n').map(l => l.trim()).find(l => l.startsWith('Error:'));
  if (errorLine) observed.error = scrub(errorLine);
  if (c.recordTools) {
    const init = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return {}; } })
      .find(e => e.type === 'system' && e.subtype === 'init');
    observed.tools = init ? init.tools : null;
  }
  observed.results = c.steps.map((s, i) => {
    const r = api.results.get(`toolu_probe_${i}`);
    if (!r) return { reached: false };
    // A refusal is recorded with what the CLI said. What it says on success
    // varies with the tool and adds nothing here, so only the fact is kept.
    return r.isError ? { refused: true, message: scrub(r.text) } : { refused: false };
  });
  if (c.observe) {
    observed.files = {};
    for (const f of c.observe) {
      const p = path.join(dir, f);
      observed.files[f] = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
    }
  }
  if (c.hook) {
    const calls = fs.existsSync(hookLog) ? fs.readFileSync(hookLog, 'utf8').split('\n').filter(l => l.trim()) : [];
    observed.hookAsked = calls.map((l) => {
      const j = JSON.parse(l);
      const input = j.tool_input || {};
      return { tool: j.tool_name, about: scrub(input.command || input.file_path || input.notebook_path || '') };
    });
  }
  fs.rmSync(root, { recursive: true, force: true });
  return observed;
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
    const { recordTools, ...shape } = c;
    cases.push({ ...shape, observed: await runCase(bin, c) });
  }
  const record = {
    about: 'What the installed Claude Code refused under the Notes-mode list, measured by test/tools/claude-cli-notes-mode-probe.js. test/unit/stub-claude-matches-cli.test.js holds the stub to it.',
    claudeCode: version,
    method: 'The real CLI in a routine spawn shape (--print --output-format stream-json --verbose --dangerously-skip-permissions), in a fresh empty folder with an empty home folder, with user, project and local settings, plugins and MCP servers kept out (--setting-sources "", --strict-mcp-config), a placeholder API key, and a stand-in for the messages API on 127.0.0.1 that asked for each case\'s tool calls in turn. No account was used and no model was called. A tool inventory is the tool list in the run\'s init event. Paths are relative to the case\'s folder.',
    notesList: NOTES_DISALLOWED_TOOLS,
    conversation: { ...CONVERSATION, how: 'A case marked shape "conversation" ran as server.js spawns a conversation: no --print, the prompt on stdin as stream-json, --include-partial-messages, and this permission mode and allowed-tools list in place of --dangerously-skip-permissions.' },
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
    : `[probe] Claude Code ${version} differs from the record${committed ? ` (made with ${committed.claudeCode})` : ''}: run with --write and read the diff\n`);
  process.exit(same ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(`[probe] ${e.stack || e.message}\n`);
  process.exit(1);
});
