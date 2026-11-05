#!/usr/bin/env node
'use strict';
// WHAT CLAUDE CODE DOES WITH A PERMISSION HOOK THAT CANNOT ANSWER, MEASURED.
//
// The permission hook ends a call it decides, but could not answer on standard
// output, with exit code 2 and its reason on standard error, on the strength
// of Claude Code's documented reading of that code: a block for PreToolUse,
// with standard error as the reason. test/unit/hook-never-crashes.test.js
// proves the hook's half on every run. This records the runtime's half, from
// the real, installed Claude Code: a tool call whose hook ends that way, and
// whether the call ran. test/unit/hook-block-capture.test.js holds the record
// to what it claims, in CI, which has no Claude Code.
//
// HOW EACH CASE RUNS. The real CLI in print mode (-p --permission-mode default
// --output-format stream-json --verbose), started in a fresh workspace whose
// .claude/settings.local.json registers a PreToolUse hook the way Rundock
// registers its own (lib/workspace/scaffold.js: a launcher started with `sh`,
// a timeout of 300 seconds) and allows Bash, so nothing but the hook can stop
// the call. HOME and CLAUDE_CONFIG_DIR are fresh, empty folders, the API key is
// a placeholder, and ANTHROPIC_BASE_URL points at a stand-in for the messages
// API on 127.0.0.1, which asks for one Bash call that writes a sentinel file,
// records the tool result Claude Code sends back, and ends the turn. No account
// is used and no model is called. A stand-in for Rundock's own server, on
// 127.0.0.1 too, approves every card the permission hook raises. Afterwards
// the sentinel file is looked for.
//
// THE CASES. Rundock's permission hook (scripts/permission-hook.js, started by
// a launcher shaped like Rundock's, with Node in place of Rundock's runtime),
// first with its standard output read as usual, then with the reading end of
// its standard output closed before it is given its input
// (scripts/hook-block-truth/reader-gone.js), so the allow the card gave cannot
// be written. Then two plain hooks, one exiting 2 with a reason on standard
// error and one exiting 0 with nothing on standard output, which is how the
// permission hook used to end when its answer could not be written.
//
// RUN BY HAND, NEVER BY THE SUITE OR CI: it needs a real Claude Code install,
// and it is not a *.test.js file, so `npm test` does not collect it.
//
//   node scripts/hook-block-truth/capture.js           measure, compare with the record
//   node scripts/hook-block-truth/capture.js --write   measure, and write the record
//
// CLAUDE_BIN names the binary; otherwise the `claude` on PATH. The test stub is
// refused. Every case runs in a folder of its own inside one made new for the
// run, private to this user and outside the repository, which is removed
// afterwards (createRunRoot, below). The record holds no path, user or
// machine name: paths are written relative to the case's folder, the capture
// is scrubbed (scripts/capture-scrub.js), and a record that would still
// carry one of this machine's names is refused rather than written. Exits 0
// when the measurement matches the record (or was written), 1 otherwise.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { scrubCapture } = require('../capture-scrub.js');

const ROOT = path.join(__dirname, '..', '..');
const RECORD = path.join(__dirname, 'captured-hook-block.json');
const HOOK = path.join(ROOT, 'scripts', 'permission-hook.js');
const READER_GONE = path.join(__dirname, 'reader-gone.js');
const STUB_DIR = path.join(ROOT, 'test', 'helpers', 'stub-claude');
const SENTINEL = 'sentinel.txt';
const COMMAND = `echo ran > ${SENTINEL}`;
const PLAIN_REASON = 'Blocked by a hook that exited 2.';
const CASE_TIMEOUT_MS = 120000;

// `launcher` is the body of the script the hook command starts with `sh`,
// given the case's folders; null for none.
const CASES = [
  {
    name: "Rundock's permission hook, its standard output read",
    launcher: (node) => `exec "${node}" "${HOOK}" "$@"`,
  },
  {
    name: "Rundock's permission hook, the reader of its standard output gone",
    launcher: (node) => `exec "${node}" "${READER_GONE}" "${node}" "${HOOK}" "$@"`,
  },
  {
    name: 'a hook that exits 2 with a reason on standard error',
    launcher: () => `cat > /dev/null\necho "${PLAIN_REASON}" >&2\nexit 2`,
  },
  {
    name: 'a hook that exits 0 with nothing on standard output',
    launcher: () => 'cat > /dev/null\nexit 0',
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

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

// The stand-in for the messages API. The main loop (a request that offers
// tools) is asked for the one Bash call, and once it has a result, ends the
// turn. Anything else gets a plain answer.
function messagesApi() {
  const results = [];
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
      let answered = false;
      for (const m of json.messages || []) {
        for (const b of Array.isArray(m.content) ? m.content : []) {
          if (b.type === 'tool_result' && b.tool_use_id === 'toolu_hook_block_0') {
            answered = true;
            if (!results.length) results.push({ isError: !!b.is_error, text: textOf(b.content) });
          }
        }
      }
      if (answered) return text(res, 'done');
      return sse(res, [
        start('msg_tool'),
        ['content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_hook_block_0', name: 'Bash', input: {} } }],
        ['content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ command: COMMAND, description: 'write the sentinel' }) } }],
        ['content_block_stop', { index: 0 }],
        ['message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } }],
        ['message_stop', {}],
      ]);
    });
  });
  return { server, results };
}

