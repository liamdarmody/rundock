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
// Creating a workspace never touches a folder that is already there, and the
// scaffold never writes over a CLAUDE.md: each proven by the suite that drives
// it, the create handler through the real server.
const CREATE_HANDLER = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'workspace.js'), suite: 'test/integration/workspace-picker.test.js' };
const SCAFFOLD_KEEP = { src: path.join(ROOT, 'lib', 'workspace', 'scaffold.js'), suite: 'test/unit/workspace-modes.test.js' };
// The switch that keeps agents inside the workspace: where it is read from, the
// new-workspace default, and the open-path reconcile that honours it.
const SCAFFOLD_SWITCH = { src: path.join(ROOT, 'lib', 'workspace', 'scaffold.js'), suite: 'test/unit/sandbox-switch.test.js' };
// The deny-list lengths the recogniser accepts, against the release history
// written out in the sandbox settings suite.
const SCAFFOLD_SETTINGS = { src: path.join(ROOT, 'lib', 'workspace', 'scaffold.js'), suite: 'test/unit/sandbox-settings.test.js' };
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
// The verdict's disk and git seam, driven through the verdict's own suite.
const VERDICT_GIT = { src: path.join(ROOT, 'scripts', 'code-mode-git.js'), suite: 'test/unit/code-mode-verdict.test.js' };
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
// registration, and the Codex glue and client that steer it into a turn.
const STOP_ASK_HOOK = { src: path.join(ROOT, 'scripts', 'permission-hook.js'), suite: 'test/unit/stop-and-ask.test.js' };
const STOP_ASK_LINE = { src: path.join(ROOT, 'scripts', 'refusal-notice.js'), suite: 'test/unit/stop-and-ask.test.js' };
const STOP_ASK_SCAFFOLD = { src: path.join(ROOT, 'lib', 'workspace', 'scaffold.js'), suite: 'test/unit/stop-and-ask.test.js' };
const STOP_ASK_GLUE = { src: path.join(ROOT, 'lib', 'runtime', 'codex-glue.js'), suite: 'test/integration/codex-stop-and-ask.test.js' };
const STOP_ASK_CLIENT = { src: path.join(ROOT, 'codex-appserver.js'), suite: 'test/integration/codex-stop-and-ask.test.js' };
// After a person approves a card, the agent is told in the same step: the
// hook's added context, the handler that says a card was answered, the click
// that says so, the line itself, and the Codex steer.
const APPROVED_HOOK = { src: path.join(ROOT, 'scripts', 'permission-hook.js'), suite: 'test/unit/approval-notice.test.js' };
const APPROVED_LINE = { src: path.join(ROOT, 'scripts', 'refusal-notice.js'), suite: 'test/unit/approval-notice.test.js' };
const APPROVED_HANDLER = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'process-control.js'), suite: 'test/unit/approval-notice.test.js' };
const APPROVED_CLICK = { src: path.join(ROOT, 'public', 'views', 'chat.js'), suite: 'test/unit/approval-notice.test.js' };
const APPROVED_GLUE = { src: path.join(ROOT, 'lib', 'runtime', 'codex-glue.js'), suite: 'test/integration/codex-approval-notice.test.js' };
const APPROVED_HANDLER_CODEX = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'process-control.js'), suite: 'test/integration/codex-approval-notice.test.js' };
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

// The hint under repeated permission cards: what counts, when it shows, and
// the Settings link that must never change a setting itself.
const REPEAT_HINT = { src: path.join(ROOT, 'public', 'repeat-hint-model.js'), suite: 'test/unit/repeat-hint.test.js' };
const REPEAT_HINT_LINK = { src: path.join(ROOT, 'public', 'views', 'settings.js'), suite: 'test/unit/repeat-hint.test.js' };
// What the shell check reads in a command carrying code or text for another
// program: escape strings, here-documents, interpreter code and a `cd` partway
// through a chain.
const SHELL_CODE = { src: path.join(ROOT, 'scripts', 'permission-hook.js'), suite: 'test/unit/shell-code-boundary.test.js' };
// The same file, the suite that times it: the folder each word starts from is
// worked out once per command, or the check grows with the square of it.
const SHELL_TIMING = { src: path.join(ROOT, 'scripts', 'permission-hook.js'), suite: 'test/unit/shell-code-timing.test.js' };

// A connector action that sends, replies or forwards: never a read in the hook,
// high risk in the client. The word tables are proven by the suite that grades
// action names; the guards that decide a card, through the real hook, server
// and card.
const CONNECTOR_HOOK = { src: path.join(ROOT, 'scripts', 'permission-hook.js'), suite: 'test/unit/connector-grading.test.js' };
const CONNECTOR_CLIENT = { src: path.join(ROOT, 'public', 'permissions.js'), suite: 'test/unit/connector-grading.test.js' };
const CONNECTOR_HOOK_FLOW = { src: path.join(ROOT, 'scripts', 'permission-hook.js'), suite: 'test/integration/connector-approvals.test.js' };
const CONNECTOR_CLIENT_FLOW = { src: path.join(ROOT, 'public', 'permissions.js'), suite: 'test/integration/connector-approvals.test.js' };
// A saved "Always allow" for a send is dropped by the store and refused by the
// handler, both proven through the real server.
const CONNECTOR_STORE_FLOW = { src: path.join(ROOT, 'lib', 'workspace', 'boundary.js'), suite: 'test/integration/connector-approvals.test.js' };
const CONNECTOR_HANDLER_FLOW = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'workspace.js'), suite: 'test/integration/connector-approvals.test.js' };
// The card a person approves a connector send from: the fields it shows, the
// model that decides how many recipients are shown, and the grading that keeps
// Always allow off a send, each proven by the suite that renders the real card
// under jsdom and reads back what a person sees.
const CONNECTOR_CARD_VIEW = { src: path.join(ROOT, 'public', 'views', 'chat.js'), suite: 'test/unit/connector-card.test.js' };
const CONNECTOR_CARD_MODEL = { src: path.join(ROOT, 'public', 'connector-fields.js'), suite: 'test/unit/connector-card.test.js' };
const CONNECTOR_CARD_GRADE = { src: path.join(ROOT, 'public', 'permissions.js'), suite: 'test/unit/connector-card.test.js' };
// The field model's own reading, where its suite reaches what the card's does
// not: every shape of value it must survive without throwing.
const CONNECTOR_FIELDS_MODEL = { src: path.join(ROOT, 'public', 'connector-fields.js'), suite: 'test/unit/connector-fields.test.js' };
// Reconnecting Claude Code from the chat: two routes that open a console on
// this machine and spend a turn checking, which only Rundock's own window may
// reach. Proven through the real server by the routes' own suite.
const RECONNECT_ROUTES = { src: path.join(ROOT, 'lib', 'http-router.js'), suite: 'test/integration/claude-reconnect.test.js' };
const RECONNECT_AUTH = { src: path.join(ROOT, 'lib', 'auth', 'index.js'), suite: 'test/integration/claude-reconnect.test.js' };
// The console and the check themselves, the server's reading of the check, and
// the card that shows its answer.
const CLAUDE_CONSOLE = { src: path.join(ROOT, 'lib', 'runtime', 'claude-console.js'), suite: 'test/unit/claude-console.test.js' };
const RECONNECT_SERVER = { src: path.join(ROOT, 'server.js'), suite: 'test/integration/claude-reconnect.test.js' };
const RECONNECT_CARD = { src: path.join(ROOT, 'public', 'views', 'chat.js'), suite: 'test/unit/reconnect-card.test.js' };
// Where the console is asked for: the desktop's channel and the server's route,
// each read by the console suite, and the first-run wizard that reads its answer.
const CONSOLE_DESKTOP = { src: path.join(ROOT, 'electron', 'main.js'), suite: 'test/unit/claude-console.test.js' };
const CONSOLE_SERVER = { src: path.join(ROOT, 'server.js'), suite: 'test/unit/claude-console.test.js' };
const CONSOLE_WIZARD = { src: path.join(ROOT, 'electron', 'wizard.html'), suite: 'test/unit/wizard-first-run.test.js' };

