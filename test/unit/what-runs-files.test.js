'use strict';
// THE FILES THAT DECIDE WHAT RUNS ALWAYS ASK.
//
// The runtime starts the permission hook through a launcher Rundock writes into
// the workspace (`.rundock/permission-hook.sh`, `.cmd` on Windows) before every
// tool call. A write to it was ordinary work inside the workspace: allowed at
// once by a file tool, and with no card for a shell redirect, in both modes.
// Rewriting it switches every permission check off.
//
// Three more files decide what the runtime starts, outside the shell sandbox:
// `.mcp.json`, whose stdio servers start at the next spawn; the project's
// `.claude/settings.json`, whose hooks and `env` the runtime acts on; and the
// scripts under `.claude/hooks/` that those hooks run.
//
// Each is now an answer file: it asks every time, with Allow and Deny only, in
// Notes and Code mode alike; no saved "Always allow" or folder grant answers
// it; and when Rundock cannot be asked it is refused. Driven through the real
// hook, as the runtime spawns it, and the request it sends is then drawn by the
// real card.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const fx = require('../helpers/code-mode-fixture.js');
const hook = require('../../scripts/permission-hook.js');

const root = fx.outsideTempRoot();
const SKIP = root.skip || false;
let world, capture, deadPort, other;
before(async () => {
  if (SKIP) return;
  world = fx.buildWorld(root.dir);
  // A launcher of the shape Rundock writes, in this made-up workspace only.
  fx.write(path.join(world.ws, '.rundock', 'permission-hook.sh'), '#!/bin/sh\nexit 0\n');
  fx.write(path.join(world.ws, 'notes.txt'), 'notes\n');
  fx.write(path.join(world.ws, '.mcp.json'), '{ "mcpServers": {} }\n');
  fx.write(path.join(world.ws, '.claude', 'settings.json'), '{}\n');
  fx.write(path.join(world.ws, '.claude', 'hooks', 'pre-tool.sh'), '#!/bin/sh\nexit 0\n');
  // A second Rundock workspace inside the working folder.
  other = path.join(world.projects, 'other-ws');
  fx.write(path.join(other, '.rundock', 'state.json'), '{}\n');
  capture = await fx.startCaptureServer();
  deadPort = await fx.closedPort();
});
after(async () => {
  if (capture) await capture.close();
  if (root.dir) fs.rmSync(root.dir, { recursive: true, force: true });
});

