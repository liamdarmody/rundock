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

// THE ONE DEFINITION OF READ-ONLY, shared with the client risk grader.
// It lived here and was answered a second time, differently, in
// public/permissions.js, and the reader paid for the disagreement: a command
// this file read as harmless was carded anyway by the narrower list kept
// there. The module sits under public/ because that is the half that cannot
// require the other (the browser has no require), and node reaching into
// public/ is the pattern lib/ already uses for shared client logic.
//
// THE REACH OUT OF scripts/ IS NOT FREE. This file is asar-unpacked so Claude
// Code can exec it as its own process, and a require reaching out of that
// directory resolves on disk rather than inside the archive. The shared module
// is named in package.json's asarUnpack for that reason, and a test binds the
// two so a later shared module cannot be added without it.
const { isReadOnlyShellCommand, isDestructiveShellCommand, shellSegments } = require('../public/read-only-shell.js');
// The Code-mode verdict and the development paths live beside this file, in
// scripts/, so they are unpacked with it (package.json asarUnpack scripts/**).
const { codeModeVerdict } = require('./code-mode-verdict.js');
const { lexSegments } = require('./code-mode-parse.js');
const devPaths = require('./dev-paths.js');

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
const PERSISTENCE_SURFACE_DIRS = ['agents', 'skills', 'plugins', 'commands', 'hooks', 'rules', 'output-styles'];
const PERSISTENCE_SURFACE_FILES = ['settings.json', 'CLAUDE.md'];

