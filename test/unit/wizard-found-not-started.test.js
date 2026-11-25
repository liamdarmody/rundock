'use strict';
// The setup screen when Claude Code is found but its first start did not
// answer in time (the check's found-not-started). On Windows that first start
// can be slow while the system scans a newly downloaded program, so the
// screen keeps the install step waiting with its own hint, keeps checking,
// and never sends the person back to the install command they already ran.
// Also the install hint's Windows line, and the most common next step run
// through the real check with stand-in children.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { JSDOM } = require('jsdom');
const { loadSetupCheck, VERSION } = require('../helpers/setup-check-children.js');

const WIZARD_HTML = path.join(__dirname, '..', '..', 'electron', 'wizard.html');

const FOUND = { status: 'found-not-started' };
const MISSING = { status: 'not-installed' };
const NO_CODEX = { installed: false, authenticated: false };
const OAUTH = 'Failed to authenticate: OAuth session expired and could not be refreshed';
const failing = { status: 'not-authenticated', reason: { kind: 'said', text: OAUTH, signIn: true } };

const FOUND_HINT = "Claude Code is installed but didn't start in time. Its first start on Windows can take a minute. "
  + 'This screen keeps checking, or click Check again.';
const FOUND_NUDGE = "Claude Code still hasn't started. Click Check again to try once more.";
const INSTALL_NUDGE = 'Still not detecting Claude Code. Make sure you ran the install command in the terminal '
  + '(not the desktop app), then click Check again.';
// Anything that sends the person back to install.
const INSTALL_WORDS = ['irm ', 'install.ps1', 'curl ', 'install.sh', 'winget', 'install command', 'Install it'];

// The install hint as main builds it, for the platforms it leaves alone.
const CODE = 'background:#333;padding:2px 6px;border-radius:3px;font-size:12px;-webkit-app-region:no-drag;-webkit-user-select:all;user-select:all';
const INTRO = 'Claude Code is a command-line tool, different from the Claude desktop app. Install it and this screen continues automatically.';
const GUIDE = '<br><a href="https://code.claude.com/docs/en/overview" target="_blank">Installation guide</a>';
const UNIX_HINT = INTRO + '<br>In Terminal: <code style="' + CODE + '">curl -fsSL https://claude.ai/install.sh | bash</code>' + GUIDE;
const WIN_LINE = "After installing, open a new PowerShell window. If it says claude isn't recognised, click Check again: "
  + 'Rundock finds Claude Code and adds it to PATH.';
const WIN_HINT = INTRO
  + '<br>In PowerShell: <code style="' + CODE + '">irm https://claude.ai/install.ps1 | iex</code>'
  + '<br>Or WinGet: <code style="' + CODE + '">winget install Anthropic.ClaudeCode</code>'
  + '<br>After installing, open a new PowerShell window. If it says <code style="' + CODE + '">claude</code> '
  + "isn't recognised, click Check again: Rundock finds Claude Code and adds it to PATH."
  + GUIDE;

