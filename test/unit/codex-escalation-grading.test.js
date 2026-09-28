'use strict';
// Codex escalations, graded by the rules Claude Code agents meet.
//
// Codex never runs the permission hook: what reaches Rundock is an escalation
// out of its own sandbox, a command or a file change. On 0.15.0 every command
// escalation was graded by the Notes-mode rules in every mode, and every file
// change was graded high, so no file change could ever be remembered. Here:
//
//   - a command escalation in Code mode is graded in process by the same
//     boundary scan and verdict the hook uses, from the approval's own cwd;
//     Runs is answered `accept` with no card, never `acceptForSession`;
//   - a file change is graded by its grantRoot in both modes: inside the
//     workspace or a working folder it is accepted with no card, a runtime
//     surface or instruction file always asks, anywhere else is a
//     boundary-style card that can name a working folder;
//   - an escalation that touches the workspace's own answer files is the
//     answer-file card, never accepted by grading, in either mode. That is the
//     half of the self-permission protection that holds whatever Codex's
//     sandbox does; the other half (whether such a write escalates at all)
//     is measured against the live CLI.
//
// THE INTERFACE THESE TESTS FIX:
//   require('lib/runtime/codex-approval.js').gradeCodexApproval({
//     kind: 'command' | 'fileChange', params: { command, cwd, grantRoot, reason },
//     workspaceRoot, extraDirs, codeMode, home,
//   }) -> { decision: 'accept' } | { decision: 'card', request }
//   where `request` is the object the browser receives (tool_name, input, and
//   code_mode_verdict / boundary / grant_dir / crossings / answer_file as the
//   hook's requests carry them);
//   and codex-glue exports handleCodexApproval(entry, convoId, ev).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const fx = require('../helpers/code-mode-fixture.js');

function grade(opts) {
  return require('../../lib/runtime/codex-approval.js').gradeCodexApproval({
    workspaceRoot: world.ws, extraDirs: [world.projects], home: world.home, codeMode: true, ...opts,
  });
}
const cmd = (command, cwd, o = {}) => grade({ kind: 'command', params: { command, cwd }, ...o });
const change = (grantRoot, o = {}) => grade({ kind: 'fileChange', params: { grantRoot, reason: 'write' }, ...o });

const root = fx.outsideTempRoot();
const SKIP = root.skip || false;
let world;
before(() => { if (!SKIP) world = fx.buildWorld(root.dir); });
after(() => { if (root.dir) fs.rmSync(root.dir, { recursive: true, force: true }); });

