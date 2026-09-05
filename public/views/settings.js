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
// The tab reads and edits the workspace's own connector configuration,
// `.mcp.json` at the workspace root, which is the file the runtime reads
// (per-user credentials from `.rundock/mcp-secrets.json` are merged in at
// spawn; their KEYS are named here and their values never shown or edited).
// Everything the tab knows arrives through Rundock's own server: the file
// read and the file save. No request leaves the machine.
//
// PURE HALF FIRST, so what a row says is testable without a page. The parse
// is tolerant of a file that is missing (an empty state, not an error) and
// loud about one that cannot be read as JSON (an error naming the file,
// never rendered as "no connectors": a person with a broken config needs
// told, not reassured).

// Local escapes, so the pure half stays requireable off the page. The page
// defines global helpers; under node there is no page, and a test driving
// what a row says should not need one.
function connectorsEsc(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function connectorsEscAttr(v) {
  return connectorsEsc(v).replace(/"/g, '&quot;');
}

function connectorsParse(text) {
  if (text === null || text === undefined) return { servers: [], missing: true, error: null };
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) {
    return { servers: [], missing: false, error: '.mcp.json could not be read as JSON, so nothing here is trustworthy until it is fixed.' };
  }
  const raw = (parsed && typeof parsed === 'object' && parsed.mcpServers && typeof parsed.mcpServers === 'object') ? parsed.mcpServers : {};
  const servers = Object.keys(raw).map((name) => {
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
  return { servers, missing: false, error: null };
}

// Merging an added server re-reads nothing: the caller hands the freshest
// text it has, and the merge refuses to replace an existing name, because
// silently replacing a connector somebody configured is an edit they did not
// make. Returns the next file text, or null with the reason on refusals.
function connectorsMerge(text, name, entry) {
  let parsed = {};
  if (text) {
    try { parsed = JSON.parse(text); } catch (e) { return { next: null, reason: '.mcp.json is not valid JSON; fix the file before adding to it.' }; }
  }
  if (!parsed || typeof parsed !== 'object') parsed = {};
  if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') parsed.mcpServers = {};
  if (!name || !/^[\w.-]+$/.test(name)) return { next: null, reason: 'A connector needs a plain name (letters, digits, dots, dashes).' };
  if (parsed.mcpServers[name]) return { next: null, reason: `A connector named "${name}" already exists; edit .mcp.json to change it.` };
  parsed.mcpServers[name] = entry;
  return { next: JSON.stringify(parsed, null, 2) + '\n', reason: null };
}

function connectorsSectionHtml(state) {
  // A read we could not trust draws its error and NOTHING ELSE: no server
  // list to misread as empty, and no Add form, because a write built on text
  // we never saw is the overwrite this whole state exists to prevent.
  if (state.error && state.readFailed) {
    return `<div class="settings-section-title">Connectors</div><div class="settings-card"><div class="settings-row"><span class="settings-prose">${connectorsEsc(state.error)}</span></div></div>`;
  }
  let body;
  if (state.error) {
    body = `<div class="settings-card"><div class="settings-row"><span class="settings-prose">${connectorsEsc(state.error)}</span></div></div>`;
  } else if (state.missing || state.servers.length === 0) {
    body = `<div class="settings-card"><div class="settings-row" style="flex-direction:column;align-items:stretch;gap:6px">
      <span class="settings-prose">No connectors configured in this workspace yet.</span>
      <span class="settings-prose">Workspace connectors live in <code>.mcp.json</code> at the workspace root and travel with the folder, so everyone opening this workspace gets them. Connectors added at claude.ai or in Claude Code's own settings are the operator's personal reach and are managed there, not here.</span>
    </div></div>`;
  } else {
    const rows = state.servers.map(srv => `<div class="settings-row" data-connector="${connectorsEscAttr(srv.name)}" style="flex-direction:column;align-items:stretch;gap:2px">
      <span class="settings-label">${connectorsEsc(srv.name)} <span class="settings-prose" style="opacity:.7">Workspace connector: travels with this folder</span></span>
      <span class="settings-value" title="${connectorsEscAttr(srv.target)}">${connectorsEsc(srv.transport === 'url' ? 'Talks to ' + srv.target : 'Starts ' + srv.target)}</span>
      ${srv.envKeys.length ? `<span class="settings-prose" style="opacity:.7">Credential keys (values kept out of this file): ${connectorsEsc(srv.envKeys.join(', '))}</span>` : ''}
    </div>`).join('');
    body = `<div class="settings-card">${rows}</div>`;
  }
  return `<div class="settings-section-title">Connectors</div>${body}
    <div class="settings-card"><div class="settings-row" style="flex-direction:column;align-items:stretch;gap:8px">
      <span class="settings-label">Add a connector</span>
      <input class="settings-input" id="connector-name" placeholder="Name (for example: notion)">
      <input class="settings-input" id="connector-target" placeholder="Command to start it, or its URL">
      <div class="settings-prose" id="connector-add-note" style="min-height:1em"></div>
      <button class="settings-btn" onclick="connectorsAdd()">Add to .mcp.json</button>
    </div></div>
    <div class="settings-row"><span class="settings-prose">Edits land in <code>.mcp.json</code>, the same file agents read their connectors from on their next start.</span></div>`;
}

// Three states, kept apart because conflating them destroys a file. `null`
// means "not yet read" and also "read and the file is genuinely absent"; a
// string is the file's known-current bytes; the read-failed flag is neither,
// and is the one state from which a write must never proceed. connectorsAdd
// reads these, so a save can only ever be built from bytes we actually saw.
let connectorsFileText = null;
let connectorsReadFailed = false;

function connectorsRenderIfShowing(state) {
  const el = document.getElementById('settings-content');
  const active = document.querySelector('.settings-nav-item.active');
  if (el && active && active.getAttribute('data-settings') === 'connectors') {
    el.innerHTML = connectorsSectionHtml(state);
  }
}

function connectorsLoad() {
  connectorsReadFailed = false;
  // Returns its promise so a caller (a test, or a later chained refresh) can
  // wait for the read to resolve; the running product ignores the return.
  return fetch('/api/file?path=' + encodeURIComponent('.mcp.json'))
    .then((r) => {
      // 404 is the file genuinely not there, an empty workspace: honest to
      // show as "no connectors yet". Every other non-ok answer is a read
      // that DID NOT succeed, and dressing it as an empty workspace is what
      // lets the next Add overwrite a file we simply failed to read.
      if (r.ok) return r.text().then((text) => { connectorsFileText = text; connectorsReadFailed = false; return connectorsParse(text); });
      if (r.status === 404) { connectorsFileText = null; connectorsReadFailed = false; return connectorsParse(null); }
      connectorsFileText = null; connectorsReadFailed = true;
      return { servers: [], missing: false, readFailed: true, error: 'Could not read .mcp.json, so its connectors are not shown and nothing new can be added until the read succeeds. Reopen this tab to retry.' };
    })
    .catch(() => {
      connectorsFileText = null; connectorsReadFailed = true;
      connectorsRenderIfShowing({ servers: [], missing: false, readFailed: true, error: 'Could not read .mcp.json, so its connectors are not shown and nothing new can be added until the read succeeds. Reopen this tab to retry.' });
      return null;
    })
    .then((state) => { if (state) connectorsRenderIfShowing(state); });
}

// Per-workspace state must not outlive its workspace: the same rule
// packagesWorkspaceChanged enforces. Dropped so a save can never carry one
// workspace's connectors into another's file after a switch.
function connectorsWorkspaceChanged() {
  connectorsFileText = null;
  connectorsReadFailed = false;
  connectorsRenderIfShowing({ servers: [], missing: false, readFailed: true, error: 'Reopen this tab to read this workspace\'s connectors.' });
}

function connectorsAdd() {
  const note = document.getElementById('connector-add-note');
  // Never build a save from text we did not read. connectorsFileText is null
  // for both "absent" and "read failed"; the flag tells them apart, and a
  // failed read is the one case where merging from null would drop the real
  // file's servers. A missing file (flag clear, text null) legitimately
  // merges from an empty object.
  if (connectorsReadFailed) {
    if (note) note.textContent = 'The connector file could not be read, so nothing can be added until it can. Reopen this tab to retry.';
    return;
  }
  const name = (document.getElementById('connector-name') || {}).value || '';
  const target = ((document.getElementById('connector-target') || {}).value || '').trim();
  if (!target) { if (note) note.textContent = 'Say what it starts or where it lives.'; return; }
  const entry = /^https?:\/\//.test(target)
    ? { url: target }
    : { command: target.split(/\s+/)[0], args: target.split(/\s+/).slice(1) };
  const merged = connectorsMerge(connectorsFileText, name.trim(), entry);
  if (!merged.next) { if (note) note.textContent = merged.reason; return; }
  if (typeof ws === 'undefined' || !ws || ws.readyState !== WebSocket.OPEN) {
    if (note) note.textContent = 'Not connected; try again in a moment.';
    return;
  }
  ws.send(JSON.stringify({ type: 'save_file', path: '.mcp.json', content: merged.next }));
  // Read back through the same road the render reads, so what the page shows
  // afterwards is what actually landed rather than what was sent.
  setTimeout(connectorsLoad, 200);
}

return { showSettingsSection, renderSettingsSection, setWorkspaceMode, runtimeRowHtml, runtimesCardHtml, renderRuntimesCard, changeWorkspace,
  packagesSubmit, packagesCancel, packagesConfirm, packagesRetry,
  packagesReplyArrived, packagesWorkspaceChanged, packagesConnectionLost,
  connectorsParse, connectorsMerge, connectorsSectionHtml, connectorsLoad, connectorsAdd, connectorsWorkspaceChanged };
}));
