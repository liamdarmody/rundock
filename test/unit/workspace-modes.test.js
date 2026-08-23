'use strict';
// Characterization: workspace mode detection, empty-workspace detection,
// scaffolding gates, state/conversation persistence, file tree.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { _internal: srv } = require('../../server.js');
const { makeWorkspace, agentFile, standardTeam, cleanup } = require('../helpers/workspace.js');

after(cleanup);

function useWorkspace(opts) {
  const dir = makeWorkspace(opts);
  srv.setWorkspace(dir);
  return dir;
}

describe('detectWorkspaceMode', () => {
  test('markdown-only workspace is knowledge', () => {
    const dir = makeWorkspace({ files: { 'notes.md': '# hi', 'Projects/idea.md': 'x' } });
    assert.strictEqual(srv.detectWorkspaceMode(dir), 'knowledge');
  });

  test('top-level code extension flips to code', () => {
    const dir = makeWorkspace({ files: { 'script.py': 'print(1)' } });
    assert.strictEqual(srv.detectWorkspaceMode(dir), 'code');
  });

  test('top-level config file flips to code', () => {
    const dir = makeWorkspace({ files: { 'package.json': '{}' } });
    assert.strictEqual(srv.detectWorkspaceMode(dir), 'code');
  });

  test('code file one level deep flips to code', () => {
    const dir = makeWorkspace({ files: { 'src/app.ts': 'x' } });
    assert.strictEqual(srv.detectWorkspaceMode(dir), 'code');
  });

  test('code files under dot-dirs and node_modules are ignored', () => {
    const dir = makeWorkspace({ files: {
      '.claude/hook.js': 'x',
      'node_modules/pkg/index.js': 'x',
      'notes.md': 'x',
    } });
    assert.strictEqual(srv.detectWorkspaceMode(dir), 'knowledge');
  });

  test('pinned as-is: code file TWO levels deep is not seen (scan is one level deep)', () => {
    const dir = makeWorkspace({ files: { 'a/b/deep.py': 'x' } });
    assert.strictEqual(srv.detectWorkspaceMode(dir), 'knowledge');
  });

  test('unreadable directory returns knowledge', () => {
    assert.strictEqual(srv.detectWorkspaceMode('/nonexistent/nowhere'), 'knowledge');
  });
});

describe('isEmptyWorkspace', () => {
  test('truly empty dir is empty', () => {
    const dir = makeWorkspace({});
    assert.strictEqual(srv.isEmptyWorkspace(dir, []), true);
  });

  test('CLAUDE.md makes it non-empty', () => {
    const dir = makeWorkspace({ claudeMd: '# x' });
    assert.strictEqual(srv.isEmptyWorkspace(dir, []), false);
  });

  test('user agents make it non-empty; platform/rundock-guide agents do not', () => {
    const dir = makeWorkspace({});
    assert.strictEqual(srv.isEmptyWorkspace(dir, [{ id: 'rundock-guide', type: 'platform' }]), true);
    assert.strictEqual(srv.isEmptyWorkspace(dir, [{ id: 'penn', type: 'specialist' }]), false);
  });

  test('user skills make it non-empty; rundock-* skills do not', () => {
    const withRundockSkill = makeWorkspace({ skills: { 'rundock-agents': 'x' } });
    assert.strictEqual(srv.isEmptyWorkspace(withRundockSkill, []), true);
    const withUserSkill = makeWorkspace({ skills: { 'my-skill': 'x' } });
    assert.strictEqual(srv.isEmptyWorkspace(withUserSkill, []), false);
  });

  // The Lucas Simonian incident (2026-04-30): an existing, well-organised
  // Obsidian vault with no CLAUDE.md passed as "empty" and had the default
  // folder scaffold written into it. A workspace with real user structure
  // is not empty, whatever its CLAUDE.md status.
  test('a structured vault without CLAUDE.md is not empty', () => {
    const dir = makeWorkspace({ files: {
      'Notes/2026-04-30.md': '# meeting',
      'Projects/launch.md': 'plan',
      'Archive/old.md': 'x',
    } });
    assert.strictEqual(srv.isEmptyWorkspace(dir, []), false);
  });

  test('a single user folder is enough to be non-empty', () => {
    const dir = makeWorkspace({ files: { 'Notes/hello.md': 'x' } });
    assert.strictEqual(srv.isEmptyWorkspace(dir, []), false);
  });

  test('one or two stray root files still count as empty', () => {
    const one = makeWorkspace({ files: { 'readme.md': 'x' } });
    assert.strictEqual(srv.isEmptyWorkspace(one, []), true);
    const two = makeWorkspace({ files: { 'readme.md': 'x', 'notes.md': 'y' } });
    assert.strictEqual(srv.isEmptyWorkspace(two, []), true);
  });

  test('three or more root files count as non-empty', () => {
    const dir = makeWorkspace({ files: { 'a.md': 'x', 'b.md': 'y', 'c.md': 'z' } });
    assert.strictEqual(srv.isEmptyWorkspace(dir, []), false);
  });

  test('hidden and tool-managed entries never count toward structure', () => {
    const dir = makeWorkspace({ files: {
      '.obsidian/app.json': '{}',
      '.claude/settings.local.json': '{}',
      '.rundock/state.json': '{}',
      '.DS_Store': '',
      '.git/config': '',
    } });
    assert.strictEqual(srv.isEmptyWorkspace(dir, []), true);
  });
});