describe('command escalations in Code mode', { skip: SKIP }, () => {
  test('Runs is accepted with no card', () => {
    for (const c of ['npm install', 'git push -u origin feat/x', 'git pull', 'rm -rf dist', 'kill 4242']) {
      assert.deepStrictEqual(cmd(c, world.app), { decision: 'accept' }, c);
    }
  });

  test('a program or substitution only known when it runs is carded as unreadable; everyday expansion is accepted', () => {
    for (const c of ['x=rm; $x -rf dist', '$(echo sudo) ls', 'p=publish; npm $p', 'x=--force; git push $x origin main', 'kill $(echo -1)', 'f(){ rm -rf dist; }; f', 'env -S "rm -rf dist"', '/bin/r? -rf dist', 'kill $(cat server.pid)', "trap 'rm -rf dist' EXIT",
      `git --work-tree=${world.app} reset --hard`]) {
      const g = cmd(c, world.app);
      assert.strictEqual(g.decision, 'card', c);
      assert.deepStrictEqual(g.request.code_mode_verdict, { verdict: 'always-asks', reason: 'unreadable-command' }, c);
    }
    const s = cmd(`FOO=$(rm -rf ${world.sketch}) git status`, world.app);
    assert.strictEqual(s.decision, 'card');
    assert.strictEqual(s.request.code_mode_verdict.reason, 'outside-repository', 'the substituted command is judged');
    for (const c of ['echo $PATH', 'npm run build -- --port $PORT', 'export X=1', 'ls $DIR', 'kill -9 $(lsof -ti :3000)', 'trap - EXIT', 'grep x <<< "$VAR"']) {
      assert.deepStrictEqual(cmd(c, world.app), { decision: 'accept' }, c);
    }
  });

  test('Asks once raises the same card, and the same rule key, as Claude Code', () => {
    const g = cmd('git push origin main', world.app);
    assert.strictEqual(g.decision, 'card');
    assert.strictEqual(g.request.code_mode_verdict.verdict, 'asks-once');
    assert.strictEqual(g.request.code_mode_verdict.rule, 'Bash:git-push:default-branch');
  });

  test('Always asks raises the same card as Claude Code', () => {
    for (const c of ['git push --force origin feat/x', `rm -rf ${'<PROJECTS>'}/sketch`, "find . -name '*.orig' -delete"]) {
      const g = cmd(fx.expand(world, c), world.app);
      assert.strictEqual(g.decision, 'card', c);
      assert.strictEqual(g.request.code_mode_verdict.verdict, 'always-asks', c);
    }
  });

  test('an outside crossing raises the boundary card', () => {
    const g = cmd('cat ~/elsewhere/x.txt', world.app);
    assert.strictEqual(g.decision, 'card');
    assert.strictEqual(g.request.boundary, true);
  });

  test('relative paths start from the approval\'s cwd', () => {
    assert.deepStrictEqual(cmd('ls ..', world.app), { decision: 'accept' }, '.. is the working folder');
    assert.deepStrictEqual(cmd('cat ../other/README.md', world.app), { decision: 'accept' });
    assert.strictEqual(cmd('rm -rf dist', undefined).decision, 'card', 'with no cwd, a relative bulk delete asks');
  });

  test('the development paths apply to Codex too', () => {
    for (const c of ['cat /tmp/build.log', 'rm -rf ~/.npm/_cacache', 'npm install --cache ~/.npm', 'cat ~/.gitconfig']) {
      assert.deepStrictEqual(cmd(c, world.app), { decision: 'accept' }, c);
    }
    assert.strictEqual(cmd('cat ~/.ssh/config', world.app).decision, 'card', 'and ~/.ssh still asks when it escalates');
  });
});

describe('the push escalation exactly as the live CLI sends it', { skip: SKIP }, () => {
  // Measured: asked in plain words to push, Codex tried inside its sandbox,
  // then asked to escalate with the command wrapped in the login shell and the
  // repository as cwd: {"command":"/bin/zsh -lc 'git push origin main'",
  // "cwd":"<working folder repo>"}. Accepting it ran the push and moved the
  // remote; declining it left the remote untouched.
  test('from the repository: a push to the default branch asks once, a feature-branch push is accepted silently', () => {
    const main = cmd("/bin/zsh -lc 'git push origin main'", world.app);
    assert.strictEqual(main.decision, 'card');
    assert.deepStrictEqual(main.request.code_mode_verdict, { verdict: 'asks-once', rule: 'Bash:git-push:default-branch', branch: 'main' });
    for (const c of ["/bin/zsh -lc 'git push origin feat/x'", "/bin/zsh -lc 'git push'", "/bin/zsh -lc 'git push -u origin feat/x'"]) {
      assert.deepStrictEqual(cmd(c, world.app), { decision: 'accept' }, c);
    }
    const force = cmd("/bin/zsh -lc 'git push --force origin feat/x'", world.app);
    assert.strictEqual(force.request.code_mode_verdict.verdict, 'always-asks');
  });

  test('with the workspace as cwd, a push whose branch cannot be read falls back to asking once', () => {
    // The workspace is not the repository, so there is no current branch to
    // read: an explicit default branch still asks once, and a bare `git push`
    // counts as a push to the default branch rather than running unseen.
    assert.strictEqual(cmd("/bin/zsh -lc 'git push origin main'", world.ws).request.code_mode_verdict.verdict, 'asks-once');
    assert.strictEqual(cmd("/bin/zsh -lc 'git push'", world.ws).request.code_mode_verdict.verdict, 'asks-once');
  });
});

