// Where the desktop app keeps its own state (userData). Pure: no Electron,
// no I/O.
//
// RUNDOCK_USER_DATA_DIR starts the app on a profile of its own: its own
// single-instance lock, renderer storage, setup marker and update record,
// none of them shared with a Rundock already open on the same machine. That
// is how a second copy runs against a throwaway workspace, and how the
// desktop parity check (test/electron/settings-parity.cjs) launches the real
// entrypoint without meeting the person's own app.
//
// The one rule, as for RUNDOCK_UPDATE_FEED: a value that is set but unusable
// is refused, never ignored. Whoever sets it expects to be kept away from the
// real profile, and falling back to it would take the real lock and write
// into the real state.
//
// The packaged-boot check (scripts/smoke-packaged.mjs, RUNDOCK_SMOKE_TEST=1)
// keeps its own disposable profile under the temporary folder, as before.

'use strict';

const path = require('path');

const ENV_VAR = 'RUNDOCK_USER_DATA_DIR';

/**
 * @param {object|undefined} env     typically process.env
 * @param {string} tmpdir            the system temporary folder
 * @returns {{ kind: 'none' } | { kind: 'path', path: string } | { kind: 'invalid', reason: string }}
 */
function resolveUserData(env, tmpdir) {
  if (env && env.RUNDOCK_SMOKE_TEST === '1') return { kind: 'path', path: path.join(tmpdir, 'rundock-smoke-userdata') };
  const raw = env && typeof env[ENV_VAR] === 'string' ? env[ENV_VAR].trim() : '';
  if (!raw) return { kind: 'none' };
  if (!path.isAbsolute(raw)) return { kind: 'invalid', reason: `${ENV_VAR} must be an absolute path, got "${raw}"` };
  return { kind: 'path', path: path.normalize(raw) };
}

module.exports = { resolveUserData, ENV_VAR };
