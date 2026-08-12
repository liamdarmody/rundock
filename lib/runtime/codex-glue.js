'use strict';
// Codex runtime glue, extracted verbatim from server.js as part of the
// server decomposition: the shared app-server lifecycle (lazy singleton,
// module-owned state), direct-chat turns, delegate turn wiring, approvals,
// the keepalive heartbeat, and every failure surface. What did NOT move:
// getRuntimeStatus and the Claude probe caches (settings machinery),
// requestServerPermission (the generic server-originated permission
// bridge, used beyond Codex; injected here), and the kill-window machine.
//
// Root-owned capabilities arrive through wireCodexGlueDeps BY IDENTITY:
// live-state accessors (chatProcesses, recentSpawnErrors) return the
// root's own maps, never copies, so tests and the root observe the same
// entries the glue mutates. Unwired deps throw at first use. The workspace
// root is read at USE time via lib/config.js: a workspace switch
// immediately redirects every later thread cwd and instruction read.
const path = require('path');
const codexRuntime = require('../../codex.js');
const codexAppServerLib = require('../../codex-appserver.js');
const { getWorkspace } = require('../config.js');
const { recordEvent } = require('../signals.js');
const { resolveMarkers } = require('../delegation/markers.js');
const { buildSystemPrompt } = require('../agents/prompt.js');
const { readNormalisedFile } = require('../agents/discovery.js');

const unwired = (name) => () => {
  throw new Error(`lib/runtime/codex-glue: ${name} not wired (call wireCodexGlueDeps at boot)`);
};
const deps = {
  chatProcesses: unwired('chatProcesses'),               // () => Map (BY IDENTITY)
  recentSpawnErrors: unwired('recentSpawnErrors'),       // () => Map (shared spawn-error dedupe)
  safeSend: unwired('safeSend'),
  appendTranscript: unwired('appendTranscript'),
  endConvoTransition: unwired('endConvoTransition'),
  registerChildPid: unwired('registerChildPid'),
  unregisterChildPid: unwired('unregisterChildPid'),
  killProcessTree: unwired('killProcessTree'),
  requestServerPermission: unwired('requestServerPermission'),
  getActualPort: unwired('getActualPort'),
  getPermissionTimeoutMs: unwired('getPermissionTimeoutMs'),
};
function wireCodexGlueDeps(next) {
  const prev = { ...deps };
  Object.assign(deps, next);
  return prev;
}

// ===== CODEX RUNTIME =====
// Agents with `runtime: codex` in their frontmatter run on the OpenAI Codex
// CLI (the user's ChatGPT plan) instead of Claude Code. ONE long-lived
// `codex app-server` process (a lazy singleton, see getCodexAppServer)
// serves every Codex conversation concurrently: each conversation is a
// thread, each message a streamed turn, and sandbox escalations arrive as
// per-action approval requests that ride the existing permission-card
// bridge. Thread ids ride the same client rails as Claude session ids, so
// the rest of the product treats both runtimes identically. Protocol
// plumbing lives in codex-appserver.js; detection/classification helpers in
// codex.js.

// Resolve the codex binary lazily and cache it, mirroring resolveClaudeBin.
let _resolvedCodexBin = null;
function resolveCodexBinCached() {
  if (!_resolvedCodexBin) _resolvedCodexBin = codexRuntime.resolveCodexBin();
  return _resolvedCodexBin;
}

// ── Shared app-server singleton ──────────────────────────────────────────
// One `codex app-server` process for the whole Rundock server, created and
// started lazily on the first Codex turn. The client module owns restarts
// (capped backoff); this host re-registers the child pid on every 'ready'
// so crash cleanup always tracks the CURRENT process. A conversation cancel
// must NEVER kill this process: it interrupts its own turn instead.
let _codexAppServerPromise = null;   // in-flight or resolved creation
let _codexAppServerInstance = null;  // resolved instance (sync access)
let _codexAppServerPid = null;       // current child pid (crash cleanup)

// Environment for the shared server. The app-server is conversation-
// agnostic, so the per-conversation parts of getSpawnEnv (RUNDOCK_CONVO_ID,
// RUNDOCK_CODE_MODE and ELECTRON_RUN_AS_NODE, which exist for the Claude
// permission hook that Codex never runs) do not apply; only the global
// bits survive: the RUNDOCK marker, the port, and the coverage guard
// (a SIGKILLed child mid-test would otherwise corrupt coverage merges).
function codexAppServerEnv() {
  const env = { ...process.env, TERM: 'dumb', RUNDOCK: '1', RUNDOCK_PORT: String(deps.getActualPort()), RUNDOCK_WORKSPACE: getWorkspace() || '' };
  delete env.NODE_V8_COVERAGE;
  return env;
}

// The tested protocol range for this release (RESEARCH.md section 10). The
// app-server surface is experimental and drifts between CLI releases:
// outside the range, warn loudly but do not block (thread state lives on
// disk; the worst case is turns failing with visible errors). The version
// comes from the initialize response's userAgent: the authoritative signal
// for the RUNNING process, unlike a separate `codex --version` probe.
function warnIfCodexVersionUntested(version) {
  const m = /^(\d+)\.(\d+)/.exec(String(version || ''));
  if (!m) {
    console.warn(`[CodexAppServer] could not parse server version '${version}'; tested range is >=0.144 <0.146`);
    return;
  }
  const major = parseInt(m[1], 10);
  const minor = parseInt(m[2], 10);
  if (!(major === 0 && minor >= 144 && minor < 146)) {
    console.warn(`[CodexAppServer] codex-cli ${version} is outside the tested range (>=0.144 <0.146); the app-server protocol may have drifted`);
  }
}

