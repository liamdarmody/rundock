'use strict';
// Keeping MCP credentials out of the file a team shares.
//
// THE PROBLEM. `.mcp.json` sits at the workspace root, and MCP servers
// commonly take an API key as a literal value inside it. The workspace folder
// is the unit of sharing, so that file travels on every sync option. Git is
// the sharp end: nothing excludes `.mcp.json` the way the setup step excludes
// `.rundock/`, so the key reaches every clone AND sits in history from the
// first commit, where deleting the file later does not remove it. The only
// mitigation Rundock had was a sentence in the documentation telling people to
// keep secret-bearing servers out of the shared file, which is advice rather
// than a mechanism, and which asks the user to already know which of their
// servers take a credential.
//
// THE SPLIT. The shared, git-tracked `.mcp.json` keeps what the team needs to
// agree on: which servers exist, what command runs them, what arguments they
// take. The values that must not be shared move to
// `.rundock/mcp-secrets.json`, keyed by server name. `.rundock/` is already
// gitignored by the setup step, so the per-user file inherits an exclusion
// that exists and is tested, rather than needing a third mechanism of its own.
// The two are merged for the length of one spawn into
// `.rundock/mcp-runtime.json`, which is what `--mcp-config` is pointed at.
//
// WHY A MERGED FILE RATHER THAN THE ENVIRONMENT. Claude Code expands `${VAR}`
// inside `.mcp.json`, so injecting the values into the spawn environment would
// also work and would need no file. It was rejected: the environment of the
// spawned process is inherited by EVERY child it starts, which is every other
// MCP server and every shell command an agent runs. That would take a
// credential that one server process can see today and show it to all of them.
// A merged config file keeps each value in the server entry that needs it.
//
// WHY NOT AN INLINE `--mcp-config` STRING. The flag accepts JSON directly,
// which would keep the merged form off disk entirely. It would also put every
// credential in the process command line, which on Linux any local user can
// read out of /proc. A file with owner-only permissions is the better of the
// two exposures.
//
// PRECEDENCE, MEASURED RATHER THAN ASSUMED. Claude Code also discovers the
// workspace's own `.mcp.json` from the working directory, so a server named in
// both that file and `--mcp-config` has two definitions. Measured against
// claude 2.1.245 with the project scope explicitly enabled: the `--mcp-config`
// entry is the one that starts, and only one process starts. The merged file
// therefore wins over the stripped copy sitting in the workspace. Everything
// here depends on that, so it was measured rather than reasoned about.
//
// COMPATIBILITY. A workspace with no secrets file, or one whose secrets name
// no server the shared file declares, gets the `.mcp.json` PATH ITSELF back,
// so its spawn is unchanged rather than merely equivalent. A literal
// credential left in `.mcp.json` keeps working exactly as before: this adds a
// safer place to put values and never requires the move.
const fs = require('fs');
const path = require('path');

// The per-user file the user (or a future settings panel) writes, and the
// merged form Rundock generates. Both live in `.rundock/`, which the setup
// step gitignores.
const SECRETS_FILENAME = 'mcp-secrets.json';
const RUNTIME_FILENAME = 'mcp-runtime.json';

// The only fields a per-user file may contribute. Deliberately narrow: these
// are where credentials live, and nothing else is a credential. Allowing
// `command` or `args` would let a file decide what binary runs, which is a
// different power from supplying a key and one this feature has no reason to
// hand out.
const CREDENTIAL_FIELDS = ['env', 'headers'];

// Keys that reach the prototype chain when assigned onto a plain object.
// JSON.parse makes these own properties rather than acting on them, so they
// arrive here intact and are dropped rather than copied through.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function mcpSecretsPath(dir) {
  return dir ? path.join(dir, '.rundock', SECRETS_FILENAME) : null;
}

function mcpRuntimeConfigPath(dir) {
  return dir ? path.join(dir, '.rundock', RUNTIME_FILENAME) : null;
}

function mcpSharedConfigPath(dir) {
  return dir ? path.join(dir, '.mcp.json') : null;
}

