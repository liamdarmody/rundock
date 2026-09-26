#!/usr/bin/env node
'use strict';
// Break each of Rundock UI's guards in turn and report which tests notice.
//
// What is guarded here: the library reaching every frame without widening
// it (the injection, its order, a source with no way out), the accessibility
// contract each component states (roving tabindex, the keys, aria wiring),
// the contrast the tokens were chosen for, the copies of the app's rules,
// the manifest's version rule, and the mode toggle's tablist. Each can be
// removed with the product still rendering something, which is why a green
// suite proves nothing about them until each is broken on purpose and a test
// goes red for it. A guard whose mutation turns nothing red is reported as a
// FAILURE.
//
//   node test/tools/mutate-rundock-ui-guards.js            # report
//   node test/tools/mutate-rundock-ui-guards.js --markdown # the same, as a table
//
// The files are restored afterwards, including when a run throws. Same shape
// as its siblings, and a separate copy for the reason stated in
// mutate-routines-guards.js.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const { beginMutationRun } = require('./mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');
const p = (...parts) => path.join(ROOT, ...parts);

const LIB = { src: p('public', 'rundock-ui.js'), suite: 'test/unit/rundock-ui.test.js' };
const FRAME = { src: p('public', 'rundock-ui-frame.js'), suite: 'test/unit/rundock-ui-frame.test.js' };
const HOST = { src: p('public', 'extension-host.js'), suite: 'test/unit/rundock-ui-frame.test.js' };
const CSS_CONTRAST = { src: p('public', 'styles', 'rundock-ui.css'), suite: 'test/unit/rundock-ui-contrast.test.js' };
const CSS_PARITY = { src: p('public', 'styles', 'rundock-ui.css'), suite: 'test/unit/rundock-ui-parity.test.js' };
const TOKENS = { src: p('public', 'styles', 'tokens.css'), suite: 'test/unit/rundock-ui-contrast.test.js' };
const APP_STYLES = { src: p('public', 'styles', 'views', 'settings.css'), suite: 'test/unit/rundock-ui-parity.test.js' };
const VERSION = { src: p('lib', 'packages', 'rundock-ui-version.js'), suite: 'test/unit/rundock-ui-manifest.test.js' };
const MANIFEST = { src: p('lib', 'packages', 'extension-manifest.js'), suite: 'test/unit/rundock-ui-manifest.test.js' };
const SETTINGS = { src: p('public', 'views', 'settings.js'), suite: 'test/unit/mode-toggle-tabs.test.js' };
const ROUTER = { src: p('lib', 'http-router.js'), suite: 'test/unit/http-router-lib.test.js' };
const APP_DANGER = { src: p('public', 'styles', 'views', 'settings.css'), suite: 'test/unit/danger-token.test.js' };
const UI_DRIFT = { src: p('public', 'styles', 'rundock-ui.css'), suite: 'test/unit/rundock-ui-parity.test.js' };
const VERSION_AGREE = { src: p('lib', 'packages', 'rundock-ui-version.js'), suite: 'test/unit/rundock-ui-frame.test.js' };
// Real-engine guards: each row runs one named Chromium test (see redTests).
const CONFINE = (title) => ({ src: p('public', 'extension-host.js'), suite: `test/e2e/extension-confinement.spec.js#${title}` });
const CONFINE_LIB = (title) => ({ src: p('public', 'rundock-ui.js'), suite: `test/e2e/extension-confinement.spec.js#${title}` });
const CONFINE_FRAME = (title) => ({ src: p('public', 'rundock-ui-frame.js'), suite: `test/e2e/extension-confinement.spec.js#${title}` });
const GALLERY_LIB = (title) => ({ src: p('public', 'rundock-ui.js'), suite: `test/e2e/rundock-ui-gallery.spec.js#${title}` });
const GALLERY_CSS = (title) => ({ src: p('public', 'styles', 'rundock-ui.css'), suite: `test/e2e/rundock-ui-gallery.spec.js#${title}` });
const BLEED = (file, title) => ({ src: p('public', 'styles', ...file), suite: `test/e2e/full-bleed.spec.js#${title}` });
const THE_PANE = 'an extension view is the pane, not a box inside it';
// The geometry the design review corrected, measured in pixels in Chromium.
const TICK = { src: p('public', 'styles', 'rundock-ui.css'), suite: 'test/e2e/rundock-ui-gallery.spec.js#the checkbox tick is centred in its box' };
const THUMB = { src: p('public', 'styles', 'rundock-ui.css'), suite: 'test/e2e/rundock-ui-gallery.spec.js#the slider thumb is centred on its track' };
const EDITOR_CSS = { src: p('public', 'styles', 'views', 'editor.css'), suite: 'test/unit/full-bleed.test.js' };
const FRAME_CSS = { src: p('public', 'styles', 'components', 'extension-frame.css'), suite: 'test/unit/full-bleed.test.js' };
const FLOOR_CSS = { src: p('public', 'styles', 'extension-base.css'), suite: 'test/unit/full-bleed.test.js' };
const FILES_SEAM = { src: p('public', 'views', 'files.js'), suite: 'test/unit/host-wiring.test.js' };

