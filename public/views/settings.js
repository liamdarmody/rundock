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

// ---- Packages install flow (hosting section and states) ----
// All flow logic lives in RundockPackagesInstallModel; this file only renders
// the model's state and forwards the person's actions and the server's
// replies. The model decides what, if anything, is sent. One link field
// serves both kinds: the server classifies the bytes and answers with either
// the trust step or the plain offer, and this file draws whichever arrived.
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

// WHAT IS BEING TYPED OUTLIVES A REDRAW. The field's value lives in the DOM
// until Add reads it, and the section redraws whenever any reply for the
// page lands: opening Packages asks every installed package for updates, so
// answers arrive while the person is still pasting. Drawn from the state
// alone, each of those answers emptied the field, and Add then read nothing.
// So a redraw that leaves the flow idle carries the typed value, the focus
// and the caret across. Only an open field is carried: a disabled one shows
// the state's own link, and every other phase draws from the state.
function packagesTypingBefore(el) {
  const field = el.querySelector('#packages-source-link');
  if (!field || field.disabled) return null;
  return {
    value: field.value,
    focused: field.ownerDocument.activeElement === field,
    start: field.selectionStart,
    end: field.selectionEnd,
  };
}

function packagesTypingRestore(el, typing) {
  if (!typing || !packagesInstall || packagesInstall.phase !== 'idle') return;
  const field = el.querySelector('#packages-source-link');
  if (!field || field.disabled) return;
  field.value = typing.value;
  if (!typing.focused) return;
  field.focus();
  try { field.setSelectionRange(typing.start, typing.end); } catch { /* a field that cannot hold a selection keeps the focus alone */ }
}

// A PACKAGE CARD THAT HAS FOCUS KEEPS IT ACROSS A REDRAW. "its package" and
// "From the ... package" on the Extensions page open Packages with focus on
// that package's card, and opening Packages reads the page again and checks
// every package for updates. Each answer redraws the section from the state,
// which replaced the focused card with a fresh one and left focus on the
// body. So a redraw that finds a card focused focuses the same card again.
function packagesCardFocusBefore(el) {
  const active = el.ownerDocument.activeElement;
  if (!active || !el.contains(active) || !active.classList.contains('pkg-card-row')) return null;
  return active.dataset.package || null;
}

function packagesFocusCard(el, id) {
  const card = [...el.querySelectorAll('.pkg-card-row[data-package]')].find((c) => c.dataset.package === id);
  if (!card) return false;
  card.setAttribute('tabindex', '-1');
  card.focus();
  return true;
}

