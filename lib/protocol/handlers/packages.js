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
const { applyImport, evaluateApproval } = require('../../packages/import-apply.js');
const { listExtensions, uiPayload } = require('../../packages/extension-registry.js');
const { readable } = require('../../../public/readable-error.js');

// What each operation was doing, said after "Rundock couldn't" when a system
// error stops it (public/readable-error.js). The raw words ride as `detail`.
const OPERATION_ACTIONS = {
  plan: 'read the package', evaluate: 'check the review', apply: 'add the package',
  install: 'install the package',
  'package-update-check': 'check for an update', 'package-update-plan': 'prepare the update',
  'package-update': 'update the package', 'package-uninstall-plan': 'prepare the removal',
  'package-uninstall': 'remove the package', 'set-enabled': 'change the extension',
  'set-all-off': 'change the extensions', 'clear-package-updates': 'clear the old updates',
};
function readableFor(operation, error) {
  return readable(error, { action: OPERATION_ACTIONS[operation] });
}

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
function fail(ws, operation, error, requestId, token) {
  ws.send(JSON.stringify({
    type: 'package_import_error',
    operation,
    requestId,
    token: token || null,
    ...readableFor(operation, error),
    // Machine-readable when the producer attached one (discovery refusals,
    // filesystem codes, journal errors), so clients classify states without
    // ever reading the message prose.
    code: error && typeof error.code === 'string' ? error.code : null,
  }));
}

function handlePlanPackageImport(ctx, ws, msg) {
  const workspace = getWorkspace();
  if (!workspace) return fail(ws, 'plan', new Error('No workspace is open.'));
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
// The one shape of a package_import_result, stated once: the evaluator's
// buckets, stamped with the operation that produced them and the token and
// request id the client correlates on. `written` and `receipt` ride only
// when the result carries them, which a projection never does.
function sendImportResult(ws, operation, token, requestId, result) {
  const reply = {
    type: 'package_import_result',
    operation,
    requestId,
    token,
    status: result.status,
    writes: result.writes,
    unchanged: result.unchanged,
    skipped: result.skipped,
    blocked: result.blocked,
    stale: result.stale,
  };
  if ('written' in result) reply.written = result.written;
  if ('receipt' in result) reply.receipt = result.receipt;
  ws.send(JSON.stringify(reply));
}

function handleEvaluatePackageDecisions(ctx, ws, msg) {
  const workspace = getWorkspace();
  const token = msg.token || null;
  if (!workspace) return fail(ws, 'evaluate', new Error('No workspace is open.'), msg.requestId, token);
  try {
    // The bytes being decided about are the ones the offer was read from:
    // the snapshot the server holds under the offer's token when the ask
    // names one (the link flow), or the typed source directory otherwise
    // (the suites that drive the planner against a local tree). Reading the
    // held snapshot does not consume it: the offer stays open for the next
    // decision, and for the confirm.
    const evaluation = evaluateApproval(workspace, token ? heldSnapshotFor(token, workspace) : sourcePathOf(msg), msg.approval);
    // Self-identifying against the apply reply, which shares this exact
    // envelope: the client matches a reply to the request that produced it,
    // and the operation stamp is one half of how it tells the two apart
    // (the request id and the token are the rest).
    sendImportResult(ws, 'evaluate', token, msg.requestId, evaluation);
  } catch (e) {
    fail(ws, 'evaluate', e, msg.requestId, token);
  }
}

function handleApplyPackageImport(ctx, ws, msg) {
  const workspace = getWorkspace();
  if (!workspace) return fail(ws, 'apply', new Error('No workspace is open.'), msg.requestId);
  try {
    // The approval object is used exactly as submitted; the evaluator is
    // the sole authority on whether it still describes reality.
    const result = applyImport(workspace, sourcePathOf(msg), msg.approval, { receipt: {} });
    // An import that landed files is an agent write like any other, so it
    // tells the root's cache cascade the way save_agent does: without this
    // the roster and skills the server serves can predate the install until
    // the cache expires, and the client's re-request right after the reply
    // would be answered from a warm cache that omits what just arrived. A
    // result whose writes bucket is empty (a replay, or every item skipped)
    // moved no agent or skill and tears nothing down; writes are non-empty
    // only on a ready result, so nothing is invalidated for a refusal.
    // And a conversation already underway was given its team in a system
    // prompt built before this package existed, so it is flagged the way an
    // agent write through team.js flags it. This wakes nothing: the flag is
    // spent when a follow-up next arrives there, respawning over --resume
    // with the roster it should have had. Without it an imported agent shows
    // in Team and cannot be delegated to in the conversation being used.
    if (result.writes.length > 0) {
      ctx.agents.invalidateAgentCache();
      ctx.agents.flagRosterRefresh();
    }
    sendImportResult(ws, 'apply', null, msg.requestId, result);
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
    ws.send(JSON.stringify({ type: 'extensions_error', reason: 'No workspace is open.' }));
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
        reason: (result && result.reason) || 'The renderer payload couldn\'t be read.',
      }));
      return;
    }
    ws.send(JSON.stringify({
      type: 'extension_ui',
      extensionId: msg.extensionId, rendererId: msg.rendererId,
      entry: result.entry, styles: result.styles, resources: result.resources,
      // The privilege travels with the payload the frame is mounted from, so
      // the host never has to ask a second source what this extension may do.
      writes: result.writes === true,
      sources: result.sources === true,
      asks: Array.isArray(result.asks) ? result.asks : [],
    }));
  };
  if (typeof workspace !== 'string' || workspace.trim() === '') {
    reply({ ok: false, reason: 'No workspace is open.' });
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
  parseGitHubSource, requirePin, requireFixedPin, acquireWithGit, acquiredCommit, acquiredPinKind,
  discardAcquisition, listRefsWithGit, listTagCommitsWithGit,
} = require('../../packages/extension-source.js');
const { classifySnapshot, readPackageDisplayName } = require('../../packages/extension-manifest.js');
const {
  planExtensionInstall, installExtension,
} = require('../../packages/extension-install.js');
const { readExtensionRecords, recordFor, latestTag } = require('../../packages/extension-record.js');

