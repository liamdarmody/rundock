#!/usr/bin/env node
'use strict';
// WHERE A RELOCATED RUNTIME HOME KEEPS ITS SECRETS, MEASURED.
//
// Claude Code reads CLAUDE_CONFIG_DIR, and Codex reads CODEX_HOME, as the
// folder to keep their state in place of `~/.claude` and `~/.codex`. The
// permission hook's secrets registry follows each variable only as far as this
// record says: a file joins the registry under the variable's folder because
// the real, installed CLI was seen to put it there, never because a document
// or a guess said so. test/unit/runtime-home-capture.test.js holds the record
// to what it claims, in CI, which has neither CLI, and binds the hook's list
// to it.
//
// HOW EACH CASE RUNS. Every folder the CLI is given is fresh and empty: HOME,
// the variable's folder (a sibling of HOME, so the two cannot be confused),
// the workspace and the temp folder. The API key is a placeholder.
//   - Claude Code runs twice in print mode against a stand-in for the messages
//     API on 127.0.0.1, which answers every request with one line of text, so
//     it writes its account state and, on the second run, whatever copy of it
//     it keeps. No account is used and no model is called.
//   - Codex is given the placeholder key with `codex login --with-api-key`,
//     told to keep it in a file rather than the system keyring, so it writes
//     its credential file without reaching any service.
// Afterwards every file and folder under HOME and under the variable's folder
// is listed, and the record says where each named file landed.
//
// WHAT IS NOT MEASURED, AND WHY. Claude Code writes its credential file only
// when a person signs in, which this harness never does, and on macOS it keeps
// the credential in the Keychain, which this harness never touches. So the
// record says where that file would be read is not measured, and the registry
// is not extended with it on the strength of this record. A CLI that is not
// installed is recorded as not measured too, never guessed.
//
// RUN BY HAND, NEVER BY THE SUITE OR CI: it needs real installs, and it is not
// a *.test.js file, so `npm test` does not collect it.
//
//   node scripts/runtime-home-truth/capture.js           measure, compare with the record
//   node scripts/runtime-home-truth/capture.js --write   measure, and write the record
//
// CLAUDE_BIN and CODEX_BIN name the binaries; otherwise the ones on PATH. The
// test stub is refused. Every case runs in a folder made new for the run,
// private to this user and outside the repository, and removed afterwards.
// The record holds no path, user or machine name: paths are written relative
// to the case's folders, and a record that would still carry one of this
// machine's names is refused rather than written.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { scrubCapture } = require('../capture-scrub.js');

const ROOT = path.join(__dirname, '..', '..');
const RECORD = path.join(__dirname, 'captured-runtime-homes.json');
const STUB_DIR = path.join(ROOT, 'test', 'helpers', 'stub-claude');
const CASE_TIMEOUT_MS = 120000;
const PLACEHOLDER_KEY = 'placeholder-not-a-key';

function resolveBin(name, envName) {
  try {
    const bin = process.env[envName] || execFileSync('which', [name], { encoding: 'utf8' }).trim();
    const real = fs.realpathSync(bin);
    if (real.startsWith(fs.realpathSync(STUB_DIR))) throw new Error(`refusing to run: ${name} resolves to the test stub`);
    return { bin };
  } catch (e) {
    if (/test stub/.test(e.message)) throw e;
    return { missing: `no ${name} CLI could be found or opened on this machine` };
  }
}

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

// The stand-in for the messages API: one line of text for every request, and
// a note of which credential each request carried.
function messagesApi() {
  const auth = new Set();
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.headers['x-api-key']) auth.add(req.headers['x-api-key'] === PLACEHOLDER_KEY ? 'the placeholder key' : 'another key');
      if (req.headers.authorization) auth.add('a bearer token');
      if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end('{}');
      }
      if (req.url.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ input_tokens: 1 }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const events = [
        ['message_start', { message: { id: 'msg_text', type: 'message', role: 'assistant', model: 'stand-in', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
        ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } }],
        ['content_block_stop', { index: 0 }],
        ['message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
        ['message_stop', {}],
      ];
      for (const [type, data] of events) res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      res.end();
    });
  });
  return { server, auth };
}

// THE RUN'S OWN FOLDER, made new and private (mode 0700) outside the
// repository, for the reasons scripts/hook-block-truth/capture.js gives: no
// fixed path is ever cleared, and removing the run's folder removes a link put
// in its place as a link, never what it leads to.
function createRunRoot(tmp = os.tmpdir()) {
  return fs.mkdtempSync(path.join(tmp, 'rundock-runtime-home-'));
}
function caseFolders(runRoot, name) {
  const root = path.join(runRoot, name);
  fs.mkdirSync(root);
  const dirs = { root, home: path.join(root, 'home'), relocated: path.join(root, 'relocated'), workspace: path.join(root, 'workspace'), tmp: path.join(root, 'tmp') };
  for (const d of [dirs.home, dirs.relocated, dirs.workspace, dirs.tmp]) fs.mkdirSync(d);
  return dirs;
}
function removeRunRoot(runRoot) {
  fs.rmSync(runRoot, { recursive: true, force: true });
}

