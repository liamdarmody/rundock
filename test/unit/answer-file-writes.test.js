'use strict';
// A COMMAND ASKS ABOUT AN ANSWER FILE WHEN IT CAN WRITE IT, NOT WHEN IT ONLY
// READS IT.
//
// A segment that named an answer file and was not entirely read-only was taken
// as changing it, so `git diff .mcp.json`, `jq . .mcp.json` and
// `cp .mcp.json backup.json` asked as a change, and were refused unattended in
// Code mode. Now a file a command names counts as written when the command can
// write it: a redirect or `tee` into it, a copy, install or `dd` onto it,
// `sed -i` or `perl -i`, `rm`, `mv`, `ln`, `touch`, `truncate`, `chmod`, a git
// command that changes the working tree there, or anything the check does not
// know to be a reader. `git add` and `git commit` naming one still ask.
//
// Driven against a workspace in the temp folder, so it needs no fixture.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');
const hook = require(HOOK);

let ws, closed;
before(async () => {
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'answer-writes-')));
  for (const f of ['.rundock/state.json', '.rundock/permissions.json', '.rundock/permission-hook.sh', '.rundock/mcp-secrets.json',
    '.mcp.json', '.claude/settings.json', '.claude/settings.local.json', '.claude/hooks/pre-tool.sh', 'x.json', 'notes.txt']) {
    fs.mkdirSync(path.dirname(path.join(ws, f)), { recursive: true });
    fs.writeFileSync(path.join(ws, f), '{}\n');
  }
  const s = http.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  closed = s.address().port;
  await new Promise(r => s.close(r));
});
after(() => { if (ws) fs.rmSync(ws, { recursive: true, force: true }); });

