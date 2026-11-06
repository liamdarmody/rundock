'use strict';
// WHICH CLAUDE CODE RUNDOCK STARTS, and what version it says it is.
//
// The version read the floor uses (lib/runtime/claude-floor.js says why there
// is a floor) lives here, so the lookup that finds Claude Code can read the
// copies it finds with it.
const fs = require('fs');
const path = require('path');
const codexRuntime = require('../../codex.js');

// What `claude --version` printed, or null when it failed, ran past the
// timeout, or could not be run. The binary is run itself, never through a
// shell, so nothing in the path it was found at (a quote, a `$(...)`) is read
// as part of a command. Stdin closed (PROBE_STDIO): on Windows a probe
// against an open piped stdin can hang for its full timeout.
//
// A Windows .cmd or .bat runs only through a shell (Node refuses to start one
// without it), so it is never run here. It is what an npm install puts on
// PATH, `%APPDATA%\npm\claude.cmd`, and npm installs the package it starts
// beside it, so its version is read from that package's package.json. With
// no such package, or one that does not parse or names no version, the
// version is unknown, and the spawn goes ahead as before, logged once
// (floorRefusal in lib/runtime/claude.js).
const VERSION_PROBE_TIMEOUT_MS = 5000;
const NPM_PACKAGE_JSON = ['node_modules', '@anthropic-ai', 'claude-code', 'package.json'];
function launcherPackageVersion(bin) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(bin), ...NPM_PACKAGE_JSON), 'utf-8'));
    return pkg && typeof pkg.version === 'string' ? pkg.version : null;
  } catch (e) { return null; }
}
function readClaudeVersion(bin, timeout = VERSION_PROBE_TIMEOUT_MS, platform = process.platform) {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) return launcherPackageVersion(bin);
  try {
    const { execFileSync } = require('child_process');
    return execFileSync(bin, ['--version'], { timeout, encoding: 'utf-8', stdio: codexRuntime.PROBE_STDIO });
  } catch (e) { return null; }
}

module.exports = { readClaudeVersion, VERSION_PROBE_TIMEOUT_MS };
