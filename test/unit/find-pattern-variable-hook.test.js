'use strict';
// THROUGH THE REAL HOOK: a find line whose pattern is a quoted variable is
// answered as the same line with a plain word in its place, in Notes mode and
// in Code mode.
//
// Inside double quotes a plain `$NAME` or `${NAME}` is one word in bash and in
// zsh, and find takes the word after a pattern primary such as `-name` as the
// pattern, whatever it says. The shared definition (public/read-only-shell.js)
// reads such a line, so the hook no longer judges the folders it names as
// written: a search that prunes `.rundock` reports no crossing. Every other
// variable still asks.
//
// Each case runs the hook as its own process, the way the runtime does,
// against a stand-in for Rundock that records what the hook asked and answers
// no. In Notes mode the hook asks Rundock about every shell line, and Rundock
// answers one that carries no grade of the hook's own by the window's
// decision, so a read is allowed with no card. The same lines through the real
// server, with no window, are in test/integration/read-only-without-window.test.js.
// The home is a scratch folder outside every temp folder and git working tree
// (see the helper), never the real one.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const fx = require('../helpers/code-mode-fixture.js');
const P = require('../../public/permissions.js');
const S = require('../../public/read-only-shell.js');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');
const SHARED = path.join(__dirname, '..', '..', 'public', 'read-only-shell.js');

const root = fx.outsideTempRoot();
const SKIP = root.skip || false;
let home, ws, hooks, readingFails;
const asked = new Map();
let server;