const READS = [
  'git diff .mcp.json', 'git log -- .mcp.json', 'git --no-pager diff -- .claude/settings.json', 'git -C . show HEAD -- .mcp.json',
  'git blame .claude/hooks/pre-tool.sh', 'git status .mcp.json', 'jq . .mcp.json', 'jq .mcpServers .mcp.json > servers.json',
  'diff .mcp.json x.json', 'cmp .rundock/permission-hook.sh x.json', 'cp .mcp.json backup.json', 'cp .rundock/mcp-secrets.json secrets.bak',
  'cat .mcp.json > copy.json', 'sed s/a/b/ .claude/settings.json', 'sed -n 1,5p .mcp.json', 'dd if=.mcp.json of=copy.json',
  'shasum .rundock/permission-hook.sh', 'install -m 644 .mcp.json backup.json', 'cat .rundock/permissions.json > copy.json',
  'tree -a .claude/hooks', 'file .mcp.json', 'stat .rundock/permission-hook.sh', 'strings .rundock/permission-hook.sh',
  // An input redirect is a read, whatever program it feeds.
  'python3 tools/run.py < .mcp.json', 'node tool.js 0< .claude/settings.json', 'python3 tools/run.py <.mcp.json > out.txt',
  'python3 tools/run.py <<< .mcp.json',
];
const WRITES = [
  'echo x > .mcp.json', 'echo x >> .mcp.json', 'echo x 1> .mcp.json', 'echo x >.mcp.json', 'echo x &> .mcp.json', 'echo x | tee .mcp.json',
  'jq . x.json > .mcp.json', 'cp x.json .mcp.json', 'install x.json .mcp.json', 'dd if=x.json of=.mcp.json',
  "sed -i '' s/a/b/ .mcp.json", 'sed -i.bak s/a/b/ .claude/settings.json', 'sed -Ei s/a/b/ .mcp.json', 'sed --in-place s/a/b/ .mcp.json',
  // macOS sed edits in place with a capital -I as well.
  "sed -I '' s/a/b/ .mcp.json", 'sed -I .bak s/a/b/ .mcp.json', 'sed -I.bak s/a/b/ .claude/settings.json', 'sed -EI s/a/b/ .mcp.json',
  'perl -pi -e s/a/b/ .mcp.json', 'touch .rundock/permission-hook.sh', 'truncate -s 0 .rundock/mcp-secrets.json',
  'chmod 777 .rundock/permission-hook.sh', 'rm .mcp.json', 'mv .mcp.json old.json', 'mv x.json .mcp.json', 'ln -s .mcp.json alias.json',
  'cp -l .mcp.json x.json', 'cp --link .mcp.json x.json', 'cp -t . .mcp.json', 'rsync --remove-source-files .mcp.json x.json',
  'git checkout -- .mcp.json', 'git restore .claude/settings.json', 'git add .mcp.json', 'git commit -m x .mcp.json',
  'git diff --output=.mcp.json', 'python3 tool.py .mcp.json', 'echo x > .claude/hooks/pre-tool.sh', 'cp x.json .claude/hooks/new.sh',
  "cat > .mcp.json <<'EOF'\nx\nEOF",
  // Viewers and listers that write a file they are given with no redirect:
  // a pager's log file, sdiff's merged output, tree's output file, a compiled
  // magic file, and the folders install -d creates or sets the mode of.
  'less -o .mcp.json x.json', 'less -O .mcp.json x.json', 'less --log-file=.mcp.json x.json', 'more -o .mcp.json x.json',
  'sdiff -o .mcp.json x.json notes.txt', 'sdiff --output=.mcp.json x.json notes.txt', 'bat cache --build --target .claude/hooks',
  'tree -o .mcp.json', 'tree -a -o .claude/settings.json', 'tree -ao .rundock/permission-hook.sh', 'file -C -m .claude/hooks/magic',
  'install -d .claude/hooks/new', 'install -d -m 000 .rundock/mcp-secrets.json',
  // Code handed to an interpreter names a file in a string literal, and a bare
  // name with no slash in it is still one: any literal there can be opened for
  // writing or removed, and nothing here can tell that it is not.
  "python3 - <<'PY'\nopen('.mcp.json','w').write('{}')\nPY",
  "python3 - <<'PY'\nimport shutil\nshutil.rmtree('.claude')\nPY",
  "python3 - <<'PY'\nimport shutil\nshutil.rmtree('.rundock')\nPY",
  "node - <<'JS'\nrequire('fs').rmSync('.claude', { recursive: true })\nJS",
  "python3 -c \"open('.mcp.json','w')\"", "node -e \"require('fs').writeFileSync('.mcp.json', '{}')\"",
  "python3 - <<'PY'\nopen('./.mcp.json','w')\nPY", "python3 - <<'PY'\nopen('.rundock/permission-hook.sh','w')\nPY",
  // Where the folder a word starts from is not certain, each literal cd in the
  // command is tried as well, chained where one follows another, and a loop
  // variable written to is tried with each word of its list.
  'if true; then cd .claude/hooks && echo x > pre.sh; fi', 'cd .claude && cd hooks && echo x > pre.sh',
  'cd .claude; echo x > settings.json', 'for f in .mcp.json; do echo x > $f; done',
  'for f in a.json .mcp.json; do cp x.json "$f"; done', 'for d in .claude; do rm -rf ${d}; done',
  "sh -c 'cd .claude && echo x > settings.json'", 'pushd .claude/hooks && echo x > pre.sh && popd',
  'ls; cd .rundock && cd .. && cd .claude && echo x > settings.json',
  // An output redirect from the same program still writes, and so does one
  // opened for reading and writing, or a file named as an argument too.
  'python3 tools/run.py > .mcp.json', 'python3 tools/run.py <> .mcp.json', 'python3 tools/run.py .mcp.json < .mcp.json',
  // A shell given its command with -c reads that word as commands, so what
  // they write is judged as if typed: through common prefixes and a path too.
  'sh -c "echo x > .mcp.json"', "bash -c 'rm -rf .claude'", "zsh -c 'cp a .claude/settings.json'", "bash -lc 'echo x >> .mcp.json'",
  "env FOO=1 bash -c 'rm .mcp.json'", "/bin/sh -c 'touch .claude/hooks/x.sh'", "exec dash -c 'echo x > .mcp.json'",
  "nohup sh -c 'rm -rf .rundock' &", "sudo -u someone sh -c 'echo x > .mcp.json'", "bash -e -c 'mv x.json .mcp.json'",
  // The forms that asked before this change, and still do.
  'echo x > .rundock/permissions.json', 'echo x >> .rundock/state.json', 'cat x > .claude/settings.local.json', 'tee .rundock/permissions.json',
  'echo x | tee -a .rundock/state.json', 'sed -i s/a/b/ .rundock/permissions.json', 'cp x .rundock/permissions.json', 'mv x .claude/settings.json',
  'rm .rundock/permissions.json', 'cat .rundock/permissions.json; echo x > .rundock/permissions.json', 'truncate -s 0 .rundock/state.json',
  'ln -sf x .rundock/permissions.json',
];

