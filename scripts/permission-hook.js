#!/usr/bin/env node
/**
 * Rundock Permission Hook
 *
 * Runs as a Claude Code PreToolUse hook. When Claude wants to use a tool
 * that requires permission (e.g. Bash), this script:
 *
 * 1. POSTs the tool request to the Rundock server
 * 2. Rundock shows a permission card in the browser
 * 3. User clicks Allow or Deny
 * 4. This script receives the decision and tells Claude Code
 *
 * If not running inside Rundock (no RUNDOCK env var), passes through silently.
 * If the Rundock server is unreachable, allows by default to avoid blocking.
 */

const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

// One directory, several names. macOS keeps /tmp and /var as symlinks into
// /private, Dropbox and iCloud vaults are commonly reached through a symlink
// in ~/Documents, and the default filesystem is case-insensitive while
// preserving case, so the same inside file arrives here spelled many ways.
// Compared unresolved, every alternate spelling of an inside path reads as
// outside and cards, which is the false-positive half of the approval storm
// two field workspaces reported (one of them Dropbox-symlinked). So both
// sides of every comparison are canonicalised first.
//
// A target that does not exist yet cannot be resolved directly; it is judged
// by its nearest existing ancestor, canonicalised, with the unborn tail
// reattached. The same rule the reverting check uses for its run records,
// for the same reason: resolve alone does not follow links, and one place
// reached through two names must be one identity.
//
// Only real host paths are canonicalised. A Windows-shaped token judged on a
// non-Windows host (the test flavour) has no filesystem to ask, and on
// Windows itself the path module is already win32 and the flavour test is an
// identity.
function canonicalize(p, pmod = path) {
  const resolved = pmod.resolve(p);
  if (pmod === path.win32 && process.platform !== 'win32') return resolved;
  const tail = [];
  let cur = resolved;
  for (;;) {
    try {
      const real = fs.realpathSync.native ? fs.realpathSync.native(cur) : fs.realpathSync(cur);
      tail.reverse();
      return tail.length ? pmod.join(real, ...tail) : real;
    } catch (e) {
      const parent = pmod.dirname(cur);
      if (parent === cur) return resolved;
      tail.push(pmod.basename(cur));
      cur = parent;
    }
  }
}

// Paths whose standing grant means more than a folder. Version one carries
// the runtime's own home directory alone, structured as a table so the next
// entry is a row rather than a mechanism: a grant there exposes the account
// credential file and every project's transcripts on the machine, which the
// card must say, and the common legitimate need (this workspace's own
// transcripts) deserves a narrower grant than the whole folder.
function sensitivePaths(home = os.homedir()) {
  return [{ id: 'claude-home', root: path.join(home, '.claude') }];
}

// The transcripts folder for ONE workspace, derived rather than hardcoded:
// the runtime names each project folder by flattening the workspace path,
// and the scheme belongs to the installed runtime, not to this file. The
// transform (every character outside letters, digits and hyphen becomes a
// hyphen) was verified against the installed layout on 2026-09-03; when the
// projects directory already holds an entry for this workspace the derived
// name is trusted only if that entry exists, so a scheme drift makes the
// narrow offer vanish rather than grant the wrong folder.
function transcriptsDirFor(workspaceRoot, home = os.homedir()) {
  const flattened = path.resolve(workspaceRoot).replace(/[^A-Za-z0-9-]/g, '-');
  const projects = path.join(home, '.claude', 'projects');
  const derived = path.join(projects, flattened);
  try {
    const entries = fs.readdirSync(projects);
    return entries.includes(flattened) ? derived : null;
  } catch (e) { return null; }
}

// What a crossing into a sensitive path carries beyond its path: the table
// row's id, and the narrow grant when one can be derived. Attached in one
// place so the file-tool and shell paths cannot drift apart.
function sensitiveEnrichment(crossingPath, workspaceRoot, home = os.homedir()) {
  if (typeof crossingPath !== 'string' || !crossingPath) return null;
  const hit = sensitivePaths(home).find(sp => isUnder(canonicalize(crossingPath), canonicalize(sp.root)));
  if (!hit) return null;
  const narrow = transcriptsDirFor(workspaceRoot, home);
  return { sensitive: hit.id, ...(narrow ? { narrowGrantDir: narrow } : {}) };
}