// Each file, and the words its card must use: its heading, then why it asks.
// The launchers are refused before any card (LAUNCHERS below), so they draw
// none: Rundock writes them and puts any other change back.
const LAUNCHER = { summary: /permission-summary">Wants to change Rundock's permission checks</, says: /starts Rundock's permission checks themselves/ };
const RUNS = { summary: /permission-summary">Wants to change what runs outside the sandbox</, says: /decides what Rundock or Claude Code runs, outside the sandbox/ };
const LAUNCHERS = ['.rundock/permission-hook.sh', '.rundock/permission-hook.cmd'];
const TARGETS = [
  { rel: '.mcp.json', ...RUNS },
  { rel: '.claude/settings.json', ...RUNS },
  { rel: '.claude/hooks/pre-tool.sh', ...RUNS },
  { rel: '.claude/hooks/lib/notify.py', ...RUNS },
];
// Every shell form that writes, edits or deletes a file. `F` is the target as
// an agent would write it, relative to the workspace.
const SHELL_FORMS = [
  'echo x > F', 'echo x >> F', 'printf x | tee F', 'echo x | tee -a F', 'cp notes.txt F', 'mv notes.txt F',
  "sed -i '' s/a/b/ F", 'sed -i s/a/b/ F', 'rm F', 'rm -f F', 'truncate -s 0 F', 'ln -sf notes.txt F', 'chmod 777 F',
  "cat > F <<'EOF'\nx\nEOF",
];
const MODES = [{ codeMode: false, label: 'Notes' }, { codeMode: true, label: 'Code' }];

const isAnswerFileRequest = (p) => !!p && (p.answer_file === true
  || (p.boundary === true && Array.isArray(p.crossings) && p.crossings.length > 0 && p.crossings.every(c => c && c.answerFile)));

function assertAlwaysAsks(r, what) {
  assert.ok(isAnswerFileRequest(r.payload), `${what}: asks, as an answer file`);
  assert.strictEqual(r.payload.grant_dir || null, null, `${what}: carries no folder a standing grant could be built from`);
  assert.strictEqual(r.live.decision, 'allow', `${what}: an approval on the card is honoured`);
  assert.strictEqual(r.dead.decision, 'deny', `${what}: refused when Rundock cannot be asked`);
  assert.match(r.dead.reason, /never changed without asking/, `${what}: and the agent is told why`);
}
// A launcher write: refused by the hook itself, with no request to the server.
function assertRefused(r, what) {
  assert.strictEqual(r.payload, null, `${what}: no card is raised`);
  for (const [run, side] of [[r.live, 'with Rundock there'], [r.dead, 'with nobody to ask']]) {
    assert.strictEqual(run.decision, 'deny', `${what}: refused ${side}`);
    assert.match(run.reason, /starts its permission checks/, `${what}: and says why, ${side}`);
  }
}

describe('the files that decide what runs always ask, through the real hook', { skip: SKIP }, () => {
  for (const { codeMode, label } of MODES) {
    test(`a file-tool write, edit or multi-edit asks (${label} mode)`, async () => {
      for (const { rel } of TARGETS) {
        const file_path = path.join(world.ws, ...rel.split('/'));
        for (const [tool, input] of [
          ['Write', { file_path, content: 'x' }],
          ['Edit', { file_path, old_string: 'exit 0', new_string: 'exit 1' }],
          ['MultiEdit', { file_path, edits: [{ old_string: 'exit 0', new_string: 'exit 1' }] }],
        ]) {
          const r = await fx.judge(world, capture, deadPort, { tool, input, cwd: world.ws, codeMode });
          assertAlwaysAsks(r, `${label}: ${tool} ${rel}`);
        }
      }
    });

    test(`every shell form that writes, edits or deletes it asks (${label} mode)`, async () => {
      for (const { rel } of TARGETS) {
        for (const form of SHELL_FORMS) {
          const command = form.replace(/\bF\b/g, rel);
          const r = await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command }, cwd: world.ws, codeMode });
          assertAlwaysAsks(r, `${label}: ${command}`);
        }
        const abs = `echo x > ${path.join(world.ws, rel)}`;
        assertAlwaysAsks(await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command: abs }, cwd: world.ws, codeMode }), `${label}: ${abs}`);
        const [dir, name] = [path.posix.dirname(rel), path.posix.basename(rel)];
        const moved = `cd ${dir} && echo x > ${name}`;
        assertAlwaysAsks(await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command: moved }, cwd: world.ws, codeMode }), `${label}: ${moved}`);
        const ps = `Set-Content -Path ${rel} -Value x`;
        assertAlwaysAsks(await fx.judge(world, capture, deadPort, { tool: 'PowerShell', input: { command: ps }, cwd: world.ws, codeMode }), `${label}: ${ps}`);
      }
    });

    test(`a launcher is refused, by every file tool and shell form, here and in another workspace (${label} mode)`, async () => {
      for (const rel of LAUNCHERS) {
        for (const ws of [world.ws, other]) {
          const file_path = path.join(ws, ...rel.split('/'));
          for (const [tool, input] of [
            ['Write', { file_path, content: 'x' }],
            ['Edit', { file_path, old_string: 'exit 0', new_string: 'exit 1' }],
            ['MultiEdit', { file_path, edits: [{ old_string: 'exit 0', new_string: 'exit 1' }] }],
          ]) {
            assertRefused(await fx.judge(world, capture, deadPort, { tool, input, cwd: world.ws, codeMode }), `${label}: ${tool} ${file_path}`);
          }
        }
        for (const form of SHELL_FORMS) {
          const command = form.replace(/\bF\b/g, rel);
          assertRefused(await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command }, cwd: world.ws, codeMode }), `${label}: ${command}`);
        }
        const elsewhere = `echo x > ${path.join(other, rel)}`;
        assertRefused(await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command: elsewhere }, cwd: world.ws, codeMode }), `${label}: ${elsewhere}`);
      }
    });

    test(`another Rundock workspace's copy asks too (${label} mode)`, async () => {
      for (const { rel } of TARGETS) {
        const target = path.join(other, ...rel.split('/'));
        assertAlwaysAsks(await fx.judge(world, capture, deadPort, { tool: 'Write', input: { file_path: target, content: 'x' }, cwd: world.ws, codeMode }), `${label}: Write ${target}`);
        assertAlwaysAsks(await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command: `echo x > ${target}` }, cwd: world.ws, codeMode }), `${label}: echo x > ${target}`);
      }
    });

    test(`reading it is still free (${label} mode)`, async () => {
      for (const { rel } of TARGETS) {
        const r = await fx.judge(world, capture, deadPort, { tool: 'Read', input: { file_path: path.join(world.ws, rel) }, cwd: world.ws, codeMode });
        assert.strictEqual(r.cls, 'runs', `${label}: Read ${rel}`);
        const c = await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command: `cat ${rel}` }, cwd: world.ws, codeMode });
        assert.ok(!isAnswerFileRequest(c.payload), `${label}: cat ${rel}`);
      }
    });
  }

  test('the hook-scripts folder itself, removed, replaced or created, asks', async () => {
    for (const { codeMode, label } of MODES) {
      for (const command of ['rm -rf .claude/hooks', 'mv tools .claude/hooks', 'mkdir -p .claude/hooks/new', 'cp -r tools .claude/hooks']) {
        assertAlwaysAsks(await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command }, cwd: world.ws, codeMode }), `${label}: ${command}`);
      }
    }
  });

  test('they ask in a workspace that has no state file yet', async () => {
    // Without `.rundock/state.json` a folder is not recognised as a Rundock
    // workspace by name, so this is the workspace's own registry speaking.
    const bare = path.join(world.root, 'bare-ws');
    fx.write(path.join(bare, '.claude', 'settings.json'), '{}\n');
    for (const { codeMode, label } of MODES) {
      const env = { ...fx.hookEnv(world, { port: deadPort, codeMode }), RUNDOCK_WORKSPACE: bare };
      for (const rel of ['.claude/settings.json', '.mcp.json', '.claude/hooks/pre-tool.sh', '.claude/hooks/lib/notify.py']) {
        for (const [tool, input] of [['Write', { file_path: path.join(bare, rel), content: '{}' }], ['Bash', { command: `echo '{}' > ${rel}` }]]) {
          const out = await fx.runHook(env, { session_id: 'bare', hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, cwd: bare });
          assert.strictEqual(out.decision, 'deny', `${label}: ${tool} ${rel} is refused with nobody to ask`);
          assert.match(out.reason, /never changed without asking/, `${label}: ${tool} ${rel}, and says why`);
        }
      }
    }
  });

  test('a .claude folder kept elsewhere through a symlink is still the workspace\'s own', async () => {
    // A person who keeps their settings in a dotfiles folder and links it in.
    const kept = path.join(world.root, 'dotfiles', 'claude');
    fx.write(path.join(kept, 'settings.json'), '{}\n');
    fx.write(path.join(kept, 'settings.local.json'), '{}\n');
    fx.write(path.join(kept, 'hooks', 'pre-tool.sh'), '#!/bin/sh\n');
    const linked = path.join(world.root, 'linked-ws');
    fx.write(path.join(linked, '.rundock', 'state.json'), '{}\n');
    fs.symlinkSync(kept, path.join(linked, '.claude'));
    for (const { codeMode, label } of MODES) {
      for (const rel of ['.claude/settings.json', '.claude/hooks/pre-tool.sh', '.claude/settings.local.json']) {
        const r = await fx.judge({ ...world, ws: linked }, capture, deadPort, { tool: 'Write', input: { file_path: path.join(linked, rel), content: 'x' }, cwd: linked, codeMode, extraDirs: [] });
        assertAlwaysAsks(r, `${label}: Write ${rel}`);
        const b = await fx.judge({ ...world, ws: linked }, capture, deadPort, { tool: 'Bash', input: { command: `echo x > ${rel}` }, cwd: linked, codeMode, extraDirs: [] });
        assertAlwaysAsks(b, `${label}: echo x > ${rel}`);
      }
    }
  });

  test('a symlink inside the workspace that points at the launcher is the launcher', async () => {
    const alias = path.join(world.ws, 'tools', 'hook.sh');
    fs.mkdirSync(path.dirname(alias), { recursive: true });
    fs.symlinkSync(path.join('..', '.rundock', 'permission-hook.sh'), alias);
    for (const { codeMode, label } of MODES) {
      assertRefused(await fx.judge(world, capture, deadPort, { tool: 'Write', input: { file_path: alias, content: 'x' }, cwd: world.ws, codeMode }), `${label}: Write through the alias`);
      assertRefused(await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command: 'echo x > tools/hook.sh' }, cwd: world.ws, codeMode }), `${label}: a redirect through the alias`);
    }
  });

  test('a workspace opened through a symlinked path still knows its launcher', async () => {
    const link = path.join(world.root, 'ws-link');
    fs.symlinkSync(world.ws, link);
    const env = (port, codeMode) => ({ ...fx.hookEnv(world, { port, codeMode }), RUNDOCK_WORKSPACE: link });
    for (const { codeMode, label } of MODES) {
      for (const input of [{ file_path: path.join(link, '.rundock', 'permission-hook.sh'), content: 'x' }, { file_path: path.join(world.ws, '.rundock', 'permission-hook.sh'), content: 'x' }]) {
        const out = await fx.runHook(env(deadPort, codeMode), { session_id: 'alias', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: input, cwd: link });
        assert.strictEqual(out.decision, 'deny', `${label}: ${input.file_path} is the launcher, however it is spelled`);
      }
    }
  });
});

