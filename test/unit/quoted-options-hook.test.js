'use strict';
// THROUGH THE REAL HOOK: a quoted or escaped option of find, rg, tree or file
// is the option, so the crossing it makes is reported, in Notes mode and in
// Code mode, exactly as the unquoted line's is.
//
// The hook frees a persistence surface under the runtime's own home for a
// command the shared definition (public/read-only-shell.js) reads as a read,
// and counts a read as not writing an answer file. That definition now judges
// each option as the shell hands it to the program, so `'-fprintf'` is
// `-fprintf`, and a line whose commands split where the shell splits them
// shows each one.
//
// Each case runs the hook as its own process, the way the runtime does,
// against a stand-in for Rundock that records what the hook asked and answers
// no. The home is a scratch folder outside every temp folder and git working
// tree (see the helper), never the real one.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const fx = require('../helpers/code-mode-fixture.js');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');
const SHARED = path.join(__dirname, '..', '..', 'public', 'read-only-shell.js');

const root = fx.outsideTempRoot();
const SKIP = root.skip || false;
let home, ws, settings, hooks, answers, readingFails;
const asked = new Map();
let server;

before(async () => {
  if (SKIP) return;
  home = path.join(root.dir, 'home');
  ws = path.join(home, 'Workspace');
  hooks = path.join(home, '.claude', 'hooks');
  settings = path.join(home, '.claude', 'settings.json');
  answers = path.join(ws, '.rundock', 'permissions.json');
  fx.write(path.join(hooks, 'pretool.sh'), '');
  fx.write(settings, '{}\n');
  fx.write(path.join(home, '.claude', '.credentials.json'), '{}\n');
  fx.write(answers, '{}\n');
  fx.write(path.join(ws, 'notes', 'todo.md'), '- TODO one\n');
  // A FAILURE FORCED INSIDE THE SHARED DEFINITION, loaded ahead of the hook
  // with `--require`. The hook has no switch for it, so nothing in a tool call
  // can set it off: the seam can only make the reading fail.
  readingFails = path.join(root.dir, 'reading-fails.js');
  fs.writeFileSync(readingFails,
    `require(${JSON.stringify(SHARED)}).optionReadingSeam.beforeReading = () => { throw new Error('forced failure'); };\n`);
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url.startsWith('/api/permission-request')) {
        try { const d = JSON.parse(body); asked.set(d.session_id, d); } catch (e) { /* asserted by the callers */ }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ allow: false }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
});
after(async () => {
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  if (root.dir) fs.rmSync(root.dir, { recursive: true, force: true });
});

let seq = 0;
function runHook(command, { codeMode = false, preload } = {}) {
  const sid = `quoted-options-${process.pid}-${++seq}`;
  return new Promise((resolve) => {
    const args = [...(preload ? ['--require', preload] : []), HOOK];
    const proc = spawn(process.execPath, args, {
      env: {
        ...process.env, NODE_V8_COVERAGE: '', RUNDOCK: '1', RUNDOCK_PORT: String(server.address().port),
        RUNDOCK_WORKSPACE: ws, RUNDOCK_CODE_MODE: codeMode ? '1' : '', RUNDOCK_CONVO_ID: 'c1', HOME: home, USERPROFILE: home,
      },
    });
    const ending = setTimeout(() => proc.kill('SIGKILL'), 30000);
    let out = '';
    let err = '';
    proc.stdout.on('data', (c) => { out += c; });
    proc.stderr.on('data', (c) => { err += c; });
    proc.on('close', (status) => {
      clearTimeout(ending);
      let answer = null;
      try { answer = JSON.parse(out).hookSpecificOutput; } catch (e) { /* asserted below */ }
      resolve({ status, err, decision: answer && answer.permissionDecision, reason: (answer && answer.permissionDecisionReason) || '', card: asked.get(sid) || null });
    });
    proc.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', cwd: ws, session_id: sid, tool_name: 'Bash', tool_input: { command } }));
  });
}

const MODES = [['Notes mode', false], ['Code mode', true]];
const under = (p, file) => p === file || p.startsWith(file + path.sep);
// The crossings a card names that write a persistence surface at `target`.
const writesAt = (r, target) => ((r.card && r.card.crossings) || [])
  .filter((c) => c.persistenceSurface && c.write && under(c.path, fs.realpathSync(target)));
function assertCardsWrite(r, target, command) {
  assert.strictEqual(r.status, 0, r.err);
  assert.ok(r.card, `the hook asked nobody: ${JSON.stringify(command)}`);
  assert.strictEqual(r.card.boundary, true, `no crossing was reported: ${JSON.stringify(command)}`);
  assert.ok(writesAt(r, target).length > 0, `the card does not name the file as written: ${JSON.stringify(r.card.crossings)}`);
  assert.strictEqual(r.decision, 'deny', 'and the answer it was given, no, is the answer');
}
function assertFreed(r, command) {
  assert.strictEqual(r.status, 0, r.err);
  assert.notStrictEqual(r.card && r.card.boundary, true, `a read of the runtime's home raised a crossing: ${command}`);
}