// The wizard with a stub of the desktop's bridge. Its 3 s poll is recorded and
// never fires on its own: a test ticks it. `runtimes`, when given, answers
// each check in place of the fixed answer.
function loadWizard({ platform = 'darwin', claude = FOUND, codex = NO_CODEX, runtimes = null } = {}) {
  const html = fs.readFileSync(WIZARD_HTML, 'utf8');
  const state = { claude, codex, calls: 0, intervals: [], cleared: [] };
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    beforeParse(window) {
      window.electronAPI = {
        platform,
        checkRuntimes: () => {
          state.calls += 1;
          return runtimes ? runtimes() : Promise.resolve({ claude: state.claude, codex: state.codex });
        },
        signInClaude: async () => ({ ok: true }),
        signInCodex: async () => ({ ok: true }),
        wizardDone: () => {},
      };
      window.setInterval = (fn, ms) => state.intervals.push({ fn, ms });
      window.clearInterval = (id) => { state.cleared.push(id); };
    },
  });
  const doc = dom.window.document;
  const el = (id) => doc.getElementById(id);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const shows = (id) => Boolean(el(id)) && el(id).style.display !== 'none' && !el(id).hidden;
  // The text a person sees in an element: hidden parts left out.
  const visible = (node) => {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1 || node.style.display === 'none' || node.hidden) return '';
    return [...node.childNodes].map(visible).join('');
  };
  return {
    w: dom.window,
    doc,
    el,
    state,
    settle,
    shows,
    installText: () => visible(el('step-install')).replace(/\s+/g, ' ').trim(),
    // The step, its icon, the reason line, both other steps and every button:
    // all a person sees but the install step's hints.
    view() {
      const button = (id) => [id, el(id).style.display, el(id).disabled, el(id).textContent];
      return JSON.stringify([el('step-install').className, el('icon-install').innerHTML,
        el('step-auth').outerHTML, el('step-codex').outerHTML, el('subtitle').textContent,
        ...['btn-signin', 'btn-signin-done', 'btn-codex-signin', 'btn-check', 'btn-codex-skip', 'btn-skip'].map(button)]);
    },
    async tick() { await state.intervals[0].fn(); },
    async check(answer) { state.claude = answer; await dom.window.checkStatus(); },
    async ask(answer) { state.claude = answer; el('btn-signin-done').click(); await settle(); },
    close: () => dom.window.close(),
  };
}

async function loaded(options) {
  const wiz = loadWizard(options);
  await wiz.settle();
  return wiz;
}

