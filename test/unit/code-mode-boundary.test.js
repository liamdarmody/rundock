'use strict';
// The boundary's wrong answers, corrected, and the places a development
// session reaches outside every working folder.
//
//   - A folder is never offered unless it exists, and never the home directory.
//   - A named folder never covers the hidden folders directly under home.
//   - In Code mode the temp folders and package caches are development paths,
//     and git's own settings are free to read; Notes mode is unchanged.
//   - ~/.ssh and every other hidden folder under home always ask, and are
//     refused when nobody can be asked.
//   - The runtimes' global instruction files are persistence surfaces.
//   - Working folders reach Claude Code as additional directories through the
//     settings it is launched with, never as --add-dir.
//
// Through the real hook where the question is what a person sees; in process
// where the question is a registry or a settings file.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fx = require('../helpers/code-mode-fixture.js');
const hook = require('../../scripts/permission-hook.js');

const root = fx.outsideTempRoot();
const SKIP = root.skip || false;
let world, capture, deadPort;
before(async () => {
  if (SKIP) return;
  world = fx.buildWorld(root.dir);
  capture = await fx.startCaptureServer();
  deadPort = await fx.closedPort();
});
after(async () => {
  if (capture) await capture.close();
  if (root.dir) fs.rmSync(root.dir, { recursive: true, force: true });
});

const bash = (command, at = 'app', o = {}) => fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command }, cwd: fx.cwdFor(world, at), ...o });
const file = (tool, input, o = {}) => fx.judge(world, capture, deadPort, { tool, input, cwd: world.app, ...o });

describe('a folder is never offered unless it exists', { skip: SKIP }, () => {
  test('a relative read from the workspace into a folder that is not there offers nothing', async () => {
    // From the workspace, ../other is <home>/other, which does not exist. On
    // 0.15.0 the card offered it anyway: a phantom folder beside the workspace.
    for (const codeMode of [true, false]) {
      const r = await bash('cat ../other/README.md', 'ws', { codeMode });
      assert.strictEqual(r.payload && r.payload.boundary, true, 'still a crossing');
      assert.strictEqual(r.payload.grant_dir || null, null, `no folder offered (${codeMode ? 'Code' : 'Notes'} mode)`);
    }
  });

  test('nor its nearest existing ancestor in its place', async () => {
    const r = await file('Read', { file_path: path.join(world.home, 'elsewhere', 'deeper', 'unborn', 'x.txt') });
    assert.strictEqual(r.payload && r.payload.boundary, true);
    assert.strictEqual(r.payload.grant_dir || null, null, 'climbing to an existing ancestor would widen the grant');
  });

  test('a folder that exists is still offered, named from where the command ran', async () => {
    const r = await bash('cat ../../elsewhere/x.txt', 'app');
    assert.strictEqual(r.payload.grant_dir, fx.real(path.join(world.home, 'elsewhere')));
  });
});

describe('a file-tool card never offers the home directory', { skip: SKIP }, () => {
  for (const codeMode of [true, false]) {
    test(`a file directly in home offers no folder (${codeMode ? 'Code' : 'Notes'} mode)`, async () => {
      const r = await file('Read', { file_path: path.join(world.home, 'notes.txt') }, { codeMode });
      assert.strictEqual(r.payload && r.payload.boundary, true);
      assert.strictEqual(r.payload.grant_dir || null, null, 'one click would otherwise silence every card for the whole home');
    });
  }

  test('nor does a read of ~/.gitconfig in Notes mode, where it is still carded', async () => {
    const r = await file('Read', { file_path: path.join(world.home, '.gitconfig') }, { codeMode: false });
    assert.strictEqual(r.payload && r.payload.boundary, true);
    assert.strictEqual(r.payload.grant_dir || null, null);
  });
});

