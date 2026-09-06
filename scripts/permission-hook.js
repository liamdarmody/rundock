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
function canonicalize(p, pmod = path, foldsCase) {
  const resolved = pmod.resolve(p);
  if (pmod === path.win32 && process.platform !== 'win32') return resolved;
  // `foldsCase`: a DEFAULTED SEAM (undefined in production); a test drives both kinds by hand.
  if (foldsCase !== undefined) return canonicalizeCaseSimulated(resolved, foldsCase);
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

// Walks a resolved POSIX path segment by segment; a miss folds to a
// case-insensitive sibling only when `foldsCase` says so. No symlinks.
function canonicalizeCaseSimulated(resolved, foldsCase) {
  const segments = resolved.split(path.sep).filter(Boolean);
  let cur = path.sep;
  for (const seg of segments) {
    let entries = [];
    try { entries = fs.readdirSync(cur); } catch (e) { /* unresolved from here on */ }
    const real = entries.includes(seg) ? seg : ((foldsCase && entries.find(e => e.toLowerCase() === seg.toLowerCase())) || seg);
    cur = path.join(cur, real);
  }
  return cur;
}

// ── The agent's own folder: three tiers, one registry ──────────────────
// `~/.claude` holds things of very different value; carding every write
// under it cards routine scratch too (a page cache, task output). The
// reason to card is PERSISTENCE, not location: is the target named by the
// secrets registry (cards on any access), or does it sit under a
// persistence surface (cards on a write, free to read)? Everything else is
// free both ways, reads and scratch alike. ARCHITECTURE.md names every
// entry below; a doc/registry binding test (workspace-boundary.test.js)
// fails if either drifts, and nowhere else may decide either question with
// a literal of its own.
const SECRET_RELATIVE_PATHS = ['.credentials.json'];
// Directories match their whole subtree; the file matches only at the
// folder root, not a same-named file nested somewhere already free.
const PERSISTENCE_SURFACE_DIRS = ['agents', 'skills', 'plugins', 'commands', 'hooks'];
const PERSISTENCE_SURFACE_FILES = ['settings.json'];
// Shell commands known to only read, never write, when invoked alone. Used
// ONLY to re-grade a crossing under the runtime's OWN home (see
// isReadOnlyShellCommand below): a shell command cannot declare which act it
// performs, so this is the one place that infers a read from the command
// text rather than from which tool was called. FAIL SAFE: a command not
// entirely built from this list is never treated as read-only, whatever it
// is. Outside the runtime's home this registry is never consulted at all;
// the existing text-heuristic crossing detection is unaffected.
const READ_ONLY_SHELL_COMMANDS = [
  'ls', 'cat', 'head', 'tail', 'find', 'grep', 'rg', 'wc', 'file', 'stat',
  'realpath', 'basename', 'dirname', 'echo', 'pwd', 'tree', 'du',
];

// canonicalize only folds case for path components that already exist: an
// unborn target realpaths its nearest existing ancestor and reattaches the
// remaining components verbatim, spelling and all. On a filesystem that
// folds case, a registry folder that has not been created yet (a first
// write to `~/.claude/Hooks/pretool.sh` before `hooks/` exists) then
// canonicalises to a path whose tail is spelled `Hooks`, which a
// case-sensitive string comparison against the registry's `hooks` entry
// never matches, so the write is classified as free scratch and lands in
// the very folder the runtime reads as `hooks/`.
//
// Whether the host folds case is a property of the filesystem, not
// reliably inferable from `process.platform` alone (a case-sensitive APFS
// volume exists), but the default filesystem on macOS and Windows folds
// case while the default on Linux does not, and no installation this
// registry has to protect runs the exception. `platform` is a DEFAULTED
// SEAM, the same shape as every other injectable seam in this file:
// production never passes it, and a test drives either filesystem kind
// explicitly on any host, rather than asking the real filesystem and
// letting its answer choose which assertion runs.
function hostFoldsCase(platform = process.platform) {
  return platform === 'darwin' || platform === 'win32';
}
function foldCase(v, foldsCase) {
  return foldsCase ? v.toLowerCase() : v;
}

function agentHomeRoot(home = os.homedir()) {
  return canonicalize(path.join(home, '.claude'));
}
function secretsRegistry(home = os.homedir()) {
  const root = agentHomeRoot(home);
  return SECRET_RELATIVE_PATHS.map(p => path.join(root, p));
}
function isSecretPath(candidate, home = os.homedir(), foldsCase = hostFoldsCase()) {
  if (typeof candidate !== 'string' || !candidate) return false;
  const c = foldCase(canonicalize(candidate), foldsCase);
  return secretsRegistry(home).some(p => c === foldCase(canonicalize(p), foldsCase));
}
function isPersistenceSurface(candidate, home = os.homedir(), foldsCase = hostFoldsCase()) {
  if (typeof candidate !== 'string' || !candidate) return false;
  const c = foldCase(canonicalize(candidate), foldsCase);
  const root = agentHomeRoot(home);
  if (PERSISTENCE_SURFACE_FILES.some(f => c === foldCase(canonicalize(path.join(root, f)), foldsCase))) return true;
  return PERSISTENCE_SURFACE_DIRS.some(d => {
    const dir = foldCase(canonicalize(path.join(root, d)), foldsCase);
    return c === dir || c.startsWith(dir + path.sep);
  });
}
// Every tag a crossing carries, computed once so the file-tool and
// shell-command paths read the same three answers.
function agentHomeTags(resolvedPath, home = os.homedir(), foldsCase = hostFoldsCase()) {
  const agentHome = isUnder(resolvedPath, agentHomeRoot(home));
  return agentHome
    ? { agentHome: true, secret: isSecretPath(resolvedPath, home, foldsCase), persistenceSurface: isPersistenceSurface(resolvedPath, home, foldsCase) }
    : { agentHome: false, secret: false, persistenceSurface: false };
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
// The refusal's own names, for a test to bind to mechanically.
const REFUSED_CLAUDE_EDIT_DIRS = ['agents', 'skills'];
// ONE COMPARISON, OR THE TWO ANSWERS DISAGREE. This refusal and the tier
// classifier below both decide what a path under the runtime's home is, and
// they must decide it the same way. Comparing raw text here while the
// classifier canonicalises and folds case let a spelling slip between them:
// on a case-folding filesystem a write to `.claude/Agents/x.md` missed this
// refusal, fell through to the classifier, and was offered as an ordinary
// approvable card. Approving it wrote into `.claude/agents/`, the folder the
// app never reads, which is the very outcome refusing exists to prevent. So
// the same canonicalisation, the same folding, and the same defaulted seams
// as the classifier: a variant spelling, a symlinked home and a target whose
// folder does not exist yet all reach the same answer here as they do there.
function isProtectedClaudeEdit(toolName, toolInput, home = os.homedir(), foldsCase = hostFoldsCase()) {
  if (!CLAUDE_EDIT_TOOLS.has(toolName)) return false;
  const ti = toolInput || {};
  const target = ti.file_path || ti.notebook_path || ti.path;
  if (typeof target !== 'string') return false;
  const c = foldCase(canonicalize(path.resolve(target)), foldsCase);
  const root = agentHomeRoot(home);
  return REFUSED_CLAUDE_EDIT_DIRS.some(d => {
    const dir = foldCase(canonicalize(path.join(root, d)), foldsCase);
    return c === dir || c.startsWith(dir + path.sep);
  });
}

// A PERSISTENCE-SURFACE WRITE UNDER THE RUNTIME'S OWN HOME IS REFUSED, NOT
// CARDED. Measured against the runtime rather than assumed: writes were
// attempted at eight paths under `~/.claude` and judged by the transcript's
// own error text and by whether a file appeared afterwards, not by asking a
// model what had happened. Every one came back "which is a sensitive file"
// and none was written. A path in the home directory but outside `.claude`
// came back with the ordinary "you haven't granted it yet".
//
// So Rundock cannot approve past the runtime here, and a card offering
// "Approve" and "Approve always" is a promise the product cannot keep: the
// reported experience was approving one and being refused anyway, which
// teaches the user that the card means nothing. `agents/` and `skills/` were
// already refused for a different reason; this extends the same treatment to
// the rest of the surface tier for this one.
//
// SCOPED DELIBERATELY, and the three exclusions matter more than the rule:
//   - Reads are untouched. Listing and reading the global agents and skills
//     is the capability the freeing tier exists to give.
//   - The secrets tier is untouched, so `.credentials.json` still CARDS on
//     every access, read and write, in both modes, exactly as documented. A
//     write there being refused by the runtime anyway is not reason enough to
//     weaken the one guarantee that says nothing silences that card.
//   - Free scratch (`projects/`, `cache/`, `tasks/`) is untouched. Rundock
//     offers no card there, so there is no false promise to withdraw.
// The workspace's own `.claude` is not this folder and is never covered:
// agents, skills, routines, connectors and their credentials all live in the
// workspace, which is where the product reads them from.
function isRuntimeHomeSurfaceEdit(toolName, toolInput, home = os.homedir(), foldsCase = hostFoldsCase()) {
  if (!CLAUDE_EDIT_TOOLS.has(toolName)) return false;
  const ti = toolInput || {};
  const target = ti.file_path || ti.notebook_path || ti.path;
  if (typeof target !== 'string') return false;
  const resolved = canonicalize(path.resolve(target));
  // NO SECRETS-TIER PATH REACHES THIS, and the reason is a property of the
  // registries rather than a check here: the secrets registry names a file at
  // the runtime home root, and no persistence surface covers that root, so
  // `isPersistenceSurface` is already false for every secret. A defensive
  // `isSecretPath` guard stood here and was removed because nothing could make
  // it fire, and an unreachable guard reads as protection that is not there.
  // The non-overlap is asserted directly instead, so an addition that broke it
  // would fail a test rather than silently convert a secrets card into a
  // refusal.
  return isPersistenceSurface(resolved, home, foldsCase);
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
// Read-only tools, since a persistence surface's tier depends on whether
// the access is a read or a write (see agentHomeTags above).
const READ_FILE_TOOLS = new Set(['Read', 'Glob', 'Grep']);

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
// `home` and `foldsCase` are defaulted seams so a test can pass a fixture
// home instead of monkey-patching os.homedir(), and drive either filesystem
// kind explicitly instead of inheriting whichever the test host happens to
// have; production never passes either.
function classifyFileAccess(toolName, toolInput, workspaceRoot, extraDirs = [], home = os.homedir(), foldsCase = hostFoldsCase(), resolvedPathFoldsCase) {
  const field = FILE_TOOL_PATH_FIELD[toolName];
  if (!field) return null;
  const ti = toolInput || {};
  const target = ti[field];
  if (typeof target !== 'string' || !target) {
    // Glob/Grep default to the working directory: inside by construction.
    // A path-less Write/Edit is malformed; let the generic card handle it.
    return (toolName === 'Glob' || toolName === 'Grep') ? { where: 'inside' } : null;
  }
  // Separate seam from `foldsCase` above; stays undefined in production.
  const resolvedPath = canonicalize(path.resolve(workspaceRoot, target), path, resolvedPathFoldsCase);
  const inside = buildRoots(workspaceRoot, extraDirs).some(r => isUnder(resolvedPath, r));
  if (inside) return { where: 'inside', resolvedPath };
  // The agent's own folder: free unless the registry names this exact
  // access as a secret (always) or a write to a persistence surface.
  const tags = agentHomeTags(resolvedPath, home, foldsCase);
  const isWrite = !READ_FILE_TOOLS.has(toolName);
  if (tags.agentHome && !tags.secret && !(isWrite && tags.persistenceSurface)) {
    return { where: 'inside', resolvedPath };
  }
  // The folder a standing grant would cover (never a secrets-tier crossing):
  // the directory itself for the directory-scanning tools, the parent for a file.
  const grantDir = (toolName === 'Glob' || toolName === 'Grep') ? resolvedPath : path.dirname(resolvedPath);
  // `settings.json` is the one persistence-surface entry that is a FILE
  // rather than a folder, so the "grant directory" beside it is not a
  // sub-folder of the runtime home, it IS the runtime home root. Offering a
  // whole-folder grant there would silence every later write to agents/,
  // skills/, plugins/, commands/ and hooks/ too: the wide-grant shape this
  // release removed, reappearing through the one crossing that does not fit
  // the folder-shaped assumption behind grantDir. No standing grant is
  // offered for the runtime home root itself, exactly as the secrets tier
  // already refuses one for any folder.
  const noGrant = tags.secret || (tags.agentHome && grantDir === agentHomeRoot(home));
  return { where: 'outside', resolvedPath, grantDir: noGrant ? null : grantDir, ...tags };
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

// Splits a command into its top-level segments on the separators a shell
// actually uses to run more than one thing (`;`, `&&`, `||`, a pipe), aware
// of quoting so a separator character inside a quoted string is not one.
// Order does not matter here (unlike shellPathTokens): every segment must
// qualify for the command to be read-only, so which one is checked first
// changes nothing about the answer.
function shellSegments(command) {
  const segments = [];
  let cur = '';
  let quote = null;
  const str = String(command);
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if ((ch === '&' && str[i + 1] === '&') || (ch === '|' && str[i + 1] === '|')) {
      segments.push(cur); cur = ''; i++; continue;
    }
    // A LONE `&` JOINS TWO COMMANDS TOO. It backgrounds what precedes it and
    // runs what follows, so `ls x & rm -rf x` is two commands exactly as
    // `ls x && rm -rf x` is. Passing it through as ordinary text left the whole
    // line judged by its leading word, so the removal rode in free on the `ls`.
    // `&&` is consumed above, so any `&` reaching here is the single form; a
    // trailing one yields an empty segment, which carries nothing to
    // disqualify and leaves a backgrounded read a read.
    if (ch === ';' || ch === '|' || ch === '&') { segments.push(cur); cur = ''; continue; }
    cur += ch;
  }
  segments.push(cur);
  return segments;
}

// Whether a shell command, taken as a whole, only reads. Used ONLY to
// re-grade an agent-home crossing that would otherwise card because it
// touches a persistence surface (see shellCrossings): the tier itself is
// unaffected, and a secrets-registry crossing is never re-graded regardless
// of this answer.
//
// FAIL SAFE, both ways at once:
// - Any write-shaped redirection (`>`, `>>`) or a `tee` invocation anywhere
//   in the command disqualifies the WHOLE command, because which stream a
//   redirection targets is not decidable from text alone, and echo alone is
//   only harmless without one (`echo x > ~/.claude/hooks/y` still writes).
// - EVERY segment must lead with a word this registry names. One
//   unrecognised leading word (an env assignment, a subshell, a command not
//   on the list) fails the whole command, not just that segment: a
//   compound like `ls ~/.claude/agents && rm -rf ~/.claude/agents/x` must
//   still card, and it does because `rm` is not in the registry.
// A redirection that cannot create or modify a file: output thrown away at
// /dev/null, or a file descriptor duplicated onto another (`2>&1`). Stripped
// before the write test below because the test reads the whole command string
// and cannot otherwise tell a discard from a write. MEASURED: a plain
// `ls ~/.claude/agents 2>/dev/null` was graded a WRITE to a persistence
// surface on the strength of that one `>`, and carded as "writing here
// persists" for a command that writes nothing.
//
// EXHAUSTIVE BY INTENT. Only these two shapes are exempt, because only these
// two provably reach no path. Every other target is a real file, including
// one inside the surface itself, so the fail-safe direction is unchanged.
const DISCARDING_REDIRECT_RE = /\d*>>?\s*(?:\/dev\/null|&\s*\d+)/g;

function isReadOnlyShellCommand(command) {
  const str = String(command).replace(DISCARDING_REDIRECT_RE, ' ');
  if (/>>?|\btee\b/.test(str)) return false;
  const segments = shellSegments(str);
  return segments.length > 0 && segments.every(seg => {
    const trimmed = seg.trim();
    if (!trimmed) return true; // an empty segment (trailing separator) carries nothing to disqualify it
    const word = (trimmed.match(/^(\S+)/) || [])[1] || '';
    const bare = word.includes('/') ? word.slice(word.lastIndexOf('/') + 1) : word;
    return READ_ONLY_SHELL_COMMANDS.includes(bare);
  });
}

// EVERY distinct target in the command that resolves outside, not the first.
//
// One reported path is not enough, because the server decides a standing
// folder grant against what it is handed. Given only the first, a command
// whose first target sits in an already-granted folder is allowed outright
// and a second target somewhere else rides along with no card at all.
function shellCrossings(command, workspaceRoot, extraDirs, home = os.homedir(), foldsCase = hostFoldsCase()) {
  const found = [];
  const seen = new Set();
  // Computed once for the whole command, not per token: whether it may read
  // a persistence surface under the runtime's OWN home free is a property of
  // the command as a whole (see isReadOnlyShellCommand), never of one target
  // in isolation.
  const readOnly = isReadOnlyShellCommand(command);
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
    // Tier three (neither secret nor a persistence surface) is free, so it
    // is not reported at all. A command cannot declare which act it
    // performs, so a persistence surface is conservatively treated as a
    // write here UNLESS the command is built entirely from read-only
    // commands (isReadOnlyShellCommand above), in which case it is free too,
    // exactly as a Read/Glob/Grep of the same path already is via
    // classifyFileAccess. The secrets tier is never re-graded this way: it
    // cards on any access, read or write, regardless of what the command is.
    const tags = agentHomeTags(resolved, home, foldsCase);
    if (tags.agentHome && !tags.secret && (!tags.persistenceSurface || readOnly)) continue;
    const key = pmod === path.win32 ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ path: resolved, ...tags });
  }
  return found;
}