// The one transition: a step that wants to send only takes effect if the
// message was actually handed to an open socket; otherwise the flow stays
// usable and says plainly that nothing went out.
function packagesApplyTransition(out) {
  if (out.send) {
    if (!(ws && ws.readyState === WebSocket.OPEN)) {
      // A projection that could not be asked for must not cost the review:
      // the plan and every decision stand, the new decision included, with
      // no projection until one can be asked. Submit and confirm have no
      // decision work to lose, so those still return the section to idle,
      // keeping the typed link.
      packagesInstall = out.send.type === 'evaluate_package_decisions'
        ? { ...out.state, fieldError: 'Not connected: your decisions are kept, but the last one could not be checked. Try again once the connection returns.' }
        : {
          ...RundockPackagesInstallModel.initial(),
          link: (packagesInstall && packagesInstall.link) || '',
          reference: (packagesInstall && packagesInstall.reference) || '',
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
  const link = document.getElementById('packages-source-link');
  packagesApplyTransition(RundockPackagesInstallModel.submit(packagesInstall, link ? link.value : ''));
}

function packagesCancel() { packagesApplyTransition(RundockPackagesInstallModel.cancel(packagesInstall)); }
function packagesSetDecision(id, decision) { packagesApplyTransition(RundockPackagesInstallModel.setDecision(packagesInstall, id, decision)); }
function packagesDecline() { packagesApplyTransition(RundockPackagesInstallModel.decline(packagesInstall)); }
function packagesConfirm() { packagesApplyTransition(RundockPackagesInstallModel.confirm(packagesInstall)); }
function packagesRetry() { packagesApplyTransition(RundockPackagesInstallModel.retry(packagesInstall)); }

// Every reply for the page reaches both models: the install flow matches
// what it is waiting on, the manage model matches its own operations and
// asks for the page again when a record or a receipt changed under a flow
// it does not drive.
function packagesReplyArrived(msg) {
  packagesApplyTransition(RundockPackagesInstallModel.reply(packagesInstall, msg));
  packagesManageApply(manageModel().reply(packagesManage, msg));
  if (updateModel()) packagesUpdateApply(updateModel().reply(packagesUpdate, msg));
}

// Per-workspace state must not outlive the workspace it was built from: a
// plan's collision facts, planned digests and default readings all describe
// one workspace, so a change of workspace returns the flow to idle, and the
// managed list is read again for the workspace now open.
function packagesWorkspaceChanged() {
  // A link typed for the workspace that is gone is not carried into the
  // next one: the field is emptied before the redraw could keep it.
  const field = typeof document !== 'undefined' ? document.getElementById('packages-source-link') : null;
  if (field) field.value = '';
  packagesInstall = RundockPackagesInstallModel.initial();
  packagesManage = manageModel().workspaceChanged();
  if (updateModel()) packagesUpdate = updateModel().workspaceChanged();
  packagesClearAsked = false;
  packagesRenderIfVisible();
}

// ---- The managed list and the receipts (the manage half of the page) ----
// The manage model owns every row state, chip tone and message; this half
// draws its rows and forwards actions. Update is the one handoff: the manage
// model names the target and the install flow plans it, so the confirmation
// is the trust card an install shows. The model is a page global in the
// browser and is required beside this view under Node.
// The page global in a browser, the sibling module under CommonJS, and null
// in neither: four other views' tests evaluate this file in a bare JSDOM
// window, where the global is absent and `require` does not exist. A version
// of this that reached for `require` unconditionally threw at load and took
// every render in those suites with it, and the failure did not name this
// line: it surfaced as `require is not defined` inside an eval, in tests
// about working folders and permissions that have nothing to do with
// packages. Degrading to null matches the install model above.
function manageModel() {
  if (typeof RundockPackagesManageModel !== 'undefined') return RundockPackagesManageModel;
  return (typeof module === 'object' && module.exports) ? require('../packages-manage-model.js') : null;
}
let packagesManage = manageModel() ? manageModel().initial() : null;

function packagesManageApply(out) {
  if (out.send) {
    if (!(ws && ws.readyState === WebSocket.OPEN)) {
      packagesManage = manageModel().unsent(out.state);
      packagesRenderIfVisible();
      return;
    }
    ws.send(JSON.stringify(out.send));
  }
  packagesManage = out.state;
  packagesRenderIfVisible();
}

// A receipt item opens the live thing where it now lives: the agent's
// profile under Team, the skill's page under Skills, the path under Files,
// a routine the Routines page, where its schedule can be read and changed,
// and an extension the Extensions page, where it is managed.
function packagesOpenReceiptItem(open, target) {
  if (open === 'agent' && typeof showProfile === 'function') { switchNav('team'); showProfile(target); }
  else if (open === 'skill' && typeof selectSkill === 'function') { switchNav('skills'); selectSkill(target); }
  else if (open === 'file' && typeof openWorkspaceFilePath === 'function') openWorkspaceFilePath(target);
  else if (open === 'routine' && typeof switchNav === 'function') switchNav('routines');
  else if (open === 'extension') showSettingsSection('extensions');
}

// ---- Package updates: the check, the update row on a package's history
// entry, the review, and the summary afterwards. All of it is decided in
// RundockPackagesUpdateModel; this half draws it and forwards the person's
// actions. Resolved the way manageModel() is, and for the same reason.
function updateModel() {
  if (typeof RundockPackagesUpdateModel !== 'undefined') return RundockPackagesUpdateModel;
  return (typeof module === 'object' && module.exports) ? require('../packages-update-model.js') : null;
}
let packagesUpdate = updateModel() ? updateModel().initial() : null;
let packagesClearAsked = false;

function packagesUpdateApply(out) {
  if (out.send) {
    if (!(ws && ws.readyState === WebSocket.OPEN)) {
      packagesManage = manageModel().unsent(packagesManage);
      packagesRenderIfVisible();
      return;
    }
    ws.send(JSON.stringify(out.send));
  }
  packagesUpdate = out.state;
  packagesRenderIfVisible();
}

function packagesReviewUpdate(id) { packagesUpdateApply(updateModel().beginReview(packagesUpdate, id)); }
function packagesConfirmUpdate() { packagesUpdateApply(updateModel().confirm(packagesUpdate)); }
function packagesCancelUpdate() { packagesUpdateApply(updateModel().cancel(packagesUpdate)); }
function packagesDismissUpdate() { packagesUpdateApply(updateModel().dismissDone(packagesUpdate)); }

// The ready-made prompt goes to the clipboard, and nowhere else.
function packagesCopyUpdatePrompt() {
  const copy = updateModel().doneCopy(packagesUpdate);
  if (!copy || !copy.prompt) return;
  const done = () => {
    const button = document.getElementById('packages-copy-prompt');
    if (button) button.textContent = 'Copied';
  };
  if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(copy.prompt).then(done, () => {});
}

// Clear asks first, in the row itself, and only then sends.
function packagesClearUpdatesFolder() {
  if (!packagesClearAsked) { packagesClearAsked = true; packagesRenderIfVisible(); return; }
  packagesClearAsked = false;
  packagesUpdateApply({ state: packagesUpdate, send: { type: 'clear_package_updates' } });
}
function packagesKeepUpdatesFolder() { packagesClearAsked = false; packagesRenderIfVisible(); }

function packagesCheckOne(id) { packagesUpdateApply(updateModel().checkOne(packagesUpdate, id)); }
function packagesAskUninstall(id) { packagesUpdateApply(updateModel().beginUninstall(packagesUpdate, id)); }
function packagesConfirmUninstallPackage() { packagesUpdateApply(updateModel().confirmUninstall(packagesUpdate)); }
function packagesCancelUninstallPackage() { packagesUpdateApply(updateModel().cancelUninstall(packagesUpdate)); }

// A card's action column: one press, naming its package.
function packagesCardAction(action, id) {
  if (action === 'check') return packagesCheckOne(id);
  if (action === 'update') return packagesReviewUpdate(id);
  if (action === 'uninstall') return packagesAskUninstall(id);
}

function packagesGroupsHtml(groups) {
  return groups.map((g) => `<div class="pkg-review-group"${g.key ? ` data-group="${escAttr(g.key)}"` : ''}>
        <div class="pkg-review-group-label">${esc(g.label)}</div>
        <div class="pkg-review-group-sub">${esc(g.sub)}</div>
        ${g.items.map((i) => (typeof i === 'string' ? `<div class="pkg-review-item">${esc(i)}</div>`
    : `<div class="pkg-review-item">${esc(i.label)}</div>${(i.routines || []).concat(i.privileges || []).map((line) => `<div class="pkg-review-disclosure">${esc(line)}</div>`).join('')}`)).join('')}
      </div>`).join('');
}

function packagesUpdateReviewHtml(copy) {
  return `<div class="pkg-card-review" id="packages-update-review">
      <div class="pkg-review-title">${esc(copy.title)}</div>
      ${packagesGroupsHtml(copy.groups)}
      <div class="pkg-review-note">${esc(copy.note)} ${esc(copy.summary)}</div>
      <div class="pkg-card-actions">
        <button class="settings-btn" ${copy.disabled ? 'disabled' : ''} onclick="packagesCancelUpdate()">${esc(copy.cancelLabel)}</button>
        <button class="settings-btn-primary" ${copy.disabled ? 'disabled' : ''} onclick="packagesConfirmUpdate()">${esc(copy.confirmLabel)}</button>
      </div>
    </div>`;
}

function packagesUpdateDoneHtml(done) {
  return `<div class="pkg-card-review" id="packages-update-done">
      <div class="pkg-review-title">${esc(done.text)}</div>
      ${done.prompt ? `<div class="pkg-review-note">${esc(done.promptLead)}</div>
        <pre class="pkg-review-prompt">${esc(done.prompt)}</pre>` : ''}
      <div class="pkg-card-actions">
        ${done.prompt ? '<button class="settings-btn" id="packages-copy-prompt" onclick="packagesCopyUpdatePrompt()">Copy prompt</button>' : ''}
        <button class="settings-btn" onclick="packagesDismissUpdate()">Done</button>
      </div>
    </div>`;
}

function packagesUninstallHtml(copy) {
  return `<div class="pkg-card-confirm" id="packages-uninstall-confirm">
      <div class="pkg-review-title">${esc(copy.title)}</div>
      ${packagesGroupsHtml(copy.groups)}
      ${copy.nothing ? `<div class="pkg-review-note">${esc(copy.nothing)}</div>` : ''}
      <div class="pkg-card-actions">
        <button class="settings-btn-danger" ${copy.disabled ? 'disabled' : ''} onclick="packagesConfirmUninstallPackage()">${esc(copy.confirmLabel)}</button>
        <button class="settings-btn" ${copy.disabled ? 'disabled' : ''} onclick="packagesCancelUninstallPackage()">${esc(copy.cancelLabel)}</button>
      </div>
    </div>`;
}

// One card per installed package, to the approved page design.
function packagesCardHtml(c) {
  const actions = c.actions.map((a) => `<button class="linkbtn${a.accent ? ' accent' : ''}${a.danger ? ' pkg-card-uninstall' : ''}" data-action="${escAttr(a.action)}" ${a.disabled ? 'disabled' : ''} onclick="packagesCardAction('${escAttr(a.action)}', '${escAttr(c.id)}')">${esc(a.label)}</button>`).join('');
  const status = c.status ? `<div class="pkg-card-status${c.status.tone === 'update' ? ' is-update' : c.status.tone === 'danger' ? ' is-danger' : ''}">${esc(c.status.text)}</div>` : '';
  // An item still in the workspace is a link to it; one that is gone is
  // plain text marked removed, with nothing in it to press.
  const itemHtml = (i) => {
    const kind = `<span class="kind">${esc(i.mark ? `${i.kind}, ${i.mark}` : i.kind)}</span>`;
    if (!i.open) return `<span class="pkg-card-gone">${esc(i.label)}${kind}</span>`;
    return `<button class="linkbtn" onclick="packagesOpenReceiptItem('${escAttr(i.open)}', '${escAttr(i.target)}')">${esc(i.label)}${kind}</button>`;
  };
  const items = c.items.length ? `<div class="pkg-card-items">${c.items.map(itemHtml).join('')}</div>` : '';
  const repo = c.repoUrl ? `<a class="linkbtn" href="${escAttr(c.repoUrl)}">${esc(c.repoLabel)}</a>` : `<span>${esc(c.repoLabel)}</span>`;
  return `<div class="pkg-card-row" data-package="${escAttr(c.id)}">
      <div class="pkg-card-top">
        <div class="pkg-card-id">
          <div class="pkg-card-name-line"><span class="pkg-card-name">${esc(c.title)}</span>${c.version ? `<span class="pkg-card-ver">${esc(c.version)}</span>` : ''}${c.chip ? `<span class="pkg-card-chip">${esc(c.chip)}</span>` : ''}</div>
          <div class="pkg-card-repo">${repo}</div>
          ${status}
          ${c.counts ? `<div class="pkg-card-counts">${esc(c.counts)}</div>` : ''}
          ${items}
        </div>
        <div class="pkg-card-controls">${actions}</div>
      </div>
      ${c.review ? packagesUpdateReviewHtml(c.review) : ''}${c.done ? packagesUpdateDoneHtml(c.done) : ''}${c.uninstall ? packagesUninstallHtml(c.uninstall) : ''}
    </div>`;
}

function packagesManageHtml() {
  const m = manageModel();
  const st = packagesManage;
  let list;
  if (st.error) list = `<div class="pkg-empty is-danger">${esc(RundockPackagesInstallModel.sentence(st.error))}</div>`;
  else if (!st.loaded) list = '<div class="pkg-empty">Reading what you\'ve installed…</div>';
  else {
    const cards = updateModel().cardRows(packagesUpdate, st);
    list = cards.length ? cards.map(packagesCardHtml).join('') : '<div class="pkg-empty">No packages installed yet. Paste a package link above to get started.</div>';
  }
  const notices = [st.notice, packagesUpdate && packagesUpdate.notice].filter(Boolean)
    .map((n) => `<div class="ext-notice ${escAttr(n.tone)}">${esc(RundockPackagesInstallModel.sentence(n.text))}</div>`).join('');
  const folder = m.folderLabel(st);
  const folderRow = folder ? `<div class="pkg-updates-folder" id="packages-updates-folder">
      <span>${esc(packagesClearAsked ? 'Clear every saved author version and backup? Your workspace files aren\'t touched.' : folder)}</span>
      ${packagesClearAsked
    ? '<span class="pkg-card-actions"><button class="settings-btn" onclick="packagesKeepUpdatesFolder()">Keep them</button><button class="settings-btn-danger" onclick="packagesClearUpdatesFolder()">Clear</button></span>'
    : '<button class="settings-btn" onclick="packagesClearUpdatesFolder()">Clear</button>'}
    </div>` : '';
  return `<div class="settings-section-label">Installed packages</div>
    <div class="settings-card pkg-list" id="packages-installed">${list}</div>${notices}${folderRow}`;
}

// The server serving a different workspace than this window opened, which
// is what a switch made from another window looks like from here: an offer
// or trust step on screen described this window's workspace, and the server
// would refuse its confirm now, so the flow returns to its start rather
// than showing a card whose facts no longer hold.
function packagesServingWorkspaceChanged(servingPath) {
  if (typeof currentWorkspacePath === 'undefined' || servingPath === currentWorkspacePath) return;
  packagesWorkspaceChanged();
}

// A dropped connection ends any wait this flow is in; the model owns the
// words for each phase, including the honest uncertainty of a lost apply.
function packagesConnectionLost() {
  const out = RundockPackagesInstallModel.connectionLost(packagesInstall);
  // Identity means no wait was in progress: repainting here would wipe a
  // half-typed link for nothing.
  if (out.state !== packagesInstall) packagesApplyTransition(out);
  if (packagesManage && packagesManage.busy) packagesManageApply(manageModel().connectionLost(packagesManage));
}

// The collision review card: every offered item as a row, collisions carrying
// their own overwrite-or-skip choice with skip preselected, blocked rows
// carrying the one action that clears them, and a confirm whose label says
// exactly what pressing it does. All words come from the model, and so does
// every row's data-tone: REVIEW_TONES there is the one source, read at
// render time, never restated here. Escaped through this file's own
// Node-safe helpers, as the connectors half is, so a test renders the real
// rows without a page and without a second copy of the escaping rule. A
// control's decision rides on its own data attribute and the item on the
// row's, which the handler reads back, as the connectors card does, so no
// value is ever written into handler source.
function packagesReviewRowHtml(row) {
  const kindTag = `<span class="packages-kind-tag">${connectorsEsc(row.kind)}</span>`;
  const open = `<div class="packages-item-row" data-row="${connectorsEscAttr(row.rowClass)}" data-tone="${connectorsEscAttr(row.tone)}" data-item="${connectorsEscAttr(row.id)}">`;
  // The routine disclosure rides on every class of row: a colliding plan
  // never shows the plain offer card, so the row is where a carried
  // schedule gets named before the person confirms.
  const routineNote = row.routineNote
    ? `<div class="packages-routine-note">${connectorsEsc(row.routineNote)}</div>` : '';
  // The chosen adopt state says what the added default becomes and that its
  // own instructions may still claim the lead; every other row carries none.
  const adoptNote = row.adoptNote
    ? `<div class="packages-adopt-note">${connectorsEsc(row.adoptNote)}</div>` : '';
  if (row.rowClass === 'willAdd') {
    return `${open}
        <div class="packages-item-top"><span class="packages-item-name">${connectorsEsc(row.name)}</span>${kindTag}
          <span class="packages-ready-mark">Will add</span></div>${routineNote}${adoptNote}
      </div>`;
  }
  if (row.rowClass === 'kept') {
    // A taken starter file: named, said to be kept, and nothing to press,
    // because nothing can replace it.
    return `${open}
        <div class="packages-item-top"><span class="packages-item-name">${connectorsEsc(row.name)}</span>${kindTag}
          <span class="packages-skip-mark">Yours is kept</span></div>
        <div class="packages-kept-note">${connectorsEsc(row.keptNote)}</div>
      </div>`;
  }
  if (row.rowClass === 'skippedNew') {
    // The chosen attach state says where the skipped default's team went;
    // an ordinary skipped row carries no such line.
    const attachNote = row.attachNote
      ? `<div class="packages-attach-note">${connectorsEsc(row.attachNote)}</div>` : '';
    return `${open}
        <div class="packages-item-top"><span class="packages-item-name">${connectorsEsc(row.name)}</span>${kindTag}
          <span class="packages-skip-mark">Will skip</span>
          <button class="settings-btn packages-row-btn" data-decision="add" onclick="packagesSetDecision(this.closest('.packages-item-row').dataset.item, this.dataset.decision)">Add it back</button></div>${routineNote}${attachNote}
      </div>`;
  }
  const compare = row.compare ? `<div class="packages-compare">
      <div class="packages-compare-side"><div class="packages-compare-label">What you have</div><p>${connectorsEsc(row.compare.have)}</p></div>
      <div class="packages-compare-side"><div class="packages-compare-label">What arrives</div><p>${connectorsEsc(row.compare.arrives)}</p></div>
    </div>` : '';
  if (row.rowClass === 'blocked') {
    // One action, one control: the toggle collapses to the disabled
    // overwrite beside the reason, and skipping is offered once, by the
    // notice's own action below.
    const toggle = !row.colliding ? '' : `<div class="packages-decision-toggle">
        <button class="packages-dt-btn packages-dt-blocked" disabled>Overwrite: blocked</button>
      </div>`;
    return `${open}
        <div class="packages-item-top"><span class="packages-item-name">${connectorsEsc(row.name)}</span>${kindTag}</div>${routineNote}
        ${compare}${toggle}
        <div class="packages-blocked-block">
          <div class="packages-blocked-note">${connectorsEsc(row.blockedNote)}</div>${row.adoptAction ? `
          <button class="settings-btn packages-blocked-resolve" data-decision="${connectorsEscAttr(row.adoptAction.decision)}"
            onclick="packagesSetDecision(this.closest('.packages-item-row').dataset.item, this.dataset.decision)">${connectorsEsc(row.adoptAction.label)}</button>` : ''}${row.blockedAction ? `
          <button class="settings-btn packages-blocked-resolve" data-decision="${connectorsEscAttr(row.blockedAction.decision)}"
            onclick="packagesSetDecision(this.closest('.packages-item-row').dataset.item, this.dataset.decision)">${connectorsEsc(row.blockedAction.label)}</button>` : ''}
        </div>
      </div>`;
  }
  const unchangedMark = row.unchanged ? '<span class="packages-skip-mark">Already identical</span>' : '';
  return `${open}
      <div class="packages-item-top"><span class="packages-item-name">${connectorsEsc(row.name)}</span>${kindTag}${unchangedMark}</div>${routineNote}${adoptNote}
      ${compare}
      <div class="packages-decision-toggle">
        <button class="packages-dt-btn${row.decision === 'overwrite' ? ' packages-dt-selected packages-dt-overwrite' : ''}" data-decision="overwrite"
          onclick="packagesSetDecision(this.closest('.packages-item-row').dataset.item, this.dataset.decision)">Overwrite: replace what you have</button>
        <button class="packages-dt-btn${row.decision === 'skip' ? ' packages-dt-selected' : ''}" data-decision="skip"
          onclick="packagesSetDecision(this.closest('.packages-item-row').dataset.item, this.dataset.decision)">Skip: keep yours</button>
      </div>
    </div>`;
}

function packagesReviewCardHtml(copy, st) {
  return `<div class="settings-card packages-review-card">
      <div class="packages-headline">${connectorsEsc(copy.title)}</div>
      <div class="packages-review-sub">${connectorsEsc(st.link)}${st.reference ? ` · ${connectorsEsc(st.reference)}` : ''}</div>
      ${copy.unaskedNote ? `<div class="packages-review-note packages-review-warn">${connectorsEsc(copy.unaskedNote)}</div>` : ''}
      <div class="packages-item-list">${copy.rows.map(packagesReviewRowHtml).join('')}</div>
      <div class="packages-review-confirm">
        <div class="packages-review-note${copy.confirmWarn ? ' packages-review-warn' : ''}">${connectorsEsc(copy.confirmNote)}</div>
        <div class="packages-actions">
          <button class="settings-btn packages-confirm" onclick="packagesConfirm()">${connectorsEsc(copy.confirmLabel)}</button>
          <button class="settings-btn packages-cancel" onclick="packagesDecline()">${connectorsEsc(copy.cancelLabel)}</button>
        </div>
      </div>
    </div>`;
}

// The review-void state: the one danger-toned surface, its tone from the
// same table as the rows'.
function packagesStaleCardHtml(copy) {
  return `<div class="settings-card packages-stale-card" data-tone="${connectorsEscAttr(copy.tone)}">
      <div class="packages-stale-headline">${connectorsEsc(copy.headline)}</div>
      <div class="packages-stale-body">${connectorsEsc(copy.body)}</div>
      <div class="packages-actions">
        <button class="settings-btn packages-replan" onclick="packagesRetry()">${connectorsEsc(copy.actionLabel)}</button>
        <button class="settings-btn packages-cancel" onclick="packagesDecline()">Back</button>
      </div>
    </div>`;
}

function packagesSectionHtml() {
  const m = RundockPackagesInstallModel;
  const st = packagesInstall;
  const idle = st.phase === 'idle';
  // The add card, to the approved page design: one field, the accent Add,
  // and the teaching line beneath. There is no reference input; a link that
  // names a reference supplies it, and the server resolves the rest. The
  // no-review sentence keeps its own line under the teaching copy even
  // though the design's teaching copy does not carry it, because the page
  // must say on screen that Rundock reviews nothing, and the field is where
  // that fact is read before a link is submitted.
  const field = `<div class="settings-card flow pkg-add">
      <div class="settings-section-label">Add a package</div>
      <div class="pkg-field-row">
        <input id="packages-source-link" class="settings-input" type="text" placeholder="Paste a GitHub link…"
          value="${escAttr(st.link || '')}" ${idle ? '' : 'disabled'}>
        <button class="settings-btn-primary" onclick="packagesSubmit()" ${idle ? '' : 'disabled'}>Add</button>
      </div>
      <p class="pkg-teach">Add agents, skills and routines to your workspace, or an extension that changes how a file opens.</p>
      <div class="packages-field-hint">Rundock doesn't review packages. What you add is your choice.</div>
      ${st.fieldError ? `<div class="packages-field-error">${esc(m.sentence(st.fieldError))}</div>` : ''}
    </div>`;
  const where = `${esc(st.link)}${st.reference ? ` · ${esc(st.reference)}` : ''}`;
  let stateHtml = '';
  if (st.phase === 'classifying') {
    stateHtml = `<div class="settings-card packages-state">
        <div class="packages-spinner"></div>Reading the repository…
        <div class="packages-body packages-where">${where}</div>
        <div class="packages-body packages-still-reading">Still reading. Larger repositories take longer.</div>
      </div>`;
  } else if (st.phase === 'offer' && !st.review) {
    const copy = m.offerCopy(st);
    stateHtml = `<div class="settings-card packages-confirm-card">
        <div class="packages-headline">${esc(copy.headline)}</div>
        <div class="packages-body">${esc(copy.body)}</div>
        <div class="packages-actions">
          <button class="settings-btn packages-confirm" onclick="packagesConfirm()">${esc(copy.confirmLabel)}</button>
          <button class="settings-btn packages-cancel" onclick="packagesDecline()">${esc(copy.cancelLabel)}</button>
        </div>
      </div>`;
  } else if (st.phase === 'trust') {
    // The network sentence depends on where Rundock is running: see hostClaims.
    // The team, so the card can name an agent an extension may ask by the
    // name the person knows it by.
    const copy = m.trustCopy(st, { desktop: !!(window.electronAPI), agents: typeof agents !== 'undefined' ? agents : [] });
    stateHtml = `<div class="settings-card packages-confirm-card extension-trust-card">
        <div class="packages-headline">${esc(copy.headline)}</div>
        <div class="packages-body">${esc(copy.sourceLine)}</div>
        <div class="packages-body extension-facts-lead">${esc(copy.factsLead)}</div>
        <ul class="extension-facts-files">${copy.files.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
        <div class="packages-body extension-match-line">${esc(copy.matchLine)}</div>
        <div class="packages-headline extension-half-heading">${esc(copy.runsHeading)}</div>
        <ul class="extension-host-claims">${copy.runsLines.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>
        <div class="packages-body extension-half-extension">${esc(copy.halves.extension)}</div>
        <div class="packages-headline extension-half-heading">${esc(copy.keepsHeading)}</div>
        <div class="packages-body extension-half-content">${esc(copy.halves.content)}</div>
        <div class="packages-body">${esc(copy.reviewLine)}</div>
        ${copy.replacesLine ? `<div class="packages-body${copy.replacesWarn ? ' packages-review-warn' : ''}">${esc(copy.replacesLine)}</div>` : ''}
        <div class="packages-actions">
          <button class="settings-btn packages-confirm" onclick="packagesConfirm()">${esc(copy.confirmLabel)}</button>
          <button class="settings-btn packages-cancel" onclick="packagesDecline()">${esc(copy.declineLabel)}</button>
        </div>
      </div>`;
  } else if (st.phase === 'offer') {
    stateHtml = packagesReviewCardHtml(m.reviewCopy(st), st);
  } else if (st.phase === 'stale') {
    stateHtml = packagesStaleCardHtml(m.staleCopy());
  } else if (st.phase === 'applying') {
    stateHtml = `<div class="settings-card packages-state"><div class="packages-spinner"></div>Adding to your team…</div>`;
  } else if (st.phase === 'installing') {
    stateHtml = `<div class="settings-card packages-state"><div class="packages-spinner"></div>Installing…</div>`;
  } else if (st.phase === 'nothing-usable') {
    // Neutral by decision: nothing failed, the repository was read correctly
    // and holds nothing to add.
    stateHtml = `<div class="settings-card packages-state">
        <div class="packages-headline">Nothing to add</div>
        <div class="packages-body">${esc(st.link)} doesn't look like a Rundock package. Rundock couldn't find any agents, skills or a manifest in it.</div>
        <div class="packages-actions"><button class="settings-btn" onclick="packagesCancel()">Try a different link</button></div>
      </div>`;
  } else if (st.phase === 'failed') {
    stateHtml = `<div class="settings-card packages-state packages-failed">
        <div class="packages-headline">That didn't work</div>
        <div class="packages-body">${esc(m.sentence(st.message))}</div>
        <div class="packages-actions">
          ${st.canReplan ? `<button class="settings-btn" onclick="packagesRetry()">Try again</button>` : ''}
          <button class="settings-btn" onclick="packagesCancel()">Back</button>
        </div>
      </div>`;
  } else if (st.phase === 'done') {
    const copy = m.doneCopy(st);
    stateHtml = `<div class="settings-card packages-success-card" data-receipt="${escAttr(st.receipt || '')}">
        <div class="packages-headline">${esc(copy.headline)}</div>
        ${copy.parts.map((p) => `<div class="packages-part"><span class="packages-part-label">${esc(p.label)}</span><span class="packages-part-dest">${esc(p.destination)}</span></div>`).join('')}
        ${copy.blockedLines.map((line) => `<div class="packages-blocked-line">${esc(line)}</div>`).join('')}
        ${copy.note ? `<div class="packages-body">${esc(copy.note)}</div>` : ''}
        <div class="packages-actions"><button class="settings-btn" onclick="packagesCancel()">Done</button></div>
      </div>`;
  }
  return `<div class="settings-section-title">Packages</div>${field}${stateHtml}${packagesManageHtml()}`;
}

function showSettingsSection(section) {
  document.querySelectorAll('.settings-nav-item').forEach(el => el.classList.remove('active'));
  document.querySelector(`.settings-nav-item[data-settings="${section}"]`)?.classList.add('active');
  // The managed list is read each time the section opens, so what is shown
  // is what the store holds now rather than what it held last visit. The
  // Extensions page reads the same store.
  if ((section === 'packages' || section === 'extensions') && packagesManage) packagesManageApply(manageModel().open(packagesManage));
  // Packages checks for updates each time it opens, never in the background;
  // the server reuses what it learned about a repository for an hour.
  if (section === 'packages' && packagesUpdate) packagesUpdateApply(updateModel().checkAll(packagesUpdate));
  renderSettingsSection(section);
}

function renderSettingsSection(section) {
  const el = document.getElementById('settings-content');
  if (section === 'packages') {
    const typing = packagesTypingBefore(el);
    const card = packagesCardFocusBefore(el);
    el.innerHTML = packagesSectionHtml();
    packagesTypingRestore(el, typing);
    if (card) packagesFocusCard(el, card);
  } else if (section === 'workspace') {
    const agentCount = agents.filter(a => a.status === 'onTeam').length;
    const skillCount = skills.length;
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
      <div class="settings-card" id="runtimes-card">${runtimesCardHtml()}</div>
      <button class="settings-btn" onclick="changeWorkspace()">Change workspace</button>`;
    // Refresh runtime state whenever the card becomes visible (the user may
    // have just installed or signed in to a CLI).
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'get_runtime_status' }));
  } else if (section === 'permissions') {
    // THE MECHANISM IS EXPLAINED ONCE, at the top, rather than once per block.
    // Three controls that were each added to the Workspace panel with their own
    // paragraph, so a reader met the same idea three times in three wordings.
    const isCode = workspaceMode === 'code';
    // WHAT THE MODE DOES, AND NOTHING ABOUT THE OPERATING SYSTEM. Mode governs
    // how agents work: which file types they may write, and whether ordinary
    // commands need approval. Whether they are kept inside this workspace is
    // the switch below, which a mode change never moves, so this sentence no
    // longer carries a clause about the sandbox that could come untrue.
    const modeDesc = isCode
      ? "Websites and software. Agents can edit code and run everyday development commands without asking. Commands that can't be undone still ask every time."
      : 'Notes, documents and other files. Agents ask before running commands.';
    el.innerHTML = `<div class="settings-section-title">Permissions</div>
      <div class="settings-lead">Choose how agents work and where they can change files.</div>
      <div id="sandbox-notice-slot">${sandboxNoticeHtml()}</div>
      <div class="settings-block-heading"><span class="settings-label">What are you working on?</span></div>
      <div class="settings-card">
        <div class="settings-row" style="flex-direction:column;align-items:stretch;gap:12px">
          <div class="mode-toggle" role="tablist" aria-label="What are you working on?" onkeydown="modeToggleKeydown(event)">
            <button class="mode-toggle-btn${isCode ? '' : ' active'}" role="tab" aria-selected="${isCode ? 'false' : 'true'}" tabindex="${isCode ? '-1' : '0'}" data-mode="notes" onclick="setWorkspaceMode('notes')">Notes</button>
            <button class="mode-toggle-btn${isCode ? ' active' : ''}" role="tab" aria-selected="${isCode ? 'true' : 'false'}" tabindex="${isCode ? '0' : '-1'}" data-mode="code" onclick="setWorkspaceMode('code')">Code</button>
          </div>
          <div class="mode-description" id="mode-description">${modeDesc}</div>
        </div>
      </div>
      <div class="settings-block-heading"><span class="settings-label">Keep agents inside this workspace</span></div>
      <div class="settings-card">
        <div id="sandbox-row">${sandboxRowHtml()}</div>
        ${workingFoldersSectionHtml()}
      </div>
      <div class="settings-block-heading"><span class="settings-label">Tools allowed without asking</span></div>
      <div class="settings-caption settings-caption-card">Choosing "Always allow" on a permission card adds one here. Removing it means the card asks again.</div>
      <div class="settings-card" id="tool-allows-block">${toolAllowsBlockHtml()}</div>`;
    modeToggleRestoreFocus(el);
    workingFoldersLoad();
    // What is in force is read fresh each time the pane opens, and the default
    // runtime with it, because a Codex default changes what the row describes.
    sandboxSend({ type: 'get_sandbox_status' });
    sandboxSend({ type: 'get_runtime_status' });
    // Asked for whenever the pane opens: a list rendered from stale state is a
    // list that lies about what is currently allowed.
    requestToolAllows();
  } else if (section === 'extensions') {
    el.innerHTML = extensionsSectionHtml();
    extensionsRestoreFocus();
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

// ── Opened from the hint under repeated permission cards ──
// Settings, Permissions, with the one control the hint named ringed, and for a
// Working folder the path typed into the field. NOTHING IS CHANGED HERE: no
// message that sets anything is sent. The person presses Add, chooses Code,
// or confirms turning the switch off, themselves.
const PERMISSIONS_RING_TARGETS = {
  folder: () => document.getElementById('working-folders-block'),
  code: () => document.querySelector('#settings-content .mode-toggle'),
  sandbox: () => document.getElementById('sandbox-row'),
};
function openPermissionsAt(target, folder) {
  const find = PERMISSIONS_RING_TARGETS[target];
  if (!find) return;
  if (typeof showView === 'function') showView('settings');
  showSettingsSection('permissions');
  const ring = find();
  if (!ring) return;
  ring.classList.add('settings-ring');
  if (target === 'folder' && typeof folder === 'string' && folder) {
    const field = document.getElementById('wf-input');
    if (field) {
      field.value = workingFoldersShort(folder);
      workingFoldersInputChanged();
      field.focus();
    }
  }
  if (typeof ring.scrollIntoView === 'function') ring.scrollIntoView({ block: 'center' });
}

// ── Working folders (settings › workspace) ──
// The folders this workspace's agents work in besides the workspace itself.
//
// The setting exists because the product assumed the workspace IS the work.
// For a team whose agents live in one folder and whose projects live in a
// dozen others, every project was permanently "outside", and no per-folder
// approval ever caught up: a build is almost all shell commands, and a shell
// crossing offers no standing grant at all.
//
// NAMING A PARENT IS THE POINT, and the interface says so twice: once in the
// tip above the list, and once as a live answer when someone types a path
// something already covers. A person who names `~/Projects` configures this
// once; a person who names each project configures it again every time they
// start one.
let workingFolders = [];
let workingFoldersHome = '';
// The last removal, kept only until the next change, so removing is reversible
// without asking "are you sure?" about an act that is trivially undone.
let workingFoldersUndo = null;

// `~` for display, because a list of absolute paths under one home reads as
// noise and the shared prefix is the least interesting part of every row.
function workingFoldersShort(dir) {
  if (workingFoldersHome && (dir === workingFoldersHome || dir.startsWith(workingFoldersHome + '/') || dir.startsWith(workingFoldersHome + '\\'))) {
    return '~' + dir.slice(workingFoldersHome.length);
  }
  return dir;
}

function workingFoldersBasename(dir) {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : dir;
}

// The client half of the covered-by answer. Advisory only: the server
// normalises the list it is sent and the hook decides what a folder covers, so
// this is a hint shown while typing, never a gate.
function workingFoldersCoveredBy(candidate) {
  const expanded = workingFoldersExpand(candidate);
  if (!expanded) return null;
  return workingFolders.find(f => expanded === f.path || expanded.startsWith(f.path + '/') || expanded.startsWith(f.path + '\\')) || null;
}

function workingFoldersExpand(raw) {
  let value = (raw || '').trim();
  if (!value) return null;
  if (value === '~') value = workingFoldersHome;
  else if (value.startsWith('~/') || value.startsWith('~\\')) value = workingFoldersHome + value.slice(1);
  return value.replace(/[\\/]+$/, '') || value;
}

// The row is identified by its INDEX, never by its path in a JavaScript string
// literal. escAttr escapes HTML, and the browser then parses the decoded
// attribute as JavaScript, so a Windows path arrives with its backslashes live:
// `C:\Users\tom` gains a tab, `C:\Users\xavier` is a syntax error and the
// button does nothing at all, and an apostrophe in a folder name breaks the
// literal on any platform. A number cannot carry an escape.
function workingFolderRowHtml(f, index) {
  // A folder that has gone is SHOWN, never quietly dropped: a setting that
  // edits itself is one a person stops trusting. Amber rather than red because
  // nothing is broken, the folder is simply not there at the moment, and it may
  // be a drive that is not mounted.
  const missing = f.missing
    ? '<div class="wf-missing">Folder not found. It stays named, and starts covering again if it comes back.</div>'
    : '';
  return `<div class="settings-row wf-row">
      <div class="wf-main">
        <div class="wf-name">${esc(workingFoldersBasename(f.path))}${f.missing ? '<span class="wf-dot" title="Folder not found"></span>' : ''}</div>
        <div class="settings-value wf-path" title="${escAttr(f.path)}">${esc(workingFoldersShort(f.path))}</div>
        ${missing}
      </div>
      <button class="wf-remove" title="Remove this folder" aria-label="Remove ${escAttr(workingFoldersShort(f.path))}" onclick="workingFoldersRemoveAt(${index})">&times;</button>
    </div>`;
}

// ONE PLACE: under the switch, as the exceptions to it. Naming a folder is a
// statement about where agents may reach, which is the switch's question, not
// the mode's. Never muted: the permission hook reads the list whether the
// switch is on or off, so it is in force in both, and the sentence above it
// says what it does in each (RundockSandboxRowModel.foldersCaption).
function sandboxRowsNow() {
  const m = typeof sandboxModel === 'function' ? sandboxModel() : null;
  if (!m) return [];
  return m.sandboxRows(sandboxStatus, typeof serverPlatform === 'string' ? serverPlatform : null,
    typeof runtimeStatus !== 'undefined' ? runtimeStatus : null, typeof agents !== 'undefined' ? agents : null);
}
function workingFoldersState() {
  const claude = sandboxRowsNow().find((r) => r.rowLabel === null);
  return claude ? claude.folders : 'plain';
}
function workingFoldersSectionHtml() {
  return `<div class="wf-section" id="working-folders-block">${workingFoldersInnerHtml()}</div>`;
}

// The block's own contents, separated from its container so an arriving list
// redraws THIS and nothing else.
function workingFoldersInnerHtml() {
  const rows = workingFolders.map(workingFolderRowHtml).join('');
  const undo = workingFoldersUndo
    ? `<div class="wf-undo">Removed ${esc(workingFoldersShort(workingFoldersUndo))}.
         <button class="wf-undo-btn" onclick="workingFoldersUndoRemove()">Undo</button></div>`
    : '';
  // The mock's words, and the two facts the list has always carried: which
  // runtime and which folder it never reaches, and when a removal takes
  // effect. The covered-by hint stays live under the field.
  const m = typeof sandboxModel === 'function' ? sandboxModel() : null;
  const caption = m ? m.foldersCaption(workingFoldersState(), workspaceMode === 'code' ? 'code' : 'notes') : null;
  const lead = caption ? `<div class="wf-section-sub">${esc(caption)}</div>` : '';
  const own = m && typeof m.ownSandboxFoldersNote === 'function' ? m.ownSandboxFoldersNote(sandboxStatus) : null;
  const ownNote = own ? `<div class="settings-caption wf-own-sandbox">${esc(own)}</div>` : '';
  const hint = workingFolders.length
    ? 'Naming a parent, such as <code>~/Projects</code>, covers everything inside it. A permission card\'s "Always allow this folder" adds to this same list.'
    : 'No extra folders added yet. Naming a parent, such as <code>~/Projects</code>, covers everything inside it.';
  return `<div class="wf-section-head">Folders agents can also change</div>
    ${lead}
    ${ownNote}
    ${undo}
    <div class="wf-section-inner">
      <div class="wf-list">${rows}</div>
      <div class="wf-add">
        <input class="packages-input wf-input" id="wf-input" aria-label="Add a folder" placeholder="Add a folder, such as ~/Projects"
               oninput="workingFoldersInputChanged()" onkeydown="if(event.key==='Enter')workingFoldersAdd()">
        <button class="settings-btn" onclick="workingFoldersAdd()">Add</button>
      </div>
      <div class="wf-hint" id="wf-hint"></div>
      <div class="settings-caption wf-note">${hint}</div>
      <div class="settings-caption wf-note">Codex agents are unaffected, and <code>~/.claude</code> is never included, so your credentials always ask.</div>
      <div class="settings-caption wf-note">Removing a folder applies to new conversations; one already running keeps the folders it started with.</div>
    </div>`;
}

// Live, and deliberately NOT a refusal. Someone typing a path already covered
// has not made an error, they have simply not needed to: saying so as they type
// teaches what naming a parent did, at the one moment the lesson is useful.
function workingFoldersInputChanged() {
  const field = document.getElementById('wf-input');
  const hint = document.getElementById('wf-hint');
  if (!field || !hint) return;
  const covered = workingFoldersCoveredBy(field.value);
  hint.textContent = covered
    ? `Already covered by ${workingFoldersShort(covered.path)}, so this isn't necessary.`
    : '';
}

function workingFoldersSend(list) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'set_working_folders', folders: list }));
}

