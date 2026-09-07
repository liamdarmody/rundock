'use strict';
// Settings view: section nav, workspace/appearance/about panels, and the
// runtimes card. Extracted verbatim from app.js (section 14), same UMD +
// root-republication pattern as views/skills.js: the static settings-nav
// inline handlers (showSettingsSection), the generated onclick handlers
// (setWorkspaceMode, changeWorkspace, toggleTheme + renderSettingsSection
// in the appearance card), the WS dispatch (renderSettingsSection,
// renderRuntimesCard) and routing (showSettingsSection) all resolve these
// as window properties.
//
// Shared state stays in app.js and is reached through the global lexical
// environment at call time: agents, skills, workspaceMode,
// currentWorkspacePath, runtimeStatus, ws, plus the helpers esc, showView
// and toggleTheme. No section-local state existed to move. Function bodies
// are byte-identical to the app.js originals at column 0.
(/** @param {any} root @param {() => object} factory */ function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    root.RundockSettingsView = factory();
    Object.assign(root, root.RundockSettingsView);
  }
}(typeof self !== 'undefined' ? self : this, function () {

// ---- Packages install flow (lane: PL2 hosting section, PL4 states) ----
// All flow logic lives in RundockPackagesInstallModel; this file only renders
// the model's state and forwards the person's actions and the server's
// replies. The model decides what, if anything, is sent.
let packagesInstall = (typeof RundockPackagesInstallModel !== 'undefined') ? RundockPackagesInstallModel.initial() : null;

// One guard for every packages render path: markup goes into the settings
// pane only when the pane is showing and Packages is the displayed section;
// otherwise the model state updates silently and the section is right the
// next time it opens.
function packagesSectionVisible() {
  if (typeof currentView === 'undefined' || currentView !== 'settings') return false;
  const active = document.querySelector('.settings-nav-item.active');
  return !!active && active.dataset.settings === 'packages';
}

function packagesRenderIfVisible() {
  if (packagesSectionVisible()) renderSettingsSection('packages');
}

function packagesApplyTransition(out) {
  // A transition that wants to send only takes effect if the message was
  // actually handed to an open socket; otherwise the flow stays usable and
  // says plainly that nothing went out.
  if (out.send) {
    if (!(ws && ws.readyState === WebSocket.OPEN)) {
      packagesInstall = {
        ...RundockPackagesInstallModel.initial(),
        sourcePath: (packagesInstall && packagesInstall.sourcePath) || '',
        fieldError: 'Not connected: nothing was sent. Try again once the connection returns.',
      };
      packagesRenderIfVisible();
      return;
    }
    ws.send(JSON.stringify(out.send));
  }
  packagesInstall = out.state;
  packagesRenderIfVisible();
}

function packagesSubmit() {
  const field = document.getElementById('packages-source-path');
  packagesApplyTransition(RundockPackagesInstallModel.submit(packagesInstall, field ? field.value : ''));
}

function packagesCancel() { packagesApplyTransition(RundockPackagesInstallModel.cancel(packagesInstall)); }
function packagesConfirm() { packagesApplyTransition(RundockPackagesInstallModel.confirm(packagesInstall)); }
function packagesRetry() { packagesApplyTransition(RundockPackagesInstallModel.retry(packagesInstall)); }

function packagesReplyArrived(msg) { packagesApplyTransition(RundockPackagesInstallModel.reply(packagesInstall, msg)); }

// Per-workspace state must not outlive the workspace it was built from: a
// plan's collision facts, planned digests and default readings all describe
// one workspace, so a change of workspace returns the flow to idle.
function packagesWorkspaceChanged() {
  packagesInstall = RundockPackagesInstallModel.initial();
  packagesRenderIfVisible();
}

// A dropped connection ends any wait this flow is in; the model owns the
// words for each phase, including the honest uncertainty of a lost apply.
function packagesConnectionLost() {
  const out = RundockPackagesInstallModel.connectionLost(packagesInstall);
  // Identity means no wait was in progress: repainting here would wipe a
  // half-typed path for nothing.
  if (out.state !== packagesInstall) packagesApplyTransition(out);
}

function packagesSectionHtml() {
  const m = RundockPackagesInstallModel;
  const st = packagesInstall;
  const field = `<div class="settings-card">
      <div class="packages-field-label">Add a package from a folder</div>
      <div class="packages-field-row">
        <input id="packages-source-path" class="packages-input" type="text" placeholder="Path to a folder of agents and skills"
          value="${escAttr(st.sourcePath || '')}" ${st.phase === 'idle' ? '' : 'disabled'}>
        <button class="settings-btn" onclick="packagesSubmit()" ${st.phase === 'idle' ? '' : 'disabled'}>Read it</button>
      </div>
      ${st.fieldError ? `<div class="packages-field-error">${esc(st.fieldError)}</div>` : ''}
    </div>`;
  let stateHtml = '';
  if (st.phase === 'classifying') {
    stateHtml = `<div class="settings-card packages-state"><div class="packages-spinner"></div>Reading the package…</div>`;
  } else if (st.phase === 'offer') {
    const copy = m.offerCopy(st);
    stateHtml = `<div class="settings-card packages-confirm-card">
        <div class="packages-headline">${esc(copy.headline)}</div>
        <div class="packages-body">${esc(copy.body)}</div>
        ${copy.collisionNote ? `<div class="packages-collision-note">${esc(copy.collisionNote)}</div>` : ''}
        <div class="packages-actions">
          <button class="settings-btn packages-confirm" onclick="packagesConfirm()" ${copy.confirmDisabled ? 'disabled' : ''}>${esc(copy.confirmLabel)}</button>
          <button class="settings-btn packages-cancel" onclick="packagesCancel()">${esc(copy.cancelLabel)}</button>
        </div>
      </div>`;
  } else if (st.phase === 'applying') {
    stateHtml = `<div class="settings-card packages-state"><div class="packages-spinner"></div>Adding to your team…</div>`;
  } else if (st.phase === 'nothing-usable') {
    stateHtml = `<div class="settings-card packages-state">
        <div class="packages-headline">Nothing usable in that folder</div>
        <div class="packages-body">Rundock looked for agents and skills and found neither.</div>
        <div class="packages-actions"><button class="settings-btn" onclick="packagesCancel()">Back</button></div>
      </div>`;
  } else if (st.phase === 'failed') {
    stateHtml = `<div class="settings-card packages-state packages-failed">
        <div class="packages-headline">That didn't work</div>
        <div class="packages-body">${esc(st.message)}</div>
        <div class="packages-actions">
          ${st.canReplan ? `<button class="settings-btn" onclick="packagesRetry()">Review the package again</button>` : ''}
          <button class="settings-btn" onclick="packagesCancel()">Back</button>
        </div>
      </div>`;
  } else if (st.phase === 'done') {
    const copy = m.doneCopy(st);
    stateHtml = `<div class="settings-card packages-success-card" data-receipt="${escAttr(st.receipt || '')}">
        <div class="packages-headline">${esc(copy.headline)}</div>
        ${copy.parts.map((p) => `<div class="packages-part"><span class="packages-part-label">${esc(p.label)}</span><span class="packages-part-dest">${esc(p.destination)}</span></div>`).join('')}
        ${copy.blockedLines.map((line) => `<div class="packages-blocked-line">${esc(line)}</div>`).join('')}
        <div class="packages-actions"><button class="settings-btn" onclick="packagesCancel()">Done</button></div>
      </div>`;
  }
  return `<div class="settings-section-title">Packages</div>${field}${stateHtml}`;
}

function showSettingsSection(section) {
  document.querySelectorAll('.settings-nav-item').forEach(el => el.classList.remove('active'));
  document.querySelector(`.settings-nav-item[data-settings="${section}"]`)?.classList.add('active');
  renderSettingsSection(section);
}

function renderSettingsSection(section) {
  const el = document.getElementById('settings-content');
  if (section === 'packages') {
    el.innerHTML = packagesSectionHtml();
  } else if (section === 'workspace') {
    const agentCount = agents.filter(a => a.status === 'onTeam').length;
    const skillCount = skills.length;
    const isCode = workspaceMode === 'code';
    // The mode control is the only permissions concept a user meets: no
    // separate sandbox switch. Knowledge mode is additionally enforced by
    // the operating system on macOS; Code mode withdraws that OS-level
    // block because a command sandbox refuses process-launch primitives
    // (a headless browser's startup check-in, for one) categorically, no
    // matter what folder permissions say, so a tool that launches its own
    // processes needs Code mode on macOS to work at all.
    const modeDesc = isCode
      ? 'Agents can write any file type and run commands without approval. On macOS, the extra operating-system write block is off here, because tools that launch their own processes, such as a headless browser, can fail under it regardless of folder permissions.'
      : 'Agents work with documents only. Terminal commands need approval. On macOS, this is additionally enforced at the operating-system level, on top of the approval cards.';
    el.innerHTML = `<div class="settings-section-title">Workspace</div>
      <div class="settings-card">
        <div class="settings-row">
          <span class="settings-label">Path</span>
          <span class="settings-value" title="${escAttr(currentWorkspacePath || 'Not set')}">${esc(currentWorkspacePath || 'Not set')}</span>
        </div>
        <div class="settings-row">
          <span class="settings-label">Agents</span>
          <span class="settings-value">${agentCount}</span>
        </div>
        <div class="settings-row">
          <span class="settings-label">Skills</span>
          <span class="settings-value">${skillCount}</span>
        </div>
      </div>
      <div class="settings-card">
        <div class="settings-row" style="flex-direction:column;align-items:stretch;gap:12px">
          <span class="settings-label">Mode</span>
          <div class="mode-toggle">
            <button class="mode-toggle-btn${isCode ? '' : ' active'}" data-mode="knowledge" onclick="setWorkspaceMode('knowledge')">Knowledge mode</button>
            <button class="mode-toggle-btn${isCode ? ' active' : ''}" data-mode="code" onclick="setWorkspaceMode('code')">Code mode</button>
          </div>
          <div class="mode-description" id="mode-description">${modeDesc}</div>
        </div>
      </div>
      <div class="settings-card" id="runtimes-card">${runtimesCardHtml()}</div>
      <button class="settings-btn" onclick="changeWorkspace()">Change workspace</button>`;
    // Refresh runtime state whenever the card becomes visible (the user may
    // have just installed or signed in to a CLI).
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'get_runtime_status' }));
  } else if (section === 'appearance') {
    const isLight = document.body.classList.contains('light');
    el.innerHTML = `<div class="settings-section-title">Appearance</div>
      <div class="settings-card">
        <div class="settings-row">
          <span class="settings-label">Theme</span>
          <button class="settings-btn" onclick="toggleTheme();renderSettingsSection('appearance')">${isLight ? 'Switch to Dark' : 'Switch to Light'}</button>
        </div>
      </div>`;
  } else if (section === 'connectors') {
    el.innerHTML = `<div class="settings-section-title">Connectors</div><div class="settings-card"><div class="settings-row"><span class="settings-value">Reading .mcp.json&hellip;</span></div></div>`;
    connectorsLoad();
  } else if (section === 'about') {
    el.innerHTML = `<div class="settings-section-title">About</div>
      <div class="settings-card">
        <div class="settings-row">
          <span class="settings-label">Version</span>
          <span class="settings-value" style="font-family:inherit">${window._rundockVersion || 'unknown'}</span>
        </div>
        <div class="settings-row">
          <span class="settings-label">Feedback</span>
          <a href="https://github.com/liamdarmody/rundock/issues" target="_blank" rel="noopener" style="font-size:var(--caption);color:var(--accent);text-decoration:underline;text-underline-offset:2px">Report an issue</a>
        </div>
      </div>`;
  }
}

