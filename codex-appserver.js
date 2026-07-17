'use strict';
// Codex app-server protocol client and process supervisor.
//
// R10 replaces per-turn `codex exec --json` spawns with ONE long-lived
// `codex app-server` process speaking JSONL JSON-RPC 2.0 over stdio, serving
// many threads concurrently. This module owns everything protocol-level:
// spawn, handshake, restart, the wire reader and writer, request
// correlation, approval plumbing, and the normalised turn event surface the
// runtime consumes. Spec of record: docs/protocol/codex-app-server/
// RESEARCH.md (section numbers referenced throughout), verified live
// against codex-cli 0.144.3.
//
// Policy invariants (do not weaken; pinned by test):
//   - `danger-full-access` (and the per-turn `dangerFullAccess` sandbox
//     policy object) is NEVER sent. The sandbox stays workspace-write or
//     tighter, exactly like exec mode (see codex.js).
//   - approvalPolicy is never DEFAULTED to 'never': callers must opt in
//     explicitly. Under 'never', sandbox-blocked actions silently fail
//     instead of asking (RESEARCH.md section 5).
//   - approvalsReviewer is always 'user': approval requests must reach
//     Rundock, never an auto-review subagent.
//   - capabilities.experimentalApi is always false: Rundock stays on the
//     stable protocol surface (RESEARCH.md section 10).
//
// Wire rules (RESEARCH.md section 1): one JSON object per line; the server
// omits the `jsonrpc` field on everything it sends (by design; never
// require it); unknown notifications and unknown fields are ignored;
// malformed lines are logged and skipped, never thrown on; -32001 responses
// mean overload and are retried with jittered backoff.
//
// Turn subscriptions (returned by startTurn) are EventEmitters that emit
// every normalised event on the single channel 'event' (never the
// EventEmitter 'error' channel, which throws when unhandled):
//   { type:'delta', text }                            streamed agent text
//   { type:'text', text }                             authoritative full text
//   { type:'usage', usage }                           this turn's token usage
//   { type:'approval', kind, requestId, params, respond(decision) }
//   { type:'error', message, kind, willRetry }
//   { type:'done', status, usage, error }             terminal, exactly once

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');

const { classifyCodexError, resolveCodexBin } = require('./codex.js');

let PKG_VERSION = '0.0.0';
try { PKG_VERSION = require('./package.json').version || PKG_VERSION; } catch (e) { /* packaged builds carry package.json */ }

// ── Normalisation helpers ───────────────────────────────────────────────────

// Map the protocol's codexErrorInfo (RESEARCH.md section 7) onto Rundock's
// error kinds. badRequest is only a model problem when the message carries
// the CLI's model-unavailability wording (classifyCodexError owns that
// pattern); other bad requests stay 'unknown' so they surface verbatim.
// Object-form variants (httpConnectionFailed etc) also fall to 'unknown'.
function normalizeErrorKind(codexErrorInfo, message) {
  switch (codexErrorInfo) {
    case 'unauthorized': return 'auth';
    case 'usageLimitExceeded':
    case 'sessionBudgetExceeded': return 'quota';
    case 'contextWindowExceeded': return 'context';
    case 'badRequest':
      return classifyCodexError(message || '').kind === 'model' ? 'model' : 'unknown';
    default:
      return 'unknown';
  }
}

// tokenUsage.last -> the flat usage object the runtime consumes. Usage rides
// its own notification and arrives BEFORE turn/completed (RESEARCH.md
// section 6), so it is buffered per turn and attached to the done event.
function normalizeUsage(last) {
  const u = last || {};
  return {
    inputTokens: u.inputTokens || 0,
    cachedInputTokens: u.cachedInputTokens || 0,
    outputTokens: u.outputTokens || 0,
    reasoningOutputTokens: u.reasoningOutputTokens || 0,
  };
}

// The only version signal the protocol offers (RESEARCH.md section 2):
// userAgent is "<clientName>/<serverVersion> (OS ...) ...".
function parseUserAgentVersion(userAgent) {
  const m = /^[^/\s]+\/(\S+)/.exec(String(userAgent || ''));
  return m ? m[1] : null;
}