function workingFoldersAdd() {
  const field = document.getElementById('wf-input');
  if (!field) return;
  const value = (field.value || '').trim();
  if (!value) return;
  workingFoldersUndo = null;
  workingFoldersSend(workingFolders.map(f => f.path).concat([value]));
  field.value = '';
}

// Resolved from the client's own list at click time, so the path never has to
// survive a round trip through an HTML attribute and a JavaScript parser.
function workingFoldersRemoveAt(index) {
  const row = workingFolders[index];
  if (!row) return;
  workingFoldersUndo = row.path;
  workingFoldersSend(workingFolders.filter((f, i) => i !== index).map(f => f.path));
}

function workingFoldersUndoRemove() {
  const restored = workingFoldersUndo;
  workingFoldersUndo = null;
  if (restored) workingFoldersSend(workingFolders.map(f => f.path).concat([restored]));
}

function workingFoldersLoad() {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'get_working_folders' }));
}

// The server's answer is the only source of the list the interface shows. The
// client never predicts the result of its own change: what comes back has been
// normalised and de-duplicated, so a row that collapsed into a parent is gone
// from the reply rather than lingering until a reload.
// THE STANDING "ALWAYS ALLOW" ANSWERS, shown where they can be taken back.
//
// A grant nobody can see is a grant nobody can revoke, and these now outlive
// the tab they were given in, so the list and the revoke are part of the same
// change rather than a later nicety.
//
// Two readers, one truth: the permission cards consult the cached set in
// chat.js and this pane renders the same list, both fed by the server's reply,
// so a revoke here silences nothing the cards still think is allowed.
let standingToolAllows = [];