// MCP read/write classification. Read-style MCP tools auto-approve; writes,
// destructive actions, and anything unrecognised get a permission card.
// Destructive verbs are checked first, so a name like `delete-after-search` can
// never auto-approve; read verbs are checked before defaulting to card, so a name
// like `API-post-search` (a search) is correctly treated as a read.
const MCP_DESTRUCTIVE_VERBS = new Set(['delete','remove','destroy','drop','cancel','abort','archive','trash','purge','clear','uninstall']);
const MCP_READ_VERBS = new Set(['get','list','search','find','read','fetch','retrieve','query','export','view','describe','show','info','overview','status','count','available','daily','review','recent','collaborators','comments','activity']);
function isMcpReadTool(toolName) {
  const action = String(toolName).split('__').slice(2).join('_');
  if (!action) return false;
  const tokens = action
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // split camelCase
    .split(/[_\-\s]+/)
    .map(t => t.toLowerCase())
    .filter(Boolean);
  if (tokens.some(t => MCP_DESTRUCTIVE_VERBS.has(t))) return false;
  if (tokens.some(t => MCP_READ_VERBS.has(t))) return true;
  return false;
}

// Deny a direct file edit to the GLOBAL Claude Code agent/skill config
// (~/.claude/agents, ~/.claude/skills). Rundock never reads the global folder,
// so such an edit would silently succeed somewhere invisible to the app: the
// reported bug where an agent "updated" and nothing changed, surviving a
// restart. Workspace .claude edits are deliberately NOT blocked (the workspace
// is the agent's own domain, and those land in the file the app reads); the
// SAVE_AGENT / SAVE_SKILL markers remain the way to get a live UI refresh.
const CLAUDE_EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
function isProtectedClaudeEdit(toolName, toolInput) {
  if (!CLAUDE_EDIT_TOOLS.has(toolName)) return false;
  const ti = toolInput || {};
  const target = ti.file_path || ti.notebook_path || ti.path;
  if (typeof target !== 'string') return false;
  const resolved = path.resolve(target);
  return isUnder(resolved, path.join(os.homedir(), '.claude', 'agents'))
      || isUnder(resolved, path.join(os.homedir(), '.claude', 'skills'));
}

// Workspace file-access boundary (spec: anything outside the workspace
// requires a permission card unless a standing per-workspace folder grant
// covers it; the server owns the grants). This function only CLASSIFIES:
// inside targets are allowed instantly with no server round-trip, outside
// targets flow to the permission card with the resolved path attached.
// Grep/Glob with no explicit path scan the working directory and are inside
// by construction. Symlinked escapes are not chased here (path resolution
// only). Shell commands reach outside too and are NOT handled here: see
// classifyShellAccess below, which also records why the sentence that used
// to sit in this comment, that Bash is carded on every call, was false in
// the mode where coding agents run.
const FILE_TOOL_PATH_FIELD = {
  Read: 'file_path', Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path', Glob: 'path', Grep: 'path',
};

// The two pieces every boundary decision in this file needs, in one place
// each. The prefix rule is the load-bearing detail: comparing with a bare
// startsWith would put `/ws-evil/x` inside `/ws`, so the separator has to be
// part of the comparison. It was written out three times before this and any
// one of them could have drifted alone.
//
// `pmod` is the path flavour to compare in. It is `path` for everything
// except a Windows-shaped token evaluated on a non-Windows host, which only
// happens in tests; on Windows `path` IS `path.win32`. Windows filesystems
// are case-insensitive, so a comparison there that respected case would call
// the same folder two different folders.
function isUnder(resolved, root, pmod = path) {
  const fold = (v) => (pmod === path.win32 ? v.toLowerCase() : v);
  const r = fold(resolved);
  const b = fold(root);
  return r === b || r.startsWith(b + pmod.sep);
}
function buildRoots(workspaceRoot, extraDirs = [], pmod = path) {
  return [canonicalize(workspaceRoot, pmod), ...extraDirs.map(d => canonicalize(d, pmod))];
}
function classifyFileAccess(toolName, toolInput, workspaceRoot, extraDirs = []) {
  const field = FILE_TOOL_PATH_FIELD[toolName];
  if (!field) return null;
  const ti = toolInput || {};
  const target = ti[field];
  if (typeof target !== 'string' || !target) {
    // Glob/Grep default to the working directory: inside by construction.
    // A path-less Write/Edit is malformed; let the generic card handle it.
    return (toolName === 'Glob' || toolName === 'Grep') ? { where: 'inside' } : null;
  }
  const resolvedPath = canonicalize(path.resolve(workspaceRoot, target));
  const inside = buildRoots(workspaceRoot, extraDirs).some(r => isUnder(resolvedPath, r));
  // The folder a standing grant would cover: the directory itself for the
  // directory-scanning tools, the parent directory for file targets.
  const grantDir = (toolName === 'Glob' || toolName === 'Grep') ? resolvedPath : path.dirname(resolvedPath);
  return { where: inside ? 'inside' : 'outside', resolvedPath, grantDir };
}

