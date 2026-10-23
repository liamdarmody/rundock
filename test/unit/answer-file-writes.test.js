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
];
const WRITES = [
  'echo x > .mcp.json', 'echo x >> .mcp.json', 'echo x 1> .mcp.json', 'echo x >.mcp.json', 'echo x &> .mcp.json', 'echo x | tee .mcp.json',
  'jq . x.json > .mcp.json', 'cp x.json .mcp.json', 'install x.json .mcp.json', 'dd if=x.json of=.mcp.json',
  "sed -i '' s/a/b/ .mcp.json", 'sed -i.bak s/a/b/ .claude/settings.json', 'sed -Ei s/a/b/ .mcp.json', 'sed --in-place s/a/b/ .mcp.json',
  'perl -pi -e s/a/b/ .mcp.json', 'touch .rundock/permission-hook.sh', 'truncate -s 0 .rundock/mcp-secrets.json',
  'chmod 777 .rundock/permission-hook.sh', 'rm .mcp.json', 'mv .mcp.json old.json', 'mv x.json .mcp.json', 'ln -s .mcp.json alias.json',
  'cp -l .mcp.json x.json', 'cp --link .mcp.json x.json', 'cp -t . .mcp.json', 'rsync --remove-source-files .mcp.json x.json',
  'git checkout -- .mcp.json', 'git restore .claude/settings.json', 'git add .mcp.json', 'git commit -m x .mcp.json',
  'git diff --output=.mcp.json', 'python3 tool.py .mcp.json', 'echo x > .claude/hooks/pre-tool.sh', 'cp x.json .claude/hooks/new.sh',
  "cat > .mcp.json <<'EOF'\nx\nEOF",
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
    'rm -rf projects/other-ws/.rundock', 'mv projects/other-ws/.claude x',
  ];
  const FOLDER_ORDINARY = [
    'rm -rf .rundock/scratch', 'rm -rf .rundock/scratch/*', 'ls .claude', 'cp -r .claude backup', 'cp x.json .', 'mv notes.txt .claude/agents/',
    'rm -rf node_modules', 'rm *.json', 'git add .', 'rm -rf .claude/agents/old.md', 'cp -r skills .claude/skills', 'rm -rf *',
    // Into a folder that holds answer files, under another name: only that name is written.
    'cp x.json .claude', 'mv notes.txt .rundock/', 'cp -t .claude x.json',
  ];
  test('a command that removes, moves or writes into a folder holding answer files asks', () => {
    for (const d of ['backup/.claude', 'projects/other-ws/.rundock', 'projects/other-ws/.claude', '.claude/agents', '.rundock/scratch', 'skills']) fs.mkdirSync(path.join(ws, d), { recursive: true });
    fs.writeFileSync(path.join(ws, 'projects', 'other-ws', '.rundock', 'state.json'), '{}');
    for (const codeMode of [false, true]) {
      for (const c of FOLDER_WRITES) assert.strictEqual(answerFileIn(c, codeMode), true, `${codeMode ? 'Code' : 'Notes'}: ${c}`);
      for (const c of FOLDER_ORDINARY) assert.strictEqual(answerFileIn(c, codeMode), false, `${codeMode ? 'Code' : 'Notes'}: ${c}`);
    }
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
