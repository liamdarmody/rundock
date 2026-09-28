'use strict';
// First-run wizard: when Claude Code (the CLI) is not installed, the install
// step must be an actionable, numbered state (never the eternal spinner the
// beta user hit), with a selectable per-OS install command and copy that
// distinguishes Claude Code from the Claude desktop app.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const WIZARD_HTML = path.join(__dirname, '..', '..', 'electron', 'wizard.html');

function loadWizard(claudeStatus) {
  const html = fs.readFileSync(WIZARD_HTML, 'utf8');
  const runtimes = { claude: { status: claudeStatus }, codex: { installed: false, authenticated: false } };
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    beforeParse(window) {
      window.electronAPI = {
        platform: 'darwin',
        checkRuntimes: async () => runtimes,
        signInClaude: async () => ({ ok: true }),
        signInCodex: async () => ({ ok: true }),
        wizardDone: () => {},
      };
    },
  });
  return { dom, runtimes };
}

// The declarations of one rule in the wizard's own stylesheet, whitespace
// collapsed, so a test can pin a declaration without pinning the formatting.
function ruleBody(html, selector) {
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = style.match(new RegExp('(?:^|\\n)\\s*' + escaped + '\\s*\\{([^}]*)\\}'));
  assert.ok(match, 'the stylesheet has a ' + selector + ' rule');
  return match[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim();
}

test('install step is actionable with a selectable command when Claude Code is missing', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'electron', 'wizard.html'), 'utf8');
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    beforeParse(window) {
      // A machine with the Claude DESKTOP APP but not Claude Code reports
      // not-installed (the CLI is not on PATH).
      window.electronAPI = {
        platform: 'darwin',
        checkRuntimes: async () => ({ claude: { status: 'not-installed' }, codex: { installed: false, authenticated: false } }),
        signInClaude: async () => ({ ok: true }),
        signInCodex: async () => ({ ok: true }),
        wizardDone: () => {},
      };
    },
  });
  const { document } = dom.window;
  // Let checkNow()'s async runtime check resolve and update the DOM.
  await new Promise((r) => setTimeout(r, 250));

  const step = document.getElementById('step-install');
  const icon = document.getElementById('icon-install');
  const hint = document.getElementById('install-hint');

  assert.ok(step.className.includes('attention'), 'install step is in the action-needed state, not active/spinning');
  assert.strictEqual(icon.querySelector('.spinner'), null, 'no spinner on the install step');
  assert.strictEqual(icon.textContent.trim(), '1', 'install step shows its number');
  assert.match(hint.innerHTML, /curl -fsSL https:\/\/claude\.ai\/install\.sh/, 'shows the macOS install command');
  assert.match(hint.innerHTML, /different from the Claude desktop app/i, 'names the desktop-app vs CLI distinction');
  assert.match(hint.innerHTML, /-webkit-app-region:\s*no-drag/, 'the command is selectable (opts out of the drag region)');
  assert.notStrictEqual(hint.style.display, 'none', 'the install instructions are shown while install is needed');

  dom.window.close(); // stop the wizard's polling interval so the test can exit
});

test('the heading sits in a fixed header and the steps and buttons in a body that can scroll', async () => {
  const { dom } = loadWizard('not-installed');
  const { document } = dom.window;
  await new Promise((r) => setTimeout(r, 250)); // let the first runtime check settle before closing
  const header = document.querySelector('body > .wizard-header');
  const body = document.querySelector('body > .wizard-body');
  assert.ok(header && body, 'header and body are both direct children of the page body');
  assert.ok(header.compareDocumentPosition(body) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, 'the header comes before the body');
  assert.ok(header.querySelector('h1'), 'the heading is in the header');
  assert.ok(header.querySelector('#subtitle'), 'the subtitle is in the header');
  assert.ok(body.querySelector('.status'), 'the steps are in the body');
  for (const id of ['btn-signin', 'btn-codex-signin', 'btn-check', 'btn-codex-skip', 'btn-skip']) {
    assert.ok(body.querySelector('#' + id), id + ' is in the body');
  }
  dom.window.close();
});

test('the header and body are centered as one block, falling back to top alignment when they do not fit', () => {
  const html = fs.readFileSync(WIZARD_HTML, 'utf8');
  const page = ruleBody(html, 'body');
  assert.match(page, /justify-content: center; justify-content: safe center;/, 'safe centering, with plain center declared first as the fallback');
  assert.match(page, /overflow: hidden;/);
  assert.doesNotMatch(page, /padding:/, 'the page body carries no padding; the header and body pad themselves');

  const header = ruleBody(html, '.wizard-header');
  assert.match(header, /flex: 0 0 auto;/, 'the header never shrinks');

  const body = ruleBody(html, '.wizard-body');
  assert.match(body, /flex: 0 1 auto;/, 'the body does not grow to fill the window, so centering has room to work');
  assert.match(body, /min-height: 0;/, 'the body can shrink below its content, which overflow needs');
  assert.match(body, /overflow-y: auto;/, 'the body scrolls when the display is too small');
  assert.match(body, /-webkit-app-region: no-drag;/, 'the body receives wheel and click events');
});

test('the content column widens with the window, and the spacing is one notch tighter', () => {
  const html = fs.readFileSync(WIZARD_HTML, 'utf8');
  assert.match(ruleBody(html, ':root'), /--content-max: max\(280px, calc\(100vw - 140px\)\);/);
  assert.match(ruleBody(html, '.wizard-header'), /max-width: var\(--content-max, 380px\);/);
  const status = ruleBody(html, '.status');
  assert.match(status, /max-width: var\(--content-max, 380px\);/, 'the steps share the header width');
  assert.match(status, /gap: 12px;/);
  assert.match(status, /margin-bottom: 20px;/);
  assert.match(ruleBody(html, 'h1'), /margin-bottom: 6px;/);
  assert.match(ruleBody(html, '.subtitle'), /margin-bottom: 20px;/);
  assert.match(ruleBody(html, '.step'), /padding: 12px 16px;/);
});

test('the install instructions hide once Claude Code is installed, and return if it goes missing', async () => {
  const { dom, runtimes } = loadWizard('not-authenticated');
  const { document } = dom.window;
  await new Promise((r) => setTimeout(r, 250));

  const hint = document.getElementById('install-hint');
  assert.ok(document.getElementById('step-install').className.includes('done'), 'the install step is done');
  assert.strictEqual(hint.style.display, 'none', 'the spent install instructions are hidden');

  runtimes.claude = { status: 'not-installed' };
  await dom.window.checkNow();
  assert.ok(document.getElementById('step-install').className.includes('attention'), 'the install step needs action again');
  assert.notStrictEqual(hint.style.display, 'none', 'the install instructions are shown again');

  dom.window.close();
});