// The shell-command half of the same boundary.
//
// classifyFileAccess above covers the seven FILE tools. A shell command is
// none of them, so it returned null, and at the code-mode branch in main()
// null means auto-approve. The result was that in the mode where coding
// agents run, a command writing to the home directory raised NO card, while
// an Edit of the same file did. The comment that used to sit above
// FILE_TOOL_PATH_FIELD said Bash "is already carded on every call": true in
// knowledge mode, false in code mode, and it is code mode where this matters.
//
// The seam is SHELL COMMANDS, not Bash. On Windows the same commands run
// through the PowerShell tool (registered as its own matcher by
// lib/workspace/scaffold.js), and it was equally unclassified.
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

// TWO SIGNALS, AND THEY ARE NOT EQUALLY GOOD. Only the first is a guarantee.
//
// 1. dangerouslyDisableSandbox. When the spawned runtime's command sandbox is
//    on, a command it denies is retried with this flag, and the retry arrives
//    here. The operating system already decided, at syscall time, that the
//    command reached outside; no text was read to establish it. Measured
//    against the CLI on 2026-08-22 rather than assumed.
//
// 2. A path in the command text that resolves outside. Deciding what a shell
//    command writes by reading it is undecidable, so this is an ESCALATION
//    HEURISTIC and never a containment guarantee. It exists because the
//    sandbox does not cover every platform this product ships on, and a
//    partial answer beats silence there. What actually holds the line is
//    signal 1, and where signal 1 is unavailable the seam is stated in the
//    product copy instead of papered over here.
//
// WHY THIS NEVER RETURNS 'inside'. main() allows an 'inside' classification
// instantly with no server round-trip. Returning 'inside' for an ordinary
// command would therefore delete the Bash card knowledge mode shows today.
// A crossing is reported; everything else returns null and keeps whatever
// card it already had.
// Tokens IN SOURCE ORDER.
//
// A quoted segment is one token, because a path with a space in it is one
// path and splitting it on whitespace would resolve two wrong ones. Order
// matters beyond tidiness: the first crossing becomes the card's headline
// target, so collecting all the quoted segments first made a command whose
// second target happened to be quoted report that one as the first place it
// reaches.
function shellPathTokens(command) {
  const out = [];
  const re = /'([^']*)'|"([^"]*)"|[^\s;|&<>()`'"]+/g;
  let m;
  while ((m = re.exec(String(command))) !== null) {
    const t = m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[0]);
    if (!t) continue;
    out.push(t);
    // Also the value after the first `=`. Flag values (`--output=/etc/x`) and
    // shell assignments (`OUT=$HOME/x`) are the two commonest places a target
    // sits in plain sight inside a larger word. The whole token is kept too,
    // so nothing that used to be seen stops being seen; a value that is not
    // path-shaped falls out at the same filter everything else does.
    const eq = t.indexOf('=');
    if (eq > 0 && eq < t.length - 1) out.push(t.slice(eq + 1));
  }
  return out;
}

// Home shorthands, in the forms each shell actually writes them. PowerShell
// uses `~` and `$env:USERPROFILE`; cmd uses `%USERPROFILE%`; POSIX shells use
// `~` and `$HOME`. All of them resolve outside a workspace that is not itself
// the home directory, and none of them contain an absolute path, which is
// what makes them the forms a literal-path scan misses.
const HOME_PREFIX = [
  /^~(?=[\\/]|$)/,
  /^\$HOME(?=[\\/]|$)/,
  /^\$\{HOME\}(?=[\\/]|$)/,
  /^\$env:USERPROFILE(?=[\\/]|$)/i,
  /^\$\{env:USERPROFILE\}(?=[\\/]|$)/i,
  /^%USERPROFILE%(?=[\\/]|$)/i,
];

