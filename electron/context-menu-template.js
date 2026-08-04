'use strict';
// Shape of the editor's right-click menu, as a decision over Electron's
// `context-menu` params.
//
// Deliberately requires nothing from electron, so it is unit-testable under
// node --test the same way public/code-language.js and public/empty-list.js
// are. main.js maps the descriptors returned here onto real Menu items and
// webContents calls; that wiring is a dozen lines and this is the half with
// edge cases.
//
// Why the app needs this at all: Electron does not provide Chromium's default
// context menu. Unless the main process listens for `context-menu` and builds
// one, right-clicking does nothing. Rundock listened for nothing, so the
// packaged app had no spelling suggestions and, more importantly, no Cut,
// Copy, Paste or Select All anywhere in the editor.
//
// The gate is `isEditable`. The renderer draws its own context menus on
// conversation rows and file-tree rows, and a renderer calling
// preventDefault() does NOT stop the main-process event firing. Returning null
// for non-editable targets is what keeps two menus off the screen at once.
// This deliberately gives up offering Copy on selected read-only text: those
// are exactly the rows that already have their own menu.

/**
 * @param {object} params Electron's context-menu params
 * @returns {Array<object>|null} menu descriptors, or null for no menu
 *
 * Descriptor shapes:
 *   { role, enabled }                     a standard editing item
 *   { type: 'separator' }
 *   { label, action: { type, word } }     a spelling item main.js wires up
 */
function buildContextMenuTemplate(params) {
  if (!params || typeof params !== 'object') return null;
  if (!params.isEditable) return null;

  // editFlags should always be present; default to everything disabled rather
  // than throwing, since this runs in the main process on every right-click.
  const flags = (params.editFlags && typeof params.editFlags === 'object') ? params.editFlags : {};

  const template = [];

  const misspelled = typeof params.misspelledWord === 'string' ? params.misspelledWord : '';
  if (misspelled) {
    const suggestions = Array.isArray(params.dictionarySuggestions) ? params.dictionarySuggestions : [];
    // The OS orders suggestions by confidence; preserve it rather than sorting.
    for (const word of suggestions) {
      if (typeof word !== 'string' || !word) continue;
      template.push({ label: word, action: { type: 'replaceMisspelling', word } });
    }
    // Offered even when there are no suggestions: Hunspell returns an empty
    // list for many proper nouns, and an underline with no way to resolve it
    // reads as a dead end.
    template.push({
      label: 'Add to Dictionary',
      action: { type: 'addToDictionary', word: misspelled },
    });
    template.push({ type: 'separator' });
  }

  template.push(
    { role: 'cut', enabled: !!flags.canCut },
    { role: 'copy', enabled: !!flags.canCopy },
    { role: 'paste', enabled: !!flags.canPaste },
    { type: 'separator' },
    { role: 'selectAll', enabled: !!flags.canSelectAll }
  );

  return template;
}

module.exports = buildContextMenuTemplate;
