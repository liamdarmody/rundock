'use strict';
/**
 * What the Extensions settings page shows for each installed extension,
 * decided from the manage model's state (RundockPackagesManageModel), which
 * this reads and never changes. The page and the Packages page share that one
 * state, so an extension switched off here is off there too.
 *
 * Each row has one right-hand control column: the switch with On or Off beside
 * it. A row that could not load has no switch; in its place the column sends
 * the person to its package, because uninstalling is the package's, on the
 * Packages page. No row is ever dimmed: off is said by the word and the
 * switch, and paused by the banner above the list.
 *
 * While every extension is paused, every switch is disabled. Each keeps
 * showing the extension's own on or off setting, which the pause leaves as it
 * was, but cannot be pressed until Resume, when each goes back to exactly that
 * setting. The row and its text stay at full strength; only the switch takes
 * the disabled style. The page offers no update controls either; where the
 * state already knows an update exists, the row says so as a link to
 * Packages, which is where updates live.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RundockExtensionsViewModel = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  const LEAD = 'Extensions add features to Rundock. Manage the ones you\'ve installed here.';
  const EMPTY = 'No extensions installed. Add a package that includes an extension to see it here.';
  const LOAD_FAILED = 'Rundock couldn\'t load this extension.';
  // What follows it: the way to the package that can remove it, or, where
  // that package is not known, a plain statement with nothing to press.
  const LOAD_FAILED_WAY = { before: 'Uninstall it from ', link: 'its package', after: '.' };
  const LOAD_FAILED_UNKNOWN = 'Rundock can\'t tell which package installed it.';
  const PAUSE_TEXT = 'Having trouble? Pause all extensions to check whether one is causing it. Nothing is removed.';
  const PAUSED_BANNER = 'All extensions are paused. Each one goes back to its own setting when you resume.';

  const DAY = 24 * 60 * 60 * 1000;
  function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }
  // "Added 2 days ago": days to a fortnight, then weeks to two months, then
  // months to a year, then years.
  function addedLabel(iso, now) {
    if (typeof iso !== 'string') return null;
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return null;
    const days = Math.max(0, Math.floor(((now instanceof Date ? now : new Date()).getTime() - then) / DAY));
    if (days === 0) return 'Added today';
    if (days === 1) return 'Added yesterday';
    if (days < 14) return `Added ${plural(days, 'day')} ago`;
    if (days < 60) return `Added ${plural(Math.floor(days / 7), 'week')} ago`;
    if (days < 365) return `Added ${plural(Math.floor(days / 30), 'month')} ago`;
    return `Added ${plural(Math.floor(days / 365), 'year')} ago`;
  }

  // owner/repo from a GitHub url, lower-cased so two spellings of one
  // repository match; anything else is compared whole.
  function repoKey(url) {
    if (typeof url !== 'string' || !url) return null;
    const m = /^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(url.trim());
    return (m ? m[1] : url.trim()).toLowerCase();
  }
  // The name the Packages page gives a receipt: the last segment of its source.
  function packageName(id) {
    const raw = String(id).trim().replace(/\/+$/, '').replace(/\.git$/i, '');
    return raw.split('/').filter(Boolean).pop() || null;
  }

  // What the package calls itself. A package and its extension share one
  // manifest (rundock.json), whose `name` is a slug, so it is title-cased the
  // way an agent's slug is when it has no displayName ("investment-partner" is
  // "Investment Partner"). A `displayName`, where the roster carries one, is
  // used as written. The repository's name is the fallback only when the
  // manifest gives no name at all.
  function titleCase(slug) {
    return slug.split(/[-_\s]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  }
  function displayNameFor(e, sourceId) {
    if (e && typeof e.displayName === 'string' && e.displayName.trim()) return e.displayName.trim();
    if (e && typeof e.id === 'string' && e.id) return titleCase(e.id);
    return packageName(sourceId);
  }

  // The package an extension came from is known only where a package card
  // names the same source. Otherwise the row says nothing about it rather
  // than linking to a card that does not exist.
  // The package card on the Packages page that installed this extension:
  // named as that card names it, and opened by its source.
  function provenanceFor(e, packages) {
    const key = repoKey(e && e.source && e.source.url);
    if (!key) return null;
    const card = (packages || []).find((c) => c && typeof c.id === 'string' && repoKey(c.id) === key);
    if (!card) return null;
    return { name: card.title || displayNameFor(e, card.id), package: card.id };
  }

  // Every reason or error a person reads here is a sentence: a capital first
  // letter and a closing full stop. The server's own reasons are written that
  // way; this holds the line for a message from an older server, or one that
  // arrives as an error's own text.
  function sentence(text) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return t;
    const capped = t[0].toUpperCase() + t.slice(1);
    return /[.!?\u2026]$/.test(capped) ? capped : `${capped}.`;
  }

  function rows(state, now) {
    const st = state || {};
    const paused = st.allOff === true;
    const busy = st.busy || null;
    return (Array.isArray(st.extensions) ? st.extensions : []).filter((e) => e && typeof e.id === 'string').map((e) => {
      const name = e.id;
      const failed = e.broken === true;
      // The extension's own setting, which a pause keeps rather than changes.
      const on = e.allOff === true ? e.ownEnabled !== false : e.enabled !== false;
      const status = st.statuses && st.statuses[name];
      const marked = (Array.isArray(e.renderers) ? e.renderers : []).find((r) => r && typeof r.declares === 'string' && r.declares);
      const refused = Array.isArray(e.refusals) && e.refusals.length ? e.refusals[0] : null;
      const note = st.notes && st.notes[name];
      const provenance = provenanceFor(e, st.packages);
      return {
        id: name, name,
        versionLabel: typeof e.version === 'string' ? `v${e.version}` : null,
        addedLabel: addedLabel(e.installedAt, now),
        provenance,
        failed,
        failedText: failed ? LOAD_FAILED : null,
        failedWay: !failed ? null : provenance ? { ...LOAD_FAILED_WAY } : { text: LOAD_FAILED_UNKNOWN },
        on, paused,
        onLabel: on ? 'On' : 'Off',
        switchLabel: paused ? `${name}, paused` : name,
        // A hook, not a control: shown only when the state already knows an
        // update exists. Nothing on this page asks.
        updateAvailable: !!(status && status.outcome === 'newer-available'),
        claims: marked ? `Renders ${marked.target} files marked "${marked.declares}" in their frontmatter.` : null,
        problem: !failed && refused ? sentence(refused.reason || `The match rule "${refused.match}" is not honoured.`) : null,
        note: note ? { text: sentence(note.text), tone: note.tone } : null,
        switching: !!(busy && busy.operation === 'set-enabled' && busy.name === name),
        // Paused, the switch shows its own setting but cannot change it.
        disabled: paused || !!busy,
      };
    });
  }

  function pauseControl(state) {
    const st = state || {};
    const paused = st.allOff === true;
    const busy = !!(st.busy && st.busy.operation === 'set-all-off');
    return paused
      ? { paused: true, banner: PAUSED_BANNER, label: busy ? 'Resuming…' : 'Resume extensions', disabled: !!st.busy }
      : { paused: false, text: PAUSE_TEXT, label: busy ? 'Pausing…' : 'Pause all extensions', disabled: !!st.busy };
  }

  // The only messages this page may cause the manage model to send.
  const SENDS = ['get_packages_page', 'set_extension_enabled', 'set_extensions_all_off'];

  return { rows, pauseControl, addedLabel, provenanceFor, displayNameFor, sentence, LEAD, EMPTY, LOAD_FAILED, LOAD_FAILED_WAY, LOAD_FAILED_UNKNOWN, PAUSE_TEXT, PAUSED_BANNER, SENDS };
}));
