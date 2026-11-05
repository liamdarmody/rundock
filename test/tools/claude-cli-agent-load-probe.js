#!/usr/bin/env node
'use strict';
// WHICH AGENT FILES THE INSTALLED CLAUDE CODE LOADS, MEASURED.
//
// A routine starts as its agent with --agent, and Claude Code drops an agent
// file it cannot read without a word. lib/agents/claude-code-load.js is
// Rundock's reading of the rules it drops one by, and the scheduler and the
// test stub both rest on it. This runs the real, installed Claude Code through
// the cases that matter and records what it did, so the reading is held to a
// measurement. test/unit/claude-cli-agent-load.test.js holds it to the record
// this writes.
//
// THE CASES. Routine values the writer used to leave bare and now quotes (a
// colon and a space, a leading backtick, stray quotation marks), each written
// both ways; the top-level leniency the reading models; a file with no
// `name:` and one with no `description:`; an agent no file defines; and an
// agent whose `tools:` line leaves out Bash, asked by the model to run Bash,
// beside the same agent with no `tools:` line.
//
// HOW EACH CASE RUNS. The real CLI, spawned the way the scheduler spawns a
// routine (--add-dir, --print, --output-format stream-json, --verbose,
// --dangerously-skip-permissions, --append-system-prompt with the unattended
// line, --session-id, --agent, the prompt last), in a fresh folder holding
// the case's agent file, with its own empty home and config folders, a
// placeholder API key, and ANTHROPIC_BASE_URL pointed at a stand-in for the
// messages API on 127.0.0.1. No account is used and no model is called. A file
// counts as loaded when a request reaches the stand-in carrying the agent's
// own instructions. Every folder the case made is removed afterwards.
//
// RUN BY HAND, NEVER BY THE SUITE OR CI: it needs a real Claude Code install,
// and it is not a *.test.js file, so `npm test` does not collect it.
//
//   node test/tools/claude-cli-agent-load-probe.js           measure, compare with the record
//   node test/tools/claude-cli-agent-load-probe.js --write   measure, and write the record
//
// CLAUDE_BIN names the binary; otherwise the `claude` on PATH. The test stub is
// refused. The record holds no path, user or machine name, and a record that
// would carry one of this machine's names is refused rather than written.
// Exits 0 when the measurement matches the record (or was written), 1
// otherwise.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { appendRoutineBlock } = require('../../lib/agents/routines.js');
const { UNATTENDED_RUN } = require('../../scripts/refusal-notice.js');

const RECORD = path.join(__dirname, '..', 'fixtures', 'claude-cli-agent-load.json');
const STUB_DIR = path.join(__dirname, '..', 'helpers', 'stub-claude');
const PROMPT = 'run the routine';
const MARKER = 'PROBE-AGENT-INSTRUCTIONS';
const SENTINEL = 'sentinel.txt';
const CASE_TIMEOUT_MS = 120000;

const agentFile = (frontmatter) => `---\n${frontmatter}\n---\n\nYou are the probe agent. ${MARKER}\n`;
const BASE = agentFile('name: probe\ndescription: Probes the loader');

// A routine written by this writer, and the same routine as the writer wrote
// it before it quoted anything: the value as it stood.
function writtenNow(prompt) {
  return appendRoutineBlock(BASE, { name: 'r', schedule: 'every day at 07:00', prompt });
}
function writtenBefore(prompt) {
  return writtenNow(prompt).replace(/^( {4}prompt: ).*$/m, (_, lead) => `${lead}${prompt}`);
}

const PROMPTS = [
  ['a colon and a space', 'Summarize: inbox, calendar and tasks'],
  ['a leading backtick', '`npm test` then report what failed'],
  ['stray quotation marks', '"Summarize" the inbox, then file it'],
];

const CASES = [
  ...PROMPTS.flatMap(([label, prompt]) => [
    { name: `a routine prompt with ${label}, as the writer used to write it`, agent: 'probe', file: writtenBefore(prompt) },
    { name: `a routine prompt with ${label}, as the writer writes it now`, agent: 'probe', file: writtenNow(prompt) },
  ]),
  { name: 'a colon and a space in a top-level description', agent: 'probe', file: agentFile('name: probe\ndescription: Probes: the loader') },
  { name: 'no name line', agent: 'probe', file: agentFile('description: Probes the loader') },
  { name: 'no description line', agent: 'probe', file: agentFile('name: probe') },
  { name: 'an agent no file defines', agent: 'nobody-here', file: BASE },
  {
    name: 'a tools line without Bash, and the model asks for Bash', agent: 'probe',
    file: agentFile('name: probe\ndescription: Probes the loader\ntools: Read, Write'),
    steps: [{ tool: 'Bash', command: `touch ${SENTINEL}` }],
  },
  {
    name: 'no tools line, and the model asks for Bash', agent: 'probe', file: BASE,
    steps: [{ tool: 'Bash', command: `touch ${SENTINEL}` }],
  },
];

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