describe('found but not started, on the setup screen', () => {
  test('the install step stays in its attention state, numbered and never done, with Check again as its action', async () => {
    const views = [];
    for (const claude of [FOUND, MISSING]) {
      const wiz = await loaded({ claude });
      assert.strictEqual(wiz.el('step-install').className, 'step attention', `${claude.status}: the attention state`);
      assert.strictEqual(wiz.el('icon-install').textContent, '1', `${claude.status}: numbered, never a tick or a spinner`);
      views.push(wiz.view());
      wiz.close();
    }
    assert.strictEqual(views[0], views[1], 'the step and its buttons as for not-installed');
  });

  for (const platform of ['win32', 'darwin', 'linux']) {
    test(`on ${platform} the step shows its own hint, never the install command`, async () => {
      const wiz = await loaded({ platform });
      assert.ok(wiz.shows('found-hint'), 'its own hint shows');
      assert.ok(!wiz.shows('install-hint'), 'the install hint does not');
      for (const words of INSTALL_WORDS) assert.ok(!wiz.installText().includes(words), `the step never says ${words}`);
      wiz.close();
    });
  }

  test('the hint says it is installed but did not start in time, that its first start on Windows can take a minute, and that the screen keeps checking', async () => {
    const wiz = await loaded();
    assert.ok(wiz.el('found-hint'), 'the step has its own hint');
    assert.strictEqual(wiz.el('found-hint').textContent, FOUND_HINT);
    assert.strictEqual(wiz.installText(), `1 Install Claude Code ${FOUND_HINT}`, 'and the step shows nothing else');
    wiz.close();
  });

  test('each hint follows its own state, and both go once the step is done', async () => {
    const wiz = await loaded();
    const hints = () => [wiz.shows('install-hint'), wiz.shows('found-hint')];
    await wiz.check(failing);
    assert.deepStrictEqual(hints(), [false, false], 'done: neither');
    await wiz.check(MISSING);
    assert.deepStrictEqual(hints(), [true, false], 'not installed: the install hint');
    await wiz.check(FOUND);
    assert.deepStrictEqual(hints(), [false, true], 'found: its own');
    wiz.close();
  });

  test('the install-detection poll runs for it as it does for not-installed', async () => {
    const runs = [];
    for (const claude of [FOUND, MISSING]) {
      const wiz = await loaded({ claude });
      for (let i = 0; i < 3; i++) await wiz.tick();
      const kept = [...wiz.state.cleared];
      await wiz.check(failing);
      await wiz.tick();
      runs.push({ intervals: wiz.state.intervals.map((i) => i.ms), calls: wiz.state.calls, kept, cleared: wiz.state.cleared });
      wiz.close();
    }
    assert.deepStrictEqual(runs[0], { intervals: [3000], calls: 6, kept: [], cleared: [1] },
      'every 3 s, a check each tick, kept while found and stopped once it moves to sign-in');
    assert.deepStrictEqual(runs[0], runs[1], 'as for not-installed');
  });

  test('its nudge after 20 polls never tells the person to run the install command', async () => {
    const wiz = await loaded({ platform: 'win32' });
    for (let i = 0; i < 20; i++) await wiz.tick();
    assert.deepStrictEqual(wiz.state.cleared, [1], 'the poll stops at 20, as for not-installed');
    assert.ok(wiz.installText().endsWith(FOUND_NUDGE), 'it nudges in its own words');
    for (const words of [...INSTALL_WORDS, 'Still not detecting']) assert.ok(!wiz.installText().includes(words), `never ${words}`);
    wiz.close();

    const install = await loaded({ claude: MISSING });
    for (let i = 0; i < 20; i++) await install.tick();
    assert.ok(install.installText().endsWith(INSTALL_NUDGE), 'not-installed keeps its nudge as on main');
    install.close();
  });

  // Sign in, then the person asks and that check fails with a reason line.
  async function askedLine(options) {
    const wiz = await loaded({ claude: failing, ...options });
    await wiz.w.signIn();
    await wiz.ask(failing);
    assert.ok(wiz.el('auth-reason').textContent.includes(OAUTH), 'sanity: the asked line shows');
    return wiz;
  }

  test('an automatic answer leaves an asked answer as it is, as not-installed does', async () => {
    const fresh = await loaded({ claude: failing });
    await fresh.check(FOUND);
    assert.ok(fresh.shows('found-hint') && !fresh.shows('install-hint'),
      'sanity: with no asked line, an automatic found answer shows its own hint, not the install command');
    fresh.close();
    for (const late of [FOUND, MISSING]) {
      const wiz = await askedLine();
      const asked = wiz.view();
      await wiz.check(late);
      assert.strictEqual(wiz.view(), asked, `${late.status}: the line, the step and the buttons stay`);
      wiz.close();
    }
  });

  test('an asked answer clears the reason line and moves the step back, as not-installed does', async () => {
    const views = [];
    for (const late of [FOUND, MISSING]) {
      const wiz = await askedLine();
      await wiz.ask(late);
      assert.ok(wiz.el('auth-reason').hidden, `${late.status}: the reason line goes`);
      assert.strictEqual(wiz.el('step-install').className, 'step attention');
      views.push(wiz.view());
      wiz.close();
    }
    assert.strictEqual(views[0], views[1]);
  });

  test('the Codex step shows as it does for not-installed', async () => {
    const views = [];
    for (const claude of [FOUND, MISSING]) {
      const wiz = await loaded({ claude, codex: { installed: true, authenticated: false } });
      assert.ok(wiz.shows('step-codex'), `${claude.status}: sanity, the Codex step shows`);
      views.push(wiz.view());
      wiz.close();
    }
    assert.strictEqual(views[0], views[1], 'the Codex step, its buttons and the subtitle as for not-installed');
  });
});

describe('the install hint on each platform', () => {
  test('on Windows it adds what to do in a new PowerShell window', async () => {
    const wiz = await loaded({ platform: 'win32', claude: MISSING });
    assert.strictEqual(wiz.el('install-hint').innerHTML, WIN_HINT);
    assert.ok(wiz.installText().includes(WIN_LINE));
    wiz.close();
  });

  for (const platform of ['darwin', 'linux']) {
    test(`on ${platform} it is byte for byte as on main`, async () => {
      const win = await loaded({ platform: 'win32', claude: MISSING });
      assert.ok(win.installText().includes(WIN_LINE), 'sanity: the platform switch is live');
      win.close();
      const wiz = await loaded({ platform, claude: MISSING });
      assert.strictEqual(wiz.el('install-hint').innerHTML, UNIX_HINT);
      wiz.close();
    });
  }
});

// Sequence 4, the most common next step: the person installs, the check finds
// Claude Code and writes the User PATH at once while the first start is still
// slow, the screen says it is found and still checking, and the next check
// moves it to sign-in. The real check runs, with stand-in children and timers.
const WIN_EXE = 'C:\\Users\\example\\.local\\bin\\claude.exe';
const WIN_FOLDER = 'C:\\Users\\example\\.local\\bin';