function getCodexAppServer() {
  if (_codexAppServerPromise) return _codexAppServerPromise;
  _codexAppServerPromise = (async () => {
    const server = codexAppServerLib.createCodexAppServer({
      binPath: resolveCodexBinCached(),
      // cwd does not affect thread behaviour (every thread passes an
      // absolute cwd), but keep it at the workspace for tidy child context.
      cwd: getWorkspace() || process.cwd(),
      env: codexAppServerEnv(),
      // The protocol client's own approval timeout must fire AFTER the
      // permission card's (PERMISSION_TIMEOUT_MS), so the card timeout
      // drives the outcome and the module timeout stays a backstop.
      approvalTimeoutMs: deps.getPermissionTimeoutMs() + 30000,
      // Slot-release failsafe after an interrupt whose response or
      // turn/completed never arrives (Finding 6 Mode 2); env-overridable
      // for tests, like the keepalive interval.
      interruptFailsafeMs: CODEX_INTERRUPT_FAILSAFE_MS,
      interruptRetryMs: CODEX_INTERRUPT_RETRY_MS,
      log: (m) => console.log(`[CodexAppServer] ${m}`),
    });
    server.on('ready', ({ version }) => {
      const pid = server.pid();
      if (pid) { _codexAppServerPid = pid; deps.registerChildPid(pid); }
      warnIfCodexVersionUntested(version);
    });
    server.on('exit', ({ code, signal, intentional }) => {
      if (_codexAppServerPid) { deps.unregisterChildPid(_codexAppServerPid); _codexAppServerPid = null; }
      if (!intentional) console.warn(`[CodexAppServer] exited (code=${code} signal=${signal || ''})`);
    });
    server.on('restart', ({ attempt, delayMs }) => {
      console.log(`[CodexAppServer] restart scheduled (attempt ${attempt}, ${delayMs}ms)`);
    });
    await server.start();
    _codexAppServerInstance = server;
    return server;
  })();
  // A failed boot (binary missing, bad install) must not poison the
  // singleton: reset so the next turn retries after the user fixes it.
  _codexAppServerPromise.catch(() => { _codexAppServerPromise = null; });
  return _codexAppServerPromise;
}

// After a crash the client restarts with backoff; a turn arriving in that
// window waits (bounded) for readiness instead of failing instantly.
function waitForCodexReady(server, timeoutMs = 20000) {
  if (server.isReady()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.removeListener('ready', onReady);
      reject(new Error('the Codex runtime is restarting and did not come back in time'));
    }, timeoutMs);
    const onReady = () => { clearTimeout(timer); resolve(); };
    server.once('ready', onReady);
  });
}

// Intentional teardown: workspace switch and server shutdown. Clears the
// singleton so the next Codex turn recreates it (with the new workspace's
// cwd). The pid stays registered until the child actually exits, so crash
// cleanup still covers a SIGTERM that never lands.
function shutdownCodexAppServer() {
  const server = _codexAppServerInstance;
  _codexAppServerInstance = null;
  _codexAppServerPromise = null;
  if (server) server.shutdown().catch((e) => console.warn(`[CodexAppServer] shutdown failed: ${e.message}`));
}

// Surface a Codex failure once per turn, classified: plan-limit exhaustion
// becomes a structured quota message (the client renders a recovery card, the
// same pattern as the Claude auth-error card); everything else becomes a
// structured error message with the CLI's verbatim text attached. The failure
// is also persisted to the transcript, so a user who wasn't looking at the
// conversation still finds out what happened when they open it.
// `kind` is the protocol's typed classification (auth/quota/context/model/
// unknown, from codexErrorInfo); it is preferred when present, with the
// message-pattern classifier as the fallback for untyped failures.
function sendCodexError(entry, convoId, message, kind) {
  if (entry.errorSent) return;
  entry.errorSent = true;
  const classified = codexRuntime.classifyCodexError(message);
  if (kind && kind !== 'unknown') classified.kind = kind;
  recordEvent('runtime_error', { conv: convoId, agent: entry.agentId, runtime: 'codex', d: { class: classified.kind === 'quota' ? 'codex_quota' : 'codex_error' } });
  // Actionable failures (signed out, unavailable model) become guidance cards
  // with a concrete fix; quota keeps its dedicated card; everything else
  // surfaces verbatim as a classified error pill.
  let subtype, friendly, guidance = null;
  if (classified.kind === 'quota') {
    subtype = 'codex_quota';
    friendly = 'This turn stopped: the ChatGPT plan limit was reached. It can be retried once the limit resets.';
  } else if (classified.kind === 'auth') {
    subtype = 'codex_guidance';
    guidance = {
      title: 'Codex is not signed in',
      body: 'This agent runs on Codex, but the Codex CLI is not signed in on this machine. Run codex login in a terminal, then resend your message.',
    };
    friendly = 'This turn stopped: Codex is not signed in on this machine. Run codex login in a terminal, then resend the message.';
  } else if (classified.kind === 'model') {
    subtype = 'codex_guidance';
    const modelBit = classified.model ? `the model '${classified.model}'` : 'a model';
    guidance = {
      title: 'Model not available on this account',
      body: `This agent is configured with ${modelBit}, which this Codex account does not offer. Edit the agent and remove the model field to use the account default, or pick a model your plan includes.`,
    };
    friendly = `This turn stopped: ${modelBit} is not available on this Codex account. Remove the agent's model field to use the account default, or pick an available model.`;
  } else if (classified.kind === 'context') {
    subtype = 'codex_error';
    friendly = 'This turn stopped: the conversation has outgrown the model\'s context window. Start a new conversation to continue.';
  } else {
    subtype = 'codex_error';
    friendly = 'This turn stopped: the runtime hit a problem.';
  }
  try {
    deps.appendTranscript(convoId, 'agent', entry.agentId, `${friendly}\nCodex: ${message}`, undefined, entry);
  } catch (e) { /* transcript persistence is best-effort */ }
  deps.safeSend(JSON.stringify({
    type: 'system', subtype, detail: message, ...(guidance || {}),
    _agent: entry.agentId, _conversationId: convoId, _processId: entry.processId,
  }));
}