// The same question asked of the classifier, where a test can choose the kind
// of filesystem rather than inherit the host's.
describe('a case variant of each file is that file where the filesystem folds case', { skip: SKIP }, () => {
  test('file tools and shell commands alike', () => {
    for (const rel of ['.RUNDOCK/Permission-Hook.SH', '.Rundock/PERMISSION-HOOK.cmd', '.MCP.json', '.Claude/Settings.JSON', '.claude/Hooks/pre-tool.sh', '.CLAUDE/HOOKS/new.sh']) {
      const a = hook.classifyFileAccess('Write', { file_path: path.join(world.ws, rel) }, world.ws, [], world.home, true, true);
      assert.strictEqual(a && a.answerFile, true, `Write ${rel}`);
      const s = hook.classifyShellAccess('Bash', { command: `echo x > ${rel}` }, world.ws, [], world.home, true, { cwd: world.ws });
      assert.ok(s && s.crossings.every(c => c.answerFile), `echo x > ${rel}`);
    }
  });
});

// What a saved answer can and cannot do. The hook marks the request; the card
// and the server decide whether anything already stored may answer it.
describe('nothing stored answers it', { skip: SKIP }, () => {
  let chat, dom, permissions;
  before(() => {
    dom = new JSDOM('<div id="messages"></div>');
    global.window = dom.window;
    global.document = dom.window.document;
    global.pendingPermissions = new Map();
    global.pendingPermissionsByConvo = new Map();
    global.alwaysAllowedTools = new Set();
    global.ws = { send() {} };
    global.userScrolledUp = false;
    global.esc = (t) => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };
    global.escAttr = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    permissions = require('../../public/permissions.js');
    global.RundockPermissions = permissions;
    global.RundockChatMarkup = require('../../public/chat-markup.js');
    global.serverPlatform = 'darwin';
    global.workspaceMode = 'knowledge';
    global.activeConversation = { id: 'convo-1' };
    // The roster app.js keeps; a Codex request names its agent from it.
    global.agents = [];
    chat = require('../../public/views/chat.js');
  });
  after(() => { if (dom) dom.window.close(); });

  // The request as lib/http-router.js hands it to the window: the hook's
  // fields, through the router's whitelist.
  function relayed(p) {
    return {
      subtype: 'can_use_tool', tool_name: p.tool_name, input: p.tool_input || {},
      ...(p.boundary ? { boundary: true, resolved_path: p.crossings[0].path, grant_dir: p.grant_dir || null, crossings: p.crossings } : {}),
      ...(p.answer_file === true && !p.boundary ? { answer_file: true, resolved_path: p.resolved_path, grant_dir: null } : {}),
      ...(p.code_mode_verdict ? { code_mode_verdict: p.code_mode_verdict } : {}),
    };
  }
  let seq = 0;
  function ask(request) {
    document.getElementById('messages').innerHTML = '';
    global.pendingPermissions.clear();
    chat.handlePermissionRequest({ request_id: `req-${++seq}`, request }, 'convo-1');
    return document.getElementById('messages').innerHTML;
  }

  test('a saved "Always allow" for the same tool never answers it, and the card offers Allow and Deny only', async () => {
    for (const { codeMode, label } of MODES) {
      for (const { rel, summary, says } of TARGETS) {
        const file_path = path.join(world.ws, rel);
        for (const [tool, input] of [['Write', { file_path, content: 'x' }], ['Edit', { file_path, old_string: 'a', new_string: 'b' }], ['Bash', { command: `echo x > ${rel}` }]]) {
          const r = await fx.judge(world, capture, deadPort, { tool, input, cwd: world.ws, codeMode });
          const request = relayed(r.payload);
          chat.setStandingToolAllows([permissions.toolAllowKey(tool, input), tool, `${tool}(*)`, 'Bash:echo', 'Bash(*)']);
          const html = ask(request);
          const what = `${label}: ${tool} ${rel}`;
          assert.match(html, /data-perm-action="allow"/, `${what}: the card is shown, not answered from the saved allow`);
          assert.match(html, /data-perm-action="deny"/, `${what}: Deny is offered`);
          assert.doesNotMatch(html, /data-perm-action="always"|data-perm-action="allow-folder"|Always allow/, `${what}: and nothing that would be remembered`);
          assert.match(html, summary, `${what}: the heading names what the file decides`);
          assert.match(html, says, `${what}: and so does the reason it asks`);
          assert.match(html, /every time/, `${what}: and that it keeps asking`);
          chat.setStandingToolAllows([]);
        }
      }
    }
  });

  // A launcher draws a card only where the hook is not the one asking: a
  // Codex agent's escalation that reaches one. That card names the checks.
  test('a card drawn for a launcher names the permission checks it starts', () => {
    for (const rel of LAUNCHERS) {
      const p = path.join(world.ws, rel);
      const html = ask({ subtype: 'can_use_tool', tool_name: 'WriteFile', input: { path: p, approvalKind: 'fileChange' }, answer_file: true, resolved_path: p, grant_dir: null });
      assert.match(html, LAUNCHER.summary, `${rel}: the heading`);
      assert.match(html, LAUNCHER.says, `${rel}: and the reason`);
    }
  });

  test('a command that also reaches outside leads with that, and still says what the file decides', async () => {
    for (const { rel, says } of TARGETS) {
      const r = await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command: `cp /etc/hosts ${rel}` }, cwd: world.ws, codeMode: false });
      assert.ok(r.payload && r.payload.boundary && r.payload.crossings.some(c => c.answerFile) && r.payload.crossings.some(c => !c.answerFile), `sanity: ${rel} and a real crossing`);
      assert.strictEqual(r.dead.decision, 'deny', `cp /etc/hosts ${rel}: refused when nobody can be asked`);
      const html = ask(relayed(r.payload));
      assert.match(html, /outside your workspace/, `${rel}: the crossing is the headline`);
      assert.match(html, says, `${rel}: and the stakes name what the file decides`);
      assert.doesNotMatch(html, /data-perm-action="always"|data-perm-action="allow-folder"|Always allow/, `${rel}: and nothing is remembered`);
    }
  });

  test('a stored folder grant over the whole workspace does not cover it', () => {
    const config = require('../../lib/config.js');
    const boundary = require('../../lib/workspace/boundary.js');
    const prev = config.getWorkspace();
    const store = path.join(world.ws, '.rundock', 'permissions.json');
    const kept = fs.readFileSync(store);
    try {
      config.setWorkspace(world.ws);
      boundary.addBoundaryGrant(world.home);
      for (const { rel } of TARGETS) {
        const target = path.join(world.ws, rel);
        assert.strictEqual(boundary.boundaryGrantCovers(target), true, `sanity: the grant reaches ${rel} by the ordinary prefix rule`);
        assert.strictEqual(boundary.crossingCovered({ path: target }), false, `and still does not answer for ${rel}`);
      }
    } finally {
      config.setWorkspace(prev);
      fs.writeFileSync(store, kept);
    }
  });
});