describe('scaffoldDefaults', () => {
  test('knowledge workspace: default folders + CLAUDE.md + setup pending', () => {
    const dir = useWorkspace({});
    const result = srv.scaffoldDefaults(dir);
    assert.strictEqual(result.success, true);
    for (const folder of ['0 Inbox', '1 Notes', '2 Projects', '3 Resources', '4 Archive']) {
      assert.ok(fs.existsSync(path.join(dir, folder)), folder);
    }
    const claudeMd = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8');
    assert.ok(claudeMd.includes('## Workspace structure'));
    assert.strictEqual(srv.readState().setupComplete, false);
  });

  test('code workspace: minimal CLAUDE.md, no folders', () => {
    const dir = useWorkspace({ files: { 'main.go': 'package main' } });
    const result = srv.scaffoldDefaults(dir);
    assert.strictEqual(result.success, true);
    assert.ok(!fs.existsSync(path.join(dir, '0 Inbox')));
    assert.strictEqual(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8'), `# ${path.basename(dir)}\n`);
  });
});

describe('scaffoldWorkspace', () => {
  test('syncs Rundock-managed files, creates .rundock, gitignores it, writes permission hooks', () => {
    const dir = useWorkspace({ claudeMd: '# x' });
    srv.scaffoldWorkspace(dir);
    assert.ok(fs.existsSync(path.join(dir, '.claude', 'agents', 'rundock-guide.md')));
    assert.ok(fs.existsSync(path.join(dir, '.claude', 'skills', 'rundock-workspace', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(dir, '.claude', 'skills', 'rundock-agents', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(dir, '.claude', 'skills', 'rundock-skills', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(dir, '.rundock')));
    assert.ok(fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8').includes('.rundock/'));

    const settings = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf-8'));
    const matchers = settings.hooks.PreToolUse.map(e => e.matcher);
    assert.deepStrictEqual(matchers.sort(), ['Bash', 'PowerShell', 'Read|Write|Edit|MultiEdit|NotebookEdit|Glob|Grep', 'mcp__.*']);
    // launcher script exists and points at the permission hook
    const launcher = path.join(dir, '.rundock', 'permission-hook.sh');
    assert.ok(fs.existsSync(launcher));
    assert.ok(fs.readFileSync(launcher, 'utf-8').includes('permission-hook.js'));
  });

  test('the runtime sandbox is written into the settings the runtime is given', () => {
    // The wiring, not the decision function. Without this the block could be
    // computed perfectly and never reach the file the runtime is started
    // with (lib/runtime/claude.js passes --settings at this exact path), and
    // every test of the decision would still be green.
    const dir = useWorkspace({ claudeMd: '# x' });
    srv.scaffoldWorkspace(dir);
    const settings = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf-8'));
    if (process.platform === 'darwin') {
      assert.ok(settings.sandbox, 'the sandbox block is present');
      assert.strictEqual(settings.sandbox.enabled, true);
      assert.ok(settings.sandbox.filesystem.allowWrite.includes(dir),
        'the workspace it was scaffolded for is the writable root, not some other one');
    } else {
      assert.strictEqual(settings.sandbox, undefined,
        'no sandbox block on a platform with no sandbox');
    }
  });

  test('an existing workspace gains the sandbox on the next open, with its hooks already current', () => {
    // The upgrade path, and the only case where the sandbox alone decides
    // whether the file is written at all. Every workspace that exists today
    // has current hooks and no sandbox block, so if adding one does not by
    // itself mark the settings dirty, nothing changes for anybody who is
    // already using this product. Found by mutation: removing that term
    // turned no test red, because a FRESH scaffold writes the file for the
    // hooks regardless and hid the case that matters.
    const dir = useWorkspace({ claudeMd: '# x' });
    srv.scaffoldWorkspace(dir);
    const settingsPath = path.join(dir, '.claude', 'settings.local.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    delete settings.sandbox;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    srv.scaffoldWorkspace(dir);

    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    if (process.platform === 'darwin') {
      assert.ok(after.sandbox && after.sandbox.enabled === true,
        'the sandbox arrives even though the hooks needed no change');
    } else {
      assert.strictEqual(after.sandbox, undefined);
    }
  });

  test('a sandbox block already in the file is left exactly as the user wrote it', () => {
    // Whoever edited it knows something this scaffold does not: which extra
    // roots their work needs. Overwriting on every workspace open would undo
    // that silently, on a file they were invited to edit.
    const dir = useWorkspace({ claudeMd: '# x' });
    const settingsPath = path.join(dir, '.claude', 'settings.local.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const mine = { enabled: true, filesystem: { allowWrite: ['/somewhere/of/my/own'] } };
    fs.writeFileSync(settingsPath, JSON.stringify({ sandbox: mine }));
    srv.scaffoldWorkspace(dir);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    assert.deepStrictEqual(settings.sandbox, mine, 'untouched');
  });

  test('idempotent: second run makes no changes and adds no duplicate hook entries', () => {
    const dir = useWorkspace({ claudeMd: '# x' });
    srv.scaffoldWorkspace(dir);
    const before = fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf-8');
    srv.scaffoldWorkspace(dir);
    const after = fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf-8');
    assert.strictEqual(after, before);
    const gitignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8');
    assert.strictEqual((gitignore.match(/\.rundock\//g) || []).length, 1);
  });

  test('stale permission-hook entries and legacy Write/Edit matchers are removed', () => {
    const dir = useWorkspace({ claudeMd: '# x' });
    const settingsPath = path.join(dir, '.claude', 'settings.local.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: { PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: '"/old/electron" "/old/asar/scripts/permission-hook.js"', timeout: 300 }] },
        { matcher: 'Write', hooks: [{ type: 'command', command: 'anything' }] },
        { matcher: 'Edit', hooks: [{ type: 'command', command: 'anything' }] },
      ] },
    }));
    srv.scaffoldWorkspace(dir);
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const matchers = settings.hooks.PreToolUse.map(e => e.matcher);
    assert.deepStrictEqual(matchers.sort(), ['Bash', 'PowerShell', 'Read|Write|Edit|MultiEdit|NotebookEdit|Glob|Grep', 'mcp__.*']);
    for (const e of settings.hooks.PreToolUse) {
      assert.ok(!e.hooks[0].command.includes('/old/'), 'stale path rewritten');
    }
  });

  test('Windows hook entries pin shell: powershell so Git Bash never runs them', () => {
    // Live findings (Parallels VM, Claude Code 2.1.208, Git installed):
    // Claude Code runs hooks under Git Bash on Windows when Git is present
    // (PowerShell is only the fallback). `& "launcher"` is a bash syntax
    // error (fail-closed) and `cmd /c "launcher"` gets its /c switch
    // mangled by MSYS path conversion (cmd goes interactive; fail-open,
    // verified live). The documented fix is the hooks `shell` field: pin
    // the entry to PowerShell and keep the call-operator command form.
    const dir = useWorkspace({ claudeMd: '# x' });
    srv.scaffoldWorkspace(dir, { platform: 'win32' });
    assert.strictEqual(
      JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf-8')).sandbox,
      undefined,
      'scaffolding FOR Windows writes no sandbox block, whatever host it runs on: '
      + 'one seam has to govern both halves, or a Windows settings file gets macOS hook wiring\'s opposite');
    const settings = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf-8'));
    const launcher = path.join(dir, '.rundock', 'permission-hook.cmd');
    assert.ok(fs.existsSync(launcher), 'cmd launcher written');
    const launcherBody = fs.readFileSync(launcher, 'utf-8');
    assert.ok(launcherBody.includes('ELECTRON_RUN_AS_NODE=1'));
    assert.ok(launcherBody.includes('permission-hook.js'));
    for (const e of settings.hooks.PreToolUse) {
      assert.strictEqual(e.hooks[0].command, `& "${launcher}"`);
      assert.strictEqual(e.hooks[0].shell, 'powershell', 'hook pinned to PowerShell');
    }
  });

  test('POSIX hook entries carry no shell field', () => {
    const dir = useWorkspace({ claudeMd: '# x' });
    srv.scaffoldWorkspace(dir);
    const settings = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf-8'));
    for (const e of settings.hooks.PreToolUse) {
      assert.strictEqual(e.hooks[0].shell, undefined);
    }
  });

  test('stale Windows hook entries migrate: both the unpinned & form and the cmd /c form', () => {
    const dir = useWorkspace({ claudeMd: '# x' });
    const settingsPath = path.join(dir, '.claude', 'settings.local.json');
    const launcher = path.join(dir, '.rundock', 'permission-hook.cmd');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: { PreToolUse: [
        // ad6220c era: right command, no shell pin (breaks under Git Bash)
        { matcher: 'Bash', hooks: [{ type: 'command', command: `& "${launcher}"`, timeout: 300 }] },
        // 5f10b26 era: cmd /c form (MSYS-mangled under Git Bash)
        { matcher: 'PowerShell', hooks: [{ type: 'command', command: `cmd /c "${launcher}"`, timeout: 300 }] },
      ] },
    }));
    srv.scaffoldWorkspace(dir, { platform: 'win32' });
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const matchers = settings.hooks.PreToolUse.map(e => e.matcher);
    assert.deepStrictEqual(matchers.sort(), ['Bash', 'PowerShell', 'Read|Write|Edit|MultiEdit|NotebookEdit|Glob|Grep', 'mcp__.*']);
    for (const e of settings.hooks.PreToolUse) {
      assert.strictEqual(e.hooks[0].command, `& "${launcher}"`);
      assert.strictEqual(e.hooks[0].shell, 'powershell', `${e.matcher} entry migrated to the pinned form`);
    }
  });

  test('missing workspace dir: bails without creating it', () => {
    const ghost = path.join(require('node:os').tmpdir(), 'rundock-ghost-' + Date.now());
    srv.scaffoldWorkspace(ghost);
    assert.ok(!fs.existsSync(ghost));
  });

  test('user files are never touched', () => {
    const dir = useWorkspace({ agents: { 'my-agent': agentFile({ name: 'my-agent', type: 'specialist', order: 1 }) } });
    const before = fs.readFileSync(path.join(dir, '.claude', 'agents', 'my-agent.md'), 'utf-8');
    srv.scaffoldWorkspace(dir);
    assert.strictEqual(fs.readFileSync(path.join(dir, '.claude', 'agents', 'my-agent.md'), 'utf-8'), before);
  });
});

describe('muteHooks', () => {
  test('wraps sound hooks with $RUNDOCK guard, idempotently, leaving others alone', () => {
    const dir = useWorkspace({});
    const settingsPath = path.join(dir, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: { Stop: [
        { hooks: [{ type: 'command', command: 'afplay /System/Library/Sounds/Glass.aiff' }] },
        { hooks: [{ type: 'command', command: 'node inject-context.js' }] },
      ] },
    }));
    srv.muteHooks(dir);
    let settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    assert.strictEqual(settings.hooks.Stop[0].hooks[0].command, '[ -z "$RUNDOCK" ] && afplay /System/Library/Sounds/Glass.aiff || true');
    assert.strictEqual(settings.hooks.Stop[1].hooks[0].command, 'node inject-context.js');
    const once = fs.readFileSync(settingsPath, 'utf-8');
    srv.muteHooks(dir);
    assert.strictEqual(fs.readFileSync(settingsPath, 'utf-8'), once, 'idempotent');
  });
});

describe('state + conversation persistence', () => {
  test('readState returns {} when missing; writeState/readState roundtrip', () => {
    useWorkspace({});
    assert.deepStrictEqual(srv.readState(), {});
    srv.writeState({ workspaceMode: 'code', setupComplete: true });
    assert.deepStrictEqual(srv.readState(), { workspaceMode: 'code', setupComplete: true });
  });

  test('readConversations returns [] when missing; roundtrip preserves entries', () => {
    useWorkspace({});
    assert.deepStrictEqual(srv.readConversations(), []);
    srv.writeConversations([{ id: 'c1', status: 'active' }]);
    assert.deepStrictEqual(srv.readConversations(), [{ id: 'c1', status: 'active' }]);
  });

  test('one-time migration: status done -> archived, with pre-migration backup', () => {
    const dir = useWorkspace({});
    srv.writeConversations([{ id: 'c1', status: 'done' }, { id: 'c2', status: 'active' }]);
    const convos = srv.readConversations();
    assert.strictEqual(convos.find(c => c.id === 'c1').status, 'archived');
    const backup = path.join(dir, '.rundock', 'conversations.json.pre-archive-backup');
    assert.ok(fs.existsSync(backup));
    assert.strictEqual(JSON.parse(fs.readFileSync(backup, 'utf-8'))[0].status, 'done');
    // persisted, so a second read needs no migration
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, '.rundock', 'conversations.json'), 'utf-8'));
    assert.strictEqual(onDisk[0].status, 'archived');
  });

  test('getDisallowedTools: knowledge blocks executable writes, code mode is unrestricted', () => {
    useWorkspace({});
    assert.strictEqual(srv.getDisallowedTools(), srv.DISALLOWED_TOOLS_KNOWLEDGE);
    srv.writeState({ workspaceMode: 'code' });
    assert.strictEqual(srv.getDisallowedTools(), '');
    srv.writeState({ workspaceMode: 'knowledge' });
    assert.strictEqual(srv.getDisallowedTools(), srv.DISALLOWED_TOOLS_KNOWLEDGE);
  });

  test('getSpawnEnv: RUNDOCK flags, convo id, code-mode flag', () => {
    useWorkspace({});
    srv.writeState({ workspaceMode: 'code' });
    const env = srv.getSpawnEnv('convo-9');
    assert.strictEqual(env.RUNDOCK, '1');
    assert.strictEqual(env.RUNDOCK_CONVO_ID, 'convo-9');
    assert.strictEqual(env.RUNDOCK_CODE_MODE, '1');
    assert.strictEqual(env.TERM, 'dumb');
    srv.writeState({});
    const env2 = srv.getSpawnEnv(null);
    assert.strictEqual(env2.RUNDOCK_CODE_MODE, undefined);
    assert.strictEqual(env2.RUNDOCK_CONVO_ID, undefined);
  });

  test('getBareArgs: add-dir always; settings/mcp-config only when files exist', () => {
    const dir = useWorkspace({});
    assert.deepStrictEqual(srv.getBareArgs(), ['--add-dir', dir]);
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), '{}');
    fs.writeFileSync(path.join(dir, '.mcp.json'), '{"mcpServers":{"notion":{}}}');
    const args = srv.getBareArgs();
    assert.ok(args.includes('--settings'));
    assert.ok(args.includes('--mcp-config'));
    assert.deepStrictEqual(srv.readMcpServerNames(dir), ['notion']);
  });

  test('readMcpServerNames: [] on missing/invalid input', () => {
    assert.deepStrictEqual(srv.readMcpServerNames(null), []);
    assert.deepStrictEqual(srv.readMcpServerNames('/nonexistent'), []);
    const dir = makeWorkspace({ files: { '.mcp.json': 'not json' } });
    assert.deepStrictEqual(srv.readMcpServerNames(dir), []);
  });
});