// The files that decide what runs: the launcher the permission hook is started
// through, the workspace's connector and project settings, and its hook
// scripts. Each always asks, through the real hook and the real card.
const WHAT_RUNS_HOOK = { src: path.join(ROOT, 'scripts', 'permission-hook.js'), suite: 'test/unit/what-runs-files.test.js' };
const REGISTRY_TO_GUARD = { src: path.join(ROOT, 'scripts', 'permission-hook.js'), suite: 'test/unit/codex-what-runs-guard.test.js' };
const WHAT_RUNS_CLIENT = { src: path.join(ROOT, 'public', 'permissions.js'), suite: 'test/unit/what-runs-files.test.js' };
const WHAT_RUNS_VIEW = { src: path.join(ROOT, 'public', 'views', 'chat.js'), suite: 'test/unit/what-runs-files.test.js' };
const WHAT_RUNS_CODEX = { src: path.join(ROOT, 'lib', 'runtime', 'codex-approval.js'), suite: 'test/unit/codex-escalation-grading.test.js' };
// An agent's connector change asks the person first: the handler that asks,
// the card that words it, and the wiring that hands the handler the card.
const CONNECTOR_ASK = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'team.js'), suite: 'test/unit/protocol-handlers-lib.test.js' };
const CONNECTOR_ASK_FLOW = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'team.js'), suite: 'test/integration/connector-asks.test.js' };
const CONNECTOR_CARD = { src: path.join(ROOT, 'public', 'permissions.js'), suite: 'test/unit/connector-change-card.test.js' };
const CONNECTOR_WIRING = { src: path.join(ROOT, 'server.js'), suite: 'test/integration/connector-asks.test.js' };
const CONNECTOR_VIEW = { src: path.join(ROOT, 'public', 'views', 'chat.js'), suite: 'test/unit/connector-change-card.test.js' };
// The per-user connector file, through the real hook and the card's words.
const SECRETS_HOOK = { src: path.join(ROOT, 'scripts', 'permission-hook.js'), suite: 'test/unit/connector-secrets-file.test.js' };
const SECRETS_CARD = { src: path.join(ROOT, 'public', 'permissions.js'), suite: 'test/unit/connector-secrets-file.test.js' };
// The card for a file Claude Code protects itself says an Allow may not hold.
const RUNS_NOTE = { src: path.join(ROOT, 'public', 'permissions.js'), suite: 'test/unit/boundary-card.test.js' };
// The detect-and-restore guard watches the files that decide what runs, for a
// Codex agent whose writes inside the workspace never meet a card; Rundock's
// own writers record what they wrote, and the put-back card and the agent's
// line say what the file decides.
const GUARD_RUNS = { src: path.join(ROOT, 'lib', 'workspace', 'answer-file-guard.js'), suite: 'test/unit/codex-what-runs-guard.test.js' };
const GUARD_RUNS_LAUNCHER = { src: path.join(ROOT, 'lib', 'workspace', 'scaffold.js'), suite: 'test/unit/codex-what-runs-guard.test.js' };
const GUARD_RUNS_CONNECTOR = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'team.js'), suite: 'test/unit/codex-what-runs-guard.test.js' };
const GUARD_RUNS_CARD = { src: path.join(ROOT, 'public', 'permissions.js'), suite: 'test/unit/codex-what-runs-guard.test.js' };
const GUARD_RUNS_LINE = { src: path.join(ROOT, 'lib', 'runtime', 'codex-glue.js'), suite: 'test/unit/codex-what-runs-guard.test.js' };
// The guide's instruction about sound hooks, which would otherwise send an
// agent to edit the project settings.
const GUIDE_HOOKS = { src: path.join(ROOT, 'scaffold', 'rundock-guide.md'), suite: 'test/unit/discovery.test.js' };
// launchctl in either mode, through suites that need no fixture.
const LAUNCHCTL_NOTES = { src: path.join(ROOT, 'public', 'read-only-shell.js'), suite: 'test/unit/launchctl-asks.test.js' };
const LAUNCHCTL_ANY_MODE = { src: path.join(ROOT, 'scripts', 'code-mode-verdict.js'), suite: 'test/unit/launchctl-asks.test.js' };
// Which words a command can write, for the answer-file check, without the fixture.
const ANSWER_WRITES = { src: path.join(ROOT, 'scripts', 'permission-hook.js'), suite: 'test/unit/answer-file-writes.test.js' };
const ANSWER_WRITES_VOCAB = { src: path.join(ROOT, 'public', 'read-only-shell.js'), suite: 'test/unit/answer-file-writes.test.js' };
const ANSWER_WRITES_VERDICT = { src: path.join(ROOT, 'scripts', 'code-mode-verdict.js'), suite: 'test/unit/answer-file-writes.test.js' };
// The launcher is refused before any card, through the real hook.
const LAUNCHER_REFUSED = { src: path.join(ROOT, 'scripts', 'permission-hook.js'), suite: 'test/unit/launcher-refused.test.js' };
// Rundock's console folder under home: the hook, the stored-grant check, the
// card's words and the sandbox block, through a made-up home.
const CONSOLE_HOOK = { src: path.join(ROOT, 'scripts', 'permission-hook.js'), suite: 'test/unit/console-folder.test.js' };
const CONSOLE_GRANT = { src: path.join(ROOT, 'lib', 'workspace', 'boundary.js'), suite: 'test/unit/console-folder.test.js' };
const CONSOLE_CARD = { src: path.join(ROOT, 'public', 'permissions.js'), suite: 'test/unit/console-folder.test.js' };
const CONSOLE_SANDBOX = { src: path.join(ROOT, 'lib', 'workspace', 'scaffold.js'), suite: 'test/unit/console-folder.test.js' };
const CONSOLE_WRITER = { src: path.join(ROOT, 'lib', 'runtime', 'claude-console.js'), suite: 'test/unit/console-folder.test.js' };
// A change allowed on the hook's card stands, without a second card.
const ALLOWED_GUARD = { src: path.join(ROOT, 'lib', 'workspace', 'answer-file-guard.js'), suite: 'test/unit/allowed-change-stands.test.js' };
const ALLOWED_HANDLER = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'process-control.js'), suite: 'test/unit/allowed-change-stands.test.js' };
const ALLOWED_TURNS = { src: path.join(ROOT, 'lib', 'runtime', 'claude-turn-guard.js'), suite: 'test/unit/allowed-change-stands.test.js' };
const ALLOWED_WIRING = { src: path.join(ROOT, 'server.js'), suite: 'test/unit/allowed-change-stands.test.js' };
const ALLOWED_ROUTER = { src: path.join(ROOT, 'lib', 'http-router.js'), suite: 'test/unit/allowed-change-stands.test.js' };
// What agents are told about the connector files, against the card's words.
const PROMPT_CONNECTORS = { src: path.join(ROOT, 'lib', 'agents', 'prompt.js'), suite: 'test/unit/discovery.test.js' };
// What Rundock decides for an agent's environment, never inherited from its own.
const SPAWN_ENV = { src: path.join(ROOT, 'lib', 'runtime', 'claude.js'), suite: 'test/unit/workspace-modes.test.js' };
// A shell command that reads or changes the Keychain: always asks, in both
// modes. The reading of the line, the card's sentence and Codex's grading are
// proven by the suite that drives them in process; the hook's own guards,
// through the real hook, server and card.
const KEYCHAIN_VERDICT = { src: path.join(ROOT, 'scripts', 'code-mode-verdict.js'), suite: 'test/unit/keychain-commands.test.js' };
const KEYCHAIN_CLIENT = { src: path.join(ROOT, 'public', 'permissions.js'), suite: 'test/unit/keychain-commands.test.js' };
const KEYCHAIN_CODEX = { src: path.join(ROOT, 'lib', 'runtime', 'codex-approval.js'), suite: 'test/unit/keychain-commands.test.js' };
const KEYCHAIN_PARSE = { src: path.join(ROOT, 'scripts', 'code-mode-parse.js'), suite: 'test/unit/keychain-commands.test.js' };
// The hook's platform seam: inert in the app, and never handed to an agent.
const KEYCHAIN_HOOK_UNIT = { src: path.join(ROOT, 'scripts', 'permission-hook.js'), suite: 'test/unit/keychain-commands.test.js' };
const KEYCHAIN_SPAWN_ENV = { src: path.join(ROOT, 'lib', 'runtime', 'claude.js'), suite: 'test/unit/claude-runtime-lib.test.js' };
const KEYCHAIN_HOOK_FLOW = { src: path.join(ROOT, 'scripts', 'permission-hook.js'), suite: 'test/integration/keychain-approvals.test.js' };

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

  // ===== THE BLOCK DENIES WHAT THE SECRETS TIER CARDS =====
  // Drop the credential entries and the OS layer permits a write the card
  // layer always asks about: the two layers disagree about the same file again.
  [SCAFFOLD, 'the block denies the runtimes\' credential files',
    '    ...credentialDenyFor(home),\n',
    ''],
  // Join a registry onto the wrong home and the deny names a file that is not
  // the credential, while the real one stays writable. The tie test reads the
  // hook's own runtimeHomes, so it must notice.
  [SCAFFOLD, 'the credential deny is joined onto each registry\'s own runtime home',
    "    ...CODEX_SECRET_RELATIVE_PATHS.map(f => path.posix.join(home, '.codex', f)),",
    "    ...CODEX_SECRET_RELATIVE_PATHS.map(f => path.posix.join(home, '.claude', f)),"],
  // A credential named in the block and not in the registry is the other
  // direction of drift: the tie test is bound both ways.
  [SCAFFOLD, 'the credential deny names nothing the secrets registry does not',
    "    ...SECRET_RELATIVE_PATHS.map(f => path.posix.join(home, '.claude', f)),",
    "    ...[...SECRET_RELATIVE_PATHS, 'extra.json'].map(f => path.posix.join(home, '.claude', f)),"],
  // Insert the credentials ahead of the workspace files and no earlier block
  // is a prefix of the new list: every existing workspace reads as a person's
  // edit and is never upgraded.
  [SCAFFOLD, 'the credential deny is appended, so earlier blocks stay recognisable and upgrade',
    '    ...[...RUNDOCK_ANSWER_FILES, ...RUNTIME_GUARDED_ANSWER_FILES].map(f => path.posix.join(workspaceDir, f)),\n    ...credentialDenyFor(home),\n',
    '    ...credentialDenyFor(home),\n    ...[...RUNDOCK_ANSWER_FILES, ...RUNTIME_GUARDED_ANSWER_FILES].map(f => path.posix.join(workspaceDir, f)),\n'],
  // Stop recognising the narrower deny lists and the block an earlier release
  // wrote is a stranger's edit: never rewritten, never given the new deny.
  [SCAFFOLD, 'a block carrying an earlier, shorter deny list is still recognised as ours',
    '  for (const n of WRITTEN_DENY_LENGTHS) if (n < deny.length) shapes.push(withDenyWrite(block, deny.slice(0, n)));\n',
    ''],
  // Accept every shorter list and a person who removes an entry from Rundock's
  // block has it put back on the next open, over their edit.
  [SCAFFOLD, 'only the deny lists a build wrote are recognised, not every shorter one',
    '  for (const n of WRITTEN_DENY_LENGTHS) if (n < deny.length) shapes.push(withDenyWrite(block, deny.slice(0, n)));\n',
    '  for (let n = 1; n < deny.length; n++) shapes.push(withDenyWrite(block, deny.slice(0, n)));\n'],
  // Forget a length a build wrote and every workspace carrying it is stranded.
  [SCAFFOLD, 'the list 0.15.6 wrote is recognised',
    'const WRITTEN_DENY_LENGTHS = [1, 2, 3, 8, 19, 21, 22, 23];',
    'const WRITTEN_DENY_LENGTHS = [1, 2, 3, 19, 21, 22, 23];'],
  [SCAFFOLD, 'the list 0.13.3 to 0.15.5 wrote is recognised',
    'const WRITTEN_DENY_LENGTHS = [1, 2, 3, 8, 19, 21, 22, 23];',
    'const WRITTEN_DENY_LENGTHS = [1, 2, 8, 19, 21, 22, 23];'],
  [SCAFFOLD, 'the lists the development line wrote before 0.13.3 are recognised',
    'const WRITTEN_DENY_LENGTHS = [1, 2, 3, 8, 19, 21, 22, 23];',
    'const WRITTEN_DENY_LENGTHS = [3, 8, 19, 21, 22, 23];'],
  // Leave the current length out and the day a longer list ships, every block
  // this build wrote reads as a person's edit and never upgrades.
  [SCAFFOLD_SETTINGS, 'the current deny list\'s length is recorded as written',
    'const WRITTEN_DENY_LENGTHS = [1, 2, 3, 8, 19, 21, 22, 23];',
    'const WRITTEN_DENY_LENGTHS = [1, 2, 3, 8, 19, 21, 22];'],
  [SCAFFOLD_SETTINGS, 'Connector secrets: the twenty-two-entry list the last build wrote is recognised',
    'const WRITTEN_DENY_LENGTHS = [1, 2, 3, 8, 19, 21, 22, 23];',
    'const WRITTEN_DENY_LENGTHS = [1, 2, 3, 8, 19, 21, 23];'],
  // ===== THE USER-LEVEL STATE FILE IS A SECRET AT BOTH LAYERS =====
  // Drop the home-level files from the block and ~/.claude.json is writable
  // by sandboxed commands again, its user-scope MCP servers with it.
  [SCAFFOLD, 'the block denies the user-level state file and its backup',
    '    ...HOME_SECRET_FILES.map(f => path.posix.join(home, f)),\n',
    ''],
  // Stop matching home-level secrets and a read of ~/.claude.json is ordinary
  // outside access again, with a folder offered to remember.
  [HOOK, 'a home-level secret is recognised by the secrets check',
    '  if (!h) return isHomeSecretFile(candidate, home, foldsCase);\n',
    '  if (!h) return false;\n'],
  // The shell and file-tool graders read the tags, not isSecretPath, outside
  // the runtime homes: drop the tag and the card loses its secret wording and
  // its refusal to remember.
  [HOOK, 'outside the runtime homes the tags still carry a home-level secret',
    '  if (!agentHome) return { agentHome: false, secret: isHomeSecretFile(resolvedPath, home, foldsCase), persistenceSurface: false };\n',
    '  if (!agentHome) return { agentHome: false, secret: false, persistenceSurface: false };\n'],
  // The backup carries the same contents as the file itself.
  [HOOK, 'the backup of the user-level state file is a secret too',
    "const HOME_SECRET_FILES = ['.claude.json', '.claude.json.backup'];",
    "const HOME_SECRET_FILES = ['.claude.json'];"],
  // The runtime reads ~/.claude/.config.json in place of ~/.claude.json, so
  // dropping it reopens the same escape under another name.
  [HOOK, 'the file the runtime reads in place of ~/.claude.json is a secret',
    "const SECRET_RELATIVE_PATHS = ['.credentials.json', '.config.json'];",
    "const SECRET_RELATIVE_PATHS = ['.credentials.json'];"],
  // Match by name anywhere and a namesake in a project is carded as a secret.
  [HOOK, 'a home-level secret matches at the home folder root only',
    '  return HOME_SECRET_FILES.some(f => c === foldCase(canonicalize(path.join(home, f)), foldsCase));\n',
    '  return HOME_SECRET_FILES.some(f => c.endsWith(path.sep + foldCase(f, foldsCase)));\n'],

  // ===== THE BLOCK DENIES WHAT THE RUNTIME ACTS ON OUTSIDE THE SANDBOX =====
  // Drop the escape paths and the protection is whatever the installed runtime
  // happens to deny: on a release without its own deny, a sandboxed command
  // plants a hook, plugin or settings file that runs unconfined next session.
  [SCAFFOLD, 'the block denies the runtime\'s own escape paths',
    '    ...escapeDenyFor(workspaceDir, home),\n',
    ''],
  // Join the home folder's names onto the workspace and the real ones stay
  // writable, while the workspace's agents and skills, which Rundock writes,
  // are denied instead.
  [SCAFFOLD, 'the escape paths are joined onto the runtime home, not the workspace',
    "    ...RUNTIME_HOME_ESCAPE_PATHS.map(f => path.posix.join(home, '.claude', f)),",
    "    ...RUNTIME_HOME_ESCAPE_PATHS.map(f => path.posix.join(workspaceDir, '.claude', f)),"],
  // The user's settings file names hooks the runtime starts itself.
  [SCAFFOLD, 'the user\'s settings file is denied',
    "const RUNTIME_HOME_ESCAPE_PATHS = ['settings.json', 'plugins',",
    "const RUNTIME_HOME_ESCAPE_PATHS = ['plugins',"],
  // The backups are not a tier at the card, so only the block names them.
  [SCAFFOLD, 'the runtime\'s backups of ~/.claude.json are denied',
    "'agents', 'commands', 'backups'];",
    "'agents', 'commands'];"],
  // The same user-level state under a non-default sign-in.
  [SCAFFOLD, 'the oauth-suffixed copies of ~/.claude.json are denied',
    '    ...OAUTH_STATE_FILES.map(f => path.posix.join(home, f)),\n',
    ''],
  // The workspace's own settings file is loaded for every agent spawned there.
  [SCAFFOLD, 'the workspace\'s project settings file is denied',
    "const WORKSPACE_ESCAPE_FILES = ['.claude/settings.json'];",
    'const WORKSPACE_ESCAPE_FILES = [];'],
  // Put the escape paths ahead of the credential files and the block the last
  // release wrote is no longer a prefix: every existing workspace reads as a
  // person's edit and never gains them.
  [SCAFFOLD, 'the escape paths are appended after the credential files, so earlier blocks upgrade',
    '    ...credentialDenyFor(home),\n    ...escapeDenyFor(workspaceDir, home),\n',
    '    ...escapeDenyFor(workspaceDir, home),\n    ...credentialDenyFor(home),\n'],

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
  // ===== CREATE NEVER OVERWRITES =====
  // Without the check, a taken name typed with a character to strip is answered
  // with the rename notice, and a second press would scaffold over it.
  [CREATE_HANDLER, 'a workspace name that already exists is refused before anything is written',
    '    if (fs.existsSync(dir)) { sendNameTaken(ws, rawName, dir); return; }\n',
    ''],
  [CREATE_HANDLER, 'a name that lost characters is said before the folder is made',
    '    if (removed) {',
    '    if (false) {'],
  // The check and the mkdir are two steps: a recursive mkdir would reuse a
  // folder made between them and scaffold over it.
  [CREATE_HANDLER, 'the workspace folder is made without recursion, so one that appeared is refused',
    '      try { fs.mkdirSync(dir); } catch (e) {',
    '      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {'],
  [CREATE_HANDLER, 'the folder offered to open is the real one on disk',
    'openPath = fs.realpathSync.native(dir);',
    'openPath = dir;'],
  [SCAFFOLD_KEEP, 'the default scaffold never writes over an existing CLAUDE.md',
    '  if (fs.existsSync(claudeMdPath)) {',
    '  if (false) {'],
  [SCAFFOLD_KEEP, 'a CLAUDE.md that appears after the check is kept, not reported as a failure',
    "    if (e.code === 'EEXIST') return { success: true, kept: true };\n",
    ''],

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
    "    const top = ctx.seam.gitTop(link ? ctx.pmod.dirname(link) : scope);",
    "    const top = ctx.seam.gitTop(link ? ctx.pmod.dirname(link) : scope) || scope;"],
  [VERDICT, "M2: \"inside a git working tree\" always false",
    "    const top = ctx.seam.gitTop(link ? ctx.pmod.dirname(link) : scope);",
    "    const top = null;"],
  [VERDICT, "M3a: the unsaved-work check on a delete always reports clean",
    "    const lost = [...(st.tracked || []), ...(st.untracked || []), ...(st.ignoredEnv || [])];",
    "    const lost = [];"],
  [VERDICT, "M3b: the unsaved-work check on a discard always reports clean",
    "  return lost.length ? unsaved(reason, lost) : RUNS;",
    "  return RUNS;"],
  [VERDICT, "M4: the unsaved-work check always reports unsaved",
    "    if (lost.length) return unsaved('unsaved-work', lost, { named, changed: st.tracked || [] });",
    "    return unsaved('unsaved-work', lost.length ? lost : ['x'], { named, changed: st.tracked || [] });"],
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
  [VERDICT, "M13a: a named file is deleted without reading git, as through 0.15.5",
    "  const named = !bulk;\n  if (named) {",
    "  const named = !bulk;\n  if (named && !targets.some(t => insideDotGit(t.path, ctx))) return RUNS;\n  if (named) {"],
  [VERDICT, "M13b: a named file outside any repository is deleted without asking",
    "    if (!top && named) { outside.push(ctx.pmod.basename(scope)); continue; }",
    "    if (!top && named) continue;"],
  [VERDICT, "M13c: a named file inside .git that does not exist yet is no longer git-internals",
    "    if (dotGit) return always(dotGitReason(dotGit.path, ctx));",
    ""],
  [CM_CLIENT, "M13d: the outside-repository card calls named files a folder",
    "      if (!names) return 'This deletes a folder",
    "      if (true) return 'This deletes a folder"],
  [VERDICT, "M13e: a restore of one named file skips git, as through 0.15.5",
    "    scopes.push(p);\n  }\n  if (!top) return always('git-unchecked');",
    "    if (!w.glob && w.text !== '.' && ctx.seam.exists(p) && !require('fs').statSync(p).isDirectory()) continue;\n    scopes.push(p);\n  }\n  if (!scopes.length) return RUNS;\n  if (!top) return always('git-unchecked');"],
  [CM_CLIENT, "M13f: a delete's card no longer says what each file loses",
    "    'unsaved-work': v => deleteCopy(v) || (namesOf(v)",
    "    'unsaved-work': v => (namesOf(v)"],
  [VERDICT, "M13g: a named delete follows a symlink to what it points to",
    "    const link = named ? t.link : null;",
    "    const link = null;"],
  [VERDICT, "M13h: pathspec magic in a restore or checkout is read as a plain path",
    "  if (operands.some(w => w.text.startsWith(':'))) return always('unreadable-command');\n  if (!candidates.length)",
    "  if (!candidates.length)"],
  [VERDICT, "M13i: a path list that cannot be read is taken as no list",
    "  const listed = listedSpecs(rest, ctx);\n  if (listed === null) return always('unreadable-command');\n  const dd = t.indexOf('--');\n  let candidates;",
    "  const listed = listedSpecs(rest, ctx) || undefined;\n  const dd = t.indexOf('--');\n  let candidates;"],
  [VERDICT, "M13j: a quoted pattern after checkout is taken as a branch",
    "      if (w.text === '.' || w.glob || /[*?[]/.test(w.text)) return true;",
    "      if (w.text === '.' || w.glob) return true;"],
  [VERDICT, "M13k: a forced checkout is judged like any other",
    "  const force = sub === 'checkout' && hasFlag(t, 'f', ['--force']);",
    "  const force = false;"],
  [VERDICT, "M13l: a switch that discards runs without asking",
    "  if (!hasFlag(t, 'f', ['--force', '--discard-changes'])) return RUNS;",
    "  return RUNS;"],
  [VERDICT, "M13m: a forced removal from git runs without asking",
    "    case 'rm': return judgeGitRm(",
    "    case 'rm': return RUNS; (judgeGitRm)("],
  [VERDICT, "M13n: shred is not judged as a delete",
    "  if (ctx.dialect === 'bash' && v === 'shred') return judgeShred(a, ctx, piped);\n",
    ""],
  [VERDICT_GIT, "M13o: a path list is read whatever kind of file it is",
    "    if (!st.isFile() || st.size > LIST_LIMIT_BYTES) return null;",
    "    if (st.size > LIST_LIMIT_BYTES) return null;"],
  [VERDICT, "M13p: a restore counts a file gone from the disk as unsaved again",
    "  const gone = new Set(want.restores ? st.deleted || [] : []);",
    "  const gone = new Set();"],
  [CM_HOOK, "M14: the verdict is sent in Notes mode",
    "    ? (codeMode ? codeModeVerdict : keychainVerdict)({ toolName: data.tool_name,",
    "    ? codeModeVerdict({ toolName: data.tool_name,"],
  [CM_CLIENT, "M15: the client offers Always allow on Always asks",
    "    if (verdict && verdict.verdict) return verdict.verdict === 'asks-once';",
    "    if (verdict && verdict.verdict) return verdict.verdict !== 'runs';"],
  [CM_CLIENT, "M16: the Asks-once key collapses to the binary key",
    "verdict.verdict === 'asks-once' && typeof verdict.rule === 'string' ? verdict.rule : null;",
    "verdict.verdict === 'asks-once' && typeof verdict.rule === 'string' ? 'Bash:git' : null;"],
  [CM_HOOK, "M17: Asks once fails open when nobody can be asked",
    "  const failClosed = answerFile || destructive || asksOnce || alwaysAsks || crossingAlwaysAsks || connectorAlwaysAsks;",
    "  const failClosed = answerFile || destructive || alwaysAsks || crossingAlwaysAsks || connectorAlwaysAsks;"],
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
    " || isAnswerFileOfAnyWorkspace(r, pmod) || reachesAnswerFiles(raw, r, pmod)\n",
    " || reachesAnswerFiles(raw, r, pmod)\n"],
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
    "  const start = () => { if (!guard) guard = acquire(workspace, onChange, { convoId }); };",
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
    '      if (SAID_WHEN_KEPT(relative)) tellTurn(g, { file: f, relative, kept: true, outsideTurn: true });',
    '      tellTurn(g, { file: f, relative, agentContent: null, restored: false, outsideTurn: true });'],
  [CM_ANSWER_GUARD, 'Answer-file guard: a settings change kept between turns is named in a notice',
    "const SAID_WHEN_KEPT = relative => relative === '.mcp.json' ||",
    "const SAID_WHEN_KEPT = relative => SHARED_FILES.has(relative) || relative === '.mcp.json' ||"],
  [CM_ANSWER_GUARD, "Answer-file guard: a Claude Code settings change between turns is put back like Rundock's own files",
    "    if (outsideTurn && isShared(relative)) {",
    "    if (false) {"],
  [CM_ANSWER_GUARD, "Answer-file guard: Rundock's own files changed between turns are kept like the settings",
    "const SHARED_FILES = new Set(['.claude/settings.local.json', '.claude/settings.json', '.mcp.json', '.rundock/mcp-secrets.json']);",
    "const SHARED_FILES = new Set(['.claude/settings.local.json', '.claude/settings.json', '.mcp.json', '.rundock/mcp-secrets.json', '.rundock/permissions.json', '.rundock/state.json']);"],
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
    "    if (writingWords.has(raw)) {",
    "    if (!readOnly) {"],
  [ANSWER_READS_HOOK, "Answer-file reads: a segment that writes a permission file is taken as a read",
    "    if (!reads) for (const t of shellPathTokens(rest.join(' '), posixText)) out.add(t);",
    "    if (false) for (const t of shellPathTokens(rest.join(' '), posixText)) out.add(t);"],
  [ANSWER_WRITES, 'Answer-file writes: a segment that can write a file is taken as a read',
    "    if (!reads) for (const t of shellPathTokens(rest.join(' '), posixText)) out.add(t);",
    "    if (false) for (const t of shellPathTokens(rest.join(' '), posixText)) out.add(t);"],
  [ANSWER_WRITES, 'Answer-file writes: a redirect target is not taken as written',
    "      if (target && !target.startsWith('&')) written.push(bare(target));",
    '      if (false) written.push(bare(target));'],
  [ANSWER_WRITES, 'Answer-file writes: the destination of a copy is not taken as written',
    '      if (operands.length > 1) written.push(operands[operands.length - 1]);',
    '      if (false) written.push(operands[operands.length - 1]);'],
  [ANSWER_WRITES, 'Answer-file writes: the file dd writes is not taken as written',
    "      for (const a of args) if (a.startsWith('of=')) written.push(a.slice(3));",
    "      for (const a of args) if (false) written.push(a.slice(3));"],
  [ANSWER_WRITES, 'Answer-file writes: sed editing in place is taken as a read',
    "      reads = !args.some(a => /^-[a-zA-Z]*[iI]/.test(a) || a.startsWith('--in-place'));",
    '      reads = true;'],
  [ANSWER_WRITES, "Answer-file writes: macOS sed's capital -I is taken as a read",
    '/^-[a-zA-Z]*[iI]/.test(a)',
    '/^-[a-zA-Z]*i/.test(a)'],
  [ANSWER_WRITES, 'Answer-file writes: every git subcommand is taken as a read',
    "      reads = GIT_READ_SUBCOMMANDS.has(args[i]) && !args.some(a => a.startsWith('--output'));",
    '      reads = true;'],
  [ANSWER_WRITES, 'Answer-file writes: a copy that links, or names its target folder, is taken as a read of its sources',
    "!args.some(a => a === '-t' || /^--(target-directory|link|symbolic-link)/.test(a) || /^-[a-zA-Z]*[ls]/.test(a))",
    'true'],
  [ANSWER_WRITES, 'Answer-file writes: a folder holding answer files is not looked at',
    '    && (holdsAnswerFiles(resolved, workspaceRoot, foldsCase, pmod) || globReachesAnswerFiles(resolved, workspaceRoot, foldsCase, pmod));',
    '    && globReachesAnswerFiles(resolved, workspaceRoot, foldsCase, pmod);'],
  [ANSWER_WRITES, 'Answer-file writes: a glob that reaches answer files is not looked at',
    '    && (holdsAnswerFiles(resolved, workspaceRoot, foldsCase, pmod) || globReachesAnswerFiles(resolved, workspaceRoot, foldsCase, pmod));',
    '    && holdsAnswerFiles(resolved, workspaceRoot, foldsCase, pmod);'],
  [ANSWER_WRITES, 'Answer-file writes: what a copy or move writes into a folder is not checked by name',
    '    if (!folder) continue;\n',
    '    continue;\n'],
  [ANSWER_WRITES, 'Answer-file writes: a folder a copy writes into is taken as replaced',
    '  const reachesAnswerFiles = (raw, resolved, pmod) => !intoFolders.has(raw)\n',
    '  const reachesAnswerFiles = (raw, resolved, pmod) => true\n'],
  [ANSWER_WRITES, 'Answer-file writes: a glob matches dot-names whatever its pattern',
    "    return !(first.startsWith('.') && !pattern.startsWith('.')) && re.test(first);",
    '    return re.test(first);'],
  [ANSWER_WRITES, "Answer-file writes: another workspace's .rundock and .claude folders are not looked at",
    "  return (name === '.rundock' || name === '.claude') && fs.existsSync(path.join(path.dirname(resolvedPath), '.rundock', 'state.json'));",
    '  return false;'],
  [ANSWER_WRITES, 'Answer-file writes: the workspace root counts as a folder holding answer files',
    '  if (c.startsWith(foldCase(canonicalize(root, pmod), folds) + pmod.sep)\n',
    '  if ((c + pmod.sep).startsWith(foldCase(canonicalize(root, pmod), folds) + pmod.sep)\n'],
  [ANSWER_WRITES, 'Answer-file writes: a comparer or viewer naming one still asks as a change',
    "    let reads = isReadOnlyShellCommand(rest.join(' ')) || READS_NAMED_FILES.has(verb);",
    "    let reads = isReadOnlyShellCommand(rest.join(' '));"],
  [ANSWER_WRITES, 'Answer-file writes: a pager, sdiff or bat is taken as only reading',
    "const READS_NAMED_FILES = new Set(['jq', 'diff', 'cmp', 'comm', 'md5', 'md5sum', 'shasum', 'sha1sum', 'sha256sum', 'cksum', 'strings']);",
    "const READS_NAMED_FILES = new Set(['jq', 'diff', 'cmp', 'comm', 'sdiff', 'md5', 'md5sum', 'shasum', 'sha1sum', 'sha256sum', 'cksum', 'strings', 'less', 'more', 'bat']);"],
  [ANSWER_WRITES, 'Answer-file writes: install -d is taken as a copy',
    '    if (makesFolders) reads = false;\n',
    ''],
  [ANSWER_WRITES, 'Answer-file writes: a folder install -d makes is taken as one it copies into',
    '    if (PLACES_INTO.has(verb) && !makesFolders) {',
    '    if (PLACES_INTO.has(verb)) {'],
  [ANSWER_WRITES, 'Answer-file writes: braces are not expanded',
    '      const forms = braceForms(t);',
    '      const forms = [t];'],
  [ANSWER_WRITES, 'Answer-file writes: a negated class is taken as a class of what it names',
    "      const negate = body[0] === '!' || body[0] === '^';",
    '      const negate = false;'],
  [ANSWER_WRITES, 'Answer-file writes: a [ with no ] after it is read as the start of a class',
    "      if (close < 0) { out += '\\\\['; continue; }",
    "      if (close < 0) { out += '['; continue; }"],
  [ANSWER_WRITES, 'Answer-file writes: a literal in code that is not shaped like a place is not read for answer files',
    '        if (MAY_NAME_ANSWER_FILE.test(lit)) names.push(lit);\n',
    ''],
  [ANSWER_WRITES, "Answer-file writes: a here-document's literals are not read for answer files",
    '\n    for (const t of code.names) names.push({ t, at });',
    '\n'],
  [ANSWER_WRITES, "Answer-file writes: -c and -e code's literals are not read for answer files",
    '\n      for (const t of code.names) names.push({ t, at });',
    '\n'],
  [ANSWER_WRITES, 'Answer-file writes: a literal naming a folder that holds answer files is not caught',
    '        || holdsAnswerFiles(r, workspaceRoot, foldsCase, flavour) || isRundockConsolePath(r, home, foldsCase, flavour)) addAnswer(r, flavour);',
    '        || isRundockConsolePath(r, home, foldsCase, flavour)) addAnswer(r, flavour);'],
  [ANSWER_WRITES, 'Answer-file writes: an unsure base is not tried from each literal cd',
    '      const starts = [base, ...cdStarts(pmod, at, fromStart)];',
    '      const starts = [base];'],
  [ANSWER_WRITES, 'Answer-file writes: a cd after another is not chained on it',
    '    for (const b of [...starts, ...out.map(l => l.base)]) {',
    '    for (const b of starts) {'],
  [ANSWER_WRITES, 'Answer-file writes: a cd after then or do is not seen',
    '    while (i < words.length - 1 && COMMAND_LEADS.has(words[i].raw)) i++;\n    const lead',
    '    const lead'],
  [ANSWER_WRITES, "Answer-file writes: a cd in a command handed to a shell counts for no word",
    '        .map(l => ({ base: l.base, at: c.at, scope: c.at })));',
    '        .map(l => ({ base: l.base, at: c.at, scope: -1 })));'],
  [ANSWER_WRITES, 'Answer-file writes: a cd is tried for words before it',
    '    .filter(l => (l.scope === null ? l.at < at : fromStart && l.scope === at)).map(l => l.base);',
    '    .filter(l => (l.scope === null ? true : fromStart && l.scope === at)).map(l => l.base);'],
  [ANSWER_WRITES, "Answer-file writes: a loop variable is not tried with its list",
    '      const spellings = forms.flatMap(loopForms);',
    '      const spellings = forms;'],
  [ANSWER_WRITES, 'Answer-file writes: ${name} is not read as the loop variable',
    "      const ref = new RegExp('\\\\$(?:\\\\{' + name + '\\\\}|' + name + '(?![A-Za-z0-9_]))', 'g');",
    "      const ref = new RegExp('\\\\$' + name + '(?![A-Za-z0-9_])', 'g');"],
  [ANSWER_WRITES, 'Answer-file writes: an input redirect is taken as a write',
    '      if (input) { if (!input[1]) i++; continue; }\n',
    ''],
  [ANSWER_WRITES, 'Answer-file writes: a file opened for reading and writing is taken as only read',
    'const INPUT_REDIRECT = /^\\d*(?:<<<|<(?![<>(]))(.*)$/;',
    'const INPUT_REDIRECT = /^\\d*(?:<<<|<(?![<(]))(.*)$/;'],
  [ANSWER_WRITES, "Answer-file writes: a shell's -c command is not read",
    '    if (shellCommand) commands.push({ text: shellCommand, at });\n',
    ''],
  [ANSWER_WRITES, "Answer-file writes: a shell after env, exec, nohup or sudo is not found",
    "const RUNS_WHAT_FOLLOWS = new Set(['env', 'exec', 'command', 'nohup', 'nice', 'time', 'sudo', 'doas']);",
    'const RUNS_WHAT_FOLLOWS = new Set([]);'],
  [ANSWER_WRITES, 'Answer-file writes: a shell named by its path is not found',
    "  if (!SHELL_NAMES.has((words[i] || '').split('/').pop())) return null;",
    "  if (!SHELL_NAMES.has(words[i] || '')) return null;"],
  [ANSWER_WRITES, 'Answer-file writes: -c in a bundle of options is not seen',
    '    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(w)) { given = true; continue; }',
    "    if (w === '-c') { given = true; continue; }"],
  [ANSWER_WRITES, "Answer-file writes: an option before -c is taken for the shell's command",
    "    if (w.startsWith('-') || w.startsWith('+')) continue;\n    return given ? w : null;",
    '    return given ? w : null;'],
  [ANSWER_WRITES_VERDICT, 'Answer-file writes: git clean -x runs in Code mode with .rundock in reach',
    '  if ((onlyIgnored || alsoIgnored) && scopes.some(p => under(rundock, p, ctx) || under(p, rundock, ctx))) {',
    '  if (false) {'],
  [ANSWER_WRITES_VOCAB, 'Read-only vocabulary: tree -o is taken as a read',
    '  var WRITING_FLAGS = { tree: /(^|\\s)-[A-Za-z]*o/, file:',
    '  var WRITING_FLAGS = { file:'],
  [ANSWER_WRITES_VOCAB, 'Read-only vocabulary: file -C is taken as a read',
    ', file: /(^|\\s)(-[A-Za-z]*C|--compile\\b)/ };',
    ' };'],
  [ANSWER_WRITES_VOCAB, 'Read-only vocabulary: a writing flag is never looked at',
    '      && WRITING_FLAGS[first].test(segment)) return false;',
    '      && false) return false;'],
  [ANSWER_READS_VOCAB, "Answer-file reads: od is not a read",
    "    'od', 'hexdump',",
    "    'hexdump',"],
  [ALLOW_KEY_HANDLER, "Allow keys: a refused save is not reported",
    "    refuseToolAllow(ws, msg.key, 'Could not record that allow: that is not a tool name.');",
    "    sendToolAllows(ws);"],
  [ALLOW_FAIL_VIEW, "Allow keys: the server's reason for a refused save is not shown",
    "next time.' + (why ? ` ${why}` : ''));",
    "next time.');"],
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
    "    if (checkFirst) require('./workspace/answer-file-guard.js').checkAnswerFilesNow(getWorkspace(), { finishedFor: id || null });",
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
  // ===== THE HINT UNDER REPEATED CARDS =====
  [REPEAT_HINT, 'Repeat hint: a command that can\'t be undone never counts',
    "    if (RundockPermissions.classifyRisk(tool, input) === 'high') return null;\n",
    ''],
  [REPEAT_HINT, 'Repeat hint: shown on the third card, not sooner',
    'const THRESHOLDS = [3, 6, 12];',
    'const THRESHOLDS = [2, 6, 12];'],
  [REPEAT_HINT, 'Repeat hint: counted over a rolling ten minutes',
    '    s.cards = s.cards.filter(c => now - c.at < WINDOW_MS);\n',
    ''],
  [REPEAT_HINT, 'Repeat hint: shown again only at the next threshold',
    '    if (s.next >= THRESHOLDS.length || count < THRESHOLDS[s.next]) return null;',
    '    if (count < THRESHOLDS[0]) return null;'],
  [REPEAT_HINT, 'Repeat hint: a re-sent card is not counted twice',
    '    if (s.seen.has(requestId)) return null;\n',
    ''],
  [REPEAT_HINT, 'Repeat hint: Code mode is offered from Notes mode only',
    "    if (SHELL.has(tool) && mode !== 'code') return { kind: 'code' };",
    "    if (SHELL.has(tool)) return { kind: 'code' };"],
  [REPEAT_HINT_LINK, 'Repeat hint link: never adds the Working folder itself',
    '      field.focus();\n    }\n  }\n  if (typeof ring.scrollIntoView',
    '      field.focus();\n      workingFoldersAdd();\n    }\n  }\n  if (typeof ring.scrollIntoView'],
  [REPEAT_HINT_LINK, 'Repeat hint link: never switches to Code mode itself',
    "  ring.classList.add('settings-ring');\n",
    "  ring.classList.add('settings-ring');\n  if (target === 'code') setWorkspaceMode('code');\n"],
  [REPEAT_HINT_LINK, 'Repeat hint link: never turns the switch off itself',
    "  const ring = find();\n",
    "  const ring = find();\n  if (target === 'sandbox') sandboxTurnOff();\n"],
  // ===== A CONNECTOR THAT SENDS ASKS EVERY TIME =====
  // Drop the send words from the hook's check and a send whose name carries a
  // read word (`send_status_update`) runs with no card at all.
  [CONNECTOR_HOOK_FLOW, 'Connector send: a send beside a read word runs as a read',
    '  if (mcpActionWords(toolName, true).some(t => MCP_DESTRUCTIVE_VERBS.has(t) || MCP_SEND_VERBS.has(t))) return false;',
    '  if (mcpActionWords(toolName, true).some(t => MCP_DESTRUCTIVE_VERBS.has(t))) return false;'],
  [CONNECTOR_HOOK, 'Connector send: the hook forgets resend',
    "const MCP_SEND_VERBS = new Set(['send','resend','reply','forward','fwd']);",
    "const MCP_SEND_VERBS = new Set(['send','reply','forward','fwd']);"],
  [CONNECTOR_HOOK, 'Connector send: the hook forgets fwd',
    "const MCP_SEND_VERBS = new Set(['send','resend','reply','forward','fwd']);",
    "const MCP_SEND_VERBS = new Set(['send','resend','reply','forward']);"],
  // Stop splitting at digits and `send2Email` is not a send; split for the
  // read check as well and `set_ipv4info` becomes a read on `info`.
  [CONNECTOR_HOOK, 'Connector send: the hook does not split at a digit',
    "  if (atDigits) action = action.replace(",
    "  if (false) action = action.replace("],
  [CONNECTOR_HOOK, 'Connector read: the read check splits at a digit',
    '  const tokens = mcpActionWords(toolName);\n  if (tokens.some(t => MCP_READ_VERBS.has(t))) return true;',
    '  const tokens = mcpActionWords(toolName, true);\n  if (tokens.some(t => MCP_READ_VERBS.has(t))) return true;'],
  [CONNECTOR_CLIENT, 'Connector send: the card does not split at a digit',
    "      .replace(/([A-Za-z])([0-9])/g, '$1 $2').replace(/([0-9])([A-Za-z])/g, '$1 $2')\n",
    ''],
  // Drop the client's grading and the card offers Always allow again, which
  // is the one click that let every later send through unseen.
  [CONNECTOR_CLIENT_FLOW, 'Connector send: the card offers Always allow on a send',
    "      if (words.some(w => MCP_SEND_VERBS.indexOf(w) !== -1)) return 'high';\n",
    ''],
  // Back to a pattern that needs `_` or `-` around the word and `deleteEvent`
  // offers Always allow, the gap the send fix had already closed for sends.
  [CONNECTOR_CLIENT_FLOW, 'Connector delete: the card offers Always allow on a camelCase delete',
    "      if (words.some(w => MCP_DESTRUCTIVE_VERBS.indexOf(w) !== -1)) return 'high';\n",
    "      if (/(^|[_\\-])(delete|remove|destroy|drop|cancel|abort|archive|trash|purge|clear|uninstall)([_\\-]|$)/.test(toolName.split('__').slice(2).join('_').toLowerCase())) return 'high';\n"],
  [CONNECTOR_CLIENT, 'Connector send: camelCase is not split, so sendEmail is not a send',
    "      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')\n",
    ''],
  [CONNECTOR_CLIENT, 'Connector send: the client forgets forward',
    "  const MCP_SEND_VERBS = ['send', 'resend', 'reply', 'forward', 'fwd'];",
    "  const MCP_SEND_VERBS = ['send', 'resend', 'reply', 'fwd'];"],
  // Read a saved send back and Settings lists an allow that never answers.
  [CONNECTOR_STORE_FLOW, 'Connector send: a saved allow for a send is read back',
    "data.allowedTools.filter((k) => typeof k === 'string' && k && !isMcpSendTool(k) && !isMcpDeleteTool(k))",
    "data.allowedTools.filter((k) => typeof k === 'string' && k && !isMcpDeleteTool(k))"],
  [CONNECTOR_STORE_FLOW, 'Connector delete: a saved allow for a delete is read back',
    "data.allowedTools.filter((k) => typeof k === 'string' && k && !isMcpSendTool(k) && !isMcpDeleteTool(k))",
    "data.allowedTools.filter((k) => typeof k === 'string' && k && !isMcpSendTool(k))"],
  [CONNECTOR_HANDLER_FLOW, 'Connector send: an allow for a send is saved again',
    '  if (isMcpSendTool(msg.key.trim()) || isMcpDeleteTool(msg.key.trim())) {',
    '  if (isMcpDeleteTool(msg.key.trim())) {'],
  [CONNECTOR_HANDLER_FLOW, 'Connector delete: an allow for a delete is saved again',
    '  if (isMcpSendTool(msg.key.trim()) || isMcpDeleteTool(msg.key.trim())) {',
    '  if (isMcpSendTool(msg.key.trim())) {'],
  [CONNECTOR_HOOK, 'Connector send: a tool that is not a connector is taken for a send',
    "  return String(toolName).startsWith('mcp__') && mcpActionWords(toolName, true).some(t => MCP_SEND_VERBS.has(t));",
    '  return mcpActionWords(toolName, true).some(t => MCP_SEND_VERBS.has(t));'],
  // Let a connector send or delete through when nobody can be asked and an
  // agent still running after Rundock has stopped sends with nobody seeing it.
  [CONNECTOR_HOOK_FLOW, 'Connector send: a send or delete is allowed when Rundock cannot be asked',
    "  const failClosed = answerFile || destructive || asksOnce || alwaysAsks || crossingAlwaysAsks || connectorAlwaysAsks;",
    "  const failClosed = answerFile || destructive || asksOnce || alwaysAsks || crossingAlwaysAsks;"],
  [CONNECTOR_HOOK_FLOW, 'Connector delete: a delete is allowed when Rundock cannot be asked',
    '  const connectorAlwaysAsks = isMcpSendTool(data.tool_name) || isMcpDeleteTool(data.tool_name);',
    '  const connectorAlwaysAsks = isMcpSendTool(data.tool_name);'],
  [CONNECTOR_HOOK_FLOW, 'Connector send: the refusal does not say why',
    "    else if (connectorAlwaysAsks) why = 'A connector",
    "    else if (false) why = 'A connector"],
  // The reason must be true of every act it covers: archiving can be undone.
  [CONNECTOR_HOOK_FLOW, 'Connector delete: the refusal says an archive cannot be called back',
    "sends, replies, forwards, deletes or archives is never done without asking, so with no way to ask it was refused",
    "sends, replies, forwards or deletes cannot be called back, and it is never done without asking, so it was refused"],
  [CONNECTOR_HOOK, 'Connector delete: a tool that is not a connector is taken for a delete',
    "  return String(toolName).startsWith('mcp__') && mcpActionWords(toolName, true).some(t => MCP_DESTRUCTIVE_VERBS.has(t));",
    '  return mcpActionWords(toolName, true).some(t => MCP_DESTRUCTIVE_VERBS.has(t));'],
  // Take the suggest rule out and a calendar's suggest_time raises a card
  // again, where the list and get actions beside it run without one.
  [CONNECTOR_HOOK_FLOW, 'Connector read: suggesting a time asks as a write',
    '  return suggestsOnlyATime(tokens);',
    '  return false;'],
  // Loosen it and suggest_edit, suggest_time_and_book or a bare suggest run
  // with no card, which is a write turned into a read.
  [CONNECTOR_HOOK, 'Connector read: suggest beside any time word is a read',
    '  return rest.length > 0 && rest.length < tokens.length && rest.every(t => MCP_SUGGEST_TIME_WORDS.has(t));',
    '  return rest.length > 0 && rest.length < tokens.length && rest.some(t => MCP_SUGGEST_TIME_WORDS.has(t));'],
  [CONNECTOR_HOOK, 'Connector read: a bare suggest is a read',
    '  return rest.length > 0 && rest.length < tokens.length && rest.every(t => MCP_SUGGEST_TIME_WORDS.has(t));',
    '  return rest.length < tokens.length && rest.every(t => MCP_SUGGEST_TIME_WORDS.has(t));'],
  [CONNECTOR_HOOK, 'Connector read: time words with no suggest are a read',
    '  return rest.length > 0 && rest.length < tokens.length && rest.every(t => MCP_SUGGEST_TIME_WORDS.has(t));',
    '  return rest.length > 0 && rest.every(t => MCP_SUGGEST_TIME_WORDS.has(t));'],
  [CONNECTOR_HOOK, 'Connector read: the time words lose availability',
    "const MCP_SUGGEST_TIME_WORDS = new Set(['time','times','slot','slots','availability','meeting','meetings']);",
    "const MCP_SUGGEST_TIME_WORDS = new Set(['time','times','slot','slots','meeting','meetings']);"],
  // ===== A KEYCHAIN COMMAND ASKS EVERY TIME =====
  // Stop reading `security` and every Keychain read runs in Code mode with no
  // card; let anything unnamed run and the allowlist becomes a denylist of one.
  [KEYCHAIN_VERDICT, 'Keychain: security is never read',
    "  if (v === 'security' && ctx.keychainPlatform === 'darwin') return judgeSecurity(a);\n",
    ''],
  // Away from a Mac a `security` is somebody else's program.
  [KEYCHAIN_VERDICT, 'Keychain: security is read as the Keychain on any host',
    "  if (v === 'security' && ctx.keychainPlatform === 'darwin') return judgeSecurity(a);",
    "  if (v === 'security') return judgeSecurity(a);"],
  [KEYCHAIN_VERDICT, 'Keychain: the Keychain gate ignores the platform it is named',
    '    keychainPlatform: opts.keychainPlatform || platform,',
    '    keychainPlatform: platform,'],
  [KEYCHAIN_VERDICT, 'Keychain: a subcommand not named as a display runs',
    '  return always(KEYCHAIN);\n}\n\nfunction judgeDocker',
    '  return RUNS;\n}\n\nfunction judgeDocker'],
  [KEYCHAIN_VERDICT, 'Keychain: a password lookup without -w or -g runs',
    '  if (SECURITY_DISPLAYS.has(sub.text)) return RUNS;',
    "  if (SECURITY_DISPLAYS.has(sub.text) || (/^find-/.test(sub.text) && !args.some(w => /^-[wgp]$/.test(w.text)))) return RUNS;"],
  [KEYCHAIN_VERDICT, 'Keychain: -s on a display command goes unnoticed',
    '  if (SECURITY_DISPLAYS_UNLESS_SET.has(sub.text) && !args.slice(i + 1).some(w => w.expands || /^-[A-Za-z]*s/.test(w.text))) return RUNS;',
    '  if (SECURITY_DISPLAYS_UNLESS_SET.has(sub.text)) return RUNS;'],
  [KEYCHAIN_VERDICT, 'Keychain: interactive mode runs',
    '    if (!/^-[hlqv]+$/.test(args[i].text)) return always(KEYCHAIN);',
    '    if (!/^-[hilpqv]+$/.test(args[i].text)) return always(KEYCHAIN);'],
  // The other direction: a display asking is a card on everyday code signing.
  [KEYCHAIN_VERDICT, 'Keychain: listing code-signing identities asks',
    "const SECURITY_DISPLAYS = new Set(['help', 'error', 'show-keychain-info', 'verify-cert', 'find-identity']);",
    "const SECURITY_DISPLAYS = new Set(['help', 'error', 'show-keychain-info', 'verify-cert']);"],
  // Lose the tie and a line that asks for another reason first hides the
  // Keychain from Notes mode, which only hears a Keychain verdict.
  [KEYCHAIN_VERDICT, 'Keychain: another reason to ask hides the Keychain',
    '  if (a.reason !== KEYCHAIN && b.reason !== KEYCHAIN) return a;',
    '  return a;'],
  // Drop the other reason and a card for a line that reads the Keychain and
  // deletes unsaved work no longer says what would be lost.
  [KEYCHAIN_VERDICT, 'Keychain: the other reason on the line is dropped',
    '  return also ? { ...named, also } : named;',
    '  return named;'],
  [KEYCHAIN_VERDICT, 'Keychain: a later reason is kept over an earlier one',
    '  const also = [a, b].map(v =>',
    '  const also = [b, a].map(v =>'],
  [KEYCHAIN_CLIENT, 'Keychain: the card leaves out the other reason',
    '    const also = verdict.also && REASON_COPY[verdict.also.reason];',
    '    const also = null;'],
  [KEYCHAIN_VERDICT, 'Keychain: what sudo runs is not read',
    "  return stricter(always('elevation'), inner.elevated ? judgeElevated(inner, quiet) : judgeCommand(inner, quiet));",
    "  return always('elevation');"],
  // Read what sudo runs, or an unfinished here-document, with the facts and
  // they ask git about everything they pass, for an answer that cannot change.
  [KEYCHAIN_VERDICT, 'Keychain: what sudo runs is read with git',
    '  const quiet = { ...inert(ctx), elevations };',
    '  const quiet = { ...ctx, elevations };'],
  [KEYCHAIN_VERDICT, 'Keychain: elevations are read however deep',
    "  if (elevations > MAX_DEPTH || ctx.dialect !== 'bash'",
    "  if (ctx.dialect !== 'bash'"],
  [KEYCHAIN_VERDICT, "Keychain: sudo's short options are read as the command",
    "    if (!/^--/.test(f) && [...f.slice(1)].findIndex(c => ELEVATION_VALUE_FLAGS.includes(c)) === f.length - 2) w.shift();\n",
    ''],
  [KEYCHAIN_VERDICT, "Keychain: sudo's long options are read as the command",
    '    if (ELEVATION_VALUE_LONG.test(f)) { w.shift(); continue; }\n',
    ''],
  [KEYCHAIN_VERDICT, "Keychain: a value joined to a sudo option swallows the command",
    'findIndex(c => ELEVATION_VALUE_FLAGS.includes(c)) === f.length - 2) w.shift();',
    'findIndex(c => ELEVATION_VALUE_FLAGS.includes(c)) !== -1) w.shift();'],
  [KEYCHAIN_VERDICT, 'Keychain: xargs and sudo is not read past',
    '  if (u.elevated) return judgeElevated(u, ctx);\n  return judgeCommand(u, ctx, { piped: true });',
    "  if (u.elevated) return always('elevation');\n  return judgeCommand(u, ctx, { piped: true });"],
  [KEYCHAIN_VERDICT, 'Keychain: find -exec and sudo is not read past',
    "    if (u.elevated) return judgeElevated(u, ctx);\n    if (['rm',",
    "    if (u.elevated) return always('elevation');\n    if (['rm',"],
  // The shell runs a line whose here-document never ends; reading none of it
  // lets a Keychain read ride in on one in Notes mode.
  [KEYCHAIN_VERDICT, 'Keychain: a here-document that never ends hides the line',
    "  if (!h.ok) return stricter(always('unreadable-command'), h.unfinished ? judgeStripped(h.unfinished, inert(ctx), depth + 1) : RUNS);",
    "  if (!h.ok) return always('unreadable-command');"],
  [KEYCHAIN_VERDICT, 'Keychain: an unfinished here-document is read with git',
    'judgeStripped(h.unfinished, inert(ctx), depth + 1)',
    'judgeStripped(h.unfinished, ctx, depth + 1)'],
  [KEYCHAIN_PARSE, 'Keychain: an unfinished here-document gives nothing to read',
    '      if (j < 0) return { text: s, bodies, ok: false, unfinished: unfinished(out, bodies, s.slice(i + 1), markers[0]) };',
    '      if (j < 0) return { text: s, bodies, ok: false };'],
  // Read an unfinished body as commands and prose in it raises a Keychain card.
  [KEYCHAIN_PARSE, "Keychain: an unfinished here-document's body is read as commands",
    '  return { text, bodies: [...bodies, { body, expands: !marker.quoted }], ok: true };',
    '  return { text: `${text}\n${body}`, bodies, ok: true };'],
  [KEYCHAIN_VERDICT, 'Keychain: Notes mode is handed every verdict',
    '  if (codeModeVerdict({ ...opts, context: {} }).reason !== KEYCHAIN) return null;\n',
    ''],
  [KEYCHAIN_VERDICT, 'Keychain: Notes mode finds nothing',
    '  return v.reason === KEYCHAIN ? v : always(KEYCHAIN);',
    '  return null;'],
  [KEYCHAIN_VERDICT, 'Keychain: Notes mode reads no facts for its card',
    '  const v = codeModeVerdict(opts);',
    '  const v = codeModeVerdict({ ...opts, context: {} });'],
  [KEYCHAIN_CLIENT, 'Keychain: the card says it cannot be undone',
    "    'keychain': () => 'This reads or changes a password or key stored in your Mac\\'s Keychain, where sign-in tokens are kept.',\n",
    ''],
  [KEYCHAIN_CODEX, 'Keychain: a Codex escalation in Notes mode is graded as ordinary',
    '  const verdict = (codeMode ? codeModeVerdict : keychainVerdict)({ toolName, command, cwd, workspaceRoot, extraDirs, home, keychainPlatform });',
    '  const verdict = codeMode ? codeModeVerdict({ toolName, command, cwd, workspaceRoot, extraDirs, home, keychainPlatform }) : null;'],
  [KEYCHAIN_CODEX, 'Keychain: a Codex Keychain card offers a folder to remember',
    "        grant_dir: verdict && verdict.reason === 'keychain' ? null : ((crossings[0] && crossings[0].grantDir) || access.grantDir || null),",
    '        grant_dir: (crossings[0] && crossings[0].grantDir) || access.grantDir || null,'],
  // Through the real hook: Notes mode never asks the question, the refusal
  // misstates why, and the card offers a folder to remember.
  [KEYCHAIN_HOOK_FLOW, 'Keychain: Notes mode never asks',
    '    ? (codeMode ? codeModeVerdict : keychainVerdict)({ toolName: data.tool_name,',
    '    ? (codeMode ? codeModeVerdict : () => null)({ toolName: data.tool_name,'],
  [KEYCHAIN_HOOK_FLOW, 'Keychain: refused unanswered as a command that cannot be undone',
    '    else if (keychain) why = ',
    '    else if (false) why = '],
  [KEYCHAIN_HOOK_FLOW, 'Keychain: the refusal leaves out what cannot be undone',
    "\n      + (verdict.also ? ' Part of it also cannot be undone.' : '')",
    ''],
  // The test seam: a platform named without its flag must change nothing, and
  // with it the hook must judge for the platform named, or the end-to-end
  // suite proves the Keychain rules on a Mac alone.
  [KEYCHAIN_HOOK_FLOW, 'Keychain: the test platform counts without its flag',
    "  return (env.RUNDOCK_TEST_SEAMS === '1' && env.RUNDOCK_TEST_PLATFORM) || process.platform;",
    '  return env.RUNDOCK_TEST_PLATFORM || process.platform;'],
  [KEYCHAIN_HOOK_UNIT, 'Keychain: the platform seam is read in the app',
    '  if (versions.electron) return process.platform;\n',
    ''],
  [KEYCHAIN_SPAWN_ENV, "Keychain: an agent inherits the seam's flag",
    '  delete env.RUNDOCK_TEST_SEAMS;\n',
    ''],
  [KEYCHAIN_SPAWN_ENV, "Keychain: an agent inherits the seam's platform",
    '  delete env.RUNDOCK_TEST_PLATFORM;\n',
    ''],
  [KEYCHAIN_HOOK_FLOW, 'Keychain: the hook judges for its host whatever the test names',
    'workspaceRoot: wsRoot, extraDirs, keychainPlatform: keychainPlatform() })',
    'workspaceRoot: wsRoot, extraDirs })'],
  // Hand the seam to the whole verdict and Windows path handling on this host
  // lets Code mode run deletes it always asks about.
  [KEYCHAIN_HOOK_FLOW, 'Keychain: the platform seam moves the whole verdict',
    'workspaceRoot: wsRoot, extraDirs, keychainPlatform: keychainPlatform() })',
    'workspaceRoot: wsRoot, extraDirs, platform: keychainPlatform() })'],
  [KEYCHAIN_HOOK_FLOW, 'Keychain: the card offers a folder to remember',
    '          grant_dir: keychain ? null : ((boundaryCrossings[0] && boundaryCrossings[0].grantDir) || access.grantDir || null),',
    '          grant_dir: (boundaryCrossings[0] && boundaryCrossings[0].grantDir) || access.grantDir || null,'],
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
  [STOP_ASK_GLUE, "Stop and ask: a declined Codex approval is never told",
    "else if (ev.respond('decline') !== false) tellCodexRefusal(convoId, ev, reason === 'timeout' ? 'timeout' : 'denied', toolName);",
    "else ev.respond('decline');"],
  [STOP_ASK_GLUE, "Stop and ask: a Codex timeout is told as a denial",
    "tellCodexRefusal(convoId, ev, reason === 'timeout' ? 'timeout' : 'denied', toolName)",
    "tellCodexRefusal(convoId, ev, 'denied', toolName)"],
  [STOP_ASK_GLUE, "Stop and ask: a Codex without turn/steer is never told",
    "Promise.resolve().then(() => ev.steer(line)).catch(later);",
    "Promise.resolve().then(() => ev.steer(line)).catch(() => {});"],
  [STOP_ASK_CLIENT, "Stop and ask: the approval event carries no way to steer",
    "{ type: 'approval', kind, requestId: id, params, respond, steer }",
    "{ type: 'approval', kind, requestId: id, params, respond }"],
  [APPROVED_HOOK, "Approved: an approval on a card is never told to the agent",
    "            ...(approved ? { additionalContext: approved } : {}),\n",
    ""],
  [APPROVED_HOOK, "Approved: an allow that asked nobody is told as a card",
    "result.allow === true && result.card === true ? approvalNotice(data.tool_name) : null",
    "result.allow === true ? approvalNotice(data.tool_name) : null"],
  [APPROVED_HOOK, "Approved: the approval line pushes a waiting put-back line out",
    "const context = [own.additionalContext, note].filter(Boolean).join('\\n');",
    "const context = own.additionalContext || note;"],
  [APPROVED_LINE, "Approved: the line names any tool it is handed",
    "return `The person approved ${subjectFor(toolName)} in Rundock after a permission card.`;",
    "return `The person approved this ${toolName} in Rundock after a permission card.`;"],
  [APPROVED_HANDLER, "Approved: the handler drops that a card was answered",
    "pending.res.end(JSON.stringify(card ? { allow: true, card: true } : { allow: msg.allow }));",
    "pending.res.end(JSON.stringify({ allow: msg.allow }));"],
  [APPROVED_HANDLER, "Approved: a card flag on a denial counts as an approval",
    "const card = msg.allow === true && msg.card === true;",
    "const card = msg.card === true;"],
  [APPROVED_CLICK, "Approved: a click on a card does not say it was a card",
    "    card: true,\n    toolInput: pending.toolInput || {}",
    "    toolInput: pending.toolInput || {}"],
  [APPROVED_HANDLER_CODEX, "Approved: a Codex decision never hears that a card was answered",
    "pending.onDecision(msg.allow === true, 'user', { card });",
    "pending.onDecision(msg.allow === true, 'user');"],
  [APPROVED_GLUE, "Approved: a Codex approval on a card is never told",
    "if (ev.respond('accept') !== false && how && how.card) tellCodexApproval(convoId, ev, toolName);",
    "ev.respond('accept');"],
  [APPROVED_GLUE, "Approved: a Codex allow with no card is told as a card",
    "if (ev.respond('accept') !== false && how && how.card) tellCodexApproval(convoId, ev, toolName);",
    "if (ev.respond('accept') !== false) tellCodexApproval(convoId, ev, toolName);"],
  // Removing the guard alone changes nothing a test can see: a missing steer
  // throws inside the promise and the catch absorbs it. Taking the guard's
  // branch every time is what it stands between, and that is caught.
  [APPROVED_GLUE, "Approved: the steer guard skips a Codex that can steer",
    "  if (typeof ev.steer !== 'function') return;\n  Promise.resolve().then(() => ev.steer(approvalNotice(toolName)))",
    "  if (typeof ev.steer !== 'function' || true) return;\n  Promise.resolve().then(() => ev.steer(approvalNotice(toolName)))"],
  [APPROVED_GLUE, "Approved: a Codex without turn/steer is told in a later turn",
    "  Promise.resolve().then(() => ev.steer(approvalNotice(toolName))).catch(() => {});",
    "  Promise.resolve().then(() => ev.steer(approvalNotice(toolName))).catch(() => queueCodexNotice(convoId, approvalNotice(toolName)));"],
  // ===== THE FILES THAT DECIDE WHAT RUNS ALWAYS ASK =====
  // The hook matches the `.rundock` names in every workspace, this one
  // included (isRundockAnswerFileAnywhere), so the registry entry is what
  // puts the launcher and the connector secrets under the guard: these rows
  // run the guard's suite.
  [REGISTRY_TO_GUARD, 'What runs: the launcher is left out of the registry, so the guard does not watch it',
    'const WORKSPACE_ANSWER_FILES = [...RUNDOCK_ANSWER_FILES, ...RUNTIME_GUARDED_ANSWER_FILES, ...LAUNCHER_FILES, ...WHAT_RUNS_FILES];',
    'const WORKSPACE_ANSWER_FILES = [...RUNDOCK_ANSWER_FILES, ...RUNTIME_GUARDED_ANSWER_FILES, ...WHAT_RUNS_FILES];'],
  [WHAT_RUNS_HOOK, "What runs: another workspace's launcher is not matched by name",
    "[...RUNDOCK_ANSWER_FILES, ...LAUNCHER_FILES, MCP_SECRETS_FILE].some(f => fold(f.split('/')[1]) === fold(parts[n - 1]))",
    "[...RUNDOCK_ANSWER_FILES, MCP_SECRETS_FILE].some(f => fold(f.split('/')[1]) === fold(parts[n - 1]))"],
  [WHAT_RUNS_CLIENT, 'What runs: the launcher card is worded as an ordinary answer file',
    "      if (n >= 2 && parts[n - 2] === '.rundock' && /^permission-hook\\.(sh|cmd)$/.test(parts[n - 1])) return 'launcher';\n",
    ''],
  [WHAT_RUNS_CLIENT, 'What runs: the stakes on a card that also reaches outside ignore which file it is',
    '    if (crossing.answerFile) return answerFileCopy(crossing.path);',
    '    if (crossing.answerFile) return answerFileCopy();'],
  [WHAT_RUNS_VIEW, 'What runs: the card reads no path when choosing its words',
    '    const named = [req.resolved_path, ...crossingList.map(c => c && c.path)].filter(Boolean);',
    '    const named = [];'],
  [WHAT_RUNS_HOOK, 'What runs: .mcp.json and the project settings are ordinary inside work',
    'const WORKSPACE_ANSWER_FILES = [...RUNDOCK_ANSWER_FILES, ...RUNTIME_GUARDED_ANSWER_FILES, ...LAUNCHER_FILES, ...WHAT_RUNS_FILES];',
    'const WORKSPACE_ANSWER_FILES = [...RUNDOCK_ANSWER_FILES, ...RUNTIME_GUARDED_ANSWER_FILES, ...LAUNCHER_FILES];'],
  [WHAT_RUNS_HOOK, 'What runs: the hook-scripts folder is not looked at',
    '    || matchesAnswerFileSet(WHAT_RUNS_DIRS, resolvedPath, workspaceRoot, foldsCase, pmod, true);',
    ';'],
  [WHAT_RUNS_HOOK, 'What runs: a folder entry matches only the folder itself, not what is in it',
    '    return c === entry || (within && c.startsWith(entry + pmod.sep));',
    '    return c === entry;'],
  [WHAT_RUNS_HOOK, "What runs: a workspace's own file reached through a linked folder is ordinary outside access",
    '  if (writing && isWorkspaceAnswerFile(resolvedPath, workspaceRoot, foldsCase)) {\n    // `where` says',
    '  if (inside && writing && isWorkspaceAnswerFile(resolvedPath, workspaceRoot, foldsCase)) {\n    // `where` says'],
  [WHAT_RUNS_HOOK, "What runs: another workspace's .mcp.json and hook scripts are not matched",
    '    || (pmod === path && (isRundockWorkspaceSettingsFile(resolvedPath) || isRundockWorkspaceRunsFile(resolvedPath)));',
    '    || (pmod === path && isRundockWorkspaceSettingsFile(resolvedPath));'],
  [WHAT_RUNS_CLIENT, 'What runs: the card for .mcp.json and the project settings is worded as an ordinary answer file',
    "      if (parts[n - 1] === '.mcp.json' || (n >= 2 && parts[n - 2] === '.claude' && parts[n - 1] === 'settings.json')) return 'runs';\n",
    ''],
  [WHAT_RUNS_CLIENT, 'What runs: the card for a hook script is worded as an ordinary answer file',
    "      if (parts.some((s, i) => s === '.claude' && parts[i + 1] === 'hooks')) return 'runs';\n",
    ''],
  [WHAT_RUNS_CODEX, 'What runs: a Codex file change inside the hook-scripts folder of a workspace with no state file is accepted',
    '  if (own || hook.isWorkspaceAnswerFile(g, workspaceRoot)) return true;',
    '  if (own) return true;'],
  // The sandbox block names the launcher and .mcp.json as well, so a sandboxed
  // write to either is refused however it was made.
  [SCAFFOLD, 'What runs: the block denies the connector file and the launcher',
    '    ...WORKSPACE_RUNS_FILES.map(f => path.posix.join(workspaceDir, f)),\n',
    ''],
  [SCAFFOLD, 'What runs: the block denies the launcher',
    "const WORKSPACE_RUNS_FILES = ['.mcp.json', '.rundock/permission-hook.sh', '.rundock/mcp-secrets.json'];",
    "const WORKSPACE_RUNS_FILES = ['.mcp.json', '.rundock/mcp-secrets.json'];"],
  [SCAFFOLD, 'What runs: the block denies the connector file',
    "const WORKSPACE_RUNS_FILES = ['.mcp.json', '.rundock/permission-hook.sh', '.rundock/mcp-secrets.json'];",
    "const WORKSPACE_RUNS_FILES = ['.rundock/permission-hook.sh', '.rundock/mcp-secrets.json'];"],
  [RUNS_NOTE, 'What runs: the card for a file Claude Code protects promises that an Allow holds',
    "Claude Code protects it too, and may '\n        + 'refuse the change even after you allow it here. An agent",
    "An agent"],
  [REGISTRY_TO_GUARD, 'Connector secrets: the per-user connector file is left out of the registry, so the guard does not watch it',
    "const WHAT_RUNS_FILES = ['.mcp.json', '.claude/settings.json', MCP_SECRETS_FILE];",
    "const WHAT_RUNS_FILES = ['.mcp.json', '.claude/settings.json'];"],
  [SECRETS_HOOK, "Connector secrets: another workspace's copy is not matched by name",
    "[...RUNDOCK_ANSWER_FILES, ...LAUNCHER_FILES, MCP_SECRETS_FILE].some(f => fold(f.split('/')[1]) === fold(parts[n - 1]))",
    "[...RUNDOCK_ANSWER_FILES, ...LAUNCHER_FILES].some(f => fold(f.split('/')[1]) === fold(parts[n - 1]))"],
  [SECRETS_CARD, 'Connector secrets: the card is worded as an ordinary answer file',
    "      if (n >= 2 && parts[n - 2] === '.rundock' && parts[n - 1] === 'mcp-secrets.json') return 'connectorSecrets';\n",
    ''],
  [SCAFFOLD, 'Connector secrets: the block denies the per-user connector file',
    "const WORKSPACE_RUNS_FILES = ['.mcp.json', '.rundock/permission-hook.sh', '.rundock/mcp-secrets.json'];",
    "const WORKSPACE_RUNS_FILES = ['.mcp.json', '.rundock/permission-hook.sh'];"],
  // Insert them ahead of the escape paths and the block the last build wrote is
  // no longer a prefix: every workspace carrying it reads as a person's edit.
  [SCAFFOLD, 'What runs: they are appended after the escape paths, so the last build\'s block upgrades',
    '    ...escapeDenyFor(workspaceDir, home),\n    ...WORKSPACE_RUNS_FILES.map(f => path.posix.join(workspaceDir, f)),\n',
    '    ...WORKSPACE_RUNS_FILES.map(f => path.posix.join(workspaceDir, f)),\n    ...escapeDenyFor(workspaceDir, home),\n'],
  // Forget the length the last build wrote and every workspace carrying it is
  // stranded: never rewritten, never given the new entries.
  [SCAFFOLD_SETTINGS, 'What runs: the nineteen-entry list is recognised',
    'const WRITTEN_DENY_LENGTHS = [1, 2, 3, 8, 19, 21, 22, 23];',
    'const WRITTEN_DENY_LENGTHS = [1, 2, 3, 8, 21, 22, 23];'],
  [SCAFFOLD, 'What runs: the nineteen-entry list upgrades on the next open',
    'const WRITTEN_DENY_LENGTHS = [1, 2, 3, 8, 19, 21, 22, 23];',
    'const WRITTEN_DENY_LENGTHS = [1, 2, 3, 8, 21, 22, 23];'],
  [SCAFFOLD_SETTINGS, 'Connector secrets: the twenty-one-entry list the last build wrote is recognised',
    'const WRITTEN_DENY_LENGTHS = [1, 2, 3, 8, 19, 21, 22, 23];',
    'const WRITTEN_DENY_LENGTHS = [1, 2, 3, 8, 19, 22, 23];'],
  [SCAFFOLD, 'Connector secrets: the twenty-one-entry list upgrades on the next open',
    'const WRITTEN_DENY_LENGTHS = [1, 2, 3, 8, 19, 21, 22, 23];',
    'const WRITTEN_DENY_LENGTHS = [1, 2, 3, 8, 19, 22, 23];'],
  // An inherited Code-mode flag puts a Notes workspace under Code-mode grading;
  // an inherited conversation id names a conversation the agent does not have.
  [SPAWN_ENV, 'Spawn env: an inherited RUNDOCK_CODE_MODE reaches the agent',
    "const INHERITED_NAMES_CLEARED = ['RUNDOCK_CODE_MODE', 'RUNDOCK_CONVO_ID'];",
    "const INHERITED_NAMES_CLEARED = ['RUNDOCK_CONVO_ID'];"],
  [SPAWN_ENV, 'Spawn env: an inherited RUNDOCK_CONVO_ID reaches the agent',
    "const INHERITED_NAMES_CLEARED = ['RUNDOCK_CODE_MODE', 'RUNDOCK_CONVO_ID'];",
    "const INHERITED_NAMES_CLEARED = ['RUNDOCK_CODE_MODE'];"],
  // ===== LAUNCHCTL CHANGES WHAT EVERY LATER PROGRAM INHERITS =====
  // Each subcommand that changes the launch environment or starts a program
  // under launchd always asks, like elevation; reading it runs.
  [VERDICT, 'launchctl: setenv runs with no card',
    "const LAUNCHCTL_CHANGES = new Set(['setenv', 'unsetenv', 'load', 'bootstrap', 'submit', 'config']);",
    "const LAUNCHCTL_CHANGES = new Set(['unsetenv', 'load', 'bootstrap', 'submit', 'config']);"],
  [VERDICT, 'launchctl: unsetenv runs with no card',
    "const LAUNCHCTL_CHANGES = new Set(['setenv', 'unsetenv', 'load', 'bootstrap', 'submit', 'config']);",
    "const LAUNCHCTL_CHANGES = new Set(['setenv', 'load', 'bootstrap', 'submit', 'config']);"],
  [VERDICT, 'launchctl: load runs with no card',
    "const LAUNCHCTL_CHANGES = new Set(['setenv', 'unsetenv', 'load', 'bootstrap', 'submit', 'config']);",
    "const LAUNCHCTL_CHANGES = new Set(['setenv', 'unsetenv', 'bootstrap', 'submit', 'config']);"],
  [VERDICT, 'launchctl: bootstrap runs with no card',
    "const LAUNCHCTL_CHANGES = new Set(['setenv', 'unsetenv', 'load', 'bootstrap', 'submit', 'config']);",
    "const LAUNCHCTL_CHANGES = new Set(['setenv', 'unsetenv', 'load', 'submit', 'config']);"],
  [VERDICT, 'launchctl: submit runs with no card',
    "const LAUNCHCTL_CHANGES = new Set(['setenv', 'unsetenv', 'load', 'bootstrap', 'submit', 'config']);",
    "const LAUNCHCTL_CHANGES = new Set(['setenv', 'unsetenv', 'load', 'bootstrap', 'config']);"],
  [GUIDE_HOOKS, 'Guide: the agent is sent to edit the project settings to mute a sound hook',
    "tell the user Rundock mutes them itself each time it opens the workspace, so they stay silent in Rundock and still sound elsewhere. Don't edit `.claude/settings.json` to do it: Rundock asks the user about every change to that file",
    'warn the user that these will fire on every response in Rundock and suggest wrapping them with `[ -z "$RUNDOCK" ] &&` to suppress in Rundock'],
  [LAUNCHCTL_ANY_MODE, 'launchctl: config runs with no card in Code mode',
    "const LAUNCHCTL_CHANGES = new Set(['setenv', 'unsetenv', 'load', 'bootstrap', 'submit', 'config']);",
    "const LAUNCHCTL_CHANGES = new Set(['setenv', 'unsetenv', 'load', 'bootstrap', 'submit']);"],
  [LAUNCHCTL_NOTES, 'launchctl: in Notes mode a change is graded medium, so a saved allow for launchctl answers it',
    '    if (/\\blaunchctl\\s+(setenv|unsetenv|load|bootstrap|submit|config)\\b/i.test(cmd)) return true;\n',
    ''],
  [LAUNCHCTL_NOTES, 'launchctl: in Notes mode one reading its subcommands from standard input is graded medium',
    '      if (launchctlUnspelled(segments[i])) return true;\n',
    ''],
  [LAUNCHCTL_NOTES, 'launchctl: in Notes mode a subcommand the shell fills in is graded medium',
    '    return words.length === 1 || /^["\'$`\\\\]/.test(words[1]);',
    '    return words.length === 1;'],
  [LAUNCHCTL_NOTES, 'launchctl: in Notes mode the unspelled-subcommand check grades other programs too',
    "    if (!words.length || bareWord(words[0]) !== 'launchctl') return false;",
    '    if (!words.length) return false;'],
  [VERDICT, 'launchctl: the verdict never reads it',
    "  if (v === 'launchctl') return judgeLaunchctl(a, ctx, piped);\n",
    ''],
  [VERDICT_HOOK, 'launchctl: through the real hook, it runs with no card',
    "  if (v === 'launchctl') return judgeLaunchctl(a, ctx, piped);\n",
    ''],
  [VERDICT, 'launchctl: reading it asks too',
    '  if (!LAUNCHCTL_CARRIES.has(sub)) return RUNS;',
    "  if (!LAUNCHCTL_CARRIES.has(sub)) return always('launch-environment');"],
  [VERDICT, 'launchctl: the command asuser and bsexec carry is not judged',
    '  if (!LAUNCHCTL_CARRIES.has(sub)) return RUNS;',
    '  return RUNS;'],
  [VERDICT, 'launchctl: a subcommand in another case is not recognised',
    '  const sub = args[0].text.toLowerCase();',
    '  const sub = args[0].text;'],
  [VERDICT, 'launchctl: a subcommand only known when the line runs is read as a known one',
    "  if (v === 'launchctl') return !!a[0] && exp(a[0]);\n",
    ''],
  [VERDICT, 'launchctl: a subcommand piped in through xargs runs',
    "  if (!args.length) return piped ? always('unreadable-command') : RUNS;",
    '  if (!args.length) return RUNS;'],
  [PROMPT_CONNECTORS, 'Prompt: the agent is told to put a credential value in the per-user file itself',
    'and ask the person to add the value to .rundock/mcp-secrets.json themselves.',
    'and put its value there.'],
  [PROMPT_CONNECTORS, 'Prompt: the agent is told every edit of .mcp.json is refused whatever is approved',
    'Rundock asks the person about every such edit, and the runtime you run on may protect that file as well, so it may refuse it even after the person allows it, which wastes their time.',
    'that file is protected wherever it lives and every such attempt is refused, whatever the user approves, so trying and reporting the refusal wastes their time.'],
  // A stored grant over a parent of several workspaces must not answer for
  // another workspace's answer files.
  [BOUNDARY, 'Stored grant: another workspace\'s answer files are covered by a grant over their parent',
    '  if (isWorkspaceAnswerFile(crossing.path, getWorkspace()) || isAnswerFileOfAnyWorkspace(crossing.path)) return false;',
    '  if (isWorkspaceAnswerFile(crossing.path, getWorkspace())) return false;'],
  // ===== THE GUARD WATCHES WHAT RUNS, FOR CODEX =====
  // ===== THE LAUNCHER IS REFUSED, NOT ASKED ABOUT =====
  [LAUNCHER_REFUSED, 'Launcher: a file tool writing it raises a card whose Allow cannot hold',
    "    return { where: inside ? 'inside' : 'outside', resolvedPath, grantDir: null, answerFile: true, enforcedDeny: 'launcher' };",
    "    return { where: inside ? 'inside' : 'outside', resolvedPath, grantDir: null, answerFile: true };"],
  [LAUNCHER_REFUSED, 'Launcher: a shell command writing it raises a card whose Allow cannot hold',
    '    || (Array.isArray(access.crossings) && access.crossings.some(c => c && c.answerFile && isLauncherFile(c.path))));',
    ');'],
  [LAUNCHER_REFUSED, 'Launcher: the refusal is never applied',
    '  if (launcherWrite) {',
    '  if (false) {'],
  [LAUNCHER_REFUSED, "Launcher: another workspace's launcher is not matched",
    "  return n >= 2 && fold(parts[n - 2]) === '.rundock' && LAUNCHER_FILES.some(f => fold(f.split('/')[1]) === fold(parts[n - 1]));",
    "  return n >= 2 && fold(parts[n - 2]) === '.rundock' && LAUNCHER_FILES.some(f => fold(f.split('/')[1]) === fold(parts[n - 1])) && !resolvedPath.includes('projects');"],
  // ===== RUNDOCK'S CONSOLE FOLDER ALWAYS ASKS =====
  [CONSOLE_HOOK, 'Console folder: a file tool writes to it as ordinary work',
    '  if (writing && isRundockConsolePath(resolvedPath, home, foldsCase)) {',
    '  if (false) {'],
  [CONSOLE_HOOK, 'Console folder: a shell command writes to it as ordinary work',
    '          || isRundockConsolePath(r, home, foldsCase, pmod) || globReachesConsole(r, home, foldsCase, pmod));',
    '          || globReachesConsole(r, home, foldsCase, pmod));'],
  [CONSOLE_HOOK, 'Console folder: a glob at home that matches it is not looked at',
    '          || isRundockConsolePath(r, home, foldsCase, pmod) || globReachesConsole(r, home, foldsCase, pmod));',
    '          || isRundockConsolePath(r, home, foldsCase, pmod));'],
  [CONSOLE_HOOK, 'Console folder: only the folder itself is matched, not what is in it',
    '  return matchesAnswerFileSet([RUNDOCK_CONSOLE_DIR], resolvedPath, home, foldsCase, pmod, true);',
    '  return matchesAnswerFileSet([RUNDOCK_CONSOLE_DIR], resolvedPath, home, foldsCase, pmod);'],
  [CONSOLE_HOOK, 'Console folder: it is matched against the workspace rather than home',
    '  return matchesAnswerFileSet([RUNDOCK_CONSOLE_DIR], resolvedPath, home, foldsCase, pmod, true);',
    '  return matchesAnswerFileSet([RUNDOCK_CONSOLE_DIR], resolvedPath, process.env.RUNDOCK_WORKSPACE || home, foldsCase, pmod, true);'],
  [CONSOLE_GRANT, 'Console folder: a stored folder grant answers a write to it',
    '  if (isRundockConsolePath(crossing.path, home)) return false;\n',
    ''],
  [CONSOLE_CARD, 'Console folder: the card calls it the permission answers',
    "      if (parts.includes('.rundock-console')) return 'console';\n",
    ''],
  [CONSOLE_HOOK, 'Console folder: the hook guards a folder the Reconnect window does not write',
    "const RUNDOCK_CONSOLE_DIR = '.rundock-console';",
    "const RUNDOCK_CONSOLE_DIR = '.rundock-terminal';"],
  [CONSOLE_WRITER, 'Console folder: the Reconnect window writes where the hook does not look',
    "const CONSOLE_SCRIPT_DIR = '.rundock-console';",
    "const CONSOLE_SCRIPT_DIR = '.rundock-terminal';"],
  [CONSOLE_SANDBOX, 'Console folder: the sandbox block leaves it writable',
    '    path.posix.join(home, RUNDOCK_CONSOLE_DIR),\n',
    ''],
  [ALLOWED_GUARD, 'Allowed change: a change allowed on the card is put back and asked about again',
    '    if (!outsideTurn && modeKept && takeAllowed(g, f, now)) { g.snapshot.set(f, now); continue; }\n',
    ''],
  [ALLOWED_GUARD, 'Allowed change: any content stands once the path is allowed',
    '  if (mark.digest !== null && !(isPlain(now) && digest(now.bytes) === mark.digest)) return false;\n',
    ''],
  [ALLOWED_GUARD, "Allowed change: another conversation's allow covers this one",
    '  if (!mark || ![...g.listeners].some(l => l.convoId === mark.convoId)) return false;',
    '  if (!mark) return false;'],
  [ALLOWED_GUARD, 'Allowed change: an allow is used more than once',
    '  allowedChanges.delete(at);\n  return true;',
    '  return true;'],
  [ALLOWED_GUARD, 'Allowed change: an allow nothing used outlives its turn',
    '        for (const [p, m] of allowedChanges) if (m.convoId === c) allowedChanges.delete(p);\n',
    ''],
  [ALLOWED_GUARD, "Allowed change: a shell allow outlives its own command's finished-call check",
    '    for (const [p, m] of allowedChanges) if (m.convoId === finishedFor && m.digest === null) allowedChanges.delete(p);\n',
    ''],
  [ALLOWED_ROUTER, 'Allowed change: the server does not say whose tool call finished',
    'checkAnswerFilesNow(getWorkspace(), { finishedFor: id || null })',
    'checkAnswerFilesNow(getWorkspace())'],
  [ALLOWED_HANDLER, 'Allowed change: an Allow on the card marks nothing',
    '      if (card) { try { markAllowedAnswerFiles(pending); }',
    '      if (false) { try { markAllowedAnswerFiles(pending); }'],
  [ALLOWED_HANDLER, "Allowed change: a shell command's answer files are not marked",
    '  for (const c of pending.crossings || []) if (c && c.answerFile && c.path) files.add(c.path);\n',
    ''],
  [ALLOWED_HANDLER, 'Allowed change: a shell command is held to content it never named',
    '  const shell = SHELL_TOOLS.has(pending.toolName);',
    '  const shell = false;'],
  [ALLOWED_HANDLER, "Allowed change: an Edit's result is not worked out",
    ': current.replace(ti.old_string, () => ti.new_string);',
    ': current;'],
  [ALLOWED_HANDLER, "Allowed change: a MultiEdit's result is not worked out",
    "  const edits = toolName === 'Edit' ? [ti] : (toolName === 'MultiEdit' && Array.isArray(ti.edits) && ti.edits.length ? ti.edits : null);",
    "  const edits = toolName === 'Edit' ? [ti] : null;"],
  [ALLOWED_HANDLER, "Allowed change: only a MultiEdit's first edit is applied",
    '  for (const edit of edits) {',
    '  for (const edit of edits.slice(0, 1)) {'],
  [ALLOWED_TURNS, "Allowed change: a Claude turn's guard is not told its conversation",
    'guard = acquire(workspace, onChange, { convoId });',
    'guard = acquire(workspace, onChange);'],
  [ALLOWED_WIRING, "Allowed change: the server does not pass the conversation to the turn guard",
    '    workspace: config.getWorkspace(),\n    convoId,\n',
    '    workspace: config.getWorkspace(),\n'],
  [GUARD_RUNS, 'Guard: only the permission answers are watched',
    'const ANSWER_FILES = [...WORKSPACE_ANSWER_FILES];',
    "const ANSWER_FILES = ['.rundock/permissions.json', '.rundock/state.json', '.claude/settings.local.json', '.claude/settings.json'];"],
  [GUARD_RUNS, 'Guard: the hook scripts already there are left out of the first baseline',
    '    const files = [...ANSWER_FILES, ...hookScriptsIn(k)].map(',
    '    const files = [...ANSWER_FILES].map('],
  [GUARD_RUNS, 'Guard: a change to a file that decides what runs, kept between turns, is said nowhere',
    '      if (SAID_WHEN_KEPT(relative)) tellTurn(g, { file: f, relative, kept: true, outsideTurn: true });\n',
    ''],
  [GUARD_RUNS_LINE, 'Guard: a change kept between turns is offered on a card',
    '  if (change && change.kept) { surfaceKeptChange(entry, convoId, change); return; }\n',
    ''],
  [GUARD_RUNS_LINE, 'Guard: the notice for a kept change does not name the file',
    '  return `${relative} changed while no agent was running, and Rundock kept it as it is. `',
    '  return `A file changed while no agent was running, and Rundock kept it as it is. `'],
  [GUARD_RUNS, 'Guard: a hook script added after the guard started is not watched',
    '  watchNewHookScripts(key(workspace), g);\n',
    ''],
  [GUARD_RUNS, 'Guard: a new hook script is taken as the starting point',
    '    if (!g.snapshot.has(f)) { g.files.push(f); g.snapshot.set(f, null); }',
    '    if (!g.snapshot.has(f)) { g.files.push(f); g.snapshot.set(f, read(f)); }'],
  [GUARD_RUNS, 'Guard: the hooks folder is listed through a link put in its place',
    "  if (realOrNull(path.join(root, ...HOOK_SCRIPTS_DIR.split('/'))) !== g.hooksAt) return;\n",
    ''],
  [GUARD_RUNS, 'Guard: a file is put back through a folder swapped for a link',
    '    try { putBackFolders(key(workspace), g, f); restore(f, was); }',
    '    try { restore(f, was); }'],
  [GUARD_RUNS, "Guard: a person's link pointed somewhere else is kept",
    '    if (was && was.link !== null && realOrNull(at) === was.real) continue;',
    '    if (was && was.link !== null) continue;'],
  [GUARD_RUNS, "Guard: a person's link is not pointed back",
    '    fs.symlinkSync(was.link, at);\n',
    ''],
  [GUARD_RUNS, 'Guard: the folders on the way are not recorded',
    '    for (const f of files) noteFolders(k, g, f);\n',
    ''],
  [GUARD_RUNS, 'Guard: a hand edit to .mcp.json between turns is put back',
    "const SHARED_FILES = new Set(['.claude/settings.local.json', '.claude/settings.json', '.mcp.json', '.rundock/mcp-secrets.json']);",
    "const SHARED_FILES = new Set(['.claude/settings.local.json', '.claude/settings.json', '.rundock/mcp-secrets.json']);"],
  [GUARD_RUNS, 'Guard: a hand edit to a hook script between turns is put back',
    'const isShared = relative => SHARED_FILES.has(relative) || relative.startsWith(`${HOOK_SCRIPTS_DIR}/`);',
    'const isShared = relative => SHARED_FILES.has(relative);'],
  [GUARD_RUNS, 'Guard: the launcher is offered on a keep card',
    '    if (LAUNCHERS.has(relative)) { putLauncherBack(key(workspace), g, f, was, relative); continue; }\n',
    ''],
  [GUARD_RUNS, "Guard: the launcher is put back to the baseline, not this copy's latest",
    '    if (mine) writePlain(f, mine.bytes, mine.mode); else restore(f, was);',
    '    restore(f, was);'],
  [GUARD_RUNS, 'Guard: a launcher another copy wrote before the guard started stands',
    '      if (mine) g.snapshot.set(f, { file: true, bytes: mine.bytes, mode: mine.mode });\n',
    ''],
  [GUARD_RUNS, 'Guard: the launcher this copy wrote is not remembered',
    '      ownLaunchers.set(key(file), { bytes, mode });\n',
    ''],
  [GUARD_RUNS_LAUNCHER, 'Guard: the launcher Rundock writes is put back as somebody else\'s change',
    '        fs.chmodSync(launcher, 0o755);\n        noteOwnWrite(launcher, body);\n',
    '        fs.chmodSync(launcher, 0o755);\n'],
  [GUARD_RUNS_CONNECTOR, 'Guard: a connector the person allowed is put back as somebody else\'s change',
    '    fs.writeFileSync(file, body, \'utf-8\');\n    // Recorded, so the answer-file guard takes it as Rundock\'s own write.\n    noteOwnWrite(file, body);\n',
    '    fs.writeFileSync(file, body, \'utf-8\');\n'],
  [GUARD_RUNS_CARD, 'Guard: the put-back card says every file holds permission answers',
    "    const kind = PUT_BACK_KIND[kindOf === 'connectorSecrets' ? 'runs' : kindOf] || PUT_BACK_KIND.answers;",
    '    const kind = PUT_BACK_KIND.answers;'],
  [GUARD_RUNS_LINE, 'Guard: the agent is told every file holds permission answers',
    "  const why = RESTORE_REASON[require('../../public/permissions.js').answerFileKind(relative)] || 'it holds the person\\'s permission answers';",
    "  const why = 'it holds the person\\'s permission answers';"],
  // ===== AN AGENT'S CONNECTOR CHANGE ASKS FIRST =====
  [CONNECTOR_ASK, 'Connector: a change is written without asking',
    'function askFirst(ctx, ws, msg, toolName, toolInput, write) {\n',
    'function askFirst(ctx, ws, msg, toolName, toolInput, write) {\n  return write();\n'],
  [CONNECTOR_ASK_FLOW, 'Connector: through the real server, a change is written without asking',
    'function askFirst(ctx, ws, msg, toolName, toolInput, write) {\n',
    'function askFirst(ctx, ws, msg, toolName, toolInput, write) {\n  return write();\n'],
  [CONNECTOR_ASK, 'Connector: an allow no person gave on a card writes',
    '      if (allow === true && how && how.card === true) { write(); return; }',
    '      if (allow === true) { write(); return; }'],
  [CONNECTOR_ASK, 'Connector: Deny or no answer writes',
    '      if (allow === true && how && how.card === true) { write(); return; }',
    '      if (true) { write(); return; }'],
  [CONNECTOR_ASK_FLOW, 'Connector: the file is not read again once allowed',
    "    const now = connectorFile(ctx, ws);\n    if (!now) return;\n    now.parsed.mcpServers[msg.name] = entry;\n    writeConnectorFile(ctx, ws, now.file, now.parsed, 'saved', msg.name);",
    "    found.parsed.mcpServers[msg.name] = entry;\n    writeConnectorFile(ctx, ws, found.file, found.parsed, 'saved', msg.name);"],
  [CONNECTOR_ASK, 'Connector: the card is not told the command or its arguments',
    '    input.command = e.command;\n    input.args = Array.isArray(e.args) ? e.args.map(String) : [];\n',
    ''],
  [CONNECTOR_ASK, 'Connector: the card is not told the URL',
    "  if (typeof e.url === 'string') input.url = e.url;\n",
    ''],
  [CONNECTOR_ASK, 'Connector: the card is not told what environment is set',
    '  if (keys(e.env).length) input.env = keys(e.env);\n',
    ''],
  [CONNECTOR_ASK, 'Connector: a removal is described as an addition',
    "connectorCardInput(msg.name, 'remove',",
    "connectorCardInput(msg.name, 'add',"],
  [CONNECTOR_CARD, 'Connector card: graded below high, so a saved allow answers it and Always allow is offered',
    "    if (toolName === 'SaveConnector' || toolName === 'DeleteConnector') return 'high';\n",
    ''],
  [CONNECTOR_CARD, 'Connector card: worded as an unknown tool, without the command',
    "    } else if (toolName === 'SaveConnector' || toolName === 'DeleteConnector') {\n      ({ summary, context, detail } = connectorCopy(toolName, input));\n",
    ''],
  [CONNECTOR_CARD, 'Connector card: an argument with a space is shown unquoted',
    '  function shellWord(a) {\n    const s = String(a);\n',
    '  function shellWord(a) {\n    const s = String(a);\n    return s;\n'],
  [CONNECTOR_CARD, 'Connector card: a line break in an argument starts a line of its own',
    "    if (CONTROL.test(s)) return `$'${escapeControl(s.replace(/\\\\/g, '\\\\\\\\').replace(/'/g, \"\\\\'\"))}'`;\n",
    ''],
  [CONNECTOR_CARD, 'Connector card: a line break in a URL, transport or helper starts a line of its own',
    '    return CONTROL.test(s) ? `"${escapeControl(',
    '    return false ? `"${escapeControl('],
  [CONNECTOR_CARD, 'Connector card: a character that reorders text is shown as it is',
    ' [0x202a, 0x202e],',
    ''],
  [CONNECTOR_CARD, 'Connector card: a name is shown with its line separator as it is',
    'odd.map(n => escapeControl(JSON.stringify(n)))',
    'odd.map(n => JSON.stringify(n))'],
  [CONNECTOR_CARD, 'Connector card: an environment name that is not a plain name is put in a sentence',
    '  const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;',
    '  const ENV_NAME = /.*/;'],
  [CONNECTOR_CARD, 'Connector card: a header name that is not an HTTP token is put in a sentence',
    "  const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;",
    '  const HEADER_NAME = /.*/;'],
  [CONNECTOR_CARD, 'Connector card: a setting name that is not a plain name is put in a sentence',
    '  const SETTING_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;',
    '  const SETTING_NAME = /.*/;'],
  [CONNECTOR_CARD, 'Connector card: the URL is hidden beside a command',
    "    if (typeof i.url === 'string') lines.push(`URL: ${shownValue(i.url)}`);",
    "    if (typeof i.url === 'string' && !runs) lines.push(`URL: ${shownValue(i.url)}`);"],
  [CONNECTOR_CARD, 'Connector card: the transport is not shown',
    "    if (typeof i.transport === 'string') lines.push(`Transport: ${shownValue(i.transport)}`);\n",
    ''],
  [CONNECTOR_CARD, 'Connector card: the header helper is not shown',
    '        lines.push(`Header helper: ${shownValue(i.headersHelper)}`);\n',
    ''],
  [CONNECTOR_VIEW, 'Connector card: the detail is clipped like any other',
    "        : (toolName === 'SaveConnector' || toolName === 'DeleteConnector')\n",
    "        : false\n"],
  [CONNECTOR_ASK_FLOW, 'Connector: a save replaces every connector already there',
    '    now.parsed.mcpServers[msg.name] = entry;\n',
    '    now.parsed.mcpServers = { [msg.name]: entry };\n'],
  [CONNECTOR_WIRING, 'Connector: the card\'s id can be guessed from the clock',
    "  const requestId = 'perm-' + require('crypto').randomBytes(16).toString('hex');",
    "  const requestId = 'perm-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);"],
  [CONNECTOR_WIRING, 'Connector: the handlers are not handed the card',
    '  runtime: { getRuntimeStatus, killAllChildren, cleanOrphanedProcesses, requestServerPermission },',
    '  runtime: { getRuntimeStatus, killAllChildren, cleanOrphanedProcesses },'],
  [CM_CLIENT, 'launchctl: the card gives no reason of its own',
    "    'launch-environment': () => 'This changes what macOS starts, or the settings every program started from now on is given, Rundock included, beyond anything Rundock can see or check.',\n",
    ''],
  // ===== A CONNECTOR CARD SHOWS WHAT IS SENT, AS TEXT =====
  // Every value on the card is an agent's. Set one as markup and an address or
  // a subject becomes an element on the card a person approves from.
  [CONNECTOR_CARD_VIEW, 'Connector card: a field value is set as markup',
    '    if (text !== undefined) n.textContent = text;',
    '    if (text !== undefined) n.innerHTML = text;'],
  // Show fewer recipients before "+N more" and a send is approved with someone
  // it goes to folded out of sight.
  [CONNECTOR_CARD_MODEL, 'Connector card: fewer recipients are shown before the rest are folded away',
    '  const SHOWN = 3;',
    '  const SHOWN = 2;'],
  // The same grading the approval flow proves above, read off the card itself:
  // drop it and a send offers Always allow beside Allow once.
  [CONNECTOR_CARD_GRADE, 'Connector card: a send offers Always allow',
    "      if (words.some(w => MCP_SEND_VERBS.indexOf(w) !== -1)) return 'high';\n",
    ''],
  // The card takes the place of the raw request, so a field it does not show
  // is one a person approves blind. Keep only the first alias and a second
  // recipient list, a second body or a second title is never shown.
  [CONNECTOR_CARD_MODEL, 'Connector card: an alias is dropped',
    '    return found;\n',
    '    return found.slice(0, 1);\n'],
  // Read a top-level field only when there is no nested message, and a `to`
  // beside `message.to` goes where the card never mentions.
  [CONNECTOR_CARD_MODEL, 'Connector card: a nested message hides the fields around it',
    "    const sources = [{ obj: input, prefix: '', skip: new Set(nested) }, ...nested.map(",
    "    const sources = [...(nested.length ? [] : [{ obj: input, prefix: '', skip: new Set() }]), ...nested.map("],
  // Uncapped, a request can fill a card with rows; capped without listing the
  // rest, what is past the cap goes unseen.
  [CONNECTOR_CARD_MODEL, 'Connector card: alias rows are not capped',
    'all.slice(0, MAX_ALIAS_ROWS).map(',
    'all.map('],
  [CONNECTOR_CARD_MODEL, 'Connector card: aliases past the cap are not listed',
    '      for (const o of all.slice(MAX_ALIAS_ROWS)) { aliasOverflow++; list(o.key, o.raw); }\n',
    ''],
  // Past the alias rows and the fields shown is exactly where a recipient can
  // be put out of sight: reduce what is there to a count and it is.
  [CONNECTOR_CARD_MODEL, 'Connector card: fields past a number are dropped from the list',
    '      others.push({ key, text: rawText(raw) });',
    '      if (others.length < 200) others.push({ key, text: rawText(raw) });'],
  [CONNECTOR_CARD_VIEW, 'Connector card: the fields past those shown are not drawn',
    ', ...rest.map(line));',
    ');'],
  // Folded away is still acted on: the card has to say it.
  [CONNECTOR_CARD_MODEL, 'Connector card: a card with fields folded away does not say so',
    "    const said = baseContext(f, server) + (isCrowded(f) ? CROWDED : '');",
    '    const said = baseContext(f, server);'],
  // An email address in a field the card does not read can be who a request
  // reaches, whatever a destination row says: never noticed, or noticed and
  // never said, it goes out of sight behind the destination.
  [CONNECTOR_CARD_MODEL, 'Connector card: an address in an unread field is not noticed',
    '      if (!unreadAddress && EMAIL_LIKE.test(rawText(raw, MAX_TEXT))) unreadAddress = true;\n',
    ''],
  // The old address pattern: an unbounded run before the "@" restarts at
  // every position of a long value with no "@", and the main thread waits
  // seconds for a card.
  [CONNECTOR_FIELDS_MODEL, 'Connector card: the address pattern takes time with the square of a value',
    '  const EMAIL_LIKE = /[^\\s@<>"]@[^\\s@<>".]+\\.[^\\s@<>"]/;',
    '  const EMAIL_LIKE = /[^\\s@<>"]+@[^\\s@<>"]+\\.[^\\s@<>"]+/;'],
  [CONNECTOR_FIELDS_MODEL, 'Connector card: an address past the part of a value shown is not noticed',
    'EMAIL_LIKE.test(rawText(raw, MAX_TEXT))',
    'EMAIL_LIKE.test(rawText(raw))'],
  [CONNECTOR_CARD_MODEL, 'Connector card: an address in an unread field draws no sentence',
    "(f.unreadAddress && f.action !== 'draft' && !said.includes('Other fields') ? ADDRESS_NOTE : '')",
    "''"],
  [CONNECTOR_CARD_VIEW, 'Connector card: an address beside a destination draws no To row',
    ' || f.unreadAddress);',
    ');'],
  [CONNECTOR_CARD_MODEL, 'Connector card: aliases past the cap do not count as folded away',
    '(f.aliasOverflow || 0) > 0 || ',
    ''],
  // A reply that names only its thread drawn as the plain card: what it says
  // is approved unread.
  [CONNECTOR_CARD_MODEL, 'Connector card: a send with only a body gets the plain card',
    "\n      || (action !== 'draft' && keysFor(o, KEYS.body).length > 0);",
    ';'],
  // Drop an entry the card cannot read and its recipient is approved unseen.
  [CONNECTOR_CARD_MODEL, 'Connector card: an entry the card cannot read is dropped',
    '    return { raw: rawText(v) };\n  }\n  function recipientsOf',
    '    return null;\n  }\n  function recipientsOf'],
  // Unread keys: never collected, or collected and never drawn.
  [CONNECTOR_CARD_MODEL, 'Connector card: unshown keys are not collected',
    '        if (s.skip.has(k) || names.has(norm(k)) || s.obj[k] === undefined) continue;',
    '        continue;'],
  [CONNECTOR_CARD_VIEW, 'Connector card: unshown keys are hidden',
    "  if (f.others.length) row('Other fields', otherFields());",
    "  if (false) row('Other fields', otherFields());"],
  // While keys went unread, "(none)", "Just you", "No one else is invited" and
  // "No recipients are set" may all be untrue.
  [CONNECTOR_CARD_VIEW, 'Connector card: an empty recipient list says none while fields went unread',
    "unreadFields ? 'Not recognised: see Other fields' : text",
    'text'],
  [CONNECTOR_CARD_MODEL, 'Connector card: the card says nobody is reached while fields went unread',
    '    const unread = hasUnreadFields(f);',
    '    const unread = false;'],
  // A warning on every card is one nobody reads: count an id or a calendar as
  // unread and nearly every event warns.
  [CONNECTOR_CARD_MODEL, 'Connector card: a well-known key makes the card warn',
    'f.others.some((o) => !quiet(o))',
    'f.others.length > 0'],
  // On a send, an id or a thread can be where the message goes: quiet there,
  // and a send that reaches no one reads as one that will fail.
  [CONNECTOR_CARD_MODEL, 'Connector card: a well-known key is quiet on a send',
    "(f.kind === 'event' || f.action === 'draft') && ",
    ''],
  // A send that names where it goes, or carries other fields, said to fail.
  [CONNECTOR_CARD_MODEL, 'Connector card: a send that names where it goes is said to fail',
    ' || f.destinations.length > 0',
    ''],
  [CONNECTOR_CARD_MODEL, 'Connector card: a send beside other fields is said to fail',
    '(nobody ? (anyOthers ?',
    '(nobody ? (false ?'],
  // Where a send goes, never read or never drawn: a thread reply or a chat
  // message says nothing about where it lands.
  // On a forward an id names the message forwarded: taken for where it goes,
  // it hides the To row and the warning beside a recipient list under an
  // unknown name.
  [CONNECTOR_CARD_MODEL, 'Connector card: an id on a forward is taken for where it goes',
    "KEYS.destination.filter((n) => n !== 'id' && n !== 'threadid')",
    'KEYS.destination'],
  [CONNECTOR_CARD_MODEL, 'Connector card: where a send goes is not read',
    "    if (action !== 'draft') read.destination = lineOf;\n",
    ''],
  [CONNECTOR_CARD_VIEW, 'Connector card: where a send goes is not drawn',
    "    for (const d of f.destinations) row(d.key, d.value ? place(d.value) : [empty('(empty)')]);\n",
    ''],
  // A destination of any length drawn whole swamps the card it is on.
  [CONNECTOR_CARD_VIEW, 'Connector card: a long destination is drawn whole',
    '    const place = (v) => (v.length > F.MAX_ADDRESS',
    '    const place = (v) => (false'],
  // A message that is not an email, drawn with an empty Subject and To.
  [CONNECTOR_CARD_MODEL, 'Connector card: every request is taken for an email',
    'destinations, emailShaped: sources.some((s) => addressed(s.obj)),',
    'destinations, emailShaped: true,'],
  [CONNECTOR_CARD_VIEW, 'Connector card: a message shows an empty Subject row',
    "(text) => clamped(text, '(no subject)', 'subject'), f.emailShaped);",
    "(text) => clamped(text, '(no subject)', 'subject'), true);"],
  [CONNECTOR_CARD_VIEW, 'Connector card: a message that names where it goes shows an empty To row',
    'f.emailShaped || !f.destinations.length',
    'true'],
  // The warning belongs on the rows of who is reached, not on a subject or a
  // message.
  [CONNECTOR_CARD_VIEW, 'Connector card: a subject or a message says Not recognised',
    "  const empty = (text) => el('span', 'permission-empty', text);",
    "  const empty = (text) => el('span', 'permission-empty', unreadFields ? 'Not recognised: see Other fields' : text);"],
  // One isolate for the name and the address, and an override in the name
  // reorders the address beside it.
  [CONNECTOR_CARD_VIEW, 'Connector card: a name and its address share one isolate',
    "    else if (e.name) n.append(el('bdi', 'permission-name', e.name), ' <', el('bdi', 'permission-address', e.address), '>');",
    "    else if (e.name) n.append(el('bdi', 'permission-name', `${e.name} <${e.address}>`));"],
  // Fold Bcc and the people a message is copied to in secret are out of sight.
  [CONNECTOR_CARD_VIEW, 'Connector card: Bcc is folded behind +N more',
    "    field('bcc', 'Bcc', (list) => everyone(list, '(none)'));",
    "    field('bcc', 'Bcc', (list) => people(list, '(none)'));"],
  // ===== A VALUE THE CARD CANNOT READ NEVER STOPS IT =====
  // Let a throw out and the card is never drawn, nor any card queued after it.
  [CONNECTOR_CARD_VIEW, 'Connector card: a field that throws stops the card',
    '      fields = null;\n      fieldsBox = null;\n',
    '      throw e;\n'],
  // An epoch no date can hold, read as one, throws when it is formatted.
  [CONNECTOR_CARD_MODEL, 'Connector card: an epoch no date can hold is read as a date',
    '      return isNaN(at.getTime()) ? { raw: String(v) } : { at };',
    '      return { at };'],
  // Read without a depth limit and a value nested thousands deep overflows the
  // stack.
  [CONNECTOR_CARD_MODEL, 'Connector card: text is read however deep it is nested',
    '    if (depth >= MAX_DEPTH) return null;\n',
    ''],
  [CONNECTOR_FIELDS_MODEL, 'Connector card: a recipient is read however deep it is nested',
    '    if (isObj(v) && depth < MAX_DEPTH) {',
    '    if (isObj(v)) {'],
  [CONNECTOR_FIELDS_MODEL, 'Connector card: a time is read however deep it is nested',
    '    if (depth >= MAX_DEPTH) return { raw: rawText(v) };\n    if (isObj(v)) {',
    '    if (isObj(v)) {'],
  // A day or a time that does not exist printed as though it did.
  [CONNECTOR_CARD_MODEL, 'Connector card: an impossible date is printed as a day',
    '    if (m) return realDay(+m[1], +m[2], +m[3]) ? { allDay: true, parts: [+m[1], +m[2], +m[3], 0, 0] } : { raw: clip(s, 120) };',
    '    if (m) return { allDay: true, parts: [+m[1], +m[2], +m[3], 0, 0] };'],
  [CONNECTOR_FIELDS_MODEL, 'Connector card: an impossible time is printed as a time',
    '    if (m && !(realDay(+m[1], +m[2], +m[3]) && realTime(+m[4], +m[5]))) return { raw: clip(s, 120) };\n',
    ''],
  // ===== TEXT CUT SHORT CAN ALWAYS BE OPENED =====
  // Trust the thresholds alone and a value the dock clamps sooner is cut with
  // nothing to open it.
  [CONNECTOR_CARD_VIEW, 'Connector card: a preview the browser cuts gets nothing to open it',
    '    if (!(shown.scrollHeight > shown.clientHeight + 1)) continue;',
    '    continue;'],
  // Measure only while drawing and a card drawn into the hidden dock is never
  // measured at all.
  [CONNECTOR_CARD_VIEW, 'Connector card: a card drawn into the hidden dock is never measured again',
    '  if (!dock.hidden) revealClampedText(list);\n',
    ''],
  // A card drawn while the chat is hidden, or one a narrower window clamps,
  // is measured again only when its host's size changes.
  [CONNECTOR_CARD_VIEW, 'Connector card: a host that is shown or resized is not measured again',
    '  if (!cardHostWatcher) cardHostWatcher = new ResizeObserver((entries) => { for (const entry of entries) revealClampedText(entry.target); });',
    '  if (!cardHostWatcher) cardHostWatcher = new ResizeObserver(() => {});'],
  [CONNECTOR_CARD_VIEW, 'Connector card: the thread a card is drawn into is never watched',
    '  watchCardHost(m);\n',
    ''],
  [CONNECTOR_CARD_VIEW, 'Connector card: the dock a card is drawn into is never watched',
    '    watchCardHost(host);\n',
    ''],
  // ===== RECONNECTING CLAUDE CODE IS FOR RUNDOCK'S OWN WINDOW =====
  // Open the reconnect routes and any process on this machine can open a
  // console here, or spend a turn checking, with no key at all.
  [AUTH_ROUTES, 'Reconnect: the reconnect routes are listed as needing no key',
    "  if (method === 'POST' && (url === '/api/auth/session' || url === '/api/permission-request')) return true;",
    "  if (method === 'POST' && (url === '/api/auth/session' || url === '/api/permission-request' || url.startsWith('/api/claude/'))) return true;"],
  [RECONNECT_ROUTES, 'Reconnect: a request with no credentials reaches the routes',
    "  if (method === 'POST' && (url === '/api/auth/session' || url === '/api/permission-request')) return true;",
    "  if (method === 'POST' && (url === '/api/auth/session' || url === '/api/permission-request' || url.startsWith('/api/claude/'))) return true;"],
  // An agent's own process tree holds the permission hook's token. Let that
  // token stand for the window and an agent can open a console or spend a turn.
  [RECONNECT_AUTH, 'Reconnect: the permission hook\'s token is taken for the window',
    "  if (sameSecret(headers[KEY_HEADER], LAUNCH_KEY)) return 'key';\n",
    "  if (sameSecret(headers[KEY_HEADER], LAUNCH_KEY)) return 'key';\n  if (hookScopeOf(req) !== undefined) return 'hook';\n"],
  // `--print` skips the trust prompt: run the check in the shared temp folder
  // and another account's project settings and hooks run with it.
  [CLAUDE_CONSOLE, 'Reconnect: the check runs in the shared temp folder',
    '{ cwd: os.homedir(), stdio:',
    '{ cwd: os.tmpdir(), stdio:'],
  // Never release the one-at-a-time guard and every later check is handed the
  // first one's answer.
  [CLAUDE_CONSOLE, 'Reconnect: the one-at-a-time guard is never released',
    '  p.then(() => { if (inFlight === p) inFlight = null; });\n',
    ''],
  // A dropped connection is not a sign-out.
  [CLAUDE_CONSOLE, 'Reconnect: any failed check counts as signed out',
    'finish(false, signedOut())',
    'finish(false, true)'],
  [RECONNECT_SERVER, 'Reconnect: the server does not say which failures are a sign-out',
    '{ bin: resolveClaudeBin(), isAuthFailure: isAuthError }',
    '{ bin: resolveClaudeBin() }'],
  [RECONNECT_SERVER, 'Reconnect: a check that could not tell changes the runtime status',
    '    if (r.known) _claudeAuthEvidence = r.connected;',
    '    _claudeAuthEvidence = r.connected;'],
  [RECONNECT_CARD, 'Reconnect: a check that could not tell is shown as still disconnected',
    "(!r || r.known === false ? 'unchecked' : 'notyet')",
    "'notyet'"],
  // The manual step is Claude Code's own login command; a bare `claude` with a
  // refused session can start ready to chat and log nobody in.
  [RECONNECT_CARD, 'Reconnect: the manual step says to run a bare claude',
    "const AUTH_LOGIN_CMD = 'claude auth login';",
    "const AUTH_LOGIN_CMD = 'claude';"],
  [RECONNECT_CARD, 'Reconnect: the manual step\'s copy button copies a bare claude',
    'writeText(AUTH_LOGIN_CMD)',
    "writeText('claude')"],
  // Every ask opening a window of its own: ten at once opened ten.
  [CLAUDE_CONSOLE, 'Reconnect: asks while a console is opening each open another',
    '  if (gate.opening) return gate.opening;\n',
    ''],
  [CLAUDE_CONSOLE, 'Reconnect: an ask straight after one opened opens another',
    '  if (gate.openedAt !== null && t >= gate.openedAt && t - gate.openedAt < OPEN_COOLDOWN_MS) return Promise.resolve({ ok: true });\n',
    ''],
  // Looking for Claude Code runs a command on the desktop's main process: look
  // before the gate and every press during the pause pays for it.
  [CLAUDE_CONSOLE, 'Reconnect: Claude Code is looked for before the gate is asked',
    '  if (gate.opening) return gate.opening;\n',
    "  if (typeof findBin === 'function') findBin();\n  if (gate.opening) return gate.opening;\n"],
  [CONSOLE_DESKTOP, 'Reconnect: the desktop app looks for Claude Code before asking the opener',
    'openClaudeConsole({ findBin: findClaude, findVersion: () => claudeFoundVersion, purpose })',
    'openClaudeConsole({ bin: findClaude(), findVersion: () => claudeFoundVersion, purpose })'],
  // The window's title and Claude Code's words go onto a command line, so only
  // fixed words may.
  [CLAUDE_CONSOLE, 'Reconnect: the console takes its title and words from the caller',
    "Object.prototype.hasOwnProperty.call(CONSOLE_TITLES, purpose) ? purpose : 'signin'",
    'purpose'],
  [CONSOLE_SERVER, 'Reconnect: the card\'s console from the server is the wizard\'s, "Sign in to Claude" running a bare claude',
    "{ bin: resolveClaudeBin(), version: _claudeProbeCache && _claudeProbeCache.version, purpose: 'reconnect' }",
    '{ bin: resolveClaudeBin(), version: _claudeProbeCache && _claudeProbeCache.version }'],
  [CONSOLE_DESKTOP, 'Reconnect: the card\'s console from the desktop app is the wizard\'s, running a bare claude',
    "? launchClaudeSignIn('reconnect') :",
    '? launchClaudeSignIn() :'],
  // With a refused session a bare `claude` can start ready to chat and say
  // "Please run /login" only once a message is sent: nobody is logged in.
  [CLAUDE_CONSOLE, 'Reconnect: the card\'s console runs a bare claude',
    "const CONSOLE_WORDS = { signin: [], reconnect: ['auth', 'login'] };",
    'const CONSOLE_WORDS = { signin: [], reconnect: [] };'],
  // `claude auth login` arrived in Claude Code 2.1.41: an older one, or one
  // whose version is not known, would show an unknown command.
  [CLAUDE_CONSOLE, 'Reconnect: the console runs claude auth login whatever the Claude Code version',
    'hasAuthLogin(version) ? CONSOLE_WORDS[known] : []',
    'CONSOLE_WORDS[known]'],
  [CLAUDE_CONSOLE, 'Reconnect: Claude Code 2.1.40 is taken to have claude auth login',
    'const AUTH_LOGIN_SINCE = [2, 1, 41];',
    'const AUTH_LOGIN_SINCE = [2, 1, 40];'],
  [CLAUDE_CONSOLE, 'Reconnect: a version that cannot be read is taken to have claude auth login',
    '  if (!m) return false;\n',
    '  if (!m) return true;\n'],
  [CLAUDE_CONSOLE, 'Reconnect: a version lookup that throws throws out of the opener',
    'try { ver = findVersion(); } catch (e) { ver = null; }',
    'ver = findVersion();'],
  [CONSOLE_SERVER, 'Reconnect: the server never tells the opener the version it probed',
    ', version: _claudeProbeCache && _claudeProbeCache.version',
    ''],
  [CONSOLE_DESKTOP, 'Reconnect: the desktop app keeps no version from its lookup',
    'claudeFoundVersion = String(execSync(',
    'String(execSync('],
  // A path that ends its line starts a command of its own on the next.
  [CLAUDE_CONSOLE, 'Reconnect: a line break or NUL in the Claude Code path is written onto the command line',
    "  if (/[\\0\\r\\n]/.test(found)) return Promise.resolve({ ok: false, reason: 'unsupported' });\n",
    ''],
  // A path no console can take is never going to open: "Try again" cannot
  // work, so the card must show the step to run by hand.
  [CLAUDE_CONSOLE, 'Reconnect: a path no console can take offers Try again instead of the steps',
    "/.test(found)) return Promise.resolve({ ok: false, reason: 'unsupported' });",
    "/.test(found)) return Promise.resolve({ ok: false, reason: 'failed' });"],
  // Outside the outer cmd's quotes, & ends the command, ^ escapes and %
  // expands: C:\Users\R&D splits the command in two.
  [CLAUDE_CONSOLE, 'Reconnect: a Windows path holding &, ^ or % is put on cmd\'s line',
    '    if (/[&^%]/.test(bin)) return null;\n',
    ''],
  [CONSOLE_WIZARD, 'Reconnect: the wizard says sign-in could not start where no window can open',
    "res && res.reason === 'unsupported'",
    'false'],
  [CLAUDE_CONSOLE, 'Reconnect: a quote in the Claude Code path ends the macOS script\'s quoting',
    ".split(\"'\").join(\"'\\\\''\")",
    ''],
  [CLAUDE_CONSOLE, 'Reconnect: a macOS script that cannot be written throws out of the opener',
    "} catch (e) { return Promise.resolve({ ok: false, reason: 'failed' }); }",
    '} catch (e) { throw e; }'],
  // The macOS script runs as the person: whoever can change it, or the folder
  // it is in, chooses what runs.
  [CLAUDE_CONSOLE, 'Reconnect: the macOS script folder is made open, then closed',
    'fs.mkdirSync(dir, { mode: 0o700 })',
    'fs.mkdirSync(dir)'],
  [CLAUDE_CONSOLE, 'Reconnect: a macOS script folder that is a link is written through',
    '!st.isDirectory() || ',
    ''],
  [CLAUDE_CONSOLE, 'Reconnect: a macOS script folder another account owns is used',
    ' || st.uid !== uid',
    ''],
  [CLAUDE_CONSOLE, 'Reconnect: a macOS script folder left open to others stays open',
    '  if ((st.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);\n',
    ''],
  [CLAUDE_CONSOLE, 'Reconnect: a leftover macOS script, or a link in its place, is not removed first',
    "  try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }\n",
    ''],
  [CLAUDE_CONSOLE, 'Reconnect: the macOS script is written through whatever appears at its path',
    ' | fs.constants.O_EXCL',
    ''],
  [CLAUDE_CONSOLE, 'Reconnect: the macOS script takes its mode from the umask',
    '    fs.fchmodSync(fd, 0o700);\n',
    ''],
  // A frame inside the main window, such as one a page embeds, taken for the
  // window itself.
  [CLAUDE_CONSOLE, 'Reconnect: a frame inside the window is taken for the window',
    ' && event.senderFrame && event.senderFrame === contents.mainFrame',
    ''],
  [CONSOLE_DESKTOP, 'Reconnect: the desktop channel answers any frame of the main window',
    "require('../lib/runtime/claude-console.js').fromMainFrame(event, mainWindow)",
    'mainWindow && event.sender === mainWindow.webContents'],
  // The wizard reading a field the opener never sends says only "try again".
  [CONSOLE_WIZARD, 'Reconnect: the wizard reads an error the opener never gives',
    '}[res && res.reason];',
    '}[res && res.error];'],
  // ===== WHAT THE SHELL CHECK READS IN CODE AND TEXT =====
  [SHELL_CODE, "Shell code: a backslash in a Bash word is a Windows separator again on a POSIX host",
    "    const pmod = winWorld ? path.win32 : flavourFor(t, workspaceRoot, posixText);",
    "    const pmod = winWorld ? path.win32 : flavourFor(t, workspaceRoot);"],
  [SHELL_CODE, "Shell code: an unquoted Bash escape is judged as written, not as bash reads it",
    " t = t.replace(/\\\\(.)/g, '$1');",
    " {}"],
  [SHELL_CODE, "Shell code: a drive letter in a Bash word loses its Windows reading",
    " && !WIN_DRIVE.test(t) && !WIN_UNC.test(t)) t = t.replace(",
    ") t = t.replace("],
  [SHELL_CODE, "Shell code: PowerShell words are read with POSIX rules",
    "  const posixText = opts.shellTool !== 'PowerShell' && !winShaped;",
    "  const posixText = !winShaped;"],
  [SHELL_CODE, "Shell code: a Windows workspace's Bash words are read with POSIX rules",
    "  const posixText = opts.shellTool !== 'PowerShell' && !winShaped;",
    "  const posixText = opts.shellTool !== 'PowerShell';"],
  [SHELL_CODE, "Shell code: a here-document fed to code is judged word by word again",
    "    if (seg === null || !subs.ok || !feedsCode(seg, b.body)) { text += b.body; continue; }",
    "    if (true) { text += b.body; continue; }"],
  [SHELL_CODE, "Shell code: a lone slash in a string literal is a place",
    "  return !lit.startsWith('/') && lit.includes('/') && !lit.includes('\\\\');",
    "  return true;"],
  [SHELL_CODE, "Shell code: a relative path in a string literal is text, so an answer file is missed",
    "  return !lit.startsWith('/') && lit.includes('/') && !lit.includes('\\\\');",
    "  return false;"],
  [SHELL_CODE, "Shell code: an absolute path in a string literal is text",
    "  if (/^\\/[^\\s/\\\\]/.test(lit) || WIN_DRIVE",
    "  if (WIN_DRIVE"],
  [SHELL_CODE, "Shell code: a Windows drive or UNC name in a string literal is text",
    " || WIN_DRIVE.test(lit) || WIN_UNC.test(lit) || TRAVERSAL.test(lit)) return true;",
    " || TRAVERSAL.test(lit)) return true;"],
  [SHELL_CODE, "Shell code: a bare climb in a string literal is text",
    " || WIN_UNC.test(lit) || TRAVERSAL.test(lit)) return true;",
    " || WIN_UNC.test(lit)) return true;"],
  [SHELL_CODE, "Shell code: home on its own in a string literal is text",
    "  if (HOME_PREFIX.some(re => re.test(lit)) || ENV_PREFIX.some(re => re.test(lit))) return true;",
    "  if (ENV_PREFIX.some(re => re.test(lit))) return true;"],
  [SHELL_CODE, "Shell code: an environment-variable path in a string literal is text",
    "  if (HOME_PREFIX.some(re => re.test(lit)) || ENV_PREFIX.some(re => re.test(lit))) return true;",
    "  if (HOME_PREFIX.some(re => re.test(lit))) return true;"],
  [SHELL_CODE, "Shell code: a string literal runs on across lines",
    " && s[j] !== '\\n') j += s[j]",
    ") j += s[j]"],
  [SHELL_CODE, "Shell code: backticks in code are not noticed",
    "    if (ch === '`') {",
    "    if (false) {"],
  [SHELL_CODE, "Shell code: Perl and Ruby command quotes are not noticed",
    "    const q = /[\\w$@%]/.test(s[i - 1] || ' ') ? null : QUOTE_OPERATOR.exec(s.slice(i, i + 4));",
    "    const q = null;"],
  [SHELL_CODE, "Shell code: what an unquoted here-document runs as it expands is not judged",
    "    for (const c of [...code.commands, ...subs.bodies]) commands.push({ text: c, at });",
    "    for (const c of code.commands) commands.push({ text: c, at });"],
  [SHELL_CODE, "Shell code: backticks and command quotes in code are not judged",
    "    for (const c of [...code.commands, ...subs.bodies]) commands.push({ text: c, at });",
    "    for (const c of subs.bodies) commands.push({ text: c, at });"],
  [SHELL_CODE, "Shell code: a quoted delimiter's body is read as expanding",
    "    const subs = b.expands ? substitutions(",
    "    const subs = true ? substitutions("],
  [SHELL_CODE, "Shell code: a here-document fed to a shell is judged as code",
    "  if (!CODE_INTERPRETER.test(lead)) return null;",
    "  if (!CODE_INTERPRETER.test(lead)) return 'python';"],
  [SHELL_CODE, "Shell code: data for a script is read as the script's program",
    "      if (!a.startsWith('-') || PROGRAM_FLAG[family].test(a)) return false;",
    "      if (false) return false;"],
  [SHELL_CODE, "Shell code: a here-document cat only prints is read as a file it writes",
    "  const files = lead === 'cat' ? outs : ",
    "  const files = lead === 'cat' ? ['out.txt'] : "],
  [SHELL_CODE, "Shell code: a shell script written to a file is read as code",
    " && !files.some(f => SCRIPT_FILE.test(f)) && ",
    " && "],
  [SHELL_CODE, "Shell code: a shell shebang is not noticed",
    " && !SHELL_SHEBANG.test(String(body).split('\\n')[0]);",
    ";"],
  [SHELL_CODE, "Shell code: a literal in code is never counted as written",
    "    for (const lit of view.literals) writes.words.add(lit.t);\n",
    ""],
  [SHELL_CODE, "Shell code: code given with -c or -e is not read as code",
    "  const inline = inlineCode(view.text, reading);",
    "  const inline = { literals: [], commands: [] };"],
  [SHELL_CODE, "Shell code: a command run from inside -c or -e code is not judged",
    "      for (const c of code.commands) commands.push({ text: c, at });",
    ""],
  [SHELL_CODE, "Shell code: code attached to its flag is not read",
    "      const code = codeParts(m[1] || words[++k] || '', reading);",
    "      const code = codeParts(words[++k] || '', reading);"],
  [SHELL_CODE, "Shell code: node's long --eval is not read as code",
    "|--(?:eval|print)=?)(.*)$/s",
    ")(.*)$/s"],
  [SHELL_CODE, "Shell code: a cd partway through a chain is ignored",
    "  const inChain = !!mid && at >= mid.from && at < mid.to;",
    "  const inChain = false;"],
  [SHELL_CODE, "Shell code: a second cd is trusted",
    "  if (cds !== 1 || other) return fromRoot;",
    "  if (other) return fromRoot;"],
  [SHELL_CODE, "Shell code: pushd and popd do not make the base uncertain",
    "  if (cds !== 1 || other) return fromRoot;",
    "  if (cds !== 1) return fromRoot;"],
  [SHELL_CODE, "Shell code: the words after a cd's chain ends keep its folder",
    "      if (depth === 0 && seg.op !== '&&') return { ...found, to: start };",
    "      if (false) return { ...found, to: start };"],
  [SHELL_CODE, "Shell code: a cd after || or a pipe is trusted",
    "['', ';', '\\n', '&&'].includes(seg.op)",
    "true"],
  [SHELL_CODE, "Shell code: cd - is trusted as a base",
    " || target.startsWith('-') || ",
    " || "],
  [SHELL_CODE, "Shell code: a cd out of the workspace is trusted as a base",
    "  return (insideWorkspaceRoot(base, workspaceRoot, pmod) || namedFolderCovers(base, extraDirs, pmod, home)) ? { base, exists } : null;",
    "  return { base, exists };"],
  [SHELL_CODE, "Shell code: a cd in a subshell, a substitution or behind an escape is not counted",
    "const CD_ANYWHERE = /(?:^|[^\\w./-])cd(?=[\\s;&|()'\"`]|$)/g;",
    "const CD_ANYWHERE = /(?:^|[;&|]|\\s)cd\\s/g;"],
  [SHELL_CODE, "Shell code: a new line or ; before a cd is not trusted",
    "['', ';', '\\n', '&&'].includes(seg.op)",
    "['', '&&'].includes(seg.op)"],
  [SHELL_CODE, "Shell code: a command found in code is spliced into the shell's text again",
    "    for (const c of [...code.commands, ...subs.bodies]) commands.push({ text: c, at });",
    "    for (const c of [...code.commands, ...subs.bodies]) text += c + '\\n';"],
  [SHELL_CODE, "Shell code: a command run from inside the code is measured from the chain's folder",
    "commandBases(fromStart ? '' : view.text, ",
    "commandBases(view.text, "],
  [SHELL_CODE, "Shell code: what a command found in code writes is not counted as written",
    "    for (const [text, fromStart] of [[view.text, false], ...view.commands.map(c => [c.text, true])]) {",
    "    for (const [text, fromStart] of [[view.text, false]]) {"],
  [SHELL_CODE, "Shell code: a compound command after a mid-chain cd ends at its first ;",
    "      if (COMPOUND_OPENS.has(ws[i])) depth++;",
    "      if (false) depth++;"],
  [SHELL_CODE, "Shell code: a compound's closing keyword is not seen, so the chain runs on past it",
    "      else if (depth > 0 && COMPOUND_CLOSES.has(ws[0])) depth--;",
    ""],
  [SHELL_CODE, "Shell code: a keyword after do or then is not in command position",
    "      while (i < ws.length - 1 && KEYWORD_LEADS.has(ws[i])) i++;",
    ""],
  [SHELL_CODE, "Shell code: a missing cd target is trusted without resolving its ancestor",
    "  const base = canonicalize(pmod.resolve(root, target), pmod);",
    "  const base = fs.existsSync(pmod.resolve(root, target)) ? canonicalize(pmod.resolve(root, target), pmod) : pmod.resolve(root, target);"],
  [SHELL_CODE, "Shell code: a missing cd target is the base past its && chain",
    "  if (!cd.exists && !inChain) return root;",
    ""],
  [SHELL_CODE, "Shell code: a missing cd target that climbs with .. is trusted",
    "  if (!exists && TRAVERSAL.test(target)) return null;",
    ""],
  [SHELL_CODE, "Shell code: a bare cd target is not judged, so a link out is not reported",
    "    const cdTarget = previous === 'cd';",
    "    const cdTarget = false;"],
  [SHELL_TIMING, "Shell code: the folder each word starts from is worked out again for every word",
    "    if (!bases.has(key)) bases.set(key, commandBases(",
    "    bases.set(key, commandBases("],
  [SHELL_CODE, "Shell code: a route-shaped literal whose first folder is not on this machine is a place",
    "  if (reading && reading.posixText && /^\\/[^\\s/\\\\]/.test(lit) && !firstFolderExists(lit, reading.firstFolders)) return false;\n",
    ""],
  [SHELL_CODE, "Shell code: the first-folder rule for literals applies to a Windows reading too",
    "  if (reading && reading.posixText && /^\\/[^\\s/\\\\]/.test(lit) && !firstFolderExists(lit, reading.firstFolders)) return false;\n",
    "  if (reading && /^\\/[^\\s/\\\\]/.test(lit) && !firstFolderExists(lit, reading.firstFolders)) return false;\n"],
  [SHELL_CODE, "Shell code: the first folders looked up are kept for the life of the process",
    "firstFolders: new Map() });",
    "firstFolders: (classifyShellAccess.kept = classifyShellAccess.kept || new Map()) });"],
  [SHELL_CODE, "Shell code: a quoted cd handed to a command counts as a second cd",
    "  const changes = folderChanges(command);",
    "  const changes = null;"],
  [SHELL_CODE, "Shell code: a cd inside a group or a function body is not counted",
    "      if (close && !add(folderChanges(w.raw.slice(1, w.raw.lastIndexOf(close)), depth + 1))) return null;",
    ""],
  [SHELL_CODE, "Shell code: a cd that eval runs is not counted",
    "    if (w === 'eval' && !add(folderChanges(words.slice(i + 1).map(v => v.text).join(' '), depth + 1))) return null;",
    ""],
  [SHELL_CODE, "Shell code: a cd inside a substitution is not counted",
    "  for (const body of subs.bodies) if (!add(folderChanges(body, depth + 1))) return null;",
    ""],
  [SHELL_CODE, "Shell code: a cd after a keyword, an assignment or a case pattern is not counted",
    "    while (i < words.length && (COMMAND_LEADS.has(words[i].raw) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i].raw) || (/\\)$/.test(words[i].raw) && !/^[({]/.test(words[i].raw)))) i++;",
    ""],
  [SHELL_CODE, "Shell code: a URL in code is judged as a path",
    "    if (URL_SCHEME.test(t)) continue;\n",
    ""],
  [SHELL_CODE, "Shell code: a cd into a working folder is not a base",
    "  return (insideWorkspaceRoot(base, workspaceRoot, pmod) || namedFolderCovers(base, extraDirs, pmod, home)) ? { base, exists } : null;",
    "  return insideWorkspaceRoot(base, workspaceRoot, pmod) ? { base, exists } : null;"],
  [SHELL_CODE, "Shell code: pushd and popd are not counted when the command cannot be lexed",
    "const DIR_CHANGE = /(?:^|[^\\w./-])(?:pushd|popd)(?=[\\s;&|()'\"`]|$)/;",
    "const DIR_CHANGE = /(?!)/;"],
  [SHELL_CODE, "Shell code: a cd to a variable is trusted as a base",
    " || CD_NOT_LITERAL.test(target)) return null;",
    ") return null;"],
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
  // The suites go to the envelope too: several of them build the Code-mode
  // fixture, and without its folder they skip and every row aimed at them
  // turns nothing red.
  const session = beginMutationRun({
    files: [...new Set(targets.map((target) => target.src))],
    suites: [...new Set(targets.map((target) => target.suite))],
  });
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
