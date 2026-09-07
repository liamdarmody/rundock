'use strict';
// WS handlers: package import planning and apply. This is a JSON boundary
// and nothing more: discovery, planning, evaluation, byte verification and
// the transaction all live in lib/packages/, and the handlers never replan,
// rewrite an approval, or fill anything in. The two typed-path handlers take
// a caller-supplied source directory, which may sit outside the workspace;
// no interface reaches them any more (the Packages section sends a link, see
// the install section below), and they stay for the suites that drive the
// planner and the transaction against a local tree. Everything they lead to
// is digested and verified before a byte lands.

const path = require('path');
const { getWorkspace } = require('../../config.js');
const { buildPlan } = require('../../packages/import-plan.js');
const { applyImport } = require('../../packages/import-apply.js');
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
    ws.send(JSON.stringify({ type: 'package_import_plan', operation: 'plan', token: null, plan }));
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
      operation: 'apply',
      token: null,
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

// ---- Package install from a link: acquire, classify, trust or offer, one
// answer, update, remove.
//
// The handlers stay a JSON boundary: validation, acquisition, planning and
// the transaction all live in lib/packages/. What is added here is the one
// piece of state a consent flow needs on the server: the acquired snapshot
// waits, under a token, between the offer and the person's answer, so the
// bytes the trust step described are the bytes an accept installs. Decline
// discards the snapshot; confirm installs from it and then discards it;
// either way the token dies with its use. A token abandoned by a dropped
// connection leaves only a temporary directory the operating system owns.
//
// EVERY REPLY NAMES ITS OPERATION AND ITS TOKEN, so the client can match a
// reply to the request that produced it rather than to whatever it happens
// to be waiting for. An uninstall's error must never be read as the answer
// to an install in flight.

const {
  parseGitHubSource, requirePin, acquireWithGit, discardAcquisition, listRefsWithGit,
} = require('../../packages/extension-source.js');
const { classifySnapshot } = require('../../packages/extension-manifest.js');
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