// Each quoted or escaped writing line beside the unquoted one it is read as.
const quotedBesidePlain = () => [
  [`find . -maxdepth 0 '-fprintf' ${settings} x`, `find . -maxdepth 0 -fprintf ${settings} x`, settings],
  [`find . -maxdepth 0 \\-fprintf ${settings} x`, `find . -maxdepth 0 -fprintf ${settings} x`, settings],
  [`find ${hooks} -fpr'int'f ${settings} x`, `find ${hooks} -fprintf ${settings} x`, settings],
  [`rg '--pre' sh x ${hooks}`, `rg --pre sh x ${hooks}`, hooks],
  [`rg "--pre=sh" x ${hooks}`, `rg --pre=sh x ${hooks}`, hooks],
  [`tree '-o' ${settings}`, `tree -o ${settings}`, settings],
  [`tree -a"o" ${settings}`, `tree -ao ${settings}`, settings],
  [`file '-C' -m ${settings}`, `file -C -m ${settings}`, settings],
  [`file "--compile" -m ${settings}`, `file --compile -m ${settings}`, settings],
];

describe('through the real hook, a quoted option crosses exactly as the unquoted one does', { skip: SKIP }, () => {
  for (const [mode, codeMode] of MODES) {
    test(`${mode}: find with a quoted -fprintf into the runtime's settings is a write crossing`, async () => {
      const command = `find . -maxdepth 0 '-fprintf' ${settings} x`;
      const quoted = await runHook(command, { codeMode });
      const plain = await runHook(`find . -maxdepth 0 -fprintf ${settings} x`, { codeMode });
      assertCardsWrite(plain, settings, 'the unquoted line');
      assertCardsWrite(quoted, settings, command);
      assert.deepStrictEqual(quoted.card.crossings, plain.card.crossings, 'the same crossings as the unquoted line');
      if (codeMode) assert.notStrictEqual(quoted.reason, 'Auto-approved: workspace is in Code mode', 'Code mode cards it');
    });

    test(`${mode}: every quoted or escaped writing option crosses as its unquoted twin`, async () => {
      for (const [quoted, plain, target] of quotedBesidePlain()) {
        const q = await runHook(quoted, { codeMode });
        const p = await runHook(plain, { codeMode });
        assertCardsWrite(p, target, plain);
        assertCardsWrite(q, target, quoted);
        assert.deepStrictEqual(q.card.crossings, p.card.crossings, `the same crossings: ${quoted}`);
      }
    });

    test(`${mode}: a quoted -fprintf into the workspace's answer file is an answer-file write`, async () => {
      const quoted = await runHook("find . -maxdepth 0 '-fprintf' .rundock/permissions.json x", { codeMode });
      const plain = await runHook('find . -maxdepth 0 -fprintf .rundock/permissions.json x', { codeMode });
      for (const r of [plain, quoted]) {
        assert.strictEqual(r.status, 0, r.err);
        assert.ok(r.card && (r.card.crossings || []).some((c) => c.answerFile && c.path === fs.realpathSync(answers)),
          `asked as a write of the answer file: ${JSON.stringify(r.card)}`);
        assert.strictEqual(r.decision, 'deny', 'and refused on the answer no');
      }
      assert.deepStrictEqual(quoted.card.crossings, plain.card.crossings, 'about the same file, as the unquoted line');
    });

    test(`${mode}: an escaped quote hides no command, so a copy over the settings on the next line is a write crossing`, async () => {
      for (const command of [`ls \\"\ncp x ${settings}\necho \\"`, `ls \\'\ncp x ${settings}\necho \\'`,
        `ls \\"; cp x ${settings}; echo \\"`]) {
        assertCardsWrite(await runHook(command, { codeMode }), settings, command);
      }
    });

    test(`${mode}: the reading forms beside them are still freed`, async () => {
      for (const command of [`find ${hooks} -name '*.sh'`, `find ${hooks} -name "*.sh" -type f`, `rg 'two words' ${hooks}`,
        `rg -n "x" ${hooks}`, `tree -L 2 ${hooks}`, `file ${settings}`, `ls '${hooks}'`]) {
        assertFreed(await runHook(command, { codeMode }), command);
      }
    });
  }

  // THE UNDO: a refused card leaves nothing behind it.
  test('a card for a quoted tree -o into the settings is denied, and the next tree -L 2 is freed', async () => {
    const writes = `tree '-o' ${settings}`;
    assertCardsWrite(await runHook(writes), settings, writes);
    assertFreed(await runHook(`tree -L 2 ${path.join(home, '.claude')}`), 'the listing after the refusal');
  });

  // THE RETRY: the same quoted line asks again, in the same words.
  test('the same quoted writing line sent twice asks both times, about the same place', async () => {
    const writes = `rg '--pre' sh x ${hooks}`;
    const first = await runHook(writes);
    const again = await runHook(writes);
    assertCardsWrite(first, hooks, writes);
    assertCardsWrite(again, hooks, writes);
    assert.strictEqual(again.reason, first.reason, 'in the words of the first asking');
    assert.deepStrictEqual(again.card.crossings, first.card.crossings, 'and about the same place');
  });

  // THE CONTROL FAILING: a failure inside the reading frees nothing.
  for (const [mode, codeMode] of MODES) {
    test(`${mode}: a failure forced inside the reading asks about the search as a write, and never frees it`, async () => {
      for (const command of [`find ${hooks} -name '*.sh'`, `rg -n x ${hooks}`, `tree -L 2 ${hooks}`, `file ${settings}`]) {
        assertFreed(await runHook(command, { codeMode }), `sanity, with nothing forced: ${command}`);
        const target = command.startsWith('file') ? settings : hooks;
        assertCardsWrite(await runHook(command, { codeMode, preload: readingFails }), target, command);
      }
    });
  }
});
