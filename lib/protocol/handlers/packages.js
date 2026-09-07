'use strict';
// WS handlers: package import planning and apply. This is a JSON boundary
// and nothing more: discovery, planning, evaluation, byte verification and
// the transaction all live in lib/packages/, and the handlers never replan,
// rewrite an approval, or fill anything in. The source path is caller
// supplied and may sit outside the workspace, which is the existing
// typed-path install affordance; everything it leads to is digested and
// verified before a byte lands.

const path = require('path');
const { getWorkspace } = require('../../config.js');
const { buildPlan } = require('../../packages/import-plan.js');
const { applyImport, evaluateApproval } = require('../../packages/import-apply.js');
const { listExtensions, uiPayload } = require('../../packages/extension-registry.js');

// A missing source path must refuse, never default: path.resolve('') is the
// server's own working directory, and running discovery or apply over that
// is precisely the accident this guard exists to make unreachable.
function sourcePathOf(msg) {
  if (typeof msg.sourcePath !== 'string' || msg.sourcePath.trim() === '') {
    throw new Error('sourcePath is required: the package source directory to read');
  }
  return path.resolve(msg.sourcePath);
}

// requestId is echoed back whenever the message that failed carried one, so
// a client correlating replies to the request that produced them (evaluate
// and apply share one result envelope and need this; plan does not, since
// package_import_plan is a type no other request produces) can match a
// refusal the same way it matches a success.
function fail(ws, operation, error, requestId) {
  ws.send(JSON.stringify({
    type: 'package_import_error',
    operation,
    requestId,
    message: error && error.message ? error.message : String(error),
    // Machine-readable when the producer attached one (discovery refusals,
    // filesystem codes, journal errors), so clients classify states without
    // ever reading the message prose.
    code: error && typeof error.code === 'string' ? error.code : null,
  }));
}

function handlePlanPackageImport(ctx, ws, msg) {
  const workspace = getWorkspace();
  if (!workspace) return fail(ws, 'plan', new Error('no workspace is open'));
  try {
    const plan = buildPlan(workspace, sourcePathOf(msg), {
      id: msg.source && msg.source.id,
      reference: msg.source && msg.source.reference !== undefined ? msg.source.reference : null,
    });
    ws.send(JSON.stringify({ type: 'package_import_plan', plan }));
  } catch (e) {
    fail(ws, 'plan', e);
  }
}

// The review's projection: evaluate the submitted decisions against the live
// workspace WITHOUT writing, so the decide surface can show blocking and
// staleness while the person is still choosing, judged by the one evaluator
// rather than a second copy of its rules in the browser. The reply reuses the
// import-result envelope because that is what it is: a result computed, not
// applied, so `written` and `receipt` are absent and nothing on disk moves.
// The snapshot-then-evaluate sequence is applyImport's own, reached through
// the one function it exports for it, so this handler stays a JSON boundary.
// No interrupted-transaction recovery runs here: recovery writes, evaluation
// must not, and apply re-evaluates authoritatively after recovering anyway.
function handleEvaluatePackageDecisions(ctx, ws, msg) {
  const workspace = getWorkspace();
  if (!workspace) return fail(ws, 'evaluate', new Error('no workspace is open'), msg.requestId);
  try {
    const evaluation = evaluateApproval(workspace, sourcePathOf(msg), msg.approval);
    ws.send(JSON.stringify({
      type: 'package_import_result',
      // Self-identifying against the apply reply, which shares this exact
      // envelope: the client matches a reply to the request that produced
      // it, and an operation stamp is one half of how it tells the two apart
      // (requestId, echoed below, is the other).
      operation: 'evaluate',
      requestId: msg.requestId,
      status: evaluation.status,
      writes: evaluation.writes,
      unchanged: evaluation.unchanged,
      skipped: evaluation.skipped,
      blocked: evaluation.blocked,
      stale: evaluation.stale,
    }));
  } catch (e) {
    fail(ws, 'evaluate', e, msg.requestId);
  }
}

function handleApplyPackageImport(ctx, ws, msg) {
  const workspace = getWorkspace();
  if (!workspace) return fail(ws, 'apply', new Error('no workspace is open'), msg.requestId);
  try {
    // The approval object is used exactly as submitted; the evaluator is
    // the sole authority on whether it still describes reality.
    const result = applyImport(workspace, sourcePathOf(msg), msg.approval, { receipt: {} });
    ws.send(JSON.stringify({
      type: 'package_import_result',
      operation: 'apply',
      requestId: msg.requestId,
      status: result.status,
      writes: result.writes,
      unchanged: result.unchanged,
      skipped: result.skipped,
      blocked: result.blocked,
      stale: result.stale,
      written: result.written,
      receipt: result.receipt,
    }));
  } catch (e) {
    fail(ws, 'apply', e, msg.requestId);
  }
}

// The mount messages: the roster of installed extensions, and the bytes one
// renderer's mount needs. Both are reads; refusals carry reasons so the
// client can say why a renderer stayed silent rather than guessing.
function handleListExtensions(ctx, ws) {
  const workspace = getWorkspace();
  if (typeof workspace !== 'string' || workspace.trim() === '') {
    ws.send(JSON.stringify({ type: 'extensions_error', reason: 'no workspace is open' }));
    return;
  }
  try {
    ws.send(JSON.stringify({ type: 'extensions', extensions: listExtensions(workspace) }));
  } catch (e) {
    ws.send(JSON.stringify({ type: 'extensions_error', reason: e && e.message ? e.message : String(e) }));
  }
}

function handleGetExtensionUi(ctx, ws, msg) {
  const workspace = getWorkspace();
  const reply = (result) => {
    if (!result || !result.ok) {
      ws.send(JSON.stringify({
        type: 'extension_ui_error',
        extensionId: msg && msg.extensionId, rendererId: msg && msg.rendererId,
        reason: (result && result.reason) || 'the renderer payload could not be read',
      }));
      return;
    }
    ws.send(JSON.stringify({
      type: 'extension_ui',
      extensionId: msg.extensionId, rendererId: msg.rendererId,
      entry: result.entry, styles: result.styles, resources: result.resources,
    }));
  };
  if (typeof workspace !== 'string' || workspace.trim() === '') {
    reply({ ok: false, reason: 'no workspace is open' });
    return;
  }
  try {
    reply(uiPayload(workspace, msg && msg.extensionId, msg && msg.rendererId));
  } catch (e) {
    reply({ ok: false, reason: e && e.message ? e.message : String(e) });
  }
}

module.exports = { handlePlanPackageImport, handleEvaluatePackageDecisions, handleApplyPackageImport, handleListExtensions, handleGetExtensionUi };