function toolAllowsArrived(msg) {
  standingToolAllows = Array.isArray(msg.tools) ? msg.tools.filter((k) => typeof k === 'string') : [];
  if (typeof setStandingToolAllows === 'function') setStandingToolAllows(standingToolAllows);
  // Redraws its own block only, and only when on screen, for the same reason
  // the folders block does: re-entering the section renderer here would make
  // the reply ask again, without end.
  const container = document.getElementById('tool-allows-block');
  if (container) container.innerHTML = toolAllowsBlockHtml();
}

// A permission key is `Tool(scope)`: the tool is what runs, the scope is what it
// is allowed to run against. Split so the eye can find the tool first, by WEIGHT
// alone rather than colour or grouping, because grouping these is a later card
// and a colour would imply a category that does not exist yet.
function toolAllowKeyHtml(key) {
  // A Code-mode rule key is listed in words ("Pushes to the default branch"),
  // with the same revoke control as any other standing allow.
  const rule = (typeof RundockPermissions !== 'undefined' && RundockPermissions.ruleKeyLabel) ? RundockPermissions.ruleKeyLabel(key) : null;
  if (rule) return `<span class="tool-allow-name">${esc(rule)}</span>`;
  const open = key.indexOf('(');
  if (open <= 0 || !key.endsWith(')')) return `<span class="tool-allow-name">${esc(key)}</span>`;
  return `<span class="tool-allow-name">${esc(key.slice(0, open))}</span>`
    + `<span class="tool-allow-scope">${esc(key.slice(open))}</span>`;
}

