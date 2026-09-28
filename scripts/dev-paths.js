'use strict';
// The development paths outside every working folder, Code mode only.
//
// A coding session writes build logs to the system temp folder, clears package
// caches and reads git's own settings. None of that is the person's work, all
// of it rebuilds or regenerates, and carding it taught people to click through
// cards. So in Code mode these are treated as working folders: reads and writes
// raise no card, and a recursive delete inside them is disposable.
//
// Each cache is the tool's documented default location, and nothing beside it:
// credential files that some tools keep next to their cache (`~/.npmrc`,
// `~/.cargo/credentials.toml`) and executables (`~/.cargo/bin`) are not caches
// and are not covered. A cache whose location could not be confirmed from its
// tool's documentation is left out rather than guessed:
//   npm   ~/.npm (Unix), %LOCALAPPDATA%\npm-cache (Windows)      npm docs, "cache"
//   pip   ~/Library/Caches/pip, ~/.cache/pip, %LOCALAPPDATA%\pip\Cache   pip docs, "Caching"
//   Yarn  ~/Library/Caches/Yarn, ~/.cache/yarn, ~/.yarn/berry/cache     Yarn docs, "cacheFolder"
//   pnpm  ~/Library/pnpm/store, ~/.local/share/pnpm/store             pnpm docs, "store-dir"
//   Cargo ~/.cargo/registry, ~/.cargo/git                              Cargo book, "Cargo Home"
//
// THE TEMP RULE NEVER COVERS THE WORKSPACE OR A WORKING FOLDER. A workspace or
// a working folder opened inside a temp folder is still the person's work, and
// is judged as such; callers check that before treating a path as disposable.
//
// NOR DOES IT COVER HOME. A home folder inside a temp folder (a sandboxed or
// test machine, a throwaway account) is still home: its hidden folders,
// secrets, instruction files and every other file keep their own rules, and
// only the package caches under it stay free. A temp folder inside home, as
// on Windows, is still scratch.
const os = require('os');
const path = require('path');
const fs = require('fs');

const POSIX_CACHES = [
  ['.npm'],
  ['Library', 'Caches', 'pip'], ['.cache', 'pip'],
  ['Library', 'Caches', 'Yarn'], ['.cache', 'yarn'], ['.yarn', 'berry', 'cache'],
  ['Library', 'pnpm', 'store'], ['.local', 'share', 'pnpm', 'store'],
  ['.cargo', 'registry'], ['.cargo', 'git'],
];
const WINDOWS_CACHES = [['npm-cache'], ['pip', 'Cache']]; // under %LOCALAPPDATA%

// git's own settings: free to read, never covered for a write.
const GIT_CONFIG_FILES = [['.gitconfig'], ['.config', 'git', 'config']];

function envValue(env, name) {
  if (!env) return undefined;
  if (env[name] !== undefined) return env[name];
  const k = Object.keys(env).find(x => x.toLowerCase() === name.toLowerCase());
  return k ? env[k] : undefined;
}

function real(p) { try { return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p); } catch (e) { return p; } }

// The temp folders, as absolute paths in the flavour of `platform`.
function tempRoots({ platform = process.platform, env = process.env, tmpdir = os.tmpdir() } = {}) {
  if (platform === 'win32') {
    return [envValue(env, 'TEMP'), envValue(env, 'TMP')].filter(Boolean);
  }
  const roots = ['/tmp', '/private/tmp', tmpdir];
  if (tmpdir) roots.push(real(tmpdir));
  return [...new Set(roots.filter(Boolean))];
}

function cacheRoots({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'win32') {
    const local = envValue(env, 'LOCALAPPDATA');
    return local ? WINDOWS_CACHES.map(parts => path.win32.join(local, ...parts)) : [];
  }
  return POSIX_CACHES.map(parts => path.join(home, ...parts));
}

function gitConfigFiles({ platform = process.platform, home = os.homedir() } = {}) {
  const pmod = platform === 'win32' ? path.win32 : path;
  return GIT_CONFIG_FILES.map(parts => pmod.join(home, ...parts));
}

function isUnderIn(p, root, pmod, fold) {
  const f = v => (fold ? v.toLowerCase() : v);
  const a = f(pmod.resolve(p));
  const b = f(pmod.resolve(root));
  return a === b || a.startsWith(b.endsWith(pmod.sep) ? b : b + pmod.sep);
}

// Whether `p` is inside a temp folder or a package cache.
function isDevPath(p, opts = {}) {
  const platform = opts.platform || process.platform;
  const pmod = platform === 'win32' ? path.win32 : path;
  const fold = platform === 'win32' || platform === 'darwin';
  const canon = opts.canonical || (x => x);
  const under = (x, r) => isUnderIn(x, r, pmod, fold) || isUnderIn(x, canon(r), pmod, fold);
  if (cacheRoots(opts).some(r => under(p, r))) return true;
  // Home under either of its names: a temp folder is often reached through a
  // link (/tmp is /private/tmp on macOS).
  const home = opts.home || os.homedir();
  const homes = [home, canon(home)];
  const inHome = homes.some(h => under(p, h));
  return tempRoots(opts).some(r => under(p, r) && !(inHome && homes.some(h => under(h, r))));
}

function isGitConfigFile(p, opts = {}) {
  const platform = opts.platform || process.platform;
  const pmod = platform === 'win32' ? path.win32 : path;
  const fold = platform === 'win32' || platform === 'darwin';
  return gitConfigFiles(opts).some(f => (fold ? f.toLowerCase() : f) === (fold ? pmod.resolve(p).toLowerCase() : pmod.resolve(p)));
}

module.exports = { tempRoots, cacheRoots, gitConfigFiles, isDevPath, isGitConfigFile, isUnderIn, envValue, POSIX_CACHES, WINDOWS_CACHES };