// The stand-in for the messages API. A request that offers tools and carries
// the agent's instructions is the agent's own turn: it is answered with the
// case's next tool call, and once every call has a result, with text.
// Anything else gets a plain answer.
function standIn(steps) {
  const seen = { loaded: false, toolsOffered: null, results: new Map() };
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
      const own = textOf(json.system).includes(MARKER) && Array.isArray(json.tools);
      if (!own) return text(res, 'ok');
      seen.loaded = true;
      if (!seen.toolsOffered) seen.toolsOffered = json.tools.map(t => t.name).sort();
      for (const m of json.messages || []) {
        for (const b of Array.isArray(m.content) ? m.content : []) {
          if (b.type === 'tool_result') seen.results.set(b.tool_use_id, { isError: !!b.is_error, text: textOf(b.content) });
        }
      }
      const next = steps.findIndex((s, i) => !seen.results.has(`toolu_probe_${i}`));
      if (next === -1) return text(res, 'RUN STATUS: succeeded');
      return sse(res, [
        start(`msg_${next}`),
        ['content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_probe_${next}`, name: steps[next].tool, input: {} } }],
        ['content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: steps[next].command, description: 'probe' }) } }],
        ['content_block_stop', { index: 0 }],
        ['message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } }],
        ['message_stop', {}],
      ]);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen })));
}

// Every path the CLI says back is the case's own folder, written as one word.
function scrubber(dirs) {
  const forms = [...new Set(dirs.flatMap(d => [d, fs.realpathSync(d)]))].sort((a, b) => b.length - a.length);
  return (s) => forms.reduce((out, d) => out.split(`${d}${path.sep}`).join('').split(d).join('.'), String(s));
}

// Nothing of this machine's own Claude Code reaches the run: its own home, its
// own config folder, and none of the variables that would point elsewhere.
function cleanEnv(port, home, config, tmp) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^(CLAUDE|ANTHROPIC)/.test(k)) env[k] = v;
  }
  return {
    ...env,
    HOME: home,
    CLAUDE_CONFIG_DIR: config,
    ANTHROPIC_API_KEY: 'placeholder-not-a-key',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_TMPDIR: tmp,
  };
}

async function runCase(bin, c) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-agent-load-probe-'));
  const work = path.join(root, 'work');
  const home = path.join(root, 'home');
  const config = path.join(root, 'config');
  const tmp = path.join(root, 'tmp');
  for (const d of [work, home, config, tmp]) fs.mkdirSync(d, { recursive: true });
  const dir = fs.realpathSync(work);
  fs.mkdirSync(path.join(dir, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'agents', 'probe.md'), c.file);
  const scrub = scrubber([work, home, config, tmp, root]);
  const api = await standIn(c.steps || []);

  const argv = ['--add-dir', dir, '--print', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions',
    '--append-system-prompt', UNATTENDED_RUN, '--session-id', randomUUID(), '--agent', c.agent, PROMPT];
  const child = spawn(bin, argv, { cwd: dir, env: cleanEnv(api.port, home, config, tmp), stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stdout.resume();
  child.stderr.on('data', (d) => { err += d; });
  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('timeout'); }, CASE_TIMEOUT_MS);
    child.on('close', (code) => { clearTimeout(timer); resolve(code); });
  });
  api.server.close();

  const observed = { exitCode, loaded: api.seen.loaded, stderr: scrub(err.trim()) };
  if (c.steps) {
    observed.toolsOffered = api.seen.toolsOffered;
    observed.results = c.steps.map((s, i) => {
      const r = api.seen.results.get(`toolu_probe_${i}`);
      if (!r) return { reached: false };
      return r.isError ? { refused: true, message: scrub(r.text) } : { refused: false };
    });
    observed.sentinelCreated = fs.existsSync(path.join(dir, SENTINEL));
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
    cases.push({ ...c, observed: await runCase(bin, c) });
  }
  const record = {
    about: 'Which agent files the installed Claude Code loaded and refused, measured by test/tools/claude-cli-agent-load-probe.js. test/unit/claude-cli-agent-load.test.js holds lib/agents/claude-code-load.js and the test stub to it.',
    claudeCode: version,
    method: 'The real CLI spawned as the scheduler spawns a routine (--add-dir, --print, --output-format stream-json, --verbose, --dangerously-skip-permissions, --append-system-prompt, --session-id, --agent, the prompt last), in a fresh folder holding the case\'s agent file as .claude/agents/probe.md, with empty home and config folders, a placeholder API key, and a stand-in for the messages API on 127.0.0.1. No account was used and no model was called. A file counts as loaded when a request carrying its instructions reached the stand-in. The stand-in asked for each case\'s tool calls in turn.',
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