function toolAllowsBlockHtml() {
  if (!standingToolAllows.length) {
    // The empty state Connectors already uses: prose in a column row, no
    // bespoke component. It says the mechanism ONCE, because the heading above
    // it names the thing and a second telling was what made this block read as
    // an apology rather than a state.
    return '<div class="settings-row" style="flex-direction:column;align-items:stretch;gap:4px">'
      + '<span class="settings-prose">Nothing yet.</span></div>';
  }
  // BY INDEX, never by value, which is the same rule the working-folders
  // remove control follows. An allow key is text the server stored on an
  // agent's behalf, and a key carrying a quote would close the attribute's
  // string and put the rest of itself in a JavaScript literal position, where
  // escAttr is the wrong escaper and nothing else is checking. An integer
  // cannot do that whatever the key says.
  // NOT TRUNCATED, which is where this diverges from .settings-value and does
  // so deliberately. That class clips to one line with an ellipsis, right for a
  // path that would push a row wide. A permission key is read in full before
  // deciding to revoke it, and the hidden half is exactly the part that might
  // make it dangerous, so this wraps instead.
  //
  // BY INDEX, never by value, which is the same rule the working-folders remove
  // control follows. An allow key is text the server stored on an agent's
  // behalf, and a key carrying a quote would close the attribute's string and
  // put the rest of itself in a JavaScript literal position, where escAttr is
  // the wrong escaper and nothing else is checking. An integer cannot.
  const rows = standingToolAllows.map((k, index) => (
    `<div class="settings-row tool-allow-row">`
    + `<span class="tool-allow-key">${toolAllowKeyHtml(k)}</span>`
    + `<button class="settings-row-remove" onclick="revokeToolAllowAt(${index})" `
    + `title="Ask again for this tool" aria-label="Ask again for ${escAttr(k)}">&times;</button></div>`
  )).join('');
  return `<div class="tool-allow-list">${rows}</div>`;
}