function setWorkspaceMode(mode) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'set_workspace_mode', mode }));
}

// ── Runtimes card (settings › workspace) ──
// One row per runtime with a unified status vocabulary. Status chips never
// claim which plan backs the credentials (detection is presence-only); plan
// language lives in the guidance copy. When Codex is absent, the guidance IS
// the hint, and it appears nowhere else in the product.
function runtimeRowHtml(label, st, isDefault) {
  // Each state carries a hover tooltip explaining the evidence behind it:
  // detection only checks what exists on disk (the CLI, its sign-in
  // credentials) and claims nothing it cannot see. "Installed" in grey is
  // deliberate: it means the CLI is present and sign-in state is unknown,
  // not that something is wrong.
  let dot, text, tip;
  if (!st || !st.installed) {
    dot = 'var(--idle)'; text = 'Not installed';
    tip = 'The CLI for this runtime was not found on this machine.';
  } else if (st.authenticated === false) {
    dot = 'var(--attention)'; text = 'Not signed in';
    tip = 'The CLI is installed, but no sign-in credentials were found on this machine. Run its login command to sign in.';
  } else if (st.authenticated === true) {
    dot = 'var(--success)'; text = 'Signed in' + (st.version ? ' · v' + esc(st.version) : '');
    tip = 'The CLI is installed and sign-in credentials were found on this machine. Rundock checks that credentials exist; it never reads them.';
  } else {
    dot = 'var(--idle)'; text = 'Installed' + (st.version ? ' · v' + esc(st.version) : ''); // auth unknown: claim nothing
    tip = 'The CLI is installed. Rundock cannot tell whether it is signed in, so it makes no claim either way. Agents on this runtime may still work.';
  }
  return `<div class="settings-row"><span class="settings-label">${label}</span>` +
    `<span class="runtime-chip" title="${esc(tip)}" style="cursor:help">${isDefault ? '<span class="runtime-default">Default</span>' : ''}` +
    `<span class="runtime-dot" style="background:${dot}"></span>${text}</span></div>`;
}

