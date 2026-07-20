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

  dom.window.close(); // stop the wizard's polling interval so the test can exit
});
