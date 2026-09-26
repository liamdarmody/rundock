#!/usr/bin/env node
'use strict';
// Break each of the extension host's guards in turn and report which tests
// notice.
//
// Every rule here is a trust rule: the sandbox posture, the closed message
// table, the watchdog, the degrade path, the teardown, the path guard. Each
// can be deleted with the product still rendering SOMETHING, which is why a
// green suite proves nothing about them until each is broken on purpose and
// a test goes red for it. A guard whose mutation turns nothing red is
// reported as a FAILURE rather than passed over.
//
//   node test/tools/mutate-extension-host-guards.js            # report
//   node test/tools/mutate-extension-host-guards.js --markdown # the same, as a table
//
// The files are restored afterwards, including when a run throws. The
// harness is the same shape as its siblings and deliberately a separate
// copy, for the reason stated in mutate-routines-guards.js.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const { beginMutationRun } = require('./mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');

// The host, watched by the suite that mounts it in a real DOM and reads the
// wire.
const HOST = { src: path.join(ROOT, 'public', 'extension-host.js'), suite: 'test/unit/extension-host.test.js' };
// The same host, watched by one named real-engine test: a suite written
// `test/e2e/<spec>.spec.js#<test title>` runs that test in Chromium (see
// redTests), for the guards whose proof the criteria name as a real engine.
const HOST_E2E = (title) => ({ src: path.join(ROOT, 'public', 'extension-host.js'), suite: `test/e2e/trust-boundary.spec.js#${title}` });
// The client registry and the file view's seam over it.
const REGISTRY = { src: path.join(ROOT, 'public', 'renderer-registry.js'), suite: 'test/unit/renderer-registry.test.js' };
// The server's payload reader, watched where its path guard is driven with a
// record that tries to escape. The install-store rules it reads under are
// the host-wiring harness's rows; this one keeps the path guard.
const SERVER = { src: path.join(ROOT, 'lib', 'packages', 'extension-registry.js'), suite: 'test/unit/extension-host.test.js' };
// The file view's seam and its shared mount release, watched by the suite
// that cuts them from source and drives them.
const FILES = { src: path.join(ROOT, 'public', 'views', 'files.js'), suite: 'test/unit/renderer-registry.test.js' };
const SERVICE = { src: path.join(ROOT, 'public', 'region-service.js'), suite: 'test/unit/region-service.test.js' };
const ROUTER = { src: path.join(ROOT, 'lib', 'http-router.js'), suite: 'test/unit/http-router-lib.test.js' };
const GUARDS = { src: path.join(ROOT, 'electron', 'extension-frame-guards.js'), suite: 'test/unit/extension-frame-guards.test.js' };
// The one rule for a file an extension may be handed or may write, and the
// server paths that state and hold it; watched by the suite that plants links
// and hard links under its own temporary root.
const EXTFILE = { src: path.join(ROOT, 'lib', 'workspace', 'extension-file.js'), suite: 'test/unit/extension-file.test.js' };
const FILEHANDLERS = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'files.js'), suite: 'test/unit/extension-file.test.js' };
const ROUTER_FILE = { src: path.join(ROOT, 'lib', 'http-router.js'), suite: 'test/unit/extension-file.test.js' };
// The page's half: it forwards the server's answer and reads no answer as a
// refusal. Watched by the suite that cuts these pieces from source.
const FILES_CLIENT = { src: path.join(ROOT, 'public', 'views', 'files.js'), suite: 'test/unit/extension-file-client.test.js' };
const REGIONS = { src: path.join(ROOT, 'public', 'editor', 'plugins', 'regions.js'), suite: 'test/unit/extension-file-client.test.js' };
// Named sources and asking an agent: the resolver and its
// write, the transport, the manifest and payload, the page's seam and the
// app's ask, each watched by the suite that drives it.
const RESOLVER = { src: path.join(ROOT, 'lib', 'workspace', 'named-sources.js'), suite: 'test/unit/named-sources.test.js' };
const GRAMMAR = { src: path.join(ROOT, 'public', 'named-sources-model.js'), suite: 'test/unit/named-sources.test.js' };
const TRANSPORT = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'sources.js'), suite: 'test/unit/named-sources-transport.test.js' };
const MANIFEST = { src: path.join(ROOT, 'lib', 'packages', 'extension-manifest.js'), suite: 'test/unit/extension-privileges.test.js' };
const PAYLOAD = { src: path.join(ROOT, 'lib', 'packages', 'extension-registry.js'), suite: 'test/unit/extension-privileges.test.js' };
const CARD = { src: path.join(ROOT, 'public', 'packages-install-model.js'), suite: 'test/unit/extension-privileges.test.js' };
const SEAM = { src: path.join(ROOT, 'public', 'views', 'files.js'), suite: 'test/unit/renderer-registry.test.js' };
const ASK_APP = { src: path.join(ROOT, 'public', 'views', 'conversations.js'), suite: 'test/unit/ask-agent.test.js' };
const PAGE_LINKS = { src: path.join(ROOT, 'public', 'external-links.js'), suite: 'test/unit/external-links.test.js' };
const DESKTOP_LINKS = { src: path.join(ROOT, 'electron', 'external-links.js'), suite: 'test/unit/external-links.test.js' };
const EDITOR_LINKS = { src: path.join(ROOT, 'public', 'editor', 'index.js'), suite: 'test/unit/wikilink-delegate.test.js' };
const RENDER_LINKS = { src: path.join(ROOT, 'public', 'markdown-render.js'), suite: 'test/unit/markdown-render.test.js' };
const EXTFILE_NS = { src: path.join(ROOT, 'lib', 'workspace', 'extension-file.js'), suite: 'test/unit/extension-file.test.js' };