describe('a named folder never covers the hidden folders directly under home', { skip: SKIP }, () => {
  test('home stored as a working folder does not hand over ~/.ssh', async () => {
    const withHome = [world.projects, world.home];
    for (const [tool, input] of [['Bash', { command: 'cat ~/.ssh/config' }], ['Read', { file_path: path.join(world.home, '.ssh', 'config') }]]) {
      const r = await fx.judge(world, capture, deadPort, { tool, input, cwd: world.app, extraDirs: withHome });
      assert.ok(r.payload, `${tool}: still asked`);
      assert.strictEqual(r.dead.decision, 'deny', `${tool}: and refused when nobody can be asked`);
    }
  });

  test('in process: namedFolderCovers stops at a hidden folder unless that folder is itself named', () => {
    const ssh = path.join(world.home, '.ssh', 'config');
    const a = hook.classifyFileAccess('Read', { file_path: ssh }, world.ws, [world.home], world.home);
    assert.strictEqual(a.where, 'outside', 'naming home does not cover ~/.ssh');
    const b = hook.classifyFileAccess('Read', { file_path: ssh }, world.ws, [path.join(world.home, '.ssh')], world.home);
    assert.strictEqual(b.where, 'inside', 'naming ~/.ssh itself does');
    const docs = hook.classifyFileAccess('Read', { file_path: path.join(world.home, 'Documents', 'brief.md') }, world.ws, [world.home], world.home);
    assert.strictEqual(docs.where, 'inside', 'and naming home still covers ordinary folders in it');
  });
});

describe('a backslash escape is not a path', { skip: SKIP }, () => {
  // `\n` reads as a relative Windows path, and was listed as a place outside
  // the workspace on every card for a command using it.
  const scan = (command, toolName = 'Bash', codeMode = true) => hook.classifyShellAccess(toolName, { command }, world.ws, [world.projects], world.home, true, { cwd: world.app, codeMode });
  for (const codeMode of [true, false]) {
    test(`escape sequences in a Bash command reach nothing (${codeMode ? 'Code' : 'Notes'} mode)`, () => {
      for (const c of ["printf 'a b' | tr ' ' '\\n'", "tr '\\t' '\\n' < notes.txt", "printf '%s\\0' a b", "echo -e 'a\\x41'"]) {
        assert.strictEqual(scan(c, 'Bash', codeMode), null, c);
      }
    });
  }
  test('the escape is dropped, and nothing real beside it is', () => {
    const a = scan("tr '\\n' ' ' < ~/elsewhere/x.txt");
    assert.deepStrictEqual(a.crossings.map(c => c.path), [fx.real(path.join(world.home, 'elsewhere', 'x.txt'))]);
  });
  test('in PowerShell a backslash is still a separator', () => {
    const a = scan('Get-Content ..\\..\\elsewhere\\x.txt', 'PowerShell');
    assert.ok(a && a.where === 'outside', 'a Windows relative path still reaches outside');
  });
});

describe('development paths, Code mode only', { skip: SKIP }, () => {
  test('in Notes mode the temp folders and caches are still outside', async () => {
    for (const c of ['cat /tmp/build.log', 'ls ~/.npm/_cacache']) {
      const r = await bash(c, 'app', { codeMode: false });
      assert.strictEqual(r.payload && r.payload.boundary, true, `${c}: Notes mode is unchanged`);
    }
  });

  test('the system temp folder under its own name, os.tmpdir(), is a development path', async () => {
    const target = path.join(os.tmpdir(), 'app-build.log');
    const r = await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command: `cat ${target}` }, cwd: world.app });
    assert.strictEqual(r.cls, 'runs');
  });

  test('credential files beside the caches are not covered', async () => {
    fx.write(path.join(world.home, '.cargo', 'credentials.toml'), '[registry]\n');
    fx.write(path.join(world.home, '.npmrc'), '//registry.example.invalid/:_authToken=x\n');
    for (const c of ['cat ~/.cargo/credentials.toml', 'cat ~/.npmrc', 'ls ~/.cargo/bin']) {
      const r = await bash(c);
      assert.ok(r.payload && r.payload.boundary, `${c} still asks`);
    }
  });

  test('~/.config/git/config is free to read, and writing it still cards with no folder offered', async () => {
    const read = await bash('cat ~/.config/git/config');
    assert.strictEqual(read.cls, 'runs');
    const w = await bash('echo "[core]" >> ~/.config/git/config');
    assert.ok(w.payload && w.payload.boundary, 'a write asks');
    assert.strictEqual(w.payload.grant_dir || null, null);
  });

  test('connecting over SSH never asks: no path to the keys appears in the command', async () => {
    const r = await bash('ssh -T git@example.invalid');
    assert.strictEqual(r.cls, 'runs');
  });
});