// ── The OTHER runtime's home, on the same three tiers ──────────────────
// Rundock spawns Codex as well as Claude, and `~/.codex` is that runtime's
// equivalent of `~/.claude`. Only one of them was exempt, so an agent reading
// its own configuration was silent on one runtime and carded on the other.
// Reported from the field: "show me my current permission settings" raised a
// card for `~/.codex/config.toml`, which Rundock's OWN Connectors tab reads and
// displays without asking (lib/http-router.js, /api/connectors/machine).
//
// THIS ALSO CLOSES A HOLE RATHER THAN ONLY QUIETING ONE. Untiered, `~/.codex`
// was ordinary outside access, so its card offered "always allow this folder".
// Anyone who granted it to stop the config.toml nagging would have silenced
// every later read of `auth.json` beside it. The secrets tier refuses a folder
// grant outright, which is exactly why credentials belong in it.
//
// Kept as its own registry rather than merged into the lists above, because
// those are joined onto `~/.claude`: a shared list would make
// `~/.claude/auth.json` a secret and `~/.codex/auth.json` nothing at all.
const CODEX_SECRET_RELATIVE_PATHS = ['auth.json'];
// `config.toml` is Codex's `settings.json`: free to read, asks on write. The
// databases, caches, logs and session files beside it are scratch and stay
// free both ways, the same judgement already made for `~/.claude`.
const CODEX_PERSISTENCE_SURFACE_DIRS = ['prompts', 'rules'];
const CODEX_PERSISTENCE_SURFACE_FILES = ['config.toml', 'AGENTS.md'];
// THE GLOBAL INSTRUCTION FILES, a subset of the surfaces above named on their
// own because their card says something different: a write to one plants
// instructions every later session loads, in every workspace, including
// routines that run unattended. Reading them stays free, like every surface.
// Protected in both modes. Each name is the runtime's own documented location
// for user-level instructions (Claude Code: CLAUDE.md, rules/, output-styles/
// under ~/.claude; Codex: AGENTS.md and rules/ under ~/.codex).
const INSTRUCTION_SURFACES = { claude: ['CLAUDE.md', 'rules', 'output-styles'], codex: ['AGENTS.md', 'rules'] };
// The read-only shell registries used to sit here, and were re-exported for
// nobody. They are now in public/read-only-shell.js, required at the top of
// this file, because the client risk grader answers the same question about
// the same text and the two answers must be one. Nothing about how this file
// USES the answer changed: it re-grades a crossing under the runtime's OWN
// home and nothing else, and outside that home it is never consulted at all.

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
function codexHomeRoot(home = os.homedir()) {
  return canonicalize(path.join(home, '.codex'));
}
// Every runtime home this product spawns into, each with the registry that
// governs it. One shape, two rows, so a tier question is asked the same way
// whichever runtime an agent happens to be running on.
function runtimeHomes(home = os.homedir()) {
  return [
    {
      root: agentHomeRoot(home),
      secrets: SECRET_RELATIVE_PATHS,
      dirs: PERSISTENCE_SURFACE_DIRS,
      files: PERSISTENCE_SURFACE_FILES,
    },
    {
      root: codexHomeRoot(home),
      secrets: CODEX_SECRET_RELATIVE_PATHS,
      dirs: CODEX_PERSISTENCE_SURFACE_DIRS,
      files: CODEX_PERSISTENCE_SURFACE_FILES,
    },
  ];
}
// The home a path sits in, or null. A path is judged by ITS OWN runtime's
// registry and no other: `~/.claude/auth.json` is not a Codex credential and
// `~/.codex/settings.json` is not a Claude one.
function homeFor(candidate, home = os.homedir(), foldsCase = hostFoldsCase()) {
  const c = foldCase(canonicalize(candidate), foldsCase);
  return runtimeHomes(home).find(h => {
    const r = foldCase(h.root, foldsCase);
    return c === r || c.startsWith(r + path.sep);
  }) || null;
}
function secretsRegistry(home = os.homedir()) {
  return runtimeHomes(home).flatMap(h => h.secrets.map(p => path.join(h.root, p)));
}
function isSecretPath(candidate, home = os.homedir(), foldsCase = hostFoldsCase()) {
  if (typeof candidate !== 'string' || !candidate) return false;
  const c = foldCase(canonicalize(candidate), foldsCase);
  const h = homeFor(candidate, home, foldsCase);
  if (!h) return false;
  return h.secrets.some(p => c === foldCase(canonicalize(path.join(h.root, p)), foldsCase));
}
function isPersistenceSurface(candidate, home = os.homedir(), foldsCase = hostFoldsCase()) {
  if (typeof candidate !== 'string' || !candidate) return false;
  const c = foldCase(canonicalize(candidate), foldsCase);
  const h = homeFor(candidate, home, foldsCase);
  if (!h) return false;
  if (h.files.some(f => c === foldCase(canonicalize(path.join(h.root, f)), foldsCase))) return true;
  return h.dirs.some(d => {
    const dir = foldCase(canonicalize(path.join(h.root, d)), foldsCase);
    return c === dir || c.startsWith(dir + path.sep);
  });
}
// Every tag a crossing carries, computed once so the file-tool and
// shell-command paths read the same three answers.
function agentHomeTags(resolvedPath, home = os.homedir(), foldsCase = hostFoldsCase()) {
  // EITHER runtime home. `agentHome` means "the runtime's own area", and this
  // product spawns two runtimes. Judged through homeFor so the tiers below are
  // read from the registry belonging to the home the path is actually in.
  const agentHome = !!homeFor(resolvedPath, home, foldsCase);
  if (!agentHome) return { agentHome: false, secret: false, persistenceSurface: false };
  const tags = { agentHome: true, secret: isSecretPath(resolvedPath, home, foldsCase), persistenceSurface: isPersistenceSurface(resolvedPath, home, foldsCase) };
  if (isInstructionSurface(resolvedPath, home, foldsCase)) tags.instructionFile = true;
  return tags;
}
function isInstructionSurface(candidate, home = os.homedir(), foldsCase = hostFoldsCase()) {
  if (typeof candidate !== 'string' || !candidate) return false;
  const c = foldCase(canonicalize(candidate), foldsCase);
  return [[agentHomeRoot(home), INSTRUCTION_SURFACES.claude], [codexHomeRoot(home), INSTRUCTION_SURFACES.codex]].some(([root, names]) => names.some((n) => {
    const e = foldCase(canonicalize(path.join(root, n)), foldsCase);
    return c === e || c.startsWith(e + path.sep);
  }));
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
// The folder the user opened. Canonicalised in ONE place: a workspace reached
// through a symlink resolves to a different string than the files inside it
// report, and a comparison that skipped this would have the workspace denying
// its own files.
function insideWorkspaceRoot(resolvedPath, workspaceRoot, pmod = path) {
  return isUnder(resolvedPath, canonicalize(workspaceRoot, pmod), pmod);
}

// A NAMED FOLDER NEVER REACHES INTO THE RUNTIME'S OWN HOME, and this function
// is the whole of that rule.
//
// Naming a folder says where a team works. It is carried into the same
// containment comparison the workspace root already uses, and that comparison
// runs BEFORE the runtime-home tier tags at every site that consults it. So
// without this, naming any ancestor of `~/.claude`, `~` most obviously, would
// make `.credentials.json` compare as inside and be allowed outright: not
// carded, not graded, the secrets tier never consulted at all. The same held
// for a persistence-surface write and for both deterministic refusals. One
// named parent, chosen for an entirely unrelated reason, would have switched
// off the tier that exists to protect the one thing worth protecting most.
//
// The workspace root is deliberately NOT filtered this way. Its exemption is
// about a folder someone opened on purpose, knowing what is in it: authoring a
// plugin in `~/.claude/plugins/my-plugin` is ordinary work in the workspace
// they chose. A named parent is the opposite act. Its entire value is that it
// covers folders nobody has enumerated, including ones that do not exist yet,
// so it must never be read as consent to the folders inside it that carry
// their own rules.
//
// `home` and `foldsCase` are the same defaulted seams the tier functions take.
function namedFolderCovers(resolvedPath, extraDirs = [], pmod = path, home = os.homedir(), foldsCase = hostFoldsCase()) {
  if (!extraDirs.length) return false;
  // Under the runtime home, the tiers decide and a named folder is silent.
  // Deliberately the WHOLE home, not just the registered tiers: a folder that
  // becomes a tier later must not already have been named past.
  // Under EITHER runtime home the tiers decide and a named folder is silent.
  // Both, for the reason the single-home version gave: a folder that becomes a
  // tier later must not already have been named past. Without this, naming
  // ~/.codex as a working folder would exempt the credentials inside it, which
  // is the grant-away hole the secrets tier exists to refuse.
  if (homeFor(resolvedPath, home, foldsCase)) return false;
  // NOR INTO A HIDDEN FOLDER DIRECTLY UNDER HOME, unless that hidden folder, or
  // a folder inside it, is itself named. Naming `~` (deliberately, or before
  // this rule from a card that offered it) must not hand over `~/.ssh`: the
  // grant was given for the folders a person works in, and the dot folders
  // are where tools keep keys and credentials.
  const hidden = pmod === path ? hiddenHomeRootOf(resolvedPath, home) : null;
  return extraDirs.some((d) => {
    const named = canonicalize(d, pmod);
    if (!isUnder(resolvedPath, named, pmod)) return false;
    return !hidden || isUnder(named, hidden, pmod);
  });
}

// The hidden folder directly under home that holds `p` (`~/.ssh`), or null.
// The runtime homes are not this rule's business: their own tiers decide.
function hiddenHomeRootOf(p, home = os.homedir()) {
  if (typeof p !== 'string' || !p) return null;
  const h = canonicalize(home);
  const rel = path.relative(h, canonicalize(p));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const first = rel.split(path.sep)[0];
  if (!first.startsWith('.')) return null;
  const root = path.join(h, first);
  if (runtimeHomes(home).some(r => root === r.root)) return null;
  return root;
}
// `home` and `foldsCase` are defaulted seams so a test can pass a fixture
// home instead of monkey-patching os.homedir(), and drive either filesystem
// kind explicitly instead of inheriting whichever the test host happens to
// have; production never passes either.
// THE FILES THAT HOLD THE PERSON'S OWN ANSWERS, protected here because here is
// the only layer that runs everywhere.
//
// state.json carries the workspace mode. permissions.json carries the standing
// grants: the folders allowed outside the workspace, and the tools allowed
// without a card. settings.local.json carries the workspace's permission
// configuration, including the hooks that produce the cards at all. Each is an
// answer a person gave to a permission question, so an agent that can write
// one can answer those questions on that person's behalf, and the standing
// allows it wrote would silence every later card for those tools with no
// further consent.
//
// lib/workspace/scaffold.js also names them in the sandbox block's denyWrite,
// and that is the stronger protection where it exists: it stops the write at
// the operating system rather than asking. But it exists on macOS alone. On
// Windows and Linux sandboxSettings returns null, so without this these
// files were writable by any agent with a shell, and the second of them is new
// state that used to live only in a browser tab where nothing could reach it.
//
// Carding rather than denying, because a person legitimately edits neither
// through an agent and would want to be told if something tried.
// WORKSPACE-RELATIVE PATHS, not bare names, because these no longer all live
// in one folder. `.claude/settings.local.json` holds the workspace's standing
// permission grants and is where the runtime loads the permission hooks from,
// so an agent able to write it could decide what an agent needs permission for.
// It sits inside the workspace, so without naming it here a write to it passed
// as ordinary inside-workspace work. An agent may always ASK for a permission;
// it must never be able to GRANT one, which is also why the crossing below
// carries no grantDir: a standing "Always Allow" on this file would hand an
// agent lasting authority over the thing that decides what needs authority.
// The workspace's own answer files, split by WHO GUARDS THEM, which was
// measured against the real runtime rather than assumed.
//
// `.claude/settings.local.json` is the settings file Rundock launches the
// runtime with, and the runtime refuses every write to it: under acceptEdits,
// through the Edit tool and through a shell redirect, and no permission rule
// inside that file unlocks it, not even a blanket one. That is deliberate: a
// permission system whose own configuration can be edited by the thing it
// governs is not a permission system. So Rundock must not offer an Allow there;
// it would be a promise the floor refuses to keep, and the user clicking it
// learns that approving does nothing.
//
// The two `.rundock/` files have NO such floor. An agent edits them freely, and
// `readToolAllows` trusts whatever strings it finds. They hold the standing
// answers a person gave, so a write is a grant of permissions nobody issued.
// THE CARD ON THESE IS THE ONLY PROTECTION THEY HAVE. Do not "simplify" it.
const RUNTIME_GUARDED_ANSWER_FILES = ['.claude/settings.local.json'];
const RUNDOCK_ANSWER_FILES = ['.rundock/state.json', '.rundock/permissions.json'];
// The workspace's project settings (`.claude/settings.json`) are answer files
// too: Claude Code loads them for every agent Rundock spawns here, and they can
// carry hooks and permission allow rules. They are matched, for this workspace
// and every other Rundock workspace alike, by isRundockWorkspaceSettingsFile
// below, and carded rather than refused: the runtime is only measured to refuse
// the settings file it is launched with.
const WORKSPACE_ANSWER_FILES = [...RUNDOCK_ANSWER_FILES, ...RUNTIME_GUARDED_ANSWER_FILES];
function matchesAnswerFileSet(set, resolvedPath, workspaceRoot, foldsCase = hostFoldsCase(), pmod = path) {
  if (typeof resolvedPath !== 'string' || !resolvedPath) return false;
  if (typeof workspaceRoot !== 'string' || !workspaceRoot) return false;
  // Windows paths fold case whatever the host says, which is why the flavour
  // travels with the comparison rather than being assumed from the host.
  const folds = foldsCase || pmod === path.win32;
  // CANONICALISED ON BOTH SIDES. Callers inside this file pass an already
  // resolved path, but the server's decision point passes a crossing's path
  // straight off the wire, and on macOS the same file has two absolute names
  // (/var and /private/var). Comparing one spelling against the other answered
  // "not an answer file" for the file it was looking at. Canonicalising is
  // idempotent, so the callers that had already done it are unaffected.
  const c = foldCase(canonicalize(resolvedPath, pmod), folds);
  // The registry spells its paths with forward slashes, so the segments are
  // split and rejoined in the flavour being compared rather than pasted in.
  return set.some((f) => (
    c === foldCase(canonicalize(pmod.join(pmod.resolve(workspaceRoot), ...f.split('/')), pmod), folds)
  ));
}

// ANOTHER WORKSPACE'S ANSWERS ARE ANSWERS TOO. A folder named as a working
// folder can hold other Rundock workspaces (a parent of several is the obvious
// case), and a write into one of them is a grant of permissions nobody issued,
// used the next time that workspace runs: self-permission by proxy. The
// `.rundock` files carry names only Rundock uses, so they are matched by name
// wherever they sit. `.claude/settings*.json` are ordinary files in any Claude
// project, so they are matched for the current workspace only (above).
function isRundockAnswerFileAnywhere(resolvedPath, pmod = path) {
  if (typeof resolvedPath !== 'string' || !resolvedPath) return false;
  const parts = resolvedPath.split(/[\\/]+/);
  const n = parts.length;
  const fold = v => (pmod === path.win32 || hostFoldsCase() ? v.toLowerCase() : v);
  return n >= 2 && fold(parts[n - 2]) === '.rundock' && RUNDOCK_ANSWER_FILES.some(f => fold(f.split('/')[1]) === fold(parts[n - 1]));
}

// A Claude settings file of a Rundock workspace: `.claude/settings.json` or
// `.claude/settings.local.json` directly under a folder holding
// `.rundock/state.json`. Only inside a Rundock workspace: in a code project the
// same names are that project's own settings, and editing them is ordinary work.
const WORKSPACE_SETTINGS_NAMES = ['settings.json', 'settings.local.json'];
function isRundockWorkspaceSettingsFile(resolvedPath) {
  if (typeof resolvedPath !== 'string' || !resolvedPath) return false;
  const claudeDir = path.dirname(resolvedPath);
  if (path.basename(claudeDir) !== '.claude' || !WORKSPACE_SETTINGS_NAMES.includes(path.basename(resolvedPath))) return false;
  return fs.existsSync(path.join(path.dirname(claudeDir), '.rundock', 'state.json'));
}
// An answer file of ANY Rundock workspace: its `.rundock` files by name, and
// its Claude settings files.
function isAnswerFileOfAnyWorkspace(resolvedPath, pmod = path) {
  return isRundockAnswerFileAnywhere(resolvedPath, pmod) || (pmod === path && isRundockWorkspaceSettingsFile(resolvedPath));
}

// The Rundock workspace, other than the current one, that holds `p`: the
// nearest ancestor with a `.rundock/state.json`. Null when there is none, or
// when it is the current workspace.
function otherWorkspaceRootOf(p, workspaceRoot) {
  if (typeof p !== 'string' || !p) return null;
  const current = canonicalize(workspaceRoot);
  let cur = path.dirname(canonicalize(p));
  for (;;) {
    if (fs.existsSync(path.join(cur, '.rundock', 'state.json'))) return cur === current ? null : cur;
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}
// ANOTHER WORKSPACE'S AGENTS AND SKILLS ARE PERSISTENCE SURFACES. Rundock
// spawns every agent with `--agent <name>` from that workspace's own
// `.claude/agents/`, and Claude Code acts on keys in agent and skill
// frontmatter that never reach a card (`hooks`, `permissionMode`,
// `allowed-tools`, `mcpServers`; see UNASKED_KEYS in
// lib/packages/import-plan.js). A write into another workspace's agents or
// skills therefore sets up how a different team runs, with no one there asked.
function isOtherWorkspaceAgentSurface(p, workspaceRoot) {
  const other = otherWorkspaceRootOf(p, workspaceRoot);
  if (!other) return false;
  const c = canonicalize(p);
  return ['agents', 'skills'].some(d => isUnder(c, path.join(other, '.claude', d)));
}

// The two predicates below differ ONLY in which set they match, so they share
// the matcher: the canonicalisation and case-folding rules above were each
// arrived at by a defect, and a second copy would not inherit them.
function isWorkspaceAnswerFile(resolvedPath, workspaceRoot, foldsCase = hostFoldsCase(), pmod = path) {
  return matchesAnswerFileSet(WORKSPACE_ANSWER_FILES, resolvedPath, workspaceRoot, foldsCase, pmod);
}

// Same matching rules as isWorkspaceAnswerFile, over the runtime-guarded subset.
function isRuntimeGuardedAnswerFile(resolvedPath, workspaceRoot, foldsCase = hostFoldsCase(), pmod = path) {
  return matchesAnswerFileSet(RUNTIME_GUARDED_ANSWER_FILES, resolvedPath, workspaceRoot, foldsCase, pmod);
}

function classifyFileAccess(toolName, toolInput, workspaceRoot, extraDirs = [], home = os.homedir(), foldsCase = hostFoldsCase(), resolvedPathFoldsCase, opts = {}) {
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
  // The workspace root, then the named folders, which stop at the runtime home
  // so the tags below still get to speak for anything inside it.
  const inside = insideWorkspaceRoot(resolvedPath, workspaceRoot)
    || namedFolderCovers(resolvedPath, extraDirs, path, home, foldsCase);
  const writing = !READ_FILE_TOOLS.has(toolName);
  // THE WORKSPACE'S OWN ANSWER FILES, carded on write however far inside the
  // workspace they sit. See workspaceAnswerFile below for why this cannot be
  // left to the sandbox.
  // MEASURED, not assumed: the runtime refuses every write to the settings file
  // it was launched with, so an Allow here could never be honoured. Rundock
  // says so instead of asking a question whose answer changes nothing. Silence
  // would be worse: it would read as Rundock having permitted the write.
  if (inside && writing && isRuntimeGuardedAnswerFile(resolvedPath, workspaceRoot, foldsCase)) {
    return { where: 'inside', resolvedPath, grantDir: null, answerFile: true, enforcedDeny: 'runtime-settings' };
  }
  if (writing && !isWorkspaceAnswerFile(resolvedPath, workspaceRoot, foldsCase) && isAnswerFileOfAnyWorkspace(resolvedPath)) {
    // Another workspace's answer file, inside a named folder or not: carded
    // like this workspace's own, never offered as a folder to remember.
    return { where: inside ? 'inside' : 'outside', resolvedPath, grantDir: null, answerFile: true };
  }
  if (writing && isOtherWorkspaceAgentSurface(resolvedPath, workspaceRoot)) {
    // Outside THIS workspace, whatever folder names cover it: carded every
    // time, never remembered.
    return { where: 'outside', resolvedPath, grantDir: null, agentHome: false, secret: false, persistenceSurface: true, otherWorkspace: true, write: true };
  }
  if (inside && writing && isWorkspaceAnswerFile(resolvedPath, workspaceRoot, foldsCase)) {
    // `where` says where the file IS, and this one is inside. It used to say
    // 'outside' because that was the only classification that both forced a
    // card and refused a standing grant, and the client then printed "wants to
    // reach outside your workspace" above a path plainly inside the workspace.
    // The card was right and its stated reason was false, which on a security
    // prompt is worse than it sounds: a prompt that misstates why it is asking
    // devalues every other prompt.
    //
    // `answerFile` now carries the reason on its own, and every place that
    // relied on 'outside' to mean "always ask, never remember" reads this flag
    // instead. They are enumerated at the call sites: the code-mode
    // auto-approve, and the decision payload.
    return { where: 'inside', resolvedPath, grantDir: null, answerFile: true };
  }
  if (inside) return { where: 'inside', resolvedPath };
  // CODE MODE'S DEVELOPMENT PATHS: the temp folders and package caches are
  // working folders there, and git's own settings are free to read. Notes mode
  // is unchanged. See scripts/dev-paths.js.
  if (opts.codeMode && devPaths.isDevPath(resolvedPath, { home, canonical: canonicalize })) return { where: 'inside', resolvedPath };
  if (opts.codeMode && !writing && devPaths.isGitConfigFile(resolvedPath, { home: canonicalize(home) })) return { where: 'inside', resolvedPath };
  // The agent's own folder: free unless the registry names this exact
  // access as a secret (always) or a write to a persistence surface.
  const tags = agentHomeTags(resolvedPath, home, foldsCase);
  const isWrite = writing;
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
  const noGrant = tags.secret
    || (tags.agentHome && runtimeHomes(home).some(h => grantDir === h.root))
    // Same rule for file tools as for commands, so the two cards cannot disagree
    // about whether a credential folder may be handed over in one click.
    || underHiddenHomeDir(grantDir, home)
    // NEVER THE HOME DIRECTORY, or anything above it, which the shell card
    // already refused. Without this a read of any file directly in home offered
    // home, and one click silenced every later card for the machine's files.
    || isHomeOrAbove(grantDir, home)
    // NEVER A FOLDER THAT DOES NOT EXIST, and not its nearest existing ancestor
    // in its place either: climbing widens the grant.
    || !fs.existsSync(grantDir);
  const hidden = hiddenHomeRootOf(resolvedPath, home);
  return { where: 'outside', resolvedPath, grantDir: noGrant ? null : grantDir, ...tags, ...(hidden ? { hiddenHome: path.basename(hidden) } : {}), ...(writing ? { write: true } : {}) };
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
// A SEARCH PATTERN IS NOT A PATH, and one that begins with a slash was being
// read as one.
//
// `ls | grep '/$'` produced a crossing at `/$`, and `grep -E '/$|No such'` one
// at `/$|No such`. Reported from the field twice in one session. The card is
// noise on its own, but the damage is larger than noise: a phantom crossing
// shares no sensible folder with a real one, so the card stops offering "always
// allow this folder" for the folder the command genuinely reaches. A regex
// anywhere in a command therefore disabled the one control that ends repeated
// asking, which is the storm this release set out to stop, returning by another
// door.
//
// POSITIONAL, NOT BY VALUE. Skipping any token that looks like a pattern would
// mean `grep '/etc/passwd' /etc/passwd` skipping both occurrences: the pattern
// AND the file being read. So each segment is judged on its own, and only the
// argument sitting in the pattern position is dropped. Everything after it is
// still a file argument and still scanned.
//
// `-e` carries the pattern when it is used, so the positional argument is then
// a file and must be kept. `-f` names a file to READ patterns from, which is a
// real path and is never dropped. Getting those two the wrong way round is the
// only way this could hide a genuine target, so they are named explicitly
// rather than lumped in with other flags.
const PATTERN_FIRST_ARG = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'sed', 'awk']);
function patternArgsIn(segment) {
  const words = String(segment).match(/'([^']*)'|"([^"]*)"|[^\s]+/g) || [];
  const bare = w => (w[0] === "'" || w[0] === '"') ? w.slice(1, -1) : w;
  const lead = bare(words[0] || '').split('/').pop();
  if (!PATTERN_FIRST_ARG.has(lead)) return [];
  const patterns = [];
  let sawE = false;
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === '-e' || w === '--regexp') { if (words[i + 1]) { patterns.push(bare(words[i + 1])); sawE = true; i++; } continue; }
    if (w === '-f' || w === '--file') { i++; continue; }   // a real path: never dropped
    if (w[0] === '-' && w.length > 1) continue;            // any other flag
    if (!sawE) patterns.push(bare(w));                     // the positional pattern
    break;                                                 // everything after it is a file
  }
  return patterns;
}