function installFail(ws, operation, token, error) {
  ws.send(JSON.stringify({
    type: 'package_install_error',
    operation,
    token: token || null,
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

// Every way an offer ends runs through here, so the snapshot and the close
// listener that would have released it leave together: a listener left on
// a long-lived socket after its offer was answered is a leak that grows by
// one per install.
function releasePending(token) {
  const pending = pendingInstalls.get(token);
  if (!pending) return null;
  pendingInstalls.delete(token);
  if (pending.onClose && typeof pending.ws.off === 'function') pending.ws.off('close', pending.onClose);
  return pending;
}

function discardPending(token) {
  const pending = releasePending(token);
  if (pending) discardAcquisition(pending.snapshot);
}

function holdPending(ws, entry) {
  const token = `pkg-${nextToken++}`;
  // An earlier offer this same connection opened and never answered is
  // superseded here rather than left holding its snapshot indefinitely.
  const previousToken = pendingBySocket.get(ws);
  if (previousToken) discardPending(previousToken);
  const pending = { ...entry, ws, onClose: null };
  // A dropped connection is the other way an offer goes unanswered. Only
  // real sockets carry `.once`; the capture socket the focused suite hands
  // in for most assertions does not, and none of this flow needs it to
  // exercise anything but this one release.
  if (typeof ws.once === 'function') {
    pending.onClose = () => discardPending(token);
    ws.once('close', pending.onClose);
  }
  pendingInstalls.set(token, pending);
  pendingBySocket.set(ws, token);
  return token;
}

// The content half of a snapshot, planned through the same machinery the
// typed path uses, with the link and the pin as the source identity so the
// receipt carries where the files came from.
function contentPlan(workspace, snapshot, source) {
  return buildPlan(workspace, snapshot, { id: source.url, reference: source.reference });
}

// Acquire, classify and offer, for a fresh install and for an update alike:
// the only difference between them is where `source` came from. The
// workspace this was planned against travels with the offer, because the
// facts on screen are true of that workspace and no other, so confirm has
// to be able to tell whether the world it is about to write into is still
// the one the trust step described.
function beginPackagePlan(ws, workspace, source) {
  let snapshot = null;
  try {
    snapshot = extensionDeps.acquire(source);
    const classified = classifySnapshot(snapshot);
    if (classified.kind === 'content') {
      const plan = contentPlan(workspace, snapshot, source);
      const token = holdPending(ws, { kind: 'content', snapshot, plan, workspace });
      ws.send(JSON.stringify({ type: 'package_import_plan', operation: 'plan', token, plan }));
      return;
    }
    requirePin(source);
    const plan = planExtensionInstall(workspace, snapshot, source);
    // Agents and skills beside an extension are offered as a second step
    // once the extension is installed; their plan is read now, from the
    // same bytes, so the offer that follows describes this snapshot.
    const content = (plan.facts.agents || plan.facts.skills) ? contentPlan(workspace, snapshot, source) : null;
    const token = holdPending(ws, { kind: 'extension', snapshot, plan, content, workspace });
    ws.send(JSON.stringify({
      type: 'extension_install_plan',
      operation: 'plan',
      token,
      manifest: plan.manifest,
      facts: plan.facts,
      source: plan.source,
      replaces: plan.replaces,
    }));
  } catch (e) {
    discardAcquisition(snapshot);
    installFail(ws, 'plan', null, e);
  }
}

function handlePlanPackageInstall(ctx, ws, msg) {
  const workspace = getWorkspace();
  if (!workspace) return installFail(ws, 'plan', null, new Error('no workspace is open'));
  let source;
  try {
    source = parseGitHubSource(msg.url, msg.reference);
  } catch (e) {
    return installFail(ws, 'plan', null, e);
  }
  beginPackagePlan(ws, workspace, source);
}

// The update path: an extension name and the reference to move to are all
// the caller supplies. The source URL comes out of the installed record,
// never from the caller, which is the whole point of persisting it, and it
// lands here in the same acquire-plan-offer flow a fresh install uses, so an
// update reopens the trust step exactly like any other install would.
function handlePlanExtensionUpdate(ctx, ws, msg) {
  const workspace = getWorkspace();
  if (!workspace) return installFail(ws, 'plan', null, new Error('no workspace is open'));
  // A handler answers, it never throws: an unreadable extensions.json (bad
  // JSON, an unrecognised schema, a record missing its own source) must
  // reach the client as a named refusal, the same as every sibling handler
  // answers for the same class of failure, rather than escaping the dispatch
  // as an uncaught exception.
  let source;
  try {
    const record = recordFor(readExtensionRecords(workspace), msg.name);
    if (!record) throw new Error(`no extension named "${msg.name}" is installed`);
    // The stored url travels with the workspace and is not trusted input,
    // exactly as the uninstall path refuses to trust the same file's root:
    // it goes through the same GitHub-source validation a fresh install's
    // pasted url does, never straight into a git argv. An update is code,
    // so the pin is required before anything is fetched.
    source = requirePin(parseGitHubSource(record.source.url, msg.reference));
  } catch (e) {
    return installFail(ws, 'plan', null, e);
  }
  beginPackagePlan(ws, workspace, source);
}

// The offer a token names is confirmed against the workspace it was shown
// on: a server that has since moved to another workspace must not install
// into whatever is current now. The token dies with its use either way.
function takePending(ws, operation, token, workspace) {
  const pending = pendingInstalls.get(token);
  if (!pending) {
    installFail(ws, operation, token, new Error('nothing is awaiting this confirmation; read the package again'));
    return null;
  }
  releasePending(token);
  if (pending.workspace !== workspace) {
    discardAcquisition(pending.snapshot);
    installFail(ws, operation, token, Object.assign(
      new Error('the workspace changed since this package was read; read it again'),
      { code: 'workspace-changed' },
    ));
    return null;
  }
  return pending;
}

function handleConfirmExtensionInstall(ctx, ws, msg) {
  const workspace = getWorkspace();
  if (!workspace) return installFail(ws, 'install', msg.token, new Error('no workspace is open'));
  const pending = takePending(ws, 'install', msg.token, workspace);
  if (!pending) return;
  if (pending.kind !== 'extension') {
    discardAcquisition(pending.snapshot);
    return installFail(ws, 'install', msg.token, new Error('this offer holds agents and skills, not an extension; answer it as the offer it is'));
  }
  try {
    const record = installExtension(workspace, pending.snapshot, pending.plan);
    // The content half, when there is one, becomes the next offer under a
    // token of its own: the snapshot stays held until that answer arrives.
    let content = null;
    if (pending.content) {
      const token = holdPending(ws, { kind: 'content', snapshot: pending.snapshot, plan: pending.content, workspace });
      content = { token, plan: pending.content };
    }
    ws.send(JSON.stringify({ type: 'extension_install_result', operation: 'install', token: msg.token, record, content }));
    if (!content) discardAcquisition(pending.snapshot);
  } catch (e) {
    discardAcquisition(pending.snapshot);
    installFail(ws, 'install', msg.token, e);
  }
}

// The content offer's answer: the approval object is used exactly as
// submitted, the evaluator is the sole authority on whether it still
// describes reality, and the snapshot the offer was read from is the one
// the writes come from.
function handleConfirmPackageInstall(ctx, ws, msg) {
  const workspace = getWorkspace();
  if (!workspace) return installFail(ws, 'apply', msg.token, new Error('no workspace is open'));
  const pending = takePending(ws, 'apply', msg.token, workspace);
  if (!pending) return;
  try {
    if (pending.kind !== 'content') throw new Error('this offer holds an extension; answer it at its trust step');
    const result = applyImport(workspace, pending.snapshot, msg.approval, { receipt: {} });
    ws.send(JSON.stringify({
      type: 'package_import_result',
      operation: 'apply',
      token: msg.token,
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
    installFail(ws, 'apply', msg.token, e);
  } finally {
    discardAcquisition(pending.snapshot);
  }
}

function handleDeclinePackageInstall(ctx, ws, msg) {
  discardPending(msg.token);
  ws.send(JSON.stringify({ type: 'package_install_declined', operation: 'decline', token: msg.token }));
}

function handleCheckExtensionUpdate(ctx, ws, msg) {
  const workspace = getWorkspace();
  if (!workspace) return installFail(ws, 'update-check', null, new Error('no workspace is open'));
  try {
    const record = recordFor(readExtensionRecords(workspace), msg.name);
    if (!record) throw new Error(`no extension named "${msg.name}" is installed`);
    // The stored url travels with the workspace and is not trusted input,
    // exactly as handlePlanExtensionUpdate revalidates the same field before
    // it can reach a git argv: ask the remote only about the canonical url
    // this validation returns, never the value stored verbatim.
    const { url } = parseGitHubSource(record.source.url, record.source.reference);
    const status = checkForUpdate({ ...record, source: { ...record.source, url } }, extensionDeps.listRefs);
    ws.send(JSON.stringify({ type: 'extension_update_status', operation: 'update-check', token: null, ...status }));
  } catch (e) {
    installFail(ws, 'update-check', null, e);
  }
}

function handleUninstallExtension(ctx, ws, msg) {
  const workspace = getWorkspace();
  if (!workspace) return installFail(ws, 'uninstall', null, new Error('no workspace is open'));
  try {
    const outcome = uninstallExtension(workspace, msg.name);
    ws.send(JSON.stringify({ type: 'extension_uninstalled', operation: 'uninstall', token: null, ...outcome }));
  } catch (e) {
    installFail(ws, 'uninstall', null, e);
  }
}

module.exports = {
  handlePlanPackageImport, handleApplyPackageImport,
  handleListExtensions, handleGetExtensionUi,
  handlePlanPackageInstall, handlePlanExtensionUpdate,
  handleConfirmExtensionInstall, handleConfirmPackageInstall, handleDeclinePackageInstall,
  handleCheckExtensionUpdate, handleUninstallExtension,
  wireExtensionDeps,
};