function revokeToolAllowAt(index) {
  const key = standingToolAllows[index];
  if (typeof key !== 'string') return;
  revokeToolAllow(key);
}

function revokeToolAllow(key) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'remove_tool_allow', key }));
  }
}

function requestToolAllows() {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'get_tool_allows' }));
}

function workingFoldersArrived(msg) {
  workingFolders = Array.isArray(msg.folders) ? msg.folders : [];
  if (typeof msg.home === 'string') workingFoldersHome = msg.home;
  const rejected = Array.isArray(msg.rejected) ? msg.rejected : [];
  // REDRAWS ITS OWN BLOCK, NEVER THE SECTION. The section renderer issues the
  // request, so re-entering it here made the reply ask again: an unbounded
  // exchange at network speed for as long as the pane was open, rebuilding the
  // pane each time and wiping whatever was being typed. The runtimes card
  // beside this one already had the right shape and this did not follow it.
  // Keyed off the block being ON SCREEN rather than off the view, so another
  // settings section is never overwritten by a reply meant for this one.
  workingFoldersRedraw();
  // A refused path is NAMED, with the reason, rather than silently absent from
  // the list a moment after being typed.
  if (rejected.length) {
    const hint = document.getElementById('wf-hint');
    if (hint) hint.textContent = `Could not add ${rejected.join(', ')}: name a full folder path, not the drive root.`;
  }
}

// Redraws the block alone, and only when it is on screen. Called when a list
// arrives and when the switch changes, since the switch mutes the section.
function workingFoldersRedraw() {
  const container = document.getElementById('working-folders-block');
  if (!container) return;
  // WHAT IS BEING TYPED SURVIVES THE REDRAW. A list can arrive at any moment,
  // including while someone is halfway through a path, and rebuilding the
  // block would otherwise empty the field under them. Carried across by hand
  // because the field is rebuilt rather than updated.
  const field = document.getElementById('wf-input');
  const typed = field ? field.value : '';
  const focused = field && document.activeElement === field;
  container.innerHTML = workingFoldersInnerHtml();
  const rebuilt = document.getElementById('wf-input');
  if (rebuilt && typed) {
    rebuilt.value = typed;
    workingFoldersInputChanged();
  }
  if (rebuilt && focused) rebuilt.focus();
}

function workingFoldersWorkspaceChanged() {
  workingFolders = [];
  workingFoldersUndo = null;
  // The sandbox row belongs to the workspace too, and is read again on the
  // next open of the pane.
  sandboxStatus = null;
  sandboxUi = sandboxUiInitial();
}

// ── Keep agents inside this workspace (settings › permissions) ──
// The row draws what RundockSandboxRowModel decides from the server's status
// and decides nothing itself. Every change is asked of the server, and the row
// is redrawn from its answer, which is read back from disk: a click never moves
// the switch on its own, so the row cannot show a state that is not in force.
// Turning it off asks first; turning it on does not.
let sandboxStatus = null;
function sandboxUiInitial() { return { confirming: false, review: null, busy: false, refocus: null }; }
let sandboxUi = sandboxUiInitial();

// The page global in a browser, the sibling module under CommonJS, and null in
// a bare window that loaded this view alone, where the row draws nothing
// rather than throwing (the same degradation manageModel explains).
function sandboxModel() {
  if (typeof RundockSandboxRowModel !== 'undefined') return RundockSandboxRowModel;
  return (typeof module === 'object' && module.exports) ? require('../sandbox-row-model.js') : null;
}
function sandboxSend(msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(msg));
  return true;
}
function sandboxPartsHtml(parts) {
  return (parts || []).map((p) => (p.code !== undefined ? `<code>${esc(p.code)}</code>` : esc(p.text))).join('');
}
const SANDBOX_LOCK = '<svg class="readonly-lock" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1.2"/><path d="M5.5 7V4.8a2.5 2.5 0 0 1 5 0V7"/></svg>';

function sandboxReviewHtml() {
  const copy = sandboxModel().reviewCopy(sandboxUi.review);
  const folders = copy.foldersLead
    ? `<p>${esc(copy.foldersLead)}</p><ul class="wall-review-list">${copy.folders.map((f) => `<li>${esc(workingFoldersShort(f))}</li>`).join('')}</ul>`
    : '';
  const warn = copy.warn ? `<p class="wall-review-warn">${sandboxPartsHtml(copy.warn)}</p>` : '';
  return `<div class="wall-review" role="group" aria-labelledby="sandbox-review-title" onkeydown="sandboxPanelKeydown(event, 'review')">
      <div class="wall-review-title" id="sandbox-review-title">${esc(copy.title)}</div>
      ${folders}${warn}
      <div class="wall-actions"><button class="settings-btn" onclick="sandboxCancelImport()">${esc(copy.cancelLabel)}</button><button class="settings-btn-primary" id="sandbox-import-confirm" onclick="sandboxConfirmImport()" ${sandboxUi.busy ? 'disabled' : ''}>${esc(copy.confirmLabel)}</button></div>
    </div>`;
}