function runtimesCardHtml() {
  if (!runtimeStatus) {
    return `<div class="settings-row"><span class="settings-label">Runtimes</span><span class="settings-value" style="font-family:inherit">Checking...</span></div>`;
  }
  let h = runtimeRowHtml('Claude Code', runtimeStatus.claude, runtimeStatus.defaultRuntime === 'claude');
  h += runtimeRowHtml('Codex', runtimeStatus.codex, runtimeStatus.defaultRuntime === 'codex');
  const cx = runtimeStatus.codex || {};
  if (cx.installed && cx.authenticated === false) {
    h += `<div class="runtime-guidance">Run <code>codex login</code> once. Your ChatGPT plan covers your agents via the official Codex CLI (July 2026).</div>`;
  } else if (!cx.installed) {
    h += `<div class="runtime-guidance">Want agents on your ChatGPT plan? Install the official Codex CLI, then sign in: <code>npm install -g @openai/codex</code> then <code>codex login</code></div>`;
  }
  // windowsSandbox is only ever a boolean on Windows (null elsewhere), so
  // this guidance self-limits to Windows machines. Without the native
  // sandbox declared, Codex file writes arrive as approval cards; with it,
  // agents write directly inside the sandbox, as on macOS.
  if (cx.installed && cx.windowsSandbox === false) {
    h += `<div class="runtime-guidance">Codex agents currently request each file write for your approval. For direct sandboxed writes, add to your Codex config (<code>%USERPROFILE%\\.codex\\config.toml</code>):<br><code>[windows]</code><br><code>sandbox = "unelevated"</code></div>`;
  }
  return h;
}

