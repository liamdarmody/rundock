'use strict';
/**
 * The state the Packages and Extensions pages share: the installed
 * extensions (which the Extensions page draws, see extensions-view-model.js)
 * and the installed packages (which the Packages page draws as cards, see
 * packages-update-model.js), and the only messages either may send about
 * installed extensions. A module rather than a view for the
 * same reason the install flow's model is one: what the pages are judged on
 * is what each entry says and what is sent when. Every transition returns
 * `{ state, send }`, and `send` is undefined unless the person asked.
 *
 * Updating and uninstalling a package are not here: a package does both as
 * one unit from its card (packages-update-model.js). This model only hears
 * which packages have a newer release, so the Extensions page can say so
 * without offering it.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else root.RundockPackagesManageModel = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  function initial() {
    return {
      loaded: false, error: null, extensions: [], receipts: [], packages: [], allOff: false, updatesFolder: { bytes: 0, files: 0 },
      // One operation in flight, matched by its reply; per-extension facts
      // learned since the read (a newer release of its package, a failure);
      // a sentence beneath the list.
      busy: null, statuses: {}, notes: {}, notice: null,
    };
  }

  function count(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
  }

  function open(state) {
    return {
      state: { ...state, busy: { operation: 'page', name: null }, notice: null },
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
      return { state: { ...state, loaded: true, error: null, busy: freed('page'), extensions: Array.isArray(msg.extensions) ? msg.extensions : [], receipts: Array.isArray(msg.receipts) ? msg.receipts : [], packages: Array.isArray(msg.packages) ? msg.packages : [], allOff: msg.allOff === true, updatesFolder: msg.updatesFolder && typeof msg.updatesFolder.bytes === 'number' ? msg.updatesFolder : { bytes: 0, files: 0 } } };
    }
    if (msg.type === 'packages_page_error') {
      return { state: { ...state, loaded: true, error: msg.reason || 'The Packages page couldn\'t be read.', extensions: [], receipts: [], packages: [], busy: null } };
    }
    // A package's check answered: an extension that package installed learns
    // whether a newer release exists, so the Extensions page can say so. The
    // package is matched by the source both records carry.
    if (msg.type === 'package_update_status') {
      const named = state.extensions.filter((e) => e && e.source && typeof e.source.url === 'string' && e.source.url === msg.id).map((e) => e.id);
      if (!named.length) return { state };
      const statuses = { ...state.statuses };
      for (const name of named) statuses[name] = { outcome: msg.outcome, newer: Array.isArray(msg.newer) ? msg.newer : [], current: msg.current };
      return { state: { ...state, statuses } };
    }
    if (msg.type === 'extension_state') {
      const op = msg.operation === 'set-all-off' ? 'set-all-off' : 'set-enabled';
      return { state: { ...state, busy: freed(op), extensions: Array.isArray(msg.extensions) ? msg.extensions : state.extensions, allOff: typeof msg.allOff === 'boolean' ? msg.allOff : state.allOff, notes: msg.name ? without(state.notes, msg.name) : state.notes } };
    }
    // Another window changed a record: the roster every window is sent. Only
    // the list and the switch move; whatever this window is waiting on stays.
    if (msg.type === 'extensions') {
      if (!state.loaded || !Array.isArray(msg.extensions)) return { state };
      return { state: { ...state, extensions: msg.extensions, allOff: typeof msg.allOff === 'boolean' ? msg.allOff : state.allOff } };
    }
    // A record or a receipt changed under a flow this model does not drive:
    // read the page again, once it has been read at all, so the list and the
    // host's registry that rides on the same reply see what changed.
    if (msg.type === 'extension_install_result') return state.loaded ? open(state) : { state };
    if (msg.type === 'package_import_result' && msg.operation === 'apply') return state.loaded ? open(state) : { state };
    if (msg.type === 'package_update_result' && msg.status === 'ready') return state.loaded ? open(state) : { state };
    if (msg.type === 'package_uninstall_result') return state.loaded ? open(state) : { state };
    // An error is this section's only when it names the operation the
    // section is waiting on; an install's error mid-check is the install
    // flow's to render, not a note on a row.
    if (msg.type === 'package_install_error' && state.busy && state.busy.name && msg.operation === state.busy.operation
      && (msg.name === undefined || msg.name === state.busy.name)) {
      const notes = { ...state.notes, [state.busy.name]: { text: msg.message || 'That did not work.', tone: 'danger' } };
      return { state: { ...state, busy: null, notes } };
    }
    // The switch is asked for by no name, so its refusal names none either:
    // it frees the wait and is said beneath the list.
    if (msg.type === 'package_install_error' && state.busy && state.busy.operation === 'set-all-off' && msg.operation === 'set-all-off') {
      return { state: { ...state, busy: null, notice: { text: msg.message || 'That did not work.', tone: 'danger' } } };
    }
    return { state };
  }

  function ask(state, operation, name, send) {
    if (state.busy || !entryFor(state, name)) return { state };
    return { state: { ...state, busy: { operation, name }, notice: null }, send };
  }

  function setEnabled(state, name, enabled) {
    return ask(state, 'set-enabled', name, { type: 'set_extension_enabled', name, enabled: !!enabled });
  }

  // The one switch for every extension. Asked for by no name: it changes no
  // extension's own setting.
  function setAllOff(state, off) {
    if (state.busy || !state.loaded) return { state };
    return { state: { ...state, busy: { operation: 'set-all-off', name: null }, notice: null }, send: { type: 'set_extensions_all_off', off: !!off } };
  }

  function connectionLost(state) {
    if (!state.busy) return { state: { ...state, busy: null } };
    const note = { text: 'The connection dropped before an answer arrived. Try again once it returns.', tone: 'danger' };
    const notes = state.busy.name ? { ...state.notes, [state.busy.name]: note } : state.notes;
    return { state: { ...state, busy: null, notes } };
  }

  function unsent(state) {
    return { ...state, busy: null, notice: { text: 'Not connected: nothing was sent. Try again once the connection returns.', tone: 'danger' } };
  }

  function workspaceChanged() {
    return initial();
  }

  // The hidden folder an update saves into, said for a person: null when empty.
  function folderLabel(state) {
    const f = state.updatesFolder || { bytes: 0, files: 0 };
    if (!f.files) return null;
    const size = f.bytes >= 1024 * 1024 ? `${(f.bytes / (1024 * 1024)).toFixed(1)} MB` : f.bytes >= 1024 ? `${Math.round(f.bytes / 1024)} KB` : `${f.bytes} bytes`;
    return `Saved during updates: ${count(f.files, 'file')}, ${size}, kept in .rundock/package-updates. Nothing clears it by itself.`;
  }

  return {
    initial, open, reply, setEnabled, setAllOff,
    connectionLost, unsent, workspaceChanged, folderLabel,
  };
}));