// The environment each CLI is given: this one's, less anything that would
// lead it to a real account, then the case's folders.
function baseEnv(dirs) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^(CLAUDE|ANTHROPIC|CODEX|OPENAI|RUNDOCK|XDG_|NODE_OPTIONS$|NODE_TEST_CONTEXT$)/.test(k)) env[k] = v;
  }
  return { ...env, HOME: dirs.home, TMPDIR: dirs.tmp };
}

// Every file and folder under `dir`, relative to it, folders ending in `/`.
// Links are listed, never followed. Names the runtime makes from a time, an
// id or a folder's path are written as placeholders, so a second capture
// differs only where the runtime changed.
function listTree(dir, scrub) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { out.push(`${r}/`); walk(path.join(d, e.name), r); } else out.push(r);
    }
  };
  walk(dir, '');
  return [...new Set(out.map(scrub))];
}

function scrubber(dirs) {
  const plain = [...new Set(Object.values(dirs).flatMap(d => [d, fs.realpathSync(d)]))].sort((a, b) => b.length - a.length);
  const encoded = plain.map(d => d.replace(/[/.]/g, '-'));
  return (s) => {
    let out = String(s);
    for (const d of plain) out = out.split(d).join('<case>');
    for (const d of encoded) out = out.split(d).join('<case>');
    out = out.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>').replace(/\d{10,}/g, '<time>');
    return scrubCapture(out);
  };
}

function run(bin, argv, opts, input) {
  return new Promise((resolve) => {
    const child = spawn(bin, argv, { ...opts, stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    child.stdout.resume();
    child.stderr.on('data', (d) => { err += d; });
    child.stdin.on('error', () => { /* it may not read its input */ });
    child.stdin.end(input || '');
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: 'timeout', err }); }, CASE_TIMEOUT_MS);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, err }); });
  });
}

const firstError = (err, scrub) => {
  const line = err.split('\n').map(l => l.trim()).find(l => /error/i.test(l));
  return line ? scrub(line) : undefined;
};

function where(name, homeTree, relocatedTree) {
  const at = [];
  if (homeTree.includes(name)) at.push('home');
  if (relocatedTree.includes(name)) at.push('relocated');
  return at;
}