function renderRuntimesCard() {
  const el = document.getElementById('runtimes-card');
  if (el) el.innerHTML = runtimesCardHtml();
}

function changeWorkspace() {
  ws.send(JSON.stringify({ type: 'list_workspaces' }));
}

// ---- Connectors (settings > connectors) ----
//
// FOUR SOURCES, ONE ROW PER NAME. An agent can reach a connector defined in
// any of:
//   1. <workspace>/.mcp.json          Claude Code, workspace scope (edited by this tab)
//   2. <workspace>/.codex/config.toml Codex,       workspace scope
//   3. ~/.claude.json                 Claude Code, user-global scope (this machine)
//   4. ~/.codex/config.toml           Codex,       user-global scope (this machine)
// Reading only source 1, as this tab once did, can say "no connectors
// configured" while several are live: workspace Codex connectors and the
// operator's own user-global reach are both invisible from .mcp.json alone.
// Sources 1-2 come through /api/file (workspace-scoped, existing); sources
// 3-4 come through /api/connectors/machine (lib/http-router.js), a second,
// deliberately narrower endpoint that reads exactly those two fixed paths
// under the server's own os.homedir() and takes no path from the client, so
// it cannot be asked to read anything else.
//
// Everything the tab knows arrives through Rundock's own server. No request
// leaves the machine.
//
// PURE HALF FIRST, so what a row says is testable without a page. Every
// parse is tolerant of a source that is missing (an empty state, not an
// error) and loud about one that cannot be read (an error naming the source,
// never rendered as "no connectors": a person with a broken config needs
// told, not reassured). Merging four sources into rows, deciding which
// runtimes reach a name, and flagging when they disagree about what that
// name IS are pure functions too, for the same reason.
//
// DRIFT is the point of merging at all. A name defined identically by both
// runtimes is unremarkable; a name defined DIFFERENTLY (a URL for one
// runtime and a local command for the other, or the same shape with
// different arguments) is exactly the fact separate per-file views would
// never surface, because each file, read alone, looks complete and correct.
//
// CREDENTIAL VALUES ARE NEVER RENDERED, NEVER STORED, NEVER EVEN HELD IN A
// LOCAL VARIABLE A MOMENT LONGER THAN PARSING NEEDS. This matters more here
// than it did for .mcp.json alone: ~/.claude.json can carry live OAuth
// tokens, not just key names. Every parser below extracts credential KEYS
// only; the code that would hold a value is not merely un-rendered, it does
// not exist.

// Local escapes, so the pure half stays requireable off the page. The page
// defines global helpers; under node there is no page, and a test driving
// what a row says should not need one.
function connectorsEsc(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function connectorsEscAttr(v) {
  return connectorsEsc(v).replace(/"/g, '&quot;');
}

// Shared by every JSON source (both .mcp.json's shape and ~/.claude.json's
// are `{ mcpServers: { name: { command|url, args, env } } }`): turn the raw
// mcpServers object into the row shape every source produces, so a name
// found in two JSON sources compares like for like. Never reads env VALUES,
// only Object.keys(env): the credential names, never what they hold.
function connectorsServersFromRaw(raw) {
  return Object.keys(raw).map((name) => {
    const entry = raw[name] || {};
    const isUrl = typeof entry.url === 'string' && entry.url;
    const target = isUrl ? entry.url
      : [entry.command].concat(Array.isArray(entry.args) ? entry.args : []).filter(Boolean).join(' ');
    return {
      name,
      transport: isUrl ? 'url' : 'command',
      // What this connector can reach, stated as the thing it starts or the
      // address it talks to, which is the honest whole of what the config
      // knows. Health and per-tool reach are runtime questions this tab does
      // not claim to answer.
      target: target || '(nothing configured)',
      envKeys: entry.env && typeof entry.env === 'object' ? Object.keys(entry.env) : [],
    };
  });
}

function connectorsParse(text) {
  if (text === null || text === undefined) return { servers: [], missing: true, error: null };
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) {
    return { servers: [], missing: false, error: '.mcp.json could not be read as JSON, so nothing here is trustworthy until it is fixed.' };
  }
  const raw = (parsed && typeof parsed === 'object' && parsed.mcpServers && typeof parsed.mcpServers === 'object') ? parsed.mcpServers : {};
  return { servers: connectorsServersFromRaw(raw), missing: false, error: null };
}

// ~/.claude.json's top-level `mcpServers` object: the operator's user-global
// Claude Code connectors, present in every workspace on this machine. Same
// shape as .mcp.json, so it shares connectorsServersFromRaw; kept as its own
// function (rather than reusing connectorsParse) so a broken ~/.claude.json
// names ITSELF in its error, not the unrelated workspace file.
function connectorsParseUserGlobalJson(text) {
  if (text === null || text === undefined) return { servers: [], missing: true, error: null };
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) {
    return { servers: [], missing: false, error: '~/.claude.json could not be read as JSON, so its user-global connectors are not shown here.' };
  }
  const raw = (parsed && typeof parsed === 'object' && parsed.mcpServers && typeof parsed.mcpServers === 'object') ? parsed.mcpServers : {};
  return { servers: connectorsServersFromRaw(raw), missing: false, error: null };
}