describe('command escalations in Notes mode keep today\'s grading', { skip: SKIP }, () => {
  test('nothing is accepted by grading, and no verdict is attached', () => {
    for (const c of ['npm install', 'git push origin main', 'rm -rf dist']) {
      const g = cmd(c, world.app, { codeMode: false });
      assert.strictEqual(g.decision, 'card', c);
      assert.strictEqual('code_mode_verdict' in g.request, false, c);
    }
  });
});

describe('file-change escalations, graded by grantRoot in both modes', { skip: SKIP }, () => {
  for (const codeMode of [true, false]) {
    const mode = codeMode ? 'Code' : 'Notes';
    test(`inside a working folder or the workspace: accepted with no card (${mode} mode)`, () => {
      for (const g of [path.join(world.app, 'src'), path.join(world.app, 'src', 'new', 'deep'), world.app, path.join(world.ws, 'notes')]) {
        assert.deepStrictEqual(change(g, { codeMode }), { decision: 'accept' }, g);
      }
    });

    test(`a runtime surface, an instruction file or a secret: always asks, never remembered (${mode} mode)`, () => {
      for (const g of [
        path.join(world.home, '.claude'), path.join(world.home, '.claude', 'CLAUDE.md'), path.join(world.home, '.claude', 'rules'),
        path.join(world.home, '.claude', 'settings.json'), path.join(world.home, '.codex', 'AGENTS.md'), path.join(world.home, '.codex', 'auth.json'),
      ]) {
        const r = change(g, { codeMode });
        assert.strictEqual(r.decision, 'card', g);
        assert.strictEqual(r.request.grant_dir || null, null, `${g}: nothing to remember`);
      }
    });

    test(`anywhere else: a boundary-style card that can name the folder (${mode} mode)`, () => {
      const r = change(path.join(world.home, 'Documents'), { codeMode });
      assert.strictEqual(r.decision, 'card');
      assert.strictEqual(r.request.boundary, true);
      assert.strictEqual(r.request.grant_dir, fx.real(path.join(world.home, 'Documents')));
      const RP = require('../../public/permissions.js');
      assert.notStrictEqual(RP.classifyRisk(r.request.tool_name, r.request.input), 'high', 'graded medium, not high');
      const home = change(world.home, { codeMode });
      assert.strictEqual(home.request.grant_dir || null, null, 'never the home directory');
    });
  }
});

describe('Codex cannot write the workspace\'s own permission answers without asking', { skip: SKIP }, () => {
  const ANSWER_FILES = ['.rundock/permissions.json', '.rundock/state.json', '.claude/settings.local.json'];
  for (const codeMode of [true, false]) {
    const mode = codeMode ? 'Code' : 'Notes';
    test(`a file change at an answer file, or at the folder holding one, is the answer-file card (${mode} mode)`, () => {
      const roots = [...ANSWER_FILES.map(f => path.join(world.ws, f)), path.join(world.ws, '.rundock'), path.join(world.ws, '.claude')];
      for (const g of roots) {
        const r = change(g, { codeMode });
        assert.strictEqual(r.decision, 'card', `${g} is never accepted by grading`);
        const isAnswerFile = r.request.answer_file === true || (Array.isArray(r.request.crossings) && r.request.crossings.some(c => c.answerFile));
        assert.strictEqual(isAnswerFile, true, `${g} is carded as the answer file`);
        assert.strictEqual(r.request.grant_dir || null, null, `${g}: never remembered`);
      }
    });

    test(`a command writing an answer file is the answer-file card (${mode} mode)`, () => {
      for (const c of ["echo '{}' > .rundock/permissions.json", 'cp /dev/null .rundock/state.json', "printf x >> .claude/settings.local.json"]) {
        const r = cmd(c, world.ws, { codeMode });
        assert.strictEqual(r.decision, 'card', c);
        const isAnswerFile = r.request.answer_file === true || (Array.isArray(r.request.crossings) && r.request.crossings.some(x => x.answerFile));
        assert.strictEqual(isAnswerFile, true, `${c} is carded as the answer file`);
      }
    });
  }
});

