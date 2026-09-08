'use strict';
/**
 * The manage half of the Packages page: what the Installed extensions list
 * shows for every installed record, what Recently added shows for every
 * receipt, and the only messages the section may send. A module rather
 * than a view for the same reason the install flow's model is one: what the
 * section is judged on is the state each row takes, the tone its chip
 * carries, and promises about what is sent when. Every transition returns
 * `{ state, send }`, and `send` is undefined unless the person asked.
 *
 * The rows are read from the roster the host reads, so the two surfaces
 * cannot disagree. A row leads with one chip that says what the extension
 * IS, and puts a second fact (an update waiting on a disabled one, a failed
 * update behind a working one) in prose beneath it: a failed update never
 * wears a Failed chip, because the extension still runs.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else root.RundockPackagesManageModel = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  const RECENT_LIMIT = 5;

  // The one tone table: each chip class names the tone token that draws it.
  const CHIP_TONES = { enabled: 'success', disabled: 'idle', update: 'attention', working: 'working', bad: 'danger' };

  const CHIPS = {
    enabled: { label: 'Enabled', className: 'enabled' },
    disabled: { label: 'Disabled', className: 'disabled' },
    'update-available': { label: 'Update available', className: 'update' },
    installing: { label: 'Installing', className: 'working' },
    updating: { label: 'Updating', className: 'working' },
    'install-failed': { label: 'Install failed', className: 'bad' },
    broken: { label: 'Broken', className: 'bad' },
  };

  const EMPTY_EXTENSIONS = 'Nothing installed yet. An extension you add from a link will show up here, with its source and the reference it was pinned to.';
  const EMPTY_RECEIPTS = 'Nothing added yet. When agents, skills or files arrive from a package, the receipt is listed here, each item linking to where it now lives.';

  function initial() {
    return {
      loaded: false, error: null, extensions: [], receipts: [],
      // One operation in flight, matched by its reply; per-extension facts
      // learned since the read (check answers, failures); the row whose
      // uninstall question is open; a sentence beneath the list.
      busy: null, statuses: {}, notes: {}, confirming: null, notice: null,
      seeAll: false,
    };
  }

  function chip(state) {
    const c = CHIPS[state];
    return { label: c.label, tone: CHIP_TONES[c.className], className: c.className };
  }

  function count(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
  }

  function open(state) {
    return {
      state: { ...state, busy: { operation: 'page', name: null }, notice: null, confirming: null },
      send: { type: 'get_packages_page' },
    };
  }

  function entryFor(state, name) {
    return state.extensions.find((e) => e && e.id === name) || null;
  }

  function without(map, name) {
    const next = { ...map };
    delete next[name];
    return next;
  }

  function reply(state, msg) {
    if (!msg || typeof msg.type !== 'string') return { state };
    const freed = (operation) => (state.busy && state.busy.operation === operation ? null : state.busy);
    if (msg.type === 'packages_page') {
      return { state: { ...state, loaded: true, error: null, busy: freed('page'), extensions: Array.isArray(msg.extensions) ? msg.extensions : [], receipts: Array.isArray(msg.receipts) ? msg.receipts : [] } };
    }
    if (msg.type === 'packages_page_error') {
      return { state: { ...state, loaded: true, error: msg.reason || 'the Packages page could not be read', extensions: [], receipts: [], busy: null } };
    }
    if (msg.type === 'extension_update_status') {
      const status = { outcome: msg.outcome, newer: Array.isArray(msg.newer) ? msg.newer : [], current: msg.current };
      return { state: { ...state, busy: freed('update-check'), statuses: { ...state.statuses, [msg.name]: status }, notes: without(state.notes, msg.name) } };
    }
    if (msg.type === 'extension_state') {
      return { state: { ...state, busy: freed('set-enabled'), extensions: Array.isArray(msg.extensions) ? msg.extensions : state.extensions, notes: without(state.notes, msg.name) } };
    }
    if (msg.type === 'extension_uninstalled') {
      return {
        state: {
          ...state, busy: freed('uninstall'),
          extensions: (Array.isArray(msg.extensions) ? msg.extensions : state.extensions).filter((e) => e && e.id !== msg.name),
          statuses: without(state.statuses, msg.name), notes: without(state.notes, msg.name),
          confirming: state.confirming === msg.name ? null : state.confirming,
          notice: typeof msg.untouched === 'string' && msg.untouched ? { text: msg.untouched, tone: 'neutral' } : state.notice,
        },
      };
    }
    // A record or a receipt changed under a flow this model does not drive:
    // read the page again, once it has been read at all, so the list and the
    // host's registry that rides on the same reply see what changed.
    if (msg.type === 'extension_install_result') return state.loaded ? open(state) : { state };
    if (msg.type === 'package_import_result' && msg.operation === 'apply') return state.loaded ? open(state) : { state };
    // An error is this section's only when it names the operation the
    // section is waiting on; an install's error mid-check is the install
    // flow's to render, not a note on a row.
    if (msg.type === 'package_install_error' && state.busy && state.busy.name && msg.operation === state.busy.operation
      && (msg.name === undefined || msg.name === state.busy.name)) {
      const notes = { ...state.notes, [state.busy.name]: { text: msg.message || 'That did not work.', tone: 'danger' } };
      return { state: { ...state, busy: null, notes, confirming: state.busy.operation === 'uninstall' ? null : state.confirming } };
    }
    return { state };
  }

  function ask(state, operation, name, send) {
    if (state.busy || !entryFor(state, name)) return { state };
    return { state: { ...state, busy: { operation, name }, notice: null }, send };
  }

  function checkForUpdate(state, name) {
    return ask(state, 'update-check', name, { type: 'check_extension_update', name });
  }

  function setEnabled(state, name, enabled) {
    return ask(state, 'set-enabled', name, { type: 'set_extension_enabled', name, enabled: !!enabled });
  }

  // Uninstall is a question first: nothing is sent until it is answered.
  function askUninstall(state, name) {
    if (!entryFor(state, name)) return { state };
    return { state: { ...state, confirming: name, notice: null } };
  }

  function cancelUninstall(state) {
    return { state: { ...state, confirming: null } };
  }

  function confirmUninstall(state, name) {
    if (state.confirming !== name) return { state };
    return ask(state, 'uninstall', name, { type: 'uninstall_extension', name });
  }

  function toggleSeeAll(state) {
    return { state: { ...state, seeAll: !state.seeAll } };
  }

  // What Update hands the install flow; null until a check found something newer.
  function updateTarget(state, name) {
    const e = entryFor(state, name);
    const status = state.statuses[name];
    if (!e || !status || status.outcome !== 'newer-available' || !status.newer.length) return null;
    return {
      name, reference: status.newer[status.newer.length - 1],
      version: typeof e.version === 'string' ? e.version : null,
      link: e.source && typeof e.source.url === 'string' ? e.source.url : null,
    };
  }

  function connectionLost(state) {
    if (!state.busy) return { state: { ...state, busy: null } };
    const note = { text: 'The connection dropped before an answer arrived. Try again once it returns.', tone: 'danger' };
    const notes = state.busy.name ? { ...state.notes, [state.busy.name]: note } : state.notes;
    return { state: { ...state, busy: null, confirming: null, notes } };
  }

  function unsent(state) {
    return { ...state, busy: null, notice: { text: 'Not connected: nothing was sent. Try again once the connection returns.', tone: 'danger' } };
  }

  function workspaceChanged() {
    return initial();
  }

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function dateLabel(iso, now) {
    if (typeof iso !== 'string') return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const today = now instanceof Date ? now : new Date();
    const base = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
    return d.getUTCFullYear() === today.getUTCFullYear() ? base : `${base} ${d.getUTCFullYear()}`;
  }

  // owner/repo out of a GitHub url; anything else is shown whole.
  function repoOf(url) {
    if (typeof url !== 'string' || !url) return null;
    const m = /^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.trim());
    return m ? m[1] : url;
  }

  function action(label, name, extra) {
    return { label, action: name, accent: false, danger: false, disabled: false, ...extra };
  }

  function busyOn(state, name, operation) {
    return !!(state.busy && state.busy.name === name && state.busy.operation === operation);
  }

  function confirmFor(name) {
    return {
      text: `Uninstall ${name}? Its files under .claude/rundock/extensions/${name} are removed with its record. Agents and skills that arrived with it are ordinary workspace files and stay.`,
      confirmLabel: `Uninstall ${name}`,
      cancelLabel: 'Keep it',
    };
  }

  // What the install flow knows that the roster does not: an install or
  // update in flight for a name, and the last one that failed.
  function flowFor(flow, name) {
    if (!flow) return null;
    const updating = flow.updating && flow.updating.name === name ? flow.updating : null;
    const fresh = !flow.updating && flow.manifest && flow.manifest.name === name ? flow.manifest : null;
    if (!updating && !fresh) return null;
    const inFlight = flow.phase === 'classifying' || flow.phase === 'trust' || flow.phase === 'installing';
    if (!inFlight && flow.phase !== 'failed') return null;
    return { updating, fresh, phase: inFlight ? 'in-flight' : 'failed', message: flow.message || 'That did not work.', reference: flow.reference || null };
  }

  function rowFor(state, e, flow, now) {
    const name = e.id;
    const version = typeof e.version === 'string' ? e.version : null;
    const source = e.source && typeof e.source === 'object' ? e.source : null;
    const row = {
      id: name, name, version,
      versionLabel: version ? `v${version}` : null,
      repo: source ? repoOf(source.url) : null,
      reference: source && typeof source.reference === 'string' ? source.reference : null,
      installedAt: typeof e.installedAt === 'string' ? e.installedAt : null,
      installedLabel: dateLabel(e.installedAt, now),
      state: 'enabled', chip: null, dimmed: false, problem: null, note: null, actions: [],
      confirming: state.confirming === name, confirm: state.confirming === name ? confirmFor(name) : null,
      transient: false,
    };
    const status = state.statuses[name] || null;
    const newer = status && status.outcome === 'newer-available' && status.newer.length ? status.newer[status.newer.length - 1] : null;
    const activity = flowFor(flow, name);

    if (activity && activity.updating && activity.phase === 'in-flight') {
      row.state = 'updating';
      row.chip = chip('updating');
      row.versionLabel = `v${activity.updating.version || version} → ${activity.updating.reference}`;
      return row;
    }
    if (e.broken) {
      row.state = 'broken';
      row.chip = chip('broken');
      row.problem = e.reason || 'This extension can no longer be read.';
      row.actions = [action('Uninstall', 'uninstall', { danger: true })];
      return row;
    }
    const refused = Array.isArray(e.refusals) && e.refusals.length ? e.refusals[0] : null;
    if (refused) row.problem = refused.reason || `the match rule "${refused.match}" is not honoured`;

    const uninstall = action('Uninstall', 'uninstall', { danger: true, disabled: !!state.busy });
    const note = state.notes[name] || null;

    if (e.enabled === false) {
      row.state = 'disabled';
      row.chip = chip('disabled');
      row.dimmed = true;
      row.actions = [
        action(busyOn(state, name, 'set-enabled') ? 'Enabling…' : 'Enable', 'enable', { accent: true, disabled: !!state.busy }),
        uninstall,
      ];
      if (newer) row.note = { text: `${newer} is available. Re-enabling does not update it automatically.`, tone: 'attention' };
    } else if (activity && activity.updating && activity.phase === 'failed') {
      row.state = 'enabled';
      row.chip = chip('enabled');
      row.note = { text: `Update to ${activity.updating.reference} failed: ${activity.message}. Still running ${version}.`, tone: 'danger' };
      row.actions = [
        action('Try again', 'retry-update', { accent: true, disabled: !!state.busy }),
        action('Disable', 'disable', { disabled: !!state.busy }),
        uninstall,
      ];
    } else if (newer) {
      row.state = 'update-available';
      row.chip = chip('update-available');
      row.actions = [
        action(`Update to ${newer}`, 'update', { accent: true, disabled: !!state.busy }),
        action(busyOn(state, name, 'set-enabled') ? 'Disabling…' : 'Disable', 'disable', { disabled: !!state.busy }),
        uninstall,
      ];
    } else {
      row.state = 'enabled';
      row.chip = chip('enabled');
      const checking = busyOn(state, name, 'update-check');
      row.actions = [
        action(checking ? 'Checking…' : 'Check for update', 'check', { disabled: !!state.busy }),
        action(busyOn(state, name, 'set-enabled') ? 'Disabling…' : 'Disable', 'disable', { disabled: !!state.busy }),
        uninstall,
      ];
      if (status && status.outcome === 'up-to-date') row.note = { text: `Up to date at ${status.current}.`, tone: 'neutral' };
      else if (status && status.outcome === 'unorderable-pin') {
        row.note = { text: `Pinned at ${status.current}, which cannot be compared with the tags this repository publishes. Pin a tag to have updates checked.`, tone: 'neutral' };
      }
    }
    if (note) row.note = note;
    if (busyOn(state, name, 'uninstall')) row.actions = row.actions.map((a) => (a.action === 'uninstall' ? { ...a, label: 'Uninstalling…', disabled: true } : a));
    return row;
  }

  // A fresh install has no record yet, so it is a transient row drawn from
  // the flow alone; its actions live on the flow's own card.
  function transientRow(flow) {
    const activity = flow && flow.manifest && !flow.updating ? flowFor(flow, flow.manifest.name) : null;
    if (!activity || !activity.fresh) return null;
    const failed = activity.phase === 'failed';
    return {
      id: activity.fresh.name, name: activity.fresh.name, version: activity.fresh.version || null,
      versionLabel: activity.fresh.version ? `v${activity.fresh.version}` : null,
      repo: repoOf(flow.link) || null, reference: flow.reference || null, installedAt: null, installedLabel: null,
      state: failed ? 'install-failed' : 'installing',
      chip: chip(failed ? 'install-failed' : 'installing'),
      dimmed: false,
      problem: failed ? `${activity.message}. Nothing was enabled.` : null,
      note: null, actions: [], confirming: false, confirm: null, transient: true,
    };
  }

  function rows(state, flow, now) {
    const out = state.extensions.filter((e) => e && typeof e.id === 'string').map((e) => rowFor(state, e, flow, now));
    const transient = transientRow(flow);
    if (transient && !out.some((r) => r.id === transient.id)) out.unshift(transient);
    return out;
  }

  const KIND_WORDS = { agent: 'agent', skill: 'skill', file: 'file', folder: 'folder' };
  const ARRIVED = new Set(['written', 'unchanged']);

  function slugOf(item) {
    const id = typeof item.id === 'string' ? item.id : '';
    const colon = id.indexOf(':');
    return colon === -1 ? id : id.slice(colon + 1);
  }

  function nameOf(source) {
    const id = source && typeof source.id === 'string' ? source.id : '';
    const repo = repoOf(id);
    const segments = (repo || id).split('/').filter(Boolean);
    return segments.length ? segments[segments.length - 1] : '(unknown package)';
  }

  function receiptRow(r, now) {
    const items = Array.isArray(r.items) ? r.items : [];
    const arrived = items.filter((i) => i && ARRIVED.has(i.outcome));
    const counts = {};
    for (const i of arrived) counts[i.kind] = (counts[i.kind] || 0) + 1;
    const countLine = Object.keys(KIND_WORDS).filter((k) => counts[k]).map((k) => count(counts[k], KIND_WORDS[k])).join(' · ');
    return {
      file: r.file,
      name: nameOf(r.source),
      repo: r.source && typeof r.source.id === 'string' ? (repoOf(r.source.id) || r.source.id) : null,
      reference: r.source && typeof r.source.reference === 'string' ? r.source.reference : null,
      appliedAt: r.appliedAt,
      date: dateLabel(r.appliedAt, now),
      countLine: countLine || 'nothing arrived',
      skipped: items.length - arrived.length,
      // Each arrived item links to the live thing.
      items: arrived.map((i) => ({
        label: slugOf(i), kind: i.kind,
        open: i.kind === 'agent' ? 'agent' : i.kind === 'skill' ? 'skill' : 'file',
        target: i.kind === 'agent' || i.kind === 'skill' ? slugOf(i) : i.destination,
      })),
    };
  }

  function receiptRows(state, now) {
    const sorted = state.receipts.filter((r) => r && typeof r.appliedAt === 'string')
      .slice().sort((a, b) => (a.appliedAt < b.appliedAt ? 1 : a.appliedAt > b.appliedAt ? -1 : (a.file < b.file ? 1 : -1)));
    const shown = state.seeAll ? sorted : sorted.slice(0, RECENT_LIMIT);
    const hidden = sorted.length - shown.length;
    return {
      rows: shown.map((r) => receiptRow(r, now)),
      hidden,
      seeAllLabel: hidden > 0 ? `See all (${sorted.length})` : null,
    };
  }

  return {
    initial, open, reply, checkForUpdate, setEnabled, askUninstall, cancelUninstall, confirmUninstall,
    toggleSeeAll, updateTarget, connectionLost, unsent, workspaceChanged, rows, receiptRows,
    CHIP_TONES, EMPTY_EXTENSIONS, EMPTY_RECEIPTS, RECENT_LIMIT,
  };
}));