// Codex's config.toml, hand-parsed, minimally: no TOML dependency for a
// format this narrow. Recognises `[mcp_servers.<name>]` tables (bare or
// quoted names) and, inside one, `command`, `args`, `url` and `env_vars`.
// `env_vars` (verified against a real config.toml) NAMES the environment
// variables Codex copies from the launcher process into the server; unlike
// Claude's `env` object there is no credential VALUE anywhere in this file
// to avoid rendering, because Codex's own format never puts one there.
//
// Deliberately tolerant rather than a real TOML parser: an unrecognised line
// is skipped, not a parse failure, because a hand-rolled scanner cannot tell
// "a TOML feature this doesn't cover" from "garbage" without becoming the
// full parser this is explicitly avoiding being. What it must never do, and
// does not do, is turn a section it cannot fully read into a server missing
// fields silently rendered as "(nothing configured)" for no stated reason;
// every field it does not recognise for a name it does track is simply left
// out of that name's target, which is visible in the target text itself.
function connectorsParseToml(text) {
  if (text === null || text === undefined) return { servers: [], missing: true, error: null };
  const lines = String(text).split(/\r?\n/);
  const order = [];
  const byName = {};
  let currentName = null;
  const ensure = (name) => {
    if (!byName[name]) { byName[name] = { command: null, args: null, url: null, envKeys: [] }; order.push(name); }
    return byName[name];
  };
  const unquote = (v) => { const m = v.match(/^"(.*)"$/); return m ? m[1] : v; };
  const parseArray = (v) => {
    const inner = v.replace(/^\[/, '').replace(/\]\s*$/, '').trim();
    return inner ? inner.split(',').map((s) => s.trim()).filter(Boolean).map(unquote) : [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const header = line.match(/^\[mcp_servers\.([A-Za-z0-9_.-]+|"[^"]+")\]$/);
    if (header) {
      currentName = unquote(header[1]);
      ensure(currentName);
      continue;
    }
    // Any other table (`[projects."..."]`, `[[skills.config]]`, `[windows]`,
    // ...) ends the current mcp_servers section: a key read past this point
    // belongs to that table, not to the connector above it.
    if (line.startsWith('[')) { currentName = null; continue; }
    if (!currentName) continue;
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1];
    const val = kv[2].trim();
    const entry = byName[currentName];
    if (key === 'command') entry.command = unquote(val);
    else if (key === 'url') entry.url = unquote(val);
    else if (key === 'args') entry.args = parseArray(val);
    else if (key === 'env_vars') entry.envKeys.push(...parseArray(val));
    // enabled, startup_timeout_sec and anything else this tab does not claim
    // to know are left unread on purpose.
  }
  const servers = order.map((name) => {
    const e = byName[name];
    const isUrl = typeof e.url === 'string' && e.url;
    const target = isUrl ? e.url : [e.command].concat(e.args || []).filter(Boolean).join(' ');
    return { name, transport: isUrl ? 'url' : 'command', target: target || '(nothing configured)', envKeys: e.envKeys };
  });
  return { servers, missing: false, error: null };
}

// The four sources' identity: which runtime reads them, and whether they
// travel with the workspace or belong to this one machine. Fixed key order
// (Object.keys below) also fixes which occurrence a name's "primary"
// definition comes from when several agree, and which side of a drift is
// checked first: workspace before user-global, Claude Code before Codex.
const CONNECTOR_SOURCE_META = {
  claudeWorkspace: { runtime: 'claude', scope: 'workspace' },
  codexWorkspace: { runtime: 'codex', scope: 'workspace' },
  claudeUserGlobal: { runtime: 'claude', scope: 'user-global' },
  codexUserGlobal: { runtime: 'codex', scope: 'user-global' },
};
const CONNECTOR_RUNTIME_LABEL = { claude: 'Claude Code', codex: 'Codex' };

// One row per connector NAME, merged across every source that names it.
// Fourteen rows for seven connectors (one per file) would be noise; this is
// the step that removes it, and the only place drift between what Claude
// Code and Codex each think a connector IS could ever be noticed. Read
// alone, a source that defines "notion" as a bare `npx` command looks
// complete and correct; only sitting it beside the other runtime's
// definition of the same name shows they disagree.
function connectorsBuildRows(sources) {
  const occurrencesByName = new Map();
  for (const key of Object.keys(CONNECTOR_SOURCE_META)) {
    const src = sources[key];
    if (!src || !Array.isArray(src.servers)) continue;
    const meta = CONNECTOR_SOURCE_META[key];
    for (const srv of src.servers) {
      if (!occurrencesByName.has(srv.name)) occurrencesByName.set(srv.name, []);
      occurrencesByName.get(srv.name).push({
        runtime: meta.runtime, scope: meta.scope,
        transport: srv.transport, target: srv.target, envKeys: srv.envKeys || [],
      });
    }
  }
  const rows = [];
  for (const [name, occurrences] of occurrencesByName) {
    const runtimes = [];
    for (const o of occurrences) if (runtimes.indexOf(o.runtime) === -1) runtimes.push(o.runtime);
    const scopes = [];
    for (const o of occurrences) if (scopes.indexOf(o.scope) === -1) scopes.push(o.scope);
    const claudeDef = occurrences.find((o) => o.runtime === 'claude');
    const codexDef = occurrences.find((o) => o.runtime === 'codex');
    // Drift compares SHAPE: transport (url vs command) and the target string
    // (the command with its arguments, or the url), never credential keys,
    // and never a value, because none is ever carried this far.
    let drift = null;
    if (claudeDef && codexDef && (claudeDef.transport !== codexDef.transport || claudeDef.target !== codexDef.target)) {
      drift = {
        claude: { transport: claudeDef.transport, target: claudeDef.target },
        codex: { transport: codexDef.transport, target: codexDef.target },
      };
    }
    const primary = claudeDef || codexDef || occurrences[0];
    const envKeys = [];
    for (const o of occurrences) for (const k of o.envKeys) if (envKeys.indexOf(k) === -1) envKeys.push(k);
    rows.push({ name, runtimes, scopes, drift, transport: primary.transport, target: primary.target, envKeys });
  }
  rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return rows;
}

// Scope stated as what it MEANS, not a badge: a workspace connector travels
// with the folder and everyone opening it gets it; a user-global one is the
// operator's personal reach, present in every workspace on this machine. The
// single-scope wording is unchanged from before this tab read four sources
// (existing tests pin the workspace phrase verbatim).
function connectorsScopeText(scopes) {
  const hasWorkspace = scopes.indexOf('workspace') !== -1;
  const hasUserGlobal = scopes.indexOf('user-global') !== -1;
  if (hasWorkspace && hasUserGlobal) {
    return 'Defined both in this workspace (travels with the folder) and user-global on this machine (present in every workspace here).';
  }
  if (hasUserGlobal) return 'User-global: the operator\'s personal reach, present in every workspace on this machine.';
  return 'Workspace connector: travels with this folder';
}

// Merges the four read results into what connectorsSectionHtml renders.
// The read-that-failed gate stays scoped to .mcp.json alone: it is the one
// source this tab can also WRITE to (the Add form), and a save built from
// bytes never actually read would drop whatever the real file held. The
// other three sources are read-only here; a failure in one of them is
// reported as a source error rather than hiding what the sources that DID
// read still know.
function connectorsBuildState(sources) {
  const mcp = sources.claudeWorkspace || { servers: [], missing: true, error: null };
  if (mcp.error && mcp.readFailed) {
    return { error: mcp.error, readFailed: true, servers: [], missing: false, sourceErrors: [] };
  }
  const sourceErrors = [];
  if (mcp.error) sourceErrors.push(mcp.error); // .mcp.json read fine but is not valid JSON
  for (const key of ['codexWorkspace', 'claudeUserGlobal', 'codexUserGlobal']) {
    const src = sources[key];
    if (src && src.error) sourceErrors.push(src.error);
  }
  const rows = connectorsBuildRows(sources);
  return { error: null, readFailed: false, missing: rows.length === 0, servers: rows, sourceErrors };
}

function connectorsRowHtml(srv) {
  const runtimes = srv.runtimes || ['claude'];
  const scopes = srv.scopes || ['workspace'];
  const badges = runtimes.map((r) => `<span class="connector-badge">${connectorsEsc(CONNECTOR_RUNTIME_LABEL[r] || r)}</span>`).join(' ');
  const scopeText = connectorsScopeText(scopes);
  const phraseFor = (t) => `<span class="settings-value" title="${connectorsEscAttr(t.target)}">${connectorsEsc(t.transport === 'url' ? 'Talks to ' + t.target : 'Starts ' + t.target)}</span>`;
  const targetHtml = srv.drift
    // DRIFT: show BOTH definitions, labelled by runtime, rather than picking
    // one as canonical. Nothing else in the product would ever have said
    // these disagree.
    ? `${connectorsEsc(CONNECTOR_RUNTIME_LABEL.claude)}: ${phraseFor(srv.drift.claude)}<br>${connectorsEsc(CONNECTOR_RUNTIME_LABEL.codex)}: ${phraseFor(srv.drift.codex)}`
    : phraseFor(srv);
  const driftNote = srv.drift
    ? `<span class="settings-prose connector-drift">Claude Code and Codex do not agree on what this connector is.</span>`
    : '';
  return `<div class="settings-row" data-connector="${connectorsEscAttr(srv.name)}" style="flex-direction:column;align-items:stretch;gap:2px">
      <span class="settings-label">${connectorsEsc(srv.name)}${badges}</span>
      <span class="settings-prose" style="opacity:.7">${connectorsEsc(scopeText)}</span>
      ${targetHtml}
      ${driftNote}
      ${srv.envKeys && srv.envKeys.length ? `<span class="settings-prose" style="opacity:.7">Credential keys (values kept out of this file): ${connectorsEsc(srv.envKeys.join(', '))}</span>` : ''}
    </div>`;
}

// ACCOUNT-TIER CONNECTORS (added at claude.ai, reaching every workspace on
// this machine) are deliberately not listed here, and carry no status.
//
// Rundock could shell out to `claude mcp list` and print whatever it
// reports. That command is not a trustworthy source for this tier: on the
// owner's own machine it reported an account connector as connected while
// claude.ai's own account page showed the same connector still needing
// authorisation, and that connector's tools were in fact absent from a real
// agent run that same session. A status this tab cannot verify is worse than
// no status, so none is shown here and `claude mcp list` is never called for
// this purpose. The one honest thing left to say is where the real state
// lives. Codex has no account tier, so there is nothing to caveat for it.
const CONNECTORS_ACCOUNT_TIER_HTML = `<div class="settings-card"><div class="settings-row"><span class="settings-prose">Account connectors are added at claude.ai and reach every workspace on this machine. Rundock does not list them here because it cannot read their state honestly. Manage them at <a href="https://claude.ai/settings/connectors" target="_blank" rel="noopener">claude.ai/settings/connectors</a>.</span></div></div>`;

function connectorsSectionHtml(state) {
  // A read we could not trust draws its error and NOTHING ELSE: no server
  // list to misread as empty, and nothing inviting a change to a file whose
  // current contents are unknown. The panel below it, the add affordance and
  // the account-tier note all describe a state this read never established.
  if (state.error && state.readFailed) {
    return `<div class="settings-section-title">Connectors</div><div class="settings-card"><div class="settings-row"><span class="settings-prose">${connectorsEsc(state.error)}</span></div></div>`;
  }
  // A source other than .mcp.json (Codex's workspace config, or either
  // user-global source) that could not be read is named here, beside
  // whatever the other sources still know, rather than hiding all of it.
  const sourceErrorsHtml = (state.sourceErrors && state.sourceErrors.length)
    ? `<div class="settings-card">${state.sourceErrors.map((e) => `<div class="settings-row"><span class="settings-prose">${connectorsEsc(e)}</span></div>`).join('')}</div>`
    : '';
  let body;
  if (state.error) {
    body = `<div class="settings-card"><div class="settings-row"><span class="settings-prose">${connectorsEsc(state.error)}</span></div></div>`;
  } else if (state.missing || state.servers.length === 0) {
    body = `${sourceErrorsHtml}<div class="settings-card"><div class="settings-row" style="flex-direction:column;align-items:stretch;gap:6px">
      <span class="settings-prose">No connectors configured in this workspace yet.</span>
      <span class="settings-prose">Workspace connectors live in <code>.mcp.json</code> at the workspace root and travel with the folder, so everyone opening this workspace gets them. Connectors added at claude.ai or in Claude Code's own settings are the operator's personal reach and are managed there, not here.</span>
    </div></div>`;
  } else {
    const rows = state.servers.map((srv) => connectorsRowHtml(srv)).join('');
    body = `${sourceErrorsHtml}<div class="settings-card">${rows}</div>`;
  }
  // ADDING A CONNECTOR IS A CONVERSATION, NOT A FORM. A working entry needs
  // more than a name and one field: a command server needs its arguments and
  // usually credentials in `env`, and an HTTP server usually needs auth
  // headers. Two inputs cannot express any of that, so the form's best case
  // was an entry that works only for a server needing no arguments and no
  // auth, and its ordinary case was an entry that looked accepted and could
  // never start. Handing this to the guide matches what Files, Skills and the
  // routine editor already do when a user reaches something they should not
  // hand-author.
  //
  // The affordance is omitted entirely when the workspace has no guide,
  // exactly as those three surfaces omit theirs, rather than offering a
  // button that opens nothing.
  const guide = (typeof getGuide === 'function') ? getGuide() : null;
  // Which agent is the guide is a property of the workspace, so its name is
  // read from the guide rather than written into this copy as a constant.
  // displayName first, then name: `name` is the slug (`rundock-guide`), and
  // putting that in a sentence reads as machinery. Same order skills.js uses
  // for the same reason.
  const guideName = (guide && (guide.displayName || guide.name)) || 'the guide';
  const addHtml = guide
    ? `<div class="settings-card"><div class="settings-row" style="flex-direction:column;align-items:stretch;gap:8px">
      <span class="settings-label">Add a connector</span>
      <span class="settings-prose">Connectors differ in what they need to start: some take a command and arguments, some a URL, and most need credentials. ${connectorsEsc(guideName)} can work out which this one is, write it into <code>.mcp.json</code>, and tell you what it still needs.</span>
      <button class="settings-btn" data-agent-id="${connectorsEscAttr(guide.id)}" onclick="startConversation(this.dataset.agentId)">Talk to ${connectorsEsc(guideName)}</button>
    </div></div>`
    : '';
  return `<div class="settings-section-title">Connectors</div>${body}
    ${addHtml}
    <div class="settings-row"><span class="settings-prose">Connectors are read from <code>.mcp.json</code> at the workspace root, and agents pick up a change on their next start.</span></div>
    ${CONNECTORS_ACCOUNT_TIER_HTML}`;
}


function connectorsRenderIfShowing(state) {
  const el = document.getElementById('settings-content');
  const active = document.querySelector('.settings-nav-item.active');
  if (el && active && active.getAttribute('data-settings') === 'connectors') {
    el.innerHTML = connectorsSectionHtml(state);
  }
}

// Fetch one workspace-relative file through the existing, workspace-scoped
// /api/file route. `errorMessage` names the source that failed: the two
// workspace sources (.mcp.json, .codex/config.toml) must not blame each
// other when a read genuinely fails (a non-404, non-ok response, or the
// request itself throwing).
function connectorsFetchWorkspaceFile(relPath, errorMessage) {
  return fetch('/api/file?path=' + encodeURIComponent(relPath))
    .then((r) => {
      // 404 is the file genuinely not there, an empty workspace: honest to
      // show as "no connectors yet". Every other non-ok answer is a read
      // that DID NOT succeed, and dressing it as an empty workspace is what
      // would let the next Add overwrite a file this simply failed to read.
      if (r.ok) return r.text().then((text) => ({ text, missing: false, error: null }));
      if (r.status === 404) return { text: null, missing: true, error: null };
      return { text: null, missing: false, error: errorMessage };
    })
    .catch(() => ({ text: null, missing: false, error: errorMessage }));
}

// The two user-global sources come back together from one endpoint
// (lib/http-router.js, /api/connectors/machine): both are small, fixed files
// under os.homedir(), and one round trip beats two for what is otherwise the
// same kind of read. A failure of the ENDPOINT ITSELF (as opposed to a
// per-file error, which the endpoint already reports per source) falls back
// to naming both sources here, rather than silently rendering as empty.
function connectorsFetchUserGlobal() {
  return fetch('/api/connectors/machine')
    .then((r) => { if (!r.ok) throw new Error('machine read failed'); return r.json(); })
    .catch(() => ({
      claudeUserGlobal: { text: null, missing: false, error: 'Could not read ~/.claude.json, so your user-global Claude Code connectors are not shown here.' },
      codexUserGlobal: { text: null, missing: false, error: 'Could not read ~/.codex/config.toml, so your user-global Codex connectors are not shown here.' },
    }));
}

function connectorsLoad() {
  // All four reads run together; none depends on another. Returns the
  // combined promise so a caller (a test, or a later chained refresh) can
  // wait for all of them; the running product ignores the return.
  const claudeWorkspacePromise = connectorsFetchWorkspaceFile('.mcp.json',
    'Could not read .mcp.json, so its connectors are not shown. Reopen this tab to retry.')
    .then((res) => {
      if (res.error) return { servers: [], missing: false, readFailed: true, error: res.error };
      return connectorsParse(res.text);
    });
  const codexWorkspacePromise = connectorsFetchWorkspaceFile('.codex/config.toml',
    'Could not read .codex/config.toml, so Codex\'s workspace connectors are not shown here. Reopen this tab to retry.')
    .then((res) => (res.error ? { servers: [], missing: false, error: res.error } : connectorsParseToml(res.text)));
  const userGlobalPromise = connectorsFetchUserGlobal().then((ug) => ({
    claudeUserGlobal: ug.claudeUserGlobal.error
      ? { servers: [], missing: false, error: ug.claudeUserGlobal.error }
      : connectorsParseUserGlobalJson(ug.claudeUserGlobal.text),
    codexUserGlobal: ug.codexUserGlobal.error
      ? { servers: [], missing: false, error: ug.codexUserGlobal.error }
      : connectorsParseToml(ug.codexUserGlobal.text),
  }));
  return Promise.all([claudeWorkspacePromise, codexWorkspacePromise, userGlobalPromise])
    .then(([claudeWorkspace, codexWorkspace, userGlobal]) => {
      const state = connectorsBuildState({
        claudeWorkspace, codexWorkspace,
        claudeUserGlobal: userGlobal.claudeUserGlobal,
        codexUserGlobal: userGlobal.codexUserGlobal,
      });
      connectorsRenderIfShowing(state);
      return state;
    });
}

// Per-workspace state must not outlive its workspace: the same rule
// packagesWorkspaceChanged enforces. The panel is cleared so a switch never
// leaves one workspace's connectors on screen under another's name.
function connectorsWorkspaceChanged() {
  connectorsRenderIfShowing({ servers: [], missing: false, readFailed: true, error: 'Reopen this tab to read this workspace\'s connectors.' });
}

return { showSettingsSection, renderSettingsSection, setWorkspaceMode, runtimeRowHtml, runtimesCardHtml, renderRuntimesCard, changeWorkspace,
  packagesSubmit, packagesCancel, packagesConfirm, packagesRetry,
  packagesReplyArrived, packagesWorkspaceChanged, packagesConnectionLost,
  connectorsParse, connectorsParseToml, connectorsParseUserGlobalJson,
  connectorsBuildRows, connectorsBuildState, connectorsRowHtml, connectorsScopeText,
  connectorsSectionHtml, connectorsLoad, connectorsWorkspaceChanged };
}));
