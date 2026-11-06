'use strict';
// NOTHING ELSE GAINS A CARD, field by field. The commands near a credential
// file that must keep their answer (a bare word in the workspace, a free file
// after `cd ~/.claude`, a glob that cannot reach a credential file, a `cd`
// that fails before the read, and the file a credential link leads to, read by
// its own path) are run through the real hook, and the whole answer and every
// card request it sends are compared with what main's hook sends for the same
// command. A card is drawn from that request, so an identical request is an
// identical card.
//
// The expected values are test/fixtures/secret-reach-on-main.json, recorded by
// running this file against main's hook:
//
//   git show origin/main:scripts/permission-hook.js > scripts/.main-hook.js
//   RUNDOCK_RECORD_HOOK="$PWD/scripts/.main-hook.js" node --test test/unit/secret-reach-on-main.test.js
//
// Paths under the temporary folder are written as `<root>`, and each request's
// session id, which differs per run, is left out.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const RECORD = process.env.RUNDOCK_RECORD_HOOK || '';
const HOOK = RECORD || path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'secret-reach-on-main.json');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'secret-reach-on-main-')));
const home = path.join(root, 'home');
const ws = path.join(root, 'ws');
// `elsewhere` stands for any other folder, such as `/tmp`, kept under the
// temporary root so every path in a request is written the same on any host.
for (const d of [path.join(home, '.claude', 'projects'), path.join(home, '.codex'), path.join(ws, 'sub'), path.join(ws, '.claude'), path.join(root, 'elsewhere')]) fs.mkdirSync(d, { recursive: true });
for (const f of ['.claude/.credentials.json', '.claude/.config.json', '.claude/settings.json', '.codex/auth.json', '.claude.json']) fs.writeFileSync(path.join(home, f), '{}');
// A credential file that is a link, to a file in a temporary folder.
const linked = path.join(root, 'linked');
fs.mkdirSync(path.join(linked, '.claude'), { recursive: true });
fs.mkdirSync(path.join(root, 'store'));
fs.writeFileSync(path.join(root, 'store', 'credentials.json'), '{}');
fs.symlinkSync(path.join(root, 'store', 'credentials.json'), path.join(linked, '.claude', '.credentials.json'));

const POSIX = process.platform === 'win32' ? 'the home folder and links are read the POSIX way here' : false;
const MODES = [['Notes mode', {}], ['Code mode', { RUNDOCK_CODE_MODE: '1' }]];
// [tool, input, home]
const CONTROLS = [
  ...[
    'cat notes.md', 'ls dist', 'cat auth.json', 'cat sub/auth.json', 'cd sub && cat auth.json',
    'cd ~/.claude && ls', 'cd ~/.claude && ls projects', 'cd ~/.claude && cat settings.json', 'cat ~/.claude/settings.json',
    'ls ~/.claude/projects/*', 'cat ~/.codex/config.*',
    'cd <root>/elsewhere && cat .credentials.json', 'cd ~/.claude && cd <root>/elsewhere && cat .credentials.json',
    // The second cd fails, and with `&&` the read never runs.
    'cd ~/.claude && cd ./nonexistent && cat .credentials.json',
  ].map(command => ['Bash', { command }, 'home']),
  // The file a credential link leads to, by its own path.
  ['Bash', { command: 'cat <root>/store/credentials.json' }, 'linked'],
  ['Read', { file_path: '<root>/store/credentials.json' }, 'linked'],
];
const keyOf = (label, [tool, input, h]) => `${label} | ${tool} | ${JSON.stringify(input)} | ${h}`;
const live = v => JSON.parse(JSON.stringify(v).split('<root>').join(root));
const normal = v => JSON.parse(JSON.stringify(v).split(root).join('<root>'));

const asked = new Map();
let server;
let port;
let runs = 0;
const recorded = {};
before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (!req.url.startsWith('/api/permission-request')) { res.statusCode = 404; res.end(); return; }
      const request = JSON.parse(body);
      if (!asked.has(request.session_id)) asked.set(request.session_id, []);
      asked.get(request.session_id).push(request);
      res.end(JSON.stringify({ allow: false }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(async () => {
  if (server) await new Promise(r => server.close(r));
  if (RECORD) fs.writeFileSync(FIXTURE, JSON.stringify(Object.fromEntries(Object.keys(recorded).sort().map(k => [k, recorded[k]])), null, 1) + '\n');
  fs.rmSync(root, { recursive: true, force: true });
});

function run(tool, input, homeDir, env) {
  const session = `s${++runs}`;
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [HOOK], {
      env: {
        ...process.env, HOME: homeDir, USERPROFILE: homeDir, NODE_V8_COVERAGE: '',
        RUNDOCK: '1', RUNDOCK_PORT: String(port), RUNDOCK_WORKSPACE: ws, RUNDOCK_CONVO_ID: '', RUNDOCK_CODE_MODE: '', ...env,
      },
    });
    let out = '';
    proc.stdout.on('data', (c) => { out += c; });
    proc.on('close', () => {
      let answer = null;
      try { answer = JSON.parse(out); } catch (e) { /* asserted below */ }
      const cards = (asked.get(session) || []).map(({ session_id: _drop, ...rest }) => rest);
      resolve(normal({ answer, cards }));
    });
    proc.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', cwd: ws, session_id: session, tool_name: tool, tool_input: input }));
  });
}

describe('the commands that keep their answer send exactly what main sends', { skip: POSIX, concurrency: 8 }, () => {
  const onMain = RECORD ? {} : JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  for (const [label, env] of MODES) {
    for (const control of CONTROLS) {
      const [tool, input, h] = control;
      test(`${label}: ${tool} ${JSON.stringify(input)}`, async () => {
        const got = await run(tool, live(input), h === 'linked' ? linked : home, env);
        if (RECORD) { recorded[keyOf(label, control)] = got; return; }
        const expected = onMain[keyOf(label, control)];
        assert.ok(expected, 'measured on main');
        assert.ok(got.answer, 'the hook answered');
        assert.ok(!got.cards.some(c => (c.crossings || []).some(x => x.secret)), 'no secret card');
        assert.deepStrictEqual(got, expected, 'the whole answer, and every card request, as main sends them');
      });
    }
  }
});