// A read-only row for a runtime Rundock does not control, drawn beneath the
// Claude Code row when both are in use.
function sandboxExtraRowHtml(r) {
  return `<div class="settings-row wall-row" data-sandbox-state="${escAttr(r.state)}">
      <div class="settings-row-main">
        <span class="settings-label">${esc(r.rowLabel)}</span>
        ${r.captions.map((c) => `<div class="settings-caption sandbox-caption">${esc(c)}</div>`).join('')}
        ${r.ownership ? `<div class="ownership-note">${sandboxPartsHtml(r.ownership)}</div>` : ''}
      </div>
      <div class="row-onoff"><span class="onoff-label">${esc(r.label)}</span>${SANDBOX_LOCK}</div>
    </div>`;
}

function sandboxRowHtml() {
  const m = sandboxModel();
  if (!m) return '';
  const all = sandboxRowsNow();
  const r = all[0];
  if (!r) return '';
  const extra = all.slice(1).map(sandboxExtraRowHtml).join('');
  const control = r.control === 'switch'
    ? `<label class="toggle-hit"><input type="checkbox" role="switch" class="rui-toggle" id="sandbox-switch" aria-label="Keep agents inside this workspace" ${r.state === 'on' ? 'checked' : ''} ${sandboxUi.busy ? 'disabled' : ''} onclick="sandboxSwitchClicked(event)"></label>`
    : r.control === 'lock' ? SANDBOX_LOCK : '';
  const confirm = sandboxUi.confirming && r.control === 'switch'
    ? `<div class="wall-confirm" role="group" aria-label="Turn off?" onkeydown="sandboxPanelKeydown(event, 'confirm')">
        <p><strong>Turn off?</strong> ${esc(m.CONFIRM_OFF)}</p>
        <div class="wall-actions"><button class="settings-btn" id="sandbox-keep-on" onclick="sandboxKeepOn()">Keep it on</button><button class="settings-btn-danger" onclick="sandboxTurnOff()">Turn it off</button></div>
      </div>` : '';
  const bringIn = r.bringIn && !sandboxUi.review
    ? `<div class="settings-row sandbox-bring-in"><button class="settings-btn" id="sandbox-bring-in" onclick="sandboxReviewImport()" ${sandboxUi.busy ? 'disabled' : ''}>Bring your custom rules into Rundock</button></div>` : '';
  const review = r.bringIn && sandboxUi.review ? sandboxReviewHtml() : '';
  const error = sandboxStatus && sandboxStatus.error ? `<div class="sandbox-error" role="alert">${esc(sandboxStatus.error)}</div>` : '';
  return `<div class="settings-row wall-row" data-sandbox-state="${escAttr(r.state)}">
      <div class="settings-row-main">
        <span class="settings-label${r.state === 'unavailable' ? ' is-quiet' : ''}">Keep agents inside this workspace</span>
        ${r.captions.map((c) => `<div class="settings-caption sandbox-caption">${esc(c)}</div>`).join('')}
        ${r.ownership ? `<div class="ownership-note">${sandboxPartsHtml(r.ownership)}</div>` : ''}
      </div>
      <div class="row-onoff"><span class="onoff-label" id="sandbox-state">${esc(r.label)}</span>${control}</div>
    </div>${confirm}${bringIn}${review}${error}${extra}`;
}

function sandboxNoticeHtml() {
  const m = sandboxModel();
  const text = m ? m.noticeText(sandboxStatus) : null;
  return text ? `<div class="migration-notice"><span>${esc(text)}</span><button type="button" class="migration-notice-dismiss" aria-label="Dismiss notice" onclick="sandboxDismissNotice()">&times;</button></div>` : '';
}

function sandboxFocus(id) {
  const el = id && document.getElementById(id);
  if (el) el.focus();
}
function sandboxRedraw() {
  const row = document.getElementById('sandbox-row');
  if (!row) return;
  row.innerHTML = sandboxRowHtml();
  const slot = document.getElementById('sandbox-notice-slot');
  if (slot) slot.innerHTML = sandboxNoticeHtml();
  workingFoldersRedraw();
  const refocus = sandboxUi.refocus;
  sandboxUi.refocus = null;
  sandboxFocus(refocus);
}

function sandboxStatusArrived(msg) {
  sandboxStatus = msg;
  sandboxUi.busy = false;
  // A review rides on the reply that answers it. A failed import keeps the
  // review on screen beside its error; anything else closes it.
  if (msg.review) { sandboxUi.review = msg.review; sandboxUi.refocus = 'sandbox-import-confirm'; }
  else if (!(msg.error && !msg.managed && sandboxUi.review)) sandboxUi.review = null;
  sandboxRedraw();
}

// The click is asked of the server; the checkbox does not move on its own.
function sandboxSwitchClicked(event) {
  if (event) event.preventDefault();
  if (sandboxUi.busy) return;
  if (sandboxStatus && sandboxStatus.on) {
    sandboxUi.confirming = true;
    sandboxUi.refocus = 'sandbox-keep-on';
    sandboxRedraw();
  } else if (sandboxSend({ type: 'set_workspace_sandbox', on: true })) {
    sandboxUi.busy = true;
    sandboxUi.refocus = 'sandbox-switch';
    sandboxRedraw();
  }
}
function sandboxKeepOn() {
  sandboxUi.confirming = false;
  sandboxUi.refocus = 'sandbox-switch';
  sandboxRedraw();
}
function sandboxTurnOff() {
  sandboxUi.confirming = false;
  sandboxUi.refocus = 'sandbox-switch';
  if (sandboxSend({ type: 'set_workspace_sandbox', on: false })) sandboxUi.busy = true;
  sandboxRedraw();
}
// Escape answers a question the way its safe button does.
function sandboxPanelKeydown(event, panel) {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  if (panel === 'confirm') sandboxKeepOn();
  else sandboxCancelImport();
}
function sandboxDismissNotice() {
  sandboxSend({ type: 'dismiss_sandbox_notice' });
}
function sandboxReviewImport() {
  if (sandboxSend({ type: 'review_sandbox_import' })) { sandboxUi.busy = true; sandboxRedraw(); }
}
function sandboxCancelImport() {
  sandboxUi.review = null;
  sandboxUi.refocus = 'sandbox-bring-in';
  sandboxRedraw();
}
function sandboxConfirmImport() {
  if (!sandboxUi.review) return;
  if (sandboxSend({ type: 'import_sandbox_rules', digest: sandboxUi.review.digest })) { sandboxUi.busy = true; sandboxRedraw(); }
}

function setWorkspaceMode(mode) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'set_workspace_mode', mode }));
}

// THE MODE TOGGLE IS A TABLIST, per the WAI-ARIA Tabs pattern with automatic
// activation, the same as Rundock UI's tabs: one tab is the tab stop (the
// selected one), ArrowLeft and ArrowRight move and select, Home and End jump
// to the ends. Selecting asks the server, and the server's answer re-renders
// this pane, which would drop focus on the floor; so the tab a key moved to
// is remembered and focused again after that render.
let modeToggleRefocus = null;
function modeToggleKeydown(event) {
  const tabs = Array.prototype.slice.call(event.currentTarget.querySelectorAll('[role="tab"]'));
  const index = tabs.indexOf(event.target);
  if (index === -1) return;
  let next = -1;
  if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
  else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = tabs.length - 1;
  if (next === -1) return;
  event.preventDefault();
  tabs.forEach((tab, i) => {
    const on = i === next;
    tab.setAttribute('aria-selected', on ? 'true' : 'false');
    tab.tabIndex = on ? 0 : -1;
    tab.classList.toggle('active', on);
  });
  tabs[next].focus();
  if (tabs[next] === tabs[index]) return;
  modeToggleRefocus = tabs[next].dataset.mode;
  setWorkspaceMode(tabs[next].dataset.mode);
}
function modeToggleRestoreFocus(pane) {
  if (!modeToggleRefocus) return;
  const tab = pane.querySelector(`.mode-toggle-btn[data-mode="${modeToggleRefocus}"]`);
  modeToggleRefocus = null;
  if (tab) tab.focus();
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
  // The default runtime decides what the sandbox row describes.
  sandboxRedraw();
}

function changeWorkspace() {
  ws.send(JSON.stringify({ type: 'list_workspaces' }));
}

// ── Extensions (settings › extensions) ──
// Installed extensions on a page of their own, drawn from the manage state the
// Packages page keeps (packagesManage), through the manage model's own
// transitions, so the two pages can never disagree. What each row shows is
// decided by RundockExtensionsViewModel. Controls are addressed by row INDEX,
// never by name in a script string, for the reason workingFolderRowHtml gives.
// There are no update controls here: updates live on Packages.
function extensionsModel() {
  if (typeof RundockExtensionsViewModel !== 'undefined') return RundockExtensionsViewModel;
  return (typeof module === 'object' && module.exports) ? require('../extensions-view-model.js') : null;
}
function extensionsSectionVisible() {
  if (typeof currentView === 'undefined' || currentView !== 'settings') return false;
  const active = document.querySelector('.settings-nav-item.active');
  return !!active && active.dataset.settings === 'extensions';
}
function extensionsRenderIfVisible() {
  if (extensionsSectionVisible()) renderSettingsSection('extensions');
}
let extensionsRefocus = null;
function extensionsRestoreFocus() {
  const id = extensionsRefocus;
  extensionsRefocus = null;
  const el = id && document.getElementById(id);
  if (el) el.focus();
}
function extensionsApply(out) {
  if (out.send) {
    if (!(ws && ws.readyState === WebSocket.OPEN)) {
      packagesManage = manageModel().unsent(out.state);
      extensionsRenderIfVisible();
      return;
    }
    ws.send(JSON.stringify(out.send));
  }
  packagesManage = out.state;
  extensionsRenderIfVisible();
}
function extensionsRows() {
  const v = extensionsModel();
  return v && packagesManage ? v.rows(packagesManage) : [];
}