describe('the hidden folders under home always ask', { skip: SKIP }, () => {
  test('every hidden folder, by rule, not by a list of names', async () => {
    fx.write(path.join(world.home, '.gnupg', 'pubring.kbx'), 'x');
    fx.write(path.join(world.home, '.some-new-tool', 'token'), 'x');
    for (const c of ['cat ~/.gnupg/pubring.kbx', 'cat ~/.some-new-tool/token', 'ls ~/.aws']) {
      const r = await bash(c);
      assert.ok(r.payload && r.payload.boundary, `${c}: asked`);
      assert.strictEqual(r.payload.grant_dir || null, null, `${c}: never remembered`);
      assert.strictEqual(r.dead.decision, 'deny', `${c}: refused when nobody can be asked`);
    }
  });

  test('the request says which hidden folder it is, so the card can name it', async () => {
    const r = await bash('cat ~/.aws/credentials');
    const c = r.payload.crossings[0];
    assert.strictEqual(c.hiddenHome, '.aws', 'the crossing names the folder the card will describe');
  });
});

describe('the runtimes\' global instruction files are persistence surfaces', () => {
  const home = path.join(os.tmpdir(), 'no-such-home-for-registry');
  const SURFACES = [
    ['.claude', 'CLAUDE.md'], ['.claude', 'rules', 'style.md'], ['.claude', 'output-styles', 'terse.md'],
    ['.codex', 'AGENTS.md'], ['.codex', 'rules', 'default.rules'],
  ];
  for (const parts of SURFACES) {
    test(`~/${parts.join('/')} is a persistence surface`, () => {
      assert.strictEqual(hook.isPersistenceSurface(path.join(home, ...parts), home), true);
    });
  }

  test('a same-named file deeper in the runtime home is still scratch', () => {
    assert.strictEqual(hook.isPersistenceSurface(path.join(home, '.claude', 'projects', 'x', 'CLAUDE.md'), home), false);
  });

  test('reading them stays free', () => {
    const a = hook.classifyFileAccess('Read', { file_path: path.join(home, '.claude', 'CLAUDE.md') }, '/w/ws', [], home);
    assert.strictEqual(a.where, 'inside');
  });

  test('ARCHITECTURE.md names every one, as it names the rest of the registry', () => {
    const doc = fs.readFileSync(path.join(__dirname, '..', '..', 'ARCHITECTURE.md'), 'utf8');
    for (const name of ['CLAUDE.md', 'rules/', 'output-styles/', 'AGENTS.md']) {
      assert.ok(doc.includes(`\`${name}\``), `ARCHITECTURE.md names \`${name}\` as a persistence surface`);
    }
  });
});