// The stand-in for Rundock's server: no line left for the agent, and every
// card approved.
function rundockServer() {
  const asked = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      asked.push(`${req.method} ${req.url.split('?')[0]}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url.startsWith('/api/agent-notice') ? { text: '' } : { allow: true }));
    });
  });
  return { server, asked };
}

// Every path the run could say back, written relative to the case's folder,
// the repository's own as `<repo>`, and Node as `node`.
function scrubber(dirs) {
  const forms = [...new Set(dirs.flatMap(d => [d, fs.realpathSync(d)]))].sort((a, b) => b.length - a.length);
  const node = [process.execPath, fs.realpathSync(process.execPath)];
  const repo = [ROOT, fs.realpathSync(ROOT)];
  return (s) => {
    let out = forms.reduce((acc, d) => acc.split(`${d}${path.sep}`).join('').split(d).join('.'), String(s));
    for (const n of node) out = out.split(n).join('node');
    for (const r of repo) out = out.split(`${r}${path.sep}`).join('<repo>/').split(r).join('<repo>');
    return scrubCapture(out);
  };
}

function cleanEnv({ home, config, tmp, apiPort, rundockPort, workspace, log }) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^(CLAUDE|ANTHROPIC|RUNDOCK|NODE_OPTIONS$|NODE_TEST_CONTEXT$)/.test(k)) env[k] = v;
  }
  return {
    ...env,
    HOME: home,
    CLAUDE_CONFIG_DIR: config,
    CLAUDE_CODE_TMPDIR: tmp,
    ANTHROPIC_API_KEY: 'placeholder-not-a-key',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${apiPort}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    // As Rundock starts a routine's agent: inside Rundock, with no
    // conversation, so a refusal is in a routine's words.
    RUNDOCK: '1',
    RUNDOCK_PORT: String(rundockPort),
    RUNDOCK_WORKSPACE: workspace,
    HOOK_BLOCK_TRUTH_LOG: log,
  };
}

// THE RUN'S OWN FOLDER, made new, private, and outside the repository. A
// folder inside the repository can be swapped for a link to one anywhere else
// by anything that can write there, an agent included, and a run that cleared
// or removed a fixed path under it then removed what the link led to. mkdtemp
// makes a folder nobody named beforehand, which only this user can open (mode
// 0700). Every case's folders are made new inside it and nothing is cleared
// before use, and at the end only this folder is removed: rmSync removes a
// link put in its place as a link, and never what it leads to.
function createRunRoot(tmp = os.tmpdir()) {
  return fs.mkdtempSync(path.join(tmp, 'rundock-hook-block-'));
}
// One case's folders, made new inside the run's folder: a case folder that
// is already there is an error, never something to clear.
function caseFolders(runRoot, index) {
  const root = path.join(runRoot, `case-${index}`);
  fs.mkdirSync(root);
  const dirs = {
    root,
    workspace: path.join(root, 'workspace'),
    aux: path.join(root, 'aux'),
    home: path.join(root, 'home'),
    config: path.join(root, 'config'),
    tmp: path.join(root, 'tmp'),
  };
  for (const d of [path.join(dirs.workspace, '.claude'), dirs.aux, dirs.home, dirs.config, dirs.tmp]) fs.mkdirSync(d, { recursive: true });
  return dirs;
}
function removeRunRoot(runRoot) {
  fs.rmSync(runRoot, { recursive: true, force: true });
}

async function runCase(bin, c, index, runRoot) {
  const { root, workspace, aux, home, config, tmp } = caseFolders(runRoot, index);
  const scrub = scrubber([workspace, aux, home, config, tmp, root]);
  const log = path.join(aux, 'hook-exit.json');

  const launcher = path.join(aux, 'hook.sh');
  fs.writeFileSync(launcher, `#!/bin/sh\n${c.launcher(process.execPath)}\n`);
  fs.chmodSync(launcher, 0o755);
  const settings = {
    permissions: { allow: ['Bash'] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `sh "${launcher}"`, timeout: 300 }] }] },
  };
  fs.writeFileSync(path.join(workspace, '.claude', 'settings.local.json'), `${JSON.stringify(settings, null, 2)}\n`);

  const api = messagesApi();
  const rundock = rundockServer();
  const apiPort = await listen(api.server);
  const rundockPort = await listen(rundock.server);
  const argv = ['-p', '--permission-mode', 'default', '--output-format', 'stream-json', '--verbose',
    '--strict-mcp-config', '--max-turns', '3', `Run this command: ${COMMAND}`];
  const child = spawn(bin, argv, {
    cwd: workspace,
    env: cleanEnv({ home, config, tmp, apiPort, rundockPort, workspace, log }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  child.stdout.resume();
  child.stderr.on('data', (d) => { err += d; });
  const exitCode = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('timeout'); }, CASE_TIMEOUT_MS);
    child.on('close', (code) => { clearTimeout(timer); resolve(code); });
  });
  api.server.close();
  rundock.server.close();

  const observed = { cliExitCode: exitCode };
  const errorLine = err.split('\n').map(l => l.trim()).find(l => l.startsWith('Error:'));
  if (errorLine) observed.cliError = scrub(errorLine);
  if (fs.existsSync(log)) {
    const hook = JSON.parse(fs.readFileSync(log, 'utf8'));
    observed.hookExitCode = hook.code;
    observed.hookStderr = scrub(hook.stderr);
  }
  observed.rundockAsked = rundock.asked;
  const result = api.results[0];
  observed.toolResult = result ? { isError: result.isError, text: scrub(result.text) } : null;
  observed.sentinelExists = fs.existsSync(path.join(workspace, SENTINEL));
  return observed;
}

