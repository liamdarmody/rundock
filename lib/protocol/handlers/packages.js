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

// ---- Extension install: acquire, trust, confirm or decline, update, remove.
//
// The handlers stay a JSON boundary: validation, acquisition, planning and
// the transaction all live in lib/packages/. What is added here is the one
// piece of state a consent flow needs on the server: the acquired snapshot
// waits, under a token, between the offer and the person's answer, so the
// bytes the trust step described are the bytes an accept installs. Decline
// discards the snapshot; confirm installs from it and then discards it;
// either way the token dies with its use. A token abandoned by a dropped
// connection leaves only a temporary directory the operating system owns.

const {
  parseGitHubSource, acquireWithGit, discardAcquisition, listRefsWithGit,
} = require('../../packages/extension-source.js');
const {
  planExtensionInstall, installExtension, uninstallExtension,
} = require('../../packages/extension-install.js');
const { readExtensionRecords, recordFor, checkForUpdate } = require('../../packages/extension-record.js');

// The two network edges, injectable so the focused suite drives the whole
// flow with fixtures. Both defaults live in lib/packages/extension-source.js,
// which stays the only place git is spelled; this module stays a JSON
// boundary and never shells out itself.
let extensionDeps = {
  acquire: acquireWithGit,
  listRefs: listRefsWithGit,
};
function wireExtensionDeps(next) {
  const previous = extensionDeps;
  extensionDeps = { ...extensionDeps, ...next };
  return previous;
}

// Extension errors travel under their own type: the two flows have separate
// state machines on the client, and an error routed into the wrong one would
// be read against the wrong request.
function extFail(ws, operation, error) {
  ws.send(JSON.stringify({
    type: 'extension_install_error',
    operation,
    message: error && error.message ? error.message : String(error),
    code: error && typeof error.code === 'string' ? error.code : null,
  }));
}

const pendingInstalls = new Map();
let nextToken = 1;

// The last unanswered plan opened on each connection, so a second plan from
// the same socket supersedes the first rather than leaving it to rot: a
// person who reads a second package before answering the first has walked
// away from that offer as surely as a decline would say so.
const pendingBySocket = new WeakMap();

function releasePending(token) {
  const pending = pendingInstalls.get(token);
  if (!pending) return;
  pendingInstalls.delete(token);
  discardAcquisition(pending.snapshot);
}

// Acquire, plan and offer, for both a fresh install and an update: the only
// difference between them is where `source` came from. Everything from here
// down is one flow, because an update IS an install.
function beginExtensionPlan(ws, workspace, source) {
  let snapshot = null;
  try {
    snapshot = extensionDeps.acquire(source);
    const plan = planExtensionInstall(workspace, snapshot, source);
    const token = `ext-${nextToken++}`;
    // An earlier offer this same connection opened and never answered is
    // superseded here rather than left holding its snapshot indefinitely.
    const previousToken = pendingBySocket.get(ws);
    if (previousToken) releasePending(previousToken);
    pendingInstalls.set(token, { snapshot, plan });
    pendingBySocket.set(ws, token);
    // A dropped connection is the other way an offer goes unanswered. Only
    // real sockets carry `.once`; the capture socket the focused suite hands
    // in for every other assertion does not, and none of this flow needs it
    // to exercise anything but this one release.
    if (typeof ws.once === 'function') {
      ws.once('close', () => releasePending(token));
    }
    ws.send(JSON.stringify({
      type: 'extension_install_plan',
      token,
      manifest: plan.manifest,
      facts: plan.facts,
      source: plan.source,
      replaces: plan.replaces,
    }));
  } catch (e) {
    discardAcquisition(snapshot);
    extFail(ws, 'extension-plan', e);
  }
}

function handlePlanExtensionInstall(ctx, ws, msg) {
  const workspace = getWorkspace();
  if (!workspace) return extFail(ws, 'extension-plan', new Error('no workspace is open'));
  let source;
  try {
    source = parseGitHubSource(msg.url, msg.reference);
  } catch (e) {
    return extFail(ws, 'extension-plan', e);
  }
  beginExtensionPlan(ws, workspace, source);
}

// The update path: an extension name and the reference to move to are all
// the caller supplies. The source URL comes out of the installed record,
// never from the caller, which is the whole point of persisting it, and it
// lands here in the same acquire-plan-offer flow a fresh install uses, so an
// update reopens the trust step exactly like any other install would.
function handlePlanExtensionUpdate(ctx, ws, msg) {
  const workspace = getWorkspace();
  if (!workspace) return extFail(ws, 'extension-plan', new Error('no workspace is open'));
  const record = recordFor(readExtensionRecords(workspace), msg.name);
  if (!record) return extFail(ws, 'extension-plan', new Error(`no extension named "${msg.name}" is installed`));
  const reference = typeof msg.reference === 'string' ? msg.reference.trim() : '';
  if (!reference) return extFail(ws, 'extension-plan', new Error('a reference to update to is required'));
  beginExtensionPlan(ws, workspace, { url: record.source.url, reference });
}

function handleConfirmExtensionInstall(ctx, ws, msg) {
  const workspace = getWorkspace();
  if (!workspace) return extFail(ws, 'extension-install', new Error('no workspace is open'));
  const pending = pendingInstalls.get(msg.token);
  if (!pending) return extFail(ws, 'extension-install', new Error('nothing is awaiting this confirmation; read the package again'));
  pendingInstalls.delete(msg.token);
  try {
    const record = installExtension(workspace, pending.snapshot, pending.plan);
    ws.send(JSON.stringify({ type: 'extension_install_result', record }));
  } catch (e) {
    extFail(ws, 'extension-install', e);
  } finally {
    discardAcquisition(pending.snapshot);
  }
}

function handleDeclineExtensionInstall(ctx, ws, msg) {
  const pending = pendingInstalls.get(msg.token);
  pendingInstalls.delete(msg.token);
  if (pending) discardAcquisition(pending.snapshot);
  ws.send(JSON.stringify({ type: 'extension_install_declined' }));
}

function handleCheckExtensionUpdate(ctx, ws, msg) {
  const workspace = getWorkspace();
  if (!workspace) return extFail(ws, 'extension-update', new Error('no workspace is open'));
  try {
    const record = recordFor(readExtensionRecords(workspace), msg.name);
    if (!record) throw new Error(`no extension named "${msg.name}" is installed`);
    const status = checkForUpdate(record, extensionDeps.listRefs);
    ws.send(JSON.stringify({ type: 'extension_update_status', ...status }));
  } catch (e) {
    extFail(ws, 'extension-update', e);
  }
}

function handleUninstallExtension(ctx, ws, msg) {
  const workspace = getWorkspace();
  if (!workspace) return extFail(ws, 'extension-uninstall', new Error('no workspace is open'));
  try {
    const outcome = uninstallExtension(workspace, msg.name);
    ws.send(JSON.stringify({ type: 'extension_uninstalled', ...outcome }));
  } catch (e) {
    extFail(ws, 'extension-uninstall', e);
  }
}

module.exports = {
  handlePlanPackageImport, handleApplyPackageImport,
  handlePlanExtensionInstall, handlePlanExtensionUpdate,
  handleConfirmExtensionInstall, handleDeclineExtensionInstall,
  handleCheckExtensionUpdate, handleUninstallExtension,
  wireExtensionDeps,
};