describe('working folders reach Claude Code as additional directories', () => {
  const scaffold = require('../../lib/workspace/scaffold.js');
  const claudeRt = require('../../lib/runtime/claude.js');
  const config = require('../../lib/config.js');

  function makeWorkspace(folders) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'additional-dirs-'));
    const ws = path.join(base, 'ws');
    fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(ws, '.rundock'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.rundock', 'state.json'), JSON.stringify({ workspaceMode: 'code', workingFolders: folders }));
    return { base, ws };
  }

  test('the settings Rundock launches with list every working folder that exists, and none that does not', () => {
    const present = fs.mkdtempSync(path.join(os.tmpdir(), 'present-folder-'));
    const missing = path.join(present, 'not-there');
    const { base, ws } = makeWorkspace([present, missing]);
    try {
      scaffold.reconcileSandboxForMode(ws, 'off', 'darwin');
      const settings = JSON.parse(fs.readFileSync(path.join(ws, '.claude', 'settings.local.json'), 'utf8'));
      const dirs = (settings.permissions && settings.permissions.additionalDirectories) || [];
      assert.ok(dirs.map(fx.real).includes(fx.real(present)), 'an existing working folder is an additional directory');
      assert.ok(!dirs.includes(missing), 'a missing one is left out, as Settings shows it missing on purpose');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
      fs.rmSync(present, { recursive: true, force: true });
    }
  });

  test('a settings file whose sandbox block a person wrote is never given additional directories, on a mode switch or an open', () => {
    const present = fs.mkdtempSync(path.join(os.tmpdir(), 'present-folder-'));
    const { base, ws } = makeWorkspace([present]);
    const f = path.join(ws, '.claude', 'settings.local.json');
    try {
      const theirs = { sandbox: { enabled: true, filesystem: { allowWrite: ['/a'] }, excludedCommands: ['*ship.sh*'] } };
      fs.writeFileSync(f, JSON.stringify(theirs, null, 2));
      const before = fs.readFileSync(f, 'utf8');
      scaffold.reconcileSandboxForMode(ws, 'off', 'darwin');
      assert.strictEqual(fs.readFileSync(f, 'utf8'), before, 'a mode switch leaves their file byte for byte alone');
      const prevDeps = scaffold.wireScaffoldDeps({ invalidateAgentCache() {}, rebaselineAgentsWatcher() {} });
      try { scaffold.scaffoldWorkspace(ws, { platform: 'darwin' }); } finally { scaffold.wireScaffoldDeps(prevDeps); }
      const after = JSON.parse(fs.readFileSync(f, 'utf8'));
      assert.ok(after.hooks, 'the open did run (it wires the permission hook)');
      assert.deepStrictEqual(after.sandbox, theirs.sandbox, 'an open leaves their block alone');
      assert.strictEqual(after.permissions && after.permissions.additionalDirectories, undefined, 'and adds no additional directories');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
      fs.rmSync(present, { recursive: true, force: true });
    }
  });

  test('the spawn passes no --add-dir beyond the workspace', () => {
    const present = fs.mkdtempSync(path.join(os.tmpdir(), 'present-folder-'));
    const { base, ws } = makeWorkspace([present]);
    const prev = config.getWorkspace && config.getWorkspace();
    try {
      config.setWorkspace(ws);
      const args = claudeRt.getBareArgs();
      const added = args.filter((a, i) => args[i - 1] === '--add-dir');
      assert.deepStrictEqual(added, [ws], 'only the workspace: --add-dir would also load skills, commands and agents Rundock never shows');
    } finally {
      if (prev) config.setWorkspace(prev);
      fs.rmSync(base, { recursive: true, force: true });
      fs.rmSync(present, { recursive: true, force: true });
    }
  });
});

describe('the OS sandbox block is unchanged', () => {
  test('the Code-mode block for fixed inputs is byte-identical to v0.15.0', () => {
    const scaffold = require('../../lib/workspace/scaffold.js');
    const block = scaffold.sandboxSettings('/w/ws', 'darwin', '/Users/someone', ['/var/folders/zz/T', '/private/var/folders/zz/T'], ['/Users/someone/Projects'], 'code');
    // Recorded from v0.15.0 with these exact inputs.
    assert.deepStrictEqual(block, {
      enabled: false,
      filesystem: {
        allowWrite: [
          '/w/ws', '/Users/someone/.npm', '/Users/someone/.claude', '/Users/someone/.claude.json',
          '/tmp/claude', '/private/tmp/claude', '/var/folders/zz/T', '/private/var/folders/zz/T', '/Users/someone/Projects',
        ],
        denyWrite: ['/w/ws/.rundock/state.json', '/w/ws/.rundock/permissions.json', '/w/ws/.claude/settings.local.json'],
      },
    }, 'the development paths are a card rule, not a widening of what the operating system allows');
  });
});