// Names of this machine that must never reach a committed file.
function leaks(text) {
  const names = [os.homedir(), os.tmpdir(), fs.realpathSync(os.tmpdir()), os.hostname(), os.userInfo().username, ROOT]
    .filter(n => n && n.length > 2);
  const found = names.filter(n => text.includes(n));
  for (const re of [/\/Users\/(?!me\b)/, /\/home\//, /\/private\//, /\/var\/folders\//, /[A-Z]:\\/, /[\u2013\u2014]/]) {
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
  const runRoot = createRunRoot();
  try {
    for (const [i, c] of CASES.entries()) {
      process.stderr.write(`[hook-block] ${c.name}\n`);
      cases.push({ name: c.name, observed: await runCase(bin, c, i, runRoot) });
    }
  } finally {
    removeRunRoot(runRoot);
  }
  const record = {
    about: 'What the installed Claude Code did with a tool call whose PreToolUse hook could not answer on standard output, measured by scripts/hook-block-truth/capture.js. test/unit/hook-block-capture.test.js holds it to what it claims.',
    runtimeVersion: version,
    method: `The real CLI in print mode (-p --permission-mode default --output-format stream-json --verbose --strict-mcp-config), in a fresh workspace whose .claude/settings.local.json allows Bash and registers one PreToolUse hook for Bash the way Rundock registers its own (a launcher started with sh, a timeout of 300 seconds), with fresh, empty HOME and CLAUDE_CONFIG_DIR folders, a placeholder API key, and a stand-in for the messages API on 127.0.0.1 that asked for one Bash call (${COMMAND}) and ended the turn once it had the result. No account was used and no model was called. The environment was a routine's inside Rundock (RUNDOCK set, no conversation), with a stand-in for Rundock's server that approved every card. Rundock's permission hook was started with Node in place of Rundock's runtime. The reader of its standard output was closed before it was given its input by scripts/hook-block-truth/reader-gone.js, which passes on its exit code and standard error. Paths are relative to the case's folder.`,
    cases,
  };
  const body = `${JSON.stringify(record, null, 2)}\n`;
  const found = leaks(body);
  if (found.length) {
    process.stderr.write(`[hook-block] refusing: the record would carry ${found.join(', ')}\n`);
    process.exit(1);
  }
  if (write) {
    fs.writeFileSync(RECORD, body);
    process.stderr.write(`[hook-block] wrote ${path.relative(ROOT, RECORD)} for Claude Code ${version}\n`);
    return;
  }
  process.stdout.write(body);
  const committed = fs.existsSync(RECORD) ? JSON.parse(fs.readFileSync(RECORD, 'utf8')) : null;
  const same = committed && JSON.stringify(committed.cases) === JSON.stringify(record.cases);
  process.stderr.write(same
    ? `[hook-block] Claude Code ${version} matches the record (made with ${committed.runtimeVersion})\n`
    : `[hook-block] Claude Code ${version} differs from the record${committed ? ` (made with ${committed.runtimeVersion})` : ''}: run with --write and read the diff\n`);
  process.exit(same ? 0 : 1);
}

module.exports = { createRunRoot, caseFolders, removeRunRoot };

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`[hook-block] ${e.stack || e.message}\n`);
    process.exit(1);
  });
}
