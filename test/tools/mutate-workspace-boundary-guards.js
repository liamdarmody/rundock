#!/usr/bin/env node
'use strict';
// Break each of the boundary's guards in turn and report which tests notice.
//
// Every rule here is a rule about a card that fires or stays quiet, and both
// failure directions are quiet ones: a guard deleted leaves inside paths
// carding (the storm this change exists to end) or outside paths sliding by.
// A green suite proves nothing about either until each rule is broken on
// purpose and a test goes red for it.
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-workspace-boundary-guards.js            # report
//   node test/tools/mutate-workspace-boundary-guards.js --markdown # as a table
//
// The files are restored afterwards, including when a run throws. Same shape
// as the sibling harnesses, deliberately a separate copy: see
// mutate-routines-guards.js for the reason.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const {
  beginMutationRun, targetsFromRows, rowsForShard, exitCodeFor, NO_VERDICT,
} = require('./mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');

const HOOK = { src: path.join(ROOT, 'scripts', 'permission-hook.js'), suite: 'test/unit/workspace-boundary.test.js' };
const SCAFFOLD = { src: path.join(ROOT, 'lib', 'workspace', 'scaffold.js'), suite: 'test/unit/workspace-boundary.test.js' };
const BOUNDARY = { src: path.join(ROOT, 'lib', 'workspace', 'boundary.js'), suite: 'test/unit/workspace-boundary.test.js' };
const CHAT_VIEW = { src: path.join(ROOT, 'public', 'views', 'chat.js'), suite: 'test/unit/boundary-card.test.js' };
// Same file as HOOK, a different suite: the attach site this target's own
// mutation breaks is never called by the unit suite (which tests
// classifyFileAccess and card rendering each in isolation), only by the
// real hook process the integration suite spawns.
const HOOK_INTEGRATION = { src: path.join(ROOT, 'scripts', 'permission-hook.js'), suite: 'test/integration/boundary-permissions.test.js' };
// Same file as HOOK again, a third suite: the outright refusals are pure
// predicates tested on their own, away from the classifier corpus the
// workspace-boundary suite drives, so a mutation to either is invisible
// there and only this suite can notice it.
const HOOK_REFUSAL = { src: path.join(ROOT, 'scripts', 'permission-hook.js'), suite: 'test/unit/permission-agent-guard.test.js' };
// The classifier's own suite. The hook is paired with several suites because
// different guards in it are driven from different places, and a mutation is
// only proved by the suite that actually exercises it: pointing a row at the
// wrong one reports that nothing broke, which reads exactly like a guard
// nothing tests. That is how the credential-folder rows first came back empty.
const HOOK_CLASSIFIER = { src: path.join(ROOT, 'scripts', 'permission-hook.js'), suite: 'test/unit/boundary.test.js' };
// The read-only definition the hook reads, and the client risk grader with
// it. It moved out of the hook when the two graders stopped keeping separate
// answers to the same question; the rows below still drive the hook's suite,
// because that is where breaking a read-only rule shows up as a crossing that
// cards or one that stops carding.
const READ_ONLY = { src: path.join(ROOT, 'public', 'read-only-shell.js'), suite: 'test/unit/workspace-boundary.test.js' };
// Same file, the other suite. Not every rule in the shared module is proven by
// the boundary corpus: the package-runner rules, the vocabulary's size, and the
// subshell guard are all driven from test/unit/permissions.test.js, which is
// where the tests that drive BOTH graders over one command live. A row here
// belongs to the suite that actually notices it, not to the file's usual one.
const READ_ONLY_CLIENT = { src: path.join(ROOT, 'public', 'read-only-shell.js'), suite: 'test/unit/permissions.test.js' };
// The mode-persisted-before-scaffold ordering guard lives in the protocol
// handler, not the scaffold layer, and is reachable only through the real
// workspace-open path (the scaffold-layer tests call scaffoldWorkspace
// directly and so never see this file's own ordering at all).
const WORKSPACE_HANDLER = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'workspace.js'), suite: 'test/integration/ws-handler-edges.test.js' };
// Same file as WORKSPACE_HANDLER, a different suite: the mode-switch
// atomicity guards are proven by protocol-handlers-lib.test.js's own
// read-back, not anything ws-handler-edges.test.js asserts.
const WORKSPACE_HANDLER_UNIT = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'workspace.js'), suite: 'test/unit/protocol-handlers-lib.test.js' };
// The switch that keeps agents inside the workspace: where it is read from, the
// new-workspace default, and the open-path reconcile that honours it.
const SCAFFOLD_SWITCH = { src: path.join(ROOT, 'lib', 'workspace', 'scaffold.js'), suite: 'test/unit/sandbox-switch.test.js' };
const WORKSPACE_HANDLER_SWITCH = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'workspace.js'), suite: 'test/unit/sandbox-switch.test.js' };
// What the Permissions row reports as in force, and the switch's own writes.
const SANDBOX_STATUS = { src: path.join(ROOT, 'lib', 'workspace', 'sandbox-status.js'), suite: 'test/unit/sandbox-status.test.js' };
// Bringing a person's own rules in: the review, the digest, the import.
const SANDBOX_IMPORT = { src: path.join(ROOT, 'lib', 'workspace', 'sandbox-status.js'), suite: 'test/unit/sandbox-import.test.js' };
// The one normalizer every reader of the stored mode goes through.
const MODE = { src: path.join(ROOT, 'lib', 'workspace', 'mode.js'), suite: 'test/unit/workspace-mode-values.test.js' };
// The Permissions pane: the label, the turn-off question, and the row model.
const NOTES_LABEL = { src: path.join(ROOT, 'public', 'views', 'settings.js'), suite: 'test/unit/notes-mode-label.test.js' };
const PERMISSIONS_PANE = { src: path.join(ROOT, 'public', 'views', 'settings.js'), suite: 'test/unit/permissions-pane.test.js' };
const SANDBOX_ROW = { src: path.join(ROOT, 'public', 'sandbox-row-model.js'), suite: 'test/unit/sandbox-row-model.test.js' };
// A block a person wrote is never rewritten by any path but bringing it in.
// Every class the panes render has a rule behind it.
const SETTINGS_SURFACE = { src: path.join(ROOT, 'public', 'styles', 'views', 'settings.css'), suite: 'test/unit/settings-surface.test.js' };
const SCAFFOLD_FOREIGN = { src: path.join(ROOT, 'lib', 'workspace', 'scaffold.js'), suite: 'test/unit/foreign-sandbox-notice.test.js' };
// The desktop app's own wiring, watched by the run that launches the shipped
// entrypoint beside the browser and compares the Permissions row. A
// suite under test/electron/ is that run: its JSON report names each
// expectation that failed (see redTests).
const DESKTOP = { src: path.join(ROOT, 'electron', 'main.js'), suite: 'test/electron/settings-parity.cjs' };
// The profile the desktop run starts on, and the entrypoint's use of it.
const USER_DATA = { src: path.join(ROOT, 'electron', 'user-data.js'), suite: 'test/unit/user-data.test.js' };
const DESKTOP_PROFILE = { src: path.join(ROOT, 'electron', 'main.js'), suite: 'test/unit/user-data.test.js' };
// The same entrypoint, watched by the run that launches it with an absolute
// and then a relative RUNDOCK_USER_DATA_DIR and reads what the running app
// reports and leaves on disk.
const DESKTOP_PROFILE_RUN = { src: path.join(ROOT, 'electron', 'main.js'), suite: 'test/electron/user-data-entrypoint.cjs' };

// ===== CODE MODE KEEPS ITS PROMISE FOR DEVELOPMENT WORK =====
// The verdict, the boundary corrections, the development paths, the card and
// Codex grading. Each row names the rule it breaks; together they prove both
// sides of the line are load-bearing.
const VERDICT = { src: path.join(ROOT, 'scripts', 'code-mode-verdict.js'), suite: 'test/unit/code-mode-verdict.test.js' };
const VERDICT_HOOK = { src: path.join(ROOT, 'scripts', 'code-mode-verdict.js'), suite: 'test/unit/code-mode-hook.test.js' };
const CM_HOOK = { src: path.join(ROOT, 'scripts', 'permission-hook.js'), suite: 'test/unit/code-mode-hook.test.js' };
const CM_BOUNDARY = { src: path.join(ROOT, 'scripts', 'permission-hook.js'), suite: 'test/unit/code-mode-boundary.test.js' };
const CM_DEV = { src: path.join(ROOT, 'scripts', 'dev-paths.js'), suite: 'test/unit/code-mode-hook.test.js' };
const CM_CLIENT = { src: path.join(ROOT, 'public', 'permissions.js'), suite: 'test/unit/code-mode-card.test.js' };
const CM_CODEX = { src: path.join(ROOT, 'lib', 'runtime', 'codex-approval.js'), suite: 'test/unit/codex-escalation-grading.test.js' };
const CM_GLUE = { src: path.join(ROOT, 'lib', 'runtime', 'codex-glue.js'), suite: 'test/unit/codex-escalation-grading.test.js' };
const CM_CODEX_BOUNDARY = { src: path.join(ROOT, 'lib', 'runtime', 'codex-approval.js'), suite: 'test/unit/code-mode-boundary.test.js' };
const CARD_CSS = { src: path.join(ROOT, 'public', 'styles', 'views', 'chat.css'), suite: 'test/unit/permission-card-contrast.test.js' };
const CARD_TOKENS = { src: path.join(ROOT, 'public', 'styles', 'tokens.css'), suite: 'test/unit/permission-card-contrast.test.js' };
const CM_APPSERVER = { src: path.join(ROOT, 'codex-appserver.js'), suite: 'test/unit/codex-escalation-grading.test.js' };
const CM_ANSWER_GUARD = { src: path.join(ROOT, 'lib', 'workspace', 'answer-file-guard.js'), suite: 'test/unit/codex-answer-file-guard.test.js' };
const CM_ANSWER_GUARD_GLUE = { src: path.join(ROOT, 'lib', 'runtime', 'codex-glue.js'), suite: 'test/unit/codex-answer-file-guard.test.js' };
// A word only known when the line runs, through each route that grades it.
const VERDICT_CODEX = { src: path.join(ROOT, 'scripts', 'code-mode-verdict.js'), suite: 'test/unit/codex-escalation-grading.test.js' };
// The answer-file guard around Claude turns, and the spawn point that starts it.
const CLAUDE_TURN_GUARD = { src: path.join(ROOT, 'lib', 'runtime', 'claude-turn-guard.js'), suite: 'test/unit/claude-answer-file-guard.test.js' };
const CLAUDE_SPAWN = { src: path.join(ROOT, 'lib', 'runtime', 'claude.js'), suite: 'test/unit/claude-answer-file-guard.test.js' };
const DEV_HOME = { src: path.join(ROOT, 'scripts', 'dev-paths.js'), suite: 'test/unit/code-mode-home-in-temp.test.js' };
const SCAFFOLD_CM = { src: path.join(ROOT, 'lib', 'workspace', 'scaffold.js'), suite: 'test/unit/code-mode-boundary.test.js' };
const CM_PARSE = { src: path.join(ROOT, 'scripts', 'code-mode-parse.js'), suite: 'test/unit/code-mode-verdict.test.js' };
// Telling the agent in the same step: the PostToolUse half, end to end.
const PUTBACK_HOOK = { src: path.join(ROOT, 'scripts', 'permission-hook.js'), suite: 'test/unit/putback-same-step.test.js' };
const PUTBACK_ROUTER = { src: path.join(ROOT, 'lib', 'http-router.js'), suite: 'test/unit/putback-same-step.test.js' };
const PUTBACK_GUARD = { src: path.join(ROOT, 'lib', 'workspace', 'answer-file-guard.js'), suite: 'test/unit/putback-same-step.test.js' };
const PUTBACK_SCAFFOLD = { src: path.join(ROOT, 'lib', 'workspace', 'scaffold.js'), suite: 'test/unit/putback-same-step.test.js' };
// The put-back card: what the glue sends, the field the server passes on, the
// card the view draws, and its copy.
const PUTBACK_GLUE = { src: path.join(ROOT, 'lib', 'runtime', 'codex-glue.js'), suite: 'test/unit/codex-answer-file-guard.test.js' };
const PUTBACK_SERVER = { src: path.join(ROOT, 'server.js'), suite: 'test/unit/putback-card.test.js' };
const PUTBACK_VIEW = { src: path.join(ROOT, 'public', 'views', 'chat.js'), suite: 'test/unit/putback-card.test.js' };
const PUTBACK_COPY = { src: path.join(ROOT, 'public', 'permissions.js'), suite: 'test/unit/putback-card.test.js' };
const CM_FIXTURE = { src: path.join(ROOT, 'test', 'helpers', 'code-mode-fixture.js'), suite: 'test/unit/code-mode-fixture-root.test.js' };
// The handler that stores "Always allow" answers, driven through the real dispatch table.
const ALLOW_KEY_HANDLER = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'workspace.js'), suite: 'test/unit/rule-key-allows.test.js' };
// Telling the agent its change was put back: the hook that hands the line over,
// and the glue that leaves it, each driven by the suite that notices it.
const AGENT_NOTICE_HOOK = { src: path.join(ROOT, 'scripts', 'permission-hook.js'), suite: 'test/unit/agent-restore-notice.test.js' };
const AGENT_NOTICE_CLAUDE = { src: path.join(ROOT, 'lib', 'runtime', 'codex-glue.js'), suite: 'test/unit/claude-answer-file-guard.test.js' };
const AGENT_NOTICE_ROUTER = { src: path.join(ROOT, 'lib', 'http-router.js'), suite: 'test/unit/agent-restore-notice.test.js' };
const AGENT_NOTICE_STORE = { src: path.join(ROOT, 'lib', 'runtime', 'agent-notices.js'), suite: 'test/unit/agent-restore-notice.test.js' };
// After a refusal, the agent is told in the same step to stop and ask: the
// hook that answers, the line and what counts as a sandbox block, the hook's
// registration.
const STOP_ASK_HOOK = { src: path.join(ROOT, 'scripts', 'permission-hook.js'), suite: 'test/unit/stop-and-ask.test.js' };
const STOP_ASK_LINE = { src: path.join(ROOT, 'scripts', 'refusal-notice.js'), suite: 'test/unit/stop-and-ask.test.js' };
const STOP_ASK_SCAFFOLD = { src: path.join(ROOT, 'lib', 'workspace', 'scaffold.js'), suite: 'test/unit/stop-and-ask.test.js' };
// Reading a permission file is not a change to it.
const ANSWER_READS_HOOK = { src: path.join(ROOT, 'scripts', 'permission-hook.js'), suite: 'test/unit/answer-file-reads.test.js' };
const ANSWER_READS_VOCAB = { src: path.join(ROOT, 'public', 'read-only-shell.js'), suite: 'test/unit/answer-file-reads.test.js' };
// A refused "Always allow" is shown, and dropped from the view's cache.
const ALLOW_FAIL_VIEW = { src: path.join(ROOT, 'public', 'views', 'chat.js'), suite: 'test/unit/standing-allows-client.test.js' };

