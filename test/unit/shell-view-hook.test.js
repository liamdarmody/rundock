'use strict';
// THROUGH THE REAL HOOK: a quote character that opens nothing in bash hides
// no command, in Notes mode and in Code mode.
//
// A quote in a comment, one escaped inside `$'…'`, one in a here-document's
// body, and the quotes inside a substitution held in double quotes each open
// nothing in bash. Paired with a later quote, each hid the copy over the
// runtime's settings on the line after it: the shared definition read the
// line as a listing and freed the crossing, or the hook's reading of its
// paths never saw the file, and in Code mode the copy ran with no card. Each
// line here now crosses exactly as the plain line it is, `ls; cp x <settings>`.
//
// Each case runs the hook as its own process, the way the runtime does,
// against a stand-in for Rundock (the Code-mode fixture's), once with someone
// to ask and once with nobody, in a world outside every temp folder and git
// working tree, never the real home.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const fx = require('../helpers/code-mode-fixture.js');

const SHARED = path.join(__dirname, '..', '..', 'public', 'read-only-shell.js');
const root = fx.outsideTempRoot();
const SKIP = root.skip || false;
let world, capture, deadPort, settings, hooks, viewFails, refuser;
// A stand-in that answers no, for the refused card.
const refused = new Map();

before(async () => {
  if (SKIP) return;
  world = fx.buildWorld(root.dir);
  settings = path.join(world.home, '.claude', 'settings.json');
  hooks = path.join(world.home, '.claude', 'hooks');
  fx.write(path.join(hooks, 'pretool.sh'), '');
  capture = await fx.startCaptureServer();
  deadPort = await fx.closedPort();
  refuser = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { const d = JSON.parse(body); if (d.session_id) refused.set(d.session_id, d); } catch (e) { /* asserted by the callers */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ allow: false }));
    });
  });
  await new Promise((resolve) => refuser.listen(0, '127.0.0.1', resolve));
  // A FAILURE FORCED INSIDE THE VIEW, loaded ahead of the hook. The hook has
  // no switch for it, so nothing in a tool call can set it off.
  viewFails = path.join(root.dir, 'view-fails.js');
  fs.writeFileSync(viewFails, `require(${JSON.stringify(SHARED)}).shellViewSeam.beforeReading = () => { throw new Error('forced failure'); };\n`);
});
after(async () => {
  if (capture) await capture.close();
  if (refuser) { refuser.closeAllConnections(); await new Promise((resolve) => refuser.close(resolve)); }
  if (root.dir) fs.rmSync(root.dir, { recursive: true, force: true });
});

const MODES = [['Notes mode', false], ['Code mode', true]];
const judge = (command, codeMode, at = 'app') => fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command }, cwd: fx.cwdFor(world, at), codeMode });
// The same, with the view made to fail inside the hook.
let seq = 0;
async function judgeWithViewFailing(command, codeMode) {
  const sid = `shell-view-${process.pid}-${++seq}`;
  const input = { session_id: sid, transcript_path: '', permission_mode: 'acceptEdits', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: world.app };
  const preload = { NODE_OPTIONS: `--require "${viewFails}"` };
  const live = await fx.runHook({ ...fx.hookEnv(world, { port: capture.port, codeMode }), ...preload }, input);
  const payload = capture.posted.get(sid) || null;
  const dead = await fx.runHook({ ...fx.hookEnv(world, { port: deadPort, codeMode }), ...preload }, { ...input, session_id: sid + '-dead' });
  return { live, dead, payload, cls: fx.classOf(live, dead, payload) };
}
const show = (cmd) => JSON.stringify(cmd);
const writesAt = (r, target) => ((r.payload && r.payload.crossings) || [])
  .filter((c) => c.persistenceSurface && c.write && (c.path === fs.realpathSync(target) || c.path.startsWith(fs.realpathSync(target) + path.sep)));
