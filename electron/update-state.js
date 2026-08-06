// Updater decision logic. Pure: no Electron, no I/O, no state of its own.
//
// Same pattern as public/chrome-insets.js, public/code-language.js and
// electron/context-menu-template.js. Everything about "given what we know
// about an update, what should the user see?" lives here so it can be tested
// without launching an app. electron/main.js keeps only the wiring, which is
// the part that genuinely cannot be tested.
//
// THE INVARIANT THIS FILE EXISTS TO HOLD:
// There is no path where the interface claims an update will be installed and
// it then is not. The shipped dialog said "Rundock will install the update on
// next quit", which was not reliably true, and a promise the app breaks is
// worse than no promise at all. Any copy here that mentions installing is
// reachable only from a state where the user has just asked for it.

'use strict';

const PHASES = ['idle', 'checking', 'available', 'downloading', 'downloaded', 'error'];

// After this many launches with an update downloaded but still not applied,
// stop pretending it is going to work and give the user a way out that does
// not depend on the updater. Three rather than two: a user who quits and
// relaunches once for unrelated reasons should not be told the thing is
// broken. Three is deliberate enough to mean something.
const STUCK_AFTER_LAUNCHES = 3;

const DOWNLOAD_PAGE = 'https://rundock.ai/download';

function clampPercent(p) {
  if (typeof p !== 'number' || Number.isNaN(p)) return null;
  return Math.max(0, Math.min(100, Math.round(p)));
}

function nothing() {
  return { kind: 'none' };
}

/**
 * Decide what the user should be shown about an update.
 *
 * @param {object} state
 * @param {string} state.phase   one of PHASES
 * @param {number|null} state.percent  download percent, null before the first event
 * @param {string|null} state.version  the version being offered
 * @param {boolean} state.manual  true when the user chose "Check for Updates"
 * @param {number} state.launchesSinceDownload  launches with an update pending
 * @param {string} [state.error]  message from the updater's error event
 * @returns {object} { kind, ... } where kind is one of:
 *   none      show nothing
 *   dialog    a modal, only ever in response to something the user did
 *   progress  an in-place surface showing a download happening
 *   ready     an update is downloaded and installing is one click away
 *   stuck     downloaded repeatedly but not installing; offer a way out
 */
function decideUpdateUi(state) {
  const s = state || {};
  const phase = s.phase;
  const manual = Boolean(s.manual);
  const version = s.version || null;
  const launches = Number(s.launchesSinceDownload) || 0;

  switch (phase) {
    case 'idle':
      return nothing();

    case 'checking':
      // A manual check is acknowledged when it resolves, not while it runs:
      // a modal that appears and replaces itself reads as a glitch.
      return nothing();

    case 'available': {
      // autoDownload is on, so "available" already means "downloading".
      // Show the progress surface either way; only a check the user asked
      // for also gets a dialog, because only that one is owed an answer.
      const ui = {
        kind: 'progress',
        percent: clampPercent(s.percent) ?? 0,
        indeterminate: clampPercent(s.percent) === null,
        text: version
          ? `Downloading Rundock ${version}. You can keep working.`
          : 'Downloading an update. You can keep working.',
        version,
      };
      if (manual) {
        ui.dialog = {
          type: 'info',
          message: version ? `Update available: ${version}` : 'Update available',
          // Deliberately describes only what is happening now. The old copy
          // promised an install on next quit, which is the bug.
          detail: 'Downloading in the background. Rundock will offer to restart when it is ready.',
          buttons: ['OK'],
        };
      }
      return ui;
    }

    case 'downloading': {
      const percent = clampPercent(s.percent);
      return {
        kind: 'progress',
        percent: percent ?? 0,
        indeterminate: percent === null,
        text: version
          ? `Downloading Rundock ${version}. You can keep working.`
          : 'Downloading an update. You can keep working.',
        version,
      };
    }

    case 'downloaded': {
      const stuck = launches >= STUCK_AFTER_LAUNCHES;
      if (stuck) {
        // The population that reaches this state is precisely the one the
        // updater is failing, so the way out must not route through the
        // updater. A plain download link always works.
        return {
          kind: 'stuck',
          version,
          text: version
            ? `Rundock ${version} was downloaded but has not installed after several restarts.`
            : 'An update was downloaded but has not installed after several restarts.',
          detail: 'You can try restarting again, or download the latest version directly.',
          buttons: ['Restart now', 'Download manually', 'Later'],
          actions: ['quitAndInstall', 'openDownloadPage', 'dismiss'],
          defaultId: 0,
          downloadUrl: DOWNLOAD_PAGE,
          launchesSinceDownload: launches,
        };
      }
      return {
        kind: 'ready',
        version,
        // States a fact about the present, and nothing about the future.
        text: version ? `Rundock ${version} is ready to install.` : 'An update is ready to install.',
        detail: 'Restarting takes a few seconds.',
        buttons: ['Restart now', 'Later'],
        actions: ['quitAndInstall', 'dismiss'],
        defaultId: 0,
      };
    }

    case 'error': {
      // An automatic check that fails says nothing: the user did not ask, and
      // a machine that is merely offline is not a problem worth a modal.
      if (!manual) return nothing();
      return {
        kind: 'dialog',
        dialog: {
          type: 'error',
          message: 'Could not check for updates',
          detail: s.error ? String(s.error) : 'The update service could not be reached.',
          buttons: ['OK'],
        },
      };
    }

    default:
      // Fail closed. A crash inside the updater path would be worse than
      // showing nothing at all.
      return nothing();
  }
}

module.exports = { decideUpdateUi, PHASES, STUCK_AFTER_LAUNCHES, DOWNLOAD_PAGE };
