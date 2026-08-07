// Update feed override. Pure: no Electron, no I/O.
//
// RUNDOCK_UPDATE_FEED points the updater at any static server that hosts the
// artefacts electron-builder generates (see scripts/update-harness/). That
// lets the whole update cycle run against a local feed instead of a published
// release, which is the only way to verify updater changes before shipping
// them through the very mechanism under repair.
//
// The one rule: a value that is set but unusable is reported as invalid,
// never silently ignored. Whoever sets the override believes their updates
// are coming from their own feed. Falling back to the production feed on a
// typo would make their test pass against the wrong thing.

'use strict';

const ENV_VAR = 'RUNDOCK_UPDATE_FEED';

/**
 * Read the update feed override from an environment object.
 *
 * @param {object|undefined} env  typically process.env
 * @returns {{ kind: 'none' } | { kind: 'feed', url: string } | { kind: 'invalid', reason: string }}
 */
function resolveUpdateFeed(env) {
  const raw = env && typeof env[ENV_VAR] === 'string' ? env[ENV_VAR].trim() : '';
  if (!raw) return { kind: 'none' };

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { kind: 'invalid', reason: `${ENV_VAR} is not a URL: "${raw}"` };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      kind: 'invalid',
      reason: `${ENV_VAR} must be an http or https URL, got "${raw}"`,
    };
  }

  return { kind: 'feed', url: raw };
}

module.exports = { resolveUpdateFeed, ENV_VAR };