describe('a separator, an echoed word, or a missing top-level path read by a read is not a place', { skip: SKIP }, () => {
  const scan = (command, codeMode = true) => hook.classifyShellAccess('Bash', { command }, world.ws, [world.projects], world.home, true, { cwd: world.app, codeMode });
  const places = (command, codeMode) => { const a = scan(command, codeMode); return a ? a.crossings.map(c => c.path) : []; };

  for (const codeMode of [true, false]) {
    const mode = codeMode ? 'Code' : 'Notes';
    test(`a lone / as a separator is dropped (${mode} mode)`, () => {
      for (const c of ["tr -d '/' < notes.txt", "tr '/' '_' < notes.txt", "cut -d'/' -f1 notes.txt", 'cut -d / -f1 notes.txt',
        "awk -F'/' '{print $1}' notes.txt", "awk -F / '{print $1}' notes.txt", "sort -t'/' -k2 notes.txt", "paste -d'/' a.log b.log",
        "column -s'/' -t notes.txt", 'IFS=/ read -r a b']) {
        assert.deepStrictEqual(places(c, codeMode), [], c);
      }
    });

    test(`a / anywhere else is still the root, and still offers nothing (${mode} mode)`, () => {
      for (const c of ['grep -r password /', 'find / -name id_rsa', 'du -sh /', 'ls /']) {
        const a = scan(c, codeMode);
        assert.ok(a && a.crossings.some(x => x.path === fx.real('/')), `${c} reaches the root`);
        assert.strictEqual(a.grantDir, null, `${c}: the root is never offered`);
      }
    });

    test(`a separator does not hide the file the same command reads (${mode} mode)`, () => {
      assert.deepStrictEqual(places("tr '/' '_' < /etc/hosts", codeMode), [fx.real('/etc/hosts')]);
      assert.deepStrictEqual(places('cut -d/ -f1 /etc/passwd', codeMode), [fx.real('/etc/passwd')]);
    });

    test(`a top-level path that does not exist, in a command that only reads, is dropped (${mode} mode)`, () => {
      for (const c of ['grep -rn x . --exclude-dir=/Archive-2027', 'rg -l x --glob=/Drafts .']) {
        assert.deepStrictEqual(places(c, codeMode), [], c);
      }
    });

    test(`a write to a new top-level path, or a missing deeper path, still crosses (${mode} mode)`, () => {
      for (const [c, p] of [['mkdir /Archive-2027', '/Archive-2027'], ['touch /Drafts', '/Drafts'], ['echo x > /Drafts', '/Drafts'], ['cat /nope/x', '/nope/x']]) {
        assert.ok(places(c, codeMode).includes(p), `${c} still reaches ${p}`);
      }
    });

    test(`echo and printf operands are text, unless the output goes somewhere (${mode} mode)`, () => {
      assert.deepStrictEqual(places('echo /Archive-2027 / /Drafts', codeMode), []);
      assert.deepStrictEqual(places("printf '%s\\n' /Archive-2027", codeMode), []);
      assert.ok(places('echo ~/.ssh/id_rsa | xargs cat', codeMode).includes(path.join(fx.real(world.home), '.ssh', 'id_rsa')), 'piped on: kept');
      assert.ok(places(`echo x > ${path.join(world.home, 'elsewhere', 'y.txt')}`, codeMode).length > 0, 'redirected: kept');
      assert.ok(places('echo x >> ~/.gitconfig', codeMode).length > 0, 'appended: kept');
      assert.ok(places('cat $(echo ~/.ssh/id_rsa)', codeMode).includes(path.join(fx.real(world.home), '.ssh', 'id_rsa')), 'a substitution belongs to the outer command');
    });
  }

  test('existing top-level folders still cross in Notes mode', () => {
    assert.ok(places('ls /etc', false).length > 0);
    assert.ok(places('ls /tmp', false).length > 0);
  });

  test('Card A, end to end: from a workspace in a parent of workspaces, only the parent is a place, and it is offered', async () => {
    const parent = path.join(world.root, 'Workspaces');
    const wsA = path.join(parent, 'ws-a');
    fx.write(path.join(wsA, '.rundock', 'state.json'), '{}\n');
    fs.mkdirSync(path.join(parent, 'Archive-2027'), { recursive: true });
    const w = { ...world, ws: wsA };
    for (const command of ['cd .. && echo /Archive-2027 / /Drafts', 'cd .. && ls */ | grep / | tr -d / && echo /Drafts /Archive-2027']) {
      const r = await fx.judge(w, capture, deadPort, { tool: 'Bash', input: { command }, cwd: wsA });
      assert.ok(r.payload && r.payload.boundary, command);
      assert.deepStrictEqual(r.payload.crossings.map(c => c.path), [fx.real(parent)], `${command}: one place`);
      assert.strictEqual(r.payload.grant_dir, fx.real(parent), `${command}: and "Always allow this folder" names it`);
    }
  });
});