// The files beside them are graded as they were.
describe('the ordinary files beside them are unchanged', { skip: SKIP }, () => {
  const NEIGHBOURS = ['.rundock/scratch/x.txt', '.claude/agents/a.md', '.claude/skills/s/SKILL.md', 'mcp.json', '.rundock/permission-hook.sh.bak',
    'notes/.mcp.json', '.claude/settings.json.bak', '.claude/hooks.md', '.claude/hooks-old/x.sh'];
  for (const { codeMode, label } of MODES) {
    test(`a write to each is ordinary work (${label} mode)`, async () => {
      for (const rel of NEIGHBOURS) {
        const w = await fx.judge(world, capture, deadPort, { tool: 'Write', input: { file_path: path.join(world.ws, rel), content: 'x' }, cwd: world.ws, codeMode });
        assert.strictEqual(w.cls, 'runs', `${label}: Write ${rel} is allowed at once, as before`);
        const b = await fx.judge(world, capture, deadPort, { tool: 'Bash', input: { command: `echo x > ${rel}` }, cwd: world.ws, codeMode });
        assert.ok(!isAnswerFileRequest(b.payload), `${label}: echo x > ${rel} is not an answer file`);
        if (codeMode) assert.strictEqual(b.cls, 'runs', `Code: echo x > ${rel} runs, as before`);
        else assert.strictEqual(b.dead.decision, 'allow', `Notes: echo x > ${rel} keeps its ordinary card, which a dead server does not turn into a refusal`);
      }
    });
  }
});