const MUTATIONS = [
  // An alert with an action shares its first line with its buttons.
  [CSS_PARITY, 'an alert with an action aligns message and action on the first baseline',
    '.rui-alert:has(> .rui-alert-action) { align-items: baseline; }\n', ''],
  [CSS_PARITY, 'the alert icon joins the first line',
    '.rui-alert:has(> .rui-alert-action) > svg { align-self: baseline; position: relative; top: calc(8px - 0.36em); margin-top: 0; }\n', ''],
  // ===== THE LIBRARY REACHES EVERY FRAME, AND WIDENS NOTHING =====
  [HOST, 'a mounted view is built with Rundock UI',
    '    frame.srcdoc = buildSrcdoc(payload, hostTokenCss(doc), extensionBaseCss(doc), ui, { state: viewState });',
    '    frame.srcdoc = buildSrcdoc(payload, hostTokenCss(doc), extensionBaseCss(doc), undefined, { state: viewState });'],
  [HOST, 'a region frame is built with Rundock UI',
    "  return buildSrcdoc(payload, doc ? hostTokenCss(doc) : '', doc ? extensionBaseCss(doc) : '', rundockUiFrameParts(doc));",
    "  return buildSrcdoc(payload, doc ? hostTokenCss(doc) : '', doc ? extensionBaseCss(doc) : '');"],
  [HOST, 'the library runs before the entry',
    "    + (ui.script ? `<script>${neutraliseClose(ui.script, 'script')}</scr` + 'ipt>' : '')\n    + `<script>${neutraliseClose(payload.entry, 'script')}</scr` + 'ipt>'",
    "    + `<script>${neutraliseClose(payload.entry, 'script')}</scr` + 'ipt>'\n    + (ui.script ? `<script>${neutraliseClose(ui.script, 'script')}</scr` + 'ipt>' : '')"],
  [HOST, 'the component stylesheet sits before the extension\'s own',
    '  const styles = tokens + base + uiCss + (payload.styles || [])',
    '  const styles = tokens + base + (payload.styles || [])'],
  [HOST, 'the frame body carries the theme class',
    "    + `</head><body${ui.bodyClass ? ` class=\"${esc(ui.bodyClass)}\"` : ''}>`",
    "    + '</head><body>'"],
  [ROUTER, 'the gallery page carries the frame policy',
    "      'Content-Security-Policy': PAGE_FRAME_POLICY, // the gallery frames extension documents too\n", ''],
  [FRAME, 'the stylesheet is read from the sheet marked data-rundock-ui',
    "    if (!node || !node.hasAttribute || !node.hasAttribute('data-rundock-ui')) continue;",
    '    continue;'],
  [LIB, 'the library source has no way out of the frame',
    '  const doc = win.document;\n  const SVG_NS',
    "  const doc = win.document; if (win.__never) win.parent.postMessage({ type: 'ready' }, '*');\n  const SVG_NS"],
  [LIB, 'a label is text, never markup',
    '    target.appendChild(doc.createTextNode(String(content)));',
    "    { const t = doc.createElement('template'); t.innerHTML = String(content); target.appendChild(t.content); }"],
  [LIB, 'the factory set is frozen', '  Object.freeze(ui);\n', ''],

  // ===== TABS AND THE OPTION LIST: THE WAI-ARIA PATTERNS =====
  [LIB, 'one tab is the tab stop', '        tab.tabIndex = on ? 0 : -1;', '        tab.tabIndex = 0;'],
  [LIB, 'End jumps to the last item', "      else if (event.key === 'End') next = items.length - 1;\n", ''],
  [LIB, 'Home jumps to the first item', "      else if (event.key === 'Home') next = 0;\n      else if (event.key === 'End') next = items.length - 1;", "      else if (event.key === 'End') next = items.length - 1;"],
  [LIB, 'the arrows wrap', '      if (keys.next.indexOf(event.key) !== -1) next = (index + 1) % items.length;', '      if (keys.next.indexOf(event.key) !== -1) next = Math.min(index + 1, items.length - 1);'],
  [LIB, 'a vertical tablist moves on the vertical arrows',
    "      ? { next: ['ArrowDown'], prev: ['ArrowUp'] }", "      ? { next: ['ArrowRight'], prev: ['ArrowLeft'] }"],
  [LIB, 'a tab panel is shown only for its selected tab',
    '        if (options[i].panel && typeof options[i].panel.nodeType === \'number\') options[i].panel.hidden = !on;\n', ''],
  [LIB, 'Space checks the focused radio',
    "{ next: ['ArrowDown', 'ArrowRight'], prev: ['ArrowUp', 'ArrowLeft'], confirm: ' ' }", "{ next: ['ArrowDown', 'ArrowRight'], prev: ['ArrowUp', 'ArrowLeft'] }"],
  [LIB, 'with nothing checked the first radio is the tab stop',
    '      const stop = current === null ? 0 : options.findIndex((option) => option.value === current);',
    '      const stop = options.findIndex((option) => option.value === current);'],

  // ===== THE REST OF THE ACCESSIBILITY CONTRACT =====
  [LIB, 'the slider announces its formatted value', "      range.setAttribute('aria-valuetext', text);\n", ''],
  [LIB, 'a field marks its control invalid', "      if (has) control.setAttribute('aria-invalid', 'true');", "      if (false) control.setAttribute('aria-invalid', 'true');"],
  [LIB, 'a field describes its control by the error', '      if (has) described.push(error.id);\n', ''],
  [LIB, 'a toggle is a switch', "{ type: 'checkbox', role: 'switch' }", "{ type: 'checkbox' }"],
  [LIB, 'indeterminate is set as the property', '    box.indeterminate = !!o.indeterminate;\n', ''],
  [LIB, 'an interactive card answers Enter and Space', "        if (event.key === 'Enter' || event.key === ' ') {", '        if (false) {'],
  [LIB, 'loading is a status', "    const node = el('div', 'rui-loading', { role: 'status', 'aria-live': 'polite' });", "    const node = el('div', 'rui-loading');"],
  [LIB, 'Escape returns focus to the menu trigger',
    "        event.preventDefault();\n        close(true);\n        return;\n      } else if (event.key === 'Tab') {",
    "        event.preventDefault();\n        close(false);\n        return;\n      } else if (event.key === 'Tab') {"],
  [LIB, "a separator carries role=separator",
    "el('div', 'rui-menu-separator', { role: 'separator' })",
    "el('div', 'rui-menu-separator')"],
  [LIB, "the keys and a choice pass over a separator",
    "    const items = all.filter((item) => !item.separator);",
    "    const items = all.map((item) => (item.separator ? { value: '', label: '' } : item));"],
  [LIB, "a menu needs a real item besides separators",
    "    if (!all.some((item) => !item.separator)) fail('menu', 'items must hold at least one item besides separators');\n",
    ""],
  [GALLERY_CSS('header stands 16px clear of its content'), 'in Chromium, a card header stands clear of its content',
    ".rui-card > .rui-card-sub:not(:last-child), .rui-card > .rui-card-title:not(:last-child):not(:has(+ .rui-card-sub)) { margin-bottom: 16px; }\n", ''],
  [LIB, "card actions share a header row with the title",
    "      if (title) head.appendChild(title);",
    "      if (title) node.insertBefore(title, head);"],
  [LIB, "card actions must be elements",
    "      if (!list.length || list.some((a) => !a || typeof a.nodeType !== 'number')) fail('card', 'actions must be an element or an array of elements');\n",
    ""],
  [GALLERY_CSS('card actions sit at the end of the title line'), "in Chromium, card actions are centred on the title",
    ".rui-card-head { display: flex; align-items: center;",
    ".rui-card-head { display: flex; align-items: flex-start;"],
  [GALLERY_CSS('card actions sit at the end of the title line'), "in Chromium, card actions sit at the end of the title line",
    ".rui-card-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-left: auto; }",
    ".rui-card-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }"],
  [GALLERY_CSS('header stands 16px clear of its content'), "in Chromium, a card header row stands clear of its content",
    ".rui-card > .rui-card-head:not(:last-child):not(:has(+ .rui-card-sub)) { margin-bottom: 16px; }\n",
    ""],
  [LIB, 'a menu choice closes the menu', '      if (items[i].disabled) return;\n      close(true);\n', '      if (items[i].disabled) return;\n'],
  [LIB, 'a press outside closes the menu', "      doc.addEventListener('pointerdown', onOutside, true);\n", ''],
  [LIB, 'a board card moves from its menu', "          if (to !== node.dataset.column) move(node, to, m.querySelector('.rui-menu-btn'));", ''],
  [LIB, 'a board move is said aloud', '      status.textContent = `Moved ${node._rui.name.textContent} to ${columnTitle(to)}`;\n', ''],
  [LIB, 'focus follows a moved card', '        if (again) again.focus();\n', ''],
  [LIB, 'statusOptions narrows where a card may go',
    "      const allowed = Array.isArray(data.statusOptions) ? data.statusOptions.map(String) : columns.map((column) => column.id);",
    '      const allowed = columns.map((column) => column.id);'],
  [LIB, 'a failed canvas offers Retry', "        box.appendChild(button({ label: 'Retry', variant: 'secondary', onClick: () => draw() }));\n", ''],
  [LIB, 'stale time is said in words', "    if (stale) node.appendChild(hiddenText(', stale'));\n", ''],

  // ===== CONTRAST, FROM THE REAL TOKENS =====
  [CSS_CONTRAST, 'the primary button fills with --accent-action, not the brand',
    '.rui-btn-primary { background: var(--accent-action); color: white; }', '.rui-btn-primary { background: var(--accent); color: white; }'],
  [CSS_CONTRAST, 'a measured rule is a measured member (a removed rule is loud)',
    '.rui-card-title { font-size: var(--body); font-weight: 700; margin: 0 0 4px; color: var(--text-1); }\n', ''],
  [CSS_CONTRAST, 'the stale time is readable in light',
    'body.light .rui-time.rui-stale { color: var(--text-1); }\n', ''],
  [CSS_CONTRAST, 'the danger button is an outline, never the fill',
    '.rui-btn-danger { background: var(--elevated); color: var(--danger-text); border: 1px solid var(--danger); }',
    '.rui-btn-danger { background: var(--danger); color: var(--danger-text); border: 1px solid var(--danger); }'],
  [CSS_CONTRAST, 'no solid fill is the brand --accent',
    '.rui-meter-fill { height: 100%; max-width: 100%; border-radius: var(--radius-pill); background: var(--accent-control); }',
    '.rui-meter-fill { height: 100%; max-width: 100%; border-radius: var(--radius-pill); background: var(--accent); }'],
  [CSS_CONTRAST, 'a bare control shape is control orange, not action orange',
    '.rui-toggle:checked { background: var(--accent-control); border-color: var(--accent-control); }',
    '.rui-toggle:checked { background: var(--accent-action); border-color: var(--accent-control); }'],
  [CSS_CONTRAST, 'a fill carrying text is action orange, not control orange',
    '.rui-chip-accent { background: var(--accent-action); color: white; }', '.rui-chip-accent { background: var(--accent-control); color: white; }'],
  [TOKENS, 'control orange clears 3:1 on the light surfaces', '--accent-control: #DB5933;', '--accent-control: #E87A5A;'],
  [CSS_PARITY, 'the send icon button copies the chat send button',
    '.rui-icon-btn-send { width: 42px; height: 42px; background: var(--card);', '.rui-icon-btn-send { width: 40px; height: 42px; background: var(--card);'],
  [LIB, 'an icon button must be named', "    if (!o.label) fail('iconButton', 'label must name the button, which has no visible text');\n", ''],
  [LIB, 'the send button becomes a named stop button', "      node.setAttribute('aria-label', cancel ? labels.cancel : labels.normal);\n", ''],
  [TOKENS, 'white on --accent-action clears 4.5:1', '--accent-action: #C15729;', '--accent-action: #CF6A42;'],

  // ===== ONE SOURCE: THE COPIES HOLD =====
  [CSS_PARITY, 'the input copies the settings input',
    '.rui-input { width: 100%; box-sizing: border-box; background: var(--elevated); border: 1px solid var(--text-3); border-radius: var(--radius-md); padding: 9px 12px;',
    '.rui-input { width: 100%; box-sizing: border-box; background: var(--elevated); border: 1px solid var(--text-3); border-radius: var(--radius-md); padding: 8px 12px;'],
  [CSS_PARITY, 'a copied rule is a member (a removed copy is loud)',
    '.rui-tabs { display: inline-flex; background: var(--base); border: 1px solid var(--border); border-radius: 10px; padding: 4px; gap: 0; }\n', ''],
  [CSS_PARITY, 'every animation stops under reduced motion',
    '  .rui-loading, .rui-canvas-skeleton, .rui-live-dot { animation: none; }', '  .rui-loading, .rui-canvas-skeleton { animation: none; }'],
  [APP_STYLES, 'an app rule that changes is followed by its copy',
    '.mode-toggle { display: flex; background: var(--base);', '.mode-toggle { display: flex; background: var(--surface);'],

  // ===== AN EXTENSION VIEW IS FULL BLEED =====
  [EDITOR_CSS, 'the pane an extension holds has no padding',
    '.editor-content.extension-pane { padding: 0; display: flex; flex-direction: column; }', '.editor-content.extension-pane { display: flex; flex-direction: column; }'],
  [FRAME_CSS, 'the frame paints the pane\'s own colour',
    'min-height: 40px; background: var(--elevated); }', 'min-height: 40px; background: var(--surface); }'],
  [FLOOR_CSS, 'the frame document paints the pane\'s own colour',
    '  padding: 0;\n  background: var(--elevated);', '  padding: 0;\n  background: var(--base);'],
  [FLOOR_CSS, 'the frame document carries the note\'s padding', 'body { padding: 24px 32px; }\n', ''],
  [FLOOR_CSS, 'a view can opt out to an edge-to-edge canvas', 'body.rundock-full-bleed { padding: 0; }\n', ''],
  [FILES_SEAM, 'the seam marks the pane full bleed', "    pane.classList.add('extension-pane');\n", ''],
  [FILES_SEAM, 'the pane gets its padding back when the view goes', "  if (pane) pane.classList.remove('extension-pane');\n", ''],
  [HOST, 'an embedded view is built with Rundock UI',
    '    const ui = rundockUiFrameParts(doc);\n', "    const ui = embedded ? { css: '', script: '', bodyClass: '' } : rundockUiFrameParts(doc);\n"],
  [HOST, 'an embedded view is told so on its body', "    if (embedded) ui.bodyClass = `${ui.bodyClass} rundock-embedded`.trim();\n", ''],


  // ===== REAL-ENGINE GUARDS (a named Chromium test goes red) =====
  [CONFINE('a view that uses the library and then leaves with the file reaches nothing, and the view ends'), 'in Chromium, a mounted view carries Rundock UI',
    '    frame.srcdoc = buildSrcdoc(payload, hostTokenCss(doc), extensionBaseCss(doc), ui, { state: viewState });',
    '    frame.srcdoc = buildSrcdoc(payload, hostTokenCss(doc), extensionBaseCss(doc), undefined, { state: viewState });'],
  [CONFINE('a view that uses the library and then leaves with the file reaches nothing, and the view ends'), 'in Chromium, the library runs before the entry',
    "    + (ui.script ? `<script>${neutraliseClose(ui.script, 'script')}</scr` + 'ipt>' : '')\n    + `<script>${neutraliseClose(payload.entry, 'script')}</scr` + 'ipt>'",
    "    + `<script>${neutraliseClose(payload.entry, 'script')}</scr` + 'ipt>'\n    + (ui.script ? `<script>${neutraliseClose(ui.script, 'script')}</scr` + 'ipt>' : '')"],
  [CONFINE('an embedded view is built with Rundock UI before its entry runs'), 'in Chromium, an embedded view carries Rundock UI',
    '    const ui = rundockUiFrameParts(doc);\n', "    const ui = embedded ? { css: '', script: '', bodyClass: '' } : rundockUiFrameParts(doc);\n"],
  [CONFINE_LIB('a frame working every component posts nothing but ready, and reaches nothing'), 'in Chromium, the library sends no message of its own',
    '  let counter = 0;\n', "  let counter = 0; win.parent.postMessage({ type: 'rundock-ui-extra' }, '*');\n"],
  [CONFINE_FRAME('a library that fails as it installs'), 'in Chromium, a failed install stops the frame before the entry runs',
    'catch (rundockUiFailure) { window.stop(); throw rundockUiFailure; }', 'catch (rundockUiFailure) { throw rundockUiFailure; }'],
  [HOST, 'the host ignores everything a frame says after it has failed',
    '    if (!alive || !frame || event.source !== frame.contentWindow) return;\n', '    if (!event || !event.data) return;\n'],
  [GALLERY_LIB('vertical tabs'), 'in Chromium, a vertical tablist moves on ArrowDown and ArrowUp',
    "      ? { next: ['ArrowDown'], prev: ['ArrowUp'] }", "      ? { next: ['ArrowRight'], prev: ['ArrowLeft'] }"],
  // Space is not a real-engine row: a radio is a native button, so the
  // browser's own Space click checks it with or without the key handler,
  // which the unit row proves in isolation. Wrapping is what only the
  // handler does, so that is the row that runs in Chromium.
  [GALLERY_LIB('option list: arrows'), 'in Chromium, the option list wraps',
    '      if (keys.next.indexOf(event.key) !== -1) next = (index + 1) % items.length;', '      if (keys.next.indexOf(event.key) !== -1) next = Math.min(index + 1, items.length - 1);'],
  [GALLERY_LIB('menu: opens from the keyboard'), 'in Chromium, Escape returns focus to the menu trigger',
    "        event.preventDefault();\n        close(true);\n        return;\n      } else if (event.key === 'Tab') {",
    "        event.preventDefault();\n        close(false);\n        return;\n      } else if (event.key === 'Tab') {"],
  [GALLERY_LIB('board: a card moves'), 'in Chromium, focus follows a moved card', '        if (again) again.focus();\n', ''],
  [GALLERY_LIB('slider: the arrows move it'), 'in Chromium, the slider announces its formatted value', "      range.setAttribute('aria-valuetext', text);\n", ''],
  [GALLERY_CSS('a chip label is centred on its ink'), 'in Chromium, the chip label is trimmed to its ink',
    '@supports (text-box: trim-both cap alphabetic) {\n  .rui-chip-label { line-height: normal; text-box: trim-both cap alphabetic; }\n}\n', ''],
  [GALLERY_CSS('without text-box, the fallback'), 'in Chromium, the chip keeps its line-height fallback',
    '.rui-chip-label { line-height: 1; }\n', '.rui-chip-label { line-height: 2; }\n'],
  [GALLERY_CSS('without text-box, the fallback'), 'in Chromium, the chip has a line-height fallback at all',
    '.rui-chip-label { line-height: 1; }\n', ''],
  [BLEED(['views', 'editor.css'], THE_PANE), 'in Chromium, the pane an extension holds has no padding',
    '.editor-content.extension-pane { padding: 0; display: flex; flex-direction: column; }', '.editor-content.extension-pane { display: flex; flex-direction: column; }'],
  [BLEED(['extension-base.css'], THE_PANE), 'in Chromium, the frame document paints the pane\'s own colour',
    '  padding: 0;\n  background: var(--elevated);', '  padding: 0;\n  background: var(--base);'],
  [BLEED(['extension-base.css'], THE_PANE), 'in Chromium, the view\'s first line starts where a note\'s does', 'body { padding: 24px 32px; }\n', 'body { padding: 24px 40px; }\n'],
  [BLEED(['extension-base.css'], 'a view can opt out to an edge-to-edge canvas'), 'in Chromium, a view can opt out to an edge-to-edge canvas', 'body.rundock-full-bleed { padding: 0; }\n', ''],
  [BLEED(['components', 'embed.css'], "an embedded view paints its panel's surface"), 'in Chromium, an embedded view paints its panel\'s surface',
    '.embed-body > .extension-frame { width: 100%; background: var(--surface); }', '.embed-body > .extension-frame { width: 100%; background: var(--card); }'],

  // ===== EVERY FORBIDDEN PRIMITIVE THE SOURCE SCAN REFUSES =====
  [LIB, 'the source scan refuses postMessage', '  let counter = 0;\n', "  let counter = 0; if (win.__never) { win.postMessage(1, '*'); }\n"],
  [LIB, 'the source scan refuses the parent', '  let counter = 0;\n', "  let counter = 0; if (win.__never) { win.parent.focus(); }\n"],
  [LIB, 'the source scan refuses window.top', '  let counter = 0;\n', "  let counter = 0; if (win.__never) { win.top.focus(); }\n"],
  [LIB, 'the source scan refuses the opener', '  let counter = 0;\n', "  let counter = 0; if (win.__never) { win.opener.focus(); }\n"],
  [LIB, 'the source scan refuses fetch', '  let counter = 0;\n', "  let counter = 0; if (win.__never) { fetch('x'); }\n"],
  [LIB, 'the source scan refuses XMLHttpRequest', '  let counter = 0;\n', "  let counter = 0; if (win.__never) { new win.XMLHttpRequest(); }\n"],
  [LIB, 'the source scan refuses WebSocket', '  let counter = 0;\n', "  let counter = 0; if (win.__never) { new win.WebSocket('ws://x'); }\n"],
  [LIB, 'the source scan refuses EventSource', '  let counter = 0;\n', "  let counter = 0; if (win.__never) { new win.EventSource('x'); }\n"],
  [LIB, 'the source scan refuses eval', '  let counter = 0;\n', "  let counter = 0; if (win.__never) { eval('1'); }\n"],
  [LIB, 'the source scan refuses Function', '  let counter = 0;\n', "  let counter = 0; if (win.__never) { Function('return 1')(); }\n"],
  [LIB, 'the source scan refuses innerHTML', '  let counter = 0;\n', "  let counter = 0; if (win.__never) { doc.body.innerHTML = ''; }\n"],
  [LIB, 'the source scan refuses outerHTML', '  let counter = 0;\n', "  let counter = 0; if (win.__never) { doc.body.outerHTML; }\n"],
  [LIB, 'the source scan refuses insertAdjacentHTML', '  let counter = 0;\n', "  let counter = 0; if (win.__never) { doc.body.insertAdjacentHTML('beforeend', ''); }\n"],
  [LIB, 'the source scan refuses dynamic import', '  let counter = 0;\n', "  let counter = 0; if (win.__never) { import('x'); }\n"],
  [LIB, 'the source scan refuses localStorage', '  let counter = 0;\n', "  let counter = 0; if (win.__never) { win.localStorage.clear(); }\n"],
  [LIB, 'the source scan refuses sessionStorage', '  let counter = 0;\n', "  let counter = 0; if (win.__never) { win.sessionStorage.clear(); }\n"],
  [LIB, 'the source scan refuses cookies', '  let counter = 0;\n', "  let counter = 0; if (win.__never) { doc.cookie; }\n"],
  [LIB, 'the source scan refuses a loaded source', '  let counter = 0;\n', "  let counter = 0; if (win.__never) { doc.createElement('img').src = 'x'; }\n"],
  [LIB, 'the source scan refuses a location', '  let counter = 0;\n', "  let counter = 0; if (win.__never) { win.location.href = 'x'; }\n"],

  // ===== THE REST OF THE GUARDED CRITERIA =====
  [LIB, 'every factory is in the set', '    button, iconButton, card,', '    button, card,'],
  [TOKENS, 'the accepted dark exception is pinned where it was accepted',
    '  --accent-control: var(--accent); --accent-control-hover: var(--accent-hover);', '  --accent-control: var(--accent-hover); --accent-control-hover: var(--accent-hover);'],
  [APP_DANGER, 'the app\'s resting destructive button is an outline over --elevated',
    '.settings-btn.danger { background: var(--elevated);', '.settings-btn.danger { background: var(--card);'],
  [UI_DRIFT, 'a literal in the component stylesheet is refused unless allowlisted', '.rui-visually-hidden {\n', '.rui-drift { color: #123456; }\n.rui-visually-hidden {\n'],
  [VERSION_AGREE, 'the server and the library agree on the version', "const RUNDOCK_UI_VERSION = '1.0';", "const RUNDOCK_UI_VERSION = '1.9';"],

  // ===== THE CORRECTED GEOMETRY, IN PIXELS =====
  [TICK, 'the checkbox tick is centred in its box',
    'background-position: center; background-size: 12px 12px;', 'background-position: left top; background-size: 12px 12px;'],
  [THUMB, 'the slider thumb sits on the track centre (margin-top -6px)',
    'cursor: pointer; margin-top: -6px; }', 'cursor: pointer; margin-top: -3px; }'],
  [THUMB, 'the slider track is the 4px line the thumb is centred on',
    '.rui-slider::-webkit-slider-runnable-track { height: 4px;', '.rui-slider::-webkit-slider-runnable-track { height: 10px;'],
  [LIB, 'the library source never reads the bare global top', '  let counter = 0;\n', '  let counter = 0; if (win.__never) top.focus();\n'],

  // ===== THE VERSION RULE =====
  [VERSION, 'a newer minor is refused', '  if (want.minor > have.minor) {', '  if (false) {'],
  [VERSION, 'another major is refused', '  if (want.major !== have.major) {', '  if (false) {'],
  [MANIFEST, 'the manifest reads rundockUi exactly as declared, never trimmed',
    '    const verdict = rundockUiCompatible(extension.rundockUi);\n', '    const verdict = rundockUiCompatible(extension.rundockUi.trim());\n'],
  [MANIFEST, 'the manifest holds rundockUi to the rule', "    if (!verdict.ok) refuse(verdict.reason, 'rundock-ui-incompatible');\n", ''],

  // ===== THE MODE TOGGLE IS A TABLIST =====
  [SETTINGS, 'the mode toggle carries the tablist role',
    '<div class="mode-toggle" role="tablist" aria-label="What are you working on?" onkeydown="modeToggleKeydown(event)">',
    '<div class="mode-toggle" onkeydown="modeToggleKeydown(event)">'],
  [SETTINGS, 'the mode toggle roves its tab stop', '    tab.tabIndex = on ? 0 : -1;\n    tab.classList.toggle(\'active\', on);', "    tab.classList.toggle('active', on);"],
  [SETTINGS, 'focus survives the re-render', '  if (tab) tab.focus();\n}', '}'],

  // ===== THE TABLE: FIXED WIDTHS AND EDITABLE CELLS =====
  [LIB, 'a column width fixes the layout', "      node.classList.add('rui-table-fixed');\n", ''],
  [LIB, 'each width reaches its col', '        if (column.width) col.style.width = column.width;\n', ''],
  [LIB, 'a table without widths draws no colgroup',
    '    if (columns.some((column) => column.width)) {', '    if (true) {'],
  [LIB, 'a width must be a length',
    "    if (typeof value === 'string' && WIDTH.test(value) && parseFloat(value) > 0) return value;",
    "    if (typeof value === 'string') return value;"],
  [LIB, 'a column takes render or format, not both', "      if (render && format) fail('table', 'a column takes render or format, not both');\n", ''],
  [LIB, "with no onEdit no cell is editable",
    "const editable = !!onEdit && (!column.edit.when || !!column.edit.when(row));",
    "const editable = (!column.edit.when || !!column.edit.when(row));"],
  [LIB, "the table never writes the row",
    "          value = next;\n          say('', editor);",
    "          value = next;\n          row[column.key] = next;\n          say('', editor);"],
  [LIB, "when(row) turns editing off for its row",
    "const editable = !!onEdit && (!column.edit.when || !!column.edit.when(row));",
    "const editable = !!onEdit;"],
  [LIB, "an editable column draws with format, not render",
    "    if (render) fail('table', 'an editable column draws with format, not render');\n",
    ""],
  [LIB, "an editable cell is named by its column, row and value",
    "        display.setAttribute('aria-label', `${name}, ${display.textContent}`);\n",
    ""],
  [LIB, "the editor is named by its column and row",
    "{ type: 'text', inputmode: type === 'number' ? 'decimal' : null, 'aria-label': name }",
    "{ type: 'text', inputmode: type === 'number' ? 'decimal' : null }"],
  [LIB, "edit.label names the row",
    "${column.edit.label ? String(column.edit.label(row)) : textOf(",
    "${false ? '' : textOf("],
  // Guarded in the unit suite only: in a real engine the stylesheet also
  // hides the covered display (visibility: hidden), which already removes it
  // from the tab order, so no browser test can see this line alone. The
  // gallery's Tab walk still proves the behaviour end to end.
  [LIB, "the covered cell leaves the tab order",
    "        display.tabIndex = -1;\n",
    ""],
  [GALLERY_LIB('Tab alone, from before the table'), "in Chromium, every editable cell is reached by Tab alone",
    "      const display = td.appendChild(el('button', 'rui-cell', { type: 'button' }));",
    "      const display = td.appendChild(el('button', 'rui-cell', { type: 'button', tabindex: '-1' }));"],
  [GALLERY_LIB('Tab alone, from before the table'), "in Chromium, a cell reached by Tab is named by its column, row and value",
    "        display.setAttribute('aria-label', `${name}, ${display.textContent}`);",
    "        display.setAttribute('aria-label', display.textContent);"],
  [LIB, "a closed cell is a tab stop again",
    "        display.removeAttribute('tabindex');\n",
    ""],
  [LIB, "a click opens the editor",
    "      display.addEventListener('click', open);\n",
    ""],
  [LIB, "F2 opens the editor",
    "        if (event.key !== 'Enter' && event.key !== 'F2') return;",
    "        if (event.key !== 'Enter') return;"],
  [LIB, "Enter on the cell opens the editor",
    "        if (event.key !== 'Enter' && event.key !== 'F2') return;",
    "        if (event.key !== 'F2') return;"],
  [LIB, "Enter commits",
    "{ Enter: 'enter', Escape: 'escape', Tab: event.shiftKey ? 'back' : 'next' }",
    "{ Escape: 'escape', Tab: event.shiftKey ? 'back' : 'next' }"],
  [LIB, "Escape returns focus to the cell",
    "        say('', editor);\n        return close(true);",
    "        say('', editor);\n        return close(false);"],
  [LIB, "Tab opens the next editable cell",
    "const next = here && (via === 'next' || via === 'back') ?",
    "const next = false ?"],
  [LIB, "Shift+Tab opens the one before",
    "cells[cells.indexOf(cell) + (via === 'next' ? 1 : -1)]",
    "cells[cells.indexOf(cell) + 1]"],
  [LIB, "at either end focus rests on the cell",
    "        close(here && !next);",
    "        close(false);"],
  [LIB, "only true accepts",
    "const verdict = (answer) => (answer === true || (typeof answer === 'string' && answer) ? answer : 'This change was not saved.');",
    "const verdict = (answer) => (typeof answer === 'string' && answer ? answer : true);"],
  [LIB, "a number opens as the cell shows it",
    "      const opening = () => (type === 'number' && parse(display.textContent) === value ? display.textContent : current());",
    "      const opening = () => current();"],
  [LIB, "a refusal reverts the value",
    "        if (revert) editor.value = opening();\n",
    ""],
  [LIB, "a refusal keeps the editor and its focus",
    "        if (doc.activeElement !== editor) {\n          close(false);",
    "        if (true) {\n          close(false);"],
  [LIB, "a refusal is said inline",
    "          message.textContent = `${textOf(column.label)}: ${text}`;\n",
    ""],
  [LIB, "the refusal is an alert",
    "{ id: nextId('cell-message'), role: 'alert' }",
    "{ id: nextId('cell-message') }"],
  [LIB, "the refusal describes its control",
    "        if (shown) control.setAttribute('aria-describedby', message.id);",
    "        if (false) control.setAttribute('aria-describedby', message.id);"],
  [LIB, "a refused control is marked invalid",
    "        if (shown) control.setAttribute('aria-invalid', 'true');",
    "        if (false) control.setAttribute('aria-invalid', 'true');"],
  [LIB, "a throw is a refusal",
    "      try { result = onEdit(change); } catch (error) { result = null; }",
    "      result = onEdit(change);"],
  [LIB, "a promise holds the cell",
    "      hold(true);\n      return result.then",
    "      return result.then"],
  [LIB, "a held cell ignores Enter and Escape",
    "        if (held) return;\n        if (via !== 'escape')",
    "        if (via !== 'escape')"],
  [LIB, "a held editor is read-only",
    "        if (editor && type !== 'select') editor.readOnly = on;\n",
    ""],
  // A held select keeps focus (aria-disabled, not disabled) but takes no
  // change: say so, refuse the keys and the press that open or move it, put
  // back a change that gets through, and free it once settled.
  [LIB, "a held select says it is held",
    "          if (on) editor.setAttribute('aria-disabled', 'true');",
    "          if (false) editor.setAttribute('aria-disabled', 'true');"],
  [LIB, "a settled select is free again",
    "          else editor.removeAttribute('aria-disabled');",
    "          else {}"],
  [LIB, "a held select takes no key",
    "          if (held && type === 'select') event.preventDefault();\n",
    ""],
  [LIB, "a held select cannot be opened",
    "          editor.addEventListener('mousedown', (event) => { if (held) event.preventDefault(); });\n",
    ""],
  [LIB, "a held select puts back a change that gets through",
    "            if (held) editor.value = heldAt;\n            else commit('enter');",
    "            if (!held) commit('enter');"],
  // Trap Tab in a held cell and keyboard focus cannot leave until the save
  // settles.
  [LIB, "a held cell never traps Tab",
    "        if (held && (via === 'next' || via === 'back')) return;\n",
    ""],
  // Forget a resize that came under an open editor, or never act on it, and
  // the table keeps the stale widths once the editor closes.
  [LIB, "a resize under an open editor is remembered",
    "        stale = true;\n",
    ""],
  [LIB, "widths are shared again once an editor closes",
    "        if (focus) display.focus();\n        refit();\n",
    "        if (focus) display.focus();\n"],
  // Resizing writes nothing handed in: a write to either is caught.
  [LIB, "resizing writes nothing to the columns handed in",
    "    const report = (i) => {\n      const width = ",
    "    const report = (i) => {\n      o.columns[i].width = override[i];\n      const width = "],
  [LIB, "resizing writes nothing to the rows handed in",
    "      override[i] = Math.max(minimum[i], Math.round(px));",
    "      override[i] = Math.max(minimum[i], Math.round(px)); if (rows[0]) rows[0][columns[i].key] = px;"],
  [LIB, "a held cell is busy",
    "      if (on) td.setAttribute('aria-busy', 'true');",
    "      if (false) td.setAttribute('aria-busy', 'true');"],
  [LIB, "a failed promise is a refusal",
    "() => { hold(false); settle(verdict(null)); });",
    "() => { hold(false); });"],
  [LIB, "only a plain decimal is a number",
    "      const parse = (typed) => (/^-?(\\d+\\.?\\d*|\\.\\d+)$/.test(typed.replace(/,/g, '')) ? Number(typed.replace(/,/g, '')) : NaN);",
    "      const parse = (typed) => Number(typed.replace(/,/g, ''));"],
  [LIB, "min is enforced",
    "(min !== null && next < min) || ",
    ""],
  [LIB, "max is enforced",
    " || (max !== null && next > max))",
    ")"],
  [LIB, "an unchanged value asks nothing",
    "        if (String(next) === current()) {",
    "        if (false) {"],
  [LIB, "a select commits on change",
    "            else commit('enter');\n",
    ""],
  [LIB, "a select shows its option label",
    "      return option ? option.label : value;",
    "      return value;"],
  [LIB, "a checkbox asks on its first activation",
    "      box.addEventListener('change', () => {\n        if (pending !== null) {",
    "      box.addEventListener('change', () => {\n        if (!box.dataset.armed) { box.dataset.armed = '1'; box.checked = value; return; }\n        if (pending !== null) {"],
  [LIB, "a refused checkbox unticks",
    "          box.checked = value;\n          say(verdict",
    "          say(verdict"],
  [LIB, "a held checkbox ignores a second click",
    "        if (pending !== null) {\n          box.checked = pending;\n          return;\n        }\n",
    ""],
  [LIB, "a held checkbox keeps focus",
    "          if (on) box.setAttribute('aria-disabled', 'true');",
    "          if (on) box.disabled = true;"],
  [LIB, "a read-only checkbox is disabled",
    "      box.disabled = !editable;\n",
    ""],
  [GALLERY_CSS("widths hold, overlong text ends in an ellipsis"), "in Chromium, the editor is laid over its cell",
    ".rui-table .rui-cell-editor { position: absolute; top: 50%; left: 0; right: 0; transform: translateY(-50%); width: auto; height: auto; margin: 0; }",
    ".rui-table .rui-cell-editor { margin: 0; }"],
  [GALLERY_CSS("widths hold, overlong text ends in an ellipsis"), "in Chromium, the covered button keeps its size",
    ".rui-td-edit.rui-editing > .rui-cell { visibility: hidden; }",
    ".rui-td-edit.rui-editing > .rui-cell { display: none; }"],
  [GALLERY_CSS("widths hold, overlong text ends in an ellipsis"), "in Chromium, the editor is placed in its own cell",
    ".rui-table td.rui-td-edit { padding: 0; position: relative; }",
    ".rui-table td.rui-td-edit { padding: 0; }"],
  [GALLERY_CSS("widths hold, overlong text ends in an ellipsis"), "in Chromium, a fixed table holds its widths",
    ".rui-table-fixed { table-layout: fixed; }\n",
    ""],
  [GALLERY_CSS("widths hold, overlong text ends in an ellipsis"), "in Chromium, overlong text ends in an ellipsis",
    ".rui-table-fixed th, .rui-table-fixed td { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n",
    ""],
  [GALLERY_CSS("treatment A: the active cell keeps the raised surface"), "in Chromium, a refusal is seen on its own line under the row",
    ".rui-table tbody tr.rui-table-message-row td, body.light .rui-table tbody tr.rui-table-message-row td { background: var(--card); }\n",
    ".rui-table tbody tr.rui-table-message-row td, body.light .rui-table tbody tr.rui-table-message-row td { background: var(--card); }\n.rui-table-message-row { display: none; }\n"],
  [GALLERY_LIB("a row menu in a fixed-width column opens whole"), "in Chromium, an open menu is placed against the viewport",
    "      list.style.position = 'fixed';\n",
    ""],
  [GALLERY_CSS("rows are square: no cell of a hovered row is rounded"), "in Chromium, a rounded row corner is caught (the mock's first-cell radius)",
    ".rui-table th, .rui-table td { border-radius: 0; }",
    ".rui-table th, .rui-table td { border-radius: 0; }\n.rui-table td:first-child { border-top-left-radius: var(--radius-lg); }"],
  [GALLERY_CSS("the text does not move when an editor opens"), "in Chromium, the editor takes the cell's padding",
    "height: auto; margin: 0; padding: 9px 12px; border: 0;",
    "height: auto; margin: 0; padding: 0 11px; border: 0;"],
  [GALLERY_CSS("the text does not move when an editor opens"), "in Chromium, the editor is centred in the cell as the button is",
    "position: absolute; top: 50%; left: 0; right: 0; transform: translateY(-50%);",
    "position: absolute; top: 0; left: 0; right: 0;"],
  [GALLERY_CSS("treatment A: the active cell keeps the raised surface"), "in Chromium, the cell being edited keeps the raised surface",
    ".rui-table td.rui-td-edit.rui-editing { background: var(--border); box-shadow:",
    ".rui-table td.rui-td-edit.rui-editing { box-shadow:"],
  [GALLERY_CSS("treatment A: the active cell keeps the raised surface"), "in Chromium, editing draws a 2px accent ring on the cell edge",
    "box-shadow: inset 0 0 0 2px var(--accent-text); }",
    "box-shadow: inset 0 0 0 1px var(--accent-text); }"],
  [GALLERY_CSS("treatment A: the active cell keeps the raised surface"), "in Chromium, a refused cell draws a danger ring",
    ".rui-table td.rui-td-edit.rui-editing:has([aria-invalid=\"true\"]) { box-shadow: inset 0 0 0 2px var(--danger-text); }\n",
    ""],
  [GALLERY_CSS("treatment A: the active cell keeps the raised surface"), "in Chromium, keyboard focus draws a 1px neutral ring on a raised cell",
    "{ background: var(--border); box-shadow: inset 0 0 0 1px var(--text-2); }",
    "{ outline: 2px solid var(--accent); }"],
  [GALLERY_CSS("treatment A: the active cell keeps the raised surface"), "in Chromium, the editor has no border and no radius",
    "padding: 9px 12px; border: 0; border-radius: 0; background: transparent; box-shadow: none;",
    "padding: 9px 12px; background: transparent; box-shadow: none;"],
  [GALLERY_CSS("treatment A: the active cell keeps the raised surface"), "in Chromium, a hovered editable cell takes its own tint",
    ".rui-cell:hover, .rui-cell.rui-force-hover { background: var(--surface); }\n",
    ""],
  [GALLERY_LIB("one row menu per row, and no pencil anywhere"), "in Chromium, an editable cell draws no pencil or second trigger",
    "        append(display, show(column, value, row));",
    "        append(display, [show(column, value, row), icon('more')]);"],
  [GALLERY_CSS("one row menu per row, and no pencil anywhere"), "in Chromium, a row-menu cell draws no ellipsis beside its trigger",
    ".rui-table-fixed td:has(> .rui-menu) { overflow: visible; }\n",
    ""],
  [LIB, "a refusal gets a line directly under its row",
    "          if (!line.parentNode) td.parentNode.parentNode.insertBefore(line, td.parentNode.nextSibling);",
    "          if (!line.parentNode) td.parentNode.parentNode.appendChild(line);"],
  [LIB, "the refusal line spans the table",
    "          line.firstChild.colSpan = head.children.length;\n",
    ""],
  [LIB, "the refusal line goes when cleared",
    "        } else if (text !== undefined) line.remove();",
    "        }"],
  [LIB, "a held save says Saving",
    "        busy(td, on);\n        saving(on);",
    "        busy(td, on);"],
  [LIB, "Saving is said politely, from a region there from the start",
    "el('span', 'rui-cell-saving', { role: 'status' })",
    "el('span', 'rui-cell-saving')"],
  [CSS_CONTRAST, "the light editing ring clears 3:1 against the separator",
    "box-shadow: inset 0 0 0 2px var(--accent-text); }",
    "box-shadow: inset 0 0 0 2px var(--accent-control); }"],
  [CSS_CONTRAST, "the dark active cell is lighter than the table",
    ".rui-table td.rui-td-edit.rui-editing { background: var(--border);",
    ".rui-table td.rui-td-edit.rui-editing { background: var(--elevated);"],
  [CSS_CONTRAST, "the dark invalid ring clears 3:1 against the active cell",
    "box-shadow: inset 0 0 0 2px var(--danger-text); }",
    "box-shadow: inset 0 0 0 2px var(--danger); }"],
  [GALLERY_CSS("treatment A: the active cell keeps the raised surface"), "in Chromium, the light row hover is quieter than the active cell",
    "body.light .rui-table tr.rui-force-hover td { background: var(--base); }",
    "body.light .rui-table tr.rui-force-hover td { background: var(--elevated); }"],
  [GALLERY_LIB('the widest text column is the main column'), "in Chromium, a table measures its columns once it is laid out",
    "        win.requestAnimationFrame(fit);\n",
    ""],
  [GALLERY_LIB('the widest text column is the main column'), "in Chromium, a column's widest sample is measured with its cells",
    "      const most = Math.max(0, ...columns.map((column) => column.widest.length));",
    "      const most = 0;"],
  [GALLERY_CSS('a table narrower than its columns keeps them'), "in Chromium, natural widths are measured on one line",
    ".rui-table.rui-table-measuring th, .rui-table.rui-table-measuring td { white-space: nowrap; }\n",
    ""],
  [GALLERY_CSS('a table narrower than its columns keeps them'), "in Chromium, a table too wide for its wrapper scrolls inside it",
    "overflow-x: auto; overflow-y: hidden; width: 100%; box-sizing: border-box; position: relative; }",
    "overflow: hidden; width: 100%; box-sizing: border-box; position: relative; }"],
  [GALLERY_LIB('widths never move while a cell is being edited'), "in Chromium, widths are never shared again under an open editor",
    "      if (node.querySelector('.rui-editing')) {\n        stale = true;\n        return;\n      }\n",
    ""],
  [GALLERY_LIB('widths never move while a cell is being edited'), "in Chromium, widths are shared again once an editor closes",
    "        if (focus) display.focus();\n        refit();\n",
    "        if (focus) display.focus();\n"],
  [GALLERY_LIB('widths never move while a cell is being edited'), "in Chromium, a locked table is set in pixels, not reflowed by its container",
    "      node.style.width = `${now.reduce((sum, w) => sum + w, 0) + (fill > 0.5 ? fill : 0)}px`;",
    "      node.style.width = '';"],
  [GALLERY_LIB('widths hold, overlong text ends in an ellipsis'), "in Chromium, explicit widths are read unstretched",
    "      node.style.width = '1px';\n",
    ""],
  [LIB, "minWidth must be a number of pixels",
    "    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail('table', 'minWidth must be a number of pixels');\n",
    ""],
  [LIB, "widest must be text or elements",
    "    for (const item of list) if (typeof item !== 'string' && !(item && typeof item.nodeType === 'number')) fail('table', 'widest must be text or an element, or an array of them');\n",
    ""],
  [GALLERY_LIB('the widest text column is the main column'), "in Chromium, longer text is capped at 280px",
    "    const CAP = 280;",
    "    const CAP = 2800;"],
  [GALLERY_LIB('resizing beside a grow column'), "in Chromium, grow: true names the grow column",
    "      grow = columns.findIndex((column) => column.grow && !column.width);",
    "      grow = -1;"],
  [GALLERY_LIB('resizing beside a grow column'), "in Chromium, the grow column takes the room, past its cap if need be",
    "        if (growing !== -1) now[growing] += room;\n",
    "        if (growing !== -1) now[growing] += 0;\n"],
  [GALLERY_LIB('the widest text column is the main column'), "in Chromium, a cut-off value keeps its whole text in the title",
    "          if (target.scrollWidth > target.clientWidth + 1) target.title = (target.innerText || '').trim();",
    "          if (false) target.title = (target.innerText || '').trim();"],
  [GALLERY_LIB('the widest text column is the main column'), "in Chromium, no column is capped below its header",
    "      base = natural.map((w, i) => (long[i] ? Math.max(header[i], Math.min(w, CAP)) : w));",
    "      base = natural.map((w, i) => (long[i] ? Math.min(w, CAP) : w));"],
  [LIB, "grow must be true or false",
    "(typeof column.grow === 'boolean' ? column.grow : fail('table', 'grow must be true or false'))",
    "column.grow"],
  [GALLERY_CSS('a table narrower than its columns keeps them'), "in Chromium, nothing a table positions escapes its scroller",
    "box-sizing: border-box; position: relative; }",
    "box-sizing: border-box; }"],
  [GALLERY_LIB('when no column qualifies, an empty filler takes the rest'), "in Chromium, the filler is hidden from assistive technology",
    "        head.appendChild(el('th', 'rui-table-filler', { 'aria-hidden': 'true' }));",
    "        head.appendChild(el('th', 'rui-table-filler'));"],
  [LIB, "a resizable column carries a handle",
    "      if (column.resizable === undefined ? resizable : column.resizable) {",
    "      if (false) {"],
  [LIB, "a column can opt out of resizing",
    "      if (column.resizable === undefined ? resizable : column.resizable) {",
    "      if (resizable || column.resizable) {"],
  [LIB, "a resize handle is a vertical separator",
    "          role: 'separator', 'aria-orientation': 'vertical', tabindex: '0',",
    "          'aria-orientation': 'vertical', tabindex: '0',"],
  [LIB, "resizable must be true or false",
    "    const resizableOf = (value) => (value === undefined ? undefined : (typeof value === 'boolean' ? value : fail('table', 'resizable must be true or false')));",
    "    const resizableOf = (value) => value;"],
  [GALLERY_LIB('a drag fixes that column at its new width'), "in Chromium, a drag resizes the column",
    "      handle.addEventListener('pointermove', (event) => { if (start) resizeTo(i, start.width + event.clientX - start.x); });\n",
    ""],
  [GALLERY_LIB('a drag fixes that column at its new width'), "in Chromium, a resize handle says its width",
    "        handle.setAttribute('aria-valuenow', String(Math.round(now[i])));\n",
    ""],
  [GALLERY_CSS('a drag fixes that column at its new width'), "in Chromium, a handle sits on its own header's edge",
    ".rui-table th.rui-th-resizable { position: relative; }\n",
    ""],
  [GALLERY_LIB('the keyboard: arrows step 8px'), "in Chromium, Shift steps 32px",
    "          const step = event.shiftKey ? 32 : 8;",
    "          const step = 8;"],
  [GALLERY_LIB('the keyboard: arrows step 8px'), "in Chromium, a column never resizes below its floor",
    "      override[i] = Math.max(minimum[i], Math.round(px));",
    "      override[i] = Math.round(px);"],
  [GALLERY_LIB('the keyboard: arrows step 8px'), "in Chromium, the floor is the header, not only minWidth",
    "      minimum = header.map((w, i) => Math.max(w, columns[i].minWidth));",
    "      minimum = header.map((w, i) => columns[i].minWidth);"],
  [GALLERY_LIB('the keyboard: arrows step 8px'), "in Chromium, the handle is not part of the header's width",
    "(child.classList.contains('rui-visually-hidden') || child.classList.contains('rui-col-resize'))",
    "child.classList.contains('rui-visually-hidden')"],
  [GALLERY_LIB('the keyboard: arrows step 8px'), "in Chromium, a reset returns the column to the rule",
    "      override[i] = 'auto';\n",
    "      override[i] = undefined;\n"],
  [GALLERY_LIB('the keyboard: arrows step 8px'), "in Chromium, Enter on a handle resets its column",
    "        } else if (event.key === 'Enter') {",
    "        } else if (event.key === 'Home') {"],
  [GALLERY_LIB('the keyboard: arrows step 8px'), "in Chromium, a double-click resets its column",
    "      handle.addEventListener('dblclick', (event) => { event.preventDefault(); reset(i); });\n",
    ""],
  [GALLERY_LIB('the keyboard: arrows step 8px'), "in Chromium, a reset is reported as a null width",
    "      const width = override[i] === 'auto' ? null : override[i];",
    "      const width = override[i];"],
  [GALLERY_LIB('the keyboard: arrows step 8px'), "in Chromium, measuring sets explicit widths aside",
    "      if (group) for (const col of group.children) col.style.width = '';\n",
    ""],
  [LIB, "a table with nothing laid out still resizes from the keys",
    "const box = typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null;",
    "const box = range.getBoundingClientRect();"],
  [GALLERY_LIB('a sparse table: the text column takes the room'), "in Chromium, the main column takes the spare room, and no other column is scaled",
    "        if (growing !== -1) now[growing] += room;\n        else fill = room;\n",
    "        if (growing !== -1 && columns[growing].grow) now[growing] += room;\n        else if (flex > 0) {\n          const factor = Math.min(1.5, (available - held) / flex);\n          scalable.forEach((on, i) => { if (on) now[i] *= factor; });\n          fill = available - held - flex * factor;\n        } else fill = room;\n"],
  [GALLERY_LIB('when no column qualifies, an empty filler takes the rest'), "in Chromium, with no main column the rest goes to the filler",
    "      if (fill > 0.5 || fillerCol) filler(cols, fill > 0.5 ? fill : 0);\n",
    ""],
  [LIB, "a control is never the main column",
    "(!column.width && !control[i] && ",
    "(!column.width && "],
  [LIB, "a column with an explicit width is never the main column",
    "(!column.width && !control[i]",
    "(!control[i]"],
  [GALLERY_LIB('the keyboard: arrows step 8px'), "in Chromium, an explicit or saved width holds",
    "resized[i] === null && !!column.width && override[i] !== 'auto');",
    "resized[i] === null && false && override[i] !== 'auto');"],
  [GALLERY_LIB('a drag fixes that column at its new width'), "in Chromium, a resized column is fixed at its new width",
    "const scalable = columns.map((column, i) => resized[i] === null && !explicit[i] && !control[i]);",
    "const scalable = columns.map((column, i) => !explicit[i] && !control[i]);"],
  [GALLERY_LIB('a drag fixes that column at its new width'), "in Chromium, the unfixed columns rescale after a resize",
    "      override[i] = Math.max(minimum[i], Math.round(px));\n      share(wrap.clientWidth);",
    "      override[i] = Math.max(minimum[i], Math.round(px));\n      node.querySelector(':scope > colgroup').children[i].style.width = `${override[i]}px`;"],
  [GALLERY_LIB('when no column qualifies, an empty filler takes the rest'), "in Chromium, a column with no text in its cells is a control",
    "|| (rows.length ? !rows.some((tr) => tr.children[i] && (tr.children[i].innerText || '').trim() !== '') : header[i] <= 0));",
    "|| false);"],
  // The main column: with no grow column, the widest text column that is
  // not fixed takes all the spare room, and the filler only what is left
  // when there is none. Stood in widths in jsdom (the unit suite).
  [LIB, "the main column is the widest text column, not the narrowest",
    "&& (best === -1 || natural[i] > natural[best]) ? i : best), -1);",
    "&& (best === -1 || natural[i] < natural[best]) ? i : best), -1);"],
  [LIB, "a numeric column is never the main column",
    " && !column.numeric && column.align === 'left'\n          && (best",
    "\n          && (best"],
  [LIB, "the main column takes the spare room, and no other column is scaled",
    "        if (growing !== -1) now[growing] += room;\n        else fill = room;\n",
    "        if (growing !== -1 && columns[growing].grow) now[growing] += room;\n        else if (flex > 0) {\n          const factor = Math.min(1.5, (available - held) / flex);\n          scalable.forEach((on, i) => { if (on) now[i] *= factor; });\n          fill = available - held - flex * factor;\n        } else fill = room;\n"],
  [LIB, "while a main column can take the room, the filler takes none",
    "        const growing = grow !== -1 && scalable[grow] ? grow : -1;",
    "        const growing = grow !== -1 && scalable[grow] && columns[grow].grow ? grow : -1;"],
  [GALLERY_LIB("clicking away commits, and focus stays where the click went"), "in Chromium, focus that has left is never pulled back",
    "        const here = doc.activeElement === editor;",
    "        const here = !!editor;"],
  [GALLERY_LIB("the keyboard: Enter opens and commits"), "in Chromium, Tab opens the next editable cell",
    "const next = here && (via === 'next' || via === 'back') ?",
    "const next = false ?"],
  [GALLERY_LIB("the keyboard: Enter opens and commits"), "in Chromium, Escape returns focus to the cell",
    "        say('', editor);\n        return close(true);",
    "        say('', editor);\n        return close(false);"],
  [GALLERY_LIB("the keyboard: Enter opens and commits"), "in Chromium, a refusal keeps the editor and its focus",
    "        if (doc.activeElement !== editor) {\n          close(false);",
    "        if (true) {\n          close(false);"],
  [GALLERY_LIB("the keyboard: Enter opens and commits"), "in Chromium, a checkbox asks on its first activation",
    "      box.addEventListener('change', () => {\n        if (pending !== null) {",
    "      box.addEventListener('change', () => {\n        if (!box.dataset.armed) { box.dataset.armed = '1'; box.checked = value; return; }\n        if (pending !== null) {"],
];

