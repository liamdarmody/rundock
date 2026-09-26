// What the host adds to every extension frame so Rundock UI is there: the
// library's stylesheet as text, the library itself as source, and the class
// the page's theme is shown by.
//
// Kept out of extension-host.js on purpose, so the host's one change is a
// single call in the one function that builds a frame's document, and the
// rest of what Rundock UI needs lives beside the library it serves.
//
// NOTHING HERE WIDENS THE FRAME. The stylesheet is read out of the page's
// own sheets the way the extension floor is (a sheet the page already
// loaded, so building a frame stays synchronous), and the script is the
// library's own function as text: both are bytes inlined into the frame's
// document, under the frame's unchanged policy, and neither is a channel.
// The theme class states what `init` already tells the frame, early enough
// for a stylesheet to use it.

import { installRundockUi } from './rundock-ui.js';

/**
 * The Rundock UI stylesheet, as text, from the page's own sheet marked
 * `data-rundock-ui`. Answers '' when it cannot be found, and the components
 * then render unstyled rather than not at all: a missing stylesheet is a
 * worse-looking extension, never a broken one.
 */
export function rundockUiCss(doc) {
  if (!doc) return '';
  for (const sheet of doc.styleSheets || []) {
    const node = sheet.ownerNode;
    if (!node || !node.hasAttribute || !node.hasAttribute('data-rundock-ui')) continue;
    try {
      return [...sheet.cssRules].map((rule) => rule.cssText).join('\n');
    } catch (e) {
      return '';
    }
  }
  return '';
}

/**
 * The library as a script: its install function's own text, called on the
 * frame's window. One source for the page and the frame, so the library an
 * extension gets is exactly the one this Rundock ships.
 *
 * A LIBRARY THAT FAILS TO INSTALL STOPS THE FRAME. The extension's entry is
 * the next script in the document, and an entry that ran on without the
 * library would be a view in an unknown state talking to the host. So a
 * failed install stops the document's parser (`window.stop()`), which means
 * no later script element runs at all, and then rethrows, so the frame's
 * error bootstrap reports the failure and the host ends the view with it
 * named. The host also ignores everything a frame says after it has reported
 * a failure (extension-host.js, dispatch), so the two halves hold each other.
 */
export function rundockUiScript() {
  return `try { (${installRundockUi.toString()})(window); } catch (rundockUiFailure) { window.stop(); throw rundockUiFailure; }`;
}

/**
 * Everything the frame builder needs, in one call. `bodyClass` is `light` in
 * the light theme, so a rule written `body.light ...` behaves in a frame
 * exactly as it does on the page.
 */
export function rundockUiFrameParts(doc) {
  const light = !!(doc && doc.body && doc.body.classList.contains('light'));
  return { css: rundockUiCss(doc), script: rundockUiScript(), bodyClass: light ? 'light' : '' };
}
