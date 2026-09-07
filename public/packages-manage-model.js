'use strict';
/**
 * The manage half of the Packages page: what the Installed extensions list
 * shows for every installed record, what Recently added shows for every
 * receipt, and the only messages the section may send.
 *
 * WHY THIS IS A MODULE AND NOT A VIEW: the same reason the install flow's
 * model is one. What the section is judged on is the state each row takes,
 * the tone its chip carries, and a set of promises about what is sent when:
 * an uninstall sends nothing before its confirmation, a check carries the
 * name and never a url, an enable names the extension and nothing else.
 * Every transition returns `{ state, send }`, and `send` is undefined
 * unless the person asked for something.
 *
 * THE ROWS ARE READ FROM THE ROSTER THE HOST READS. The server answers one
 * roster from the install store, and this model draws it; there is no
 * second list of installed extensions anywhere for the two to disagree
 * about. A record's own facts (its source repository, its pin, its install
 * date) ride on the roster entry, and the row states them as facts.
 *
 * A ROW LEADS WITH ONE CHIP. Two facts at once (disabled with an update
 * waiting; working with a failed update behind it) keep the chip that says
 * what the extension IS, and put the second fact in prose beneath it. A
 * failed update never wears a Failed chip: the extension still runs.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else root.RundockPackagesManageModel = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  const RECENT_LIMIT = 5;

  // The one tone table. Each chip class names the tone token the stylesheet
  // draws it in; a chip added here without a rule, or a rule without a row
  // that reaches it, is what the render walk in the suite catches.
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
      // The one operation in flight, so a reply can be matched to it and a
      // second click waits rather than racing the first.
      busy: null,
      // Per-extension facts learned since the page was read: the last update
      // check's answer, and the last operation's failure.
      statuses: {}, notes: {},
      // The row whose uninstall confirmation is open, if any.
      confirming: null,
      // A sentence beneath the list: the uninstall reply's own account of what
      // stayed, or the reason the last ask did not go out.
      notice: null,
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

  // ---- what the server said

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
    if (msg.type === 'packages_page') {
      return {
        state: {
          ...state, loaded: true, error: null,
          extensions: Array.isArray(msg.extensions) ? msg.extensions : [],
          receipts: Array.isArray(msg.receipts) ? msg.receipts : [],
          busy: state.busy && state.busy.operation === 'page' ? null : state.busy,
        },
      };
    }
    if (msg.type === 'packages_page_error') {
      return { state: { ...state, loaded: true, error: msg.reason || 'the Packages page could not be read', extensions: [], receipts: [], busy: null } };
    }
    if (msg.type === 'extension_update_status') {
      const busy = state.busy && state.busy.operation === 'update-check' && state.busy.name === msg.name ? null : state.busy;
      return {
        state: {
          ...state, busy,
          statuses: { ...state.statuses, [msg.name]: { outcome: msg.outcome, newer: Array.isArray(msg.newer) ? msg.newer : [], current: msg.current } },
          notes: without(state.notes, msg.name),
        },
      };
    }
    if (msg.type === 'extension_state') {
      return {
        state: {
          ...state,
          extensions: Array.isArray(msg.extensions) ? msg.extensions : state.extensions,
          busy: state.busy && state.busy.operation === 'set-enabled' ? null : state.busy,
          notes: without(state.notes, msg.name),
        },
      };
    }
    if (msg.type === 'extension_uninstalled') {
      return {
        state: {
          ...state,
          extensions: (Array.isArray(msg.extensions) ? msg.extensions : state.extensions).filter((e) => e && e.id !== msg.name),
          statuses: without(state.statuses, msg.name),
          notes: without(state.notes, msg.name),
          busy: state.busy && state.busy.operation === 'uninstall' ? null : state.busy,
          confirming: state.confirming === msg.name ? null : state.confirming,
          notice: typeof msg.untouched === 'string' && msg.untouched ? { text: msg.untouched, tone: 'neutral' } : state.notice,
        },
      };
    }
    // A record changed under a flow this model does not drive: the trust
    // step installed or replaced an extension, or an import landed files and
    // a receipt. Read the page again so the list, and the host's registry
    // that rides on the same reply, see what changed.
    if (msg.type === 'extension_install_result') return open(state);
    if (msg.type === 'package_import_result' && msg.operation === 'apply') return open(state);
    // An error is this section's only when it names the operation the
    // section is waiting on; an install's error mid-check is the install
    // flow's to render, not a note on a row.
    if (msg.type === 'package_install_error' && state.busy && state.busy.name && msg.operation === state.busy.operation
      && (msg.name === undefined || msg.name === state.busy.name)) {
      return {
        state: {
          ...state, busy: null,
          confirming: state.busy.operation === 'uninstall' ? null : state.confirming,
          notes: { ...state.notes, [state.busy.name]: { text: msg.message || 'That did not work.', tone: 'danger' } },
        },
      };
    }
    return { state };
  }

  // ---- what the person asked for

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

  // Uninstall is a question first. Nothing is sent until the confirmation
  // inside the row is answered, and the filled danger button lives there.
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

  // What the Update action hands the install flow: the name, the newest
  // reference the check found, the installed version and the stored link,
  // so the trust card says where the update comes from. Null until a check
  // has found something newer.
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
    const name = state.busy.name;
    return {
      state: {
        ...state, busy: null, confirming: null,
        notes: name ? { ...state.notes, [name]: { text: 'The connection dropped before an answer arrived. Try again once it returns.', tone: 'danger' } } : state.notes,
      },
    };
  }

  function unsent(state) {
    return { ...state, busy: null, notice: { text: 'Not connected: nothing was sent. Try again once the connection returns.', tone: 'danger' } };
  }

  function workspaceChanged() {
    return initial();
  }

  // ---- the rows

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function dateLabel(iso, now) {
    if (typeof iso !== 'string') return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const today = now instanceof Date ? now : new Date();
    const base = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
    return d.getUTCFullYear() === today.getUTCFullYear() ? base : `${base} ${d.getUTCFullYear()}`;
  }

  // owner/repo out of a stored GitHub url; the string itself for anything
  // else, because a source is a fact to show whole rather than to tidy.
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

  // The install flow's state, read for the two things it knows that the
  // roster does not: an install or update in flight for a name, and the
  // last one that failed. `updating` names the installed extension a plan
  // was begun for; `manifest` names what a fresh install was reading.
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

  // A fresh install the flow is reading or that just failed has no record
  // yet, so it is drawn as a transient row from the flow alone: the working
  // chip while it runs, the danger chip with the failure line when it did
  // not. Its actions live on the flow's own card, not here.
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

  // ---- the receipts

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
      // Each item links to the live thing: an agent to its profile, a skill
      // to its page, a file or folder to its path in Files.
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