// The two network edges, injectable so the focused suite drives the whole
// flow with fixtures. Both defaults live in lib/packages/extension-source.js,
// which stays the only place git is spelled; this module stays a JSON
// boundary and never shells out itself.
let extensionDeps = {
  acquire: acquireWithGit,
  listRefs: listRefsWithGit,
  commitOf: acquiredCommit,
  pinKindOf: acquiredPinKind,
  listTagCommits: listTagCommitsWithGit,
  runningRuns: () => scheduler.runningRuns(),
  afterStep: undefined,
  now: () => Date.now(),
};
function wireExtensionDeps(next) {
  const previous = extensionDeps;
  extensionDeps = { ...extensionDeps, ...next };
  return previous;
}

// `extra` is what the manage page's operations add: the extension name, so
// a refusal lands on the row that asked rather than on whichever row the
// page happens to be waiting on.
function installFail(ws, operation, token, error, requestId, extra = {}) {
  ws.send(JSON.stringify({
    type: 'package_install_error',
    operation,
    token: token || null,
    requestId,
    ...readableFor(operation, error),
    code: error && typeof error.code === 'string' ? error.code : null,
    ...extra,
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

// The snapshot an open offer is holding, for a read that must not consume
// it: the review's projection. Refused, never defaulted, when nothing is
// held under the token or the workspace has moved since the offer was
// shown, with the same words the confirm would use, so the review learns
// what the confirm would have said before the person spends more decisions
// on it.
function heldSnapshotFor(token, workspace) {
  const pending = pendingInstalls.get(token);
  if (!pending) throw new Error('nothing is awaiting this review; read the package again');
  if (pending.workspace !== workspace) {
    throw Object.assign(new Error('the workspace changed since this package was read; read it again'), { code: 'workspace-changed' });
  }
  if (pending.kind === 'update') {
    if (!pending.update) throw new Error('This update carries no agents or skills to review.');
    return pending.snapshot;
  }
  if (pending.kind !== 'content') throw new Error('this offer holds an extension; answer it at its trust step');
  return pending.snapshot;
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

// The newest version tag, or null for a repository with none it can order.
// Any other failure to list is a refusal: installing the head because a
// listing failed would install unreleased work while a release exists.
function newestRelease(refs) {
  try {
    return latestTag(refs);
  } catch (e) {
    if (e.code === 'no-tags' || e.code === 'unorderable-tags') return null;
    throw e;
  }
}

// The commit a snapshot was fetched at, or null when the acquirer cannot say.
function commitOf(snapshot) {
  return typeof extensionDeps.commitOf === 'function' ? extensionDeps.commitOf(snapshot) : null;
}

// The content half of a snapshot, planned through the same machinery the
// typed path uses, with the link and the pin as the source identity so the
// receipt carries where the files came from.
function contentPlan(workspace, snapshot, source) {
  return buildPlan(workspace, snapshot, { id: source.url, reference: source.reference });
}

// Acquire, classify and offer a fresh install. A package update has its
// own path (handlePlanPackageUpdate below), planned from the installed
// package rather than a link. The
// workspace this was planned against travels with the offer, because the
// facts on screen are true of that workspace and no other, so confirm has
// to be able to tell whether the world it is about to write into is still
// the one the trust step described.
function beginPackagePlan(ws, workspace, source) {
  let snapshot = null;
  try {
    snapshot = extensionDeps.acquire(source);
    const classified = classifySnapshot(snapshot);
    // A plain link to agents and skills installs the newest release when the
    // repository has one, exactly as an extension's does, so what is
    // installed has a version an update can come after. With no release it
    // installs the head's exact commit, which is recorded, and is never
    // offered an update (decided 2026-09-24).
    if (classified.kind === 'content' && !source.reference) {
      const reference = newestRelease(extensionDeps.listRefs(source.url));
      if (reference) {
        discardAcquisition(snapshot);
        snapshot = null;
        return beginPackagePlan(ws, workspace, { ...source, reference });
      }
      // No release: the snapshot in hand is the head, so its commit is the
      // pin, set before planning so the plan and the receipt name it.
      const headCommit = commitOf(snapshot);
      if (!headCommit) {
        throw Object.assign(new Error('this repository has no version tags, and the commit that was fetched could not be read, '
          + 'so there is nothing exact to install; paste a link that names a commit'), { code: 'no-tags' });
      }
      source = { ...source, reference: headCommit };
    }
    if (classified.kind === 'content') {
      const plan = contentPlan(workspace, snapshot, source);
      const displayName = readPackageDisplayName(snapshot);
      const token = holdPending(ws, { kind: 'content', snapshot, plan, workspace, commit: commitOf(snapshot), displayName });
      ws.send(JSON.stringify({ type: 'package_import_plan', operation: 'plan', token, plan, ...(displayName ? { displayName } : {}) }));
      return;
    }
    // The bytes are an extension and the link named no reference, so the
    // pin is derived rather than asked for: the repository's newest version
    // tag, chosen by the record module's one semver ordering (latestTag),
    // from the same ref lister the update check takes as a dependency. The
    // head snapshot was then read only to classify; it is discarded and the
    // resolved tag's own bytes are acquired through the same flow, so the
    // facts the trust step derives are facts about exactly the bytes that
    // would land. A repository with no version tags installs the exact
    // commit just fetched, as a content package does: the snapshot in hand
    // is already those bytes, the pin is that commit, and under the
    // tags-only rule it is never offered an update (decided 2026-09-24).
    if (!source.reference) {
      const release = newestRelease(extensionDeps.listRefs(source.url));
      if (release) {
        discardAcquisition(snapshot);
        snapshot = null;
        return beginPackagePlan(ws, workspace, { ...source, reference: release });
      }
      const fetched = commitOf(snapshot);
      if (!fetched) {
        throw Object.assign(new Error('this repository has no version tags, and the commit that was fetched could not be read, '
          + 'so there is nothing exact to install; paste a link that names a commit'), { code: 'no-tags' });
      }
      // Pinned to exactly the bytes in hand, so there is no reference whose
      // fetched kind needs checking: the pin is the commit itself.
      source = { ...source, reference: fetched };
    } else {
      requirePin(source);
      // Never from a branch: the fetch says what the reference was, and only
      // a tag or an exact commit goes on to the trust step. The catch below
      // discards the snapshot.
      requireFixedPin(source, extensionDeps.pinKindOf(snapshot));
    }
    const commit = commitOf(snapshot);
    const plan = planExtensionInstall(workspace, snapshot, commit ? { ...source, commit } : source);
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
  if (!workspace) return installFail(ws, 'plan', null, new Error('No workspace is open.'));
  let source;
  try {
    source = parseGitHubSource(msg.url, msg.reference);
  } catch (e) {
    return installFail(ws, 'plan', null, e);
  }
  beginPackagePlan(ws, workspace, source);
}

// The offer a token names is confirmed against the workspace it was shown
// on: a server that has since moved to another workspace must not install
// into whatever is current now. The token dies with its use either way.
function takePending(ws, operation, token, workspace, requestId) {
  const pending = pendingInstalls.get(token);
  if (!pending) {
    installFail(ws, operation, token, new Error('nothing is awaiting this confirmation; read the package again'), requestId);
    return null;
  }
  releasePending(token);
  if (pending.workspace !== workspace) {
    discardAcquisition(pending.snapshot);
    installFail(ws, operation, token, Object.assign(
      new Error('the workspace changed since this package was read; read it again'),
      { code: 'workspace-changed' },
    ), requestId);
    return null;
  }
  return pending;
}

function handleConfirmExtensionInstall(ctx, ws, msg) {
  const workspace = getWorkspace();
  if (!workspace) return installFail(ws, 'install', msg.token, new Error('No workspace is open.'));
  const pending = takePending(ws, 'install', msg.token, workspace);
  if (!pending) return;
  if (pending.kind !== 'extension') {
    discardAcquisition(pending.snapshot);
    return installFail(ws, 'install', msg.token, new Error('this offer holds agents and skills, not an extension; answer it as the offer it is'));
  }
  try {
    const record = installExtension(workspace, pending.snapshot, pending.plan);
    // The file tree lists what an enabled record claims, from a cache the
    // root owns: every record write, install and update alike, tells it so
    // the next tree a client reads carries the change.
    ctx.workspace.noteExtensionRecordsChanged();
    // THE INSTALL HAS HAPPENED once installExtension returns, so from here
    // the reply must say so whatever else goes wrong: the catch below is
    // for the install itself. The roster after the write rides on the
    // reply, the way the manage replies carry theirs, so a live mount of an
    // updated extension is reconciled from this very message rather than a
    // round trip later; it is read BEFORE the content offer takes a token,
    // because a roster read that throws after a token was issued would
    // leave that token pointing at the snapshot the failure path discards.
    // When the roster cannot be read, the install is still reported as
    // done, naming the roster error, with no roster on the reply (the
    // client reads a missing roster as nothing to reconcile) and no content
    // offer: reading the package again reopens that offer, whereas a
    // failure report here would invite re-running, and so re-consenting
    // to, an install that already happened.
    let extensions = null;
    let rosterError = null;
    try {
      extensions = listExtensions(workspace);
    } catch (e) {
      rosterError = e && e.message ? e.message : String(e);
    }
    // The content half, when there is one, becomes the next offer under a
    // token of its own: the snapshot stays held until that answer arrives.
    let content = null;
    if (rosterError === null && pending.content) {
      const token = holdPending(ws, { kind: 'content', snapshot: pending.snapshot, plan: pending.content, workspace, commit: pending.plan.source.commit || null, displayName: pending.plan.manifest.displayName || null });
      content = { token, plan: pending.content };
    }
    ws.send(JSON.stringify({ type: 'extension_install_result', operation: 'install', token: msg.token, record, content, extensions, rosterError }));
    if (rosterError === null) broadcastRoster(ctx, ws, workspace);
    if (!content) discardAcquisition(pending.snapshot);
  } catch (e) {
    discardAcquisition(pending.snapshot);
    installFail(ws, 'install', msg.token, e);
  }
}

// An approval's source against the one an offer's plan named: exactly its
// id and its reference, with no other field.
function sameSource(source, offered) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return false;
  const keys = Object.keys(source).sort();
  return keys.length === 2 && keys[0] === 'id' && keys[1] === 'reference'
    && source.id === offered.id && source.reference === offered.reference;
}

// The content offer's answer: the approval object is used exactly as
// submitted, the evaluator is the sole authority on whether it still
// describes reality, and the snapshot the offer was read from is the one
// the writes come from.
function handleConfirmPackageInstall(ctx, ws, msg) {
  const workspace = getWorkspace();
  if (!workspace) return installFail(ws, 'apply', msg.token, new Error('No workspace is open.'), msg.requestId);
  const pending = takePending(ws, 'apply', msg.token, workspace, msg.requestId);
  if (!pending) return;
  try {
    if (pending.kind !== 'content') throw new Error('this offer holds an extension; answer it at its trust step');
    // The receipt records the approval's source and the update check reads
    // it, so the source must be the one this offer named: the same id and
    // reference, and nothing else (the commit is the server's own, from the
    // snapshot it holds).
    if (!sameSource(msg.approval && msg.approval.source, pending.plan.source)) {
      throw Object.assign(new Error('the approval names a different source than this offer; read the package again'), { code: 'stale' });
    }
    const result = applyImport(workspace, pending.snapshot, msg.approval, { receipt: { commit: pending.commit, displayName: pending.displayName } });
    // The link flow lands the same agent and skill files the typed path
    // does, so it tells the cache cascade under the same rule as
    // handleApplyPackageImport above: only when something actually landed.
    if (result.writes.length > 0) {
      ctx.agents.invalidateAgentCache();
      ctx.agents.flagRosterRefresh();
    }
    sendImportResult(ws, 'apply', msg.token, msg.requestId, result);
  } catch (e) {
    installFail(ws, 'apply', msg.token, e, msg.requestId);
  } finally {
    discardAcquisition(pending.snapshot);
  }
}

function handleDeclinePackageInstall(ctx, ws, msg) {
  discardPending(msg.token);
  ws.send(JSON.stringify({ type: 'package_install_declined', operation: 'decline', token: msg.token }));
}

// ---- Checking a package for an update (decided 2026-09-24): only when the
// person asks or opens Packages, never in the background. Git runs off the
// handler, one package at a time through one queue, and a repository's tag
// listing is reused for an hour, so opening the page again costs nothing.

const { installedPackages, packageCards } = require('../../packages/package-state.js');
const { checkPackageUpdate } = require('../../packages/package-check.js');

const PACKAGE_CHECK_TTL_MS = 60 * 60 * 1000;
const packageCheckCache = new Map();
let packageCheckQueue = Promise.resolve();
function resetPackageCheckCache() { packageCheckCache.clear(); }

function releaseTags(url) {
  const hit = packageCheckCache.get(url);
  if (hit && extensionDeps.now() - hit.at < PACKAGE_CHECK_TTL_MS) return Promise.resolve(hit.tags);
  const run = packageCheckQueue.then(() => extensionDeps.listTagCommits(url));
  packageCheckQueue = run.catch(() => {});
  return run.then((tags) => { packageCheckCache.set(url, { at: extensionDeps.now(), tags }); return tags; });
}

async function handleCheckPackageUpdate(ctx, ws, msg) {
  const named = msg && typeof msg.source === 'string' ? msg.source : null;
  const workspace = getWorkspace();
  let targets;
  try {
    if (!workspace) throw new Error('No workspace is open.');
    const all = installedPackages(workspace);
    targets = named ? all.filter((p) => p.id === named) : all;
    if (named && targets.length === 0) throw new Error(`No package from ${named} is installed.`);
  } catch (e) {
    installFail(ws, 'package-update-check', null, e, undefined, { id: named });
    ws.send(JSON.stringify({ type: 'package_update_checked', operation: 'package-update-check', token: null, id: named, count: 0 }));
    return;
  }
  for (const pkg of targets) {
    try {
      // A package with no release to compare, or from a folder, is answered
      // from its own facts: git is never asked about it.
      const answered = checkPackageUpdate(pkg, []);
      const status = answered.outcome === 'no-release' || answered.outcome === 'not-updatable' ? answered
        // The stored id is revalidated before it reaches a git argv.
        : checkPackageUpdate(pkg, await releaseTags(parseGitHubSource(pkg.id).url));
      ws.send(JSON.stringify({ type: 'package_update_status', operation: 'package-update-check', token: null, ...status }));
    } catch (e) {
      installFail(ws, 'package-update-check', null, e, undefined, { id: pkg.id });
    }
  }
  // The check has answered for every package it was asked about, including
  // none, so the page can stop saying it is checking.
  ws.send(JSON.stringify({ type: 'package_update_checked', operation: 'package-update-check', token: null, id: named, count: targets.length }));
}

// ---- Planning a package update as one unit. The package is named by its
// source and the release to move to; the source is read from the installed
// package, never from the message, and the release must be one the check
// itself reports as newer, so a downgrade or a moved tag can never be
// planned. The new version is acquired through the same flow an install
// uses, held under a token, and offered as one review: the extension's
// trust facts beside every agent, skill and starter file classified.

const { buildUpdatePlan } = require('../../packages/package-update-plan.js');

// What the new version of an extension may do that the installed one could
// not, so the review names each new power in the trust card's own words.
function addedPrivileges(workspace, pkg, manifest) {
  const before = (pkg.extension && recordFor(readExtensionRecords(workspace), pkg.extension)) || {};
  const beforeAsks = Array.isArray(before.asks) ? before.asks : [];
  return {
    writes: manifest.writes === true && before.writes !== true,
    sources: manifest.sources === true && before.sources !== true,
    asks: (Array.isArray(manifest.asks) ? manifest.asks : []).filter((id) => !beforeAsks.includes(id)),
  };
}

async function handlePlanPackageUpdate(ctx, ws, msg) {
  const named = msg && typeof msg.source === 'string' ? msg.source : null;
  const fail = (e) => installFail(ws, 'package-update-plan', null, e, undefined, { id: named });
  let snapshot = null;
  try {
    const workspace = getWorkspace();
    if (!workspace) throw new Error('No workspace is open.');
    const pkg = installedPackages(workspace).find((p) => p.id === named);
    if (!pkg) throw new Error(`No package from ${named} is installed.`);
    const source = parseGitHubSource(pkg.id, msg.reference);
    const status = checkPackageUpdate(pkg, await releaseTags(source.url));
    if (!status.newer.includes(source.reference)) {
      throw Object.assign(new Error(`${source.reference} isn't a newer release of this package.`), { code: 'not-newer' });
    }
    snapshot = extensionDeps.acquire(source);
    const commit = commitOf(snapshot);
    const classified = classifySnapshot(snapshot);
    let extension = null;
    if (classified.kind === 'extension') {
      requireFixedPin(source, extensionDeps.pinKindOf(snapshot)); // an update is code, held to the install's rule
      extension = planExtensionInstall(workspace, snapshot, commit ? { ...source, commit } : source);
      if (pkg.extension && extension.manifest.name !== pkg.extension) {
        throw Object.assign(new Error(`The update for "${pkg.extension}" declares the name "${extension.manifest.name}", so nothing was installed.`), { code: 'name-changed' });
      }
    }
    const hasContent = classified.kind === 'content' || extension.facts.agents || extension.facts.skills;
    const update = hasContent ? buildUpdatePlan(workspace, snapshot, pkg, source) : null;
    // Where each kept item's author version will be saved, so the review and
    // the prompt name the real file.
    for (const entries of Object.values(update ? update.groups : {})) {
      for (const entry of entries) if (entry.saveAuthor) entry.saved = reviewPath(pkg.id, source.reference, entry.destination);
    }
    const token = holdPending(ws, { kind: 'update', snapshot, update, extension, pkg, source, commit, workspace });
    ws.send(JSON.stringify({
      type: 'package_update_plan', operation: 'package-update-plan', token, id: pkg.id,
      from: pkg.reference, to: source.reference,
      extension: extension ? { manifest: extension.manifest, facts: extension.facts, replaces: extension.replaces, added: addedPrivileges(workspace, pkg, extension.manifest) } : null,
      ...(update || { approval: null, groups: {} }),
    }));
  } catch (e) {
    discardAcquisition(snapshot);
    fail(e);
  }
}

// Confirming an update. The approval is the held plan's own, never the
// message's: the review offers no per-item choices (B+), so nothing the
// client sends can widen what is written. Refused while a routine of an
// agent it would rewrite is running. Everything lands in one transaction.
const { updateExtras, reviewPath, updatesFolderSize, clearUpdatesFolder } = require('../../packages/package-update-apply.js');
const { writeAsUnit } = require('../../workspace/atomic-write.js');
const scheduler = require('../../scheduler.js');

function runningAffected(approval) {
  const agents = new Set(approval.items.filter((i) => i.kind === 'agent' && i.decision === 'overwrite').map((i) => i.slug));
  return extensionDeps.runningRuns().filter((run) => agents.has(run.agent));
}

function handleConfirmPackageUpdate(ctx, ws, msg) {
  const workspace = getWorkspace();
  if (!workspace) return installFail(ws, 'package-update', msg.token, new Error('No workspace is open.'), msg.requestId);
  const pending = takePending(ws, 'package-update', msg.token, workspace, msg.requestId);
  if (!pending) return;
  try {
    if (pending.kind !== 'update') throw new Error('This offer is not a package update.');
    const approval = pending.update && pending.update.approval;
    const busy = approval ? runningAffected(approval) : [];
    if (busy.length) {
      throw Object.assign(new Error(`Wait for ${busy.map((r) => `${r.agent}'s ${r.routine} run`).join(', ')} to finish, then update.`), { code: 'routine-running' });
    }
    const extra = (evaluation) => updateExtras(workspace, pending.snapshot, pending, evaluation);
    const result = approval
      ? applyImport(workspace, pending.snapshot, approval, {
        extra, afterStep: extensionDeps.afterStep,
        // What the new version no longer carries rides on the update, so the
        // receipt lists each as kept.
        receipt: {
          commit: pending.commit, displayName: readPackageDisplayName(pending.snapshot),
          update: { from: pending.pkg.reference, to: pending.source.reference, retired: pending.update.groups.retired || [] },
        },
      })
      : { status: 'ready', writes: [], ...writeExtrasOnly(workspace, pending, extra) };
    if (result.writes.length > 0) {
      ctx.agents.invalidateAgentCache();
      ctx.agents.flagRosterRefresh();
    }
    const landed = result.status === 'ready';
    if (landed && pending.extension) ctx.workspace.noteExtensionRecordsChanged();
    ws.send(JSON.stringify({
      type: 'package_update_result', operation: 'package-update', token: msg.token, requestId: msg.requestId,
      id: pending.pkg.id, to: pending.source.reference, status: result.status,
      writes: result.writes, unchanged: result.unchanged || [], skipped: result.skipped || [], blocked: result.blocked || [], stale: result.stale || [],
      receipt: result.receipt || null, groups: pending.update ? pending.update.groups : {},
      ...(landed && pending.extension ? { extensions: listExtensions(workspace), allOff: readAllOff(workspace) } : {}),
    }));
    if (landed && pending.extension) broadcastRoster(ctx, ws, workspace);
  } catch (e) {
    installFail(ws, 'package-update', msg.token, e, msg.requestId);
  } finally {
    discardAcquisition(pending.snapshot);
  }
}

// An update that carries only an extension: its writes, in one transaction.
function writeExtrasOnly(workspace, pending, extra) {
  const { writes, replaceDirs } = extra({ writes: [] });
  writeAsUnit(workspace, writes, { replaceDirs, afterStep: extensionDeps.afterStep });
  return { receipt: null };
}

// EVERY OTHER WINDOW IS TOLD, not only the one that asked. A record that
// changed (enabled, disabled, installed, uninstalled, or every extension
// switched off) changes what every window may mount, and a window that is
// not told keeps a live mount of an extension somebody just turned off. The
// asker's own reply already carries the roster, so it is skipped here.
function broadcastRoster(ctx, ws, workspace) {
  let payload;
  try {
    payload = JSON.stringify({ type: 'extensions', extensions: listExtensions(workspace), allOff: readAllOff(workspace) });
  } catch (e) { return; }
  for (const client of ctx.clients || []) {
    if (client === ws || client.readyState !== 1) continue;
    try { client.send(payload); } catch (e) { /* a closing socket hears nothing */ }
  }
}

// ---- The manage page: enablement on the record, and the page's one read.

const { setExtensionEnabled, setExtensionsAllOff, listReceipts } = require('../../packages/extension-manage.js');
const { readAllOff } = require('../../packages/extension-record.js');

function handleSetExtensionEnabled(ctx, ws, msg) {
  const workspace = getWorkspace();
  const name = msg && typeof msg.name === 'string' ? msg.name : '';
  if (!workspace) return installFail(ws, 'set-enabled', null, new Error('No workspace is open.'), undefined, { name });
  try {
    const outcome = setExtensionEnabled(workspace, name, msg.enabled);
    // The tree lists what an enabled record claims, so a flag that changed
    // is a tree that changed.
    ctx.workspace.noteExtensionRecordsChanged();
    ws.send(JSON.stringify({ type: 'extension_state', operation: 'set-enabled', token: null, ...outcome, extensions: listExtensions(workspace), allOff: readAllOff(workspace) }));
    broadcastRoster(ctx, ws, workspace);
  } catch (e) {
    installFail(ws, 'set-enabled', null, e, undefined, { name });
  }
}

// The switch for every extension at once. Each extension's own setting is
// left exactly as it was, so turning the switch back restores it.
function handleSetExtensionsAllOff(ctx, ws, msg) {
  const workspace = getWorkspace();
  if (!workspace) return installFail(ws, 'set-all-off', null, new Error('No workspace is open.'));
  try {
    const outcome = setExtensionsAllOff(workspace, msg && msg.off);
    ctx.workspace.noteExtensionRecordsChanged();
    ws.send(JSON.stringify({ type: 'extension_state', operation: 'set-all-off', token: null, ...outcome, extensions: listExtensions(workspace) }));
    broadcastRoster(ctx, ws, workspace);
  } catch (e) {
    installFail(ws, 'set-all-off', null, e);
  }
}

function handleGetPackagesPage(ctx, ws) {
  const workspace = getWorkspace();
  if (typeof workspace !== 'string' || workspace.trim() === '') {
    ws.send(JSON.stringify({ type: 'packages_page_error', reason: 'No workspace is open.' }));
    return;
  }
  try {
    ws.send(JSON.stringify({ type: 'packages_page', extensions: listExtensions(workspace), allOff: readAllOff(workspace), receipts: listReceipts(workspace), packages: packageCards(workspace), updatesFolder: updatesFolderSize(workspace) }));
  } catch (e) {
    const r = readable(e, { action: 'read your packages' });
    ws.send(JSON.stringify({ type: 'packages_page_error', reason: r.message, detail: r.detail }));
  }
}

// ---- Uninstalling a package (package-uninstall.js). The plan names what
// goes and what stays; the confirm names the plan it answers by its key, and
// the server reads the workspace again, so nothing the confirmation did not
// list is removed. Refused while a routine of an agent it removes is running.
const { planUninstall, applyUninstall } = require('../../packages/package-uninstall.js');

function handlePlanPackageUninstall(ctx, ws, msg) {
  const id = msg && typeof msg.source === 'string' ? msg.source : null;
  try {
    const workspace = getWorkspace();
    if (!workspace) throw new Error('No workspace is open.');
    ws.send(JSON.stringify({ type: 'package_uninstall_plan', operation: 'package-uninstall-plan', token: null, ...planUninstall(workspace, id) }));
  } catch (e) {
    installFail(ws, 'package-uninstall-plan', null, e, undefined, { id });
  }
}

function handleConfirmPackageUninstall(ctx, ws, msg) {
  const id = msg && typeof msg.source === 'string' ? msg.source : null;
  try {
    const workspace = getWorkspace();
    if (!workspace) throw new Error('No workspace is open.');
    const removing = new Set(planUninstall(workspace, id).goes.filter((g) => g.kind === 'agent').map((g) => g.label));
    const busy = extensionDeps.runningRuns().filter((run) => removing.has(run.agent));
    if (busy.length) {
      throw Object.assign(new Error(`Wait for ${busy.map((r) => `${r.agent}'s ${r.routine} run`).join(', ')} to finish, then uninstall.`), { code: 'routine-running' });
    }
    const plan = applyUninstall(workspace, id, msg.key, { afterStep: extensionDeps.afterStep });
    // Removed agents leave the roster, so their routines stop with them, and
    // a conversation already underway picks up the smaller team.
    ctx.agents.invalidateAgentCache();
    ctx.agents.flagRosterRefresh();
    if (plan.extension) ctx.workspace.noteExtensionRecordsChanged();
    ws.send(JSON.stringify({
      type: 'package_uninstall_result', operation: 'package-uninstall', token: null, requestId: msg.requestId,
      id, title: plan.title, removed: plan.goes, kept: plan.stays,
      extensions: listExtensions(workspace), allOff: readAllOff(workspace),
    }));
    broadcastRoster(ctx, ws, workspace);
  } catch (e) {
    installFail(ws, 'package-uninstall', null, e, msg && msg.requestId, { id });
  }
}

// Clear the folder updates save the author's versions and backups in.
function handleClearPackageUpdates(ctx, ws) {
  const workspace = getWorkspace();
  try {
    if (!workspace) throw new Error('No workspace is open.');
    clearUpdatesFolder(workspace);
  } catch (e) {
    return installFail(ws, 'clear-package-updates', null, e);
  }
  handleGetPackagesPage(ctx, ws);
}

module.exports = {
  handlePlanPackageImport, handleEvaluatePackageDecisions, handleApplyPackageImport,
  handleListExtensions, handleGetExtensionUi,
  handlePlanPackageInstall,
  handleConfirmExtensionInstall, handleConfirmPackageInstall, handleDeclinePackageInstall,
  handleCheckPackageUpdate, resetPackageCheckCache, handlePlanPackageUpdate, handleConfirmPackageUpdate, handleClearPackageUpdates,
  handlePlanPackageUninstall, handleConfirmPackageUninstall,
  handleSetExtensionEnabled, handleSetExtensionsAllOff, handleGetPackagesPage,
  wireExtensionDeps,
};