function classifyShellAccess(toolName, toolInput, workspaceRoot, extraDirs = [], home = os.homedir(), foldsCase = hostFoldsCase()) {
  if (!SHELL_TOOLS.has(toolName)) return null;
  const ti = toolInput || {};
  // Signal 1. No grant folder is offered: a sandbox escape is not about one
  // folder, so "always allow this folder" would remember nothing.
  if (ti.dangerouslyDisableSandbox === true) {
    return { where: 'outside', resolvedPath: null, grantDir: null, grantable: false, crossings: [] };
  }
  // Signal 2.
  if (typeof ti.command !== 'string' || !ti.command) return null;
  const crossings = shellCrossings(ti.command, workspaceRoot, extraDirs, home, foldsCase);
  if (!crossings.length) return null;
  return { where: 'outside', resolvedPath: crossings[0].path, grantDir: null, grantable: false, crossings };
}

module.exports = {
  isProtectedClaudeEdit, isRuntimeHomeSurfaceEdit, isMcpReadTool, classifyFileAccess, classifyShellAccess, canonicalize,
  isSecretPath, isPersistenceSurface, SECRET_RELATIVE_PATHS, PERSISTENCE_SURFACE_DIRS, PERSISTENCE_SURFACE_FILES,
  REFUSED_CLAUDE_EDIT_DIRS, READ_ONLY_SHELL_COMMANDS, isReadOnlyShellCommand,
};

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

  const wsRoot = process.env.RUNDOCK_WORKSPACE || process.cwd();
  const extraDirs = (process.env.RUNDOCK_EXTRA_DIRS || '').split(path.delimiter).filter(Boolean);
  // A WORKSPACE OPENED UNDER THE RUNTIME HOME IS STILL A WORKSPACE. Both
  // refusals below are about reaching the runtime's own configuration from
  // somewhere else; neither is about the folder a person deliberately opened.
  // Someone authoring a plugin in `~/.claude/plugins/my-plugin` writes
  // ordinary files there, and without this the refusals would deny every one
  // of them outright, with no card and no way past it, telling them to go and
  // edit the workspace they are already in. The containment test is the
  // classifier's own, so one place cannot be inside for the boundary and
  // outside for the refusals.
  const refusalTarget = (function () {
    const ti = (data && data.tool_input) || {};
    const t = ti.file_path || ti.notebook_path || ti.path;
    return typeof t === 'string' && t ? canonicalize(path.resolve(wsRoot, t)) : null;
  }());
  const targetInsideWorkspace = refusalTarget !== null
    && buildRoots(wsRoot, extraDirs).some(r => isUnder(refusalTarget, r));

  // THE REFUSALS RUN FIRST, BEFORE ANYTHING CAN ANSWER THEM. They are
  // enforcement rather than a prompt, so no mode, grant or classification may
  // speak for the reader here. Placed after the boundary classification, they
  // were reachable only when that classification produced an outside crossing:
  // a refused edit is tagged as nothing at all, and Code mode auto-approves
  // anything not tagged outside, so in Code mode a write to the GLOBAL agents
  // folder was allowed, landed where the app never reads, and reported
  // success. That is the silent failure the denial exists to prevent, in the
  // mode a developer is most likely to be running.
  // Agents and skills are managed ONLY through the RUNDOCK:SAVE_AGENT /
  // RUNDOCK:SAVE_SKILL markers, which write into THIS workspace's .claude folder
  // and refresh the UI. Deterministically deny any direct file edit to a
  // .claude/agents or .claude/skills path, in the workspace OR the global
  // ~/.claude (Claude Code's native default). Without this, a direct edit
  // silently succeeds in the wrong place: an edit to the global agents folder
  // that Rundock never reads, leaving the user told "done" while the workspace
  // file, and the profile panel, never changed. This is enforcement, not a
  // prompt: the wrong path can no longer look like a success.
  if (!targetInsideWorkspace && isProtectedClaudeEdit(data.tool_name, data.tool_input)) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: "Rundock reads the agents and skills inside the open workspace, never the global ~/.claude copies, so this edit would land where the app never looks and change nothing it can see. Manage this workspace's agents and skills through the RUNDOCK:SAVE_AGENT / RUNDOCK:SAVE_SKILL markers (which write into this workspace and refresh the app), or edit the workspace's own .claude file."
      }
    }));
    process.exit(0);
  }

  // The rest of the persistence tier under the runtime's own home. The branch
  // above names the two folders Rundock manages and can redirect the user to;
  // this one covers plugins/, commands/, hooks/ and settings.json, which the
  // runtime refuses outright (measured; see isRuntimeHomeSurfaceEdit). Rundock
  // cannot approve past it, so a card saying "Approve always" for such a write
  // is a promise the product cannot keep.
  if (!targetInsideWorkspace && isRuntimeHomeSurfaceEdit(data.tool_name, data.tool_input)) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: "Claude Code protects its own configuration folder, so it refuses this write whatever Rundock or you approve: approving it would still fail. Reading and listing that folder is unaffected. Agents, skills, routines and connectors for this workspace live in the workspace itself, which is where Rundock reads them from, so make the change there and it will take effect."
      }
    }));
    process.exit(0);
  }

  // Workspace file-access boundary. Classified BEFORE the code-mode
  // short-circuit on purpose: code mode trusts commands inside the
  // workspace, it does not extend the workspace to the whole machine.
  // File tools and shell commands are classified by the same boundary and
  // reach the same card. classifyShellAccess only ever answers 'outside' or
  // null, so an ordinary command keeps whatever card it already had: the
  // instant-allow branch below stays reachable only by file tools.
  // No refusal reaches here: both exit above, so this guard is the tool-name
  // check alone rather than restating them.
  const access = (typeof data.tool_name === 'string')
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

  const port = process.env.RUNDOCK_PORT || 3000;
  const convoId = process.env.RUNDOCK_CONVO_ID || '';

  // Every crossing, already tagged by classifyFileAccess/shellCrossings at
  // the point each was classified: nothing here re-derives those answers. A
  // secrets-registry crossing already carries no grantDir (stripped at
  // classification), so the request emitted for one is never grantable.
  const boundaryCrossings = (access && access.where === 'outside')
    ? (access.crossings || [{
        path: access.resolvedPath, grantDir: access.grantDir,
        agentHome: access.agentHome, secret: access.secret, persistenceSurface: access.persistenceSurface,
      }])
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
          // NOT the secrets gate, decided per crossing above (grantDir
          // stripped there): this flag stays true for every crossing so a
          // standing grant can still silence the ones it covers.
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