// Spawn-failure copy for the shared Codex app-server. The generic Claude
// spawn-error handler tells users to check their Claude Code install, which
// is the wrong guidance for a Codex agent. Surfaces once per conversation-
// turn attempt (the singleton resets on a failed boot, so every retry against
// a missing binary lands here, deduped below). Marks the entry so any close
// paths stay silent.
function handleCodexSpawnError(err, convoId) {
  const entry = deps.chatProcesses().get(convoId);
  if (entry) entry.spawnFailed = true;
  // Same 30s per-conversation dedupe as the Claude spawn-error handler, so
  // retries against a missing binary do not stack pills. Keys are prefixed
  // to keep the two runtimes' dedupe windows independent.
  const dedupeKey = `codex:${convoId || ''}`;
  const last = deps.recentSpawnErrors().get(dedupeKey);
  const now = Date.now();
  if (last && last.code === err.code && (now - last.ts) < 30000) {
    console.error(`[SpawnError] convo=${convoId} codex code=${err.code} (deduped within 30s)`);
    deps.safeSend(JSON.stringify({
      type: 'system', subtype: 'done', code: -1,
      _agent: entry ? entry.agentId : undefined, _conversationId: convoId,
      _processId: entry ? entry.processId : undefined,
    }));
    return;
  }
  deps.recentSpawnErrors().set(dedupeKey, { code: err.code, ts: now });
  let userMessage;
  if (err.code === 'ENOENT') {
    userMessage = 'The Codex CLI was not found on this machine. Install the official Codex CLI, then sign in: npm install -g @openai/codex then codex login';
  } else if (err.code === 'EACCES') {
    userMessage = "Couldn't start Codex: permission denied. Check your Codex CLI install.";
  } else {
    userMessage = `Couldn't start Codex: ${err.message}. Run codex --version to check your install.`;
  }
  deps.safeSend(JSON.stringify({
    type: 'system', subtype: 'info', content: userMessage, _conversationId: convoId,
  }));
  deps.safeSend(JSON.stringify({
    type: 'system', subtype: 'done', code: -1,
    _agent: entry ? entry.agentId : undefined, _conversationId: convoId,
    _processId: entry ? entry.processId : undefined,
  }));
}

// One approval request from a Codex turn (RESEARCH.md section 5): the agent
// needs something its sandbox blocks (a command outside the sandbox, network
// access, a write outside writable roots). Route it through the existing
// permission-card bridge; the protocol client keeps the turn blocked until
// respond() is called, and its own timeout (approvalTimeoutMs, set longer
// than PERMISSION_TIMEOUT_MS) backstops a card that never resolves.
function handleCodexApproval(entry, convoId, ev) {
  const params = ev.params || {};
  if (entry.cancelled || entry.superseded) {
    // The conversation already moved on; stop the turn rather than leave
    // the server blocked on a card nobody will see.
    try { ev.respond('cancel'); } catch (e) { /* already resolved */ }
    return;
  }
  let toolName, toolInput;
  if (ev.kind === 'command') {
    toolName = process.platform === 'win32' ? 'PowerShell' : 'Bash';
    toolInput = { command: params.command || '' };
    if (params.reason) toolInput.description = params.reason;
  } else {
    // fileChange. v1 limitation: the approval request carries only the
    // grant root and reason; the patch content lives on the fileChange item,
    // which the protocol client does not expose. The input is honest about
    // that: content is null (never an empty string a card could present as
    // "the exact content"), the approval kind is explicit, and the runtime's
    // reason (the one honest context available) travels so the card renders
    // it. The client copy for this shape says the agent wants write access
    // under the path, without claiming any content is shown (see
    // public/permissions.js describeToolRequest).
    toolName = 'WriteFile';
    toolInput = {
      path: params.grantRoot || getWorkspace() || '',
      content: null,
      agent: entry.agentId,
      reason: params.reason || null,
      approvalKind: 'fileChange',
    };
  }
  deps.requestServerPermission({
    convoId,
    toolName,
    toolInput,
    onDecision: (allow, reason) => {
      try {
        if (allow) ev.respond('accept');
        // A conversation cancel becomes the protocol's 'cancel' decision
        // (deny AND interrupt the turn); deny/timeout decline, letting the
        // agent continue and work around the refusal.
        else if (reason === 'cancelled') ev.respond('cancel');
        else ev.respond('decline');
      } catch (e) { /* approval already resolved (module timeout won) */ }
    },
  });
}

// Turn-activity keepalive for Codex turns. The protocol client forwards ONLY
// agentMessage deltas to the browser, so a turn that thinks silently or runs
// a long tool (npm install, a test suite: minutes of legitimate silence)
// produces zero watchdog-resetting messages and the client's 90s
// stream-inactivity watchdog would auto-finish the UI mid-task. While the
// turn entry is live, a periodic system/keepalive keeps the working state
// honest; the client reducer treats it as stream activity and renders
// nothing. Design note: a fixed-interval heartbeat was chosen over
// forwarding the protocol's non-agentMessage activity (reasoning deltas,
// command output deltas, item/started) because it bounds the client's
// activity gap at CODEX_KEEPALIVE_MS regardless of WHAT the runtime emits;
// an activity forward would add protocol surface without improving that
// worst case. Interval is env-overridable for tests, exactly like the
// exec-era heartbeat this reinstates.
const CODEX_KEEPALIVE_MS = parseInt(process.env.RUNDOCK_CODEX_KEEPALIVE_MS || '', 10) || 25000;

