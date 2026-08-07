// Pending-update launch counting. Pure: no Electron, no I/O.
//
// When an update downloads but fails to install, every subsequent app launch
// is evidence of that failure. electron/update-state.js switches to an
// escape-hatch message once the count is high enough; this module owns the
// counting itself. Reading and writing the record to disk stays in
// electron/main.js with the rest of the wiring.
//
// The record is { downloadedVersion, launches }: which version is sitting
// downloaded-but-unapplied, and how many times the app has started since.

'use strict';

/**
 * Called once per app launch with whatever record the previous run left.
 *
 * @param {object} args
 * @param {string} args.currentVersion  the version actually running
 * @param {*} args.stored  the persisted record, or null/garbage
 * @returns {{ record: object|null, launchesSinceDownload: number }}
 *   record is what should be persisted for the next launch (null clears it);
 *   launchesSinceDownload feeds decideUpdateUi.
 */
function reconcileOnLaunch({ currentVersion, stored }) {
  const none = { record: null, launchesSinceDownload: 0 };

  if (!stored || typeof stored !== 'object') return none;
  if (typeof stored.downloadedVersion !== 'string' || !stored.downloadedVersion) return none;

  // Running the version that was pending means the install worked. Clear
  // the record, or a once-stuck user would be told the updater is broken
  // forever, on every version after the one that failed.
  if (stored.downloadedVersion === currentVersion) return none;

  const previous = typeof stored.launches === 'number' && Number.isFinite(stored.launches)
    ? Math.max(0, Math.floor(stored.launches))
    : 0;
  const launches = previous + 1;

  return {
    record: { downloadedVersion: stored.downloadedVersion, launches },
    launchesSinceDownload: launches,
  };
}

/**
 * Called when a download completes.
 *
 * A stuck install downloads the same update again on every launch, so a
 * completed download of the version already pending must keep the existing
 * count; resetting it would make the escape-hatch threshold unreachable by
 * exactly the users who need it. A different version starts a fresh count:
 * a newer download deserves a fresh chance before being called stuck.
 */
function recordDownloaded(version, existing) {
  if (
    existing && typeof existing === 'object' &&
    existing.downloadedVersion === version &&
    typeof existing.launches === 'number' && Number.isFinite(existing.launches)
  ) {
    return { downloadedVersion: version, launches: Math.max(0, Math.floor(existing.launches)) };
  }
  return { downloadedVersion: version, launches: 0 };
}

module.exports = { reconcileOnLaunch, recordDownloaded };