// The door in front of every card: a request reaches the permission bridge
// only from this machine's own page or process (lib/local-origin.js), wired
// into the HTTP server and the WebSocket upgrade in server.js. Both watched by
// the suite that sends foreign Hosts and Origins at a booted server.
const LOCAL_ORIGIN = { src: path.join(ROOT, 'lib', 'local-origin.js'), suite: 'test/integration/local-origin.test.js' };
const LOCAL_ORIGIN_DOOR = { src: path.join(ROOT, 'server.js'), suite: 'test/integration/local-origin.test.js' };
// Only Rundock's own window drives the server (lib/auth): the one question,
// the door in server.js that asks it, the routes that need no key, the hook's
// own tokens, writes that never leave through a link, the key kept out of the
// agent's environment, and the desktop window's header. Each watched by the
// attack suite that makes the request any other process would make, or by the
// unit suite for the pieces it cannot reach.
const ATTACK = 'test/integration/attack/control-connection.test.js';
const AUTH = { src: path.join(ROOT, 'lib', 'auth', 'index.js'), suite: ATTACK };
const AUTH_UNIT = { src: path.join(ROOT, 'lib', 'auth', 'index.js'), suite: 'test/unit/control-auth.test.js' };
const AUTH_DOOR = { src: path.join(ROOT, 'server.js'), suite: ATTACK };
const AUTH_ROUTER = { src: path.join(ROOT, 'lib', 'http-router.js'), suite: ATTACK };
const AUTH_ROUTES = { src: path.join(ROOT, 'lib', 'http-router.js'), suite: 'test/unit/control-auth.test.js' };
const AUTH_FILES = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'files.js'), suite: ATTACK };
const AUTH_LINK = { src: path.join(ROOT, 'lib', 'workspace', 'link-safe-write.js'), suite: 'test/unit/control-auth.test.js' };
const AUTH_SPAWN = { src: path.join(ROOT, 'lib', 'runtime', 'claude.js'), suite: ATTACK };
const AUTH_HOOK = { src: path.join(ROOT, 'scripts', 'permission-hook.js'), suite: 'test/integration/boundary-permissions.test.js' };
const AUTH_WINDOW = { src: path.join(ROOT, 'electron', 'window-key.js'), suite: 'test/unit/control-auth.test.js' };
const AUTH_SIGNIN = { src: path.join(ROOT, 'public', 'sign-in-model.js'), suite: 'test/unit/control-auth.test.js' };
// The key the Windows launcher makes and hands over, consumed and never echoed.
const LAUNCHER = { src: path.join(ROOT, 'lib', 'auth', 'index.js'), suite: 'test/unit/launcher-code.test.js' };
const LAUNCHER_BANNER = { src: path.join(ROOT, 'server.js'), suite: 'test/unit/launcher-code.test.js' };
// What a browser holds: one-time codes, session tokens sent as a header, the
// media cookie, and the desktop app accepting none of them.
const BROWSER_ATTACK = { src: path.join(ROOT, 'lib', 'auth', 'index.js'), suite: 'test/integration/attack/browser-session.test.js' };
const DESKTOP_AUTH = { src: path.join(ROOT, 'lib', 'auth', 'index.js'), suite: 'test/unit/desktop-auth.test.js' };
// A link only when the person asks; the launcher's own status; the page's
// policy; and the suite keeping its fixtures out of the checkout's stores.
const LINK_ON_REQUEST = { src: path.join(ROOT, 'lib', 'auth', 'index.js'), suite: 'test/unit/link-on-request.test.js' };
const PAGE_POLICY = { src: path.join(ROOT, 'lib', 'http-router.js'), suite: 'test/integration/page-policy.test.js' };
const STORE_ISOLATION = { src: path.join(ROOT, 'test', 'helpers', 'approvals.js'), suite: 'test/unit/test-store-isolation.test.js' };
const BROWSER_DOOR = { src: path.join(ROOT, 'server.js'), suite: 'test/integration/attack/browser-session.test.js' };
const MEDIA_ROUTER = { src: path.join(ROOT, 'lib', 'http-router.js'), suite: 'test/integration/attack/browser-session.test.js' };