// Windows-shaped absolutes. A drive letter is not a relative path and never
// resolves under a POSIX workspace root, and a UNC name is not even this
// machine.
const WIN_DRIVE = /^[A-Za-z]:[\\/]/;
const WIN_UNC = /^\\\\[^\\]/;
// `..` as a whole segment, delimited by EITHER separator. Backslash matters:
// `..\..\elsewhere` climbs out exactly as `../../elsewhere` does, and is what
// a PowerShell agent writes.
const TRAVERSAL = /(^|[\\/])\.\.(?=[\\/]|$)/;

// Tokens that name something other than a place in the user's files.
//
// The null device and its siblings discard what is written to them, so a
// write there stores nothing anyone can read back; the executable lookup
// directories are where interpreters live and appear in a large share of
// ordinary commands, including inside every shebang line an agent writes into
// a script. Carding these would put a boundary card on ordinary work, and a
// card that fires on ordinary work is one people learn to click through,
// which costs more than it protects.
//
// This is an exemption from the TEXT heuristic only. On macOS the command
// sandbox still refuses a real write to any of them, and on Windows, where
// there is no sandbox, it is part of the seam the release notes state.
//
// Judged on the TOKEN, normalised with POSIX rules, rather than on the
// resolved path. These names are POSIX names: on a Windows host `path` is
// `path.win32`, so resolving `/dev/null` first would produce `C:\dev\null`
// and match nothing, and every Git Bash command containing `2>/dev/null`
// would raise a card. Normalising first is what keeps `/dev/../etc/hosts`
// out of the exemption: it is `/etc/hosts` and nothing is being discarded.
const DEVICE_PATHS = new Set(['/dev/null', '/dev/zero', '/dev/tty', '/dev/stdin', '/dev/stdout', '/dev/stderr', '/dev/random', '/dev/urandom']);
const EXEC_DIRS = ['/bin', '/sbin', '/usr/bin', '/usr/sbin', '/usr/local/bin', '/opt/homebrew/bin'];
function isExemptToken(token) {
  if (!token.startsWith('/')) return false;
  const norm = path.posix.normalize(token);
  if (DEVICE_PATHS.has(norm) || norm.startsWith('/dev/fd/')) return true;
  return EXEC_DIRS.some(d => isUnder(norm, d, path.posix));
}

// A URL is not a path, and unlike the filter below this one earns its place:
// `https://example.com/a/../../..` carries `..` segments, so it reaches the
// traversal test, resolves to somewhere above the workspace and produces a
// card naming a folder nobody is touching.
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

// Which path flavour to judge a token in. On Windows `path` is already
// `path.win32`, so this only ever differs on a non-Windows host judging a
// Windows-shaped token, which is what the tests do.
function flavourFor(token, workspaceRoot) {
  if (WIN_DRIVE.test(token) || WIN_UNC.test(token) || token.includes('\\')) return path.win32;
  if (WIN_DRIVE.test(workspaceRoot) || WIN_UNC.test(workspaceRoot)) return path.win32;
  return path;
}

// EVERY distinct target in the command that resolves outside, not the first.
//
// One reported path is not enough, because the server decides a standing
// folder grant against what it is handed. Given only the first, a command
// whose first target sits in an already-granted folder is allowed outright
// and a second target somewhere else rides along with no card at all.
function shellCrossings(command, workspaceRoot, extraDirs) {
  const found = [];
  const seen = new Set();
  for (const raw of shellPathTokens(command)) {
    let t = raw;
    let homed = false;
    for (const re of HOME_PREFIX) {
      if (re.test(t)) { t = t.replace(re, os.homedir()); homed = true; break; }
    }
    // Skip tokens that could not cross. A relative token resolves against the
    // workspace root and lands inside whatever it looks like, so a URL, a
    // compiler flag and a bare filename all fall out here without needing a
    // rule of their own. What must NOT fall out here is any Windows shape:
    // a drive letter and a backslash traversal both reach outside while
    // containing no leading forward slash and no `/`-delimited `..`.
    if (URL_SCHEME.test(t)) continue;
    if (isExemptToken(t)) continue;
    if (!homed && !t.startsWith('/') && !WIN_DRIVE.test(t) && !WIN_UNC.test(t) && !TRAVERSAL.test(t)) continue;
    const pmod = flavourFor(t, workspaceRoot);
    const resolved = canonicalize(pmod.resolve(pmod.resolve(workspaceRoot), t), pmod);
    if (buildRoots(workspaceRoot, extraDirs, pmod).some(r => isUnder(resolved, r, pmod))) continue;
    const key = pmod === path.win32 ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ path: resolved });
  }
  return found;
}

