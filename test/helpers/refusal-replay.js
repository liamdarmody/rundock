'use strict';
// Replay a recorded session of refusals through a build of the permission
// hook, and report what the agent was told at each one, in that step.
//
// Every call goes through the hook spawned as the runtime spawns it, against
// the real router holding the card and the real handler answering it. A step
// the sandbox refused is then reported back to the hook as the runtime reports
// a failed call (PostToolUseFailure), when the build being replayed registers
// a hook for that event. Which build is replayed is a parameter, so the same
// session can be measured before a change and after.
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const config = require('../../lib/config.js');
const router = require('../../lib/http-router.js');
const { handlePermissionResponse } = require('../../lib/protocol/handlers/process-control.js');
const auth = require('../../lib/auth/index.js');
const spiral = require('../fixtures/refusal-spiral.js');

function runHook(hook, env, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [hook], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => { let parsed = {}; try { parsed = JSON.parse(out); } catch (e) { /* nothing said */ } resolve(parsed); });
    child.stdin.end(JSON.stringify(input));
  });
}

async function waitFor(fn, ms = 10000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) return null;
    await new Promise((r) => setTimeout(r, 10));
  }
}

// What the agent read for one refused step: the refusal's own answer, or the
// context added to the finished call. Null when it was told nothing.
function toldFor(answer) {
  const h = (answer && answer.hookSpecificOutput) || {};
  return [h.permissionDecision === 'deny' ? h.permissionDecisionReason : null, h.additionalContext]
    .filter(Boolean).join('\n') || null;
}

async function replay(hook, { failureHook = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'refusal-replay-'));
  const home = path.join(base, 'home');
  const ws = path.join(home, 'Workspace');
  fs.mkdirSync(path.join(ws, '.rundock'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'notes'), { recursive: true });
  fs.mkdirSync(path.join(home, 'Desktop'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.rundock', 'state.json'), '{"workspaceMode":"knowledge"}\n');
  const pending = new Map();
  const sent = [];
  let timeoutMs = 60000;
  const prevWorkspace = config.getWorkspace();
  config.setWorkspace(ws);
  const prevDeps = router.wireHttpRouterDeps({
    pendingPermissionRequests: () => pending,
    safeSend: (s) => sent.push(JSON.parse(s)),
    getPermissionTimeoutMs: () => timeoutMs,
    routineRunForSession: () => null,
  });
  const server = http.createServer(router.handleHttpRequest);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const convo = 'refusal-replay';
  const env = { ...process.env, RUNDOCK: '1', RUNDOCK_PORT: String(server.address().port), RUNDOCK_WORKSPACE: ws, RUNDOCK_CONVO_ID: convo, RUNDOCK_HOOK_TOKEN: auth.issueHookToken(convo), RUNDOCK_EXTRA_DIRS: '', HOME: home };
  delete env.RUNDOCK_CODE_MODE;
  delete env.NODE_V8_COVERAGE;
  const session = spiral({ H: home });
  const steps = [];
  try {
    for (const step of session.steps) {
      const toolInput = { command: step.command, ...(step.dangerouslyDisableSandbox ? { dangerouslyDisableSandbox: true } : {}) };
      timeoutMs = step.card === 'none' ? 50 : 60000;
      const since = sent.length;
      const asking = runHook(hook, env, { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: toolInput, cwd: ws });
      const card = step.card ? await waitFor(() => sent.slice(since).find((m) => m.type === 'control_request')) : null;
      if (card && step.card !== 'none') {
        handlePermissionResponse({ pendingPermissions: pending, broadcast: () => {} }, { send() {} }, { requestId: card.request_id, conversationId: convo, allow: step.card === 'allow' });
      }
      const pre = await asking;
      const decision = pre.hookSpecificOutput && pre.hookSpecificOutput.permissionDecision;
      let kind = null;
      let told = null;
      if (decision === 'deny') {
        kind = step.card === 'none' ? 'timeout' : 'denied';
        told = toldFor(pre);
      } else if (step.blocked) {
        kind = 'sandbox';
        told = failureHook
          ? toldFor(await runHook(hook, env, { session_id: 's', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: toolInput, error: step.blocked, cwd: ws }))
          : null;
      }
      steps.push({ command: step.command, carded: !!card, decision, kind, told });
    }
  } finally {
    await new Promise((r) => server.close(r));
    router.wireHttpRouterDeps(prevDeps);
    if (prevWorkspace) config.setWorkspace(prevWorkspace);
    fs.rmSync(base, { recursive: true, force: true });
  }
  return { steps, summary: summarize(steps) };
}

// The measures, per refused step: was the agent told, in that step, to stop
// and ask; was it told something that invites another attempt; was it told
// nothing at all.
//
// `attemptsAfterRefusal` is what the recorded session did: the calls it made
// after its first refusal before it asked the person. `attemptsUntold` is how
// many of those it made before any refusal had told it to stop and ask, which
// is the part of the spiral the session gave the agent no reason not to make.
// Whether an agent then does stop is the model's to show, in a live session;
// a replay can only show what it was told.
const STOP_AND_ASK = /stop and ask/i;
const INVITES_RETRY = /try the command again|move on/i;
function summarize(steps) {
  const refused = steps.filter((s) => s.kind);
  const firstRefusal = steps.findIndex((s) => s.kind);
  const firstTold = steps.findIndex((s) => s.kind && STOP_AND_ASK.test(s.told || ''));
  const after = firstRefusal === -1 ? 0 : steps.length - 1 - firstRefusal;
  return {
    refusals: refused.length,
    toldToStopAndAsk: refused.filter((s) => STOP_AND_ASK.test(s.told || '')).length,
    invitedToRetry: refused.filter((s) => INVITES_RETRY.test(s.told || '')).length,
    toldNothing: refused.filter((s) => !s.told).length,
    attemptsAfterRefusal: after,
    attemptsUntold: firstTold === -1 ? after : firstTold - firstRefusal,
  };
}

module.exports = { replay, summarize };
