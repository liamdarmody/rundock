'use strict';
// The facts the Code-mode verdict reads from the disk and from git, behind one
// seam so a Windows-shaped world can be judged on any host.
//
// Only four questions are ever asked: does a path exist, which working tree is
// it in, what does git hold unsaved under some paths, and which branch does a
// push land on. Every git call has a short limit and any failure is reported
// as a failure, never as "nothing unsaved": the caller asks when it cannot
// check.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const GIT_LIMIT_MS = 3000;

function git(args, cwd) {
  return execFileSync('git', ['--no-optional-locks', ...args], {
    cwd, encoding: 'utf-8', timeout: GIT_LIMIT_MS, stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 64 * 1024 * 1024,
  });
}

// The real path of `p`, judged by its nearest existing ancestor with the
// unborn tail reattached, so one place under two names is one identity.
function realNearest(p) {
  const tail = [];
  let cur = path.resolve(p);
  for (;;) {
    try {
      const real = fs.realpathSync.native ? fs.realpathSync.native(cur) : fs.realpathSync(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch (e) {
      const up = path.dirname(cur);
      if (up === cur) return path.resolve(p);
      tail.push(path.basename(cur));
      cur = up;
    }
  }
}

// The top of the working tree holding `p` (a `.git` folder, or a `.git` file
// for a worktree or submodule), walking up with no subprocess; or null.
function gitTop(p) {
  let cur = realNearest(p);
  for (;;) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur;
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

// What git holds unsaved under `specs` (pathspecs relative to `top`):
//   tracked     tracked files with changes
//   untracked   new files git has never seen and does not ignore
//   ignoredEnv  ignored .env and .env.* files, when `env` is asked for
// { ok: false } on any failure.
function gitStatus(top, specs, { env = false } = {}) {
  const list = specs.length ? specs.map(s => s || '.') : ['.'];
  try {
    const raw = git(['-C', top, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...list], top);
    const tracked = [];
    const untracked = [];
    const parts = raw.split('\0').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const xy = parts[i].slice(0, 2);
      const file = parts[i].slice(3);
      if (xy === '??') untracked.push(file);
      else if (xy !== '!!') tracked.push(file);
      if (xy[0] === 'R' || xy[0] === 'C') i++; // a rename carries its source next
    }
    let ignoredEnv = [];
    if (env) {
      const patterns = [];
      for (const s of list) {
        const scope = s === '.' ? '' : s.replace(/\/+$/, '');
        const pre = scope ? `${scope}/` : '';
        patterns.push(`:(glob)${pre}**/.env`, `:(glob)${pre}**/.env.*`);
        if (/(^|\/)\.env(\.[^/]*)?$/.test(scope)) patterns.push(`:(literal)${scope}`);
      }
      const out = git(['-C', top, 'ls-files', '-z', '-o', '-i', '--exclude-standard', '--', ...patterns], top);
      ignoredEnv = out.split('\0').filter(Boolean);
    }
    return { ok: true, tracked, untracked, ignoredEnv };
  } catch (e) {
    return { ok: false };
  }
}

function currentBranch(top) {
  try { return git(['-C', top, 'branch', '--show-current'], top).trim() || null; } catch (e) { return null; }
}

// The remote's default branch from refs/remotes/<remote>/HEAD; when that is
// unset, main and master both count.
function defaultBranches(top, remote = 'origin') {
  try {
    const ref = git(['-C', top, 'symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`], top).trim();
    const name = ref.replace(`refs/remotes/${remote}/`, '');
    if (name && name !== ref) return [name];
  } catch (e) { /* unset: fall through */ }
  return ['main', 'master'];
}

function isTag(top, name) {
  try { git(['-C', top, 'show-ref', '--verify', '--quiet', `refs/tags/${name}`], top); return true; } catch (e) { return false; }
}

function defaultContext() {
  return { exists: p => fs.existsSync(p), canonical: realNearest, gitTop, gitStatus, currentBranch, defaultBranches, isTag };
}

module.exports = { defaultContext, realNearest, gitTop, gitStatus, currentBranch, defaultBranches, isTag, GIT_LIMIT_MS };