const MUTATIONS = [
  // ===== ONE DIRECTORY UNDER TWO NAMES IS ONE IDENTITY =====
  // Compare unresolved again and every symlink, alias and case spelling of
  // an inside path reads as outside: the false-positive half of the storm.
  [HOOK, 'file targets are canonicalised before the comparison',
    '  const resolvedPath = canonicalize(path.resolve(workspaceRoot, target), path, resolvedPathFoldsCase);',
    '  const resolvedPath = path.resolve(workspaceRoot, target);'],
  // The refusal and the tier classifier decide the same paths, so they must
  // decide them the same way. Drop the folding here and only here, and a
  // variant spelling misses the refusal, falls through, and is offered as an
  // ordinary approvable card: the two answers disagree about one path, which
  // is how the escape existed in the first place. The enclosing line is part
  // of the guard because the comparison itself is written identically in the
  // classifier, and a guard that matches twice proves nothing about either.
  [HOOK, 'the outright refusal folds case exactly as the tier classifier does',
    '  return REFUSED_CLAUDE_EDIT_DIRS.some(d => {\n'
    + '    const dir = foldCase(canonicalize(path.join(root, d)), foldsCase);\n',
    '  return REFUSED_CLAUDE_EDIT_DIRS.some(d => {\n'
    + '    const dir = canonicalize(path.join(root, d));\n'],
  // Drop the refusal and a write to commands/, hooks/, plugins/ or
  // settings.json is offered an "Approve always" the runtime overrules
  // underneath, which is the false promise this rule removes.
  [HOOK_REFUSAL, 'a persistence-surface write under the runtime home is refused, not carded',
    '  return isPersistenceSurface(resolved, home, foldsCase);',
    '  return false;'],
  // Cover reads as well and listing the global agents and skills breaks,
  // which is the capability the freeing tier exists to give.
  [HOOK_REFUSAL, 'the runtime-home surface refusal covers edits only, never reads',
    'function isRuntimeHomeSurfaceEdit(toolName, toolInput, home = os.homedir(), foldsCase = hostFoldsCase()) {\n'
    + '  if (!CLAUDE_EDIT_TOOLS.has(toolName)) return false;',
    'function isRuntimeHomeSurfaceEdit(toolName, toolInput, home = os.homedir(), foldsCase = hostFoldsCase()) {\n'
    + '  if (false) return false;'],
  // Put either refusal back behind Code mode and the hole returns: a refused
  // edit is tagged as no crossing at all, Code mode auto-approves anything not
  // tagged outside, and a write to the GLOBAL agents folder is allowed, lands
  // where the app never reads, and reports success.
  // Drop the workspace exemption and anyone who opens a workspace under the
  // runtime home has every ordinary write in it refused outright, with no card
  // and no way past.
  [HOOK_INTEGRATION, 'a target inside the open workspace is never refused, even under the runtime home',
    '  const targetInsideWorkspace = refusalTarget !== null\n'
    + '    && insideWorkspaceRoot(refusalTarget, wsRoot);',
    '  const targetInsideWorkspace = false;'],
  // THE OTHER DIRECTION OF THE SAME LINE, and the one that protects a tier
  // rather than a capability. Widen the exemption back to the named folders
  // and someone who names `~` has both refusals stop looking at the runtime
  // home entirely: a write to the global agents folder is allowed, lands where
  // the app never reads, and reports success, which is the silent failure the
  // refusals exist to prevent.
  // The mutation deliberately bypasses namedFolderCovers rather than calling
  // it. Calling it proves NOTHING, measured: that function stops at the runtime
  // home itself, so a refusal target under `~/.claude` is false either way and
  // the mutated build behaves identically. The two rules are defence in depth
  // over the same paths, which is worth having and makes each harder to test
  // alone. So this row widens the exemption the way a careless edit actually
  // would, by comparing against the named folders raw.
  [HOOK_INTEGRATION, 'a named working folder never exempts the refusals, only the open workspace does',
    '    && insideWorkspaceRoot(refusalTarget, wsRoot);',
    '    && (insideWorkspaceRoot(refusalTarget, wsRoot) || extraDirs.some(d => isUnder(refusalTarget, canonicalize(d))));'],
  // Only the surface refusal is mutated for this rule, and deliberately so.
  // `agents/` and `skills/` are persistence surfaces as well, so gating the
  // agents-and-skills refusal alone changes no verdict: the surface refusal
  // below it catches the same paths and still denies. The overlap is real
  // protection, but it means that mutation proves nothing on its own, and a
  // row that proves nothing is worse than no row because it reads as coverage.
  // The ordering rule these two share is proven by the one that can move a
  // verdict.
  [HOOK_INTEGRATION, 'Code mode cannot answer the runtime-home surface refusal',
    '  if (!targetInsideWorkspace && isRuntimeHomeSurfaceEdit(data.tool_name, data.tool_input)) {',
    "  if (process.env.RUNDOCK_CODE_MODE !== '1' && !targetInsideWorkspace && isRuntimeHomeSurfaceEdit(data.tool_name, data.tool_input)) {"],
  [HOOK, 'the workspace root is canonicalised, or a symlink-opened workspace denies its own files',
    '  return isUnder(resolvedPath, canonicalize(workspaceRoot, pmod), pmod);',
    '  return isUnder(resolvedPath, pmod.resolve(workspaceRoot), pmod);'],
  // The same rule for a named folder, which reaches the boundary by a
  // different route and so needs its own row: a folder named through a symlink
  // (a Dropbox or iCloud path, routinely) would otherwise cover nothing at all,
  // and the storm this card exists to end would carry on with the setting
  // apparently configured.
  [HOOK, 'a named folder is canonicalised too, or naming a symlinked folder covers nothing',
    "    const named = canonicalize(d, pmod);\n    if (!isUnder(resolvedPath, named, pmod)) return false;",
    "    const named = pmod.resolve(d);\n    if (!isUnder(resolvedPath, named, pmod)) return false;"],
  // THE LOAD-BEARING ROW OF THIS CARD. Remove the runtime-home stop and a
  // single named ancestor, `~` above all, makes `.credentials.json` compare as
  // inside and be allowed outright: not carded, not graded, the secrets tier
  // never consulted. One folder named for an unrelated reason would switch off
  // the tier protecting the one thing most worth protecting.
  // THE THIRD THING THE CRITERIA NAME, and the four rows above did not cover it:
  // a named folder must not reach an UNNAMED sibling. Widened to always true, a
  // named folder covers the whole machine; widened to a bare string prefix,
  // `/Projects-old` falls inside `/Projects` because the separator stops being
  // part of the comparison. Both are the classic way this check goes wrong and
  // neither was proven to turn anything red.
  [HOOK, 'a named folder covers only what it names, never an unnamed sibling',
    "    if (!isUnder(resolvedPath, named, pmod)) return false;",
    "    if (false) return false;"],
  [HOOK, 'the separator is part of the comparison, or a lookalike sibling reads as inside',
    "    if (!isUnder(resolvedPath, named, pmod)) return false;",
    "    if (!resolvedPath.startsWith(named)) return false;"],
  // The stop compares BOTH SIDES resolved. Drop the canonicalisation of the home
  // root and a runtime home whose .claude is a link elsewhere stops being
  // recognised as the runtime home at all, so a named ancestor of its real
  // target reaches the secrets tier through the back door.
  [HOOK, 'the runtime-home root in the stop is canonicalised, like the folders it is compared against',
    'function agentHomeRoot(home = os.homedir()) {\n  return canonicalize(path.join(home, \'.claude\'));',
    'function agentHomeRoot(home = os.homedir()) {\n  return path.join(home, \'.claude\');'],
  [HOOK, 'a named folder stops at EITHER runtime home, so the tiers still decide there',
    '  if (homeFor(resolvedPath, home, foldsCase)) return false;',
    '  if (false) return false;'],
  // A grant stored under one spelling must cover the other, both directions.
  [BOUNDARY, 'grants are canonicalised on write and on read',
    '  const t = canonicalize(targetPath);',
    '  const t = path.resolve(targetPath);'],
  // The two calls mask each other in a fixture that only ever writes through
  // addBoundaryGrant (which already canonicalises on write): removing the
  // read-side call alone needs a grant stored under its raw, uncanonicalised
  // spelling to notice, which is exactly what the dedicated read-side test
  // writes directly to the grants file.
  [BOUNDARY, 'a stored grant is canonicalised again on read, for the ones written before write-side canonicalisation existed',
    '    const g = canonicalize(d);',
    '    const g = d;'],

  // ===== THE BLOCK NAMES THE MEASURED PLUMBING =====
  // Drop the runtime home from the measured roots and the field storm is
  // back; the shape test and the doc binding both have to notice.
  [SCAFFOLD, 'the runtime home is a measured writable root',
    "    path.posix.join(home, '.claude'),\n",
    ''],
  // Refuse the legacy shape and every workspace the two-root release wrote
  // treats its own block as a person's edit, denying the plumbing forever.
  [SCAFFOLD, 'the two-root release\'s block is still recognised as ours',
    '  if (sameSandbox(block, legacySandboxSettings(claimedWorkspace, claimedHome))) return true;\n',
    ''],
  // Demand this machine's exact temp tail and a workspace opened on another
  // machine is never recognised, so it never reconciles.
  [SCAFFOLD, 'another machine\'s temp tail is ours to reconcile, not a stranger\'s edit',
    "  if (!tail.every(t => typeof t === 'string' && t.length > 0)) return false;",
    '  if (JSON.stringify(tail) !== JSON.stringify(tempRoots())) return false;'],
  // Drop the pairing check and a root a person appends, sitting in the
  // second tail slot, is structurally indistinguishable from a legitimate
  // temp-directory real path: the block is read as ours and their root is
  // rewritten away on the next reconcile. The pairing check itself is a
  // general real-path-spelling test (ends-with), not only the literal
  // /private case, so a non-/private relocation is recognised too.
  // The real-path pairing guard is GONE, and its mutation with it. It read a
  // second tail entry as a temp root only when it ended with the first, which
  // was how an appended root was told from ours. The list now carries the
  // folders a person named, so a second entry is as likely to be one of those
  // as a temp spelling, and no rule separates them. What replaced it is the
  // head: six entries in fixed positions, rebuilt from the block's own claimed
  // workspace and home, and mutated by the zero-tail entry below. The cost is
  // recorded in lib/workspace/scaffold.js beside the check that remains.
  // A corrupt or unreadable settings.local.json must not be silently
  // replaced with {}. Only ENOENT may start empty; drop that distinction and
  // every other read/parse failure quietly overwrites the file instead of
  // being surfaced.
  [SCAFFOLD, 'only a genuinely absent settings file may start the reconcile from {}',
    "    if (e.code !== 'ENOENT') throw new Error(`could not read ${settingsLocalPath}: ${e.message}`);\n",
    ''],

  // ===== THE BLOCK IS DRIVEN BY MODE, AND ONLY BY MODE =====
  // Ignore the mode and the switch writes the block for code mode too.
  [SCAFFOLD, 'the mode switch really drops the enable in code mode, rather than writing the enabled shape',
    "  const desired = sandboxSettings(dir, platform, os.homedir(), tempRoots(), workingFoldersFor(dir), mode);",
    "  const desired = sandboxSettings(dir, platform, os.homedir(), tempRoots(), workingFoldersFor(dir), 'knowledge');"],
  // ===== THE SWITCH IS STORED, AND THE MODE DOES NOT DECIDE IT =====
  // The next open must write the stored switch. Hard-wire the on shape and a
  // workspace whose switch is off has it turned back on every time it opens.
  [SCAFFOLD_SWITCH, 'the next open writes the stored switch, not a fixed shape',
    "    const desired = sandboxSettings(dir, platform, os.homedir(), tempRoots(), workingFoldersFor(dir), sandboxShapeFor(dir));",
    "    const desired = sandboxSettings(dir, platform, os.homedir(), tempRoots(), workingFoldersFor(dir), 'on');"],
  // A stored switch wins over the mode. Drop the stored branch and every
  // workspace falls back to what its mode implies, which is the coupling this
  // switch exists to end.
  [SCAFFOLD_SWITCH, 'a stored switch wins over what the mode implies',
    "  if (st.sandboxSwitch === 'on' || st.sandboxSwitch === 'off') return { on: st.sandboxSwitch === 'on', stored: true };\n",
    ''],
  // Absent, the switch is what the mode always implied. Read it as always on
  // and every Code-mode workspace that predates the switch has its block
  // rewritten on the next open.
  [SCAFFOLD_SWITCH, 'an absent switch reads as what the mode implied, so no existing block is rewritten',
    "  return { on: normalizeWorkspaceMode(st.workspaceMode) !== 'code', stored: false };",
    "  return { on: true, stored: false };"],
  // The new-workspace default is on, in one named place.
  [SCAFFOLD_SWITCH, 'a workspace new to Rundock starts with the switch on',
    "const NEW_WORKSPACE_SANDBOX_SWITCH = 'on';",
    "const NEW_WORKSPACE_SANDBOX_SWITCH = 'off';"],
  // A first open must record the switch, not only the mode, or a later mode
  // change is free to move it.
  [WORKSPACE_HANDLER, 'a first open records the switch before scaffolding, not only the mode',
    "  const state = recordFirstOpen(dir);\n\n  try { scaffoldWorkspace(dir); }",
    "  const state = readState();\n\n  try { scaffoldWorkspace(dir); }"],

  // ===== THE ROW SAYS WHAT IS IN FORCE =====
  // Read the stored preference instead of the disk and a switch that says on
  // beside a block that says off is reported On.
  [SANDBOX_STATUS, 'the effective state is read from the files on disk, not the stored switch',
    '    on: available && effective,',
    '    on: available && sandboxSwitchFor(dir).on,'],
  // The shipped runtime ORs the enable across layers: count only Rundock's
  // block and a sandbox the user's own settings turn on is reported Off.
  [SANDBOX_STATUS, 'any layer that turns the sandbox on keeps the row On',
    '  const effective = blockOn || managedOn || enabledElsewhere.length > 0;',
    '  const effective = blockOn;'],
  // Managed settings that turn it on are shown as the organisation's.
  [SANDBOX_STATUS, 'managed settings that turn it on are named as the organisation\'s',
    "  const setBy = managedOn ? 'managed' :",
    "  const setBy = false ? 'managed' :"],
  // Drop the restore and a failed flip leaves the stored switch and the block
  // disagreeing.
  [SANDBOX_STATUS, 'a failed switch write restores both files',
    "    reconcileSandboxForMode(dir, on ? 'on' : 'off', platform);\n  } catch (e) {\n    restore(snaps);\n    throw e;",
    "    reconcileSandboxForMode(dir, on ? 'on' : 'off', platform);\n  } catch (e) {\n    throw e;"],
  // Drop the ownership refusal and the switch writes over a block a person wrote.
  [SANDBOX_STATUS, 'the switch refuses a hand-authored block',
    "  if (!status.managed) throw new Error('this workspace\\'s sandbox was set up outside Rundock.');\n",
    ''],
  // A hand-authored block never gets the notice: mode never moved it.
  [SANDBOX_STATUS, 'no one-time notice for a hand-authored block',
    '    notice: available && present && managed && !stored ?',
    '    notice: available && present && !stored ?'],

  // ===== A PERSON'S OWN RULES COME IN ONLY AS REVIEWED =====
  // Drop the digest check and a file edited after the review is brought in
  // unseen.
  [SANDBOX_IMPORT, 'only the file the person reviewed is brought in',
    "  if (digest !== review.digest) throw new Error('your settings file has changed since you reviewed it. Review it again.');\n",
    ''],
  // Drop the restore and a failed import leaves the folders added and the
  // person's block in place, or the block replaced and no folders.
  [SANDBOX_IMPORT, 'a failed import restores both files',
    "    noteOwnWrite(settingsFile(dir), body);\n  } catch (e) {\n    restore(snaps);\n    throw e;",
    "    noteOwnWrite(settingsFile(dir), body);\n  } catch (e) {\n    throw e;"],
  // Drop the folder write and the folders the review promised are lost.
  [SANDBOX_IMPORT, 'the folders the review listed become working folders',
    '    writeWorkingFolders([...readWorkingFolders(), ...review.folders]);\n',
    ''],
  // Write the on shape regardless and an off block is switched on by the import.
  [SANDBOX_IMPORT, 'bringing rules in keeps what was in force',
    "    settings.sandbox = sandboxSettings(dir, platform, os.homedir(), tempRoots(), workingFoldersFor(dir), review.on ? 'on' : 'off');",
    "    settings.sandbox = sandboxSettings(dir, platform, os.homedir(), tempRoots(), workingFoldersFor(dir), 'on');"],
  // A rule Rundock cannot represent must be named, not silently skipped.
  [SANDBOX_IMPORT, 'every rule that cannot come is named in the review',
    "    if (key !== 'filesystem' || !value || typeof value !== 'object') { drop(key, value); continue; }",
    "    if (key !== 'filesystem' || !value || typeof value !== 'object') { continue; }"],

  // ===== THE STORED MODE IS READ ONE WAY =====
  // Let an unrecognised value lift the restriction and a garbled or future
  // value reaches every reader as Code. Red only if the readers really go
  // through the normalizer.
  [MODE, 'anything but code reads as the restrictive mode, at every reader',
    "  return raw === 'code' ? 'code' : 'notes';",
    "  return raw === 'notes' || raw === 'knowledge' || raw == null ? 'notes' : 'code';"],
  // A third writable value would be read by v0.9.0 to v0.14.0 as Notes
  // without anyone deciding it.
  [MODE, 'this build can write only notes and code',
    "const WRITABLE_MODES = Object.freeze(['notes', 'code']);",
    "const WRITABLE_MODES = Object.freeze(['notes', 'code', 'knowledge']);"],

  // ===== THE PERMISSIONS PANE =====
  // Let the reconcile overwrite a block it did not write and a person's own
  // rules are replaced without their acting.
  [SCAFFOLD_FOREIGN, 'the reconcile never rewrites a block a person wrote',
    '  if (ours && desired && !sameSandbox(settingsLocal.sandbox, desired)) {',
    '  if (desired && !sameSandbox(settingsLocal.sandbox, desired)) {'],
  // Delete a rule a rendered class needs and the element is left to inherit.
  [SETTINGS_SURFACE, 'every class the Permissions pane renders has a rule',
    '.sandbox-caption { margin-top: 4px; }',
    '.sandbox-captions { margin-top: 4px; }'],
  // ===== THE DESKTOP APP SHOWS THE SAME ROW =====
  // The shipped wiring the desktop run depends on, broken in electron/main.js
  // itself. Lose the main window's preload and the page is a browser page in
  // a desktop frame; unregister the storage handler and the preload's
  // snapshot never comes back.
  // Without the key its main process adds, the shipped window is refused by
  // its own server and shows only the line pointing to a link.
  [DESKTOP, "the desktop main window carries the key to its own server",
    '  installWindowKey(mainWindow.webContents.session, { port, key: auth.launchKey(), header: auth.KEY_HEADER });\n',
    ''],
  [DESKTOP, "the desktop main window loads the app's preload",
    "    ...chromeWindowOptions(),\n    webPreferences: {\n      preload: path.join(__dirname, 'preload.js'),",
    "    ...chromeWindowOptions(),\n    webPreferences: {\n      preload: path.join(__dirname, 'preload-missing.js'),"],
  [DESKTOP, "the desktop main process answers the preload's storage snapshot",
    "ipcMain.on('rundock-storage-snapshot', (event) => {",
    "ipcMain.on('rundock-storage-snapshot-unregistered', (event) => {"],
  // The desktop run's own profile: a value that cannot be used is refused,
  // and the refusal stops the app, rather than either falling back to the
  // person's real profile.
  [USER_DATA, 'a relative RUNDOCK_USER_DATA_DIR is refused, never read against the working directory',
    "  if (!path.isAbsolute(raw)) return { kind: 'invalid',",
    "  if (false) return { kind: 'invalid',"],
  [DESKTOP_PROFILE, 'a refused RUNDOCK_USER_DATA_DIR stops the app before it starts',
    "  process.exit(1);\n}\nif (userData.kind === 'path') {",
    "}\nif (userData.kind === 'path') {"],
  // The same two rules, proved on the running app rather than its source. The
  // resolved folder never applied leaves the app on the default profile;
  // the refusal printed but not acted on lets the app carry on to a window
  // and a profile of its own.
  [DESKTOP_PROFILE_RUN, 'the desktop app runs on the RUNDOCK_USER_DATA_DIR folder it resolved',
    "  app.setPath('userData', userData.path);",
    "  void userData.path;"],
  [DESKTOP_PROFILE_RUN, 'a relative RUNDOCK_USER_DATA_DIR stops the running app before a window, the server or any profile state',
    "Not starting.`);\n  process.exit(1);",
    "Not starting.`);"],
  // The mode is called Notes wherever a person reads it.
  [NOTES_LABEL, 'the Notes tab never reads Knowledge mode again',
    ">Notes</button>",
    ">Knowledge mode</button>"],
  // Turning off asks first. Skip the question and a click sends the write.
  [PERMISSIONS_PANE, 'turning the switch off asks before anything is sent',
    '  if (sandboxStatus && sandboxStatus.on) {\n    sandboxUi.confirming = true;',
    '  if (false) {\n    sandboxUi.confirming = true;'],
  // Escape answers the question the safe way.
  [PERMISSIONS_PANE, 'Escape keeps the switch on',
    "  if (event.key !== 'Escape') return;\n  event.preventDefault();\n  if (panel === 'confirm') sandboxKeepOn();",
    "  if (event.key !== 'Escape') return;\n  event.preventDefault();\n  if (panel === 'confirm') return;"],
  // A block a person wrote is read-only: nothing switch-shaped.
  [SANDBOX_ROW, 'a hand-authored block renders as a read-only status, not a switch',
    "      return row(state, 'lock', {\n        captions: lockedCaptions,\n        ownership: [{ text: 'Set up outside Rundock, in ' }",
    "      return row(state, 'switch', {\n        captions: lockedCaptions,\n        ownership: [{ text: 'Set up outside Rundock, in ' }"],
  // Windows has no sandbox to switch.
  [SANDBOX_ROW, 'Windows shows Unavailable with nothing to press',
    "  if (host === 'win32') return row('unavailable', 'none',",
    "  if (host === 'win32') return row('unavailable', 'switch',"],
  // A sentence about what Codex does only where Rundock detected it.
  [SANDBOX_ROW, 'the Codex sentence appears only where the config was read',
    "    const captions = cx.windowsSandbox === false ?",
    "    const captions = true ?"],
  // The folders' sentence must name the mode's real behaviour: Code mode only
  // asks about a command it can see reaching outside.
  [SANDBOX_ROW, 'the folders sentence for Code with the switch off says what Code mode really asks',
    "      return mode === 'code'\n",
    "      return false\n"],
  // Another file turning it on locks the row: Rundock's switch cannot turn it off.
  [SANDBOX_ROW, 'a sandbox another file turns on is read-only, not a switch',
    "      return row(state, 'lock', { captions: lockedCaptions, ownership, folders });",
    "      return row(state, 'switch', { captions: lockedCaptions, ownership, folders });"],
  // A workspace using both runtimes shows both rows.
  [SANDBOX_ROW, 'a Codex row joins the Claude Code row when both runtimes are in use',
    "    if (hasCodex) rows.push(",
    "    if (hasCodex && !hasClaude) rows.push("],

  // ===== THE AGENT'S OWN FOLDER: THREE TIERS, ONE REGISTRY =====
  // Drop the write gate and a persistence-surface write becomes free, the storm this tiering exists to end.
  [HOOK, 'a write to a persistence surface is not free the way a read is',
    '  if (tags.agentHome && !tags.secret && !(isWrite && tags.persistenceSurface)) {',
    '  if (tags.agentHome && !tags.secret) {'],
  // Both tags must come from the registry, not a hardcoded literal.
  [HOOK, 'a crossing\'s secret and persistence-surface tags come from the registry, not a hardcoded false',
    "  const tags = { agentHome: true, secret: isSecretPath(resolvedPath, home, foldsCase), persistenceSurface: isPersistenceSurface(resolvedPath, home, foldsCase) };",
    "  const tags = { agentHome: true, secret: false, persistenceSurface: false };"],
  // Drop tier three's exemption and a shell command merely touching scratch is reported as a crossing.
  [HOOK, 'a shell crossing into tier three (neither secret nor a persistence surface) is not reported at all',
    '    if (tags.agentHome && !tags.secret && (!tags.persistenceSurface || readOnly)) continue;',
    '    if (false) continue;'],
  // Drop the read-only re-grading and a command built entirely from `ls`,
  // `cat` and their neighbours cards against a persistence surface again,
  // the two-card storm this row exists to end.
  [HOOK, 'a persistence-surface shell crossing is freed by a read-only command, not only by staying in tier three',
    '(!tags.persistenceSurface || readOnly)',
    '(!tags.persistenceSurface)'],
  // Stop treating a lone `&` as a separator and `ls x & rm -rf x` is judged by
  // its leading word again, freeing the removal against a persistence surface.
  [READ_ONLY, 'a lone & separates commands, so the second cannot ride the first',
    "      if (ch === ';' || ch === '|' || ch === '&' || ch === '\\n' || ch === '\\r') {",
    "      if (ch === ';' || ch === '|' || ch === '\\n' || ch === '\\r') {"],
  // Stop stripping the discarding redirects and one `2>/dev/null` appended
  // to `ls` grades the whole command a WRITE again, which is the card a real
  // session was shown for a command that writes nothing.
  [READ_ONLY, 'a redirection that discards output does not disqualify a read-only command',
    "    var str = String(command).replace(DISCARDING_REDIRECT_RE, ' ');",
    '    var str = String(command);'],
  // Widen the exemption to any redirect target and the fail-safe inverts:
  // `ls x > x/listing.txt` writes into the surface and would read as free.
  [READ_ONLY, 'only /dev/null and descriptor duplication are exempt, never an arbitrary redirect target',
    'var DISCARDING_REDIRECT_RE = /\\d*>>?\\s*(?:\\/dev\\/null|&\\s*\\d+)/g;',
    'var DISCARDING_REDIRECT_RE = /\\d*>>?\\s*\\S+/g;'],
  // A command is read-only only if every leading word is actually in the
  // registry: drop the check and any command (a bare `rm`, included) reads
  // as free against a persistence surface.
  [READ_ONLY, 'a command is read-only only when the registry actually names its leading word',
    '    if (READ_ONLY_SHELL_COMMANDS.indexOf(first) >= 0) return true;\n'
    + '    if (NO_TARGET_COMMANDS.indexOf(first) >= 0) return true;\n'
    + '    if (READ_ONLY_POWERSHELL_COMMANDS.indexOf(first.toLowerCase()) >= 0) return true;\n'
    + '    return false;',
    '    return true;'],
  // A subshell the segmenter cannot see into hides whatever it runs. Drop the
  // test and `cd $(rm -rf ~/.claude/agents/x)` reads as a bare `cd`, and the
  // removal is exempted from its crossing rather than reported.
  [READ_ONLY_CLIENT, 'structure the segmenter cannot see into is never a read',
    '    if (HIDES_SUBCOMMAND.test(str)) return false;',
    ''],
  // The vocabulary grew by exactly one word. Put the card grader's old private
  // list back into it and `sort -o <persistence surface> payload` is graded a
  // read and exempted from its crossing, which is the write nobody sees.
  // `find` sat on the read-only registry with its flags unexamined. Drop the
  // allowlist and `find ~/.claude/hooks -delete` is graded a read again, its
  // crossing skipped, and in Code mode the hook scripts go with no card.
  [READ_ONLY_CLIENT, 'find is judged by its flags at all',
    "    if (first === 'find') return findOnlyReads(words.slice(1));",
    ''],
  // THE SHAPE, not the contents. Return true for an unrecognised flag and the
  // allowlist becomes a denylist of nothing: every write action this file does
  // not name, on every platform it does not run on, is waved through again.
  [READ_ONLY_CLIENT, 'a find flag nobody recognised fails closed rather than passing',
    '      return false;\n    }\n    return true;\n  }',
    '      continue;\n    }\n    return true;\n  }'],
  // Consume an operand after a flag that does not take one and an action is
  // swallowed as data: `find . -depth -delete` reads as a bare search again.
  [READ_ONLY_CLIENT, 'only a flag that always takes an operand consumes the word after it',
    '      if (FIND_READ_FLAGS_NO_OPERAND.indexOf(w) >= 0) continue;',
    '      if (FIND_READ_FLAGS_NO_OPERAND.indexOf(w) >= 0) { i++; continue; }'],
  [READ_ONLY_CLIENT, 'the shared vocabulary adds only the word the reported command needs',
    "  var NO_TARGET_COMMANDS = ['cd'];",
    "  const NO_TARGET_COMMANDS = ['cd', 'pushd', 'popd', 'true', 'date', 'diff',\n"
    + "    'printenv', 'sort', 'uniq', 'which', 'whoami'];"],
  // Drop the PowerShell half and Windows keeps the storm this release ended
  // on macOS: every Get-ChildItem under the runtime home grades as a write.
  [READ_ONLY, 'the read-only registry answers for PowerShell as well as the Unix shells',
    '    if (READ_ONLY_POWERSHELL_COMMANDS.indexOf(first.toLowerCase()) >= 0) return true;',
    ''],
  // Compare case-sensitively and half the spellings agents actually write
  // (get-childitem, GCI) stop being reads, because PowerShell is not.
  [READ_ONLY, 'PowerShell commands are compared case-insensitively, because PowerShell is',
    'READ_ONLY_POWERSHELL_COMMANDS.indexOf(first.toLowerCase()) >= 0',
    'READ_ONLY_POWERSHELL_COMMANDS.indexOf(first) >= 0'],
  // Every segment of a compound command must qualify, not merely one of
  // them: drop `every` for `some` and `ls x && rm -rf x` reads as free
  // because its first segment alone is a read.
  [READ_ONLY, 'every segment of a compound command must be read-only, not merely one of them',
    'segments.every(segmentReads)',
    'segments.some(segmentReads)'],
  // A write-shaped redirection makes an otherwise read-only leading command
  // write anyway: drop the check and `echo x > ~/.claude/hooks/y` reads as
  // free because `echo` alone is on the registry.
  [READ_ONLY, 'a write-shaped redirection disqualifies a command as read-only, whatever its leading words are',
    "    if (/>>?|\\btee\\b/.test(str)) return false;",
    ''],
  // The two rows that stood here guarded a package-runner exemption keyed on one
  // third-party tool's name and subcommand. The exemption is gone, so there is
  // nothing left to mutate: a runner is not a read, and the row below proves
  // that by the only thing that can, which is the fall-through answering false.
  // A registry path is recognised however it is spelled, including before it
  // exists: drop the fold on the CANDIDATE side (the fold on the registry's
  // own, already-lowercase names changes nothing, which is why this targets
  // the side that actually carries the variance) and a case variant of an
  // unborn registry folder escapes the comparison on a case-folding host.
  [HOOK, 'the case-fold seam actually folds the candidate before it is compared against the registry',
    'function isPersistenceSurface(candidate, home = os.homedir(), foldsCase = hostFoldsCase()) {\n'
    + '  if (typeof candidate !== \'string\' || !candidate) return false;\n'
    + '  const c = foldCase(canonicalize(candidate), foldsCase);',
    'function isPersistenceSurface(candidate, home = os.homedir(), foldsCase = hostFoldsCase()) {\n'
    + '  if (typeof candidate !== \'string\' || !candidate) return false;\n'
    + '  const c = canonicalize(candidate);'],
  // The registry is fail-loud in the code direction: a literal folder name
  // hardcoded alongside the registry's own, rather than reasoned from it,
  // must make an unregistered neighbour classify as governed.
  [HOOK, 'no folder is a persistence surface unless its own home\'s registry says so',
    '  return h.dirs.some(d => {',
    '  return [...h.dirs, \'projects\'].some(d => {'],
  // The registry is fail-loud in the doc direction too: a name removed from
  // the registry while the boundary passage still cites it must be caught,
  // not just the reverse.
  [HOOK, 'every persistence-surface directory the registry declares is bound to the architecture doc',
    "const PERSISTENCE_SURFACE_DIRS = ['agents', 'skills', 'plugins', 'commands', 'hooks', 'rules', 'output-styles'];",
    "const PERSISTENCE_SURFACE_DIRS = ['agents', 'skills', 'commands', 'hooks', 'rules', 'output-styles'];"],
  // settings.json is the one persistence-surface FILE, so the folder beside
  // its card is the runtime home root itself: drop the exclusion and
  // approving that card's "Always allow this folder" would silence every
  // later write to agents/, skills/, plugins/, commands/ and hooks/ too.
  [HOOK, 'no standing folder grant is offered when the grant directory would be the root of EITHER runtime home',
    '    || (tags.agentHome && runtimeHomes(home).some(h => grantDir === h.root))',
    '    || false'],
  // The credential-folder rule, mutated on its own so it is guarded by a test
  // rather than by the one beside it. Breaking it would put the one-click
  // blanket grant back on ~/.ssh and its kin, which is the whole point of it.
  [HOOK_CLASSIFIER, 'a hidden folder under home is never offered as a standing grant, on either card',
    "    || underHiddenHomeDir(grantDir, home)\n    // NEVER THE HOME DIRECTORY",
    "    || false\n    // NEVER THE HOME DIRECTORY"],
  [HOOK_CLASSIFIER, 'and the shell card refuses it too, so the two cards cannot disagree',
    '  if (underHiddenHomeDir(dir, home)) return null;',
    '  if (false) return null;'],
  // The one production site carrying classifyFileAccess's tags onto the emitted request.
  // Moved into boundaryCrossingsFor when that was extracted as a seam, so the
  // payload's own shape could be asserted rather than the classifier's return.
  // The guard follows the code: drop the tags and the request carries none.
  [HOOK_INTEGRATION, 'a file crossing\'s tags reach the request the hook actually emits',
    "    path: access.resolvedPath, grantDir: access.grantDir,\n    agentHome: access.agentHome, secret: access.secret,\n    persistenceSurface: access.persistenceSurface, answerFile: access.answerFile,\n",
    "    path: access.resolvedPath, grantDir: access.grantDir,\n"],
  // Drop the registry check and a broad grant silences the credential file inside it.
  [BOUNDARY, 'a secrets-registry crossing is covered by no stored grant, however broad',
    '  if (isSecretPath(crossing.path, home)) return false;',
    '  if (false) return false;'],
  [CHAT_VIEW, 'the whole-folder button is never offered for a secrets-tier crossing, nor where an answer file is among the places reached',
    '  const wholeFolderOffered = grantable\n'
    + '    && !(flaggedCrossing && (flaggedCrossing.secret || flaggedCrossing.answerFile))\n'
    + '    && !crossings.some(c => c && c.answerFile);',
    '  const wholeFolderOffered = grantable;'],
  [CHAT_VIEW, 'the agent-home copy is applied to the card\'s context',
    '    if (stakesCopy) context = crossings.length > 1 ? `${context} ${stakesCopy}` : stakesCopy;',
    '    if (false) context = crossings.length > 1 ? `${context} ${stakesCopy}` : stakesCopy;'],
  // The multi-crossing warning is COMPOSED with the stakes copy, not
  // replaced by it: dropping the ternary back to a plain overwrite is the
  // exact regression an earlier version shipped, where approving a command
  // that reached several places was no longer told it was approving all of them.
  [CHAT_VIEW, 'the multi-crossing warning survives alongside the agent-home stakes copy, rather than being overwritten by it',
    'crossings.length > 1 ? `${context} ${stakesCopy}` : stakesCopy;',
    'stakesCopy;'],

  // ===== MODE NEVER REACHES THE BLOCK =====
  // Re-couple the block to mode inside the mode handler and a mode change
  // rewrites the settings file, which is the coupling the switch ends.
  [WORKSPACE_HANDLER_UNIT, 'a mode change never rewrites the sandbox block',
    '    state.workspaceMode = mode;\n    writeState(state);\n',
    "    state.workspaceMode = mode;\n    writeState(state);\n    if (getWorkspace()) reconcileSandboxForMode(getWorkspace(), mode, platform);\n"],
  // Drop the pin and a workspace with no switch stored has it moved by the
  // mode on the next open.
  [WORKSPACE_HANDLER_SWITCH, 'the first mode change pins the switch the old mode implied',
    "    if (!current.stored) state.sandboxSwitch = current.on ? 'on' : 'off';\n",
    ''],

  // The lower length bound is the one that survives. The upper bound is gone
  // with the fixed-length tail: the list now carries the folders the user
  // named, so its length proves nothing. A block with NO tail at all is still
  // refused, and that is what stops a block a person trimmed the temp roots
  // out of being read as ours and regenerated over their edit.
  [SCAFFOLD, 'a tail of zero entries is rejected, so a block trimmed of its temp roots is not read as ours',
    '  if (roots.length < expectedHead.length + 1) return false;',
    ''],
  // The shape is read from the block, not assumed. Pinned because it is the
  // branch that lets a workspace which changed mode still recognise what it
  // wrote before: assume one shape and the other reads as a stranger's block,
  // which is a block Rundock can never rewrite or withdraw.
  [SCAFFOLD, 'which shape a block claims is read from the block, not assumed to be the enabled one',
    "  const claimedMode = block.enabled === true ? 'knowledge' : 'code';",
    "  const claimedMode = 'knowledge';"],
  // ===== CODE MODE: THE VERDICT, THE BOUNDARY CORRECTIONS AND CODEX =====
  [VERDICT, "M1: \"inside a git working tree\" always true",
    "    const top = ctx.seam.gitTop(scope);",
    "    const top = ctx.seam.gitTop(scope) || scope;"],
  [VERDICT, "M2: \"inside a git working tree\" always false",
    "    const top = ctx.seam.gitTop(scope);",
    "    const top = null;"],
  [VERDICT, "M3a: the unsaved-work check on a delete always reports clean",
    "    const lost = [...(st.tracked || []), ...(st.untracked || []), ...(st.ignoredEnv || [])];",
    "    const lost = [];"],
  [VERDICT, "M3b: the unsaved-work check on a discard always reports clean",
    "  return lost.length ? unsaved(reason, lost) : RUNS;",
    "  return RUNS;"],
  [VERDICT, "M4: the unsaved-work check always reports unsaved",
    "    if (lost.length) return unsaved('unsaved-work', lost);",
    "    return unsaved('unsaved-work', lost.length ? lost : ['x']);"],
  [VERDICT_HOOK, "M5: a git failure is treated as clean",
    "    const st = ctx.seam.gitStatus(top, specs, { env: true });\n    if (!st || !st.ok) return always('git-unchecked');",
    "    const st = ctx.seam.gitStatus(top, specs, { env: true });\n    if (!st || !st.ok) continue;"],
  [VERDICT, "M6: the top-of-repository and .git exclusions are removed",
    "    if ((!t.glob && (scope === topC || under(topC, scope, ctx))) || bareAtTop) return always('repository');",
    ""],
  [VERDICT, "M7: the force-push rule is removed",
    "  if (force || dests.some(r => r.plus)) {",
    "  if (false) {"],
  [VERDICT, "M8: the default branch is never detected",
    "  const isDefault = b => !b || defaults.includes(b);",
    "  const isDefault = b => false;"],
  [VERDICT, "M9: the default branch is always detected",
    "  const isDefault = b => !b || defaults.includes(b);",
    "  const isDefault = b => true;"],
  [VERDICT, "M10: the strictest segment is replaced by the first",
    "    result = stricter(result, judgeCommand(u, ctx, { piped, prev }));",
    "    if (seg === segments[0]) result = judgeCommand(u, ctx, { piped, prev });"],
  [VERDICT, "M11: wrapper stripping is removed",
    "    if (ctx.dialect === 'bash' && BASH_WRAPPERS.has(verb)) {",
    "    if (false) {"],
  [VERDICT, "M12a: the command after xargs is not read",
    "  if (v === 'xargs') return judgeXargs(a, ctx);",
    "  if (v === 'xargs') return RUNS;"],
  [VERDICT, "M12b: the command after sh -c is not read",
    "    if (i >= 0) return inner(a[i + 1], ctx, 'bash');",
    "    if (i >= 0) return RUNS;"],
  [VERDICT, "M13: the PowerShell and cmd delete verbs are removed",
    "  if (ctx.dialect === 'ps' && PS_REMOVE.has(v)) return judgePsRemove(a, ctx, piped, prev);",
    ""],
  [CM_HOOK, "M14: the verdict is sent in Notes mode",
    "  const verdict = (codeMode && shellCommand !== null)",
    "  const verdict = (shellCommand !== null)"],
  [CM_CLIENT, "M15: the client offers Always allow on Always asks",
    "    if (verdict && verdict.verdict) return verdict.verdict === 'asks-once';",
    "    if (verdict && verdict.verdict) return verdict.verdict !== 'runs';"],
  [CM_CLIENT, "M16: the Asks-once key collapses to the binary key",
    "verdict.verdict === 'asks-once' && typeof verdict.rule === 'string' ? verdict.rule : null;",
    "verdict.verdict === 'asks-once' && typeof verdict.rule === 'string' ? 'Bash:git' : null;"],
  [CM_HOOK, "M17: Asks once fails open when nobody can be asked",
    "  const failClosed = answerFile || destructive || asksOnce || alwaysAsks || crossingAlwaysAsks;",
    "  const failClosed = answerFile || destructive || alwaysAsks || crossingAlwaysAsks;"],
  [CM_HOOK, "M18: the Code-mode branch answers before the boundary classification",
    "      && !(access && (access.where === 'outside' || access.answerFile))\n      && (!verdict || verdict.verdict === 'runs')) {",
    "      && (!verdict || verdict.verdict === 'runs')) {"],
  [CM_HOOK, "M19: the hook input's cwd is ignored",
    "  const cwd = (typeof data.cwd === 'string' && data.cwd) ? data.cwd : undefined;",
    "  const cwd = undefined;"],
  [VERDICT_HOOK, "M20: a leading cd into a working folder is not accepted",
    "      const resolved = cds === 0 && target && !shape.keyword ? expandPath(target, ctx) : null;",
    "      const resolved = null;"],
  [CM_BOUNDARY, "M21a: a shell card offers a folder without checking it exists",
    "  if (!fs.existsSync(dir)) return null;\n  return dir;\n}",
    "  return dir;\n}"],
  [CM_BOUNDARY, "M21b: a file-tool card offers a folder without checking it exists",
    "    || isHomeOrAbove(grantDir, home)\n    // NEVER A FOLDER THAT DOES NOT EXIST, and not its nearest existing ancestor\n    // in its place either: climbing widens the grant.\n    || !fs.existsSync(grantDir);",
    "    || isHomeOrAbove(grantDir, home);"],
  [CM_BOUNDARY, "M22: a file-tool card may offer the home directory",
    "    || isHomeOrAbove(grantDir, home)\n    // NEVER A FOLDER THAT DOES NOT EXIST",
    "    // NEVER A FOLDER THAT DOES NOT EXIST"],
  [CM_BOUNDARY, "M23: a named parent covers the hidden folders under home",
    "    return !hidden || isUnder(named, hidden, pmod);",
    "    return true;"],
  [CM_BOUNDARY, "M24: the global instruction files are removed from the surfaces",
    "const PERSISTENCE_SURFACE_FILES = ['settings.json', 'CLAUDE.md'];",
    "const PERSISTENCE_SURFACE_FILES = ['settings.json'];"],
  [CM_DEV, "M25: the temp folders are not development paths",
    "  return tempRoots(opts).some(r => under(p, r) && !(inHome && homes.some(h => under(h, r))));",
    "  return false;"],
  [CM_DEV, "M26: the package caches are not development paths",
    "  if (cacheRoots(opts).some(r => under(p, r))) return true;",
    ""],
  [CM_CODEX, "M27: a Codex command escalation is not graded (always carded)",
    "  if (codeMode && !access && verdict.verdict === 'runs') return { decision: 'accept' };",
    ""],
  [CM_CODEX, "M28: a Codex file change inside a working folder is carded",
    "  if (under(g, hook.canonicalize(workspaceRoot)) || extraDirs.some(d => under(g, hook.canonicalize(d)))) return { decision: 'accept' };",
    ""],
  [CM_GLUE, "M29: Codex Runs is answered acceptForSession",
    "    try { ev.respond('accept'); } catch (e) { /* approval already resolved */ }\n    return;",
    "    try { ev.respond('acceptForSession'); } catch (e) { /* approval already resolved */ }\n    return;"],
  [CM_CODEX, "Codex self-permission: a file change at an answer file is graded like any other",
    "  if (touchesAnswerFile(g, workspaceRoot)) {",
    "  if (false) {"],
  [CM_ANSWER_GUARD, "Codex self-permission: a change to an answer file during a turn is never detected",
    "    if (same(now, was)) continue;",
    "    continue;"],
  [CM_ANSWER_GUARD, "Codex self-permission: Rundock's own writes are no longer told apart from an agent's",
    "    if (ownBytes && modeKept) { g.snapshot.set(f, now); continue; }",
    ""],
  [CM_ANSWER_GUARD_GLUE, "Codex self-permission: a Codex turn starts without the answer-file guard",
    "  guardCodexTurn(entry, convoId);\n  const timer = setInterval(() => {",
    "  const timer = setInterval(() => {"],
  [CM_APPSERVER, "Codex permissions request: granted what was asked instead of refused",
    "  return { permissions: {}, scope: 'turn' };",
    "  return { permissions: { fileSystem: { entries: [] }, network: { enabled: true } }, scope: 'turn' };"],
  [CM_APPSERVER, "Codex permissions request: refused for the session instead of the turn",
    "  return { permissions: {}, scope: 'turn' };",
    "  return { permissions: {}, scope: 'session' };"],
  [CM_APPSERVER, "Codex permissions request: the refusal is not passed to the turn",
    "      if (st) this._emitTurnEvent(st, { type: 'permissionsRefused', params });",
    ""],
  [CARD_CSS, "Permission card: the Deny button loses its edge",
    ".btn-deny, .btn-keep-change { background: transparent; color: var(--text-2-strong); border-color: var(--border-strong); }",
    ".btn-deny, .btn-keep-change { background: transparent; color: var(--text-2-strong); }"],
  [CARD_TOKENS, "Permission card: light success text falls back to the fill",
    "  --success-text: #266A36;\n",
    ""],
  [CM_BOUNDARY, "A backslash escape in a Bash command is read as a path again",
    "    if (opts.shellTool !== 'PowerShell' && BASH_ESCAPE.test(raw)) continue;",
    ""],
  [CM_BOUNDARY, "Card A: a lone / in a separator position is read as the root again",
    "skip.push(...patternArgsIn(seg), ...delimiterArgsIn(seg));",
    "skip.push(...patternArgsIn(seg));"],
  [CM_BOUNDARY, "Card A: a missing top-level path in a read-only command is a place again",
    "    if (readOnly && !homed && pmod === path && /^\\/[^/\\\\]+\\/?$/.test(t) && !fs.existsSync(resolved)) continue;\n",
    ""],
  [CM_BOUNDARY, "Card A: echoed words are read as paths again",
    "  skip.push(...echoedArgsIn(command));\n",
    ""],
  [CM_BOUNDARY, "Proxy: another workspace's answer file, by file tool, matched for the current workspace only",
    "  if (writing && !isWorkspaceAnswerFile(resolvedPath, workspaceRoot, foldsCase) && isAnswerFileOfAnyWorkspace(resolvedPath)) {",
    "  if (false) {"],
  [CM_BOUNDARY, "Proxy: another workspace's answer file, by shell, matched for the current workspace only",
    " || isAnswerFileOfAnyWorkspace(resolved, pmod)",
    ""],
  [CM_CODEX_BOUNDARY, "Proxy: Codex grades another workspace's answer file as ordinary work",
    "  if (hook.isAnswerFileOfAnyWorkspace(g)) return true;\n  if (path.basename(g) === '.rundock') return true;",
    "  return false;"],
  [CM_BOUNDARY, "Another workspace's agents and skills are ordinary files again",
    "  if (writing && isOtherWorkspaceAgentSurface(resolvedPath, workspaceRoot)) {",
    "  if (false) {"],
  [CM_BOUNDARY, "Proxy: a code project's Claude settings are taken for a workspace's",
    "  return fs.existsSync(path.join(path.dirname(claudeDir), '.rundock', 'state.json'));",
    "  return true;"],
  [CM_BOUNDARY, "Proxy: a sibling workspace's Claude settings are not recognised",
    "  return fs.existsSync(path.join(path.dirname(claudeDir), '.rundock', 'state.json'));",
    "  return false;"],
  // ===== A WORD ONLY KNOWN WHEN THE LINE RUNS =====
  [VERDICT, "Expansion: a program named by a variable or a substitution is read as a literal",
    "    if (!verbUnderstood(ws[0], ctx)) return UNREADABLE;",
    ""],
  [VERDICT_HOOK, "Expansion (hook): a program named by a variable or a substitution is read as a literal",
    "    if (!verbUnderstood(ws[0], ctx)) return UNREADABLE;",
    ""],
  [VERDICT_CODEX, "Expansion (Codex): a program named by a variable or a substitution is read as a literal",
    "    if (!verbUnderstood(ws[0], ctx)) return UNREADABLE;",
    ""],
  [VERDICT, "Expansion: a substitution's own command is not judged",
    "    result = stricter(result, judgeSubstitutions(seg.text, ctx, depth, false));",
    ""],
  [VERDICT, "Expansion: an argument only known at run time is read as a literal",
    "  if (argsUnknown(v, a, ctx)) return always('unreadable-command');",
    ""],
  [VERDICT, "Expansion: git arguments only known at run time are read as literals",
    "GIT_GRADED.has(sub) && (elsewhere || unknown || rest.some(w => expands(w, ctx)))",
    "GIT_GRADED.has(sub) && (elsewhere || unknown)"],
  [VERDICT, "Expansion: everyday expansion in an npm command is carded",
    "  if (['npm', 'yarn', 'pnpm', 'pwsh', 'powershell', 'cmd'].includes(v)) return lead();",
    "  if (['npm', 'yarn', 'pnpm', 'pwsh', 'powershell', 'cmd'].includes(v)) return a.some(exp);"],
  [VERDICT, "Expansion: here-document bodies are read as commands",
    "  const h = stripHeredocs(text, ctx.dialect);",
    "  const h = { text, bodies: [], ok: true };"],
  [VERDICT, "Expansion: a shell reading a here-document is not judged",
    "  if (shellReadsHeredoc) for (const b of h.bodies) result = stricter(result, judgeLine(b.body, ctx, depth + 1));",
    ""],
  [VERDICT, "Expansion: an unquoted here-document's substitutions are not judged",
    "  for (const b of h.bodies) if (b.expands) result = stricter(result, judgeSubstitutions(b.body, ctx, depth, true));",
    ""],
  [VERDICT, "Git pointed at another repository by --git-dir, --work-tree or GIT_DIR is graded against this one",
    "GIT_GRADED.has(sub) && (elsewhere || unknown ||",
    "GIT_GRADED.has(sub) && (unknown ||"],
  // ===== THE ANSWER-FILE GUARD: LINKS, AND CLAUDE TURNS =====
  [CM_ANSWER_GUARD, "Answer-file guard: an answer file is read through a link",
    "  try { st = fs.lstatSync(file); } catch (e) { return null; }",
    "  try { st = fs.statSync(file); } catch (e) { return null; }"],
  [CM_ANSWER_GUARD, "Answer-file guard: a restore writes through whatever stands at the path",
    "  if (st) fs.rmSync(file, { force: true, recursive: st.isDirectory() });\n  if (bytes === null) return;\n  fs.mkdirSync(path.dirname(file), { recursive: true });\n  fs.writeFileSync(file, bytes, { flag: 'wx' });",
    "  if (bytes === null) { if (st) fs.rmSync(file, { force: true, recursive: st.isDirectory() }); return; }\n  fs.mkdirSync(path.dirname(file), { recursive: true });\n  fs.writeFileSync(file, bytes);"],
  [CM_ANSWER_GUARD_GLUE, "Answer-file guard: an approved change is written through a link",
    "        writePlain(change.file, change.agentContent, change.mode);",
    "        require('fs').writeFileSync(change.file, change.agentContent);"],
  [CLAUDE_TURN_GUARD, "Claude turns: a turn is never guarded",
    "  const start = () => { if (!guard) guard = acquire(workspace, onChange); };",
    "  const start = () => {};"],
  [CLAUDE_TURN_GUARD, "Claude turns: a turn never ends, so an idle process second-guesses the person",
    "      if (RESULT_LINE.test(text)) { end(); tail = ''; return; }",
    "      if (RESULT_LINE.test(text)) { tail = ''; return; }"],
  [CLAUDE_SPAWN, "Claude turns: spawnClaude does not hand the process to the guard",
    "  deps.onClaudeSpawn(proc, {",
    "  (() => {})(proc, {"],
  // ===== HOME INSIDE A TEMP FOLDER IS STILL HOME =====
  [DEV_HOME, "Development paths: the temp rule covers a home folder inside a temp folder",
    "  return tempRoots(opts).some(r => under(p, r) && !(inHome && homes.some(h => under(h, r))));",
    "  return tempRoots(opts).some(r => under(p, r));"],
  [DEV_HOME, "Development paths: home is recognised only by the name it was given",
    "  const homes = [home, canon(home)];",
    "  const homes = [home];"],
  // ===== FREEING A PORT =====
  [VERDICT, "Kill: a process-id lookup is carded like any other expansion",
    "  if (['kill', 'taskkill'].includes(v)) return a.some(w => exp(w) && !pidLookup(w, ctx));",
    "  if (['kill', 'taskkill'].includes(v)) return a.some(exp);"],
  [VERDICT, "Kill: any program with lsof's options counts as a process-id lookup",
    "  if (verb !== 'lsof') return false;",
    ""],
  [VERDICT, "Kill: lsof without a port counts as a process-id lookup",
    "  return terse && port;",
    "  return terse;"],
  [VERDICT, "Kill: pidof with any options counts as a process-id lookup",
    "  if (verb === 'pidof') return args.length > 0 && args.every(x => PLAIN_NAME.test(x));",
    "  if (verb === 'pidof') return true;"],
  // ===== ONLY SHAPES THE VERDICT FULLY UNDERSTANDS CAN RUN =====
  [VERDICT, "Shapes: a function defined as name() is read as a command",
    "  if (/^[^\\s\"'=(){}<>|&;]+\\s*\\(\\s*\\)/.test(t)) return { kind: 'unreadable' }; // name () { ... }",
    ""],
  [VERDICT, "Shapes: a function defined with the function keyword is read as a command",
    "  if (/^(function\\s|case\\s|select\\s|coproc(\\s|$))/.test(t)) return { kind: 'unreadable' };",
    "  if (/^(case\\s|select\\s|coproc(\\s|$))/.test(t)) return { kind: 'unreadable' };"],
  [VERDICT, "Shapes: a keyword is read as the program name",
    "  for (let m = KEYWORD.exec(t); m; m = KEYWORD.exec(t)) { t = t.slice(m[0].length).trim(); keyword = true; }",
    ""],
  [VERDICT, "Shapes: a subshell's contents are not judged",
    "    return { kind: 'subshell', inner: t.slice(1, j) };",
    "    return { kind: 'skip' };"],
  [VERDICT, "Shapes: a group's contents are not judged",
    "    return { kind: 'group', inner: t.slice(1, j) };",
    "    return { kind: 'skip' };"],
  [VERDICT, "Shapes: a cd behind a keyword is followed as if it always happens",
    "      const resolved = cds === 0 && target && !shape.keyword ? expandPath(target, ctx) : null;",
    "      const resolved = cds === 0 && target ? expandPath(target, ctx) : null;"],
  [VERDICT, "Shapes: a cd inside a group does not move where the rest runs",
    "      if (shape.kind === 'group') { ctx = { ...ctx, base: null }; cds++; }",
    ""],
  [VERDICT, "Shapes: an env option not modelled is skipped",
    "      if (/^-/.test(f)) return null; // -S, --split-string, -C, -P and anything else",
    "      if (/^-/.test(f)) { w.shift(); continue; }"],
  [VERDICT, "Shapes: a wrapper not modelled is read as the program",
    "    if (ctx.dialect === 'bash' && UNMODELLED_WRAPPERS.has(verb) && ws.length > 1) return UNREADABLE;",
    ""],
  [VERDICT, "Shapes: an xargs option not modelled is skipped",
    "    if (!XARGS_FLAG.test(f)) return always('unreadable-command');",
    ""],
  [VERDICT, "Shapes: brace expansion or a glob in the program name is read as a name",
    "  if (!PLAIN_NAME.test(name)) return false;",
    ""],
  [VERDICT, "Shapes: a git variable set through export or env is not recognised",
    "    if (setter) for (const w of words.slice(i + 1)) if (/^GIT_/.test(w.text) || assigning(w)) return true;",
    ""],
  [VERDICT, "Shapes: git environment variables are not looked for at all",
    "  if (gitEnvironmentIn(text, ctx)) ctx = { ...ctx, gitRedirected: true };",
    ""],
  // ===== A SETTINGS FILE RUNDOCK DOES NOT OWN =====
  [SCAFFOLD_CM, "Foreign settings: an open writes additional directories into a person's settings",
    "    if (ownsSettings && reconcileAdditionalDirectories(settingsLocal, additionalDirectoriesFor(dir))) dirtySandbox = true;",
    "    if (reconcileAdditionalDirectories(settingsLocal, additionalDirectoriesFor(dir))) dirtySandbox = true;"],
  [SCAFFOLD_CM, "Foreign settings: a mode switch writes additional directories into a person's settings",
    "  if (ownsSettings && reconcileAdditionalDirectories(settingsLocal, additionalDirectoriesFor(dir))) dirty = true;",
    "  if (reconcileAdditionalDirectories(settingsLocal, additionalDirectoriesFor(dir))) dirty = true;"],
  // ===== THE BASELINE OUTLIVES EVERY TURN =====
  [CM_ANSWER_GUARD, "Answer-file guard: the baseline is thrown away when the last turn ends",
    "      if (!g.listeners.size && g.timer) { clearInterval(g.timer); g.timer = null; }",
    "      if (!g.listeners.size) { clearInterval(g.timer); guards.delete(k); }"],
  [CM_ANSWER_GUARD, "Answer-file guard: a change made while no turn ran is not looked for when a turn starts",
    "    check(k, { outsideTurn: true });",
    ""],
  [CM_ANSWER_GUARD, "Answer-file guard: a file's mode is not compared",
    "  if (isPlain(a) || isPlain(b)) return isPlain(a) && isPlain(b) && a.mode === b.mode && a.bytes.equals(b.bytes);",
    "  if (isPlain(a) || isPlain(b)) return isPlain(a) && isPlain(b) && a.bytes.equals(b.bytes);"],
  [CM_ANSWER_GUARD_GLUE, "Answer-file guard: a change made while no turn ran is worded as an agent's",
    "        outsideTurn: !!change.outsideTurn,",
    "        outsideTurn: false,"],
  // ===== TRAPS AND HERE-STRINGS =====
  [VERDICT, "Trap: a trap's command is read as a plain argument",
    "  if (ctx.dialect === 'bash' && v === 'trap') {",
    "  if (false) {"],
  [VERDICT_HOOK, "Trap (hook): a trap's command is read as a plain argument",
    "  if (ctx.dialect === 'bash' && v === 'trap') {",
    "  if (false) {"],
  [VERDICT_CODEX, "Trap (Codex): a trap's command is read as a plain argument",
    "  if (ctx.dialect === 'bash' && v === 'trap') {",
    "  if (false) {"],
  [VERDICT, "Trap: clearing or listing traps asks",
    "    if (!a.length || texts[0] === '-l' || texts[0] === '-p' || texts[0] === '-') return RUNS;",
    ""],
  [CM_PARSE, "Here-string: <<< is read as a here-document",
    "    if (ch === '<' && s[i + 1] === '<' && s[i + 2] === '<') { out += '<<<'; i += 2; continue; }",
    ""],
  [VERDICT, "Here-string: a shell reading a here-string is not judged",
    "      if (ctx.dialect === 'bash' && SHELLS.has(u.verb)) result = stricter(result, inner(u.args[hs + 1], ctx, 'bash'));",
    ""],
  // ===== OUTSIDE CHANGES TO THE CLAUDE CODE SETTINGS, AND THE APPROVED COPY =====
  [CM_ANSWER_GUARD, "Answer-file guard: a settings change made outside Rundock between turns is reported",
    "SHARED_FILES.has(relative)) { g.snapshot.set(f, now); continue; }",
    "SHARED_FILES.has(relative)) { g.snapshot.set(f, now); const l = [...g.listeners].pop(); if (l) l({ file: f, relative, agentContent: null, restored: false, outsideTurn: true }); continue; }"],
  [CM_ANSWER_GUARD, "Answer-file guard: a Claude Code settings change between turns is put back like Rundock's own files",
    "    if (outsideTurn && SHARED_FILES.has(relative)) {",
    "    if (false) {"],
  [CM_ANSWER_GUARD, "Answer-file guard: Rundock's own files changed between turns are kept like the settings",
    "const SHARED_FILES = new Set(['.claude/settings.local.json', '.claude/settings.json']);",
    "const SHARED_FILES = new Set(['.claude/settings.local.json', '.claude/settings.json', '.rundock/permissions.json', '.rundock/state.json']);"],
  [CM_ANSWER_GUARD, "Answer-file guard: a restored plain file loses its mode",
    "  if (isPlain(was)) return writePlain(file, was.bytes, was.mode);",
    "  if (isPlain(was)) return writePlain(file, was.bytes);"],
  [CM_CLIENT, "Card: the unreadable-command sentence is the old one",
    "    'unreadable-command': () => 'Rundock can\\'t tell what this command will do until it runs, so it asks first.',",
    "    'unreadable-command': () => 'This runs a command Rundock can\\'t read before it runs.',"],
  [SANDBOX_ROW, "Settings: the own-sandbox folders note shows where the block is Rundock's",
    "    return status && status.present && status.managed === false ? OWN_SANDBOX_FOLDERS_NOTE : null;",
    "    return status && status.present ? OWN_SANDBOX_FOLDERS_NOTE : null;"],
  [PERMISSIONS_PANE, "Settings: the own-sandbox folders note is not drawn",
    "    ${ownNote}",
    ""],
  // ===== THE CODE-MODE FIXTURE UNDER CI =====
  [CM_FIXTURE, "Fixture: under CI a missing fixture folder skips again",
    "  if (runningInCi(env)) throw new Error(",
    "  if (false) throw new Error("],
  // ===== AN ASKS-ONCE ANSWER IS SAVED UNDER ITS RULE KEY =====
  [ALLOW_KEY_HANDLER, "Allow keys: the handler refuses the Code-mode rule keys",
    "(ALLOW_KEY.test(key) || RULE_KEYS.has(key))",
    "ALLOW_KEY.test(key)"],
  // ===== THE AGENT IS TOLD, READS ARE READS, AND A FAILED SAVE IS SHOWN =====
  [AGENT_NOTICE_HOOK, "Agent notice: the hook never hands over a waiting line",
    "    const note = agentNotice;",
    "    const note = null;"],
  [AGENT_NOTICE_CLAUDE, "Agent notice: a Claude agent is not told its change was put back",
    "  if (runtime === 'claude') { leaveAgentNotice(convoId, line); return; }",
    "  if (runtime === 'claude') return;"],
  [AGENT_NOTICE_CLAUDE, "Agent notice: a change caught between turns is put down to the agent",
    "  if (!convoId || change.outsideTurn) return;",
    "  if (!convoId) return;"],
  [CM_ANSWER_GUARD_GLUE, "Agent notice: a Codex agent's next turn is not told",
    "  return [...waiting, input].filter(Boolean).join('\\n\\n');",
    "  return input;"],
  [ANSWER_READS_HOOK, "Answer-file reads: a command that only reads a permission file is taken as changing it",
    "    if (writingWords.has(raw) && (isWorkspaceAnswerFile(",
    "    if (!readOnly && (isWorkspaceAnswerFile("],
  [ANSWER_READS_HOOK, "Answer-file reads: a segment that writes a permission file is taken as a read",
    "      if (!isReadOnlyShellCommand(seg)) for (const w of shellPathTokens(seg)) writingWords.add(w);",
    "      if (false) for (const w of shellPathTokens(seg)) writingWords.add(w);"],
  [ANSWER_READS_VOCAB, "Answer-file reads: od is not a read",
    "    'od', 'hexdump',",
    "    'hexdump',"],
  [ALLOW_KEY_HANDLER, "Allow keys: a refused save is not reported",
    "    refuseToolAllow(ws, msg.key, 'Could not record that allow: that is not a tool name.');",
    "    sendToolAllows(ws);"],
  [ALLOW_FAIL_VIEW, "Allow keys: the view keeps an allow the server refused",
    "  if (key) alwaysAllowedTools.delete(key);",
    ""],
  [AGENT_NOTICE_ROUTER, "Agent notice: the server hands out no line",
    "    const text = id ? require('./runtime/agent-notices.js').takeAgentNotice(id) : null;",
    "    const text = null;"],
  [AGENT_NOTICE_STORE, "Agent notice: any conversation id is accepted",
    "  return PLAIN_ID.test(id) && id !== '.' && id !== '..' ? id : null;",
    "  return id || null;"],
  [AGENT_NOTICE_STORE, "Agent notice: a line is handed over more than once",
    "  waiting.delete(id);",
    ""],
  // ===== THE AGENT IS TOLD IN THE SAME STEP =====
  [PUTBACK_HOOK, "Same step: the finished tool call does not ask for a check",
    "+ (check ? '&check=1' : '')",
    ""],
  [PUTBACK_ROUTER, "Same step: the server does not check before handing out the line",
    "    if (checkFirst) require('./workspace/answer-file-guard.js').checkAnswerFilesNow(getWorkspace());",
    ""],
  [PUTBACK_GUARD, "Same step: a check on demand checks nothing",
    "  if (!g || !g.listeners.size) return [];",
    "  return [];"],
  [PUTBACK_SCAFFOLD, "Same step: the PostToolUse hook is never registered",
    "    if (ownsSettings) {\n      const POST_MATCHER",
    "    if (false) {\n      const POST_MATCHER"],
  [PUTBACK_SCAFFOLD, "Same step: the PostToolUse hook is written into a person's own settings",
    "    if (ownsSettings) {\n      const POST_MATCHER",
    "    if (true) {\n      const POST_MATCHER"],
  // ===== THE PUT-BACK CARD =====
  [PUTBACK_GLUE, "Put-back card: sent as an ordinary answer-file card",
    "      put_back: {\n        runtime:",
    "      unused_put_back: {\n        runtime:"],
  [PUTBACK_SERVER, "Put-back card: the server drops its details on the way to the browser",
    ", 'answer_file', 'put_back'];",
    ", 'answer_file'];"],
  [PUTBACK_VIEW, "Put-back card: drawn as an ordinary card",
    "  if (req.put_back && !RundockPermissions.permissionEnded(endedPermissions, requestId)) { renderPutBackCard(d, convoId, host); return; }",
    ""],
  [PUTBACK_VIEW, "Put-back card: Leave it restored keeps the change",
    "data-perm-action=\"deny\">${esc(copy.leave)}",
    "data-perm-action=\"allow\">${esc(copy.leave)}"],
  [PUTBACK_VIEW, "Put-back card: the reply is not moved below the card",
    "    state.currentStreamingMsg = next;",
    ""],
  [PUTBACK_COPY, "Put-back card: a whitespace-only change is invisible",
    "    return m ? line.slice(0, m.index) + m[0].replace(/./g, '\u00b7') : line;",
    "    return line;"],
  // ===== ONLY THIS MACHINE'S OWN PAGE REACHES THE SERVER =====
  [LOCAL_ORIGIN, 'Local origin: a foreign Host is refused',
    "  if (!isLoopbackHost(headers.host, port)) return 'host';\n",
    ''],
  [LOCAL_ORIGIN, 'Local origin: the Host must carry the listening port',
    '  return LOOPBACK_NAMES.some((name) => value === `${name}:${port}`);',
    '  return LOOPBACK_NAMES.some((name) => value.startsWith(name));'],
  [LOCAL_ORIGIN, 'Local origin: a write with a foreign Origin is refused',
    "  if (writes && origin !== undefined && !isAppOrigin(origin, port)) return 'origin';\n",
    ''],
  [LOCAL_ORIGIN, 'Local origin: a WebSocket upgrade is held to the Origin rule',
    "  const writes = upgrade || !READ_METHODS.includes(String(req.method || 'GET').toUpperCase());",
    "  const writes = !READ_METHODS.includes(String(req.method || 'GET').toUpperCase());"],
  [LOCAL_ORIGIN, 'Local origin: every loopback name for the port is the app',
    "const LOOPBACK_NAMES = ['localhost', '127.0.0.1', '[::1]'];",
    "const LOOPBACK_NAMES = ['localhost'];"],
  [LOCAL_ORIGIN_DOOR, 'Local origin: every HTTP request passes the check',
    '  const refused = localOrigin.refusal(req, port);',
    '  const refused = null;'],
  [LOCAL_ORIGIN_DOOR, 'Local origin: every WebSocket upgrade passes the check',
    '  verifyClient: ({ req }) => !localOrigin.refusal(req, server.address().port, { upgrade: true })\n',
    '  verifyClient: ({ req }) => true\n'],
  // ===== ONLY RUNDOCK'S OWN WINDOW DRIVES THE SERVER =====
  [AUTH_UNIT, 'Auth: an unknown hook token belongs to no conversation',
    '  return hookScopes.has(token) ? hookScopes.get(token) : undefined;',
    '  return hookScopes.has(token) ? hookScopes.get(token) : null;'],
  [AUTH_DOOR, 'Auth: every WebSocket upgrade asks for the key',
    '    && auth.authenticate(req, server.address().port),',
    '    && true,'],
  [AUTH_ROUTES, 'Auth: a route not named as open is closed',
    "    if (url === '/api/auth/status') return true;",
    "    if (url.startsWith('/api/')) return true;"],
  [AUTH_ROUTER, 'Auth: the card route takes only a hook token',
    "  } else if (req.method === 'POST' && req.url === '/api/permission-request') {\n    const scope = auth.hookScopeOf(req);\n    if (scope === undefined) {",
    "  } else if (req.method === 'POST' && req.url === '/api/permission-request') {\n    const scope = auth.hookScopeOf(req);\n    if (false) {"],
  [AUTH_ROUTER, 'Auth: a card is filed into the token\'s conversation, not the one named',
    "        const convoId = scope || '';",
    "        const convoId = data.conversation_id || scope || '';"],
  [AUTH_ROUTER, 'Auth: the notice route takes only a hook token',
    "  } else if (req.method === 'GET' && req.url.startsWith('/api/agent-notice?')) {\n    const scope = auth.hookScopeOf(req);\n    if (scope === undefined) {",
    "  } else if (req.method === 'GET' && req.url.startsWith('/api/agent-notice?')) {\n    const scope = auth.hookScopeOf(req);\n    if (false) {"],
  [AUTH_ROUTER, 'Auth: a notice goes only to the token\'s own conversation',
    "    const id = scope || '';",
    "    const id = new URL(req.url, 'http://127.0.0.1').searchParams.get('conversation') || scope || '';"],
  [AUTH_ROUTER, 'Links: a review sidecar is never written through a link',
    '        writeFileNoFollow(fullPath, data.content);',
    "        fs.writeFileSync(fullPath, data.content, 'utf-8');"],
  [AUTH_FILES, 'Links: a save that would land outside through a link is refused',
    '      if (!ctx.workspace.isWritableInWorkspace(fullPath)) {\n        ws.send(',
    '      if (false) {\n        ws.send('],
  [AUTH_LINK, 'Links: a write is judged where it really lands',
    '    if (real) return path.join(real, ...rest.reverse());',
    '    if (real) return path.resolve(target);'],
  [AUTH_LINK, 'Links: the last step never follows a link',
    '(fs.constants.O_NOFOLLOW || 0);\n  const fd',
    '0;\n  const fd'],
  [AUTH_SPAWN, 'Auth: an agent is started with its conversation\'s hook token',
    "  env.RUNDOCK_HOOK_TOKEN = require('../auth/index.js').issueHookToken(convoId || null);\n",
    ''],
  [AUTH_HOOK, 'Auth: the hook sends its token with a card request',
    "      'Content-Length': Buffer.byteLength(payload),\n      ...hookTokenHeader(),",
    "      'Content-Length': Buffer.byteLength(payload),"],
  [AUTH_WINDOW, 'Auth: the window\'s key never goes from an extension frame',
    '  return !isExtensionFrame(details.frame);',
    '  return true;'],
  [AUTH_WINDOW, 'Auth: the window\'s key goes only to this server\'s port',
    '  if (String(url.port) !== String(port)) return false;\n',
    ''],
  [AUTH_WINDOW, 'Auth: a debugging switch is recognised with its value',
    "    const name = String(arg).split('=')[0];",
    '    const name = String(arg);'],
  [AUTH_SIGNIN, 'Sign-in: a tab that was connected says Rundock restarted',
    '    return everConnected ? RESTARTED : NEVER_SIGNED_IN;',
    '    return NEVER_SIGNED_IN;'],
  [AUTH, 'Auth: the key in the header is compared, not merely present',
    "  if (sameSecret(headers[KEY_HEADER], LAUNCH_KEY)) return 'key';",
    "  if (headers[KEY_HEADER]) return 'key';"],
  [AUTH_UNIT, 'Auth: a session counts only if its fingerprint is on file',
    "    && now - Number(s.at) <= SESSION_MAX_AGE_S * 1000 && sameSecret(s.fp, fp));",
    "    || true);"],
  [AUTH_UNIT, 'Auth: only a fingerprint of a browser token is kept',
    "    { fp: fingerprint(token), kind: 'session', port: String(port), at },",
    "    { fp: fingerprint(token), token, kind: 'session', port: String(port), at },"],
  [AUTH_UNIT, 'Auth: the media cookie stays out of the page\'s reach and off every other path',
    "    'Set-Cookie': `${result.mediaCookie}; HttpOnly; SameSite=Strict; Path=/workspace-file; Max-Age=${SESSION_MAX_AGE_S}`,",
    "    'Set-Cookie': `${result.mediaCookie}; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_S}`,"],
  [AUTH_UNIT, 'Auth: the media cookie opens pictures and PDFs only',
    "  if (isMediaRequest(req) && knownSession(readCookie(req, mediaCookieName(port)), port, 'media')) return 'media';",
    "  if (knownSession(readCookie(req, mediaCookieName(port)), port, 'media')) return 'media';"],
  [AUTH_UNIT, 'Auth: a session token is not good on another port',
    "  return readSessions().some(s => s.kind === kind && String(s.port) === String(port)\n",
    "  return readSessions().some(s => s.kind === kind\n"],
  [BROWSER_ATTACK, 'Auth: a session expires on the server',
    "    && now - Number(s.at) <= SESSION_MAX_AGE_S * 1000 && sameSecret(s.fp, fp));",
    "    && sameSecret(s.fp, fp));"],
  [BROWSER_ATTACK, 'Auth: the launch key is never a code',
    "  if (desktopOnly || typeof code !== 'string' || !liveCode(code)) return null;",
    "  if (desktopOnly || typeof code !== 'string' || (!liveCode(code) && code !== LAUNCH_KEY)) return null;"],
  [BROWSER_ATTACK, 'Auth: a code works once',
    "  codes.delete(code);\n  const token = newSecret();",
    "  const token = newSecret();"],
  [BROWSER_ATTACK, 'Auth: a code is good for a few minutes only',
    "  if (Date.now() > until) { codes.delete(code); return false; }",
    "  if (false) { codes.delete(code); return false; }"],
  [DESKTOP_AUTH, 'Auth: the desktop accepts its window\'s key and nothing a browser holds',
    "  if (desktopOnly) return null;\n",
    ""],
  [AUTH_DOOR, 'Auth: every HTTP route but the open ones asks for the key',
    "  if (!httpRouter.isOpenRoute(req) && !req.rundockAuthorisedBy) {",
    "  if (false) {"],
  [BROWSER_DOOR, 'Auth: the socket never chooses the subprotocol carrying the token',
    "  handleProtocols: (protocols) => (protocols.has(auth.WS_PROTOCOL) ? auth.WS_PROTOCOL : false),",
    "  handleProtocols: (protocols) => [...protocols].pop() || false,"],
  [LAUNCHER, 'Launcher code: taken out of the environment before anything inherits it',
    'delete process.env.RUNDOCK_LAUNCH_CODE;\n',
    ''],
  [LAUNCHER, 'Launcher code: only a value shaped like a code is used',
    "const FROM_LAUNCHER = !process.versions.electron && typeof HANDED_CODE === 'string' && TOKEN_SHAPE.test(HANDED_CODE);",
    "const FROM_LAUNCHER = !process.versions.electron && typeof HANDED_CODE === 'string' && HANDED_CODE.length > 0;"],
  [LAUNCHER_BANNER, 'Launcher code: the startup line holds no link when the launcher holds it',
    '      else if (auth.codeFromLauncher()) console.log(',
    '      else if (false) console.log('],
  [AUTH_SIGNIN, 'Sign-in: only a code-shaped value in the fragment is read',
    "    const match = /^#(?:.*&)?c=([A-Za-z0-9_-]{16,128})(?:&|$)/.exec(String(hash || ''));",
    "    const match = /[ck]=([^&]+)/.exec(String(hash || ''));"],
  [AUTH_SIGNIN, 'Sign-in: the token goes only to this page\'s own server',
    "      if (!token || !same) return fetchImpl(input, init);",
    "      if (!token) return fetchImpl(input, init);"],
  [MEDIA_ROUTER, 'Links: a picture let in by the media cookie is read only where it really is',
    "    const inside = req.rundockAuthorisedBy === 'media' ? deps.isWritableInWorkspace(fullPath) : deps.isInsideWorkspace(fullPath);",
    "    const inside = deps.isInsideWorkspace(fullPath);"],
  [AUTH_WINDOW, 'Auth: the window\'s key never goes with another origin',
    "  if (origin !== undefined && !LOOPBACK.some((h) => String(headers[origin]).toLowerCase() === `http://${h}:${port}`)) return false;\n",
    ""],
  [LINK_ON_REQUEST, 'Links: a link asked for at the terminal is answered at most once a second',
    '    if (Date.now() - lastPrintAt < 1000) return;\n',
    ''],
  [LINK_ON_REQUEST, 'Links: asking for a new link retires the last one',
    '    if (printedCode) codes.delete(printedCode);\n',
    ''],
  [LINK_ON_REQUEST, 'Links: the desktop app prints no link',
    '  if (FROM_LAUNCHER || desktopOnly) return;\n  lastPrintAt = Date.now();',
    '  if (FROM_LAUNCHER) return;\n  lastPrintAt = Date.now();'],
  [LAUNCHER, 'Launcher: only a server the launcher started says whether it is idle',
    '  if (FROM_LAUNCHER) { body.launcher = true; body.idle = !!idleProbe(); }\n',
    ''],
  [AUTH_SIGNIN, 'Sign-in: a launcher install points to its icon, not a terminal',
    '    if (fromLauncher) return FROM_LAUNCHER;\n',
    ''],
  [AUTH_SIGNIN, 'Sign-in: the exchange is tried again until the server itself answers',
    '    return status === 200 || status === 401;',
    '    return true;'],
  [PAGE_POLICY, 'Page policy: the page connects only to its own server',
    "const PAGE_FRAME_POLICY = \"frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'\";",
    "const PAGE_FRAME_POLICY = \"frame-src 'self'\";"],
  [STORE_ISOLATION, 'Tests: fixtures never write into the checkout\'s stores',
    'function seenHere(dir) {\n  isolateStores();',
    'function seenHere(dir) {'],
  // ===== STOP AND ASK AFTER A REFUSAL =====
  [STOP_ASK_HOOK, "Stop and ask: a denied card goes back to inviting another route",
    ": refusalNotice(result.reason === 'timeout' ? 'timeout' : 'denied', data.tool_name);",
    ": 'This command was not approved. Acknowledge and move on.';"],
  [STOP_ASK_HOOK, "Stop and ask: a timed-out card is told as a denial",
    "refusalNotice(result.reason === 'timeout' ? 'timeout' : 'denied', data.tool_name)",
    "refusalNotice('denied', data.tool_name)"],
  [STOP_ASK_HOOK, "Stop and ask: a failed call never reaches the after-call branch",
    "if (hookEvent === 'PostToolUse' || hookEvent === 'PostToolUseFailure') {",
    "if (hookEvent === 'PostToolUse') {"],
  [STOP_ASK_HOOK, "Stop and ask: a sandbox block is never told",
    "blocked ? refusalNotice('sandbox', finished.tool_name) : null",
    "null"],
  [STOP_ASK_HOOK, "Stop and ask: told outside Rundock too",
    "const blocked = !!process.env.RUNDOCK && sandboxBlocked(",
    "const blocked = sandboxBlocked("],
  [STOP_ASK_LINE, "Stop and ask: any tool's output can count as a sandbox block",
    "  if (toolName !== 'Bash') return false;\n  const out",
    "  const out"],
  [STOP_ASK_LINE, "Stop and ask: the runtime's own sandbox mark is not decisive",
    "  if (out.includes(SANDBOX_TAG)) return true;\n",
    "\n"],
  [STOP_ASK_LINE, "Stop and ask: Operation not permitted counts in Code mode and off macOS",
    "  if (codeMode || platform !== 'darwin') return false;\n",
    "\n"],
  [STOP_ASK_LINE, "Stop and ask: a command run outside the sandbox is blamed on it",
    "return !sandboxOff && NOT_PERMITTED.test(out);",
    "return NOT_PERMITTED.test(out);"],
  [STOP_ASK_LINE, "Stop and ask: a kind that is no refusal still gets a line",
    "const what = Object.prototype.hasOwnProperty.call(WHAT, kind) ? WHAT[kind] : null;",
    "const what = WHAT[kind] || null;"],
  [STOP_ASK_SCAFFOLD, "Stop and ask: the failure hook is never registered",
    "for (const event of ['PostToolUse', 'PostToolUseFailure']) {",
    "for (const event of ['PostToolUse']) {"],
];

