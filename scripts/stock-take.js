#!/usr/bin/env node
'use strict';

/**
 * The clean-up stock-take: what this repository has lying around, what is
 * safe to remove, and the one command a person must run that an agent cannot.
 *
 *   node scripts/stock-take.js            # from any checkout of the repository
 *   node scripts/stock-take.js --json     # the same, as data
 *
 * READ-ONLY. It runs git to look and never to change anything: no fetch, no
 * removal, no config write. Remote refs are as of the last fetch.
 *
 * WHAT IT LISTS
 *   - Worktrees, each with its uncommitted changes and its commits that are on
 *     no remote. A linked worktree with neither is removable.
 *   - Local branches, each with whether it is merged into the base and how
 *     many of its commits are on no remote. A branch with none, not checked
 *     out anywhere that stays, is removable.
 *   - Branch sections in the repository's config: `[branch "x"]` sections for
 *     branches that no longer exist, and those of the branches this plan
 *     removes.
 *
 * WHY IT PRINTS A COMMAND FOR A PERSON. Two things the clean-up needs are
 * writes inside `.git` that the agent sandbox refuses:
 *   - deleting a branch leaves its config section behind, and only a config
 *     write removes it;
 *   - removing the last linked worktree makes git delete the empty
 *     `.git/worktrees` folder, and no new worktree can be added until it is
 *     made again.
 * So both are printed as one command, alongside the list, for the same
 * approval, instead of being found later one at a time.
 */

const path = require('node:path');
const { execFileSync } = require('node:child_process');