const answerFileIn = (command, codeMode) => {
  const a = hook.classifyShellAccess('Bash', { command }, ws, [], os.homedir(), true, { cwd: ws, codeMode });
  return !!(a && hook.boundaryCrossingsFor(a).some(c => c && c.answerFile));
};

describe('a command asks about an answer file only when it can write it', () => {
  for (const codeMode of [false, true]) {
    const label = codeMode ? 'Code' : 'Notes';
    test(`commands that only read one name no answer file (${label} mode)`, () => {
      for (const c of READS) assert.strictEqual(answerFileIn(c, codeMode), false, `${label}: ${c}`);
    });
    test(`every form that can write one still asks (${label} mode)`, () => {
      for (const c of WRITES) assert.strictEqual(answerFileIn(c, codeMode), true, `${label}: ${c}`);
    });
  }

  // A FOLDER THAT HOLDS ANSWER FILES IS THEM. Removing, moving or replacing
  // `.claude` or `.rundock` changes every answer file inside, and a copy or move
  // into a folder writes the file of the same name there.
  const FOLDER_WRITES = [
    'rm -rf .claude', 'mv .claude old-claude', 'rm -rf .rundock', 'mv .rundock old', 'rm -rf .claude/hooks', 'chmod -R 000 .rundock',
    'git checkout -- .claude', 'cp -r backup/.claude .', 'cp backup/.mcp.json .', 'mv backup/settings.json .claude',
    'cp backup/permission-hook.sh .rundock/', 'rm -rf .claude/*', 'rm .rundock/*.json', 'rm -rf .*', 'rm -f .m?p.json',
    'rm -rf projects/other-ws/.rundock', 'mv projects/other-ws/.claude x', 'install -d -m 000 .claude',
    // The shell expands braces before the command sees the word, and `[!...]`
    // and `[^...]` are classes that match what they do not name.
    'rm -rf .{claude,rundock}', 'rm -rf {src,.claude}', 'rm -f .{mcp,other}.json', 'rm -rf .claude/{hooks,agents}', 'rm -rf .{a,{b,rundock}}',
    'rm -rf .[!.]*', 'rm -rf .[^.]*', 'rm -rf .[!a]*',
  ];
  const FOLDER_ORDINARY = [
    'rm -rf .rundock/scratch', 'rm -rf .rundock/scratch/*', 'ls .claude', 'cp -r .claude backup', 'cp x.json .', 'mv notes.txt .claude/agents/',
    'rm -rf node_modules', 'rm *.json', 'git add .', 'rm -rf .claude/agents/old.md', 'cp -r skills .claude/skills', 'rm -rf *',
    // Into a folder that holds answer files, under another name: only that name is written.
    'cp x.json .claude', 'mv notes.txt .rundock/', 'cp -t .claude x.json',
    'rm -rf {src,dist}', 'rm -rf .claude/{agents,skills}', 'rm -rf [!.]*', 'rm -rf .[!cmr]*', 'echo ${HOME}',
    // A `[` with no `]` after it is the character itself, not a class.
    '[ -f x.json ] && rm notes.txt', 'rm -f [ x.json', 'touch .[a',
    // A cd and a loop that reach only ordinary files name none.
    'cd skills && echo x > .mcp.json', 'for f in a.txt notes.txt; do echo x > $f; done', 'cd .claude && ls agents',
    'echo x > settings.json; if true; then cd .claude; fi', "cd \"$DIR\" && cd hooks; echo x > notes.txt",
    // A shell's -c command that writes only ordinary files names none.
    "bash -c 'echo hi > notes.txt'", "sh -c 'cat .mcp.json'", "bash -c 'ls .claude'",
    // Code naming only ordinary files names no answer file.
    "python3 - <<'PY'\nopen('notes.txt','w').write('x')\nprint('done')\nPY", "node -e \"require('fs').writeFileSync('x.json', 'w')\"",
  ];
  test('a command that removes, moves or writes into a folder holding answer files asks', () => {
    for (const d of ['backup/.claude', 'projects/other-ws/.rundock', 'projects/other-ws/.claude', '.claude/agents', '.rundock/scratch', 'skills']) fs.mkdirSync(path.join(ws, d), { recursive: true });
    fs.writeFileSync(path.join(ws, 'projects', 'other-ws', '.rundock', 'state.json'), '{}');
    for (const codeMode of [false, true]) {
      for (const c of FOLDER_WRITES) assert.strictEqual(answerFileIn(c, codeMode), true, `${codeMode ? 'Code' : 'Notes'}: ${c}`);
      for (const c of FOLDER_ORDINARY) assert.strictEqual(answerFileIn(c, codeMode), false, `${codeMode ? 'Code' : 'Notes'}: ${c}`);
    }
  });

  // The shared read-only vocabulary frees a command everywhere it is used, so
  // a lister given a file to write is not a read there either: `tree -o` into
  // the runtime's own settings would otherwise pass as a read of them.
  test('tree -o and file -C are not reads in the shared vocabulary', () => {
    const { isReadOnlyShellCommand } = require('../../public/read-only-shell.js');
    for (const c of ['tree -o out.txt', 'tree -ao out.txt .', 'file -C -m magic', 'file --compile -m magic']) {
      assert.strictEqual(isReadOnlyShellCommand(c), false, c);
    }
    for (const c of ['tree', 'tree -a -L 2 .claude', 'file x.json', 'tree --noreport .']) {
      assert.strictEqual(isReadOnlyShellCommand(c), true, c);
    }
    const home = os.homedir();
    const a = hook.classifyShellAccess('Bash', { command: `tree -o ${path.join(home, '.claude', 'settings.json')}` }, ws, [], home, true, { cwd: ws });
    assert.ok(a && hook.boundaryCrossingsFor(a).length > 0, "tree -o into the runtime's own settings is a crossing");
  });

  // `git clean -x` and `-X` name no file, yet remove what git ignores, and the
  // workspace's own `.rundock` folder is ignored: the permission answers, the
  // launcher and the connector secrets go with it. Notes mode grades the
  // command destructive; Code mode ran it when nothing untracked was lost.
  test('git clean that removes ignored files asks in Code mode while .rundock is in reach', () => {
    const { codeModeVerdict } = require('../../scripts/code-mode-verdict.js');
    const context = {
      gitTop: () => ws, canonical: p => path.resolve(p), exists: () => true,
      gitStatus: () => ({ ok: true, tracked: [], untracked: [], ignoredEnv: [], deleted: [] }),
    };
    const verdict = c => codeModeVerdict({ command: c, workspaceRoot: ws, cwd: ws, toolName: 'Bash', context, platform: process.platform });
    for (const c of ['git clean -fdx', 'git clean -fdX', 'git clean -f -d -x', 'git clean -fx .rundock', 'git clean -fdx .']) {
      const v = verdict(c);
      assert.strictEqual(v.verdict, 'always-asks', c);
      assert.ok(JSON.stringify(v).includes('.rundock'), `${c}: the card names it`);
    }
    for (const c of ['git clean -fd', 'git clean -fdx src', 'git clean -ndx']) assert.strictEqual(verdict(c).verdict, 'runs', c);
  });

  function hookDecision(command, codeMode) {
    const env = { ...process.env, RUNDOCK: '1', RUNDOCK_WORKSPACE: ws, RUNDOCK_PORT: String(closed), RUNDOCK_EXTRA_DIRS: '' };
    delete env.RUNDOCK_CODE_MODE;
    delete env.NODE_V8_COVERAGE;
    if (codeMode) env.RUNDOCK_CODE_MODE = '1';
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [HOOK], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', () => { try { resolve(JSON.parse(out).hookSpecificOutput.permissionDecision); } catch (e) { resolve('none'); } });
      child.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', cwd: ws, tool_name: 'Bash', tool_input: { command } }));
    });
  }
  test('through the real hook in Code mode, the reads run unattended and a write is refused', async () => {
    for (const c of ['git diff .mcp.json', 'jq . .mcp.json', 'cp .mcp.json backup.json', 'diff .mcp.json x.json']) {
      assert.strictEqual(await hookDecision(c, true), 'allow', c);
    }
    assert.strictEqual(await hookDecision('cp x.json .mcp.json', true), 'deny', 'a copy onto it is still refused with nobody to ask');
  });
});
