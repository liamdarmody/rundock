// Theme decision. Pure: no DOM, no storage, following the convention of
// public/chrome-insets.js and public/code-language.js.
//
// The rule: an explicit choice the user once made wins forever; until they
// make one, the app follows the OS. `followOs` tells the caller whether to
// keep listening for OS changes (only while no explicit choice exists:
// a chosen theme must not flip when the OS schedule does).
//
// Anything in storage that is not exactly 'light' or 'dark' counts as no
// choice, so corrupt or legacy values degrade to following the OS rather
// than pinning a theme the user never picked.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.chooseTheme = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  /**
   * @param {object} input
   * @param {string|null} [input.stored]        persisted 'light' | 'dark' | anything else
   * @param {boolean} [input.osPrefersLight]    prefers-color-scheme: light
   * @returns {{ light: boolean, followOs: boolean }}
   */
  function chooseTheme(input) {
    const s = input || {};
    if (s.stored === 'light') return { light: true, followOs: false };
    if (s.stored === 'dark') return { light: false, followOs: false };
    return { light: Boolean(s.osPrefersLight), followOs: true };
  }

  return chooseTheme;
}));