describe('the glue answers Codex', { skip: SKIP }, () => {
  const config = require('../../lib/config.js');
  const glue = require('../../lib/runtime/codex-glue.js');

  function withWorkspace(fn) {
    const prev = config.getWorkspace();
    fs.writeFileSync(path.join(world.ws, '.rundock', 'state.json'), JSON.stringify({ workspaceMode: 'code', workingFolders: [world.projects] }));
    config.setWorkspace(world.ws);
    const savedHome = process.env.HOME;
    process.env.HOME = world.home;
    try { return fn(); } finally {
      process.env.HOME = savedHome;
      if (prev) config.setWorkspace(prev);
    }
  }
  function drive(ev) {
    const asked = [];
    const prev = glue.wireCodexGlueDeps({ requestServerPermission: (req) => { asked.push(req); } });
    const answers = [];
    try {
      withWorkspace(() => glue.handleCodexApproval({ agentId: 'dev' }, 'convo-1', { ...ev, respond: (d) => answers.push(d) }));
    } finally { glue.wireCodexGlueDeps(prev); }
    return { asked, answers };
  }

  test('a command graded Runs is answered accept, with no card and never acceptForSession', () => {
    const { asked, answers } = drive({ kind: 'command', params: { command: 'npm install', cwd: world.app } });
    assert.deepStrictEqual(answers, ['accept']);
    assert.strictEqual(asked.length, 0, 'no card was raised');
  });

  test('a command that asks carries the approval\'s cwd into the request, and an approval is accept, never acceptForSession', () => {
    const { asked, answers } = drive({ kind: 'command', params: { command: 'git push origin main', cwd: world.app } });
    assert.strictEqual(asked.length, 1);
    assert.strictEqual(asked[0].toolInput.cwd, world.app, 'the cwd travels with the request');
    asked[0].onDecision(true);
    assert.deepStrictEqual(answers, ['accept']);
  });

  test('a file change inside the working folder is accepted with no card', () => {
    const { asked, answers } = drive({ kind: 'fileChange', params: { grantRoot: path.join(world.app, 'src'), reason: 'edit' } });
    assert.deepStrictEqual(answers, ['accept']);
    assert.strictEqual(asked.length, 0);
  });

  test('a file change at an answer file is carded, and a denial leaves it declined', () => {
    const { asked, answers } = drive({ kind: 'fileChange', params: { grantRoot: path.join(world.ws, '.rundock', 'permissions.json'), reason: 'edit' } });
    assert.strictEqual(asked.length, 1);
    asked[0].onDecision(false, 'denied');
    assert.deepStrictEqual(answers, ['decline']);
  });

  test('nothing in the glue ever answers acceptForSession', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'runtime', 'codex-glue.js'), 'utf8');
    assert.doesNotMatch(src, /respond\(\s*['"]acceptForSession['"]/);
  });
});

describe('Codex\'s own sandbox is not widened', () => {
  test('threads keep workspace-write, on-request, and no working folders as writable roots', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'runtime', 'codex-glue.js'), 'utf8');
    assert.match(src, /sandbox:\s*'workspace-write'/);
    assert.match(src, /approvalPolicy:\s*'on-request'/);
    assert.doesNotMatch(src, /writableRoots\s*:\s*[^\]]*[Ww]orking/, 'working folders are not writable roots: an escalation is Rundock\'s only look at a Codex command');
    assert.doesNotMatch(src, /networkAccess\s*:\s*true/, 'network stays off, so every push escalates and is graded');
  });
});