// A row that could not load has nothing in its control column. Its way out
// is in the sentence on the left: "its package" links to the package's card
// where that package is known, and plain words say so where it is not.
function extensionFailedWayHtml(r, i) {
  const way = r.failedWay;
  if (!way) return '';
  if (!way.link) return esc(way.text);
  return `${esc(way.before)}<button class="linkbtn accent ext-page-to-package" id="ext-to-package-${i}" onclick="extensionsOpenPackages(${i})">${esc(way.link)}</button>${esc(way.after)}`;
}

function extensionRowHtml(r, i) {
  const from = r.provenance
    ? `<div class="ext-page-from">From the <button class="linkbtn accent" onclick="extensionsOpenPackages(${i})">${esc(r.provenance.name)}</button> package</div>` : '';
  const update = r.updateAvailable
    ? `<div class="ext-page-update"><button class="linkbtn accent" onclick="extensionsOpenPackages()">Update available in Packages</button></div>` : '';
  const lines = [
    r.claims ? `<div class="ext-page-line">${esc(r.claims)}</div>` : '',
    r.problem ? `<div class="ext-page-line is-danger">${esc(r.problem)}</div>` : '',
    r.failedText ? `<div class="ext-page-line is-danger ext-page-failed">${esc(r.failedText)} ${extensionFailedWayHtml(r, i)}</div>` : '',
    r.note ? `<div class="ext-page-line${r.note.tone === 'danger' ? ' is-danger' : ''}">${esc(r.note.text)}</div>` : '',
  ].join('');
  const control = r.failed ? '' : `<div class="row-onoff"><span class="onoff-label">${esc(r.onLabel)}</span><label class="toggle-hit"><input type="checkbox" role="switch" class="rui-toggle" id="ext-switch-${i}" aria-label="${escAttr(r.switchLabel)}" ${r.on ? 'checked' : ''} ${r.disabled ? 'disabled' : ''} onclick="extensionsToggle(event, ${i})"></label></div>`;
  return `<div class="ext-page-row" data-extension="${escAttr(r.id)}">
      <div class="ext-page-top">
        <div class="ext-page-id">
          <div class="ext-page-name-line"><span class="ext-page-name">${esc(r.name)}</span>${r.versionLabel ? `<span class="ext-page-ver">${esc(r.versionLabel)}</span>` : ''}${r.failed ? '<span class="ext-page-chip">Couldn\'t load</span>' : ''}</div>
          ${r.addedLabel ? `<div class="ext-page-added">${esc(r.addedLabel)}</div>` : ''}
          ${from}${update}${lines}
        </div>
        <div class="ext-page-controls">${control}</div>
      </div>
    </div>`;
}

function extensionsSectionHtml() {
  const v = extensionsModel();
  const st = packagesManage;
  const head = `<div class="settings-section-title">Extensions</div>`;
  if (!v || !st) return head;
  const lead = `<div class="settings-lead">${esc(v.LEAD)}</div>`;
  const rows = st.loaded && !st.error ? extensionsRows() : [];
  const pause = v.pauseControl(st);
  const banner = rows.length && pause.paused
    ? `<div class="ext-paused-banner"><p>${esc(pause.banner)}</p><button class="settings-btn-primary" id="ext-resume" onclick="extensionsSetPaused(false)" ${pause.disabled ? 'disabled' : ''}>${esc(pause.label)}</button></div>` : '';
  let list;
  if (st.error) list = `<div class="ext-page-empty is-danger">${esc(v.sentence(st.error))}</div>`;
  else if (!st.loaded) list = `<div class="ext-page-empty">Reading what is installed…</div>`;
  else if (!rows.length) list = `<div class="ext-page-empty">${esc(v.EMPTY)} <button class="linkbtn accent" onclick="extensionsOpenPackages()">Go to Packages</button></div>`;
  else list = rows.map(extensionRowHtml).join('');
  const notice = st.notice ? `<div class="ext-page-notice${st.notice.tone === 'danger' ? ' is-danger' : ''}" role="status">${esc(v.sentence(st.notice.text))}</div>` : '';
  const below = !rows.length ? ''
    : pause.paused ? ''
      : `<div class="ext-pause"><p>${esc(pause.text)}</p><button class="settings-btn" id="ext-pause" onclick="extensionsSetPaused(true)" ${pause.disabled ? 'disabled' : ''}>${esc(pause.label)}</button></div>`;
  return `${head}${lead}${banner}<div class="settings-card ext-page-list" id="extensions-list">${list}</div>${notice}${below}`;
}

// The switch asks; the row moves when the answer arrives.
function extensionsToggle(event, i) {
  if (event) event.preventDefault();
  const r = extensionsRows()[i];
  // A disabled switch, as every switch is while paused, sends nothing.
  if (!r || r.failed || r.disabled) return;
  extensionsRefocus = `ext-switch-${i}`;
  extensionsApply(manageModel().setEnabled(packagesManage, r.id, !r.on));
}
function extensionsSetPaused(paused) {
  extensionsRefocus = paused ? 'ext-resume' : 'ext-pause';
  extensionsApply(manageModel().setAllOff(packagesManage, paused));
}
// To Packages, and to the history entry of the package a row came from when
// there is one.
function extensionsOpenPackages(i) {
  const r = typeof i === 'number' ? extensionsRows()[i] : null;
  showSettingsSection('packages');
  const id = r && r.provenance ? r.provenance.package : null;
  if (!id) return;
  const content = document.getElementById('settings-content');
  if (!packagesFocusCard(content, id)) return;
  const entry = document.activeElement;
  if (typeof entry.scrollIntoView === 'function') entry.scrollIntoView({ block: 'center' });
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
      <span class="settings-prose">Connectors differ in what they need to start: some take a command and arguments, some a URL, and most need credentials. ${connectorsEsc(guideName)} can work out which this one is, write it, and tell you what it still needs. A connector is read when an agent starts, so a new one reaches the next conversation rather than the one you add it in.</span>
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

// The install flow's onclick names, its reply entry and its two workspace
// resets are published because the generated markup and the app.js dispatch
// cases resolve them against the module's exported surface, not against
// private closure variables.
return { showSettingsSection, renderSettingsSection, openPermissionsAt, setWorkspaceMode, modeToggleKeydown, runtimeRowHtml, runtimesCardHtml, renderRuntimesCard, changeWorkspace,
  packagesSubmit, packagesCancel, packagesDecline, packagesConfirm, packagesRetry, packagesSetDecision,
  packagesReviewRowHtml, packagesReviewCardHtml, packagesStaleCardHtml,
  packagesReplyArrived, packagesWorkspaceChanged, packagesServingWorkspaceChanged, packagesConnectionLost,
  packagesOpenReceiptItem, packagesManageHtml, packagesCardHtml, packagesCardAction,
  packagesCheckOne, packagesReviewUpdate, packagesConfirmUpdate, packagesCancelUpdate, packagesDismissUpdate,
  packagesAskUninstall, packagesConfirmUninstallPackage, packagesCancelUninstallPackage,
  packagesCopyUpdatePrompt, packagesClearUpdatesFolder, packagesKeepUpdatesFolder, packagesUpdateReviewHtml, packagesUpdateDoneHtml, packagesUninstallHtml,
  connectorsParse, connectorsParseToml, connectorsParseUserGlobalJson,
  connectorsBuildRows, connectorsBuildState, connectorsRowHtml, connectorsScopeText,
  connectorsSectionHtml, connectorsLoad, connectorsWorkspaceChanged,
  workingFoldersSectionHtml, workingFolderRowHtml, workingFoldersShort, workingFoldersBasename,
  workingFoldersCoveredBy, workingFoldersExpand, workingFoldersInputChanged, workingFoldersAdd,
  workingFoldersRemoveAt, workingFoldersUndoRemove, workingFoldersLoad, workingFoldersArrived,
  // app.js dispatches 'tool_allows' straight to toolAllowsArrived as a bare
  // global, the same way it dispatches 'working_folders'. Left off this list
  // the name does not exist on window, and the message throws on arrival.
  toolAllowsArrived, requestToolAllows, revokeToolAllow, revokeToolAllowAt,
  workingFoldersInnerHtml,
  workingFoldersWorkspaceChanged,
  sandboxStatusArrived, sandboxSwitchClicked, sandboxKeepOn, sandboxTurnOff, sandboxPanelKeydown,
  sandboxDismissNotice, sandboxReviewImport, sandboxCancelImport, sandboxConfirmImport,
  // The Extensions page: its inline handlers, and the redraw app.js calls when a
  // reply for the shared manage state arrives.
  extensionsRenderIfVisible, extensionsToggle, extensionsSetPaused, extensionsOpenPackages };
}));