before(async () => {
  if (SKIP) return;
  home = path.join(root.dir, 'home');
  ws = path.join(home, 'Workspace');
  hooks = path.join(home, '.claude', 'hooks');
  fx.write(path.join(hooks, 'pretool.sh'), '');
  fx.write(path.join(ws, '.rundock', 'state.json'), '{}\n');
  fx.write(path.join(ws, 'notes', 'alpha.md'), '# alpha\n');
  fx.write(path.join(ws, 'notes', 'beta.md'), '# beta\n');
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
  const sid = `find-pattern-${process.pid}-${++seq}`;
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
const CODE_MODE_ALLOWS = 'Auto-approved: workspace is in Code mode';
// The grades the hook puts on a request, any one of which Rundock cards.
const HOOK_GRADES = ['boundary', 'answer_file', 'startup_file', 'credential'];
const show = (command) => JSON.stringify(command);
const SEARCH = (pattern) => 'for t in alpha beta; do echo "== $t"; '
  + `find . -path ./.git -prune -o -path ./.rundock -prune -o -name "${pattern}" -print; done`;

// What the window does with what the hook asked: a request carrying a grade of
// the hook's own is carded, and any other is decided as the window decides it.
function windowAnswer(card) {
  if (!card) return null;
  if (HOOK_GRADES.some((f) => card[f] !== undefined)) return 'card';
  const input = card.tool_input;
  const risk = P.classifyRisk('Bash', input);
  return P.decidePermission(risk, P.toolAllowKey('Bash', input), new Set(), card.code_mode_verdict, { toolName: 'Bash', input }).action;
}
// What the hook did with a line: its answer, whether it asked and what the
// window does with that, and the grades on what it asked. A crossing names the
// text it was read from, so the variable's name is put back as the plain word
// it stands beside.
function outcome(r) {
  assert.strictEqual(r.status, 0, r.err);
  const grade = {};
  for (const field of [...HOOK_GRADES, 'crossings', 'code_mode_verdict']) {
    if (r.card && r.card[field] !== undefined) grade[field] = r.card[field];
  }
  return JSON.parse(JSON.stringify({ decision: r.decision, reason: r.reason, asked: !!r.card, window: windowAnswer(r.card), grade })
    .replace(/\$\{t\}|\$t/g, 'alpha'));
}
// Answered as a read. In Code mode the hook allows it itself and asks nobody.
// In Notes mode it asks Rundock with no grade of its own, and the window's
// decision for the line is allow, unasked, as a low-risk read.
function assertAnsweredAsRead(r, command, codeMode) {
  assert.strictEqual(r.status, 0, r.err);
  if (codeMode) {
    assert.strictEqual(r.decision, 'allow', `Code mode allows it: ${show(command)}`);
    assert.strictEqual(r.reason, CODE_MODE_ALLOWS, show(command));
    assert.strictEqual(r.card, null, `and asks nobody: ${show(command)}`);
    return;
  }
  assert.ok(r.card, `the hook asked Rundock: ${show(command)}`);
  assert.deepStrictEqual(HOOK_GRADES.filter((f) => r.card[f] !== undefined), [], `with no grade of its own: ${JSON.stringify(r.card)}`);
  assert.strictEqual(r.card.code_mode_verdict, undefined, `and no verdict: ${show(command)}`);
  const input = r.card.tool_input;
  const risk = P.classifyRisk('Bash', input);
  assert.strictEqual(risk, 'low', `graded low: ${show(command)}`);
  assert.deepStrictEqual(P.decidePermission(risk, P.toolAllowKey('Bash', input), new Set(), undefined, { toolName: 'Bash', input }),
    { action: 'allow', reason: 'low-risk' }, `which the window allows with no card: ${show(command)}`);
}
// Asked about in Notes mode: a card the window raises, refused on the answer no.
function assertAsked(r, command) {
  assert.strictEqual(r.status, 0, r.err);
  assert.ok(r.card, `the hook asked Rundock: ${show(command)}`);
  const graded = HOOK_GRADES.some((f) => r.card[f] !== undefined);
  assert.ok(graded || P.classifyRisk('Bash', r.card.tool_input) !== 'low', `and the window cards it: ${JSON.stringify(r.card)}`);
  assert.strictEqual(r.decision, 'deny', `the answer it was given, no, is the answer: ${show(command)}`);
}

describe("through the real hook, a quoted variable that is find's pattern is answered as a plain word there", { skip: SKIP }, () => {
  // THE REPORTED LINE: a search over several names that prunes `.git` and
  // `.rundock`, in a workspace holding `.rundock/state.json`.
  test('the search over several names is a read, with no crossing', () => {
    assert.strictEqual(S.isReadOnlyShellCommand(SEARCH('$t.md')), true, 'the shared definition reads it');
    assert.strictEqual(S.isReadOnlyShellCommand(SEARCH('alpha.md')), true, 'as it reads the literal name');
  });

  for (const [mode, codeMode] of MODES) {
    test(`${mode}: the search over several names is answered as a read, as the literal name is`, async () => {
      const held = await runHook(SEARCH('$t.md'), { codeMode });
      const literal = await runHook(SEARCH('alpha.md'), { codeMode });
      assertAnsweredAsRead(literal, 'the literal name', codeMode);
      assertAnsweredAsRead(held, SEARCH('$t.md'), codeMode);
      assert.deepStrictEqual(outcome(held), outcome(literal), 'the same answer as the literal name');
    });

    test(`${mode}: each line of the new shape is answered as a read`, async () => {
      for (const command of ['find . -name "$t.md" -print', 'find notes -iname "${t}*"', 'find notes -name "$t*"',
        'find . -path ./.rundock -prune -o -name "$t.md" -print', 'find . -path "./$d/*" -print',
        'find . -regex ".*/${t}[.]md"', 'find . -lname "$t"', 'find . -wholename "./$a/$b.md"']) {
        assertAnsweredAsRead(await runHook(command, { codeMode }), command, codeMode);
      }
    });
  }

  // GENERATED: from the module's own pattern list and a set of templates,
  // reading and writing. Each line with the variable is answered, and graded
  // when asked, exactly as the line with a plain word in its place.
  const TEMPLATES = [
    (p) => `find . ${p} -print`,
    (p) => `find . -path ./.rundock -prune -o ${p} -print`,
    (p) => `find . ${p} -delete`,
    (p) => `find . ${p} -fprint .rundock/state.json`,
    (p) => `find . ${p} -exec cat {} \\;`,
    (p) => `find ${hooks} ${p} -delete`,
  ];
  for (const [mode, codeMode] of MODES) {
    test(`${mode}: a quoted variable as any pattern, in any template, is answered as the plain word is`, async () => {
      const patterns = S.namedOptions().find.patterns;
      assert.ok(patterns.length > 0, 'the module names its patterns');
      for (const primary of patterns) {
        const pairs = TEMPLATES.map((template) => [template(`${primary} "$t.md"`), template(`${primary} "alpha.md"`)]);
        const answers = await Promise.all(pairs.flat().map((command) => runHook(command, { codeMode })));
        pairs.forEach(([held, plain], i) => {
          assert.deepStrictEqual(outcome(answers[2 * i]), outcome(answers[2 * i + 1]), `answered as the plain word: ${show(held)}`);
          assert.strictEqual(S.isReadOnlyShellCommand(held), S.isReadOnlyShellCommand(plain), `the same verdict: ${show(held)}`);
          assert.strictEqual(P.classifyRisk('Bash', { command: held }), P.classifyRisk('Bash', { command: plain }), `the same risk: ${show(held)}`);
        });
      }
    });
  }
  test('a writing template asks either way, so the comparison is not of two reads', async () => {
    for (const template of TEMPLATES.slice(2)) {
      for (const word of ['"$t.md"', '"alpha.md"']) assertAsked(await runHook(template(`-name ${word}`)), template(`-name ${word}`));
    }
  });

  // THE INVERSE ACTION: the read, then the same search deleting what it finds.
  test('a search by a quoted variable reads, and the same search with -delete right after it asks', async () => {
    assertAnsweredAsRead(await runHook('find . -name "$t.md" -print'), 'the search', false);
    assertAsked(await runHook('find . -name "$t.md" -delete'), 'the delete after it');
  });

  // THE UNDO: a refused card leaves nothing behind it.
  test('a card for a quoted variable where find reads a path is denied, and the next search by it reads', async () => {
    const asPath = 'find . "$t"';
    assert.strictEqual(S.isReadOnlyShellCommand(asPath), false, 'the path is not a read');
    assertAsked(await runHook(asPath), asPath);
    assertAnsweredAsRead(await runHook('find . -name "$t.md" -print'), 'the search after the refusal', false);
  });

  // THE RETRY: the unquoted line asks again, in the same words.
  test('the unquoted pattern sent twice asks both times, in the same words', async () => {
    const unquoted = 'find . -name $t.md -print';
    assert.strictEqual(S.isReadOnlyShellCommand(unquoted), false, 'an unquoted variable is not a read');
    const first = await runHook(unquoted);
    const again = await runHook(unquoted);
    assertAsked(first, unquoted);
    assertAsked(again, unquoted);
    assert.deepStrictEqual(outcome(again), outcome(first), 'asked as it was asked the first time');
  });

  // THE CONTROL FAILING: a failure inside the reading, or text past what it
  // follows, on a line of the new shape. The segment is not a read, and the
  // hook still answers, as it answers the line on which every path may be
  // written: the pruned `.rundock` is an answer-file crossing again.
  const PRUNING = 'find . -path ./.rundock -prune -o -name "$t.md" -print';
  const past = `${PRUNING} ${'x'.repeat(20000)}`;
  test('a failure inside the reading, or text past what it follows, makes the new shape not a read', () => {
    assert.strictEqual(S.isReadOnlyShellCommand(PRUNING), true, 'sanity: with nothing forced, it reads');
    assert.strictEqual(S.isReadOnlyShellCommand(past), false, 'text past what the reading follows is not a read');
    const before = S.optionReadingSeam.beforeReading;
    S.optionReadingSeam.beforeReading = () => { throw new Error('forced failure'); };
    try {
      assert.strictEqual(S.isReadOnlyShellCommand(PRUNING), false, 'a failure inside the reading is not a read');
      assert.strictEqual(S.isReadOnlyShellCommand(SEARCH('$t.md')), false, 'nor is the search over several names');
    } finally { S.optionReadingSeam.beforeReading = before; }
  });
  for (const [mode, codeMode] of MODES) {
    test(`${mode}: a failure forced inside the reading, or text past it, asks about the pruned folder and never frees it`, async () => {
      assertAnsweredAsRead(await runHook(PRUNING, { codeMode }), `sanity, with nothing forced: ${PRUNING}`, codeMode);
      for (const [label, command, preload] of [['forced', PRUNING, readingFails], ['forced', SEARCH('$t.md'), readingFails],
        ['past the limit', past, undefined]]) {
        const r = await runHook(command, { codeMode, preload });
        assert.strictEqual(r.status, 0, `${label}: the hook answered: ${r.err}`);
        assert.ok(r.card, `${label}: the hook asked Rundock: ${show(command.slice(0, 80))}`);
        assert.ok((r.card.crossings || []).some((c) => c.answerFile && c.path === fs.realpathSync(path.join(ws, '.rundock'))),
          `${label}: asked about the pruned folder as written: ${JSON.stringify(r.card.crossings)}`);
        assert.strictEqual(r.decision, 'deny', `${label}: and refused on the answer no`);
      }
    });
  }
});