function assertCrossesAsPlain(r, plain, target, command) {
  assert.ok(r.payload, `the hook asked nobody: ${show(command)}`);
  assert.strictEqual(r.payload.boundary, true, `no crossing was reported: ${show(command)}`);
  assert.ok(writesAt(r, target).length > 0, `the card does not name the file as written: ${JSON.stringify(r.payload.crossings)}`);
  assert.deepStrictEqual(r.payload.crossings, plain.payload.crossings, `the crossings of the plain line: ${show(command)}`);
  assert.strictEqual(r.cls, plain.cls, `asked as the plain line is: ${show(command)}`);
}
// The hook, with the stand-in answering no.
async function refusedBy(command) {
  const sid = `shell-view-no-${process.pid}-${++seq}`;
  const input = { session_id: sid, transcript_path: '', permission_mode: 'acceptEdits', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: world.app };
  const live = await fx.runHook(fx.hookEnv(world, { port: refuser.address().port, codeMode: false }), input);
  return { live, payload: refused.get(sid) || null };
}
function assertFreed(r, command) {
  assert.notStrictEqual(r.payload && r.payload.boundary, true, `a read of the runtime's home raised a crossing: ${show(command)}`);
}

const hidden = () => [
  ['an escaped quote inside $\'…\'', `ls $'\\''; cp x ${settings}`],
  ['an escaped quote inside $\'…\', on lines of their own', `ls $'\\''\ncp x ${settings}\nls $'\\''`],
  ['a quote in a comment', `ls # it's\ncp x ${settings}\nls # '`],
  ['a quote in a here-document\'s body', `cat <<EOF\n'\nEOF\ncp x ${settings}\necho "'"`],
  ['a quote in a quoted here-document\'s body', `cat <<'EOF'\nit's\nEOF\ncp x ${settings}\necho "'"`],
  ['quotes inside a substitution in double quotes', `echo "$(echo "'")"\ncp x ${settings}\necho "$(echo "'")"`],
  ['quotes inside a backtick in double quotes', `echo "\`echo "'"\`"\ncp x ${settings}\necho "\`echo "'"\`"`],
  ['a copy inside a substitution in double quotes', `echo "$(cp x ${settings})"`],
  ['an escaped quote inside $\'…\' in a shell\'s -c', `bash -c "ls $'\\\\''; cp x ${settings}; ls $'\\\\''"`],
  ['a copy after a case pattern', `case x in x) cp x ${settings};; esac`],
  ['a copy in a zsh glob qualifier', `ls *(e:'cp x ${settings}':)`],
  ['a copy in a zsh glob qualifier in brackets, after another', `ls *(.e[cp x ${settings}])`],
];