function classifyShellAccess(toolName, toolInput, workspaceRoot, extraDirs = []) {
  if (!SHELL_TOOLS.has(toolName)) return null;
  const ti = toolInput || {};
  // Signal 1. No grant folder is offered: a sandbox escape is not about one
  // folder, so "always allow this folder" would remember nothing.
  if (ti.dangerouslyDisableSandbox === true) {
    return { where: 'outside', resolvedPath: null, grantDir: null, grantable: false, crossings: [] };
  }
  // Signal 2.
  if (typeof ti.command !== 'string' || !ti.command) return null;
  const crossings = shellCrossings(ti.command, workspaceRoot, extraDirs);
  if (!crossings.length) return null;
  return { where: 'outside', resolvedPath: crossings[0].path, grantDir: null, grantable: false, crossings };
}

module.exports = { isProtectedClaudeEdit, isMcpReadTool, classifyFileAccess, classifyShellAccess, canonicalize, sensitivePaths, sensitiveEnrichment, transcriptsDirFor };

if (require.main === module) main();
function main() {
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  // Not running in Rundock: pass through (no decision, Claude Code handles normally)
  if (!process.env.RUNDOCK) {
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }

  let data;
  try {
    data = JSON.parse(input);
  } catch (e) {
    // Bad input: pass through
    process.stdout.write(JSON.stringify({}));
    process.exit(0);
  }

  // Workspace file-access boundary. Classified BEFORE the code-mode
  // short-circuit on purpose: code mode trusts commands inside the
  // workspace, it does not extend the workspace to the whole machine.
  const wsRoot = process.env.RUNDOCK_WORKSPACE || process.cwd();
  const extraDirs = (process.env.RUNDOCK_EXTRA_DIRS || '').split(path.delimiter).filter(Boolean);
  // File tools and shell commands are classified by the same boundary and
  // reach the same card. classifyShellAccess only ever answers 'outside' or
  // null, so an ordinary command keeps whatever card it already had: the
  // instant-allow branch below stays reachable only by file tools.
  const access = (typeof data.tool_name === 'string' && !isProtectedClaudeEdit(data.tool_name, data.tool_input))
    ? classifyFileAccess(data.tool_name, data.tool_input, wsRoot, extraDirs)
      || classifyShellAccess(data.tool_name, data.tool_input, wsRoot, extraDirs)
    : null;
  if (access && access.where === 'inside') {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'In-workspace file access'
      }
    }));
    process.exit(0);
  }

  // Code mode: auto-approve all commands (no permission card). Out-of-
  // workspace file access still cards above/below regardless of mode.
  if (process.env.RUNDOCK_CODE_MODE === '1' && !(access && access.where === 'outside')) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'Auto-approved: workspace is in Code mode'
      }
    }));
    process.exit(0);
  }

  // MCP tools are routed through the hook (not pre-approved via --allowed-tools).
  // Read-style MCP calls auto-approve here, server-side, so they work even when no
  // browser tab is actively connected and never block on the card timeout.
  // Write/destructive/unrecognised MCP calls fall through to the permission card.
  if (typeof data.tool_name === 'string' && data.tool_name.startsWith('mcp__') && isMcpReadTool(data.tool_name)) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'Auto-approved: MCP read'
      }
    }));
    process.exit(0);
  }

  // Agents and skills are managed ONLY through the RUNDOCK:SAVE_AGENT /
  // RUNDOCK:SAVE_SKILL markers, which write into THIS workspace's .claude folder
  // and refresh the UI. Deterministically deny any direct file edit to a
  // .claude/agents or .claude/skills path, in the workspace OR the global
  // ~/.claude (Claude Code's native default). Without this, a direct edit
  // silently succeeds in the wrong place: an edit to the global agents folder
  // that Rundock never reads, leaving the user told "done" while the workspace
  // file, and the profile panel, never changed. This is enforcement, not a
  // prompt: the wrong path can no longer look like a success.
  if (isProtectedClaudeEdit(data.tool_name, data.tool_input)) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: "This edits the global ~/.claude agent or skill config, which Rundock does not use. Manage this workspace's agents and skills through the RUNDOCK:SAVE_AGENT / RUNDOCK:SAVE_SKILL markers (which write into this workspace and refresh the app), or edit the workspace's own .claude file."
      }
    }));
    process.exit(0);
  }

  const port = process.env.RUNDOCK_PORT || 3000;
  const convoId = process.env.RUNDOCK_CONVO_ID || '';

  // Every crossing, enriched, with the sensitive ones stripped of their
  // whole-folder grantDir. PM-5: a crossing into a path the sensitive table
  // names must never be answerable from a standing grant over that whole
  // root, so the request this hook emits for one carries no grantable
  // whole-folder grant at all: the narrow grant (this same enrichment, when
  // one can be derived) stays the only standing-grant route left for it. The
  // top-level grant_dir below is read off crossings[0] rather than kept as a
  // second value, so the two can never say different things about the same
  // crossing.
  const boundaryCrossings = (access && access.where === 'outside')
    ? (access.crossings || [{ path: access.resolvedPath, grantDir: access.grantDir }])
        .map(c => {
          const enrichment = sensitiveEnrichment(c.path, wsRoot) || {};
          return enrichment.sensitive
            ? { ...c, grantDir: null, ...enrichment }
            : { ...c, ...enrichment };
        })
    : [];

  const payload = JSON.stringify({
    tool_name: data.tool_name,
    tool_input: data.tool_input || {},
    session_id: data.session_id,
    conversation_id: convoId,
    ...(access && access.where === 'outside'
      ? {
          boundary: true,
          resolved_path: access.resolvedPath || null,
          grant_dir: (boundaryCrossings[0] && boundaryCrossings[0].grantDir) || null,
          // WHETHER A STANDING FOLDER GRANT MAY ANSWER THIS AT ALL.
          //
          // False for every shell command. A folder grant and a command
          // approval answer different questions: the grant says an agent may
          // touch that folder, and a shell card says this command may run.
          // The second cannot be inferred from the first, because everything
          // in the command runs, not only the part that touches the granted
          // folder. Letting a grant answer a command would retire the
          // per-command card that already exists, which is the opposite of
          // what this boundary is for.
          //
          // NOT the whole-folder gate for a sensitive crossing: that is
          // decided per crossing above (grantDir stripped), because this
          // flag also has to stay true for a non-sensitive crossing, and for
          // a sensitive one whose narrow grant should still be able to
          // silence a later, in-scope request.
          grantable: access.grantable !== false,
          // Every crossing, so the server can refuse to answer from a
          // standing grant unless EVERY one is covered. A file tool has
          // exactly one; a shell command can have several; a sandbox escape
          // has none, because no path established it. Always sent, so the
          // server never has to reconstruct it: this is the only producer of
          // boundary requests in the product.
          crossings: boundaryCrossings,
        }
      : {})
  });

  const req = http.request({
    hostname: '127.0.0.1',
    port: port,
    path: '/api/permission-request',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    },
    timeout: 300000 // 5 min: server-side timeout (120s) handles the real cutoff
  }, res => {
    let body = '';
    res.on('data', chunk => { body += chunk; });
    res.on('end', () => {
      try {
        const result = JSON.parse(body);
        let reason = 'Approved in Rundock';
        if (!result.allow) {
          reason = result.reason === 'timeout'
            ? 'The permission request was not completed within the time limit. Try the command again if it is still needed.'
            : 'This command was not approved. Acknowledge and move on.';
        }
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: result.allow ? 'allow' : 'deny',
            permissionDecisionReason: reason
          }
        }));
      } catch (e) {
        // Parse error: allow to avoid blocking
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            permissionDecisionReason: 'Rundock hook: could not parse server response'
          }
        }));
      }
      process.exit(0);
    });
  });

  req.on('error', () => {
    // Server unreachable: allow to avoid blocking the user
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'Rundock server unreachable, allowing by default'
      }
    }));
    process.exit(0);
  });

  req.on('timeout', () => {
    req.destroy();
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'The permission request was not completed within the time limit. Try the command again if it is still needed.'
      }
    }));
    process.exit(0);
  });

  req.write(payload);
  req.end();
});
}
