'use strict';
// WHERE RUNDOCK LOOKS FOR CLAUDE CODE, AND IN WHAT ORDER.
//
// A packaged app does not inherit the shell's PATH, so before the desktop app
// looks for `claude` it puts these folders at the front of PATH, in this order
// (ensurePath in electron/main.js). The lookup then takes the first `claude`
// on PATH (findClaude there, resolveClaudeBin in lib/runtime/claude.js).
//
// The list is written once, here. When the copy found is too old to start,
// the notice names these same folders, read from here (tooOldError in
// lib/runtime/claude-floor.js), so the folders a person is sent to are the
// folders the lookup searches.
const os = require('os');
const path = require('path');

/** @param {string} platform */
const pathFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);

/**
 * Where the native installer puts `claude`, on macOS, Linux and Windows
 * alike: the first folder searched.
 * @param {string} home
 * @param {string} [platform]
 */
function nativeInstallerFolder(home, platform = process.platform) {
  return pathFor(platform).join(home, '.local', 'bin');
}

/**
 * The folders, in the order they go on PATH.
 * @param {{ platform?: string, env?: Record<string, string|undefined>, home?: string }} [where]
 * @returns {string[]}
 */
function claudeFolders({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const p = pathFor(platform);
  if (platform === 'win32') {
    return [
      // Anthropic's PowerShell installer drops claude.exe here.
      nativeInstallerFolder(home, platform),
      // WinGet shim location.
      env.LOCALAPPDATA ? p.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links') : '',
      // npm global bin (Claude installed via `npm install -g`).
      env.APPDATA ? p.join(env.APPDATA, 'npm') : '',
    ].filter(Boolean);
  }
  return [nativeInstallerFolder(home, platform), p.join(home, '.claude', 'bin'), '/usr/local/bin', '/opt/homebrew/bin'];
}

/**
 * PATH with each of the folders it lacks put at its front, in order. A folder
 * PATH already holds keeps its place.
 * @param {string} current
 * @param {string[]} folders
 * @param {string} [delimiter]
 */
function withClaudeFolders(current, folders, delimiter = path.delimiter) {
  const segments = current.split(delimiter);
  const missing = folders.filter((d) => !segments.includes(d));
  return missing.length ? missing.join(delimiter) + delimiter + current : current;
}

module.exports = { claudeFolders, nativeInstallerFolder, withClaudeFolders };
