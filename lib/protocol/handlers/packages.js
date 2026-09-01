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
const { applyImport } = require('../../packages/import-apply.js');

function fail(ws, operation, error) {
  ws.send(JSON.stringify({
    type: 'package_import_error',
    operation,
    message: error && error.message ? error.message : String(error),
  }));
}

function handlePlanPackageImport(ctx, ws, msg) {
  const workspace = getWorkspace();
  if (!workspace) return fail(ws, 'plan', new Error('no workspace is open'));
  try {
    const plan = buildPlan(workspace, path.resolve(String(msg.sourcePath || '')), {
      id: msg.source && msg.source.id,
      reference: msg.source && msg.source.reference !== undefined ? msg.source.reference : null,
    });
    ws.send(JSON.stringify({ type: 'package_import_plan', plan }));
  } catch (e) {
    fail(ws, 'plan', e);
  }
}

function handleApplyPackageImport(ctx, ws, msg) {
  const workspace = getWorkspace();
  if (!workspace) return fail(ws, 'apply', new Error('no workspace is open'));
  try {
    // The approval object is used exactly as submitted; the evaluator is
    // the sole authority on whether it still describes reality.
    const result = applyImport(workspace, path.resolve(String(msg.sourcePath || '')), msg.approval, { receipt: {} });
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

module.exports = { handlePlanPackageImport, handleApplyPackageImport };