describe('through the real hook, a quote that opens nothing hides no copy over the settings', { skip: SKIP }, () => {
  for (const [mode, codeMode] of MODES) {
    test(`${mode}: each hidden copy crosses as the plain line does`, async () => {
      const plain = await judge(`ls; cp x ${settings}`, codeMode);
      assert.ok(plain.payload && plain.payload.boundary && writesAt(plain, settings).length > 0, 'the plain line is a write crossing');
      for (const [name, command] of hidden()) {
        assertCrossesAsPlain(await judge(command, codeMode), plain, settings, `${name}: ${command}`);
      }
    });

    test(`${mode}: the most common reads beside them are still freed`, async () => {
      const claude = path.join(world.home, '.claude');
      for (const command of [`grep -rn "it's" ${hooks}`, `ls ${claude} # list the runtime's folder`, `rg -n 'TODO' ${hooks}`,
        `ls ${hooks} # it's here`, `echo $'a\\tb'; ls ${hooks}`]) {
        assertFreed(await judge(command, codeMode), command);
      }
    });
  }

  // In Code mode the verdict reads the line both ways: a removal it asks about
  // asks however it is hidden, and one that zsh runs from inside a word asks.
  test('Code mode: a removal that always asks asks the same, hidden behind any of these quotes', async () => {
    const plain = await judge('rm -rf .git', true);
    assert.strictEqual(plain.cls, 'always-asks');
    for (const command of ["ls $'\\''; rm -rf .git; ls $'\\''", "ls # it's\nrm -rf .git\nls # '", "cat <<EOF\n'\nEOF\nrm -rf .git\necho \"'\"",
      'echo "$(echo "\'")"\nrm -rf .git\necho "$(echo "\'")"', "bash -c \"ls $'\\\\''; rm -rf .git; ls $'\\\\''\""]) {
      const r = await judge(command, true);
      assert.strictEqual(r.cls, 'always-asks', show(command));
      assert.strictEqual(r.payload.reason, plain.payload.reason, `for the plain line's reason: ${show(command)}`);
    }
  });

  test('Code mode: zsh\'s commands inside a word, and a substitution bash 3.2 ends early, always ask', async () => {
    for (const command of ["ls *(e:'rm -rf .git':)", 'ls x(+cleanup)', 'cat =(rm -rf .git)',
      "echo \"$(cat <<'EOF'\n)$(rm -rf .git)\nEOF\n)\""]) {
      assert.strictEqual((await judge(command, true)).cls, 'always-asks', show(command));
    }
  });

  test('Code mode: a commit message in a here-document, and a comment with a quote, run as they did', async () => {
    for (const command of ["git commit -m \"$(cat <<'EOF'\nRead the line, it's quoted\nEOF\n)\"", "git status --short # it's quick",
      "git log --oneline -3 # what's new"]) {
      assert.strictEqual((await judge(command, true)).cls, 'runs', show(command));
    }
  });

  // A READ BESIDE THE COPY MASKS NO WRITE: a crossing both readings find
  // takes its write flag from the line's one decision.
  for (const [mode, codeMode] of MODES) {
    test(`${mode}: a cat of the settings before a hidden copy over them crosses as a write, as the plain line does`, async () => {
      const plain = await judge(`cat ${settings}; cp x ${settings}`, codeMode);
      const r = await judge(`cat ${settings} # it's\ncp x ${settings}\nls # '`, codeMode);
      for (const [what, j] of [['the plain line', plain], ['the hidden copy', r]]) {
        const c = ((j.payload && j.payload.crossings) || []).find((x) => x.path === fs.realpathSync(settings));
        assert.ok(c && c.write === true, `${what}: the settings are not a write: ${JSON.stringify(j.payload && j.payload.crossings)}`);
      }
      assert.strictEqual(r.cls, plain.cls, 'asked as the plain line is');
    });
  }

  // THE INVERSE: a read of the same folder is freed, the hidden copy is not.
  test('a listing of the runtime\'s folder is freed, and the hidden copy after it asks', async () => {
    assertFreed(await judge(`ls ${hooks}`, false), 'the listing');
    const plain = await judge(`ls; cp x ${settings}`, false);
    assertCrossesAsPlain(await judge(`ls $'\\''; cp x ${settings}`, false), plain, settings, 'the hidden copy');
  });

  // THE UNDO: a refused card leaves nothing behind it.
  test('a hidden copy is refused, and the next listing is freed', async () => {
    const r = await refusedBy(`ls # it's\ncp x ${settings}\nls # '`);
    assert.ok(r.payload && r.payload.boundary, 'asked as a crossing');
    assert.strictEqual(r.live.decision, 'deny', 'and the answer it was given, no, is the answer');
    assertFreed(await judge(`ls ${hooks}`, false), 'the listing after the refusal');
  });

  // THE RETRY: the same hidden line asks again, in the same words.
  test('the same hidden copy sent twice asks both times, about the same place', async () => {
    const command = `ls $'\\''\ncp x ${settings}\nls $'\\''`;
    const first = await judge(command, false);
    const again = await judge(command, false);
    assert.ok(first.payload && again.payload, 'both asked');
    assert.ok(writesAt(first, settings).length > 0, `about the settings, as written: ${JSON.stringify(first.payload.crossings)}`);
    assert.deepStrictEqual(again.payload.crossings, first.payload.crossings, 'about the same place');
    assert.strictEqual(again.live.reason, first.live.reason, 'in the words of the first asking');
  });

  // THE CONTROL FAILING: a failure inside the view frees nothing, and the
  // hook still answers.
  for (const [mode, codeMode] of MODES) {
    test(`${mode}: a failure forced inside the view asks about a listing of the hooks as a write`, async () => {
      const command = `ls ${hooks}`;
      assertFreed(await judge(command, codeMode), `sanity, with nothing forced: ${command}`);
      const r = await judgeWithViewFailing(command, codeMode);
      assert.ok(r.live.raw.length > 0, 'the hook answered');
      assert.ok(r.payload, 'and asked');
      assert.ok(writesAt(r, hooks).length > 0, `about the hooks, as written: ${JSON.stringify(r.payload.crossings)}`);
    });
  }
});
