'use strict';
// Codex app-server protocol fixtures (JSONL JSON-RPC 2.0 over stdio).
//
// Shapes mirror docs/protocol/codex-app-server/RESEARCH.md, captured live
// against codex-cli 0.144.3. Server-to-client messages deliberately OMIT the
// `jsonrpc` field: the real server does this by design (RESEARCH.md section
// 1) and clients must tolerate it, so the stub reproduces it and a test pins
// it. These fixtures are the single source of truth for both the stub codex
// binary's app-server mode and the codex-appserver client unit tests, so the
// client and the harness can never drift apart (the codex-jsonl.js
// precedent). Validate against a real `codex app-server` when changing them.

function nowSeconds() { return Math.floor(Date.now() / 1000); }

// ── JSON-RPC envelopes ──────────────────────────────────────────────────────

function response(id, result) {
  return { id, result };
}

function errorResponse(id, code, message) {
  return { id, error: { code, message } };
}

// Overload rejection (RESEARCH.md section 1): clients back off with jitter.
function overloadErrorResponse(id) {
  return errorResponse(id, -32001, 'Server overloaded; retry later.');
}

// Unknown-method rejection (RESEARCH.md section 7): the message enumerates
// the supported methods, which real clients can use as a capability probe.
function unknownMethodError(id, method) {
  return errorResponse(id, -32600,
    `Invalid request: unknown variant \`${method}\`, expected one of \`initialize\`, \`thread/start\`, \`thread/resume\`, \`turn/start\`, \`turn/interrupt\``);
}

// ── Handshake (RESEARCH.md section 2) ───────────────────────────────────────

// The only version signal the protocol offers is the server version embedded
// in userAgent, right after the client name.
function initializeResult(clientName, clientVersion, serverVersion) {
  return {
    userAgent: `${clientName}/${serverVersion} (Stub OS 1.0; test) StubTerm/1 (${clientName}; ${clientVersion})`,
    codexHome: '/stub/.codex',
    platformFamily: 'unix',
    platformOs: 'stub',
  };
}

// Pushed unprompted right after the initialized notification; clients must
// ignore unknown notifications (RESEARCH.md section 2).
function remoteControlStatusChanged() {
  return { method: 'remoteControl/status/changed', params: { enabled: false } };
}

// ── Thread lifecycle (RESEARCH.md section 3) ────────────────────────────────

function threadObject(threadId, params = {}) {
  return {
    id: threadId,
    sessionId: threadId,
    status: { type: 'idle' },
    path: `/stub/.codex/sessions/rollout-${threadId}.jsonl`,
    cwd: params.cwd || '/tmp/stub',
    cliVersion: '0.144.3',
    // Historical artefact: app-server-created threads record source "vscode"
    // in 0.144.3 (RESEARCH.md section 3, thread/list gotcha).
    source: 'vscode',
    turns: [],
  };
}

// thread/start and thread/resume responses echo the effective settings.
function threadStartResult(threadId, params = {}) {
  return {
    thread: threadObject(threadId, params),
    model: params.model || 'gpt-5.6-sol',
    modelProvider: 'openai',
    cwd: params.cwd || '/tmp/stub',
    runtimeWorkspaceRoots: [params.cwd || '/tmp/stub'],
    approvalPolicy: params.approvalPolicy || 'on-request',
    approvalsReviewer: params.approvalsReviewer || 'user',
    sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
    reasoningEffort: null,
  };
}

function threadStartedNotification(threadId, params = {}) {
  return { method: 'thread/started', params: { thread: threadObject(threadId, params) } };
}

// ── Turn lifecycle (RESEARCH.md sections 3 and 4) ───────────────────────────

function turnObject(turnId, status = 'inProgress', error = null) {
  return {
    id: turnId,
    items: [],
    itemsView: 'notLoaded',
    status,
    error,
    startedAt: nowSeconds(),
  };
}

function turnStartResult(turnId) {
  return { turn: turnObject(turnId) };
}

function threadStatusChanged(threadId, statusType) {
  const status = statusType === 'active' ? { type: 'active', activeFlags: [] } : { type: statusType };
  return { method: 'thread/status/changed', params: { threadId, status } };
}

function turnStarted(threadId, turnId) {
  return { method: 'turn/started', params: { threadId, turn: turnObject(turnId) } };
}

function itemStartedUserMessage(threadId, turnId, itemId, text) {
  return {
    method: 'item/started',
    params: {
      item: { type: 'userMessage', id: itemId, content: [{ type: 'text', text, text_elements: [] }] },
      threadId, turnId, startedAtMs: Date.now(),
    },
  };
}

function itemCompletedUserMessage(threadId, turnId, itemId, text) {
  return {
    method: 'item/completed',
    params: {
      item: { type: 'userMessage', id: itemId, content: [{ type: 'text', text, text_elements: [] }] },
      threadId, turnId, completedAtMs: Date.now(),
    },
  };
}

function itemStartedAgentMessage(threadId, turnId, itemId) {
  return {
    method: 'item/started',
    params: {
      item: { type: 'agentMessage', id: itemId, text: '', phase: 'final_answer', memoryCitation: null },
      threadId, turnId, startedAtMs: Date.now(),
    },
  };
}

