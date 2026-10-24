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
  // Perl's three-argument open names the file. (The two-argument form, with
  // the mode written into the name, is not caught; see ARCHITECTURE.md.)
  "perl -e \"open(F, '>', '.claude/hooks/pre.sh')\"",
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
  // `<>` opens the file for writing too, and makes it if it is missing,
  // whatever the program it feeds then does.
  'cat <> .mcp.json', 'cat 0<>.claude/settings.json',
  // A shell given its command with -c reads that word as commands, so what
  // they write is judged as if typed: through common prefixes and a path too.
  'sh -c "echo x > .mcp.json"', "bash -c 'rm -rf .claude'", "zsh -c 'cp a .claude/settings.json'", "bash -lc 'echo x >> .mcp.json'",
  "env FOO=1 bash -c 'rm .mcp.json'", "/bin/sh -c 'touch .claude/hooks/x.sh'", "exec dash -c 'echo x > .mcp.json'",
  "nohup sh -c 'rm -rf .rundock' &", "sudo -u someone sh -c 'echo x > .mcp.json'", "bash -e -c 'mv x.json .mcp.json'",
  // timeout and xargs run what follows them too, past their own options and
  // timeout's duration, and a shell's command is read for the shells and the
  // code it runs in turn.
  "timeout 10 sh -c 'echo x > .mcp.json'", "timeout -s KILL -k 5 30s bash -c 'rm -rf .claude'", "timeout --signal=TERM 5 sh -c 'rm .mcp.json'",
  "timeout --preserve-status 1m bash -c 'touch .claude/hooks/x.sh'",
  "find . -print0 | xargs -0 sh -c 'echo x > .mcp.json'", "ls | xargs -n 1 -P 4 bash -c 'rm -rf .claude'", "ls | xargs -I{} sh -c 'cp {} .claude/settings.json'",
  "ls | xargs --null -r sh -c 'rm .mcp.json'",
  "bash -c \"bash -c 'echo x > .mcp.json'\"", "sh -c \"timeout 5 sh -c 'rm -rf .rundock'\"", "bash -c \"python3 -c 'open(\\\".mcp.json\\\", \\\"w\\\")'\"",
  // Code given on the command line is read after the same prefixes.
  "timeout 5 python3 -c \"open('.mcp.json','w')\"", "env python3 -c \"open('.mcp.json','w')\"", "nohup node -e \"require('fs').rmSync('.claude', { recursive: true })\"",
  "ls | xargs python3 -c \"open('.mcp.json','w')\"", "uv run python -c \"open('.mcp.json','w')\"", "uv run --with requests python -c \"open('.mcp.json','w')\"",
  "npx node -e \"require('fs').writeFileSync('.mcp.json', '{}')\"", "sudo -u someone python3 -c \"open('.mcp.json','w')\"",
  // BSD xargs's -J, -R and -S take values, and gtimeout, stdbuf, ionice and
  // caffeinate run what follows them.
  "ls | xargs -J % sh -c 'rm .mcp.json'", "ls | xargs -R 2 -S 255 sh -c 'rm .mcp.json'", "gtimeout -k 5 30 sh -c 'rm -rf .claude'",
  "stdbuf -o L sh -c 'echo x > .mcp.json'", "stdbuf -oL sh -c 'echo x > .mcp.json'", "ionice -c 3 sh -c 'rm .mcp.json'",
  "caffeinate -t 60 sh -c 'rm .mcp.json'", "caffeinate -i python3 -c \"open('.mcp.json','w')\"",
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
    "timeout 5 sh -c 'echo hi > notes.txt'", "ls | xargs -0 sh -c 'cat .mcp.json'", "bash -c \"bash -c 'cat .mcp.json'\"",
    "timeout 5 python3 -c \"print(open('.mcp.json').read())\"", "uv run python -c \"print('ok')\"", "caffeinate -i sh -c 'echo hi > notes.txt'",
    "bash -c \"python3 -c 'print(open(\\\".mcp.json\\\").read())'\"",
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
  // CODE ASKS ABOUT AN ANSWER FILE UNLESS IT ONLY READS IT. A path in code
  // handed to an interpreter (a literal, or one built from parts by a join,
  // pathlib's `/`, an f-string or a template) that names an answer file, a
  // folder holding them or the console folder counts as written, unless every
  // use of it is one the check recognises as a read or as plain string
  // handling (CODE_READS_ALLOWED in the hook). A use it does not recognise
  // asks: an alias, a helper or a form nobody listed is a write until shown
  // otherwise.
  const CODE_READS = [
    "python3 -c \"import json; print(json.load(open('.mcp.json')))\"",
    "node -e \"console.log(require('fs').readFileSync('.claude/settings.json', 'utf8'))\"",
    "python3 - <<'PY'\nimport os\nfor root, dirs, files in os.walk('.'):\n    dirs[:] = [d for d in dirs if d not in ('.git', '.claude', '.rundock')]\n    for f in files:\n        print(os.path.join(root, f))\nPY",
    "cat > tools/walk.py <<'PY'\nimport os\nSKIP = {'.claude', '.rundock', '.git'}\nfor root, dirs, files in os.walk('.'):\n    dirs[:] = [d for d in dirs if d not in SKIP]\nPY",
    "python3 -c \"print('.claude')\"",
    "python3 - <<'PY'\nimport os\nfor root, dirs, files in os.walk('.'):\n    if '.claude' in dirs:\n        dirs.remove('.claude')\nPY",
    "python3 - <<'PY'\nCFG = '.mcp.json'\nprint(open(CFG).read())\nPY",
    "python3 - <<'PY'\nopen('.mcp.json', 'r').read()\nopen('.claude/settings.json', encoding='utf-8').read()\nPY",
    "node -e \"const p = '.claude'; console.log(p.replace('.', ''))\"",
    "python3 - <<'PY'\nimport shutil\nshutil.copy('.mcp.json', 'backup.json')\nPY",
    "python3 - <<'PY'\nfrom pathlib import Path\nprint(Path('.claude/settings.json').read_text())\nPY",
    "perl -e \"open(F, '<', '.mcp.json'); print <F>\"",
    "ruby -e \"puts File.read('.mcp.json')\"",
    // What a write call writes is its path, not the content handed to it.
    "node -e \"require('fs').writeFileSync('out.json', require('fs').readFileSync('.mcp.json'))\"",
    // A loop's list ends where a comprehension's condition starts.
    "python3 - <<'PY'\nimport os, shutil\n[shutil.rmtree(d) for d in os.listdir('build') if d not in ('.claude', '.rundock')]\nPY",
    // A path built from parts is judged whole: inside .claude or .rundock is
    // not an answer file, and a string pattern is not a path.
    "python3 - <<'PY'\nimport os\nos.makedirs(os.path.join('.rundock', 'scratch'), exist_ok=True)\nPY",
    "node -e \"require('fs').mkdirSync(require('path').join('.rundock', 'scratch', 'x'), { recursive: true })\"",
    "python3 - <<'PY'\nfrom pathlib import Path\n(Path('.claude') / 'agents' / 'new.md').write_text('x')\nPY",
    "python3 - <<'PY'\nfrom pathlib import Path\nfor p in Path('docs').rglob('*.md'):\n    print(str(p).replace('.claude/', ''))\nPY",
    "python3 - <<'PY'\nfrom pathlib import Path\nf = Path('notes.md')\nf.write_text(f.read_text().replace('.claude', '.config'))\nPY",
    // Tests of a path, listings, comparisons and printing are reads.
    "python3 -c \"import os; print(os.path.exists('.mcp.json'), os.path.isdir('.claude'))\"",
    "node -e \"const fs = require('fs'); if (fs.existsSync('.claude/settings.json')) console.log(fs.statSync('.mcp.json').size)\"",
    "python3 - <<'PY'\nimport os\nfor name in os.listdir('.claude'):\n    print(name)\nPY",
    "python3 -c \"import sys; print(sys.argv[1] == '.mcp.json')\"",
    "ruby -e \"puts File.exist?('.mcp.json')\"",
    "python3 - <<'PY'\nfrom pathlib import Path\nprint(Path('.mcp.json').exists(), Path('.claude').is_dir())\nPY",
  ];
  const CODE_WRITES = [
    "python3 - <<'PY'\nCFG = '.mcp.json'\nwith open(CFG, 'w') as f:\n    f.write('{}')\nPY",
    "python3 - <<'PY'\nimport json\njson.dump({}, open('.mcp.json', 'a'))\nPY",
    "python3 - <<'PY'\nimport os\nos.remove(os.path.join('.claude', 'settings.json'))\nPY",
    "python3 - <<'PY'\nimport os\nos.makedirs('.claude/hooks', exist_ok=True)\nPY",
    "python3 - <<'PY'\nimport shutil\nshutil.move('x.json', '.mcp.json')\nPY",
    "python3 - <<'PY'\nimport shutil\nshutil.copytree('backup', '.claude')\nPY",
    "python3 - <<'PY'\nfrom pathlib import Path\nPath('.mcp.json').write_text('{}')\nPY",
    "python3 - <<'PY'\nfrom pathlib import Path\np = Path('.claude') / 'settings.json'\np.write_text('{}')\nPY",
    "python3 - <<'PY'\nfrom pathlib import Path\nPath('.claude/hooks/pre-tool.sh').unlink()\nPY",
    "python3 - <<'PY'\nimport shutil\nfor d in ('.claude', '.rundock'):\n    shutil.rmtree(d)\nPY",
    "python3 - <<'PY'\nimport subprocess\nsubprocess.run(['rm', '-rf', '.claude'])\nPY",
    "python3 -c \"import os; os.system('rm .mcp.json')\"",
    "node -e \"require('fs').promises.rm('.claude', { recursive: true })\"",
    "node -e \"const fs = require('fs'); fs.appendFileSync('.mcp.json', 'x')\"",
    "node -e \"const { rmSync } = require('fs'); rmSync('.rundock', { recursive: true })\"",
    "node -e \"require('fs').renameSync('x.json', '.claude/settings.json')\"",
    "node -e \"require('child_process').execSync('rm -rf .claude')\"",
    "ruby -e \"File.write('.mcp.json', '{}')\"", "ruby -e \"require 'fileutils'; FileUtils.rm_rf('.claude')\"",
    "perl -e \"unlink('.mcp.json')\"",
    "python3 - <<'PY'\nimport os\nos.open('.mcp.json', os.O_WRONLY | os.O_CREAT)\nPY",
    "node -e \"require('fs').unlink('.mcp.json', () => {})\"",
    "node -e \"for (const d of ['.claude']) require('fs').rmSync(d, { recursive: true })\"",
    "node -e \"const dirs = ['.claude', '.rundock']; dirs.forEach(d => require('fs').rmSync(d, { recursive: true }))\"",
    "ruby -e \"require 'fileutils'; dirs = ['.claude']; dirs.each { |d| FileUtils.rm_rf(d) }\"",
    "perl -e 'foreach my $f (\".mcp.json\") { unlink($f) }'",
    // Forms nobody listed are writes until shown otherwise: aliases, runners
    // imported under another name, names inside f-strings and templates, a
    // path object's own writes, a mode kept in a variable, and a path kept
    // somewhere the check does not follow.
    "python3 - <<'PY'\nfrom shutil import rmtree as r\nr('.claude')\nPY",
    "python3 - <<'PY'\nimport os as o\no.remove('.mcp.json')\nPY",
    "python3 - <<'PY'\nimport subprocess as sp\nsp.run(['rm', '-rf', '.claude'])\nPY",
    "python3 - <<'PY'\nfrom subprocess import run\nrun(['rm', '-rf', '.claude'])\nPY",
    "python3 - <<'PY'\nimport os\nos.execvp('rm', ['rm', '-rf', '.claude'])\nPY",
    "python3 - <<'PY'\nimport subprocess\nfor d in ['.claude', '.rundock']:\n    subprocess.run(['rm', '-rf', d])\nPY",
    "python3 - <<'PY'\nd = '.claude'\nopen(f'{d}/settings.json', 'w').write('{}')\nPY",
    "node - <<'JS'\nconst d = '.claude';\nrequire('fs').rmSync(`${d}`, { recursive: true });\nJS",
    "ruby - <<'RB'\nrequire 'fileutils'\nd = '.claude'\nFileUtils.rm_rf(\"#{d}\")\nRB",
    "node - <<'JS'\nconst { rmSync: r } = require('fs');\nr('.claude', { recursive: true });\nJS",
    "node - <<'JS'\nimport * as f from 'node:fs/promises';\nawait f.rm('.claude', { recursive: true });\nJS",
    "node - <<'JS'\nconst p = require('fs').promises;\np.unlink('.mcp.json');\nJS",
    "node - <<'JS'\nconst fsx = require('fs');\nfsx.unlink('.mcp.json', () => {});\nJS",
    "python3 - <<'PY'\nfrom pathlib import Path\nPath.cwd().joinpath('.mcp.json').write_text('{}')\nPY",
    "ruby - <<'RB'\nrequire 'pathname'\nPathname.new('.claude').rmtree\nRB",
    "ruby - <<'RB'\nrequire 'pathname'\nPathname.new('.mcp.json').write('{}')\nRB",
    "ruby - <<'RB'\nrequire 'pathname'\nPathname.new('.mcp.json').delete\nRB",
    "python3 - <<'PY'\nm = 'w'\nopen('.mcp.json', m).write('{}')\nPY",
    "python3 - <<'PY'\nimport os\nos.open('.mcp.json', 577)\nPY",
    "python3 - <<'PY'\na, b = '.mcp.json', 'x.json'\nopen(a, 'w').write('{}')\nPY",
    "python3 - <<'PY'\nclass C:\n    def __init__(self):\n        self.path = '.mcp.json'\n    def save(self):\n        open(self.path, 'w').write('{}')\nC().save()\nPY",
    // A path built from parts that names one, or a folder holding them with
    // the rest unknown, asks.
    "node -e \"require('fs').writeFileSync(require('path').join('.claude', 'hooks', 'x.sh'), '')\"",
    "python3 - <<'PY'\nfrom pathlib import Path\n(Path('.claude') / 'settings.json').write_text('{}')\nPY",
    "python3 - <<'PY'\nimport os, sys\nos.remove(os.path.join('.claude', sys.argv[1]))\nPY",
    "python3 - <<'PY'\nimport os\nB = '.claude'\nF = 'settings.json'\nos.remove(os.path.join(B, F))\nPY",
    // What is done with a listing, or with a result that carries the path
    // on, is what counts.
    "python3 - <<'PY'\nimport glob, os\nfor p in glob.glob('.claude/hooks/*'):\n    os.remove(p)\nPY",
    "python3 - <<'PY'\nfrom pathlib import Path\nPath('.claude/hooks/pre-tool.sh').parent.rmdir()\nPY",
    "python3 - <<'PY'\nfrom pathlib import Path\nPath('.mcp.json').replace('backup.json')\nPY",
    // A use no rule recognises asks: the path as an operand of an operator
    // the check does not model, or a branch of a conditional, reaches only
    // the default at the end, and the write through the name it lands in is
    // then caught by nothing else.
    "python3 - <<'PY'\nimport os\ntarget = os.environ.get('CFG') or '.mcp.json'\nopen(target, 'w').write('{}')\nPY",
    "node - <<'JS'\nconst target = process.argv[2] || '.claude/settings.json';\nrequire('fs').writeFileSync(target, '{}');\nJS",
    "node - <<'JS'\nconst target = process.env.PROD ? '.mcp.json' : 'dev.json';\nrequire('fs').writeFileSync(target, '{}');\nJS",
    "python3 - <<'PY'\nimport sys\ntarget = (len(sys.argv) > 1 and '.mcp.json')\nopen(target, 'w').write('{}')\nPY",
    // And a call or a method nobody listed, on anything.
    "python3 - <<'PY'\nimport mylib\nmylib.sync('.mcp.json')\nPY",
    "python3 - <<'PY'\nfrom tools import deploy\ndeploy({}, '.claude/settings.json')\nPY",
    "node - <<'JS'\nconst client = makeClient();\nclient.store.save('.mcp.json', {});\nJS",
  ];
  test('code asks about an answer file only when it can write one', () => {
    for (const codeMode of [false, true]) {
      const label = codeMode ? 'Code' : 'Notes';
      for (const c of CODE_READS) assert.strictEqual(answerFileIn(c, codeMode), false, `${label}: ${c}`);
      for (const c of CODE_WRITES) assert.strictEqual(answerFileIn(c, codeMode), true, `${label}: ${c}`);
    }
  });
  // THE READS ARE A LIST, AND THE LIST IS PINNED. Anything not on it asks, so
  // widening it widens what code may do to an answer file unasked: a change
  // here is a change to this test and to the architecture notes, on purpose.
  test('the uses of an answer file that code may make unasked are the listed ones', () => {
    assert.deepStrictEqual(JSON.parse(JSON.stringify(hook.CODE_READS_ALLOWED)), {
      calls: ['print', 'pprint', 'puts', 'pp', 'len', 'repr', 'log', 'info', 'warn', 'error', 'debug',
        'exists', 'isfile', 'isdir', 'islink', 'lexists', 'getsize', 'getmtime', 'stat', 'lstat', 'access',
        'existsSync', 'statSync', 'lstatSync', 'accessSync', 'readFileSync', 'readFile', 'createReadStream',
        'read_text', 'read_bytes', 'read', 'readlines', 'exist?', 'exists?', 'file?', 'directory?', 'require'],
      openCalls: ['open', 'openSync', 'fopen'],
      sources: ['listdir', 'scandir', 'walk', 'glob', 'iglob', 'rglob', 'iterdir', 'readdir', 'readdirSync', 'opendir', 'entries', 'children'],
      copySources: ['copy', 'copy2', 'copyfile', 'copytree', 'copyFile', 'copyFileSync', 'cp', 'cpSync', 'cp_r', 'copySync', 'copy_file', 'copy_entry'],
      comparisons: ['==', '!=', '===', '!==', '<=', '>=', 'in', 'not in', 'is', 'is not'],
      argumentMethods: ['replace', 'replaceAll', 'startswith', 'endswith', 'startsWith', 'endsWith', 'split', 'rsplit',
        'strip', 'lstrip', 'rstrip', 'includes', 'indexOf', 'lastIndexOf', 'find', 'rfind', 'count', 'removeprefix', 'removesuffix',
        'partition', 'rpartition', 'match', 'search', 'test', 'sub', 'gsub', 'contains', 'has',
        'remove', 'append', 'add', 'discard', 'index', 'insert', 'extend', 'push', 'unshift', 'delete', 'get'],
      receiverReads: ['exists', 'is_file', 'is_dir', 'is_symlink', 'is_absolute', 'stat', 'lstat', 'read_text', 'read_bytes',
        'samefile', 'startswith', 'endswith', 'startsWith', 'endsWith', 'includes', 'indexOf', 'find', 'count', 'exist?', 'file?', 'directory?'],
      receiverPassThrough: ['resolve', 'absolute', 'expanduser', 'as_posix', 'with_suffix', 'with_name', 'relative_to',
        'parent', 'name', 'stem', 'suffix', 'iterdir', 'glob', 'rglob', 'lower', 'upper', 'strip', 'lstrip', 'rstrip', 'split',
        'format', 'encode', 'replace', 'toLowerCase', 'toUpperCase', 'trim', 'slice', 'substring', 'toString', 'normalize', 'to_s'],
    });
    const notes = fs.readFileSync(path.join(__dirname, '..', '..', 'ARCHITECTURE.md'), 'utf8');
    for (const [group, list] of Object.entries(hook.CODE_READS_ALLOWED)) {
      for (const name of list) assert.ok(notes.includes(`\`${name}\``), `ARCHITECTURE.md lists ${group}: ${name}`);
    }
  });

  test('through the real hook, code that only reads an answer file runs in Code mode and draws no refusal in Notes mode', async () => {
    for (const c of CODE_READS) {
      assert.strictEqual(await hookDecision(c, true), 'allow', `Code: ${c}`);
      assert.notStrictEqual(await hookDecision(c, false), 'deny', `Notes: ${c}`);
    }
    assert.strictEqual(await hookDecision("python3 -c \"open('.mcp.json','w')\"", true), 'deny', 'code that writes one is still refused with nobody to ask');
    assert.strictEqual(await hookDecision("python3 -c \"open('.mcp.json','w')\"", false), 'deny', 'in Notes mode too');
  });

  test('through the real hook in Code mode, the reads run unattended and a write is refused', async () => {
    for (const c of ['git diff .mcp.json', 'jq . .mcp.json', 'cp .mcp.json backup.json', 'diff .mcp.json x.json']) {
      assert.strictEqual(await hookDecision(c, true), 'allow', c);
    }
    assert.strictEqual(await hookDecision('cp x.json .mcp.json', true), 'deny', 'a copy onto it is still refused with nobody to ask');
  });
});
