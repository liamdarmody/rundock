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
// The extension half of the install section: same model module, its own
// state, because a person can abandon one flow without disturbing the other.
let extensionInstall = (typeof RundockPackagesInstallModel !== 'undefined') ? RundockPackagesInstallModel.extInitial() : null;

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

// The extension flow's transitions travel the same one-socket rule as the
// pack flow's: a send that cannot go out resets to a stated not-connected
// error rather than pretending something is in flight.
function extensionApplyTransition(out) {
  if (out.send) {
    if (!(ws && ws.readyState === WebSocket.OPEN)) {
      extensionInstall = {
        ...RundockPackagesInstallModel.extInitial(),
        url: (extensionInstall && extensionInstall.url) || '',
        reference: (extensionInstall && extensionInstall.reference) || '',
        fieldError: 'Not connected: nothing was sent. Try again once the connection returns.',
      };
      packagesRenderIfVisible();
      return;
    }
    ws.send(JSON.stringify(out.send));
  }
  extensionInstall = out.state;
  packagesRenderIfVisible();
}

function extensionSubmit() {
  const urlField = document.getElementById('extension-source-url');
  const refField = document.getElementById('extension-source-ref');
  extensionApplyTransition(RundockPackagesInstallModel.extSubmit(
    extensionInstall, urlField ? urlField.value : '', refField ? refField.value : ''));
}
function extensionConfirm() { extensionApplyTransition(RundockPackagesInstallModel.extConfirm(extensionInstall)); }
function extensionDecline() { extensionApplyTransition(RundockPackagesInstallModel.extDecline(extensionInstall)); }
function extensionBack() { extensionApplyTransition({ state: RundockPackagesInstallModel.extInitial() }); }
function extensionReplyArrived(msg) { extensionApplyTransition(RundockPackagesInstallModel.extReply(extensionInstall, msg)); }

// Per-workspace state must not outlive the workspace it was built from: a
// plan's collision facts, planned digests and default readings all describe
// one workspace, so a change of workspace returns the flow to idle.
function packagesWorkspaceChanged() {
  packagesInstall = RundockPackagesInstallModel.initial();
  extensionInstall = RundockPackagesInstallModel.extInitial();
  packagesRenderIfVisible();
}

// A dropped connection ends any wait this flow is in; the model owns the
// words for each phase, including the honest uncertainty of a lost apply.
function packagesConnectionLost() {
  const out = RundockPackagesInstallModel.connectionLost(packagesInstall);
  // Identity means no wait was in progress: repainting here would wipe a
  // half-typed path for nothing.
  if (out.state !== packagesInstall) packagesApplyTransition(out);
  const extOut = RundockPackagesInstallModel.extConnectionLost(extensionInstall);
  if (extOut.state !== extensionInstall) extensionApplyTransition(extOut);
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
  return `<div class="settings-section-title">Packages</div>${field}${stateHtml}${extensionSectionHtml()}`;
}

function extensionSectionHtml() {
  const m = RundockPackagesInstallModel;
  const st = extensionInstall;
  const idle = st.phase === 'ext-idle';
  const field = `<div class="settings-card">
      <div class="packages-field-label">Install an extension from GitHub</div>
      <div class="packages-field-row">
        <input id="extension-source-url" class="packages-input" type="text" placeholder="Repository URL or owner/repo"
          value="${escAttr(st.url || '')}" ${idle ? '' : 'disabled'}>
        <input id="extension-source-ref" class="packages-input packages-input-ref" type="text" placeholder="Tag or commit"
          value="${escAttr(st.reference || '')}" ${idle ? '' : 'disabled'}>
        <button class="settings-btn" onclick="extensionSubmit()" ${idle ? '' : 'disabled'}>Read it</button>
      </div>
      ${st.fieldError ? `<div class="packages-field-error">${esc(st.fieldError)}</div>` : ''}
    </div>`;
  let stateHtml = '';
  if (st.phase === 'ext-acquiring') {
    stateHtml = `<div class="settings-card packages-state"><div class="packages-spinner"></div>Fetching the pinned snapshot…</div>`;
  } else if (st.phase === 'ext-trust') {
    const copy = m.extTrustCopy(st);
    stateHtml = `<div class="settings-card packages-confirm-card extension-trust-card">
        <div class="packages-headline">${esc(copy.headline)}</div>
        <div class="packages-body">${esc(copy.sourceLine)}</div>
        <div class="packages-body extension-facts-lead">${esc(copy.factsLead)}</div>
        <ul class="extension-facts-files">${copy.files.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
        <div class="packages-body">${esc(copy.body)}</div>
        <div class="packages-body extension-match-line">${esc(copy.matchLine)}</div>
        ${copy.replacesLine ? `<div class="packages-body">${esc(copy.replacesLine)}</div>` : ''}
        <div class="packages-actions">
          <button class="settings-btn packages-confirm" onclick="extensionConfirm()">${esc(copy.confirmLabel)}</button>
          <button class="settings-btn packages-cancel" onclick="extensionDecline()">${esc(copy.declineLabel)}</button>
        </div>
      </div>`;
  } else if (st.phase === 'ext-installing') {
    stateHtml = `<div class="settings-card packages-state"><div class="packages-spinner"></div>Installing…</div>`;
  } else if (st.phase === 'ext-failed') {
    stateHtml = `<div class="settings-card packages-state packages-failed">
        <div class="packages-headline">That didn't work</div>
        <div class="packages-body">${esc(st.message)}</div>
        <div class="packages-actions"><button class="settings-btn" onclick="extensionBack()">Back</button></div>
      </div>`;
  } else if (st.phase === 'ext-done') {
    stateHtml = `<div class="settings-card packages-success-card">
        <div class="packages-headline">Installed ${esc(st.record.name)} ${esc(st.record.version)}</div>
        <div class="packages-body">Pinned at ${esc(st.record.source.reference)}. Update checks read this record, so you never enter the URL again.</div>
        <div class="packages-actions"><button class="settings-btn" onclick="extensionBack()">Done</button></div>
      </div>`;
  }
  return field + stateHtml;
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
    const modeDesc = isCode
      ? 'Agents can write any file type and run commands without approval.'
      : 'Agents work with documents only. Terminal commands need approval.';
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

return { showSettingsSection, renderSettingsSection, setWorkspaceMode, runtimeRowHtml, runtimesCardHtml, renderRuntimesCard, changeWorkspace,
  packagesSubmit, packagesCancel, packagesConfirm, packagesRetry,
  packagesReplyArrived, packagesWorkspaceChanged, packagesConnectionLost,
  // The extension flow's own onclick names and its reply entry, published
  // for the same reason the pack flow's are: the generated markup and the
  // app.js dispatch case resolve these against the module's exported
  // surface, not against private closure variables.
  extensionSubmit, extensionConfirm, extensionDecline, extensionBack, extensionReplyArrived };
}));
