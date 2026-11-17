'use strict';
// NOTHING ELSE CHANGES ITS CARD, field by field. Reading each shell word as
// bash joins it only adds crossings, so a line with no quoted path in it, or
// one whose quotes hold an ordinary name (`cat "notes/a b.md"`), must send
// exactly what main's hook sends: a spelling past the commands that never
// name a path (echo, printf, a pattern for grep or sed, a delimiter for cut or
// tr), the plain spellings of the files near a credential file, and the
// spellings that already asked before (an escaped character, a `cd` into the
// folder). Each is run through the real hook, and the whole answer and every
// card request it sends are compared with what main's hook sends. A card is
// drawn from that request, so an identical request is an identical card.
//
// A write to a file named in quotes asks with the card main raises for the
// same write spelled plainly: the same request but for the command's own text
// and the label scanned from it, which is not drawn on a crossing's card.
//
// The expected values are test/fixtures/joined-path-words-on-main.json,
// recorded by running this file against main's hook:
//
//   git show origin/main:scripts/permission-hook.js > scripts/.main-hook.js
//   RUNDOCK_RECORD_HOOK="$PWD/scripts/.main-hook.js" node --test test/unit/joined-path-words-on-main.test.js
//
// Paths under the temporary folder are written as `<root>`, and each request's
// session id, which differs per run, is left out. A card names a path by its
// real location, and on macOS `/etc` is a link to `/private/etc`, so that real
// folder is written as `/etc` and one recording holds on every POSIX host.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const RECORD = process.env.RUNDOCK_RECORD_HOOK || '';
const HOOK = RECORD || path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'joined-path-words-on-main.json');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'joined-path-words-on-main-')));
const home = path.join(root, 'home');
const ws = path.join(root, 'ws');
for (const d of [path.join(home, '.claude', 'projects'), path.join(home, '.codex'), path.join(ws, 'notes'), path.join(ws, 'My Notes')]) fs.mkdirSync(d, { recursive: true });
for (const f of ['.claude/.credentials.json', '.claude/.config.json', '.claude/settings.json', '.codex/auth.json', '.claude.json']) fs.writeFileSync(path.join(home, f), '{}');
fs.writeFileSync(path.join(ws, 'notes.md'), '# notes\n');
fs.writeFileSync(path.join(ws, 'notes', 'a b.md'), '# a b\n');

const POSIX = process.platform === 'win32' ? 'the home folder and quotes are read the POSIX way here' : false;
const MODES = [['Notes mode', {}], ['Code mode', { RUNDOCK_CODE_MODE: '1' }]];
const CONTROLS = [
  // Quotes around an ordinary name in the workspace.
  'cat "notes/a b.md"', 'cat notes/"a b".md', "ls 'My Notes'", "cat './notes/a b.md'", 'ls "My Notes"', 'cat "notes/a b.md" | head -5',
  'echo "x" > "notes/out.md"', 'cat notes.md',
  // Words that never name a path.
  'echo ~/.claude/".credentials.json"', "printf '%s\\n' \"~/.claude/.credentials.json\"", 'echo "/etc/hosts"', 'echo "$HOME"',
  'grep "/etc/x" notes.md', 'grep -e "/etc/x" notes.md', "sed 's#/a#/b#' notes.md",
  "tr -d '/' < notes.md", "tr '/' '_' < notes.md", "cut -d '/' -f2 notes.md", "awk -F '/' '{print $2}' notes.md", "sort -t '/' -k2 notes.md",
  'IFS=\'/\' read -r a b <<< "$x"', 'git commit -m "fix: update notes"', 'date "+%Y/%m/%d"', 'find . -name "*.md"',
  // The plain spellings, and the spellings that already asked.
  'cat ~/.claude/.credentials.json', 'cat ~/\\.claude/.credentials.json', 'cd ~/.claude && cat .credentials.json',
  'echo x >> ~/.claude/settings.json', 'echo x > ~/.claude/.credentials.json', 'echo x >> ~/.zshrc',
];
// [quoted, the plain spelling main is compared on]
const WRITES = [
  ['echo x >> ~/.claude/"settings.json"', 'echo x >> ~/.claude/settings.json'],
  ["echo x >> ~/.claude/'settings'.json", 'echo x >> ~/.claude/settings.json'],
  ['echo x > ~/.claude/".credentials.json"', 'echo x > ~/.claude/.credentials.json'],
];
const keyOf = (label, command) => `${label} | ${command}`;
const ETC = process.platform === 'win32' ? '/etc' : fs.realpathSync('/etc');
const normal = v => JSON.parse(JSON.stringify(v).split(root).join('<root>').split(`"${ETC}/`).join('"/etc/'));
const drawn = ({ tool_input: _input, advisory_outside_paths: _label, ...card }) => card;

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

function run(command, env) {
  const session = `s${++runs}`;
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [HOOK], {
      env: {
        ...process.env, HOME: home, USERPROFILE: home, NODE_V8_COVERAGE: '',
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
    proc.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', cwd: ws, session_id: session, tool_name: 'Bash', tool_input: { command } }));
  });
}

describe('lines with no quoted path near a credential file send exactly what main sends', { skip: POSIX, concurrency: 8 }, () => {
  const onMain = RECORD ? {} : JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  for (const [label, env] of MODES) {
    for (const command of CONTROLS) {
      test(`${label}: ${command}`, async () => {
        const got = await run(command, env);
        if (RECORD) { recorded[keyOf(label, command)] = got; return; }
        const expected = onMain[keyOf(label, command)];
        assert.ok(expected, 'measured on main');
        assert.ok(got.answer, 'the hook answered');
        assert.deepStrictEqual(got, expected, 'the whole answer, and every card request, as main sends them');
      });
    }
    for (const [command, plain] of RECORD ? [] : WRITES) {
      test(`${label}: ${command} asks with the card main raises for ${plain}`, async () => {
        const got = await run(command, env);
        const expected = onMain[keyOf(label, plain)];
        assert.ok(expected && expected.cards.length === 1, `measured on main: ${plain} asks`);
        assert.deepStrictEqual(got.answer, expected.answer, 'the same answer');
        assert.deepStrictEqual(got.cards.map(drawn), expected.cards.map(drawn), 'the same card');
      });
    }
  }
});