async function claudeCase(runRoot) {
  const found = resolveBin('claude', 'CLAUDE_BIN');
  if (found.missing) return { variable: 'CLAUDE_CONFIG_DIR', measured: false, reason: found.missing };
  const version = execFileSync(found.bin, ['--version'], { encoding: 'utf8' }).trim().split(/\s+/)[0] || null;
  const dirs = caseFolders(runRoot, 'claude');
  const scrub = scrubber(dirs);
  const api = messagesApi();
  const port = await listen(api.server);
  const env = {
    ...baseEnv(dirs),
    CLAUDE_CONFIG_DIR: dirs.relocated,
    CLAUDE_CODE_TMPDIR: dirs.tmp,
    ANTHROPIC_API_KEY: PLACEHOLDER_KEY,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  const argv = ['-p', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--max-turns', '1', 'Say ok.'];
  const runs = [];
  for (let i = 0; i < 2; i++) runs.push(await run(found.bin, argv, { cwd: dirs.workspace, env }));
  api.server.close();
  const home = listTree(dirs.home, scrub);
  const relocated = listTree(dirs.relocated, scrub);
  const out = {
    variable: 'CLAUDE_CONFIG_DIR',
    runtimeVersion: version,
    measured: runs.every(r => r.code === 0),
    cliExitCodes: runs.map(r => r.code),
    credentialSent: [...api.auth].sort(),
    created: { home, relocated },
    files: {
      '.claude.json': where('.claude.json', home, relocated),
      '.claude.json.backup': where('.claude.json.backup', home, relocated),
      'backups/': where('backups/', home, relocated),
      '.credentials.json': where('.credentials.json', home, relocated),
    },
    notMeasured: {
      '.credentials.json': 'Claude Code writes its credential file only when a person signs in, which this harness never does, and on macOS it keeps the credential in the Keychain, which this harness never touches.',
    },
  };
  const error = runs.map(r => firstError(r.err, scrub)).find(Boolean);
  if (error) out.cliError = error;
  if (!out.measured) out.reason = 'the CLI did not finish both runs';
  return out;
}

async function codexCase(runRoot) {
  const found = resolveBin('codex', 'CODEX_BIN');
  if (found.missing) return { variable: 'CODEX_HOME', measured: false, reason: found.missing };
  let version = null;
  try { version = (execFileSync(found.bin, ['--version'], { encoding: 'utf8' }).match(/\d+\.\d+\.\d+/) || [null])[0]; } catch (e) { /* recorded as unknown */ }
  const dirs = caseFolders(runRoot, 'codex');
  const scrub = scrubber(dirs);
  const env = { ...baseEnv(dirs), CODEX_HOME: dirs.relocated };
  const r = await run(found.bin, ['login', '--with-api-key', '-c', 'cli_auth_credentials_store="file"'], { cwd: dirs.workspace, env }, `${PLACEHOLDER_KEY}\n`);
  const home = listTree(dirs.home, scrub);
  const relocated = listTree(dirs.relocated, scrub);
  const out = {
    variable: 'CODEX_HOME',
    runtimeVersion: version,
    measured: r.code === 0,
    cliExitCodes: [r.code],
    created: { home, relocated },
    files: { 'auth.json': where('auth.json', home, relocated) },
  };
  const error = firstError(r.err, scrub);
  if (error) out.cliError = error;
  if (!out.measured) out.reason = 'the CLI did not finish its sign-in with the placeholder key';
  return out;
}

// Names of this machine that must never reach a committed file.
function leaks(text) {
  let user = '';
  try { user = os.userInfo().username; } catch (e) { user = process.env.USER || ''; }
  const names = [os.homedir(), os.tmpdir(), fs.realpathSync(os.tmpdir()), os.hostname(), user, ROOT].filter(n => n && n.length > 2);
  const found = names.filter(n => text.includes(n));
  for (const re of [/\/Users\/(?!me\b)/, /\/home\//, /\/private\//, /\/var\/folders\//, /[A-Z]:\\/, /[\u2013\u2014]/]) {
    if (re.test(text)) found.push(String(re));
  }
  return found;
}

async function main() {
  const write = process.argv.includes('--write');
  const runRoot = createRunRoot();
  const runtimes = {};
  try {
    process.stderr.write('[runtime-home] Claude Code with CLAUDE_CONFIG_DIR set\n');
    runtimes.claude = await claudeCase(runRoot);
    process.stderr.write('[runtime-home] Codex with CODEX_HOME set\n');
    runtimes.codex = await codexCase(runRoot);
  } finally {
    removeRunRoot(runRoot);
  }
  const record = {
    about: 'Where the installed Claude Code and Codex put their account state and credential files when CLAUDE_CONFIG_DIR and CODEX_HOME name a folder, measured by scripts/runtime-home-truth/capture.js. test/unit/runtime-home-capture.test.js holds it to what it claims.',
    method: `Fresh, empty folders for HOME, the variable's folder (a sibling of HOME), the workspace and the temp folder, and a placeholder API key. Claude Code ran twice in print mode (-p --output-format stream-json --verbose --strict-mcp-config --max-turns 1) against a stand-in for the messages API on 127.0.0.1 that answered every request with one line of text. Codex was given the placeholder key with codex login --with-api-key, told to keep it in a file (cli_auth_credentials_store="file"). No account was used, no model was called, and the Keychain was never touched. Then every file and folder under HOME and under the variable's folder was listed: "home" and "relocated" say where each named file landed. Names made from a time, an id or a folder's path are written as placeholders.`,
    runtimes,
  };
  const body = `${JSON.stringify(record, null, 2)}\n`;
  const found = leaks(body);
  if (found.length) {
    process.stderr.write(`[runtime-home] refusing: the record would carry ${found.join(', ')}\n`);
    process.exit(1);
  }
  if (write) {
    fs.writeFileSync(RECORD, body);
    process.stderr.write(`[runtime-home] wrote ${path.relative(ROOT, RECORD)}\n`);
    return;
  }
  process.stdout.write(body);
  const committed = fs.existsSync(RECORD) ? JSON.parse(fs.readFileSync(RECORD, 'utf8')) : null;
  const same = committed && JSON.stringify(committed.runtimes) === JSON.stringify(record.runtimes);
  process.stderr.write(same ? '[runtime-home] matches the record\n' : '[runtime-home] differs from the record: run with --write and read the diff\n');
  process.exit(same ? 0 : 1);
}

module.exports = { createRunRoot, caseFolders, removeRunRoot, listTree, leaks };

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`[runtime-home] ${e.stack || e.message}\n`);
    process.exit(1);
  });
}