const REPORTER = ['--test-reporter', 'spec'];

function redTests(suite) {
  let out = '';
  let failed = false;
  // A suite under test/electron/ is a run of the shipped desktop app, not a
  // node:test file: it prints one JSON report whose `failures` names every
  // expectation that did not hold, and exits 1 when there are any.
  if (String(suite || '').startsWith('test/electron/')) {
    try {
      out = execFileSync('node', [suite], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 240000 });
    } catch (e) {
      failed = true;
      out = e.stdout || '';
    }
    try {
      const report = JSON.parse(out.slice(out.indexOf('{\n'), out.lastIndexOf('}') + 1));
      if (Array.isArray(report.failures) && (report.failures.length > 0) === failed) return report.failures;
    } catch (e) { /* no report: no verdict */ }
    return { unparsable: true };
  }
  try {
    out = execFileSync('node', ['--test', ...REPORTER, suite],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    failed = true;
    out = (e.stdout || '') + (e.stderr || '');
  }
  const marker = out.indexOf('failing tests:');
  if (marker === -1) {
    if (!failed) return [];
    // A suite that failed with output this could not read has produced no
    // verdict: not red, not green, nothing. Refused as a named row rather
    // than thrown, so the report says which mutation was in flight instead
    // of a stack trace that names nothing.
    return { unparsable: true };
  }
  const names = [];
  for (const line of out.slice(marker).split('\n')) {
    const m = /^✖ (.+?) \(\d/.exec(line.trim());
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

// THE TARGETS ARE THE ONES THE ROWS NAME, derived rather than listed. A hand
// list beside the rows went stale: rows were added naming targets the list did
// not load, so the harness crashed at the first of them, and none of those
// rows had ever run. Every row must name a target object with a source file
// that exists and a suite; anything else is refused before a file is touched.
function targetsFor(mutations) {
  return targetsFromRows(mutations);
}

function run() {
  const targets = targetsFor(MUTATIONS);
  const session = beginMutationRun({ files: [...new Set(targets.map((target) => target.src))] });
  const originals = new Map();
  for (const target of targets) originals.set(target, session.original(target.src));
  const results = [];
  try {
    for (const [target, label, guard, without] of rowsForShard(MUTATIONS)) {
      const original = originals.get(target);
      const matches = original.split(guard).length - 1;
      if (matches === 0) {
        results.push({ label, applied: false, red: [] });
        continue;
      }
      // A GUARD THAT MATCHES MORE THAN ONCE IS REFUSED RATHER THAN TAKING THE
      // FIRST: String.replace takes the first occurrence, so a search text
      // that also appears somewhere else quietly breaks the wrong code and
      // reports on whatever that turns red.
      if (matches > 1) {
        results.push({ label, applied: false, ambiguous: matches, red: [] });
        continue;
      }
      fs.writeFileSync(target.src, original.replace(guard, without));
      const red = redTests(target.suite);
      results.push(red && red.unparsable
        ? { label, applied: true, unparsable: true, red: [] }
        : { label, applied: true, red });
      fs.writeFileSync(target.src, original);
    }
  } finally {
    session.finish();
  }
  return results;
}

function report(results, markdown) {
  let failed = 0;
  const lines = [];
  for (const { label, applied, red, ambiguous, unparsable } of results) {
    if (unparsable) {
      failed++;
      const why = 'no verdict: the suite failed but its output could not be parsed, so nothing '
        + 'about this mutation is known; fix the reporter parsing rather than trusting a rerun';
      lines.push(markdown ? `| ${label} | **${why}** | |` : `${label}\n  ${why.toUpperCase()}`);
      continue;
    }
    if (ambiguous) {
      failed++;
      const why = `the guard text matches ${ambiguous} places, so it would break whichever came first`;
      lines.push(markdown ? `| ${label} | **${why}** | |` : `${label}\n  AMBIGUOUS: ${why}`);
      continue;
    }
    if (!applied) {
      failed++;
      lines.push(markdown
        ? `| ${label} | **the guard text was not found, so nothing was mutated** | |`
        : `${label}\n  THE GUARD TEXT WAS NOT FOUND, so nothing was mutated`);
      continue;
    }
    if (red.length === 0) {
      failed++;
      lines.push(markdown ? `| ${label} | **nothing turned red** | |` : `${label}\n  NOTHING TURNED RED`);
      continue;
    }
    lines.push(markdown
      ? `| ${label} | ${red.length} | ${red.map((n) => `\`${n}\``).join('<br>')} |`
      : `${label}\n  ${red.length} red\n${red.map((n) => `    - ${n}`).join('\n')}`);
  }
  if (markdown) {
    console.log('| Guard broken | Tests red | Which |');
    console.log('|---|---|---|');
    for (const line of lines) console.log(line);
  } else {
    for (const line of lines) console.log(`\n${line}`);
  }
  return failed;
}

// REFUSE TO START ON A MACHINE THAT WOULD MISREPORT. See
// mutate-routines-guards.js for the two runs that taught this: a full temp
// root surfaces as tests going red, and red tests are exactly what this
// instrument reports as a guard nobody was watching.
function requireSaneTempRoot() {
  const verdict = preflight(os.tmpdir());
  if (verdict.ok) return;
  console.error(verdict.message);
  process.exit(NO_VERDICT);
}

if (require.main === module) {
  requireSaneTempRoot();
  if (process.argv.includes('--preflight-only')) process.exit(0);
  const results = run();
  const failed = report(results, process.argv.includes('--markdown'));
  if (failed) {
    console.error(`\n${failed} mutation(s) proved nothing. A guard no test notices is not guarded,`
      + ' and a mutation that could break more than one place proves nothing about either.');
    process.exit(exitCodeFor(failed, results));
  }
}

module.exports = { MUTATIONS, run, targetsFor };