// Post-cancel follow-up window tunables (Windows VM Finding 6). Both are
// env-overridable so tests can run the paths in milliseconds.
// - Failsafe: how long the protocol client waits after sending an interrupt
//   before releasing the client-side turn slot locally (Mode 2).
// - Retry: how long to wait before the single thread/resume retry when the
//   failure is the transient not-yet-flushed-rollout class (Mode 1). ~2s
//   matches the observed flush behaviour: the rollout appears shortly after
//   codex finishes wrapping up the interrupted turn.
const CODEX_INTERRUPT_FAILSAFE_MS = parseInt(process.env.RUNDOCK_CODEX_INTERRUPT_FAILSAFE_MS || '', 10) || 10000;
// One interrupt re-send before the failsafe (Windows Finding 7); the client
// defaults to the halfway point of the failsafe window when unset.
const CODEX_INTERRUPT_RETRY_MS = parseInt(process.env.RUNDOCK_CODEX_INTERRUPT_RETRY_MS || '', 10) || undefined;
const CODEX_RESUME_RETRY_MS = parseInt(process.env.RUNDOCK_CODEX_RESUME_RETRY_MS || '', 10) || 2000;
function startCodexTurnKeepalive(entry, convoId) {
  const timer = setInterval(() => {
    // Self-clearing liveness check: the entry has no child process (its turn
    // runs on the shared app-server), so terminal states are flags.
    if (entry.exited || entry.resultSent || entry.spawnFailed || entry.cancelled || entry.superseded) {
      clearInterval(timer);
      if (entry._keepaliveTimer === timer) entry._keepaliveTimer = null;
      return;
    }
    deps.safeSend(JSON.stringify({
      type: 'system', subtype: 'keepalive',
      _agent: entry.agentId, _conversationId: convoId, _processId: entry.processId,
    }));
  }, CODEX_KEEPALIVE_MS);
  // Never hold the event loop open for a heartbeat (the done/failure paths
  // below stop it deterministically anyway).
  if (timer.unref) timer.unref();
  entry._keepaliveTimer = timer;
}
function stopCodexTurnKeepalive(entry) {
  if (entry._keepaliveTimer) { clearInterval(entry._keepaliveTimer); entry._keepaliveTimer = null; }
}

// Terminal done envelope, exactly once per turn.
function sendCodexDone(entry, convoId, code) {
  if (entry.doneSent) return;
  entry.doneSent = true;
  deps.safeSend(JSON.stringify({
    type: 'system', subtype: 'done', code,
    _agent: entry.agentId, _conversationId: convoId, _processId: entry.processId,
  }));
}

// Deliver the completed Codex turn: persist the transcript, send the result
// (with normalised token usage: subscription usage, never dollar costs) and
// the done signal.
function finishCodexTurn(entry, convoId) {
  if (entry.resultSent) return;
  entry.resultSent = true;
  const text = entry.responseText || '';
  if (text) deps.appendTranscript(convoId, 'agent', entry.agentId, text, undefined, entry);
  deps.safeSend(JSON.stringify({
    type: 'result', result: text, is_error: false, usage: entry.usage,
    _agent: entry.agentId, _conversationId: convoId, _processId: entry.processId,
    _turnStartTime: entry.turnStartTime,
  }));
  sendCodexDone(entry, convoId, 0);
}

// Read an agent's full instruction body from its file. Claude Code loads
// agent files natively via --agent, but Codex has no equivalent, so the
// instructions must travel inside the first-turn prompt. Falls back to the
// (truncated) discovery snapshot if the file cannot be read.
function readAgentInstructions(agentData) {
  try {
    if (agentData.fileName && getWorkspace()) {
      const content = readNormalisedFile(path.join(getWorkspace(), '.claude', 'agents', agentData.fileName));
      const bodyMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)/);
      if (bodyMatch && bodyMatch[1].trim()) return bodyMatch[1].trim();
    }
  } catch (e) { /* fall through to snapshot */ }
  return agentData.instructions || '';
}

// Shared per-entry plumbing for Codex turns. The entry has NO per-
// conversation child process: `interrupt()` stops the entry's own turn on
// the shared app-server (the runtime-aware replacement for process.kill),
// and `_turnEnd` resolves when the turn reaches its done event, so a
// superseding message can wait (bounded) for the thread's slot to free.
function makeCodexEntryControls(entry) {
  entry.interrupt = () => {
    const server = _codexAppServerInstance;
    if (server && entry._turnThreadId) {
      try {
        const p = server.interruptTurn(entry._turnThreadId);
        // A failed interrupt is a real signal, not noise (Finding 6 Mode 2:
        // lost interrupt responses left turns wedged for tens of seconds).
        // Surface it; the protocol client's failsafe releases the slot.
        if (p && p.catch) p.catch((e) => console.warn(`[Codex] turn/interrupt failed on thread ${entry._turnThreadId}: ${e.message}`));
      } catch (e) { /* no active turn: nothing to interrupt */ }
    }
  };
  entry._turnEnd = new Promise((resolve) => { entry._turnEndResolve = resolve; });
}

