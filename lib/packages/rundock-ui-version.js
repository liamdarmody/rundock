'use strict';
// Which Rundock UI an extension was built against, and whether this Rundock
// can honour it.
//
// THE RULE. A version is "MAJOR.MINOR". A minor adds (a new component, a new
// option, a new state); a major changes what an existing call does or
// accepts. A visual change is neither: the host injects the library into
// every frame, so a restyle reaches every extension at once and asks nothing
// of any of them. So an extension built against X.Y runs on a Rundock that
// provides X.Z where Z >= Y, and on nothing else: an older minor lacks
// something it may call, and another major means a call it makes may now do
// something different.
//
// ENFORCED AT INSTALL, and only when declared. A manifest that names no
// version installs as before and gets the library all the same: it simply
// has no promise to check. docs/RUNDOCK-UI.md states the rule for authors.
//
// The number here and `Rundock.ui.version` in public/rundock-ui.js are one
// fact in two runtimes (the library is inlined into frames as its own source
// text, so it cannot import this); test/unit/rundock-ui-frame.test.js holds
// the two equal.

const RUNDOCK_UI_VERSION = '1.0';
const VERSION_SHAPE = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/;

function parse(version) {
  const m = VERSION_SHAPE.exec(String(version));
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

/**
 * Whether a Rundock providing `provided` can run an extension built against
 * `declared`. Returns { ok: true } or { ok: false, reason } with the reason
 * written for the person installing.
 */
function rundockUiCompatible(declared, provided = RUNDOCK_UI_VERSION) {
  const want = parse(declared);
  const have = parse(provided);
  if (!want) return { ok: false, reason: 'extension.rundockUi must be a version of the form MAJOR.MINOR, such as "1.0"' };
  if (!have) throw new Error(`this Rundock's own Rundock UI version is malformed: ${provided}`);
  if (want.major !== have.major) {
    return { ok: false, reason: `the extension was built against Rundock UI ${declared}, and this Rundock provides ${provided}, a different major version whose components may behave differently` };
  }
  if (want.minor > have.minor) {
    return { ok: false, reason: `the extension was built against Rundock UI ${declared}, newer than the ${provided} this Rundock provides: update Rundock to install it` };
  }
  return { ok: true };
}

module.exports = { RUNDOCK_UI_VERSION, rundockUiCompatible };
