'use strict';
// Private terms that must never reach a public repository: names of people,
// connected services, workspaces and agents. The list itself is private, so it
// lives outside every repository and is never copied into one. This file only
// knows how to find it, read it and match it, and never prints a term in full.
//
// Where the list is: the RUNDOCK_PRIVATE_DENYLIST environment variable, else
// `git config rundock.privateDenylist` (per clone, or once with --global). A
// default path cannot be written here, because the path itself is private.
//
// Format: one entry per line. A plain term matches as a whole word, ignoring
// case. `re:<regex>` is a case-insensitive regular expression. `#` starts a
// comment. A `[class]` line names the class reported for the entries below it.
// An entry may end with `  !<regex>`: a place where it is intended and signed
// off (a published testimonial, say), matched against "<repository folder>/<path>".
// The entry still applies to every other file and to every message.

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function parseDenylist(text) {
  const entries = [];
  const errors = [];
  let cls = 'private term';
  String(text).split('\n').forEach((raw, i) => {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) return;
    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) { cls = section[1].trim(); return; }
    const scoped = line.match(/^(.*?)\s+!(\S.*)$/);
    const term = scoped ? scoped[1] : line;
    try {
      const except = scoped ? new RegExp(scoped[2]) : null;
      const re = term.startsWith('re:')
        ? new RegExp(term.slice(3), 'gi')
        : new RegExp(`(?<![A-Za-z0-9])${escape(term)}(?![A-Za-z0-9])`, 'gi');
      entries.push({ cls, re, except });
    } catch (e) {
      errors.push(`line ${i + 1}: invalid regex (${e.message.replace(/\/.*\//, '/.../')})`);
    }
  });
  return { entries, errors };
}

function gitConfigValue() {
  try {
    return execFileSync('git', ['config', '--get', 'rundock.privateDenylist'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}

function resolveDenylistPath(env = process.env, gitConfig = gitConfigValue) {
  return env.RUNDOCK_PRIVATE_DENYLIST || gitConfig() || '';
}

const WARNING = [
  '',
  '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
  '!!  PRIVATE DENYLIST NOT FOUND: names of people, services and      !!',
  '!!  workspaces are NOT being checked. Only generic rules ran.      !!',
  '!!  Set RUNDOCK_PRIVATE_DENYLIST, or once for every repository:    !!',
  '!!    git config --global rundock.privateDenylist <path>           !!',
  '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
  '',
].join('\n');

// { status: 'loaded' | 'missing' | 'skipped', entries, errors, warning }
function loadDenylist({ env = process.env, gitConfig = gitConfigValue } = {}) {
  if (env.CI) return { status: 'skipped', entries: [], errors: [], warning: 'private denylist: skipped under CI (generic rules only).' };
  const file = resolveDenylistPath(env, gitConfig);
  let text;
  try { text = file ? fs.readFileSync(file, 'utf8') : null; } catch { text = null; }
  if (text === null) return { status: 'missing', entries: [], errors: [], warning: WARNING };
  return { status: 'loaded', ...parseDenylist(text), warning: '' };
}

// A private term, masked: its first character and its length only.
const maskPrivate = (v) => `${v.slice(0, 1)}${'*'.repeat(Math.min(Math.max(v.length - 1, 0), 12))} (${v.length} characters)`;

function scanPrivate(label, text, entries, { scope = null } = {}) {
  const out = [];
  String(text).split('\n').forEach((line, i) => {
    const seen = []; // one finding per span: a surname inside a full name is not a second leak
    for (const { cls, re, except } of entries) {
      if (except && scope && except.test(scope)) continue;
      re.lastIndex = 0;
      for (const m of line.matchAll(re)) {
        const end = m.index + m[0].length;
        if (!m[0] || seen.some(([a, b]) => m.index >= a && end <= b)) continue;
        seen.push([m.index, end]);
        out.push({ file: label, line: i + 1, cls, label: `private ${cls}`, match: maskPrivate(m[0]) });
      }
    }
  });
  return out;
}

module.exports = { parseDenylist, resolveDenylistPath, loadDenylist, scanPrivate, maskPrivate };