describe('another workspace\'s answer files and agents, reached through a named folder or not', { skip: SKIP }, () => {
  // Self-permission by proxy: an agent in one workspace writing another's
  // standing answers, or its agents and skills, which that workspace then runs
  // with.
  let B;
  before(() => {
    B = path.join(world.projects, 'ws-b');
    fx.write(path.join(B, '.rundock', 'state.json'), '{"workspaceMode":"code"}\n');
    fx.write(path.join(B, '.rundock', 'permissions.json'), '{}\n');
    fx.write(path.join(B, '.claude', 'settings.local.json'), '{}\n');
    fx.write(path.join(B, '.claude', 'agents', 'helper.md'), '---\nname: helper\n---\n');
    fx.write(path.join(B, '.claude', 'skills', 'tidy', 'SKILL.md'), '---\nname: tidy\n---\n');
    fx.write(path.join(B, 'CLAUDE.md'), '# b\n');
  });
  const named = () => [world.projects];
  const isAnswerFile = p => !!p && (p.answer_file === true || (Array.isArray(p.crossings) && p.crossings.some(c => c.answerFile)));

  for (const [label, extraDirs] of [['with the parent named', named], ['with no folders named', () => []]]) {
    for (const f of ['.rundock/permissions.json', '.rundock/state.json']) {
      test(`${f}: an Edit, a shell write and a Codex file change are the answer-file card (${label})`, async () => {
        const target = path.join(B, f);
        const edit = await fx.judge(world, capture, deadPort, { tool: 'Edit', input: { file_path: target, old_string: '{', new_string: '{"allowedTools":["Bash"],' }, cwd: world.app, extraDirs: extraDirs() });
        assert.strictEqual(isAnswerFile(edit.payload), true, 'Edit');
        assert.strictEqual(edit.payload.grant_dir || null, null);
        assert.strictEqual(edit.dead.decision, 'deny', 'refused when nobody can be asked');
        const shell = await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command: `echo '{}' > ${target}` }, cwd: world.app, extraDirs: extraDirs() });
        assert.strictEqual(isAnswerFile(shell.payload), true, 'shell');
        assert.strictEqual(shell.dead.decision, 'deny');
        const { gradeCodexApproval } = require('../../lib/runtime/codex-approval.js');
        for (const grantRoot of [target, path.join(B, '.rundock'), B]) {
          const g = gradeCodexApproval({ kind: 'fileChange', params: { grantRoot }, workspaceRoot: world.ws, extraDirs: extraDirs(), codeMode: true, home: world.home });
          assert.strictEqual(g.decision, 'card', `Codex, grantRoot ${path.relative(world.projects, grantRoot)}`);
          assert.strictEqual(g.request.grant_dir || null, null);
        }
      });
    }

    test(`the sibling workspace's Claude settings files are answer files too (${label})`, async () => {
      for (const f of ['.claude/settings.local.json', '.claude/settings.json']) {
        const target = path.join(B, f);
        fx.write(target, '{}\n');
        const edit = await fx.judge(world, capture, deadPort, { tool: 'Edit', input: { file_path: target, old_string: '{', new_string: '{"hooks":{},' }, cwd: world.app, extraDirs: extraDirs() });
        assert.strictEqual(isAnswerFile(edit.payload), true, `${f}: Edit`);
        assert.strictEqual(edit.payload.grant_dir || null, null);
        assert.strictEqual(edit.dead.decision, 'deny', `${f}: refused when nobody can be asked`);
        const shell = await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command: `echo '{}' > ${target}` }, cwd: world.app, extraDirs: extraDirs() });
        assert.strictEqual(isAnswerFile(shell.payload), true, `${f}: shell`);
        const { gradeCodexApproval } = require('../../lib/runtime/codex-approval.js');
        for (const grantRoot of [target, path.join(B, '.claude')]) {
          const g = gradeCodexApproval({ kind: 'fileChange', params: { grantRoot }, workspaceRoot: world.ws, extraDirs: extraDirs(), codeMode: true, home: world.home });
          assert.strictEqual(g.decision, 'card', `${f}: Codex, grantRoot ${path.relative(world.projects, grantRoot)}`);
          const isAf = g.request.answer_file === true || (g.request.crossings || []).some(c => c.answerFile);
          assert.strictEqual(isAf, true, `${f}: Codex answer-file card`);
        }
      }
    });

    test(`another workspace's agents and skills always ask, never remembered (${label})`, async () => {
      for (const f of ['.claude/agents/helper.md', '.claude/skills/tidy/SKILL.md']) {
        const target = path.join(B, f);
        const edit = await fx.judge(world, capture, deadPort, { tool: 'Edit', input: { file_path: target, old_string: 'name', new_string: 'name' }, cwd: world.app, extraDirs: extraDirs() });
        assert.ok(edit.payload && edit.payload.boundary, `${f}: carded`);
        assert.strictEqual(edit.payload.grant_dir || null, null, `${f}: never remembered`);
        assert.ok(edit.payload.crossings.some(c => c.persistenceSurface), `${f}: as a persistence surface`);
        assert.strictEqual(edit.dead.decision, 'deny', `${f}: refused when nobody can be asked`);
        const shell = await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command: `echo 'hooks: {}' >> ${target}` }, cwd: world.app, extraDirs: extraDirs() });
        assert.ok(shell.payload && shell.payload.boundary && shell.payload.grant_dir == null, `${f}: shell write carded`);
      }
      const { gradeCodexApproval } = require('../../lib/runtime/codex-approval.js');
      for (const grantRoot of [path.join(B, '.claude', 'agents'), path.join(B, '.claude'), B]) {
        const g = gradeCodexApproval({ kind: 'fileChange', params: { grantRoot }, workspaceRoot: world.ws, extraDirs: extraDirs(), codeMode: true, home: world.home });
        assert.strictEqual(g.decision, 'card', `Codex, grantRoot ${path.relative(world.projects, grantRoot)}`);
      }
    });
  }

  test('another workspace\'s CLAUDE.md is an ordinary file: it carries no permission keys', async () => {
    const r = await fx.judge(world, capture, deadPort, { tool: 'Edit', input: { file_path: path.join(B, 'CLAUDE.md'), old_string: 'b', new_string: 'c' }, cwd: world.app });
    assert.strictEqual(r.cls, 'runs');
  });

  test('this workspace\'s own agents are its own to edit', async () => {
    const r = await fx.judge(world, capture, deadPort, { tool: 'Edit', input: { file_path: path.join(world.ws, '.claude', 'agents', 'mine.md'), old_string: 'a', new_string: 'b' }, cwd: world.app });
    assert.strictEqual(r.cls, 'runs');
  });

  test('this workspace\'s own .claude/settings.json is an answer file, and a project\'s is ordinary work', async () => {
    const own = await fx.judge(world, capture, deadPort, { tool: 'Edit', input: { file_path: path.join(world.ws, '.claude', 'settings.json'), old_string: '{', new_string: '{"hooks":{},' }, cwd: world.app });
    assert.strictEqual(isAnswerFile(own.payload), true, 'the workspace\'s project settings');
    assert.strictEqual(own.dead.decision, 'deny');
    // A code project's own Claude settings, in a named working folder, in Code
    // mode: ordinary work, by file tool, shell and Codex.
    const repoSettings = path.join(world.app, '.claude', 'settings.json');
    fx.write(repoSettings, '{}\n');
    const repo = await fx.judge(world, capture, deadPort, { tool: 'Edit', input: { file_path: repoSettings, old_string: '{', new_string: '{' }, cwd: world.app, extraDirs: [world.projects] });
    assert.strictEqual(repo.cls, 'runs', 'a code project\'s own Claude settings stay ordinary work');
    const repoShell = await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command: `echo '{}' > ${repoSettings}` }, cwd: world.app, extraDirs: [world.projects] });
    assert.strictEqual(repoShell.cls, 'runs');
    const { gradeCodexApproval } = require('../../lib/runtime/codex-approval.js');
    assert.deepStrictEqual(gradeCodexApproval({ kind: 'fileChange', params: { grantRoot: repoSettings }, workspaceRoot: world.ws, extraDirs: [world.projects], codeMode: true, home: world.home }), { decision: 'accept' });
    fs.rmSync(path.join(world.app, '.claude'), { recursive: true, force: true });
  });

  test('Rundock\'s own write to the workspace\'s settings.json during a Codex turn is neither reverted nor reported', () => {
    const guardLib = require('../../lib/workspace/answer-file-guard.js');
    const scaffold = require('../../lib/workspace/scaffold.js');
    const settings = path.join(world.ws, '.claude', 'settings.json');
    fx.write(settings, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'afplay /System/Library/Sounds/Glass.aiff' }] }] } }, null, 2));
    const changes = [];
    const g = guardLib.acquireAnswerFileGuard(world.ws, c => changes.push(c));
    try {
      scaffold.muteHooks(world.ws);
      g.check();
    } finally { g.release(); }
    assert.match(fs.readFileSync(settings, 'utf-8'), /\$RUNDOCK/, 'Rundock muted the sound hook, and the change stands');
    assert.deepStrictEqual(changes, []);
    fs.rmSync(settings, { force: true });
  });
});