// WHICH CRITERION EACH ROW GUARDS, so coverage is checked rather than
// claimed: test/unit/rundock-ui-mutation-coverage.test.js requires every
// criterion that is a guard in the code to have a row, every criterion proved in a
// real engine to have a row that runs one, and every row to be listed here.
const CRITERIA = {
  'a mounted view is built with Rundock UI': ['view-built-on-library', 'every-frame-gets-library'],
  'a region frame is built with Rundock UI': ['every-frame-gets-library'],
  'the library runs before the entry': ['library-before-entry', 'every-frame-gets-library'],
  "the component stylesheet sits before the extension's own": ['library-before-entry'],
  'the frame body carries the theme class': ['library-before-entry'],
  'the gallery page carries the frame policy': ['gallery-frame-policy'],
  'the stylesheet is read from the sheet marked data-rundock-ui': ['one-source-copies'],
  'the library source has no way out of the frame': ['library-no-way-out', 'source-scan-forbidden'],
  'a label is text, never markup': ['source-scan-forbidden'],
  'the factory set is frozen': ['factory-set-frozen'],
  'one tab is the tab stop': ['roving-tab-stop'],
  'End jumps to the last item': ['roving-tab-stop', 'arrow-keys-and-radios'],
  'Home jumps to the first item': ['roving-tab-stop', 'arrow-keys-and-radios'],
  'the arrows wrap': ['roving-tab-stop', 'arrow-keys-and-radios'],
  'a vertical tablist moves on the vertical arrows': ['roving-tab-stop'],
  'a tab panel is shown only for its selected tab': ['roving-tab-stop'],
  'Space checks the focused radio': ['arrow-keys-and-radios'],
  'with nothing checked the first radio is the tab stop': ['arrow-keys-and-radios'],
  'the slider announces its formatted value': ['control-semantics'],
  'a field marks its control invalid': ['control-semantics'],
  'a field describes its control by the error': ['control-semantics'],
  'a toggle is a switch': ['control-semantics'],
  'indeterminate is set as the property': ['control-semantics'],
  'an interactive card answers Enter and Space': ['control-semantics'],
  'loading is a status': ['status-and-alert-copy', 'control-semantics'],
  'Escape returns focus to the menu trigger': ['menu-focus-and-close'],
  'a menu choice closes the menu': ['menu-focus-and-close'],
  "card actions share a header row with the title": ["card-header-actions", "status-and-alert-copy"],
  "card actions must be elements": ["card-header-actions", "status-and-alert-copy"],
  "in Chromium, card actions are centred on the title": ["card-header-actions", "status-and-alert-copy"],
  "in Chromium, card actions sit at the end of the title line": ["card-header-actions", "status-and-alert-copy"],
  "in Chromium, a card header row stands clear of its content": ["card-header-actions", "status-and-alert-copy"],
  "in Chromium, a card header stands clear of its content": ["card-header-actions", "status-and-alert-copy"],
  "a separator carries role=separator": ["menu-separators", "menu-focus-and-close"],
  "the keys and a choice pass over a separator": ["menu-separators", "menu-focus-and-close"],
  "a menu needs a real item besides separators": ["menu-separators", "menu-focus-and-close"],
  'a press outside closes the menu': ['menu-focus-and-close'],
  'a board card moves from its menu': ['board-keyboard-move'],
  'a board move is said aloud': ['board-keyboard-move'],
  'focus follows a moved card': ['board-keyboard-move'],
  'statusOptions narrows where a card may go': ['board-keyboard-move'],
  'a failed canvas offers Retry': ['status-and-alert-copy'],
  'stale time is said in words': ['status-and-alert-copy'],
  'the primary button fills with --accent-action, not the brand': ['light-theme-contrast', 'fill-color-roles'],
  'a measured rule is a measured member (a removed rule is loud)': ['light-theme-contrast'],
  'the stale time is readable in light': ['light-theme-contrast'],
  'the danger button is an outline, never the fill': ['light-theme-contrast', 'destructive-outline'],
  'no solid fill is the brand --accent': ['fill-color-roles'],
  'a bare control shape is control orange, not action orange': ['fill-color-roles'],
  'a fill carrying text is action orange, not control orange': ['fill-color-roles'],
  'control orange clears 3:1 on the light surfaces': ['fill-color-roles'],
  'the send icon button copies the chat send button': ['icon-button-naming', 'one-source-copies'],
  'an icon button must be named': ['control-semantics', 'icon-button-naming'],
  'the send button becomes a named stop button': ['icon-button-naming'],
  'white on --accent-action clears 4.5:1': ['fill-color-roles', 'destructive-outline'],
  'the input copies the settings input': ['one-source-copies'],
  'a copied rule is a member (a removed copy is loud)': ['one-source-copies'],
  'every animation stops under reduced motion': ['reduced-motion'],
  'an app rule that changes is followed by its copy': ['one-source-copies'],
  'the pane an extension holds has no padding': ['pane-full-bleed'],
  "the frame paints the pane's own colour": ['frame-paints-pane-color'],
  "the frame document paints the pane's own colour": ['frame-paints-pane-color'],
  "the frame document carries the note's padding": ['view-note-padding'],
  'a view can opt out to an edge-to-edge canvas': ['edge-to-edge-opt-out'],
  'the seam marks the pane full bleed': ['pane-full-bleed'],
  'the pane gets its padding back when the view goes': ['pane-full-bleed'],
  'an embedded view is built with Rundock UI': ['every-frame-gets-library'],
  'an embedded view is told so on its body': ['every-frame-gets-library', 'embedded-view-surface'],
  'in Chromium, a mounted view carries Rundock UI': ['view-built-on-library', 'every-frame-gets-library'],
  'in Chromium, the library runs before the entry': ['view-built-on-library', 'library-before-entry'],
  'in Chromium, an embedded view carries Rundock UI': ['every-frame-gets-library'],
  'in Chromium, the library sends no message of its own': ['library-no-way-out'],
  'in Chromium, a failed install stops the frame before the entry runs': ['failed-install-stops-frame'],
  'the host ignores everything a frame says after it has failed': ['failed-install-stops-frame'],
  'in Chromium, a vertical tablist moves on ArrowDown and ArrowUp': ['roving-tab-stop'],
  'in Chromium, the option list wraps': ['arrow-keys-and-radios'],
  'in Chromium, Escape returns focus to the menu trigger': ['menu-focus-and-close'],
  'in Chromium, focus follows a moved card': ['board-keyboard-move'],
  'in Chromium, the slider announces its formatted value': ['control-semantics'],
  'in Chromium, the chip label is trimmed to its ink': ['chip-line-height'],
  'in Chromium, the chip keeps its line-height fallback': ['chip-line-height'],
  'in Chromium, the chip has a line-height fallback at all': ['chip-line-height'],
  'in Chromium, the pane an extension holds has no padding': ['pane-full-bleed'],
  "in Chromium, the frame document paints the pane's own colour": ['frame-paints-pane-color'],
  "in Chromium, the view's first line starts where a note's does": ['view-note-padding'],
  'in Chromium, a view can opt out to an edge-to-edge canvas': ['edge-to-edge-opt-out'],
  "in Chromium, an embedded view paints its panel's surface": ['embedded-view-surface'],
  'every factory is in the set': ['factory-set-frozen'],
  'the accepted dark exception is pinned where it was accepted': ['dark-exception-pinned'],
  "the app's resting destructive button is an outline over --elevated": ['destructive-outline'],
  'a literal in the component stylesheet is refused unless allowlisted': ['stylesheet-literals-allowlisted'],
  'the server and the library agree on the version': ['version-agreement'],
  'the checkbox tick is centred in its box': ['control-geometry'],
  'the slider thumb sits on the track centre (margin-top -6px)': ['control-geometry'],
  'the slider track is the 4px line the thumb is centred on': ['control-geometry'],
  'the library source never reads the bare global top': ['source-scan-forbidden'],
  'a newer minor is refused': ['version-rule'],
  'another major is refused': ['version-rule'],
  'the manifest reads rundockUi exactly as declared, never trimmed': ['version-rule'],
  'the manifest holds rundockUi to the rule': ['version-rule'],
  'an alert with an action aligns message and action on the first baseline': ['status-and-alert-copy'],
  'the alert icon joins the first line': ['status-and-alert-copy'],
  'the mode toggle carries the tablist role': ['mode-toggle-tablist'],
  'the mode toggle roves its tab stop': ['mode-toggle-tablist'],
  'focus survives the re-render': ['mode-toggle-tablist'],
  'a column width fixes the layout': ['table-widths-and-cell-styling'],
  'each width reaches its col': ['table-widths-and-cell-styling'],
  'a table without widths draws no colgroup': ['table-widths-and-cell-styling'],
  'a width must be a length': ['table-widths-and-cell-styling'],
  'a column takes render or format, not both': ['table-widths-and-cell-styling'],
  "with no onEdit no cell is editable": ["table-never-writes-rows"],
  "the table never writes the row": ["table-never-writes-rows"],
  "when(row) turns editing off for its row": ["table-editable-columns"],
  "an editable column draws with format, not render": ["table-editable-columns"],
  "an editable cell is named by its column, row and value": ["table-cell-naming-and-tab-order"],
  "the editor is named by its column and row": ["table-cell-naming-and-tab-order"],
  "edit.label names the row": ["table-cell-naming-and-tab-order"],
  "the covered cell leaves the tab order": ["table-cell-naming-and-tab-order"],
  "a closed cell is a tab stop again": ["table-cell-naming-and-tab-order"],
  "a click opens the editor": ["table-edit-keyboard"],
  "F2 opens the editor": ["table-edit-keyboard"],
  "Enter on the cell opens the editor": ["table-edit-keyboard"],
  "Enter commits": ["table-edit-keyboard"],
  "Escape returns focus to the cell": ["table-edit-keyboard"],
  "Tab opens the next editable cell": ["table-edit-keyboard"],
  "Shift+Tab opens the one before": ["table-edit-keyboard"],
  "at either end focus rests on the cell": ["table-edit-keyboard"],
  "only true accepts": ["table-onedit-decides"],
  "a number opens as the cell shows it": ["table-widths-and-cell-styling"],
  "a refusal reverts the value": ["table-onedit-decides"],
  "a refusal keeps the editor and its focus": ["table-onedit-decides"],
  "a refusal is said inline": ["table-onedit-decides"],
  "the refusal is an alert": ["table-onedit-decides"],
  "the refusal describes its control": ["table-onedit-decides"],
  "a refused control is marked invalid": ["table-onedit-decides"],
  "a throw is a refusal": ["table-onedit-decides"],
  "a promise holds the cell": ["table-onedit-decides"],
  "a held cell ignores Enter and Escape": ["table-onedit-decides"],
  "a held editor is read-only": ["table-onedit-decides"],
  "a held cell is busy": ["table-onedit-decides"],
  "a failed promise is a refusal": ["table-onedit-decides"],
  "only a plain decimal is a number": ["table-onedit-decides"],
  "min is enforced": ["table-onedit-decides"],
  "max is enforced": ["table-onedit-decides"],
  "an unchanged value asks nothing": ["table-onedit-decides"],
  "a select commits on change": ["table-select-and-checkbox"],
  "a select shows its option label": ["table-select-and-checkbox"],
  "a checkbox asks on its first activation": ["table-select-and-checkbox"],
  "a refused checkbox unticks": ["table-select-and-checkbox"],
  "a held checkbox ignores a second click": ["table-select-and-checkbox"],
  "a held checkbox keeps focus": ["table-select-and-checkbox"],
  "a read-only checkbox is disabled": ["table-never-writes-rows"],
  "in Chromium, the editor is laid over its cell": ["table-widths-and-cell-styling"],
  "in Chromium, the covered button keeps its size": ["table-widths-and-cell-styling"],
  "in Chromium, the editor is placed in its own cell": ["table-widths-and-cell-styling"],
  "in Chromium, a fixed table holds its widths": ["table-widths-and-cell-styling"],
  "in Chromium, overlong text ends in an ellipsis": ["table-widths-and-cell-styling"],
  "in Chromium, a refusal is seen on its own line under the row": ["table-refusal-line"],
  "in Chromium, an open menu is placed against the viewport": ["table-widths-and-cell-styling"],
  "in Chromium, a rounded row corner is caught (the mock's first-cell radius)": ["table-widths-and-cell-styling"],
  "in Chromium, the editor takes the cell's padding": ["table-widths-and-cell-styling"],
  "in Chromium, the editor is centred in the cell as the button is": ["table-widths-and-cell-styling"],
  "in Chromium, the cell being edited keeps the raised surface": ["table-widths-and-cell-styling"],
  "in Chromium, editing draws a 2px accent ring on the cell edge": ["table-widths-and-cell-styling"],
  "in Chromium, a refused cell draws a danger ring": ["table-widths-and-cell-styling"],
  "in Chromium, keyboard focus draws a 1px neutral ring on a raised cell": ["table-widths-and-cell-styling"],
  "in Chromium, the editor has no border and no radius": ["table-widths-and-cell-styling"],
  "in Chromium, a hovered editable cell takes its own tint": ["table-widths-and-cell-styling"],
  "in Chromium, an editable cell draws no pencil or second trigger": ["table-widths-and-cell-styling"],
  "in Chromium, a row-menu cell draws no ellipsis beside its trigger": ["table-widths-and-cell-styling"],
  "a refusal gets a line directly under its row": ["table-refusal-line"],
  "the refusal line spans the table": ["table-refusal-line"],
  "the refusal line goes when cleared": ["table-refusal-line"],
  "a held save says Saving": ["table-onedit-decides"],
  "Saving is said politely, from a region there from the start": ["table-onedit-decides"],
  "the light editing ring clears 3:1 against the separator": ["table-widths-and-cell-styling"],
  "the dark active cell is lighter than the table": ["table-widths-and-cell-styling"],
  "the dark invalid ring clears 3:1 against the active cell": ["table-widths-and-cell-styling"],
  "in Chromium, the light row hover is quieter than the active cell": ["table-widths-and-cell-styling"],
  "in Chromium, a table measures its columns once it is laid out": ["table-measured-widths"],
  "in Chromium, a column's widest sample is measured with its cells": ["table-measured-widths"],
  "in Chromium, natural widths are measured on one line": ["table-measured-widths"],
  "in Chromium, a table too wide for its wrapper scrolls inside it": ["table-explicit-widths-and-scroll"],
  "in Chromium, widths are never shared again under an open editor": ["table-widths-locked-while-editing", "table-widths-and-cell-styling"],
  "in Chromium, a locked table is set in pixels, not reflowed by its container": ["table-widths-locked-while-editing"],
  "in Chromium, explicit widths are read unstretched": ["table-explicit-widths-and-scroll"],
  "minWidth must be a number of pixels": ["table-measured-widths"],
  "widest must be text or elements": ["table-measured-widths"],
  "in Chromium, longer text is capped at 280px": ["table-measured-widths"],
  "in Chromium, grow: true names the grow column": ["table-grow-column"],
  "in Chromium, the grow column takes the room, past its cap if need be": ["table-grow-column"],
  "in Chromium, a cut-off value keeps its whole text in the title": ["table-measured-widths"],
  "in Chromium, no column is capped below its header": ["table-measured-widths"],
  "grow must be true or false": ["table-grow-column"],
  "in Chromium, nothing a table positions escapes its scroller": ["table-explicit-widths-and-scroll"],
  "in Chromium, the filler is hidden from assistive technology": ["table-spare-room-sharing"],
  "a resizable column carries a handle": ["table-resize-handle"],
  "a column can opt out of resizing": ["table-resize-handle"],
  "a resize handle is a vertical separator": ["table-resize-handle"],
  "resizable must be true or false": ["table-resize-handle"],
  "in Chromium, a drag resizes the column": ["table-resize-interaction"],
  "in Chromium, a resize handle says its width": ["table-resize-handle"],
  "in Chromium, a handle sits on its own header's edge": ["table-resize-handle"],
  "in Chromium, Shift steps 32px": ["table-resize-interaction"],
  "in Chromium, a column never resizes below its floor": ["table-resize-interaction"],
  "in Chromium, the floor is the header, not only minWidth": ["table-resize-interaction"],
  "in Chromium, the handle is not part of the header's width": ["table-resize-handle"],
  "in Chromium, a reset returns the column to the rule": ["table-resize-interaction"],
  "in Chromium, Enter on a handle resets its column": ["table-resize-interaction"],
  "in Chromium, a double-click resets its column": ["table-resize-interaction"],
  "in Chromium, a reset is reported as a null width": ["table-resize-reporting"],
  "in Chromium, measuring sets explicit widths aside": ["table-explicit-widths-and-scroll"],
  "a table with nothing laid out still resizes from the keys": ["table-resize-interaction"],
  "in Chromium, the main column takes the spare room, and no other column is scaled": ["table-spare-room-sharing"],
  "in Chromium, with no main column the rest goes to the filler": ["table-spare-room-sharing"],
  "a control is never the main column": ["table-spare-room-sharing"],
  "a column with an explicit width is never the main column": ["table-spare-room-sharing", "table-explicit-widths-and-scroll"],
  "in Chromium, an explicit or saved width holds": ["table-explicit-widths-and-scroll", "table-resize-reporting"],
  "in Chromium, a resized column is fixed at its new width": ["table-explicit-widths-and-scroll"],
  "in Chromium, the unfixed columns rescale after a resize": ["table-explicit-widths-and-scroll"],
  "in Chromium, a column with no text in its cells is a control": ["table-spare-room-sharing"],
  "the main column is the widest text column, not the narrowest": ["table-spare-room-sharing"],
  "a numeric column is never the main column": ["table-spare-room-sharing"],
  "the main column takes the spare room, and no other column is scaled": ["table-spare-room-sharing"],
  "while a main column can take the room, the filler takes none": ["table-spare-room-sharing"],
  "in Chromium, focus that has left is never pulled back": ["table-edit-keyboard"],
  "in Chromium, Tab opens the next editable cell": ["table-edit-keyboard"],
  "in Chromium, Escape returns focus to the cell": ["table-edit-keyboard"],
  "in Chromium, a refusal keeps the editor and its focus": ["table-onedit-decides"],
  "in Chromium, a checkbox asks on its first activation": ["table-select-and-checkbox"],
  "in Chromium, widths are shared again once an editor closes": ["table-widths-locked-while-editing"],
  "a resize under an open editor is remembered": ["table-widths-locked-while-editing"],
  "widths are shared again once an editor closes": ["table-widths-locked-while-editing"],
  "resizing writes nothing to the columns handed in": ["table-resize-reporting"],
  "resizing writes nothing to the rows handed in": ["table-resize-reporting"],
  "in Chromium, every editable cell is reached by Tab alone": ["table-cell-naming-and-tab-order"],
  "in Chromium, a cell reached by Tab is named by its column, row and value": ["table-cell-naming-and-tab-order"],
  "a held select says it is held": ["table-onedit-decides"],
  "a settled select is free again": ["table-onedit-decides"],
  "a held select takes no key": ["table-onedit-decides"],
  "a held select cannot be opened": ["table-onedit-decides"],
  "a held select puts back a change that gets through": ["table-onedit-decides"],
  "a held cell never traps Tab": ["table-cell-naming-and-tab-order", "table-onedit-decides"],
};
for (const name of ['postMessage', 'the parent', 'window.top', 'the opener', 'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'eval', 'Function',
  'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'dynamic import', 'localStorage', 'sessionStorage', 'cookies', 'a loaded source', 'a location']) {
  CRITERIA[`the source scan refuses ${name}`] = ['source-scan-forbidden'];
}

const REPORTER = ['--test-reporter', 'spec'];

function redTests(suite) {
  let out = '';
  let failed = false;
  // A suite named `test/e2e/<spec>.spec.js#<test title>` is a real-engine
  // check: Playwright runs that one test in Chromium, on a port of its own so
  // it never meets a server another run holds, and its failures are read from
  // the numbered list the line reporter ends with.
  const [file, grep] = String(suite).split('#');
  const e2e = /\.spec\.js$/.test(file);
  try {
    out = e2e
      ? execFileSync('npx', ['playwright', 'test', file, '--reporter=line', ...(grep ? ['-g', grep] : [])],
        { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, E2E_PORT: '34637' } })
      : execFileSync('node', ['--test', ...REPORTER, suite],
        { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    failed = true;
    out = (e.stdout || '') + (e.stderr || '');
  }
  if (e2e) {
    const names = [];
    for (const line of out.split('\n')) {
      const m = /^\s*\d+\) \S+\.spec\.js:\d+:\d+ .*› (.+?)\s*[─\s]*$/.exec(line);
      if (m && !names.includes(m[1].trim())) names.push(m[1].trim());
    }
    if (names.length) return names;
    return failed ? { unparsable: true } : [];
  }
  const marker = out.indexOf('failing tests:');
  if (marker === -1) {
    if (!failed) return [];
    // A suite that failed with output this could not read has produced no
    // verdict: not red, not green, nothing. Refused as a named row rather
    // than thrown, so the report says which mutation was in flight instead
    // of a stack trace that names nothing.
    return { unparsable: true };
  }
  const names = [];
  for (const line of out.slice(marker).split('\n')) {
    const m = /^✖ (.+?) \(\d/.exec(line.trim());
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

function run() {
  // Every target a row names must be here, or its original is never read:
  // derived from the rows so a new target cannot be forgotten a second time.
  const targets = [...new Set(MUTATIONS.map((m) => m[0]))];
  const session = beginMutationRun({ files: [...new Set(targets.map((t) => t.src))] });
  const originals = new Map();
  for (const target of targets) originals.set(target, session.original(target.src));
  const results = [];
  try {
    for (const [target, label, guard, without] of MUTATIONS) {
      const original = originals.get(target);
      const matches = original.split(guard).length - 1;
      if (matches === 0) {
        results.push({ label, applied: false, red: [] });
        continue;
      }
      if (matches > 1) {
        results.push({ label, applied: false, ambiguous: matches, red: [] });
        continue;
      }
      fs.writeFileSync(target.src, original.replace(guard, without));
      const red = redTests(target.suite);
      results.push(red && red.unparsable
        ? { label, applied: true, unparsable: true, red: [] }
        : { label, applied: true, red });
      fs.writeFileSync(target.src, original);
    }
  } finally {
    session.finish();
  }
  return results;
}

function report(results, markdown) {
  let failed = 0;
  const lines = [];
  for (const { label, applied, red, ambiguous, unparsable } of results) {
    if (unparsable) {
      failed++;
      const why = 'no verdict: the suite failed but its output could not be parsed, so nothing '
        + 'about this mutation is known; fix the reporter parsing rather than trusting a rerun';
      lines.push(markdown ? `| ${label} | **${why}** | |` : `${label}\n  ${why.toUpperCase()}`);
      continue;
    }
    if (ambiguous) {
      failed++;
      const why = `the guard text matches ${ambiguous} places, so it would break whichever came first`;
      lines.push(markdown ? `| ${label} | **${why}** | |` : `${label}\n  AMBIGUOUS: ${why}`);
      continue;
    }
    if (!applied) {
      failed++;
      lines.push(markdown
        ? `| ${label} | **the guard text was not found, so nothing was mutated** | |`
        : `${label}\n  THE GUARD TEXT WAS NOT FOUND, so nothing was mutated`);
      continue;
    }
    if (red.length === 0) {
      failed++;
      lines.push(markdown ? `| ${label} | **nothing turned red** | |` : `${label}\n  NOTHING TURNED RED`);
      continue;
    }
    lines.push(markdown
      ? `| ${label} | ${red.length} | ${red.map((n) => `\`${n}\``).join('<br>')} |`
      : `${label}\n  ${red.length} red\n${red.map((n) => `    - ${n}`).join('\n')}`);
  }
  if (markdown) {
    console.log('| Guard broken | Tests red | Which |');
    console.log('|---|---|---|');
    for (const line of lines) console.log(line);
  } else {
    for (const line of lines) console.log(`\n${line}`);
  }
  return failed;
}

function requireSaneTempRoot() {
  const verdict = preflight(os.tmpdir());
  if (verdict.ok) return;
  console.error(verdict.message);
  process.exit(2);
}

if (require.main === module) {
  requireSaneTempRoot();
  if (process.argv.includes('--preflight-only')) process.exit(0);
  const failed = report(run(), process.argv.includes('--markdown'));
  if (failed) {
    console.error(`\n${failed} mutation(s) proved nothing. A guard no test notices is not guarded,`
      + ' and a mutation that could break more than one place proves nothing about either.');
    process.exit(1);
  }
}

// Every criterion by name, in the order the criteria were written. Three are
// not guards in the code; the coverage test says why.
const CRITERION_NAMES = [
  'view-built-on-library',
  'library-no-way-out',
  'source-scan-forbidden',
  'library-before-entry',
  'every-frame-gets-library',
  'failed-install-stops-frame',
  'factory-set-frozen',
  'status-and-alert-copy',
  'roving-tab-stop',
  'arrow-keys-and-radios',
  'mode-toggle-tablist',
  'menu-focus-and-close',
  'board-keyboard-move',
  'control-semantics',
  'control-geometry',
  'chip-line-height',
  'icon-button-naming',
  'reduced-motion',
  'light-theme-contrast',
  'fill-color-roles',
  'dark-exception-pinned',
  'destructive-outline',
  'one-source-copies',
  'stylesheet-literals-allowlisted',
  'pane-full-bleed',
  'frame-paints-pane-color',
  'view-note-padding',
  'edge-to-edge-opt-out',
  'embedded-view-surface',
  'version-agreement',
  'version-rule',
  'ui-docs',
  'gallery-frame-policy',
  'starter-extension',
  'mutation-coverage',
];

// The editable table's criteria by name, in the order they were written. Six
// are not guards in this repository; the coverage test says why.
const TABLE_CRITERION_NAMES = [
  'table-widths-and-cell-styling',
  'table-editable-columns',
  'table-edit-keyboard',
  'table-cell-naming-and-tab-order',
  'table-onedit-decides',
  'table-never-writes-rows',
  'table-select-and-checkbox',
  'table-evidence',
  'table-consumer-adoption',
  'table-markup-unchanged',
  'table-source-scan',
  'table-version',
  'table-contrast-and-parity',
  'table-measured-widths',
  'table-spare-room-sharing',
  'table-grow-column',
  'table-widths-locked-while-editing',
  'table-resize-handle',
  'table-resize-interaction',
  'table-explicit-widths-and-scroll',
  'table-resize-reporting',
  'card-header-actions',
  'menu-separators',
  'table-refusal-line',
];

module.exports = { MUTATIONS, CRITERIA, CRITERION_NAMES, TABLE_CRITERION_NAMES, run };