// A SEPARATOR IS NOT A PATH. `tr -d '/'`, `cut -d'/'`, `awk -F/` and
// `IFS=/` hand a command a lone `/` as a field or character separator, and it
// was read as the filesystem root: listed on the card, and it collapsed the
// folder the card could offer to `/`, so no "Always allow this folder" was
// drawn. Only a bare `/` in one of these positions is dropped; a `/` anywhere
// else (`grep -r x /`, `find / -name id_rsa`, `du -sh /`) is still a crossing.
const DELIMITER_FLAGS = { cut: ['-d', '--delimiter'], awk: ['-F'], gawk: ['-F'], mawk: ['-F'], sort: ['-t', '--field-separator'], paste: ['-d', '--delimiters'], column: ['-s', '--separator'] };
function delimiterArgsIn(segment) {
  const words = String(segment).match(/'([^']*)'|"([^"]*)"|[^\s]+/g) || [];
  const bare = w => w.replace(/^['"]|['"]$/g, '').replace(/'([^']*)'|"([^"]*)"/g, (m, a, b) => (a !== undefined ? a : b));
  const found = [];
  let i = 0;
  // Assignments before the command, IFS=/ among them.
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) {
    if (/^IFS=/.test(words[i]) && bare(words[i].slice(4)) === '/') found.push('/');
    i++;
  }
  const lead = bare(words[i] || '').split('/').pop();
  const rest = words.slice(i + 1);
  if (lead === 'tr') {
    for (const w of rest) if (bare(w) === '/') found.push('/');
    return found;
  }
  const flags = DELIMITER_FLAGS[lead];
  if (!flags) return found;
  for (let k = 0; k < rest.length; k++) {
    const w = rest[k];
    for (const f of flags) {
      if (w === f) { if (bare(rest[k + 1] || '') === '/') found.push('/'); }
      else if (w.startsWith(f.startsWith('--') ? f + '=' : f) && bare(w.slice(f.length + (f.startsWith('--') ? 1 : 0))) === '/') found.push('/');
    }
  }
  return found;
}

// AN ECHOED WORD IS NOT A FILE ACCESS. `echo /X` and `printf '%s' /X` print
// text; nothing is opened. Their operands are skipped only when the output
// goes nowhere else: no redirection in the command, and not piped on, since
// `echo ~/.ssh/id_rsa | xargs cat` hands the path to something that reads it.
// A substitution (`cat $(echo /X)`) belongs to the outer command and is kept.
function echoedArgsIn(command) {
  const out = [];
  const segs = lexSegments(String(command), 'bash');
  for (let i = 0; i < segs.length; i++) {
    const text = segs[i].text;
    const words = text.match(/'([^']*)'|"([^"]*)"|[^\s]+/g) || [];
    const lead = (words[0] || '').replace(/^['"]|['"]$/g, '').split('/').pop();
    if (lead !== 'echo' && lead !== 'printf') continue;
    if (/[<>]/.test(text) || text.includes('$(') || text.includes('`')) continue;
    if (segs[i + 1] && segs[i + 1].op === '|') continue;
    for (const w of words.slice(1)) out.push(w.replace(/^['"]|['"]$/g, ''));
  }
  return out;
}

function shellPathTokens(command) {
  const out = [];
  // Every argument sitting in a pattern position, counted per segment so the
  // same text appearing later as a real file is still seen; and the same for
  // a separator and an echoed word.
  const skip = [];
  for (const seg of shellSegments(String(command))) skip.push(...patternArgsIn(seg), ...delimiterArgsIn(seg));
  skip.push(...echoedArgsIn(command));
  const re = /'([^']*)'|"([^"]*)"|[^\s;|&<>()`'"]+/g;
  let m;
  while ((m = re.exec(String(command))) !== null) {
    const t = m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[0]);
    if (!t) continue;
    // Dropped once per pattern occurrence, not everywhere the text appears, so
    // `grep '/etc/passwd' /etc/passwd` still reports the file it reads.
    const at = skip.indexOf(t);
    if (at !== -1) { skip.splice(at, 1); continue; }
    out.push(t);
    // Also the value after the first `=`. Flag values (`--output=/etc/x`) and
    // shell assignments (`OUT=$HOME/x`) are the two commonest places a target
    // sits in plain sight inside a larger word. The whole token is kept too,
    // so nothing that used to be seen stops being seen; a value that is not
    // path-shaped falls out at the same filter everything else does.
    const eq = t.indexOf('=');
    if (eq > 0 && eq < t.length - 1) {
      const value = t.slice(eq + 1);
      // An IFS=/ separator is dropped here, where its value is split off.
      const vat = /^IFS=/.test(t) ? skip.indexOf(value) : -1;
      if (vat !== -1) skip.splice(vat, 1); else out.push(value);
    }
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

// `shellSegments` and `isReadOnlyShellCommand` are required from
// public/read-only-shell.js at the top of this file. They used to be written
// out here, and written out a second time in public/permissions.js, which is
// how the two graders came to disagree about the same command text. Used here
// ONLY to re-grade an agent-home crossing that would otherwise card because it
// touches a persistence surface (see shellCrossings): the tier itself is
// unaffected, and a secrets-registry crossing is never re-graded regardless of
// this answer.

// EVERY distinct target in the command that resolves outside, not the first.
//
// One reported path is not enough, because the server decides a standing
// folder grant against what it is handed. Given only the first, a command
// whose first target sits in an already-granted folder is allowed outright
// and a second target somewhere else rides along with no card at all.
// WHERE THE RELATIVE PATHS IN THIS COMMAND START FROM.
//
// A Bash tool call runs at the workspace root, so that is the base, and it was
// the base unconditionally. But a command may move first, and then the relative
// tokens after it mean something else:
//
//   cd <ws>/.claude && cat ../.mcp.json
//
// reads <ws>/.mcp.json, inside the workspace. Measured from the root instead,
// `../.mcp.json` became <ws>/../.mcp.json: outside, carded, and on the machine
// this was reported from, not a file that exists. Reported from the field, on
// an agent reading its own workspace's configuration to answer a question
// about that workspace.
//
// WHAT THIS DELIBERATELY WILL NOT DO is interpret the shell. A base is taken
// only when it can be read off the front of the command with certainty, and
// every uncertainty falls back to the workspace root. The fallback is the safe
// direction by construction: too shallow a base can only turn a path that
// climbs back INTO the workspace into a false crossing, which costs a card.
// Too deep a base could let a token climb out unnoticed, which costs the
// boundary, so nothing here is allowed to guess its way deeper.
//
// Hence all four conditions. The `cd` must be the FIRST thing in the command
// (anything later would need to know what ran in between). Its target must be
// a literal (a variable, a substitution or a glob is not knowable here). There
// must be no second `cd` (the base would stop being true partway through). And
// the target must land INSIDE the workspace: a command that leaves is the case
// this whole card exists for, and its own token reports it.
const CD_PREFIX = /^\s*cd\s+("[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)/;
const CD_ANYWHERE = /(?:^|[;&|]|\s)cd\s/g;
const CD_NOT_LITERAL = /[$`*?[\](){}<>!~]/;
// THE BASE IS WHERE THE COMMAND RUNS. The hook input's `cwd` follows the agent
// (Claude Code documents it: it is the new directory after a `cd`, and the
// working directory carries over inside the project and its additional
// directories); a Codex approval carries its own. Only when neither is known
// is the workspace root the base. The base says where a relative path starts,
// never what counts as inside.
//
// A leading literal `cd` still narrows it, and may now land in a working
// folder as well as the workspace: `cd ~/Projects/app && rm -rf dist`, run
// from the workspace, is judged in `app`.
function commandBaseDir(command, workspaceRoot, pmod, cwd, extraDirs = [], home = os.homedir()) {
  const root = cwd ? canonicalize(pmod.resolve(cwd), pmod) : pmod.resolve(workspaceRoot);
  const m = CD_PREFIX.exec(command);
  if (!m) return root;
  // A second `cd` means the base stops being true partway through the command.
  const cds = String(command).match(CD_ANYWHERE);
  if (!cds || cds.length !== 1) return root;
  let target = m[1];
  const quoted = (target.startsWith('"') && target.endsWith('"')) || (target.startsWith("'") && target.endsWith("'"));
  if (quoted) target = target.slice(1, -1);
  for (const re of HOME_PREFIX) {
    if (re.test(target)) { target = target.replace(re, home); break; }
  }
  if (!target || CD_NOT_LITERAL.test(target)) return root;
  const base = canonicalize(pmod.resolve(root, target), pmod);
  // Leaving the workspace and every working folder is not a base this trusts.
  // The `cd` token is scanned like any other and reports the crossing on its own.
  return (insideWorkspaceRoot(base, workspaceRoot, pmod) || namedFolderCovers(base, extraDirs, pmod, home)) ? base : root;
}

// `$env:TEMP\x` and `%LOCALAPPDATA%\x` in the forms each shell writes them, for
// the development paths; `$env:USERPROFILE` and `%USERPROFILE%` are home and are
// handled with the other home shorthands.
const BASH_ESCAPE = /^\\(?:[abefnrtv0\\'"?]|x[0-9a-fA-F]{1,2}|[0-7]{1,3}|u[0-9a-fA-F]{4})$/;
const WIN_SWITCH = /^\/[A-Za-z?]{1,8}(:[^\\/\s]*)?$/;
const ENV_PREFIX = [/^\$\{?env:([A-Za-z_][A-Za-z0-9_]*)\}?(?=[\\/]|$)/i, /^%([A-Za-z_][A-Za-z0-9_]*)%(?=[\\/]|$)/];

function shellCrossings(command, workspaceRoot, extraDirs, home = os.homedir(), foldsCase = hostFoldsCase(), opts = {}) {
  const found = [];
  const seen = new Set();
  const codeMode = !!opts.codeMode;
  const winWorld = opts.platform === 'win32';
  const devOpts = { home, env: opts.env || process.env, platform: winWorld ? 'win32' : process.platform, canonical: winWorld ? (x => x) : canonicalize };
  // Computed once for the whole command, not per token: whether it may read
  // a persistence surface under the runtime's OWN home free is a property of
  // the command as a whole (see isReadOnlyShellCommand), never of one target
  // in isolation.
  const readOnly = isReadOnlyShellCommand(command);
  // AN ANSWER FILE IS CHANGED ONLY BY A SEGMENT THAT DOES MORE THAN READ.
  // `tail .rundock/permissions.json; echo done > build.log` reads the file and
  // writes somewhere else; judged as a whole it was a change to the answer
  // file. So the words of the segments that do not only read are collected,
  // and an answer file is reported when one of them names it. A redirect, tee,
  // sed -i, cp or mv onto it is such a segment.
  const writingWords = new Set();
  if (!readOnly) {
    for (const seg of shellSegments(String(command))) {
      if (!isReadOnlyShellCommand(seg)) for (const w of shellPathTokens(seg)) writingWords.add(w);
    }
  }
  for (const raw of shellPathTokens(command)) {
    let t = raw;
    let homed = false;
    for (const re of HOME_PREFIX) {
      if (re.test(t)) { t = t.replace(re, home); homed = true; break; }
    }
    if (!homed) {
      for (const re of ENV_PREFIX) {
        const m = re.exec(t);
        const val = m && devPaths.envValue(opts.env || process.env, m[1]);
        if (val) { t = val + t.slice(m[0].length); homed = true; break; }
      }
    }
    if (URL_SCHEME.test(t)) continue;
    if (isExemptToken(t)) continue;
    // A WINDOWS SWITCH IS NOT A PATH. `taskkill /PID 4242 /F`, `icacls . /grant`
    // and `cmd /c` read as absolute POSIX paths, and in Code mode an outside
    // write with nothing to offer asks every time. Only in Code mode (Notes
    // mode is unchanged), only in a Windows command, and only for a short word
    // naming nothing on this machine.
    if (codeMode && opts.windowsSwitches && WIN_SWITCH.test(raw) && !fs.existsSync(raw)) continue;
    // A BACKSLASH ESCAPE IS NOT A PATH. `tr '/' '\n'`, `printf '%s\t'` and
    // `sed 's/ /\n/'` hand the command an escape sequence, and a backslash reads
    // as a Windows separator, so `\n` was judged as a relative path and listed
    // as a place outside the workspace. Only for the Bash tool: in PowerShell a
    // backslash really is a separator.
    if (opts.shellTool !== 'PowerShell' && BASH_ESCAPE.test(raw)) continue;
    const pmod = winWorld ? path.win32 : flavourFor(t, workspaceRoot);
    // Resolved against where the command actually runs, not against the
    // workspace root regardless. Everything BELOW still judges against the
    // workspace root: the base says where a relative path starts, never what
    // counts as inside.
    const resolved = canonicalize(pmod.resolve(commandBaseDir(command, workspaceRoot, pmod, opts.cwd, extraDirs, home), t), pmod);

    // THE ANSWER FILES ARE TESTED BEFORE THE CROSSING FILTER, not after it.
    //
    // The filter below exists to answer "could this token reach OUTSIDE the
    // workspace", and a plain relative token cannot, which is why it is
    // skipped. The answer files are the one thing INSIDE the workspace that
    // still has to be reported, so testing them after that skip left the
    // ordinary spelling unguarded while the absolute one was caught:
    //
    //   echo '{}' > /abs/ws/.rundock/permissions.json   caught
    //   echo '{}' > .rundock/permissions.json           skipped entirely
    //
    // The second is how anyone would actually write it, and it is the shape a
    // test using an absolute path never sees.
    if (writingWords.has(raw) && (isWorkspaceAnswerFile(resolved, workspaceRoot, foldsCase, pmod) || isAnswerFileOfAnyWorkspace(resolved, pmod))) {
      const akey = pmod === path.win32 ? resolved.toLowerCase() : resolved;
      if (!seen.has(akey)) { seen.add(akey); found.push({ path: resolved, answerFile: true }); }
      continue;
    }

    // Skip tokens that could not cross. A relative token resolves against the
    // workspace root and lands inside whatever it looks like, so a URL, a
    // compiler flag and a bare filename all fall out here without needing a
    // rule of their own. What must NOT fall out here is any Windows shape:
    // a drive letter and a backslash traversal both reach outside while
    // containing no leading forward slash and no `/`-delimited `..`.
    // A bare word (`dist`, `install`, `-rf`) is never a crossing, however the
    // base falls; a relative path with a separator is judged by where it
    // resolves from the base, like any other.
    if (!homed && !t.startsWith('/') && !WIN_DRIVE.test(t) && !WIN_UNC.test(t) && !TRAVERSAL.test(t) && !/[\\/]/.test(t)) continue;
    if (insideWorkspaceRoot(resolved, workspaceRoot, pmod)) continue;
    // A TOP-LEVEL PATH THAT DOES NOT EXIST, READ BY A COMMAND THAT ONLY READS,
    // reaches nothing: `--exclude-dir=/Build` and `git log -- /Docs` name a
    // pattern, not a place. A command that writes keeps the crossing, however
    // unlikely a write at the root is.
    if (readOnly && !homed && pmod === path && /^\/[^/\\]+\/?$/.test(t) && !fs.existsSync(resolved)) continue;
    if (!readOnly && pmod === path && isOtherWorkspaceAgentSurface(resolved, workspaceRoot)) {
      const okey = resolved;
      if (!seen.has(okey)) { seen.add(okey); found.push({ path: resolved, agentHome: false, secret: false, persistenceSurface: true, otherWorkspace: true, write: true }); }
      continue;
    }
    if (namedFolderCovers(resolved, extraDirs, pmod, home, foldsCase)) continue;
    // Code mode's development paths, and git's own settings read by a command
    // that only reads.
    if (codeMode && devPaths.isDevPath(resolved, devOpts)) continue;
    if (codeMode && readOnly && devPaths.isGitConfigFile(resolved, { ...devOpts, home: winWorld ? home : canonicalize(home) })) continue;
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
    const hidden = winWorld ? hiddenWinRootOf(resolved, home) : hiddenHomeRootOf(resolved, home);
    found.push({ path: resolved, ...tags, ...(hidden ? { hiddenHome: path.basename(hidden.replace(/\\/g, '/')) } : {}), ...(readOnly ? {} : { write: true }) });
  }
  return found;
}

// hiddenHomeRootOf for a Windows-shaped world judged on another host.
function hiddenWinRootOf(p, home) {
  const rel = path.win32.relative(home, p);
  if (!rel || rel.startsWith('..') || path.win32.isAbsolute(rel)) return null;
  const first = rel.split('\\')[0];
  if (!first.startsWith('.') || /^\.(claude|codex)$/i.test(first)) return null;
  return path.win32.join(home, first);
}

// ADVISORY ONLY: what the command APPEARS to reach, for labelling a card.
//
// This never decides anything. It cannot allow, deny, or grant. Its single job
// is to answer "should this card also say the command reaches outside your
// workspace", and it is deliberately kept away from `crossings`, which is what
// the server acts on.
//
// WHY IT EXISTS. shellCrossings tokenises the command and inspects tokens that
// look like paths, which is the right basis for a DECISION: it does not guess.
// A path inside a quoted interpreter argument is not its own token, so the
// tokeniser does not see it:
//
//   cat /Users/me/.ssh/id_rsa                      -> a crossing, carded
//   python3 -c "print(open('/Users/me/.ssh/id_rsa').read())"  -> not a crossing
//
// The second is still carded, by the risk grader, because an interpreter
// invocation grades above "low". So nothing here is silently allowed. What was
// wrong is what the card SAID: it asked whether a python command may run,
// without mentioning that the command reads a file outside the workspace. The
// facts were on screen in a form that is easy to approve without noticing.
//
// Measured across the shapes that evade the tokeniser (python -c, node -e,
// sh -c, awk getline, command substitution): every one is carded by the risk
// grader. The gap is a labelling gap, not a bypass, and this closes it by
// adding information to a card that was already being shown.
//
// It scans the raw text, so it over-matches: a path in a comment, in a URL
// path, or in prose counts. Over-matching is the correct failure direction for
// a label. It is not the correct failure direction for a decision, which is
// why this value is kept out of every decision path.
function advisoryOutsidePaths(command, workspaceRoot, extraDirs = [], home = os.homedir(), foldsCase = hostFoldsCase()) {
  if (typeof command !== 'string' || !command) return [];
  // URLs first, whole. Matching starts after the scheme, so `https://host/a/b`
  // otherwise yields `//host/a/b`, which resolves to a plausible-looking
  // absolute path and would put "reaches outside your workspace" on every
  // command that fetches a page. A label that cries wolf is the failure this
  // is meant to fix.
  const text = command.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ');
  const out = [];
  const seen = new Set();
  // Absolute POSIX paths, ~-rooted paths, and Windows drive paths, wherever
  // they sit: inside quotes, inside a larger word, adjacent to punctuation.
  const re = /(?:~|\$HOME)?\/(?:[\w.@+~-]+\/)*[\w.@+~-]+|[A-Za-z]:\\(?:[\w.@+~ -]+\\)*[\w.@+~ -]+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let t = m[0];
    if (URL_SCHEME.test(t) || t.startsWith('//')) continue;
    for (const rx of HOME_PREFIX) {
      if (rx.test(t)) { t = t.replace(rx, home); break; }
    }
    if (!t.startsWith('/') && !WIN_DRIVE.test(t)) continue;
    let resolved;
    try {
      const pmod = flavourFor(t, workspaceRoot);
      resolved = canonicalize(pmod.resolve(pmod.resolve(workspaceRoot), t), pmod);
      if (insideWorkspaceRoot(resolved, workspaceRoot, pmod)) continue;
      if (namedFolderCovers(resolved, extraDirs, pmod, home, foldsCase)) continue;
    } catch (e) { continue; }
    // IT MUST NAME SOMETHING REAL. Scanning raw text splits a path at a space,
    // and workspace paths contain spaces: "/Users/me/Documents/My Notes/site"
    // yields "/Users/me/Documents/My" plus a fragment,
    // neither of which exists and both of which resolve outside the workspace.
    // Unfiltered, this labelled every ordinary command in such a workspace as
    // reaching outside it: the cry-wolf failure a label exists to avoid, worse
    // than saying nothing because it teaches the reader to skip the line.
    //
    // Existing, or a parent that exists, so a command writing a new file is
    // still named. A path that matches neither is a fragment, not a target.
    try {
      if (!fs.existsSync(resolved)) {
        // Not there. It is worth naming only if it looks like a file about to
        // be created: an existing parent AND a final segment with a suffix.
        // "/Users/me/Documents/My" passes the parent test and is still a
        // fragment of a folder named "My Notes", so the parent test alone is
        // not enough in exactly the workspaces where this matters most.
        const parent = path.dirname(resolved);
        const leaf = path.basename(resolved);
        if (!fs.existsSync(parent) || !/\.[A-Za-z0-9]{1,8}$/.test(leaf)) continue;
      }
    } catch (e) { continue; }
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
    if (out.length >= 8) break; // a label, not an inventory
  }
  return out;
}


// The one folder a shell card may offer to name, or null.
//
// ONE FOLDER, NOT AN ANCESTOR OF EVERYTHING. A command can reach several places,
// and the common ancestor of two unrelated paths climbs until it finds one:
// `/etc/hosts` and `~/Documents/x` meet at the filesystem root. Offering that
// would let one click widen the boundary to the whole machine, which is the
// opposite of the point.
//
// So the answer is refused unless every crossing sits under one directory that
// is itself specific: not the root, not the home directory, and not one of the
// shallow system folders a person never means to hand over wholesale. When in
// doubt this returns null and the card simply has no button, which costs one
// trip to Settings rather than a boundary nobody chose.
//
// A crossing the secrets registry names is never grantable at all, so its
// presence refuses the whole offer rather than being quietly skipped: a command
// that touches a credential must not be the occasion for naming its folder.
// A HIDDEN FOLDER UNDER HOME IS NEVER OFFERED AS A STANDING GRANT.
//
// `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`: by convention these hold keys and
// credentials, and the folder is where the danger lives rather than the one file
// a card happens to be about. Asking an agent about `~/.ssh/config` produced a
// card offering to allow the whole folder, private keys included, in one click
// beside the ordinary Allow, worded as though it were the same size of yes.
//
// WHAT THIS DOES NOT COST, measured before deciding: nothing that uses SSH needs
// it. `ssh host`, `scp`, `rsync` and `git push` raise no card at all, because the
// ssh binary reads the keys as a subprocess and no path for them appears in the
// command. So the grant buys no quiet that anyone actually wants; it only removes
// the asking from the one folder where the asking is the point.
//
// Allow still works. What goes is the one-click blanket, not the access: a person
// who genuinely wants agents editing their SSH config names the folder in
// Settings, deliberately, which is the right weight for that decision.
//
// A RULE RATHER THAN A LIST OF NAMES, because the next credential store will have
// a name nobody here guessed. Dot-directories directly under home are config and
// secret stores by convention; the workspace, named working folders and ordinary
// project directories are unaffected.
function isHomeOrAbove(dir, home = os.homedir()) {
  if (typeof dir !== 'string' || !dir) return false;
  const h = canonicalize(home);
  const d = canonicalize(dir);
  return d === h || isUnder(h, d);
}

function underHiddenHomeDir(dir, home = os.homedir()) {
  if (typeof dir !== 'string' || !dir) return false;
  const h = canonicalize(home);
  const rel = path.relative(h, canonicalize(dir));
  // Outside home, or home itself: not this rule's business.
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  if (!rel.split(path.sep)[0].startsWith('.')) return false;
  // EXCEPT THE RUNTIME HOMES, which are hidden directories under home but are
  // already governed by something finer than this. Their roots are refused a
  // grant, their credential files are secrets and are refused one on any access,
  // and everything else in them is scratch the agent owns. A folder-shaped
  // persistence surface like `.claude/hooks` is deliberately grantable, scoped
  // to itself, and a blanket rule here would take that away for no gain: hooks
  // are not credentials, and the credentials beside them are already protected.
  // Caught by the test that pins exactly that, rather than by reading.
  const under = canonicalize(dir);
  return !runtimeHomes(home).some(r => under === r.root || isUnder(under, r.root));
}

const NEVER_OFFERED = new Set(['/', '/Users', '/home', '/tmp', '/var', '/etc', '/usr',
  '/bin', '/sbin', '/opt', '/private', '/System', '/Library', '/Applications', '/Volumes']);
function shellGrantDir(crossings, home = os.homedir()) {
  if (!crossings.length) return null;
  if (crossings.some(c => c.secret || c.answerFile || c.otherWorkspace)) return null;
  // Each crossing as the folder it implies: a directory is itself, a file is
  // the folder holding it. An unborn path is judged by its parent either way.
  const dirs = crossings.map((c) => {
    let isDir = false;
    try { isDir = fs.statSync(c.path).isDirectory(); } catch (e) { /* unborn: treat as a file */ }
    return isDir ? c.path : path.dirname(c.path);
  });
  const segmentsOf = d => d.split(path.sep).filter(Boolean);
  let common = segmentsOf(dirs[0]);
  for (const d of dirs.slice(1)) {
    const segs = segmentsOf(d);
    let i = 0;
    while (i < common.length && i < segs.length && common[i] === segs[i]) i++;
    common = common.slice(0, i);
  }
  if (!common.length) return null;
  const dir = path.sep + common.join(path.sep);
  // COMPARED CANONICALLY, because macOS reaches these through symlinks: /etc is
  // really /private/etc and /tmp is /private/tmp, and every crossing arrives
  // here already canonicalised. A literal string match therefore let the REAL
  // spelling of a system folder walk straight past the list written to refuse
  // it, and `ls /etc` offered to name /private/etc. Caught by running the list
  // against real paths rather than by reading it.
  const refused = new Set();
  for (const d of NEVER_OFFERED) {
    refused.add(d);
    try { refused.add(canonicalize(d)); } catch (e) { /* absent on this host */ }
  }
  if (refused.has(dir) || refused.has(canonicalize(dir))) return null;
  // The home directory itself, and anything above it, is too much to hand over
  // from one card. Named explicitly rather than by counting segments, because
  // how deep a home directory sits differs by platform.
  const h = canonicalize(home);
  if (dir === h || isUnder(h, dir)) return null;
  // NOR A RUNTIME HOME ROOT, for the reason classifyFileAccess already refuses
  // it: `settings.json` is the one persistence-surface entry that is a FILE, so
  // the folder holding it IS `~/.claude` itself. Offering that would let one
  // approval at settings.json silence every later write to agents/, skills/,
  // plugins/, commands/ and hooks/ underneath it. The file path had this guard
  // and the shell path, being new, did not; a test that already existed for the
  // file tools caught it.
  if (runtimeHomes(home).some(r => dir === r.root)) return null;
  if (underHiddenHomeDir(dir, home)) return null;
  // NEVER A FOLDER THAT DOES NOT EXIST. A `..` measured from the wrong base
  // once offered a phantom folder beside the workspace; with the base fixed,
  // an offer must still name something real, and climbing to the nearest
  // existing ancestor instead would widen the grant.
  if (!fs.existsSync(dir)) return null;
  return dir;
}

function classifyShellAccess(toolName, toolInput, workspaceRoot, extraDirs = [], home = os.homedir(), foldsCase = hostFoldsCase(), opts = {}) {
  if (!SHELL_TOOLS.has(toolName)) return null;
  const ti = toolInput || {};
  // Signal 1. No grant folder is offered: a sandbox escape is not about one
  // folder, so "always allow this folder" would remember nothing.
  if (ti.dangerouslyDisableSandbox === true) {
    return { where: 'outside', resolvedPath: null, grantDir: null, grantable: false, crossings: [] };
  }
  // Signal 2.
  if (typeof ti.command !== 'string' || !ti.command) return null;
  const windowsSwitches = toolName === 'PowerShell' || /\bcmd(\.exe)?\s+\/[ck]\b/i.test(ti.command);
  const crossings = shellCrossings(ti.command, workspaceRoot, extraDirs, home, foldsCase, { ...opts, windowsSwitches, shellTool: toolName });
  if (!crossings.length) return null;
  // `grantDir` AND `grantable` ARE DIFFERENT QUESTIONS, and conflating them is
  // why this offered nothing.
  //
  // `grantable` stays false, unchanged and load-bearing: a STORED grant must
  // never answer a command, because everything in the command runs, not only
  // the part that touches the granted folder. That rule is what keeps
  // `rm -rf * ; touch <named>/x` in front of a person.
  //
  // `grantDir` is a different thing: what the button on THIS card would name.
  // The person is approving this command explicitly either way; the button adds
  // "and work here from now on". Leaving it null meant that in real use the
  // offer was nearly unreachable, because 68% of boundary cards measured across
  // 91 real sessions came from shell commands, and an agent asked to read one
  // file reaches for `cat` far more often than for the file tool. People were
  // told to name a folder in Settings while standing in front of the card that
  // knew exactly which folder they meant.
  return {
    where: 'outside',
    resolvedPath: crossings[0].path,
    grantDir: opts.platform === 'win32' ? null : shellGrantDir(crossings, home),
    grantable: false,
    crossings,
  };
}

module.exports = {
  isProtectedClaudeEdit, isRuntimeHomeSurfaceEdit, isMcpReadTool, classifyFileAccess, classifyShellAccess, canonicalize,
  advisoryOutsidePaths,
  isSecretPath, isPersistenceSurface, SECRET_RELATIVE_PATHS, PERSISTENCE_SURFACE_DIRS, PERSISTENCE_SURFACE_FILES,
  CODEX_SECRET_RELATIVE_PATHS, CODEX_PERSISTENCE_SURFACE_DIRS, CODEX_PERSISTENCE_SURFACE_FILES,
  agentHomeRoot, codexHomeRoot, runtimeHomes,
  isWorkspaceAnswerFile, isRuntimeGuardedAnswerFile,
  WORKSPACE_ANSWER_FILES, RUNDOCK_ANSWER_FILES, RUNTIME_GUARDED_ANSWER_FILES,
  boundaryCrossingsFor,
  REFUSED_CLAUDE_EDIT_DIRS, isReadOnlyShellCommand, isRundockAnswerFileAnywhere, isRundockWorkspaceSettingsFile, isAnswerFileOfAnyWorkspace, otherWorkspaceRootOf, isOtherWorkspaceAgentSurface,
  INSTRUCTION_SURFACES, isInstructionSurface, hiddenHomeRootOf, alwaysAsksCrossing, SHELL_TOOLS,
};

if (require.main === module) main();
// The crossings the server acts on, built from one classification.
//
// A SEAM, extracted so the payload's own shape can be asserted rather than the
// classifier's return value. Those are different things, and a test on the
// second passes while the first silently drops a tag.
//
// Every crossing is already tagged by classifyFileAccess/shellCrossings at the
// point each was classified: nothing here re-derives those answers. A
// secrets-registry crossing already carries no grantDir (stripped at
// classification), so the request emitted for one is never grantable.
//
// THE SAME TAGS WHICHEVER GRADER CAUGHT IT. The shell path tags its own
// answer-file crossings, and this one dropped the flag, so a card for the
// identical file could be worded one way when a command wrote it and another
// when a tool did. The tool route is the direct one.
function boundaryCrossingsFor(access) {
  if (!access || access.where !== 'outside') return [];
  if (access.crossings) return access.crossings;
  return [{
    path: access.resolvedPath, grantDir: access.grantDir,
    agentHome: access.agentHome, secret: access.secret,
    persistenceSurface: access.persistenceSurface, answerFile: access.answerFile,
    ...(access.instructionFile ? { instructionFile: true } : {}),
    ...(access.hiddenHome ? { hiddenHome: access.hiddenHome } : {}),
    ...(access.write ? { write: true } : {}),
  }];
}

// IN CODE MODE, A CROSSING THAT CAN NEVER BE REMEMBERED IS ALWAYS ASKS: it is
// carded every time and refused when nobody can be asked, rather than let
// through because a local server was down. That is any access to a hidden
// folder directly under home (~/.ssh first), a write to a global instruction
// file or another persistence surface, and a write that no folder offer could
// ever answer (a file directly in home, say). Ordinary outside access keeps
// the boundary card and its old behaviour when unanswered.
function alwaysAsksCrossing(access) {
  if (!access || access.where !== 'outside') return false;
  const crossings = boundaryCrossingsFor(access);
  if (crossings.some(c => c && (c.hiddenHome || c.instructionFile || (c.persistenceSurface && c.write)))) return true;
  const writing = crossings.some(c => c && c.write);
  const offered = (crossings[0] && crossings[0].grantDir) || access.grantDir;
  return writing && !offered;
}

// THE LINE RUNDOCK LEFT FOR THIS CONVERSATION'S AGENT, if any, asked for from
// the server that keeps it (lib/runtime/agent-notices.js) before this hook
// decides anything, so every answer below can carry it. Only the server can
// have left it: nothing is read from the workspace. Brief and best-effort:
// with the server unreachable, slow or saying anything unexpected, there is
// simply no line, and the decision is unaffected.
const AGENT_NOTICE_ID = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/;
// The token Rundock started this agent with, bound to its conversation. The
// server's two hook routes accept nothing else, and act only for the
// conversation it names (lib/auth).
function hookTokenHeader() {
  const token = process.env.RUNDOCK_HOOK_TOKEN || '';
  return token ? { 'X-Rundock-Hook-Token': token } : {};
}
function fetchAgentNotice(done, { check = false } = {}) {
  const id = process.env.RUNDOCK_CONVO_ID || '';
  if (!process.env.RUNDOCK || !AGENT_NOTICE_ID.test(id)) { done(null); return; }
  let finished = false;
  const finish = (text) => {
    if (finished) return;
    finished = true;
    done(typeof text === 'string' && text.trim() ? text.trim().slice(0, 2000) : null);
  };
  const req = http.request({
    hostname: '127.0.0.1', port: process.env.RUNDOCK_PORT || 3000,
    path: '/api/agent-notice?conversation=' + encodeURIComponent(id) + (check ? '&check=1' : ''), method: 'GET', timeout: check ? 1000 : 250,
    headers: hookTokenHeader(),
  }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; if (body.length > 8192) { req.destroy(); finish(null); } });
    res.on('end', () => { let text = null; try { text = JSON.parse(body).text; } catch (e) { /* no line */ } finish(text); });
  });
  req.on('error', () => finish(null));
  req.on('timeout', () => { req.destroy(); finish(null); });
  req.end();
}

function main() {
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
// A FINISHED TOOL CALL (PostToolUse). Nothing is decided here: the server is
// asked to check the permission files now, and any line about a change it put
// back goes to the agent in this same step. The line PreToolUse would have
// carried is the same one, handed over once, whichever asks first.
let hookEvent = '';
try { hookEvent = JSON.parse(input).hook_event_name || ''; } catch (e) { /* judged below */ }
if (hookEvent === 'PostToolUse') {
  fetchAgentNotice((note) => {
    process.stdout.write(JSON.stringify(note ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: note } } : {}));
    process.exit(0);
  }, { check: true });
  return;
}
fetchAgentNotice((agentNotice) => {
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
  // Every answer this hook gives from here on also hands over any line
  // Rundock left for this conversation's agent, as additionalContext, which
  // the runtime adds to the model's context. The line was fetched from the
  // server before deciding (agentNotice, below); it is never read from a file.
  const writeDecision = (answer) => {
    const note = agentNotice;
    if (!note) { process.stdout.write(JSON.stringify(answer)); return; }
    const own = answer.hookSpecificOutput || { hookEventName: 'PreToolUse' };
    const context = [own.additionalContext, note].filter(Boolean).join('\n');
    process.stdout.write(JSON.stringify({ ...answer, hookSpecificOutput: { ...own, additionalContext: context } }));
  };
  // THE FOLDERS AS THEY ARE NOW, not only as they were when this agent started.
  //
  // The env carries the list the agent was BORN with, and lib/runtime/claude.js
  // says why: a folder list must not change underneath a command that is midway
  // through running. That reasoning is about NARROWING. A folder removed while
  // an agent works should not retroactively forbid what it is already doing.
  //
  // Widening is the opposite case, and it is the one a person is standing in
  // front of. Reported from the field: approving a folder with "Always allow
  // this folder" and then watching the very next command in the same turn raise
  // a card for a path inside the folder just approved. The approval was stored
  // correctly; this process simply had no way to hear about it. From the
  // reader's side the button did nothing, which is worse than if it had not
  // been offered.
  //
  // So the two are UNIONED. Anything the agent was born with stays, whatever
  // the file says now, which keeps the narrowing guarantee exactly as it was.
  // Anything named since is added, which makes an approval mean something
  // immediately. This hook is a fresh process on every tool call, so "now"
  // costs one small read and is genuinely now.
  //
  // Read directly rather than through lib/workspace/working-folders.js: this
  // file is asar-unpacked so the runtime can exec it, every require reaching
  // out of scripts/ has to be unpacked alongside it, and the stored list is
  // already normalised by the writer. A file that is missing, unreadable or
  // malformed leaves the born-with list standing, which is the safe direction:
  // it can only ask more often, never less.
  const bornWith = (process.env.RUNDOCK_EXTRA_DIRS || '').split(path.delimiter).filter(Boolean);
  const namedSince = (function () {
    try {
      const state = JSON.parse(fs.readFileSync(path.join(wsRoot, '.rundock', 'state.json'), 'utf-8'));
      const list = state && state.workingFolders;
      return Array.isArray(list) ? list.filter(d => typeof d === 'string' && d) : [];
    } catch (e) { return []; }
  }());
  const extraDirs = [...new Set([...bornWith, ...namedSince])];
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
  // THE WORKSPACE ROOT ONLY. A named folder never exempts these refusals, even
  // when it contains the target: see namedFolderCovers for why the two acts are
  // not the same act. Naming `~` must not turn the runtime home into a folder
  // the refusals stop looking at.
  const targetInsideWorkspace = refusalTarget !== null
    && insideWorkspaceRoot(refusalTarget, wsRoot);

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
    writeDecision(({
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
    writeDecision(({
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
  // Where the command runs: the hook input's cwd follows the agent.
  const codeMode = process.env.RUNDOCK_CODE_MODE === '1';
  const cwd = (typeof data.cwd === 'string' && data.cwd) ? data.cwd : undefined;
  const access = (typeof data.tool_name === 'string')
    ? classifyFileAccess(data.tool_name, data.tool_input, wsRoot, extraDirs, undefined, undefined, undefined, { codeMode })
      || classifyShellAccess(data.tool_name, data.tool_input, wsRoot, extraDirs, undefined, undefined, { cwd, codeMode })
    : null;
  // THE SAME PRINCIPLE THE BRANCH ABOVE APPLIES TO ~/.claude, applied to the
  // workspace's own settings file, because the measurement is the same one.
  //
  // The runtime refuses every write to the settings file it was launched with:
  // under acceptEdits, through a file tool and through a shell redirect, and no
  // permission rule inside that file unlocks it, not even a blanket one. So a
  // card here offers an Allow that cannot be honoured. A user met exactly
  // that: the card appeared, the approval was recorded, the write was refused
  // anyway, and the agent reported it as "not approved". A prompt whose answer
  // cannot take effect is worse than no prompt, because it teaches that
  // approving is pointless.
  //
  // Named rather than silent: silence would read as Rundock having allowed it.
  if (access && access.enforcedDeny === 'runtime-settings') {
    writeDecision(({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: "This is the settings file the runtime was started with, and the runtime refuses every write to it: it holds the permission rules themselves, so nothing inside it can grant permission to change it. Rundock cannot approve past that, so it does not ask. Edit the file yourself if you need to, or ask for the specific permission you want and it can be requested properly."
      }
    }));
    process.exit(0);
  }

  // `answerFile` is excluded HERE, at the first branch that can allow anything,
  // and not only at the code-mode branch below. This instant-allow fires in
  // every mode, so reclassifying an answer file as inside without touching this
  // line removed the card completely, in Knowledge mode as well as Code mode:
  // a silent, total loss of the one question that governs every other question.
  // `where` describes where the file sits and must stay honest; `answerFile`
  // decides whether it is ordinary inside work, and it never is.
  if (access && access.where === 'inside' && !access.answerFile) {
    writeDecision(({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'In-workspace file access'
      }
    }));
    process.exit(0);
  }

  // CODE MODE: ordinary work runs with no card. Out-of-workspace access still
  // cards (classified above, before this branch, on purpose), and so does a
  // write to the workspace's own answer files: Code mode says the person
  // trusts agents with their code, not that they have stopped deciding what
  // agents may do.
  //
  // For a shell command the class is the VERDICT (scripts/code-mode-verdict.js):
  // it runs when what it changes can be got back with tools already to hand,
  // asks every time when it cannot, and asks once for the few acts other
  // people see first. It is computed for every Code-mode shell request, a
  // boundary card included, so the card's class is always the verdict. It is
  // never computed outside Code mode, where the grader is unchanged.
  const shellCommand = SHELL_TOOLS.has(data && data.tool_name)
    && typeof ((data.tool_input || {}).command) === 'string' ? data.tool_input.command : null;
  const verdict = (codeMode && shellCommand !== null)
    ? codeModeVerdict({ toolName: data.tool_name, command: shellCommand, cwd, workspaceRoot: wsRoot, extraDirs })
    : null;
  if (codeMode
      && !(access && (access.where === 'outside' || access.answerFile))
      && (!verdict || verdict.verdict === 'runs')) {
    writeDecision(({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'Auto-approved: workspace is in Code mode'
      }
    }));
    process.exit(0);
  }
  // Notes mode keeps its own definition of an irreversible command, unchanged.
  const destructive = !codeMode && shellCommand !== null && isDestructiveShellCommand(shellCommand);

  // MCP tools are routed through the hook (not pre-approved via --allowed-tools).
  // Read-style MCP calls auto-approve here, server-side, so they work even when no
  // browser tab is actively connected and never block on the card timeout.
  // Write/destructive/unrecognised MCP calls fall through to the permission card.
  if (typeof data.tool_name === 'string' && data.tool_name.startsWith('mcp__') && isMcpReadTool(data.tool_name)) {
    writeDecision(({
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
  const boundaryCrossings = boundaryCrossingsFor(access);

  // LABEL, NOT A DECISION. Sent under its own name so it can never be mistaken
  // for `crossings`, which is what the server acts on. The server must not read
  // this when deciding; the client reads it when wording the card.
  const advisory = SHELL_TOOLS.has(data.tool_name)
    ? advisoryOutsidePaths((data.tool_input || {}).command, wsRoot, extraDirs)
    : [];

  const payload = JSON.stringify({
    tool_name: data.tool_name,
    tool_input: data.tool_input || {},
    session_id: data.session_id,
    conversation_id: convoId,
    ...(advisory.length ? { advisory_outside_paths: advisory } : {}),
    // THE VERDICT, under its own name, Code mode only. The server relays it by
    // name and the browser draws the card from it; without it the browser
    // grades as it always has, which is every Notes-mode request.
    ...(verdict ? { code_mode_verdict: verdict } : {}),
    // An answer-file write asks without claiming a crossing: it carries its own
    // reason, and the client keys its heading off this rather than off boundary.
    ...(access && access.answerFile && access.where !== 'outside'
      ? { answer_file: true, resolved_path: access.resolvedPath || null, grant_dir: null }
      : {}),
    ...(access && access.where === 'outside'
      ? {
          boundary: true,
          resolved_path: access.resolvedPath || null,
          // THE FOLDER THE BUTTON WOULD NAME. A file tool tags its own crossing
          // with the folder holding it; a shell command has no single crossing
          // to tag, so the classifier works one out from all of them (see
          // shellGrantDir) and hangs it on the access rather than on a crossing.
          // Read from the crossing first so nothing about the file path
          // changes, then from the access, which is the only source a shell
          // request has.
          //
          // Kept off the crossings deliberately: `crossingCovered` on the server
          // reads those when deciding whether a STORED grant covers a request,
          // and a shell request must never be answered that way. What this field
          // does is draw a button; what `grantable` does is decide whether a
          // stored grant may answer. Two questions, and they are answered by two
          // fields on purpose.
          grant_dir: (boundaryCrossings[0] && boundaryCrossings[0].grantDir) || access.grantDir || null,
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

  // WHAT TO DO WHEN NOBODY CAN BE ASKED.
  //
  // Three paths end here: the server is unreachable, its answer is unparsable,
  // or it never answers. They used to disagree, and two of them said allow.
  //
  // Allowing is right for ORDINARY access. The card is a convenience there, the
  // sandbox and the runtime's own guards are still underneath, and a person
  // whose work stops dead because a local web server died has been failed by a
  // safety feature that protected nothing.
  //
  // It is exactly wrong for the ANSWER FILES. `.rundock/state.json` and
  // `.rundock/permissions.json` have NO floor beneath them: no sandbox rule
  // covers them, the runtime does not refuse them, and readToolAllows trusts
  // whatever strings it finds. The card IS the guard. Failing open there means
  // that whenever this server is down, an agent may write itself standing
  // permissions nobody ever granted, and they persist into every later session.
  //
  // HOW THIS WAS FOUND, because it says something about the shape of the risk:
  // the tests covering these files were spawning the real hook with no port
  // pinned, so they reached a developer's live Rundock and a human clicked Deny
  // on eleven mystery cards. The moment they were pointed at a closed port, the
  // assertions failed. The guard had never been exercised without a server, and
  // "the server is down" is precisely when it matters.
  //
  // A denial is safe to repeat: nothing is lost but the attempt, and the agent
  // is told plainly why.
  // AND ANYTHING WORTH ASKING ABOUT IN CODE MODE, for the same reason.
  //
  // An irreversible command (Always asks), a remembered-once act nobody has
  // remembered yet (Asks once), and a crossing that can never be remembered
  // (see alwaysAsksCrossing) have been judged worth a person's decision. When
  // the sandbox switch is off there is nothing under the command but the card,
  // and proceeding because nobody could be asked is the one outcome that
  // cannot be taken back. Notes mode keeps its destructive-command rule.
  // Ordinary access keeps failing open: a person whose work stops because a
  // local web server died has been failed by a safety feature that protected
  // nothing.
  const asksOnce = !!(verdict && verdict.verdict === 'asks-once');
  const alwaysAsks = !!(verdict && verdict.verdict === 'always-asks');
  const crossingAlwaysAsks = codeMode && alwaysAsksCrossing(access);
  const answerFile = !!(access && (access.answerFile || boundaryCrossingsFor(access).some(c => c && c.answerFile)));
  const failClosed = answerFile || destructive || asksOnce || alwaysAsks || crossingAlwaysAsks;
  function unanswered(reason) {
    let why;
    if (answerFile) why = 'This file records your own permission answers, and it is never changed without asking, so it was refused rather than approved on your behalf.';
    else if (alwaysAsks || destructive) why = 'This command cannot be undone, and it is never run without asking, so it was refused rather than approved on your behalf.';
    else if (asksOnce) why = 'This command was held for your approval and Rundock could not ask, so it was refused rather than approved on your behalf.';
    else if (crossingAlwaysAsks) why = 'This reaches a place Rundock asks about every time, and it is never done without asking, so it was refused rather than approved on your behalf.';
    writeDecision(({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: failClosed ? 'deny' : 'allow',
        permissionDecisionReason: failClosed ? `${reason} ${why}` : reason,
      }
    }));
    process.exit(0);
  }

  const req = http.request({
    hostname: '127.0.0.1',
    port: port,
    path: '/api/permission-request',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      ...hookTokenHeader(),
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
        writeDecision(({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: result.allow ? 'allow' : 'deny',
            permissionDecisionReason: reason
          }
        }));
      } catch (e) {
        unanswered('Rundock hook: could not parse server response.');
      }
      process.exit(0);
    });
  });

  req.on('error', () => {
    unanswered('Rundock server unreachable.');
  });

  req.on('timeout', () => {
    req.destroy();
    // Already a denial before this change, and it stays one for everything: an
    // unanswered card means the person never saw it or never chose.
    writeDecision(({
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
});
}