const MUTATIONS = [
  // ===== A USER ACTION GRANTS ONE REQUEST, IN A REAL ENGINE =====
  // Each production guard behind these proofs, broken in the host itself,
  // with the named Chromium test that must turn red for it.
  [HOST_E2E('a script-sent ask with no user action at all is refused with its reason and shows the refusal line, never the bar'),
    'a request with no user action at all is refused, never put to the person',
    "  if (!hasUserActivation(win)) {\n    lapsed(activationOf(win));\n    return 'refuse';",
    "  if (!hasUserActivation(win)) {\n    lapsed(activationOf(win));\n    return 'confirm';"],
  [HOST_E2E('a real key press inside the view grants one ask; the same view\'s script-sent ask with no key press is refused'),
    'in a view the person uses from the keyboard, a script-sent ask with no key press is refused',
    "  if (!hasUserActivation(win)) {\n    lapsed(activationOf(win));\n    return 'refuse';",
    "  if (!hasUserActivation(win)) {\n    lapsed(activationOf(win));\n    return 'click';"],
  [HOST_E2E('a real key press inside the view grants one ask; the same view\'s script-sent ask with no key press is refused'),
    'the activation a real key press sets is what grants the ask',
    '  return !!(activation && activation.isActive);',
    '  return false;'],
  [HOST_E2E('the ask on the bar: one click drafts one; the next waits on the bar, a press before it arms drafts nothing, and only a press after it drafts'),
    'the ask bar is unarmed when it appears, so a press before it arms drafts nothing',
    "  const open = ui.button({ label: 'Open', variant: 'primary', onClick: answer(onOpen), disabled: true });",
    "  const open = ui.button({ label: 'Open', variant: 'primary', onClick: answer(onOpen) });"],
  [HOST_E2E('the armed Open drafts exactly the waiting ask, agent and message, and tells the view nothing'),
    "the bar's Open performs the waiting ask",
    '        onOpen: () => { if (alive) perform(); },',
    '        onOpen: () => {},'],
  [HOST_E2E('Dismiss on the ask bar tells the view only that it was refused, and drafts nothing'),
    'Dismiss refuses the waiting ask and performs nothing',
    "        onDismiss: () => send({ type: 'refused', of, reason: REQUEST_REASONS.dismissed }),",
    '        onDismiss: () => { if (alive) perform(); },'],
  [HOST_E2E('the armed Open drafts exactly the waiting ask, agent and message, and tells the view nothing'),
    "the bar's Open drafts the waiting ask's own message",
    '          ? opts.onAsk(data.agent, message)',
    "          ? opts.onAsk(data.agent, '')"],
  [HOST_E2E('the armed Open drafts exactly the waiting ask, agent and message, and tells the view nothing'),
    "the bar's Open drafts to the waiting ask's own agent",
    '          ? opts.onAsk(data.agent, message)',
    '          ? opts.onAsk(asks[asks.length - 1], message)'],
  // ===== AN EMBEDDED VIEW IS READ-ONLY AND REACHES NO OTHER FILE =====
  [HOST, 'an embedded view cannot write or open another file, whatever its manifest declared',
    "    if (embedded && (data.type === 'open' || data.type === 'save' || data.type === 'change')) {", '    if (false) {'],
  // ===== CHANGE IS GATED ON THE SAME DECLARATION AS SAVE =====
  [HOST, 'change is honoured only for an extension that declared writes',
    "        send({ type: 'refused', of: 'change', reason: 'this extension did not declare writes in its manifest' });\n        return;\n", ''],
  // ===== THE POSTURE =====
  // Widen the sandbox and the frame gains the app's origin: the one
  // combination the contract forbids in as many words.
  [HOST, 'the sandbox grants scripts and nothing else',
    "    frame.setAttribute('sandbox', 'allow-scripts');",
    "    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');"],
  // The frame CSP is the contract's no-network enforcement; weakening it must
  // redden the posture test, or the no-network claim rests on nothing.
  [HOST, "the frame document denies the network with default-src 'none'",
    'const FRAME_CSP = "default-src \'none\'; script-src \'unsafe-inline\'; "',
    'const FRAME_CSP = "default-src * ; script-src \'unsafe-inline\'; "'],
  // Drop the closing-tag escaping and a payload can break out of its own
  // script element, so the view never says ready.
  [HOST, 'the inlined payload cannot close its own element',
    "  return String(text || '').split(`</${tag}`).join(`<\\\\/${tag}`);",
    "  return String(text || '');"],

  // ===== THE CLOSED TABLE =====
  // Silence instead of refusal: the extension never learns it was refused
  // and an audit never sees the attempt.
  [HOST, 'a message outside the contract is refused with a reason, on the wire',
    "      send({ type: 'refused', of: verdict.of, reason: verdict.reason });\n      return;\n    }\n    const data = event.data;",
    '      return;\n    }\n    const data = event.data;'],
  // Shrink the table without touching the document and the two-way check
  // must fail naming the drift.
  [HOST, 'the enforced table and the published table cannot drift apart',
    "  open: { target: (v) => typeof v === 'string' && v.length > 0 },\n",
    ''],

  // ===== THE DEGRADE PATH =====
  [HOST, 'a view that never starts is torn down by the clock',
    '    readyTimer = win.setTimeout(() => {\n      degrade(`the extension did not start within ${readyTimeoutMs}ms`);\n    }, readyTimeoutMs);',
    ''],
  [HOST, 'a reported failure tears the frame down rather than leaving it',
    "    if (data.type === 'error') {\n      degrade(`the extension reported a failure: ${data.message}`);\n      return;\n    }",
    "    if (data.type === 'error') {\n      return;\n    }"],

  // ===== THE TEARDOWN =====
  [HOST, 'an update under a live mount tears the old frame down first',
    '    swap(newPayload) {\n      teardown();',
    '    swap(newPayload) {'],

  // ===== THE REGISTRY =====
  // The bare-claim collision. Rewritten when marker claims arrived: a target
  // now holds a slot with one bare claim beside a claim per marker, so the
  // guard moved from a map lookup to the slot's own bare field. The rule it
  // proves is unchanged, which is why this row was repointed rather than
  // retired: two bare claims on one target cannot both render it.
  [REGISTRY, 'two claims on one target cannot both render it',
    '            if (slot.bare) {\n              refusals.push({ extension: ext.id, target,\n                reason: `Files ending "${target}" are already rendered by ${slot.bare.extension}.` });\n              continue;\n            }',
    ''],
  [REGISTRY, 'an unregistered target is an answer with a reason, never an invented renderer',
    '      if (!slot) {\n        return { registered: false, reason: `no installed extension renders "${target}"` };\n      }',
    "      if (!slot) {\n        return { registered: true, extension: 'unknown', renderer: 'unknown' };\n      }"],
  // Widen the grammar to accept multi-segment targets the last-dot lookup can
  // never match, and the quiet-shadowing refusal this module exists to
  // prevent comes back.
  [REGISTRY, 'the accepted grammar is a single segment the lookup can honour',
    "  return /^\\.[a-z0-9][a-z0-9-]*$/.test(normaliseTarget(target));",
    "  return /^\\.[a-z0-9][a-z0-9.-]*$/.test(normaliseTarget(target));"],

  // ===== THE CLAMP =====
  // Assign the raw height and a hostile view stretches the page exactly as
  // the contract says it cannot.
  [HOST, 'the requested height is clamped to the published bounds',
    '      const h = Math.max(MIN_FRAME_HEIGHT, Math.min(MAX_FRAME_HEIGHT, data.height));',
    '      const h = data.height;'],

  // ===== THE REAL WIRE =====
  // Remove the listener registration and the host mediates nothing a real
  // frame posts; remove its teardown and a stale listener survives the mount.
  [HOST, 'the mediator is bound to the window on mount',
    "    win.addEventListener('message', onMessage);\n",
    ''],
  [HOST, 'the mediator is unbound on teardown',
    "    alive = false;\n    win.removeEventListener('message', onMessage);",
    '    alive = false;'],

  // ===== THE PATH GUARD =====
  // Let a manifest walk out of its own directory and the server reads
  // whatever the workspace holds on the extension's behalf.
  [SERVER, 'a payload path resolves inside the extension directory or not at all',
    '  if (real === realRoot || real.startsWith(realRoot + path.sep)) return real;\n  return null;',
    '  return real;'],
  // ===== THE FILE VIEW'S MOUNT LIFECYCLE =====
  // Remove the token guard and two opens of one path both mount, leaking the
  // first frame and repainting over the second.
  [FILES, 'a superseded open neither mounts nor degrades',
    '    if (superseded()) return;\n    // NAMED SOURCES, only for',
    '    // NAMED SOURCES, only for'],
  [SEAM, 'an open superseded while its sources are in flight does not mount',
    '    if (!ready || superseded()) return;\n    const [host, payload, resolved, viewState] = ready;',
    '    if (!ready) return;\n    const [host, payload, resolved, viewState] = ready;'],
  // Remove the release before the board-or-seam decision and a live mount
  // survives a file open.
  [FILES, 'every file open releases the live mount before it decides',
    '    releaseExtensionMount();\n    const surface = plainSurfaceFor(viewers, path, content);',
    '    const surface = plainSurfaceFor(viewers, path, content);'],
  // Remove the release in closeOpenFile and a mount survives a workspace
  // switch. Repointed when region services began stopping in the same place:
  // the rule is unchanged and only what follows the line moved, so the row
  // follows the line. Quoting the call alone rather than the pair, because
  // this proves the RELEASE happens and its neighbour is somebody else's row.
  [FILES, 'a workspace switch releases the live mount',
    '  releaseExtensionMount();\n  // And the render services go too',
    '  // And the render services go too'],
  // And the services stop with it: a service holds a frame running code
  // installed in the workspace being left, so leaving one alive carries one
  // workspace's third-party code into the next.
  [FILES, 'a workspace switch stops the region render services',
    '  stopRegionServices();\n  currentFilePath = null;',
    '  currentFilePath = null;'],
  // ===== CONFINEMENT: A FRAME CANNOT LEAVE, CHOOSE ITS FILE, OR ACT UNASKED =====
  // Measured on 2026-09-22: a sandboxed frame may always navigate itself, and
  // the page that replaces it is still the frame's window. Each row below
  // removes one layer; the real-engine proof that the layers hold together
  // is the confinement e2e and the Electron run, which this harness does not
  // replace.
  [HOST, 'one init per frame: a second ready ends the view',
    "      if (initSent) { degrade(LEFT_VIEW_REASON); return; }",
    "      if (false) { degrade(LEFT_VIEW_REASON); return; }"],
  [HOST, 'a second load on the frame ends the view',
    "      if (loads > 1) degrade(LEFT_VIEW_REASON);",
    "      if (false) degrade(LEFT_VIEW_REASON);"],
  // The click gate's conditions each have a case where it alone decides,
  // so each is its own row.
  [HOST, 'a request needs a click the browser recorded',
    "  if (!hasUserActivation(win)) {\n    lapsed(activationOf(win));\n    return 'refuse';",
    "  if (false) {\n    lapsed(activationOf(win));\n    return 'refuse';"],
  [HOST, 'the click must be in this frame, which has focus',
    "  if (win.document.activeElement !== frame) return 'refuse';",
    "  if (false) return 'refuse';"],
  [HOST, "a click on Rundock's own page, still live, is put to the person",
    " || now - last <= ACTIVATION_LIFESPAN_MS) return 'confirm';",
    ") return 'confirm';"],
  // ===== ONE ACTIVATION, ONE REQUEST, ACROSS EVERY FRAME =====
  [HOST, 'a spent activation is spent for every frame',
    "  if (activationSpent(win) || inheritsActivation(win, frame)",
    "  if (inheritsActivation(win, frame)"],
  [HOST, 'a frame mounted during a live activation does not own it',
    "  if (activationSpent(win) || inheritsActivation(win, frame) ||",
    "  if (activationSpent(win) ||"],
  [HOST, 'a frame is marked when it mounts',
    "    noteMount(win, frame);\n",
    ""],
  [HOST, 'the browser reporting a lapse releases every mark',
    "function lapsed(state) {\n  state.generation += 1;",
    "function lapsed(state) {\n  state.generation += 0;"],
  [HOST, 'a lapse seen at a request releases the marks at once',
    "    lapsed(activationOf(win));\n    return 'refuse';",
    "    return 'refuse';"],
  [HOST, 'a fresh click, honoured, is spent',
    "    if (standing === 'click') {\n      spendActivation(win);",
    "    if (standing === 'click') {"],
  // ===== NAMED SOURCES: WHAT A VIEW IS HANDED =====
  [HOST, 'sources are handed only to an extension that declared them',
    "  const declaresSources = !!(payload && payload.sources === true) && !embedded;",
    "  const declaresSources = !embedded;"],
  [HOST, 'an embedded view is handed no sources',
    "  const declaresSources = !!(payload && payload.sources === true) && !embedded;",
    "  const declaresSources = !!(payload && payload.sources === true);"],
  [HOST, 'a source reaches the frame as its name and text, or name and reason, and nothing else',
    "  return list.filter((s) => s && typeof s.path === 'string').map((s) => (typeof s.content === 'string'",
    "  return list; list.filter((s) => s && typeof s.path === 'string').map((s) => (typeof s.content === 'string'"],
  [HOST, 'a changed list replaces the one the view was handed',
    "      sources = wireSources(list);\n      if (initSent) send({ type: 'sources', sources });",
    "      if (initSent) send({ type: 'sources', sources: wireSources(list) });"],
  // ===== NAMED SOURCES: WHAT A VIEW MAY WRITE =====
  [HOST, 'a view with no sources may not write one',
    "      if (!declaresSources) { send({ type: 'refused', of: data.type, reason: SOURCE_REFUSED_REASONS.none }); return; }",
    "      if (false) { send({ type: 'refused', of: data.type, reason: SOURCE_REFUSED_REASONS.none }); return; }"],
  [HOST, 'a source write needs the writes declaration',
    "      if (!writes) { send({ type: 'refused', of: data.type, reason: 'this extension did not declare writes in its manifest' }); return; }\n      const hit",
    "      const hit"],
  [HOST, 'a source write names a source the view was handed, compared as a string',
    "      const hit = sources.find((s) => s.path === data.source && typeof s.content === 'string');",
    "      const hit = { path: data.source, content: '' };"],
  [HOST, 'a source write may not change the source\'s own list',
    "      const why = listKept(win, hit.content, data.content);\n      if (why) { send({ type: 'refused', of: data.type, reason: why }); return; }",
    "      const why = null;"],
  [HOST, 'save may not change the file\'s sources list',
    "      const why = listKept(win, content, data.content);\n      if (why) { send({ type: 'refused', of: 'save', reason: why }); return; }",
    "      const why = null;"],
  [HOST, 'change may not change the file\'s sources list',
    "      const why = listKept(win, content, data.content);\n      if (why) { send({ type: 'refused', of: 'change', reason: why }); return; }",
    "      const why = null;"],
  [HOST, 'with no grammar to check against, a write is refused',
    "  if (!grammar || typeof grammar.sameSources !== 'function') return SOURCE_REFUSED_REASONS.unchecked;",
    "  if (!grammar || typeof grammar.sameSources !== 'function') return null;"],
  // ===== ASK AN AGENT =====
  [HOST, 'an embedded view cannot ask',
    "      if (embedded) { send({ type: 'refused', of: 'ask', reason: ASK_REFUSED_REASONS.embedded }); return; }",
    "      if (false) { send({ type: 'refused', of: 'ask', reason: ASK_REFUSED_REASONS.embedded }); return; }"],
  [HOST, 'an ask needs a click inside the view',
    "    if (standing === 'click') {\n      spendActivation(win);\n      perform();\n      return;\n    }",
    "    if (standing === 'click' || of === 'ask') {\n      spendActivation(win);\n      perform();\n      return;\n    }"],
  [HOST, 'a malformed ask spends the click too',
    "      if (verdict.of === 'ask' && !embedded && requestStanding(win, frame) === 'click') spendActivation(win);\n",
    ""],
  [HOST, 'an ask names an agent the manifest declared',
    "      const declared = asks.indexOf(data.agent) >= 0;",
    "      const declared = true;"],
  [HOST, 'the person is never asked about an undeclared agent',
    "    if (standing === 'confirm' && !blocked) {",
    "    if (standing === 'confirm') {"],
  [HOST, 'the draft is cleaned before it reaches the app',
    "      const message = cleanAskMessage(data.message);",
    "      const message = data.message;"],
  [HOST, 'bidirectional and zero-width characters are removed',
    "    .replace(/[\\u061c\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2069\\ufeff]/g, '');",
    "    ;"],
  [HOST, 'a message over the limit is refused by shape',
    "    message: (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_ASK_CHARS,",
    "    message: (v) => typeof v === 'string' && v.length > 0,"],
  [ASK_APP, 'an agent not on the team is refused before any conversation exists',
    "  if (!agent) return `there is no agent called ${agentId} on this team`;",
    "  if (!agent) { startConversation(agentId); return null; }"],
  [ASK_APP, 'a platform agent cannot be asked',
    "  const agent = agents.find(a => a.id === agentId && a.status === 'onTeam' && a.type !== 'platform');",
    "  const agent = agents.find(a => a.id === agentId && a.status === 'onTeam');"],
  [CARD, 'the card names each agent an extension may ask, by the name the person knows',
    "      return agent && agent.displayName ? agent.displayName : id;",
    "      return id;"],
  [CARD, 'the card says what a sources extension can read, and what it never gets',
    "    if (facts.sources !== true || !facts.declares) return [];",
    "    return [];"],
  // ===== THE SERVER IS THE AUTHORITY =====
  [RESOLVER, 'the note itself is held to the extension file rule',
    "  if (noteRefusal) return { ok: false, reason: `the note cannot be read: ${noteRefusal}`, sources: [] };",
    "  if (false) return { ok: false, reason: `the note cannot be read: ${noteRefusal}`, sources: [] };"],
  [RESOLVER, 'a name that breaks the grammar is refused',
    "    if (byName) { out.push({ path: name, refused: byName }); continue; }",
    "    if (false) { out.push({ path: name, refused: byName }); continue; }"],
  [RESOLVER, 'a linked, hard-linked, missing or folder source is refused',
    "    if (onDisk) { out.push({ path: name, refused: onDisk }); continue; }",
    "    if (false) { out.push({ path: name, refused: onDisk }); continue; }"],
  [RESOLVER, 'the note is refused as its own source, by device and inode',
    "    if (identity(workspace, name) === noteId) { out.push({ path: name, refused: REASONS.self }); continue; }",
    "    if (false) { out.push({ path: name, refused: REASONS.self }); continue; }"],
  [RESOLVER, 'a name listed twice is refused',
    "    if (seen.has(name)) { out.push({ path: name, refused: REASONS.duplicate }); continue; }",
    "    if (false) { out.push({ path: name, refused: REASONS.duplicate }); continue; }"],
  [RESOLVER, 'the note and its sources are held to the total cap',
    "    if (total + content.length > model.MAX_TOTAL_CHARS) { out.push({ path: name, refused: REASONS.overCap }); continue; }",
    "    if (false) { out.push({ path: name, refused: REASONS.overCap }); continue; }"],
  [RESOLVER, 'a write is to a name the note lists now',
    "  if (!hit) return REASONS.unlisted;\n  if (typeof hit.refused === 'string') return hit.refused;",
    "  if (typeof (hit || {}).refused === 'string') return hit.refused;"],
  [RESOLVER, 'a write to a source refused now is refused',
    "  if (typeof hit.refused === 'string') return hit.refused;",
    ""],
  [GRAMMAR, 'a hidden segment is refused by name',
    "      if (seg.startsWith('.')) return 'a hidden file, or a file in a hidden folder, is never handed to an extension';",
    ""],
  [GRAMMAR, 'a note lists at most twelve names',
    "    if (names.length > MAX_SOURCES) {",
    "    if (false) {"],
  [GRAMMAR, 'a changed list is a changed list',
    "    return a.names.every((n, i) => n === b.names[i]);",
    "    return true;"],
  [EXTFILE_NS, 'no extension write may change the file\'s sources list, on the server',
    "  if (!sameSources(before, content)) return REASONS.changedList;",
    ""],
  [TRANSPORT, 'a switched workspace ends the watch',
    "    if (ws.readyState !== 1 || getWorkspace() !== workspace || ws._sourcesWatch !== watch) {",
    "    if (ws.readyState !== 1 || ws._sourcesWatch !== watch) {"],
  [TRANSPORT, 'a closed connection ends the watch',
    "    if (ws.readyState !== 1 || getWorkspace() !== workspace || ws._sourcesWatch !== watch) {",
    "    if (getWorkspace() !== workspace || ws._sourcesWatch !== watch) {"],
  [TRANSPORT, 'an unwatch for another mount leaves this one',
    "  if (ws._sourcesWatch && (!watchId || ws._sourcesWatch.watchId === watchId)) closeSourcesWatch(ws);",
    "  if (ws._sourcesWatch) closeSourcesWatch(ws);"],
  [TRANSPORT, 'only a real change is pushed',
    "    if (text === last) return;",
    ""],
  // ===== DECLARED, RECORDED, SERVED =====
  [MANIFEST, 'sources is refused without a marker at install',
    "  if (sources && !declares) {",
    "  if (false) {"],
  [MANIFEST, 'asks is one to four ids',
    "    if (!Array.isArray(extension.asks) || extension.asks.length < 1 || extension.asks.length > MAX_ASKS) {",
    "    if (!Array.isArray(extension.asks)) {"],
  [MANIFEST, 'asks names an agent once',
    "    if (new Set(extension.asks).size !== extension.asks.length) refuse('extension.asks names an agent twice');",
    ""],
  [PAYLOAD, 'the payload grants sources only with a marker',
    "    sources: record.sources === true && !!declared.declares, asks };",
    "    sources: record.sources === true, asks };"],
  [PAYLOAD, 'the payload keeps asks to valid ids, at most four',
    "    ? record.asks.filter((a) => typeof a === 'string' && AGENT_ID.test(a)).slice(0, MAX_ASKS) : [];",
    "    ? record.asks : [];"],
  [PAYLOAD, 'the roster refuses a record granting sources without a marker',
    "    if (mapped.target && record.sources === true && !declared.declares) {",
    "    if (false) {"],
  // ===== THE PAGE'S SEAM =====
  [SEAM, 'sources are asked for only for a declaring extension that claimed the note by its marker',
    "    const wantsSources = !!(payload && payload.sources === true && claim.marker);",
    "    const wantsSources = !!(payload && payload.sources === true);"],
  [SEAM, 'a change for a mount that has ended is ignored',
    "  if (!d || d.watchId !== sourcesWatchId) return;",
    "  if (!d) return;"],
  [SEAM, 'releasing a mount ends its watch',
    "  extensionSeamToken += 1;\n  endSourcesWatch();",
    "  extensionSeamToken += 1;"],
  // ===== A WEB LINK OPENS OUTSIDE THE APP =====
  [RENDER_LINKS, 'a web link in rendered markdown opens outside the app',
    "          const outside = web ? ' target=\"_blank\" rel=\"noopener noreferrer\"' : '';",
    "          const outside = '';"],
  [RENDER_LINKS, 'a protocol-relative link is a web link, never a workspace file',
    "          const web = /^https?:/i.test(href) || /^\\/\\//.test(href);",
    "          const web = /^https?:/i.test(href);"],
  [RENDER_LINKS, 'a link climbing out of the workspace is not a workspace file',
    "      if (depth < 0) return null;",
    ""],
  [RENDER_LINKS, 'read-only rendering opens a workspace file through the shared resolver',
    "            return target ? `<a class=\"wikilink\" data-wikilink=\"${escapeAttr(target)}\">${text}</a>` : text;",
    "            return text;"],
  [EDITOR_LINKS, 'the rich editor opens a relative workspace link in Rundock through the shared resolver',
    "    if (fileTarget) {",
    "    if (false) {"],
  [PAGE_LINKS, 'a click on an external link is taken, and the page does not navigate',
    "      event.preventDefault();\n      win.open(href, '_blank', 'noopener,noreferrer');",
    "      win.open(href, '_blank', 'noopener,noreferrer');"],
  [PAGE_LINKS, 'a protocol-relative link counts as external on the page',
    "    if (!/^(?:https?:|\\/\\/)/i.test(raw.trim())) return null;",
    "    if (!/^https?:/i.test(raw.trim())) return null;"],
  [PAGE_LINKS, 'the rule runs in the capture phase, ahead of every surface',
    "    doc.addEventListener('click', onClick(win || doc.defaultView), true);",
    "    doc.addEventListener('click', onClick(win || doc.defaultView), false);"],
  [DESKTOP_LINKS, 'the main window stays on the app\'s own origin, compared exactly',
    "  return !!u && u.origin === appOrigin;",
    "  return String(url).startsWith(appOrigin);"],
  [DESKTOP_LINKS, 'only the web and mail are handed to the system',
    "  return !!u && (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:');",
    "  return !!u;"],
  [DESKTOP_LINKS, 'a navigation off the app is stopped',
    "    if (isAppUrl(url, appOrigin)) return;\n    event.preventDefault();",
    "    if (isAppUrl(url, appOrigin)) return;"],
  // ===== ONE CLICK IS ONE REQUEST =====
  // ===== THE PERSON IS ASKED, IN RUNDOCK'S OWN BAR =====
  [HOST, 'one request waits at a time; the rest are refused as waiting',
    "      if (requestWaiting(doc)) { send({ type: 'refused', of, reason: REQUEST_REASONS.waiting }); return; }\n",
    ""],
  [HOST, 'only a trusted press answers the bar',
    "    if (!event || event.isTrusted !== true) return;",
    "    if (!event) return;"],
  [HOST, 'the bar is unarmed when it appears',
    "  const open = ui.button({ label: 'Open', variant: 'primary', onClick: answer(onOpen), disabled: true });",
    "  const open = ui.button({ label: 'Open', variant: 'primary', onClick: answer(onOpen) });"],
  [HOST, 'the bar sits directly above the frame',
    "  if (frame && frame.parentNode === pane) pane.insertBefore(slot.node, frame);",
    "  if (frame && frame.parentNode === pane) pane.appendChild(slot.node);"],
  [HOST, 'Rundock UI is bound privately, adding no page global',
    "    ui = installRundockUi({ document: doc });",
    "    ui = installRundockUi(doc.defaultView);"],
  [HOST, 'leaving the view clears the bar',
    "    liveViews.delete(endForLeaving);\n    clearSlot(doc, owner);",
    "    liveViews.delete(endForLeaving);"],
  [HOST, 'a request with no click is shown to the person as stopped',
    "    showRefusalLine({ doc, pane: paneElement, frame, owner, message: refusalWords(of, detail, extensionName) });\n",
    ""],
  [HOST, 'a refusal line never replaces a waiting request',
    "function showRefusalLine({ doc, pane, frame, owner, message }) {\n  if (requestWaiting(doc)) return;",
    "function showRefusalLine({ doc, pane, frame, owner, message }) {"],
  // ===== A LINKED FILE IS NEVER HANDED TO AN EXTENSION =====
  [EXTFILE, 'a symlink on the way to the file, or the file itself, is refused',
    "    if (stat.isSymbolicLink()) return REASONS.linked;\n",
    ""],
  [EXTFILE, 'a hard link is refused',
    "  if (stat.nlink > 1) return REASONS.hardLink;\n",
    ""],
  [EXTFILE, 'a hidden or traversing path is refused before anything is read',
    " || hasHiddenSegment(rel)) {",
    ") {"],
  [FILEHANDLERS, 'an extension save is held to the rule, not written like the editor\'s',
    "    if (msg.origin === 'extension') {",
    "    if (false) {"],
  [FILEHANDLERS, 'read_file states the server\'s answer for the file',
    "      extensionRefusal: extensionFileRefusal(getWorkspace(), msg.path),",
    "      extensionRefusal: null,"],
  [ROUTER_FILE, '/api/file states the answer, and never clears a refused file',
    "        'X-Rundock-Extension-Refusal': refusal ? encodeURIComponent(refusal) : 'none',",
    "        'X-Rundock-Extension-Refusal': 'none',"],
  [FILES, 'the seam never mounts a file the server refused',
    "  if (refusal) {\n    surface(viewers, path, content);\n    noteRendererFailure(refusal);",
    "  if (false) {\n    surface(viewers, path, content);\n    noteRendererFailure(refusal);"],
  [FILES_CLIENT, 'an embed reads no header as a refusal, never as permission',
    "      const refusal = said === 'none' ? null : (said ? decodeURIComponent(said) : EXTENSION_UNCHECKED_REASON);",
    "      const refusal = said && said !== 'none' ? decodeURIComponent(said) : null;"],
  [REGIONS, 'a refused document has no region drawers',
    "  if (documentPath != null && (typeof refusalFor !== 'function' || refusalFor(documentPath))) return null;",
    "  if (false) return null;"],
  [HOST, 'openExternal opens only http and https',
    "    return (url.protocol === 'http:' || url.protocol === 'https:') ? url.href : null;",
    "    return url.href;"],
  [REGISTRY, 'a hidden path is never claimed by a view',
    "      if (isHiddenPath(path)) return { registered: false, reason: HIDDEN_PATH_REASON };",
    "      if (false) return { registered: false, reason: HIDDEN_PATH_REASON };"],
  [REGISTRY, 'a document in a hidden folder has no drawer',
    "      if (path != null && isHiddenPath(path)) return null;",
    "      if (false) return null;"],
  [SERVICE, 'a render frame answering ready twice is stopped',
    "        if (readySeen) { left(); return; }",
    "        if (false) { left(); return; }"],
  [SERVICE, 'a render frame loading a second document is stopped',
    "        if (loads > 1) left();",
    "        if (false) left();"],
  [ROUTER, 'the app page carries the frame policy',
    "      'Content-Security-Policy': PAGE_FRAME_POLICY,\n",
    ""],
  // The desktop guards. Two rows WIDEN rather than remove, because widening
  // is the failure that would degrade the app: a guard on every sub-frame
  // breaks PDF viewing and preview links, a guard on every request breaks
  // the update check.
  [GUARDS, 'an extension frame may not navigate away',
    "  return !!(frame && frame.parent) && initiatorOrigin === 'null' && !isOwnDocument(url);",
    "  return false;"],
  [GUARDS, 'the navigation guard reaches extension frames only, never every sub-frame',
    "  return !!(frame && frame.parent) && initiatorOrigin === 'null' && !isOwnDocument(url);",
    "  return !!(frame && frame.parent) && !isOwnDocument(url);"],
  [GUARDS, 'the request filter reaches extension frames only, never the app',
    "  return isExtensionFrame(details.frame);",
    "  return !!details.frame;"],
  [GUARDS, 'WebRTC is off for the window',
    "  webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');\n",
    ""],
];