describe('getFileTree', () => {
  test('includes viewable types, folders first, hides dotfiles, node_modules and code files', () => {
    const dir = makeWorkspace({ files: {
      'b-note.md': 'x',
      'a-data.json': '{}',
      'script.js': 'x',
      'notes/inner.txt': 'x',
      '.hidden/secret.md': 'x',
      'node_modules/pkg/readme.md': 'x',
      // FV2: files the registry can open are first-class in the tree
      'artifact.html': '<p>x</p>',
      'diagram.svg': '<svg></svg>',
      'chart.png': 'x',
      'photo.JPEG': 'x',
      'report.pdf': 'x',
    } });
    const tree = srv.getFileTree(dir);
    const names = tree.map(e => e.name);
    assert.deepStrictEqual(names, ['notes', 'a-data.json', 'artifact.html', 'b-note.md', 'chart.png', 'diagram.svg', 'photo.JPEG', 'report.pdf']);
    assert.strictEqual(tree[0].type, 'folder');
    assert.deepStrictEqual(tree[0].children.map(c => c.path), ['notes/inner.txt']);
    assert.ok(!names.includes('script.js'), 'code files stay hidden');
  });

  test('unreadable dir returns []', () => {
    assert.deepStrictEqual(srv.getFileTree('/nonexistent/nowhere'), []);
  });

  test('every level is sorted the way the tree reconciler assumes', () => {
    // The client diffs one tree snapshot against another and emits no move
    // operation, because it takes for granted that both snapshots order every
    // level the same way: folders first, then by name. That assumption lives
    // in public/file-tree-diff.js and the thing it depends on lives here, with
    // a module boundary and a network hop in between and nothing connecting
    // them. If this sort ever changed, the client would not reorder anything
    // and the tree would quietly disagree with the disk.
    //
    // So the comparator is restated here and checked against the real output.
    // It is a duplicate, deliberately: the point is to fail when the two stop
    // matching, which is exactly what a shared helper would prevent it from
    // noticing.
    const dir = makeWorkspace({ files: {
      'zebra.md': 'x', 'Apple.md': 'x', 'mango.md': 'x',
      'zoo/a.md': 'x', 'alpha/b.md': 'x', 'Beta/c.md': 'x',
      'alpha/nested/deep.md': 'x', 'alpha/aaa.md': 'x',
    } });

    const ordered = (nodes) => {
      const expected = nodes.slice().sort((a, b) => (
        a.type === 'folder' && b.type !== 'folder' ? -1
          : a.type !== 'folder' && b.type === 'folder' ? 1
            : a.name.localeCompare(b.name)
      ));
      assert.deepStrictEqual(nodes.map(n => n.name), expected.map(n => n.name));
      for (const n of nodes) if (n.type === 'folder') ordered(n.children);
    };

    const tree = srv.getFileTree(dir);
    ordered(tree);
    // Guard the guard: a tree with no folders, or only one level, would pass
    // the check above while proving nothing about either rule.
    assert.ok(tree.some(n => n.type === 'folder') && tree.some(n => n.type === 'file'));
    assert.ok(tree.find(n => n.name === 'alpha').children.some(n => n.type === 'folder'));
  });
});
