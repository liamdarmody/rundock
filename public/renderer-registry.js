// The renderer registry: which installed extension, if any, renders a given
// file target.
//
// A REGISTRY AND NOT A GUESS. The file view asks one question at its render
// seam: does anything claim this file? The answer is either a registration
// carrying everything a mount needs, or a reason there is none. There is no
// third state, because "no renderer" rendering a broken frame is the failure
// the criteria forbid: an unregistered target renders nothing and says why,
// and the plain surface carries on.
//
// FIRST CLAIM WINS, AND THE LOSER IS RECORDED. Two extensions claiming one
// target cannot both render it, and resolving by any quality judgement would
// put the registry in the business of ranking extensions. Registration order
// is the roster's order, which is stable and visible; the refused claim is
// kept with a reason so a person wondering why their renderer is silent can
// be told, rather than left to discover a quiet shadowing.

function normaliseTarget(target) {
  return String(target || '').toLowerCase();
}

// The target grammar, version one: a single dot-prefixed segment, such as
// ".csv" or ".dataview". A single final segment on purpose, because that is
// exactly what rendererFor can look up: it resolves a file's target with the
// last dot, so a multi-segment claim like ".tar.gz" would register, list,
// and never match anything, the quiet shadowing this module exists to
// prevent. No dots after the first, so the accepted grammar and the lookup
// agree. A grammar can grow later, but it can never shrink without breaking
// an extension, so it starts as small as the lookup can honour.
export function isValidTarget(target) {
  return /^\.[a-z0-9][a-z0-9-]*$/.test(normaliseTarget(target));
}

export function createRendererRegistry() {
  const byTarget = new Map();
  const refusals = [];

  return {
    /**
     * Register every renderer an installed-extension roster declares.
     * @param {Array<{id: string, enabled?: boolean, renderers?: Array<{id: string, target: string}>}>} extensions
     */
    registerFromRoster(extensions) {
      for (const ext of (extensions || [])) {
        if (ext.enabled === false) continue;
        for (const renderer of (ext.renderers || [])) {
          const target = normaliseTarget(renderer.target);
          if (!isValidTarget(target)) {
            refusals.push({ extension: ext.id, target: renderer.target,
              reason: 'the target is not a file extension of the form ".name"' });
            continue;
          }
          if (byTarget.has(target)) {
            const holder = byTarget.get(target);
            refusals.push({ extension: ext.id, target,
              reason: `"${target}" is already rendered by ${holder.extension}` });
            continue;
          }
          byTarget.set(target, { extension: ext.id, renderer: renderer.id, target });
        }
      }
    },

    /**
     * The one question the file view asks.
     * @returns {{ registered: true, extension: string, renderer: string }
     *   | { registered: false, reason: string }}
     */
    rendererFor(path) {
      const name = String(path || '');
      const dot = name.lastIndexOf('.');
      if (dot < 0 || dot === name.length - 1) {
        return { registered: false, reason: 'the file has no extension for a renderer to claim' };
      }
      const target = normaliseTarget(name.slice(dot));
      const hit = byTarget.get(target);
      if (!hit) {
        return { registered: false, reason: `no installed extension renders "${target}"` };
      }
      return { registered: true, extension: hit.extension, renderer: hit.renderer };
    },

    // Refused claims, kept so silence is explicable.
    refusals: () => refusals.slice(),
    targets: () => [...byTarget.keys()].sort(),
  };
}