// A JSON object from a file, or null on any problem: no file, unreadable,
// unparseable, or parsing to something that is not a plain object. Every
// caller here treats "no answer" and "a bad answer" the same way, so they are
// not distinguished.
function readJsonObject(file) {
  if (!file) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

// An own, safely-named property, or null. Used for every lookup driven by a
// name that came out of a file.
function ownProperty(obj, key) {
  if (!obj || typeof obj !== 'object' || UNSAFE_KEYS.has(key)) return null;
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return null;
  return obj[key];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The per-user credentials for a workspace, keyed by MCP server name.
 * Returns {} on any problem, so a missing or damaged file degrades to "no
 * overrides" rather than stopping a spawn.
 *
 * @param {string|null} dir workspace root
 */
function readMcpSecrets(dir) {
  return readJsonObject(mcpSecretsPath(dir)) || {};
}

/**
 * The shared config with per-user credential values merged in.
 *
 * Merges rather than replaces: a server's `env` in the shared file keeps every
 * key the per-user file does not name, so non-secret settings can stay where
 * the team can see them. Servers the shared file does not declare are ignored,
 * which keeps `.mcp.json` the single answer to which servers a workspace has.
 * The input is never mutated.
 *
 * @param {object} baseConfig parsed `.mcp.json`
 * @param {object} secrets parsed `.rundock/mcp-secrets.json`
 * @returns {{ config: object, servers: string[] }} the merged config and the
 *   names of the servers that actually received a value
 */
function mergeMcpConfig(baseConfig, secrets) {
  const servers = isPlainObject(baseConfig) ? baseConfig.mcpServers : null;
  if (!isPlainObject(servers)) return { config: baseConfig, servers: [] };

  const applied = [];
  const merged = {};
  for (const name of Object.keys(servers)) {
    const entry = servers[name];
    const override = ownProperty(secrets, name);
    let next = entry;

    if (isPlainObject(entry) && isPlainObject(override)) {
      for (const field of CREDENTIAL_FIELDS) {
        const values = ownProperty(override, field);
        if (!isPlainObject(values)) continue;
        const base = isPlainObject(entry[field]) ? entry[field] : {};
        const combined = { ...base };
        let touched = false;
        for (const key of Object.keys(values)) {
          if (UNSAFE_KEYS.has(key)) continue;
          // Only strings: an MCP env value is a string, and anything else
          // arriving here is a malformed file rather than a credential.
          if (typeof values[key] !== 'string') continue;
          combined[key] = values[key];
          touched = true;
        }
        if (!touched) continue;
        if (next === entry) next = { ...entry };
        next[field] = combined;
      }
    }

    if (next !== entry) applied.push(name);
    merged[name] = next;
  }
  return { config: { ...baseConfig, mcpServers: merged }, servers: applied };
}

// Remove a merged file left by an earlier run. Called whenever no secret
// applies: the file holds credentials, so leaving a stale one behind would
// keep a copy alive after the user removed the source.
function discardRuntimeConfig(file) {
  if (!file) return;
  try { fs.rmSync(file, { force: true }); } catch (e) { /* best effort */ }
}

// Replace the merged file WITHOUT ever exposing a partial one.
//
// The path is resolved again on every spawn, so this rewrites a file that
// agents started moments earlier may still be opening, and two Rundocks on one
// synced workspace can reach it at the same instant. Writing in place truncates
// first, so a reader landing in that window would see an empty or half-written
// config and start with no MCP servers rather than failing outright. Writing a
// new file and renaming it over the old one means the path always names a
// complete config: a reader holding the previous file keeps reading it.
//
// The temporary name carries the process id and a counter so two writers never
// pick the same one, which would trade this race for a smaller one between the
// temporary files themselves. Permissions are set on the temporary file, before
// it is ever reachable under the real name.
let tempCounter = 0;
function writeRuntimeConfigAtomically(file, contents) {
  const temp = `${file}.${process.pid}.${++tempCounter}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, contents, { mode: 0o600 });
    // writeFileSync's mode applies on creation only. Setting it explicitly
    // covers a temporary name that somehow already existed.
    try { fs.chmodSync(temp, 0o600); } catch (e) { /* Windows has no POSIX mode */ }
    fs.renameSync(temp, file);
    return true;
  } catch (e) {
    try { fs.rmSync(temp, { force: true }); } catch (e2) { /* best effort */ }
    return false;
  }
}

/**
 * The path to hand to `--mcp-config` for a workspace, or null when the
 * workspace has no MCP config at all.
 *
 * Returns the shared `.mcp.json` path unchanged unless a per-user secret
 * actually applies to a declared server. When one does, writes the merged form
 * to `.rundock/mcp-runtime.json` with owner-only permissions and returns that.
 *
 * A failed write falls back to the shared path rather than refusing to spawn:
 * the agent then starts with whatever `.mcp.json` holds, and a server missing
 * its key fails loudly at the server, which is a better outcome than no agent.
 *
 * @param {string|null} dir workspace root
 * @returns {string|null}
 */
function resolveMcpConfigPath(dir) {
  const sharedPath = mcpSharedConfigPath(dir);
  if (!sharedPath || !fs.existsSync(sharedPath)) return null;

  const runtimePath = mcpRuntimeConfigPath(dir);
  const base = readJsonObject(sharedPath);
  const { config, servers } = base
    ? mergeMcpConfig(base, readMcpSecrets(dir))
    : { config: null, servers: [] };

  if (!servers.length) {
    discardRuntimeConfig(runtimePath);
    return sharedPath;
  }

  const written = writeRuntimeConfigAtomically(runtimePath, `${JSON.stringify(config, null, 2)}\n`);
  return written ? runtimePath : sharedPath;
}

module.exports = {
  SECRETS_FILENAME, RUNTIME_FILENAME, CREDENTIAL_FIELDS,
  mcpSecretsPath, mcpRuntimeConfigPath, mcpSharedConfigPath,
  readMcpSecrets, mergeMcpConfig, resolveMcpConfigPath,
};