describe('a request to widen Codex\'s own permissions is refused at once, with an empty grant, and the person is told', () => {
  // item/permissions/requestApproval has no decision field in the live schema:
  // the answer is the profile granted. Rundock always refuses, with an empty
  // grant for the turn. Measured: under on-request Codex does not send it (it
  // asks for a command approval instead), and the granular policy that would
  // enable it needs the experimental API, which Rundock never opts into.
  const { EventEmitter } = require('node:events');
  const { createCodexAppServer } = require('../../codex-appserver.js');
  const REFUSAL = { permissions: {}, scope: 'turn' };
  function serverWithTurn({ approvalTimeoutMs = 60000 } = {}) {
    const server = createCodexAppServer({ binPath: 'codex-not-started', approvalTimeoutMs, log: () => {} });
    const written = [];
    server._writeLine = (msg) => written.push(msg);
    const sub = new EventEmitter();
    server._activeTurns.set('t', { threadId: 't', sub, turnId: 'u', approvals: new Map(), finished: false });
    const events = [];
    sub.on('event', ev => events.push(ev));
    return { server, written, events };
  }
  const request = (id) => ({
    id, method: 'item/permissions/requestApproval',
    params: { threadId: 't', turnId: 'u', itemId: 'i', cwd: '/w', startedAtMs: 1, reason: 'need to write outside',
      permissions: { fileSystem: { entries: [{ path: { type: 'path', path: '/w/out' }, access: 'write' }] }, network: { enabled: true } } },
  });

  test('declined immediately with an empty grant, whatever was asked, and the turn is told', () => {
    const { server, written, events } = serverWithTurn();
    server._onServerRequest(request(7));
    assert.deepStrictEqual(written, [{ jsonrpc: '2.0', id: 7, result: REFUSAL }], 'nothing asked for is granted, and never for the session');
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, 'permissionsRefused', 'the turn hears it was refused');
    assert.strictEqual(typeof events[0].respond, 'undefined', 'and there is nothing to answer: no Allow path exists');
  });

  test('never waits on a timer: answered before any approval timeout could fire', () => {
    const { server, written } = serverWithTurn({ approvalTimeoutMs: 1 });
    server._onServerRequest(request(8));
    assert.deepStrictEqual(written[0].result, REFUSAL, 'answered synchronously');
    assert.strictEqual(server._activeTurns.get('t').approvals.size, 0, 'no pending approval is held open');
  });

  test('with no turn to route it to, it is declined at once, never left hanging', () => {
    const server = createCodexAppServer({ binPath: 'codex-not-started', log: () => {} });
    const written = [];
    server._writeLine = (msg) => written.push(msg);
    server._onServerRequest(request(11));
    assert.deepStrictEqual(written, [{ jsonrpc: '2.0', id: 11, result: REFUSAL }]);
  });

  test('the glue tells the person, in the conversation, that it was refused', () => {
    const glue = require('../../lib/runtime/codex-glue.js');
    const sent = [];
    const prev = glue.wireCodexGlueDeps({ safeSend: (m) => sent.push(JSON.parse(m)) });
    try { glue.surfacePermissionsRefused({ agentId: 'dev', processId: 'p' }, 'convo-1', request(1).params); }
    finally { glue.wireCodexGlueDeps(prev); }
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].subtype, 'notice');
    assert.strictEqual(sent[0]._conversationId, 'convo-1');
    assert.strictEqual(sent[0].content,
      "Codex asked for more access than its sandbox allows for the rest of this turn. Rundock refused it, so nothing was granted. Codex's reason: need to write outside");
  });

  test('both turn paths surface it', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'runtime', 'codex-glue.js'), 'utf8');
    const handler = "case 'permissionsRefused':\n      surfacePermissionsRefused(entry, convoId, ev.params);";
    assert.strictEqual(src.split(handler).length - 1, 2, 'the direct-chat and delegate handlers both surface it');
  });
});