// Resolve the shared server and this conversation's thread, then send the
// init envelope (same shape as the Claude init: the client stores the id and
// sends it back as msg.sessionId on the next turn). Shared by direct chats
// and delegated turns.
// Classify a thread/resume rejection. Only ever evaluated against a
// thread/resume rejection, so the generic -32600 code cannot misfire for
// other requests. Returns:
//
//   'transient'  The thread EXISTS but is not readable yet. Captured live
//                (Windows 11, codex-cli 0.144.4, Finding 6 Mode 1): a resume
//                arriving seconds after an interrupted turn fails with
//                "failed to read thread: thread-store internal error: failed
//                to read session metadata ...rollout-...jsonl: rollout at
//                ... is empty", because codex had not flushed the rollout
//                yet (it appeared moments later). Falling back to a fresh
//                thread here would permanently discard a thread about to
//                become resumable, so this class retries and then asks the
//                user to resend, never clearing the stored session id.
//   'permanent'  The thread is GONE: -32600 "no rollout found for thread id
//                ..." (verified live against 0.144.3). Real-world triggers:
//                Codex pruning sessions under ~/.codex, thread/delete, a
//                CODEX_HOME change, a workspace synced across machines. The
//                wording patterns are a fallback for CLI releases that
//                phrase it differently. Recovery starts a fresh thread.
//   null         Not resume-shaped (transport failure etc.): propagate.
//
// Transient wording is checked FIRST: it is more specific, and the
// read-race message must never fall into the permanent class (that is the
// exact bug this classification fixes).
const CODEX_RESUME_TRANSIENT_RE = /rollout at .* is empty|thread-store internal error|failed to read session metadata/i;
function classifyCodexResumeFailure(err) {
  if (!err) return null;
  const message = err.message || '';
  if (CODEX_RESUME_TRANSIENT_RE.test(message)) return 'transient';
  if (err.code === -32600) return 'permanent';
  if (/no rollout|not found/i.test(message)) return 'permanent';
  return null;
}

// A turn-start refusal because the thread's previous turn is still winding
// down (Finding 6 Mode 2). Two sources share the wording: the protocol
// client's own synchronous guard ("a turn is already active on thread ...")
// when the local slot has not been released yet, and the server's rejection
// of turn/start when ITS turn state is still active (the server is
// authoritative; the local failsafe may have already released the slot).
// Both are the same user situation: pressed stop, sent the next message too
// quickly. Surfaced as a retryable notice, never an error card.
const CODEX_TURN_BUSY_RE = /already active on thread/i;
function isCodexTurnBusy(err) {
  if (!err) return false;
  return !!err.codexBusy || CODEX_TURN_BUSY_RE.test(err.message || '');
}

// The retryable "resend in a moment" notice for both Finding 6 modes.
// Subtype 'notice' (the neutral pill): 'info' would clear the stored
// session id client-side, and preserving the session is the whole point.
const CODEX_BUSY_NOTICE = 'The runtime is still wrapping up the previous turn. Resend your message in a moment.';
function sendCodexBusyNotice(entry, convoId) {
  if (entry.busyNoticeSent) return;
  entry.busyNoticeSent = true;
  // Suppress any later error surface for this turn: busy is not a failure.
  entry.errorSent = true;
  deps.safeSend(JSON.stringify({
    type: 'system', subtype: 'notice', content: CODEX_BUSY_NOTICE,
    _agent: entry.agentId, _conversationId: convoId, _processId: entry.processId,
  }));
}

// Returns { server, threadId, resumed } (or null when the conversation moved
// on). `resumed` is true ONLY when the stored thread actually resumed:
// callers must compose a FULL first-turn prompt (identity + platform rules)
// whenever it is false, including the expired-session fallback below.
async function openCodexThread(entry, convoId, resumeThreadId, model) {
  // Bail (without a turn) once the conversation has moved on; resolve the
  // turn-end promise so a superseding message never waits on a turn that
  // will not happen.
  const abandoned = () => {
    if (!entry.cancelled && !entry.superseded) return false;
    if (entry._turnEndResolve) entry._turnEndResolve();
    return true;
  };
  const server = await getCodexAppServer();
  await waitForCodexReady(server);
  if (abandoned()) return null;
  const threadOpts = {
    cwd: getWorkspace(),
    model: model || undefined,
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
  };
  let threadId;
  let resumed = false;
  if (resumeThreadId) {
    try {
      ({ threadId } = await server.resumeThread(resumeThreadId, threadOpts));
      resumed = true;
    } catch (err) {
      // Non-resume-shaped failures still propagate to the caller's error
      // surface; resume-shaped ones split by class (see
      // classifyCodexResumeFailure).
      let cls = classifyCodexResumeFailure(err);
      if (!cls) throw err;
      if (abandoned()) return null;
      if (cls === 'transient') {
        // Finding 6 Mode 1: the interrupted thread's rollout has not been
        // flushed yet. Retry ONCE after a short wait; if the thread is
        // still unreadable, hand the moment back to the user (busy notice +
        // clean done via the codexBusy path) with the session id intact.
        // NEVER fall back to a fresh thread here: the thread becomes
        // resumable once codex flushes, and a fresh thread would discard it
        // permanently.
        console.log(`[Codex] convo=${convoId} thread/resume transient failure for ${resumeThreadId} (${err.message}); retrying in ${CODEX_RESUME_RETRY_MS}ms`);
        await new Promise(r => setTimeout(r, CODEX_RESUME_RETRY_MS));
        if (abandoned()) return null;
        try {
          ({ threadId } = await server.resumeThread(resumeThreadId, threadOpts));
          resumed = true;
        } catch (err2) {
          const cls2 = classifyCodexResumeFailure(err2);
          if (cls2 === 'transient') {
            const busy = new Error(`codex thread ${resumeThreadId} is still settling after the previous turn: ${err2.message}`);
            busy.codexBusy = true;
            throw busy;
          }
          if (cls2 !== 'permanent') throw err2;
          // Transient turned permanent on the retry: the thread really is
          // gone; fall through to the fresh-thread recovery below.
          cls = 'permanent';
          err = err2;
        }
      }
      if (!resumed && cls === 'permanent') {
        // Mirror the Claude path's stale-session recovery (isResumeFailure
        // in the chat close handlers): the stored thread is gone, so tell
        // the user with the same copy and fall back to a FRESH thread in
        // the same pass, so this message is still answered instead of the
        // conversation bricking on every retry. Direct chats use subtype
        // 'info', the client's stale-session signal, which also clears the
        // stored primary session id; delegate turns use the neutral
        // 'notice' because 'info' would clear the ORCHESTRATOR's primary
        // session, and the delegate's fresh id supersedes the stale one in
        // the sessionIds chain via the init envelope below.
        console.log(`[Codex] convo=${convoId} thread/resume failed for ${resumeThreadId} (${err.message}); starting fresh`);
        deps.safeSend(JSON.stringify({
          type: 'system', subtype: entry.delegation ? 'notice' : 'info',
          content: 'Previous session expired. Starting fresh.',
          _conversationId: convoId, _processId: entry.processId,
        }));
        ({ threadId } = await server.startThread(threadOpts));
      }
    }
  } else {
    ({ threadId } = await server.startThread(threadOpts));
  }
  if (abandoned()) return null;
  entry.sessionId = threadId;
  deps.safeSend(JSON.stringify({
    type: 'system', subtype: 'init', _sessionId: threadId,
    _agent: entry.agentId, _conversationId: convoId, _processId: entry.processId,
  }));
  return { server, threadId, resumed };
}