// Slices 1+2 support the four plain string decisions; the object forms
// (execpolicy/network amendments) come later if ever needed.
const APPROVAL_DECISIONS = new Set(['accept', 'acceptForSession', 'decline', 'cancel']);

// Whitelisted params, mirroring codex.js's whitelist philosophy: nothing the
// caller sends reaches the wire unless it is a known, safe key.
const THREAD_OPT_KEYS = ['cwd', 'model', 'sandbox', 'approvalPolicy', 'config', 'baseInstructions', 'developerInstructions', 'ephemeral'];
const TURN_OPT_KEYS = ['model', 'cwd', 'effort', 'summary', 'approvalPolicy', 'sandboxPolicy', 'outputSchema', 'clientUserMessageId'];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Client ──────────────────────────────────────────────────────────────────

class CodexAppServer extends EventEmitter {
  constructor(opts = {}) {
    super();
    this._binPath = opts.binPath || resolveCodexBin();
    this._spawnCwd = opts.cwd || process.cwd();
    this._spawnEnv = opts.env || process.env;
    this._clientName = opts.clientName || 'rundock';
    this._clientVersion = opts.clientVersion || PKG_VERSION;
    this._requestTimeoutMs = opts.requestTimeoutMs ?? 30000;
    this._approvalTimeoutMs = opts.approvalTimeoutMs ?? 120000;
    const or = opts.overloadRetry || {};
    this._overloadAttempts = or.attempts ?? 3;
    this._overloadBaseMs = or.baseMs ?? 250;
    this._overloadMaxMs = or.maxMs ?? 2000;
    const rb = opts.restartBackoff || {};
    this._restartBaseMs = rb.baseMs ?? 500;
    this._restartMaxMs = rb.maxMs ?? 30000;
    this._shutdownGraceMs = opts.shutdownGraceMs ?? 3000;
    this._log = typeof opts.log === 'function' ? opts.log : () => {};

    this._proc = null;
    this._ready = false;
    this._everReady = false;
    this._closing = false;
    this._version = null;
    this._nextId = 1;
    this._pending = new Map();     // request id -> { method, resolve, reject, timer }
    this._activeTurns = new Map(); // threadId -> turn state (one active turn per thread)
    this._restartAttempt = 0;
    this._restartTimer = null;
    this._readBuffer = '';
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  // Spawn and handshake. Readiness = the initialize response (RESEARCH.md
  // section 2). Rejects if the process cannot come up; a client that never
  // reached ready does not auto-restart (that is a configuration error, not
  // a crash).
  async start() {
    if (this._closing) throw new Error('codex app-server client has been shut down');
    if (this._proc) throw new Error('codex app-server already started');
    await this._boot();
  }

  isReady() { return this._ready; }
  version() { return this._version; }

  // Clean shutdown: interrupt any active turns so the server can end them,
  // then SIGTERM, escalating to SIGKILL after the grace period. Disables
  // auto-restart permanently.
  async shutdown() {
    this._closing = true;
    if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null; }
    const proc = this._proc;
    if (!proc) return;
    const interrupts = [];
    for (const [threadId, state] of this._activeTurns) {
      if (state.turnId != null) {
        interrupts.push(
          this._rawRequest('turn/interrupt', { threadId, turnId: state.turnId },
            { timeoutMs: Math.min(this._shutdownGraceMs, 1000) }).catch(() => {})
        );
      }
    }
    if (interrupts.length) {
      await Promise.all(interrupts);
      // The interrupt RESPONSE races the server's follow-up turn/completed
      // notification (separate writes on the same pipe): signalling now can
      // kill the process before that line is flushed and the turn would
      // surface as failed instead of interrupted. Wait, bounded, for the
      // interrupted turns to actually finish before terminating.
      const deadline = Date.now() + Math.min(this._shutdownGraceMs, 1000);
      while (this._activeTurns.size > 0 && this._proc === proc && Date.now() < deadline) {
        await sleep(5);
      }
    }
    if (this._proc !== proc) return; // died while interrupting; exit handled
    const exited = new Promise(resolve => {
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
      proc.once('close', resolve);
    });
    try { proc.kill('SIGTERM'); } catch (e) { /* already gone */ }
    const killTimer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (e) { /* already gone */ }
    }, this._shutdownGraceMs);
    await exited;
    clearTimeout(killTimer);
  }

  _spawn() {
    const proc = spawn(this._binPath, ['app-server'], {
      cwd: this._spawnCwd,
      env: this._spawnEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this._proc = proc;
    this._readBuffer = '';
    proc.stdout.setEncoding('utf-8');
    proc.stdout.on('data', chunk => { if (this._proc === proc) this._onData(chunk); });
    proc.stderr.setEncoding('utf-8');
    proc.stderr.on('data', chunk => this._log(`codex app-server stderr: ${String(chunk).trim()}`));
    // 'error' (spawn failure) and 'close' can both fire; collapse to one.
    // 'close' rather than 'exit': it waits for stdio to drain, so lines the
    // server wrote just before dying (e.g. turn/completed after an
    // interrupt) are still parsed before in-flight turns are failed.
    let gone = false;
    const onGone = (code, signal) => {
      if (gone) return;
      gone = true;
      if (this._proc === proc) this._onExit(code, signal);
    };
    proc.on('close', onGone);
    proc.on('error', err => {
      this._log(`codex app-server spawn error: ${err.message}`);
      onGone(-1, null);
    });
  }

  async _boot() {
    this._spawn();
    // Handshake: exactly one initialize request, then the initialized
    // notification (RESEARCH.md section 2).
    const result = await this._rawRequest('initialize', {
      clientInfo: { name: this._clientName, title: 'Rundock', version: this._clientVersion },
      // Invariant: never opt into the experimental surface (section 10).
      capabilities: { experimentalApi: false },
    }, { beforeReady: true });
    this._version = parseUserAgentVersion(result && result.userAgent);
    this._writeLine({ jsonrpc: '2.0', method: 'initialized' });
    this._ready = true;
    this._everReady = true;
    this._restartAttempt = 0;
    this.emit('ready', { version: this._version });
  }

  _onExit(code, signal) {
    this._proc = null;
    this._ready = false;
    // In-flight requests can never complete: reject them now.
    for (const [, pending] of this._pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`codex app-server exited before responding to ${pending.method}`));
    }
    this._pending.clear();
    // In-flight turns are gone with the process. Thread state lives on disk
    // (RESEARCH.md section 3) so the THREAD survives, but the turn itself is
    // unrecoverable: surface it as an error.
    for (const [, state] of this._activeTurns) {
      for (const [, approval] of state.approvals) clearTimeout(approval.timer);
      state.approvals.clear();
      this._emitTurnEvent(state, { type: 'error', message: 'codex app-server exited mid-turn', kind: 'unknown', willRetry: false });
      state.finished = true;
      state.sub.emit('event', { type: 'done', status: 'failed', usage: state.usage, error: { message: 'codex app-server exited mid-turn' } });
    }
    this._activeTurns.clear();
    this.emit('exit', { code, signal, intentional: this._closing });
    if (!this._closing && this._everReady) this._scheduleRestart();
  }

  // Capped exponential backoff; the attempt counter resets on 'ready'.
  _scheduleRestart() {
    this._restartAttempt += 1;
    const delayMs = Math.min(this._restartBaseMs * 2 ** (this._restartAttempt - 1), this._restartMaxMs);
    this.emit('restart', { attempt: this._restartAttempt, delayMs });
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      if (this._closing) return;
      // A failed boot exits (or never starts) the child; _onExit schedules
      // the next attempt, so the error only needs logging here.
      this._boot().catch(err => this._log(`codex app-server restart failed: ${err.message}`));
    }, delayMs);
  }

  // ── Wire ──────────────────────────────────────────────────────────────────

  // Line-atomic writer: one write() call per message (JSON + newline), so
  // callers can never interleave partial lines on the pipe. Returns false
  // instead of throwing when the process is gone.
  _writeLine(obj) {
    const proc = this._proc;
    if (!proc || !proc.stdin || proc.stdin.destroyed || !proc.stdin.writable) return false;
    try {
      proc.stdin.write(JSON.stringify(obj) + '\n');
      return true;
    } catch (e) {
      this._log(`codex app-server write failed: ${e.message}`);
      return false;
    }
  }

  _onData(chunk) {
    this._readBuffer += chunk;
    let idx;
    while ((idx = this._readBuffer.indexOf('\n')) >= 0) {
      const line = this._readBuffer.slice(0, idx);
      this._readBuffer = this._readBuffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      // Malformed lines: log and skip, never throw (RESEARCH.md section 10).
      try { msg = JSON.parse(line); } catch (e) {
        this._log(`codex app-server: skipping malformed line: ${line.slice(0, 200)}`);
        continue;
      }
      if (!msg || typeof msg !== 'object') continue;
      try { this._dispatch(msg); } catch (e) {
        this._log(`codex app-server: dispatch failed: ${e.message}`);
      }
    }
  }

  // The server omits `jsonrpc` on everything it sends (section 1): classify
  // by the fields present, never by strict JSON-RPC validation.
  _dispatch(msg) {
    if (typeof msg.method === 'string') {
      if (msg.id !== undefined && msg.id !== null) this._onServerRequest(msg);
      else this._onNotification(msg.method, msg.params || {});
    } else if (msg.id !== undefined && msg.id !== null) {
      this._onResponse(msg);
    }
  }

  // ── Requests (client to server) ───────────────────────────────────────────

  _rawRequest(method, params, { beforeReady = false, timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      if (!beforeReady && !this._ready) {
        return reject(new Error(`codex app-server not ready (request ${method})`));
      }
      const id = this._nextId++;
      const limit = timeoutMs ?? this._requestTimeoutMs;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`codex app-server request timed out after ${limit}ms: ${method}`));
      }, limit);
      this._pending.set(id, { method, resolve, reject, timer });
      if (!this._writeLine({ jsonrpc: '2.0', id, method, params })) {
        this._pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`codex app-server not writable (request ${method})`));
      }
    });
  }

  // Correlated request with overload handling: -32001 responses retry with
  // jittered exponential backoff, bounded attempts (RESEARCH.md section 1).
  async request(method, params, reqOpts = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this._rawRequest(method, params, reqOpts);
      } catch (err) {
        if (err && err.code === -32001 && attempt < this._overloadAttempts && !this._closing) {
          const cap = Math.min(this._overloadBaseMs * 2 ** attempt, this._overloadMaxMs);
          await sleep(cap / 2 + Math.random() * (cap / 2));
          continue;
        }
        throw err;
      }
    }
  }

  _onResponse(msg) {
    const pending = this._pending.get(msg.id);
    if (!pending) return; // late reply after a timeout: ignore
    this._pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) {
      const err = new Error(`codex app-server ${pending.method} failed: ${msg.error.message || 'unknown error'}`);
      err.code = msg.error.code;
      err.data = msg.error.data;
      pending.reject(err);
    } else {
      pending.resolve(msg.result);
    }
  }

  // ── Threads ───────────────────────────────────────────────────────────────

  _sanitizeThreadParams(opts = {}) {
    if (opts.sandbox === 'danger-full-access') {
      throw new Error('refusing to pass danger-full-access: the sandbox invariant is never weakened');
    }
    const params = {};
    for (const key of THREAD_OPT_KEYS) {
      if (opts[key] !== undefined) params[key] = opts[key];
    }
    // Invariant: approvals always come to Rundock, never an auto-reviewer.
    // Note approvalPolicy is only ever a pass-through above: 'never' must be
    // an explicit caller choice, not a default.
    params.approvalsReviewer = 'user';
    return params;
  }

  async startThread(opts = {}) {
    const result = await this.request('thread/start', this._sanitizeThreadParams(opts));
    return { threadId: result.thread.id };
  }

  async resumeThread(threadId, overrides = {}) {
    const params = this._sanitizeThreadParams(overrides);
    params.threadId = threadId;
    const result = await this.request('thread/resume', params);
    return { threadId: result.thread.id };
  }

  // ── Turns ─────────────────────────────────────────────────────────────────

  // Start a turn and return its subscription (an EventEmitter emitting the
  // normalised events documented at the top of this file on the 'event'
  // channel). Also exposed: sub.threadId, sub.turnId (populated once known)
  // and sub.started (a promise resolving to { turnId }).
  startTurn(threadId, inputText, perTurnOpts = {}) {
    if (typeof inputText !== 'string') throw new TypeError('inputText must be a string');
    if (this._activeTurns.has(threadId)) {
      // The server enforces one active turn per thread (RESEARCH.md section
      // 9); failing fast here keeps the error synchronous and the wire clean.
      throw new Error(`a turn is already active on thread ${threadId}`);
    }
    const sp = perTurnOpts.sandboxPolicy;
    if (sp && sp.type === 'dangerFullAccess') {
      throw new Error('refusing to pass dangerFullAccess: the sandbox invariant is never weakened');
    }
    const params = { threadId, input: [{ type: 'text', text: inputText }] };
    for (const key of TURN_OPT_KEYS) {
      if (perTurnOpts[key] !== undefined) params[key] = perTurnOpts[key];
    }

    const sub = new EventEmitter();
    sub.threadId = threadId;
    sub.turnId = null;
    const state = {
      threadId,
      sub,
      turnId: null,
      usage: null,             // buffered from thread/tokenUsage/updated (section 6)
      agentItemIds: new Set(), // delta guard: only items announced as agentMessage
      approvals: new Map(),    // server request id -> { timer, respond }
      finished: false,
      startedPromise: null,
    };
    this._activeTurns.set(threadId, state);

    state.startedPromise = this.request('turn/start', params).then(result => {
      if (state.turnId == null) state.turnId = result.turn.id;
      sub.turnId = state.turnId;
      return { turnId: state.turnId };
    });
    sub.started = state.startedPromise;
    // If turn/start itself fails the turn never existed server-side; the
    // catch below also marks the promise handled for callers who ignore it.
    state.startedPromise.catch(err => {
      if (this._activeTurns.get(threadId) === state) this._activeTurns.delete(threadId);
      this._emitTurnEvent(state, { type: 'error', message: err.message, kind: 'unknown', willRetry: false });
      this._finishTurn(state, { status: 'failed', error: { message: err.message } });
    });
    return sub;
  }

  // Interrupt a turn. turnId is tracked internally from the turn/start
  // response; passing it explicitly is optional.
  async interruptTurn(threadId, turnId) {
    let id = turnId;
    const state = this._activeTurns.get(threadId);
    if (id == null && state) {
      if (state.turnId == null && state.startedPromise) {
        try { await state.startedPromise; } catch (e) { /* turn/start failed */ }
      }
      id = state.turnId;
    }
    if (id == null) throw new Error(`no active turn to interrupt on thread ${threadId}`);
    return this.request('turn/interrupt', { threadId, turnId: id });
  }

  _emitTurnEvent(state, ev) {
    if (state.finished) return;
    state.sub.emit('event', ev);
  }

  // Terminal: emits done exactly once and releases the thread's active slot.
  _finishTurn(state, { status, error = null }) {
    if (state.finished) return;
    for (const [, approval] of state.approvals) {
      clearTimeout(approval.timer);
      // Unblock the server if an approval is still pending at turn end; a
      // decline for an already-resolved request is ignored server-side.
      try { approval.respond('decline'); } catch (e) { /* already answered */ }
    }
    state.approvals.clear();
    state.finished = true;
    if (this._activeTurns.get(state.threadId) === state) this._activeTurns.delete(state.threadId);
    state.sub.emit('event', { type: 'done', status, usage: state.usage, error: status === 'failed' ? error : null });
  }

  // ── Notifications (server to client) ─────────────────────────────────────

  // Demultiplexed strictly by threadId: one process serves many threads and
  // their notifications interleave on the same pipe (RESEARCH.md section 9).
  // Unknown methods are ignored by design (section 10).
  _onNotification(method, params) {
    if (!params || typeof params !== 'object') return;
    const state = params.threadId != null ? this._activeTurns.get(params.threadId) : null;
    switch (method) {
      case 'turn/started': {
        // Backup turnId source: the notification can beat the turn/start
        // response's promise resolution because both arrive on the same pipe.
        if (state && state.turnId == null && params.turn) {
          state.turnId = params.turn.id;
          state.sub.turnId = state.turnId;
        }
        return;
      }
      case 'item/started': {
        if (state && params.item && params.item.type === 'agentMessage') {
          state.agentItemIds.add(params.item.id);
        }
        return;
      }
      case 'item/agentMessage/delta': {
        // Guard by itemId: only stream deltas for items announced as
        // agentMessage (RESEARCH.md section 4); anything else is skipped.
        if (state && state.agentItemIds.has(params.itemId)) {
          this._emitTurnEvent(state, { type: 'delta', text: params.delta });
        }
        return;
      }
      case 'item/completed': {
        // The completed agentMessage carries the authoritative full text.
        if (state && params.item && params.item.type === 'agentMessage') {
          this._emitTurnEvent(state, { type: 'text', text: params.item.text || '' });
        }
        return;
      }
      case 'thread/tokenUsage/updated': {
        // Arrives BEFORE turn/completed; buffer per turn (section 6).
        if (state && (state.turnId == null || params.turnId == null || params.turnId === state.turnId)) {
          state.usage = normalizeUsage(params.tokenUsage && params.tokenUsage.last);
          this._emitTurnEvent(state, { type: 'usage', usage: state.usage });
        }
        return;
      }
      case 'error': {
        // Turn-level error stream (section 7). willRetry true means the
        // server is retrying internally: the turn is not terminal yet, so
        // only turn/completed ends it.
        if (!state) return;
        const e = params.error || {};
        this._emitTurnEvent(state, {
          type: 'error',
          message: e.message || 'Codex error',
          kind: normalizeErrorKind(e.codexErrorInfo, e.message),
          willRetry: !!params.willRetry,
        });
        return;
      }
      case 'turn/completed': {
        if (!state) return;
        const turn = params.turn || {};
        this._finishTurn(state, { status: turn.status || 'completed', error: turn.error || null });
        return;
      }
      default:
        return; // unknown notifications are expected and ignored
    }
  }

  // ── Server-to-client requests (approvals; RESEARCH.md section 5) ─────────

  _onServerRequest(msg) {
    const { id, method } = msg;
    const params = msg.params || {};
    const kind = method === 'item/commandExecution/requestApproval' ? 'command'
      : method === 'item/fileChange/requestApproval' ? 'fileChange'
        : null;
    if (!kind) {
      // Every server request MUST get a response or the turn blocks forever;
      // refusing unknown ones is the safe default.
      this._writeLine({ jsonrpc: '2.0', id, error: { code: -32601, message: `unsupported server request: ${method}` } });
      return;
    }
    const state = this._activeTurns.get(params.threadId);
    let answered = false;
    const respond = (decision) => {
      if (!APPROVAL_DECISIONS.has(decision)) {
        throw new Error(`invalid approval decision: ${decision} (accept | acceptForSession | decline | cancel)`);
      }
      if (answered) return false;
      answered = true;
      if (state) {
        const a = state.approvals.get(id);
        if (a) { clearTimeout(a.timer); state.approvals.delete(id); }
      }
      this._writeLine({ jsonrpc: '2.0', id, result: { decision } });
      return true;
    };
    // A turn can never hang forever on an unanswered approval: auto-decline
    // after the configured window. respond() cancels this timer.
    const timer = setTimeout(() => {
      try { respond('decline'); } catch (e) { /* unreachable: decline is valid */ }
    }, this._approvalTimeoutMs);
    if (timer.unref) timer.unref();
    if (!state) {
      // No turn to route this to (already finished or unknown thread):
      // decline immediately rather than leave the server blocked.
      clearTimeout(timer);
      respond('decline');
      return;
    }
    state.approvals.set(id, { timer, respond });
    this._emitTurnEvent(state, { type: 'approval', kind, requestId: id, params, respond });
  }
}

function createCodexAppServer(opts = {}) {
  return new CodexAppServer(opts);
}

module.exports = { createCodexAppServer, normalizeErrorKind, parseUserAgentVersion };