function gitIn(cwd) {
  return (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const tryGit = (git, args, fallback = '') => {
  try { return git(args); } catch { return fallback; }
};

// `git worktree list --porcelain`, as records. The first is the main one.
function parseWorktrees(text) {
  const out = [];
  for (const block of String(text).split(/\n\n+/)) {
    const wt = {};
    for (const line of block.split('\n')) {
      const [key, ...rest] = line.split(' ');
      const value = rest.join(' ');
      if (key === 'worktree') wt.path = value;
      else if (key === 'HEAD') wt.head = value;
      else if (key === 'branch') wt.branch = value.replace(/^refs\/heads\//, '');
      else if (key === 'detached') wt.branch = null;
      else if (key === 'prunable') wt.prunable = true;
    }
    if (wt.path) out.push(wt);
  }
  return out;
}

// The branch names that `branch.<name>.<key>` config entries are about. A
// branch name may itself hold dots, so the key is everything after the last.
function parseBranchSections(text) {
  const names = [];
  for (const line of String(text).split('\n')) {
    const key = line.trim().split(/\s/)[0];
    if (!key || !key.startsWith('branch.')) continue;
    const name = key.slice('branch.'.length, key.lastIndexOf('.'));
    if (name && key.lastIndexOf('.') > 'branch'.length && !names.includes(name)) names.push(name);
  }
  return names;
}

function gather(cwd = process.cwd(), git = gitIn(cwd)) {
  const commonDir = path.resolve(cwd, git(['rev-parse', '--git-common-dir']).trim());
  const base = tryGit(git, ['rev-parse', '--verify', '--quiet', 'origin/main']).trim() ? 'origin/main' : 'main';
  const worktrees = parseWorktrees(git(['worktree', 'list', '--porcelain'])).map((wt, i) => {
    const wgit = gitIn(wt.path);
    const missing = wt.prunable || !tryGit(wgit, ['rev-parse', '--show-toplevel'], null);
    return {
      ...wt,
      main: i === 0,
      missing: Boolean(missing),
      dirty: missing ? 0 : tryGit(wgit, ['status', '--porcelain']).split('\n').filter(Boolean).length,
      unpushed: Number(tryGit(git, ['rev-list', '--count', wt.head, '--not', '--remotes'], '0').trim()) || 0,
    };
  });
  const branches = tryGit(git, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n').filter(Boolean).map((name) => ({
    name,
    merged: tryGit(git, ['merge-base', '--is-ancestor', name, base], null) !== null,
    unpushed: Number(tryGit(git, ['rev-list', '--count', name, '--not', '--remotes'], '0').trim()) || 0,
  }));
  const sections = parseBranchSections(tryGit(git, ['config', '--file', path.join(commonDir, 'config'), '--name-only', '--get-regexp', '^branch\\.']));
  return { commonDir, base, worktrees, branches, sections };
}

// POSIX single-quoting, for a name typed into someone's terminal.
function shellQuote(s) {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(s) ? s : `'${String(s).replace(/'/g, "'\\''")}'`;
}

function plan({ commonDir, base, worktrees, branches, sections }) {
  const removableWorktrees = worktrees.filter((w) => !w.main && (w.missing || (w.dirty === 0 && w.unpushed === 0)));
  const staying = new Set(worktrees.filter((w) => !removableWorktrees.includes(w)).map((w) => w.branch).filter(Boolean));
  const baseName = base.replace(/^origin\//, '');
  const removableBranches = branches.filter((b) => b.unpushed === 0 && b.name !== baseName && !staying.has(b.name));
  const existing = new Set(branches.map((b) => b.name));
  const removing = new Set(removableBranches.map((b) => b.name));
  const staleSections = sections
    .filter((name) => !existing.has(name) || removing.has(name))
    .map((name) => ({ name, why: existing.has(name) ? 'its branch is removed by this plan' : 'its branch no longer exists' }));
  const linked = worktrees.filter((w) => !w.main);
  const removesLastWorktree = linked.length > 0 && removableWorktrees.length === linked.length;

  const parts = staleSections.map((s) => `git config --file ${shellQuote(path.join(commonDir, 'config'))} --remove-section ${shellQuote(`branch.${s.name}`)}`);
  if (removesLastWorktree) parts.push(`mkdir ${shellQuote(path.join(commonDir, 'worktrees'))}`);
  return {
    removableWorktrees, removableBranches, staleSections, removesLastWorktree,
    command: parts.length ? parts.join(' && ') : null,
  };
}

function report(facts, p) {
  const lines = [];
  const rel = (w) => w.path;
  lines.push(`Stock-take of ${facts.commonDir} (read-only; remote refs as of the last fetch; base ${facts.base})`, '');
  lines.push(`Worktrees (${facts.worktrees.length}):`);
  for (const w of facts.worktrees) {
    const state = w.main ? 'main checkout, kept'
      : w.missing ? 'its folder is gone: removable (prune)'
        : w.dirty || w.unpushed ? `KEEP or archive first: ${w.dirty} uncommitted, ${w.unpushed} commit(s) on no remote`
          : 'clean, every commit on a remote: removable';
    lines.push(`  ${rel(w)}  [${w.branch || 'detached'}]  ${state}`);
  }
  lines.push('', `Local branches (${facts.branches.length}):`);
  for (const b of facts.branches) {
    const removable = p.removableBranches.includes(b);
    lines.push(`  ${b.name}  ${b.merged ? 'merged' : 'not merged'}, ${b.unpushed} commit(s) on no remote${removable ? ': removable' : ''}`);
  }
  if (p.removesLastWorktree) {
    lines.push('', 'This plan removes the last linked worktree. Git then deletes the empty .git/worktrees folder, which the',
      'sandbox cannot make again, so the command below recreates it.');
  }
  if (p.command) {
    lines.push('');
    if (p.staleSections.length) {
      lines.push('Branch config sections to remove (the sandbox cannot write the config):');
      for (const s of p.staleSections) lines.push(`  [branch "${s.name}"]  ${s.why}`);
    }
    lines.push('', 'For a person to run, in the same approval as the list, once the removals above are done:', `  ${p.command}`);
  }
  return lines.join('\n');
}

if (require.main === module) {
  const facts = gather();
  const p = plan(facts);
  if (process.argv.includes('--json')) console.log(JSON.stringify({ ...facts, plan: p }, null, 2));
  else console.log(report(facts, p));
}

module.exports = { parseWorktrees, parseBranchSections, gather, plan, report, shellQuote };