// Failure before the turn could start (binary missing, handshake failed,
// thread/start rejected). Spawn-level failures get the Codex install
// guidance; everything else surfaces as a classified runtime error. Either
// way the client is unblocked with a done envelope and the entry released.
function handleCodexTurnStartFailure(entry, convoId, err) {
  entry.exited = true;
  stopCodexTurnKeepalive(entry);
  if (entry._turnEndResolve) entry._turnEndResolve();
  if (entry.cancelled || entry.superseded) {
    if (deps.chatProcesses().get(convoId) === entry) deps.chatProcesses().delete(convoId);
    return;
  }
  if (isCodexTurnBusy(err)) {
    // Finding 6: the previous (usually just-cancelled) turn is still winding
    // down, either locally (slot not yet released; the failsafe will free
    // it) or server-side (the server rejected turn/start; its state is
    // authoritative). Retryable, not an error: notice + clean done, session
    // preserved so the resend simply works.
    console.log(`[Codex] convo=${convoId} turn not started, previous turn still active: ${err.message}`);
    sendCodexBusyNotice(entry, convoId);
    sendCodexDone(entry, convoId, 0);
    if (deps.chatProcesses().get(convoId) === entry) {
      deps.chatProcesses().delete(convoId);
      deps.endConvoTransition(convoId, entry);
    }
    return;
  }
  console.error(`[Codex] convo=${convoId} turn failed to start: ${err.message}`);
  if (err && (err.code === 'ENOENT' || err.code === 'EACCES')) {
    handleCodexSpawnError(err, convoId); // sends info + done (reads the entry from the map)
  } else {
    sendCodexError(entry, convoId, err.message);
    sendCodexDone(entry, convoId, -1);
  }
  if (deps.chatProcesses().get(convoId) === entry) {
    deps.chatProcesses().delete(convoId);
    deps.endConvoTransition(convoId, entry); // never strand a kill-window buffer
  }
}

// Wire a Codex delegate turn on the shared app-server. Events deliver the
// specialist's result and record any handoff marker on the SAME entry fields
// Claude delegates use (returnMarkerSeen, finalResponseText), so the shared
// delegate close path in handleDelegation performs restoration identically
// for both runtimes. With no per-turn process there is no 'close' event: the
// turn's done event fires entry.onTurnDone (set by handleDelegation to the
// same handler Claude delegates attach to process close), which owns
// agent_switch/done and parent restoration. This function sends the result.
function wireCodexDelegate(entry, convoId, prompt, { resumeThreadId = null, model = undefined, freshPrompt = null } = {}) {
  makeCodexEntryControls(entry);
  // Same silent-turn heartbeat as direct chats: a delegate has no per-turn
  // process either, and its brief is exactly the kind of long quiet work
  // (research, tool runs) the watchdog would otherwise declare dead.
  startCodexTurnKeepalive(entry, convoId);
  (async () => {
    const opened = await openCodexThread(entry, convoId, resumeThreadId, model);
    if (!opened) return;
    const { server, threadId } = opened;
    entry._turnThreadId = threadId;
    // An expired delegate session falls back to a fresh thread inside
    // openCodexThread; a fresh thread needs the FULL delegate prompt
    // (identity + delegation contract + brief), never the resume-shaped one.
    const turnPrompt = opened.resumed ? prompt : (freshPrompt || prompt);
    const sub = server.startTurn(threadId, turnPrompt);
    entry.subscription = sub;
    sub.on('event', (ev) => {
      try {
        handleCodexDelegateEvent(entry, convoId, ev);
      } catch (e) {
        console.error(`[Codex] convo=${convoId} delegate event handling failed:`, e);
      }
    });
  })().catch((err) => {
    // Same surface as a delegate process that died before its result; the
    // done hook still fires so handleDelegation can restore the parent.
    if (err && (err.code === 'ENOENT' || err.code === 'EACCES')) {
      handleCodexSpawnError(err, convoId);
    } else if (!entry.cancelled && isCodexTurnBusy(err)) {
      // Finding 6: previous turn on the delegate's thread still winding
      // down. Retryable notice instead of an error card (see
      // handleCodexTurnStartFailure).
      sendCodexBusyNotice(entry, convoId);
    } else if (!entry.cancelled) {
      sendCodexError(entry, convoId, err.message);
    }
    entry.exited = true;
    stopCodexTurnKeepalive(entry);
    if (entry._turnEndResolve) entry._turnEndResolve();
    if (entry.onTurnDone) entry.onTurnDone(-1);
  });
}