const REPORTER = ['--test-reporter', 'spec'];

function redTests(suite) {
  let out = '';
  let failed = false;
  // A suite named `test/e2e/<spec>.spec.js#<test title>` is a real-engine
  // check: Playwright runs that one test in Chromium, on a port of this
  // harness's own so it never meets a server another run holds, and its
  // failures are read from the numbered list the line reporter ends with.
  const [file, grep] = String(suite).split('#');
  const e2e = /\.spec\.js$/.test(file);
  try {
    out = e2e
      ? execFileSync('npx', ['playwright', 'test', file, '--reporter=line', ...(grep ? ['-g', grep] : [])],
        { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, E2E_PORT: '34647' } })
      : execFileSync('node', ['--test', ...REPORTER, suite],
        { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    failed = true;
    out = (e.stdout || '') + (e.stderr || '');
  }
  if (e2e) {
    const names = [];
    for (const line of out.split('\n')) {
      const m = /^\s*\d+\) \S+\.spec\.js:\d+:\d+ .*› (.+?)\s*[─\s]*$/.exec(line);
      if (m && !names.includes(m[1].trim())) names.push(m[1].trim());
    }
    if (names.length) return names;
    return failed ? { unparsable: true } : [];
  }
  const marker = out.indexOf('failing tests:');
  if (marker === -1) {
    if (!failed) return [];
    // A suite that failed with output this could not read has produced no
    // verdict: not red, not green, nothing. Refused as a named row rather
    // than thrown, so the report says which mutation was in flight instead
    // of a stack trace that names nothing.
    return { unparsable: true };
  }
  const names = [];
  for (const line of out.slice(marker).split('\n')) {
    const m = /^✖ (.+?) \(\d/.exec(line.trim());
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

function run() {
  // Every target a row names must be here, or its original is never read:
  // derived from the rows so a new target cannot be forgotten a second time.
  const targets = [...new Set([HOST, REGISTRY, SERVER, FILES, ...MUTATIONS.map((m) => m[0])])];
  const session = beginMutationRun({ files: [...new Set(targets.map((t) => t.src))] });
  const originals = new Map();
  for (const target of targets) originals.set(target, session.original(target.src));
  const results = [];
  try {
    // `--only <prefix>` runs just the rows whose label starts with it, so one
    // set of rows can be run and recorded on its own. The gate never passes it.
    const onlyAt = process.argv.indexOf('--only');
    const only = onlyAt >= 0 ? String(process.argv[onlyAt + 1] || '') : null;
    for (const [target, label, guard, without] of MUTATIONS) {
      if (only !== null && !label.startsWith(only)) continue;
      const original = originals.get(target);
      const matches = original.split(guard).length - 1;
      if (matches === 0) {
        results.push({ label, applied: false, red: [] });
        continue;
      }
      if (matches > 1) {
        results.push({ label, applied: false, ambiguous: matches, red: [] });
        continue;
      }
      fs.writeFileSync(target.src, original.replace(guard, without));
      const red = redTests(target.suite);
      results.push(red && red.unparsable
        ? { label, applied: true, unparsable: true, red: [] }
        : { label, applied: true, red });
      fs.writeFileSync(target.src, original);
    }
  } finally {
    session.finish();
  }
  return results;
}

function report(results, markdown) {
  let failed = 0;
  const lines = [];
  for (const { label, applied, red, ambiguous, unparsable } of results) {
    if (unparsable) {
      failed++;
      const why = 'no verdict: the suite failed but its output could not be parsed, so nothing '
        + 'about this mutation is known; fix the reporter parsing rather than trusting a rerun';
      lines.push(markdown ? `| ${label} | **${why}** | |` : `${label}\n  ${why.toUpperCase()}`);
      continue;
    }
    if (ambiguous) {
      failed++;
      const why = `the guard text matches ${ambiguous} places, so it would break whichever came first`;
      lines.push(markdown ? `| ${label} | **${why}** | |` : `${label}\n  AMBIGUOUS: ${why}`);
      continue;
    }
    if (!applied) {
      failed++;
      lines.push(markdown
        ? `| ${label} | **the guard text was not found, so nothing was mutated** | |`
        : `${label}\n  THE GUARD TEXT WAS NOT FOUND, so nothing was mutated`);
      continue;
    }
    if (red.length === 0) {
      failed++;
      lines.push(markdown ? `| ${label} | **nothing turned red** | |` : `${label}\n  NOTHING TURNED RED`);
      continue;
    }
    lines.push(markdown
      ? `| ${label} | ${red.length} | ${red.map((n) => `\`${n}\``).join('<br>')} |`
      : `${label}\n  ${red.length} red\n${red.map((n) => `    - ${n}`).join('\n')}`);
  }
  if (markdown) {
    console.log('| Guard broken | Tests red | Which |');
    console.log('|---|---|---|');
    for (const line of lines) console.log(line);
  } else {
    for (const line of lines) console.log(`\n${line}`);
  }
  return failed;
}

function requireSaneTempRoot() {
  const verdict = preflight(os.tmpdir());
  if (verdict.ok) return;
  console.error(verdict.message);
  process.exit(2);
}

if (require.main === module) {
  requireSaneTempRoot();
  if (process.argv.includes('--preflight-only')) process.exit(0);
  const failed = report(run(), process.argv.includes('--markdown'));
  if (failed) {
    console.error(`\n${failed} mutation(s) proved nothing. A guard no test notices is not guarded,`
      + ' and a mutation that could break more than one place proves nothing about either.');
    process.exit(1);
  }
}

module.exports = { MUTATIONS, run };
