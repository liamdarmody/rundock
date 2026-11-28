'use strict';
// ONE USE OF ONE COMMAND OUTSIDE THE SANDBOX, FOR A CARD A PERSON APPROVED.
//
// A Bash or PowerShell call with `dangerouslyDisableSandbox: true` raises a
// card, and the hook answers allow when the person approves it. Claude Code
// then asks a question of its own that a PreToolUse allow does not answer:
// only a PermissionRequest hook answering allow does. The click records a
// grant here (lib/protocol/handlers/process-control.js, its only writer), and
// the hook's PermissionRequest branch spends it through one route
// (POST /api/sandbox-grant in lib/http-router.js), which never records one.
//
// A grant is keyed by the conversation and agent the card was raised for, the
// tool and the exact command, with the flag exactly true, and lives for
// GRANT_WINDOW_MS. Identical approvals stack, one use each. Approvals are kept
// apart from grants, spent or not, for the same window, so a refusal that
// follows an approval can be told from any other. Everything is in this
// process's memory only: a restart drops it, and the call is refused as it
// was before.

const GRANT_WINDOW_MS = 60000;
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

// The clock, patched in-process by tests.
const seams = { now: () => Date.now() };

// key -> the times each unspent grant was recorded.
const grants = new Map();
// key -> the times each approval was recorded, spent or not.
const approvals = new Map();

function keyOf(grant) {
  if (!grant || typeof grant !== 'object') return null;
  const { conversationId, agentId, toolName, toolInput } = grant;
  if (typeof conversationId !== 'string' || !conversationId) return null;
  if (typeof agentId !== 'string' || !agentId) return null;
  if (!SHELL_TOOLS.has(toolName)) return null;
  if (!toolInput || typeof toolInput !== 'object' || toolInput.dangerouslyDisableSandbox !== true) return null;
  const command = toolInput.command;
  if (typeof command !== 'string' || !command) return null;
  return JSON.stringify([conversationId, agentId, toolName, command]);
}

function live(at, now) {
  return now - at < GRANT_WINDOW_MS;
}

function prune(now) {
  for (const map of [grants, approvals]) {
    for (const [key, times] of map) {
      const kept = times.filter((at) => live(at, now));
      if (kept.length) map.set(key, kept);
      else map.delete(key);
    }
  }
}

function recordGrant(grant) {
  const key = keyOf(grant);
  if (!key) return false;
  const now = seams.now();
  prune(now);
  for (const map of [grants, approvals]) map.set(key, [...(map.get(key) || []), now]);
  return true;
}

function spendGrant(grant) {
  const key = keyOf(grant);
  prune(seams.now());
  const times = key ? grants.get(key) : null;
  if (!times) return false;
  times.shift();
  if (!times.length) grants.delete(key);
  return true;
}

function wasApproved(grant) {
  const key = keyOf(grant);
  const now = seams.now();
  return !!key && (approvals.get(key) || []).some((at) => live(at, now));
}

module.exports = { GRANT_WINDOW_MS, recordGrant, spendGrant, wasApproved, seams };