function handleCodexDelegateEvent(entry, convoId, ev) {
  switch (ev.type) {
    case 'delta':
      // Live streaming to the browser, same synthesised shape as direct
      // chats; the delegate's text appears as it is produced.
      if (!entry.cancelled) {
        deps.safeSend(JSON.stringify({
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ev.text } },
          _agent: entry.agentId, _conversationId: convoId, _processId: entry.processId,
        }));
      }
      return;
    case 'text':
      // Belt and braces for Finding 7, same as the direct-chat handler:
      // post-done text can only be a superseded turn's leakage.
      if (entry.exited) return;
      entry.responseText = entry.responseText ? entry.responseText + '\n' + ev.text : ev.text;
      return;
    case 'usage':
      entry.usage = ev.usage;
      return;
    case 'approval':
      handleCodexApproval(entry, convoId, ev);
      return;
    case 'error':
      // willRetry means the server is retrying internally: not terminal,
      // never surfaced (only turn/completed ends the turn).
      if (ev.willRetry) {
        console.log(`[Codex] convo=${convoId} delegate transient error (retrying): ${ev.message}`);
        return;
      }
      if (!entry.cancelled && isCodexTurnBusy(ev)) {
        // Server-side turn still active on the delegate's thread (Finding
        // 6): retryable notice, never an error card.
        sendCodexBusyNotice(entry, convoId);
        return;
      }
      if (!entry.cancelled) sendCodexError(entry, convoId, ev.message, ev.kind);
      return;
    case 'done': {
      entry.exited = true;
      entry._turnThreadId = null;
      stopCodexTurnKeepalive(entry);
      if (entry._turnEndResolve) entry._turnEndResolve();
      if (ev.status === 'completed' && !entry.cancelled) {
        // Marker scan, COMPLETE priority: same single resolver as the
        // Claude delegate onResult handler. mode is null when no handoff
        // marker is present, matching the unset-field contract downstream.
        const markerMode = resolveMarkers(entry.responseText).mode;
        if (markerMode) entry.returnMarkerSeen = markerMode;
        const displayText = entry.responseText;
        if (displayText) deps.appendTranscript(convoId, 'agent', entry.agentId, displayText, undefined, entry);
        deps.safeSend(JSON.stringify({
          type: 'result', result: displayText, is_error: false, usage: entry.usage || ev.usage,
          _agent: entry.agentId, _conversationId: convoId, _processId: entry.processId,
          _turnStartTime: entry.turnStartTime,
        }));
        entry.resultSent = true;
        entry.finalResponseText = displayText;
        // Handback parity with the Claude delegate onResult: accumulate the
        // turn before the reset so multi-turn handbacks stay whole.
        if (displayText && entry.deliveredTurns) entry.deliveredTurns.push(displayText);
        entry.responseText = '';
        entry.idle = true; entry.idleSince = Date.now();
      } else if (ev.status === 'failed' && !entry.cancelled) {
        if (!entry.resultSent && !entry.errorSent) {
          sendCodexError(entry, convoId, (ev.error && ev.error.message) || 'Codex turn failed');
        }
      }
      // Fire the shared restoration path (it no-ops for cancelled/replaced
      // entries via its own current-entry and cancelled checks).
      if (entry.onTurnDone) entry.onTurnDone(ev.status === 'completed' ? 0 : 1);
      return;
    }
  }
}

// Run one Codex conversation turn on the shared app-server. Fresh turns
// carry the agent's instructions and the platform rules followed by the user
// message; resumed turns send only the new message (instructions are never
// re-injected, keeping resumed turns cheap). Replies stream live to the
// browser as synthesised Claude-shaped stream events.
function startCodexTurn(convoId, msg, agentData) {
  // A new user message supersedes a still-running turn: interrupt it and
  // continue on the same thread once the slot frees (one active turn per
  // thread). Mirrors the Claude path's stale-entry handling. The shared
  // app-server itself is never killed here.
  //
  // No kill-window buffer (convoTransitions) is needed on this path: unlike
  // the Claude runtime, where a follow-up could be written into a dying
  // process's stdin, the new message here is captured by THIS turn's closure
  // and only sent to the app-server after the bounded _turnEnd wait below,
  // so it is never lost. Pinned by test/integration/codex-chat.test.js
  // ("a new user message while a codex turn is running supersedes it").
  const existing = deps.chatProcesses().get(convoId);
  let priorTurnEnd = null;
  if (existing && !existing.exited) {
    existing.superseded = true;
    if (existing.interrupt) {
      existing.interrupt();
      priorTurnEnd = existing._turnEnd || null;
    } else if (existing.process) {
      try { deps.killProcessTree(existing.process); } catch (e) { /* already dead */ }
    }
    deps.chatProcesses().delete(convoId);
  }

  // Normalise once: an invalid session id (hostile client, corrupted
  // persistence) must produce a FULL fresh turn, instructions included,
  // never a resume-shaped prompt on a fresh thread.
  const resumeThreadId = codexRuntime.isValidThreadId(msg.sessionId) ? msg.sessionId : null;
  const processId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  console.log(`[Codex] convo=${convoId} proc=${processId} agent=${agentData.id} ${resumeThreadId ? `resume=${resumeThreadId}` : 'new thread'} model=${agentData.model || '(codex default)'}`);

  const entry = {
    runtime: 'codex', processId, agentId: agentData.id,
    responseText: '', exited: false, resultSent: false, errorSent: false,
    doneSent: false, superseded: false, usage: null,
    sessionId: resumeThreadId, lastUserMessage: msg.content,
    toolCalls: [], turnStartTime: Date.now(),
    subscription: null,
  };
  makeCodexEntryControls(entry);
  deps.chatProcesses().set(convoId, entry);

  deps.safeSend(JSON.stringify({
    type: 'system', subtype: 'process_started',
    _agent: agentData.id, _conversationId: convoId, _processId: processId,
  }));
  // Heartbeat from the moment the client shows "working": thread opening
  // (resume can be slow) counts as silence too.
  startCodexTurnKeepalive(entry, convoId);

  (async () => {
    // Bounded wait for the superseded turn to actually end: the server
    // allows one active turn per thread, so starting before the interrupt
    // lands would fail. The timeout keeps a wedged turn from blocking the
    // user's new message forever.
    if (priorTurnEnd) {
      await Promise.race([priorTurnEnd, new Promise(r => setTimeout(r, 2000))]);
    }
    const opened = await openCodexThread(entry, convoId, resumeThreadId, agentData.model);
    if (!opened) return;
    const { server, threadId } = opened;
    // Prompt composition, same as exec mode: first turns carry identity
    // (the agent file body) plus the platform rules; Claude gets these via
    // --agent and --append-system-prompt, which Codex does not support.
    // Decided on opened.resumed, NOT resumeThreadId: an expired session
    // falls back to a fresh thread inside openCodexThread, and a fresh
    // thread must never receive a resume-shaped prompt (it would lose the
    // agent's identity).
    const prompt = opened.resumed
      ? msg.content
      : [readAgentInstructions(agentData), buildSystemPrompt(agentData), msg.content].filter(Boolean).join('\n\n');
    entry._turnThreadId = threadId;
    const sub = server.startTurn(threadId, prompt);
    entry.subscription = sub;
    sub.on('event', (ev) => {
      try {
        handleCodexChatEvent(entry, convoId, ev);
      } catch (e) {
        console.error(`[Codex] convo=${convoId} event handling failed:`, e);
      }
    });
  })().catch((err) => handleCodexTurnStartFailure(entry, convoId, err));
}