// Exact delta shape (RESEARCH.md section 4): all four fields required.
function agentMessageDelta(threadId, turnId, itemId, delta) {
  return { method: 'item/agentMessage/delta', params: { threadId, turnId, itemId, delta } };
}

// The completed item carries the full accumulated text (authoritative).
function itemCompletedAgentMessage(threadId, turnId, itemId, text) {
  return {
    method: 'item/completed',
    params: {
      item: { type: 'agentMessage', id: itemId, text, phase: 'final_answer', memoryCitation: null },
      threadId, turnId, completedAtMs: Date.now(),
    },
  };
}

function itemStartedCommandExecution(threadId, turnId, itemId, command) {
  return {
    method: 'item/started',
    params: {
      item: { type: 'commandExecution', id: itemId, command, cwd: '/tmp/stub', status: 'inProgress' },
      threadId, turnId, startedAtMs: Date.now(),
    },
  };
}

function itemStartedFileChange(threadId, turnId, itemId) {
  return {
    method: 'item/started',
    params: {
      item: { type: 'fileChange', id: itemId, changes: [], status: 'inProgress' },
      threadId, turnId, startedAtMs: Date.now(),
    },
  };
}

// ── Usage and completion (RESEARCH.md section 6) ────────────────────────────

// Token usage rides its own notification and arrives BEFORE turn/completed;
// clients buffer it per turnId. Defaults (100 in / 0 cached / 50 out) are
// the suite's baseline numbers.
function tokenUsageUpdated(threadId, turnId, usage = {}) {
  const last = {
    inputTokens: usage.inputTokens ?? 100,
    cachedInputTokens: usage.cachedInputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 50,
    reasoningOutputTokens: usage.reasoningOutputTokens ?? 0,
  };
  last.totalTokens = last.inputTokens + last.outputTokens;
  return {
    method: 'thread/tokenUsage/updated',
    params: { threadId, turnId, tokenUsage: { total: { ...last }, last, modelContextWindow: 258400 } },
  };
}

// Follows each turn in the real protocol; carries plan-level quota. The
// client ignores it in slices 1+2, so its presence doubles as an
// unknown-notification tolerance check.
function accountRateLimitsUpdated() {
  return {
    method: 'account/rateLimits/updated',
    params: {
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: nowSeconds() + 3600 },
        planType: 'plus',
      },
    },
  };
}

// status: 'completed' | 'interrupted' | 'failed'; error only when failed.
function turnCompleted(threadId, turnId, status = 'completed', error = null) {
  const turn = turnObject(turnId, status, error);
  turn.completedAt = nowSeconds();
  turn.durationMs = 100;
  return { method: 'turn/completed', params: { threadId, turn } };
}

// ── Turn errors (RESEARCH.md section 7) ─────────────────────────────────────

// { message, codexErrorInfo, willRetry }; willRetry true means the server is
// retrying internally and the turn is not dead yet.
function errorNotification(threadId, turnId, { message, codexErrorInfo = null, willRetry = false } = {}) {
  return {
    method: 'error',
    params: {
      threadId, turnId, willRetry,
      error: { message: message || 'stub turn error', additionalDetails: null, codexErrorInfo },
    },
  };
}

// ── Approvals: server-to-client requests (RESEARCH.md section 5) ────────────

// These carry a JSON-RPC id; the client MUST answer or the turn hangs.
function commandApprovalRequest(id, { threadId, turnId, itemId, command, reason = null } = {}) {
  return {
    id,
    method: 'item/commandExecution/requestApproval',
    params: {
      threadId, turnId, itemId,
      approvalId: null, command, commandActions: null, cwd: null, reason,
      environmentId: null, networkApprovalContext: null,
      proposedExecpolicyAmendment: null, proposedNetworkPolicyAmendments: null,
      startedAtMs: Date.now(),
    },
  };
}

function fileChangeApprovalRequest(id, { threadId, turnId, itemId, grantRoot = null, reason = null } = {}) {
  return {
    id,
    method: 'item/fileChange/requestApproval',
    params: { threadId, turnId, itemId, grantRoot, reason, startedAtMs: Date.now() },
  };
}

// ── Captured failure texts ──────────────────────────────────────────────────

// The quota-exhaustion message the CLI emits when a ChatGPT plan's Codex
// allowance is used up. Wording varies; the classifier keys on "usage limit".
const QUOTA_MESSAGE = "You've hit your usage limit. Try again at 3pm.";

module.exports = {
  QUOTA_MESSAGE,
  response, errorResponse, overloadErrorResponse, unknownMethodError,
  initializeResult, remoteControlStatusChanged,
  threadObject, threadStartResult, threadStartedNotification,
  turnObject, turnStartResult, threadStatusChanged, turnStarted,
  itemStartedUserMessage, itemCompletedUserMessage,
  itemStartedAgentMessage, agentMessageDelta, itemCompletedAgentMessage,
  itemStartedCommandExecution, itemStartedFileChange,
  tokenUsageUpdated, accountRateLimitsUpdated, turnCompleted,
  errorNotification, commandApprovalRequest, fileChangeApprovalRequest,
};