function standIns(t, mod, world) {
  const saved = { ...mod.deps };
  t.after(() => { Object.assign(mod.deps, saved); });
  const started = [];
  const timers = [];
  const kind = (program, args) => (program === 'where.exe' ? 'lookup'
    : args.at(-1) === mod.READ_SCRIPT ? 'path read'
      : args.at(-1) === mod.WRITE_SCRIPT ? 'path write'
        : args.includes('--version') ? 'version' : 'sign-in');
  Object.assign(mod.deps, {
    spawn(program, args, options) {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => true;
      const what = kind(program, args);
      started.push({ what, options });
      const reply = world(what);
      if (reply) {
        setImmediate(() => {
          if (reply.stdout) child.stdout.emit('data', Buffer.from(reply.stdout));
          if (reply.stderr) child.stderr.emit('data', Buffer.from(reply.stderr));
          child.emit('close', reply.status || 0, null);
        });
      }
      return child;
    },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
  });
  return { started, timers };
}

describe('sequence 4, the most common next step, through the real check', () => {
  test('installed, PATH written while the first start is slow, the screen says found and still checking, and the next check moves it to sign-in', async (t) => {
    const mod = loadSetupCheck();
    const now = { installed: false, slow: true };
    const { started, timers } = standIns(t, mod, (what) => ({
      lookup: now.installed ? { stdout: `${WIN_EXE}\r\n` } : { status: 1 },
      'path read': { stdout: `ExpandString:${Buffer.from('C:\\Windows').toString('base64')}` },
      'path write': { stdout: 'written' },
      version: now.slow ? null : { stdout: VERSION },
      'sign-in': { status: 1, stderr: 'Not logged in\n' },
    })[what]);
    const check = mod.createSetupCheck({ platform: 'win32', env: { PATH: 'C:\\Windows', USERPROFILE: 'C:\\Users\\example' }, extendPath: () => {} });
    const wiz = await loaded({ platform: 'win32', runtimes: async () => ({ claude: await check.check(), codex: NO_CODEX }) });
    assert.ok(wiz.shows('install-hint') && wiz.installText().includes(WIN_LINE), 'before install: the install step, with its PowerShell line');

    now.installed = true;
    const tick = wiz.tick();
    for (let i = 0; i < 500 && !started.some((s) => s.what === 'version'); i++) await new Promise((r) => setImmediate(r));
    const version = started.findIndex((s) => s.what === 'version');
    assert.ok(version > 0, 'the version run started');
    timers[version].fn();
    await tick;
    assert.deepStrictEqual(started.map((s) => s.what), ['lookup', 'lookup', 'path read', 'path write', 'version'], 'PATH written before the slow start');
    assert.strictEqual(started[3].options.env.SETUP_CHECK_PATH_NEW, `C:\\Windows;${WIN_FOLDER}`);
    assert.ok(mod.WRITE_SCRIPT.includes("SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment'"),
      'and Windows is told, so a new PowerShell window recognises claude');
    assert.strictEqual(wiz.el('step-install').className, 'step attention');
    assert.ok(wiz.shows('found-hint') && !wiz.shows('install-hint'), 'the screen says found and still checking');
    assert.deepStrictEqual(wiz.state.cleared, [], 'and keeps checking');

    now.slow = false;
    await wiz.tick();
    assert.deepStrictEqual(started.map((s) => s.what).slice(5), ['lookup', 'version', 'sign-in'], 'the folder is not written again');
    assert.ok(wiz.el('step-install').className.includes('done'), 'the next check moves the screen to sign-in');
    assert.ok(wiz.el('step-auth').className.includes('active'));
    assert.strictEqual(wiz.el('btn-signin').style.display, 'inline-block');
    assert.deepStrictEqual([wiz.shows('install-hint'), wiz.shows('found-hint')], [false, false]);
    assert.deepStrictEqual(wiz.state.cleared, [1], 'the install poll stops there');
    wiz.close();
  });
});