function handleCodexChatEvent(entry, convoId, ev) {
  switch (ev.type) {
    case 'delta':
      // Forward as the synthesised Claude-shaped stream event: the client's
      // handleStreamEvent consumes it unchanged, and the authoritative full
      // text still arrives via the 'text' event (never double-counted into
      // responseText). Deltas cover STREAMING turns only; silent stretches
      // (reasoning, long tools) are covered by the keepalive heartbeat
      // (startCodexTurnKeepalive), which the client treats as activity.
      if (!entry.superseded && !entry.cancelled) {
        deps.safeSend(JSON.stringify({
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ev.text } },
          _agent: entry.agentId, _conversationId: convoId, _processId: entry.processId,
        }));
      }
      return;
    case 'text':
      // Belt and braces for Finding 7: the protocol client routes events by
      // turnId and a finished subscription emits nothing, so text after this
      // entry's done can only be leakage from a superseded turn. Never
      // accumulate it into a turn that has already delivered its result.
      if (entry.exited) return;
      // Authoritative full item text; items join with a blank-free newline,
      // matching the exec-era text-event behaviour.
      entry.responseText = entry.responseText ? entry.responseText + '\n' + ev.text : ev.text;
      return;
    case 'usage':
      entry.usage = ev.usage;
      return;
    case 'approval':
      handleCodexApproval(entry, convoId, ev);
      return;
    case 'error':
      if (ev.willRetry) {
        console.log(`[Codex] convo=${convoId} transient error (retrying): ${ev.message}`);
        return;
      }
      if (!entry.superseded && !entry.cancelled && isCodexTurnBusy(ev)) {
        // The SERVER rejected turn/start because the previous turn is still
        // active there (Finding 6 Mode 2: its state is authoritative even
        // after the local failsafe freed the slot). Retryable notice, not
        // an error card; the following done event closes the turn cleanly.
        console.log(`[Codex] convo=${convoId} turn rejected, previous turn still active server-side: ${ev.message}`);
        sendCodexBusyNotice(entry, convoId);
        return;
      }
      if (!entry.superseded && !entry.cancelled) sendCodexError(entry, convoId, ev.message, ev.kind);
      return;
    case 'done': {
      entry.exited = true;
      entry._turnThreadId = null;
      stopCodexTurnKeepalive(entry);
      if (entry._turnEndResolve) entry._turnEndResolve();
      if (deps.chatProcesses().get(convoId) === entry) {
        deps.chatProcesses().delete(convoId);
        // Close any kill-window transition this entry owned (an interrupt
        // driven by end_delegation): buffered messages replay into a fresh
        // turn. Codex entries have no process close event to do this from.
        deps.endConvoTransition(convoId, entry);
      }
      if (entry.superseded) return; // a newer turn took over; stay silent
      if (entry.cancelled) return;  // cancel handler already sent cancelled + done
      if (ev.status === 'completed') {
        finishCodexTurn(entry, convoId);
      } else if (ev.status === 'failed') {
        if (entry.busyNoticeSent) {
          // Busy is retryable, not a failure: close with a NORMAL done so
          // the conversation stays healthy for the resend.
          sendCodexDone(entry, convoId, 0);
          return;
        }
        if (!entry.errorSent) {
          sendCodexError(entry, convoId, (ev.error && ev.error.message) || 'Codex turn failed');
        }
        sendCodexDone(entry, convoId, -1);
      } else {
        // Interrupted without a user cancel (e.g. runtime shutdown): just
        // unblock the client.
        sendCodexDone(entry, convoId, null);
      }
      return;
    }
  }
}

// The root's synchronous 'exit' handler must be able to SIGKILL a shared
// app-server that is still draining its graceful SIGTERM; the pid is
// module-owned state, so it travels out through this accessor (a primitive
// cannot be re-exported by identity).
function getCodexAppServerPid() {
  return _codexAppServerPid;
}

module.exports = {
  wireCodexGlueDeps,
  getCodexAppServer,
  waitForCodexReady,
  shutdownCodexAppServer,
  getCodexAppServerPid,
  readAgentInstructions,
  wireCodexDelegate,
  startCodexTurn,
};
