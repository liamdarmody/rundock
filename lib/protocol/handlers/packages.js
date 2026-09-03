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
const { applyImport, snapshotCurrent } = require('../../packages/import-apply.js');
const { evaluateImport } = require('../../packages/import-evaluate.js');

// A missing source path must refuse, never default: path.resolve('') is the
// server's own working directory, and running discovery or apply over that
// is precisely the accident this guard exists to make unreachable.
function sourcePathOf(msg) {
  if (typeof msg.sourcePath !== 'string' || msg.sourcePath.trim() === '') {
    throw new Error('sourcePath is required: the package source directory to read');
  }
  return path.resolve(msg.sourcePath);
}

function fail(ws, operation, error) {
  ws.send(JSON.stringify({
    type: 'package_import_error',
    operation,
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
// No interrupted-transaction recovery runs here: recovery writes, evaluation
// must not, and apply re-evaluates authoritatively after recovering anyway.
function handleEvaluatePackageDecisions(ctx, ws, msg) {
  const workspace = getWorkspace();
  if (!workspace) return fail(ws, 'evaluate', new Error('no workspace is open'));
  try {
    const sourceRoot = sourcePathOf(msg);
    const evaluation = evaluateImport(msg.approval, snapshotCurrent(workspace, sourceRoot, msg.approval));
    ws.send(JSON.stringify({
      type: 'package_import_result',
      operation: 'evaluate',
      status: evaluation.status,
      writes: evaluation.writes,
      unchanged: evaluation.unchanged,
      skipped: evaluation.skipped,
      blocked: evaluation.blocked,
      stale: evaluation.stale,
    }));
  } catch (e) {
    fail(ws, 'evaluate', e);
  }
}

function handleApplyPackageImport(ctx, ws, msg) {
  const workspace = getWorkspace();
  if (!workspace) return fail(ws, 'apply', new Error('no workspace is open'));
  try {
    // The approval object is used exactly as submitted; the evaluator is
    // the sole authority on whether it still describes reality.
    const result = applyImport(workspace, sourcePathOf(msg), msg.approval, { receipt: {} });
    ws.send(JSON.stringify({
      type: 'package_import_result',
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
    fail(ws, 'apply', e);
  }
}

module.exports = { handlePlanPackageImport, handleEvaluatePackageDecisions, handleApplyPackageImport };
