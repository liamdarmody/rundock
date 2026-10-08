#!/usr/bin/env node
'use strict';

/**
 * Can this shell drive a browser and push a branch? Find out in seconds, and
 * be told the fix, before a lane depends on either.
 *
 *   node scripts/capability-preflight.js            # both
 *   node scripts/capability-preflight.js --browser  # Chromium starts and loads a page
 *   node scripts/capability-preflight.js --push     # git can push this branch, gh is signed in
 *
 * Run it from the lane's own worktree, in the same shape the lane's real
 * commands will take, as one bare command. That is the point of it: the
 * answer depends on the invocation's shape (see scripts/lib/sandbox.js), so
 * a check run any other way answers a different question.
 *
 * WHAT IT NEVER SAYS. "Can't start" and "token invalid" are what these two
 * look like from inside the sandbox, and both have sent people after the
 * wrong cause. Inside the sandbox this reports that, and nothing else, without
 * trying either. Outside it, each failure is reported with its cause and the
 * command that fixes it. The push is a dry run: nothing reaches the remote.
 *
 * Exit codes: 0 every check passed, 1 a check failed, 2 sandboxed.
 */

const { spawnSync } = require('node:child_process');
const { isSandboxed } = require('./lib/sandbox.js');

const ROOT = require('node:path').join(__dirname, '..');
const SELF = 'node scripts/capability-preflight.js';

function firstLine(text) {
  return String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
}

// Chromium, as the browser pass launches it.
async function checkBrowser({ launch } = {}) {
  const start = launch || (async () => {
    const { chromium } = require('@playwright/test');
    return chromium.launch();
  });
  let browser;
  try {
    browser = await start();
    const page = await browser.newPage();
    await page.setContent('<p>ok</p>');
    const text = await page.textContent('p');
    if (text !== 'ok') return { ok: false, cause: 'Chromium started but did not render a page.', fix: 'npx playwright install chromium' };
    return { ok: true, detail: 'Chromium started and rendered a page.' };
  } catch (err) {
    const message = String(err && err.message || err);
    if (/Executable doesn't exist|browserType\.launch: .*not found|Please run the following command to download new browsers/i.test(message)) {
      return { ok: false, cause: 'Playwright has no Chromium installed for this checkout.', fix: 'npx playwright install chromium' };
    }
    if (/Cannot find module '@playwright\/test'/.test(message)) {
      return { ok: false, cause: 'This checkout has no dependencies installed.', fix: 'npm ci' };
    }
    return { ok: false, cause: `Chromium failed outside the sandbox: ${firstLine(message)}`, fix: 'npx playwright install chromium, then run this again' };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

function defaultRun(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
  return { status: r.error ? null : r.status, stdout: r.stdout || '', stderr: r.stderr || (r.error ? r.error.message : '') };
}

// A dry-run push of this branch to origin authenticates exactly as a real push
// does and sends nothing. gh is checked too, because the pull request is the
// other half of pushing a lane.
function checkPush({ run = defaultRun, cwd = ROOT } = {}) {
  const branch = run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd);
  if (branch.status !== 0) return { ok: false, cause: 'HEAD is not on a branch, so there is nothing to push.', fix: 'git switch <lane branch>' };
  const name = branch.stdout.trim();
  const push = run('git', ['push', '--dry-run', '--porcelain', 'origin', `HEAD:refs/heads/${name}`], cwd);
  if (push.status !== 0) {
    const err = `${push.stderr}\n${push.stdout}`;
    if (/could not read Username|Authentication failed|terminal prompts disabled|returned error: 40[13]|Permission denied \(publickey\)/i.test(err)) {
      return { ok: false, cause: 'git could not authenticate to origin.', fix: 'gh auth setup-git (after gh auth login, at a terminal)' };
    }
    if (/Could not resolve host|Network is unreachable|Connection timed out|Failed to connect/i.test(err)) {
      return { ok: false, cause: 'origin could not be reached over the network.', fix: 'check the network connection, then run this again' };
    }
    if (/non-fast-forward|fetch first|rejected/i.test(err)) {
      return { ok: false, cause: `origin has commits on ${name} this checkout does not, so a push would be rejected.`, fix: `git fetch origin ${name}, then rebase or merge` };
    }
    return { ok: false, cause: `git push --dry-run failed: ${firstLine(err)}`, fix: 'run git push --dry-run origin HEAD at a terminal to see it in full' };
  }
  const gh = run('gh', ['auth', 'status', '--hostname', 'github.com'], cwd);
  if (gh.status === null) return { ok: false, cause: 'gh is not installed, so no pull request can be opened.', fix: 'install the GitHub CLI' };
  if (gh.status !== 0) return { ok: false, cause: 'gh is not signed in to github.com, so no pull request can be opened.', fix: 'gh auth login (at a terminal)' };
  return { ok: true, detail: `git can push ${name} to origin (dry run) and gh is signed in.` };
}

async function preflight({ env = process.env, want = { browser: true, push: true }, browser = checkBrowser, push = checkPush } = {}) {
  if (isSandboxed(env)) {
    return {
      code: 2,
      lines: [
        '[capability] SANDBOXED: this shell is inside the agent sandbox (SANDBOX_RUNTIME=1), so neither a browser nor a',
        '[capability] push can work here, so neither was tried. Fix this first: a browser or credential error seen here says nothing.',
        `[capability] Fix: run "${SELF}" (or the lane's own command) as one bare command, from the worktree, with nothing`,
        '[capability] chained, piped or redirected, so the sandbox exclusions match it; or through scripts/exempt-run.js.',
      ],
    };
  }
  const lines = [];
  let failed = 0;
  for (const [name, check] of [['browser', browser], ['push', push]]) {
    if (!want[name]) continue;
    const r = await check();
    if (r.ok) lines.push(`[capability] ${name}: ok. ${r.detail}`);
    else { failed++; lines.push(`[capability] ${name}: FAIL. ${r.cause}`, `[capability]   fix: ${r.fix}`); }
  }
  return { code: failed ? 1 : 0, lines };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const some = args.includes('--browser') || args.includes('--push');
  const want = { browser: !some || args.includes('--browser'), push: !some || args.includes('--push') };
  preflight({ want }).then(({ code, lines }) => {
    for (const l of lines) (code ? console.error : console.log)(l);
    process.exit(code);
  });
}

module.exports = { preflight, checkBrowser, checkPush };
