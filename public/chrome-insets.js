'use strict';
// The two numbers that carry every platform difference in the window chrome.
//
// macOS puts its window controls top-LEFT; Windows puts them top-RIGHT.
// Designing for that directly means two layouts, two sets of CSS and two test
// matrices, forever. Instead the layout reserves an inset on each side and the
// platform supplies the values:
//
//   --chrome-inset-left    macOS traffic lights. 0 everywhere else.
//   --chrome-inset-right   Windows caption buttons. 0 everywhere else.
//
// This module is the ONLY platform-aware code in the chrome. There must be no
// per-platform branch in CSS and no per-platform DOM; if one appears, the
// mechanism has been abandoned. Browser and Linux are the same zero-inset path
// as each other, which is why they cost nothing to support.
//
// Pure and requireable in Node, so the platform matrix is exhaustively tested
// without launching four builds, following public/code-language.js.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.computeChromeInsets = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  // Room for the macOS traffic lights. The cluster is three 12px buttons with
  // 8px gaps starting at x=9, so it ends at 61; 77 leaves a margin before the
  // first interface element rather than butting straight up against them.
  // The 9px start matches the nav rail's own icon inset, so the lights read
  // as part of the rail column's rhythm.
  // A constant, not a measurement, because macOS exposes no equivalent of the
  // Window Controls Overlay API: the lights are positioned BY us, via
  // trafficLightPosition, so their location is something we choose.
  const MAC_TRAFFIC_LIGHTS = 77;

  const ZERO = { left: 0, right: 0 };

  const isFiniteNumber = (n) => typeof n === 'number' && Number.isFinite(n);

  /**
   * @param {object} input
   * @param {string|null} input.platform      process.platform, or null in a browser
   * @param {number} input.viewportWidth      window.innerWidth
   * @param {boolean} [input.fullScreen]      macOS hides the lights in fullscreen
   * @param {object} [input.overlay]          navigator.windowControlsOverlay shape
   * @returns {{left: number, right: number}} never negative, never NaN
   */
  function computeChromeInsets(input) {
    if (!input || typeof input !== 'object') return { ...ZERO };
    const { platform, viewportWidth, fullScreen, overlay } = input;

    if (platform === 'darwin') {
      // In fullscreen macOS hides the lights entirely; keeping the inset would
      // leave a permanent empty gap at the top-left.
      return fullScreen ? { ...ZERO } : { left: MAC_TRAFFIC_LIGHTS, right: 0 };
    }

    // Windows, and anything else that exposes the Window Controls Overlay.
    // The rect describes the DRAGGABLE area, not the buttons, so the space the
    // buttons occupy is whatever the rect leaves over on each side. Deriving
    // it this way rather than from the platform name means a caption width
    // that changes with DPI scaling, or on maximise, is simply measured again.
    // Hardcoding 138 is the classic bug here.
    if (overlay && overlay.visible && overlay.rect) {
      const { x, width } = overlay.rect;
      if (!isFiniteNumber(x) || !isFiniteNumber(width) || !isFiniteNumber(viewportWidth)) return { ...ZERO };
      return {
        left: Math.max(0, x),
        right: Math.max(0, viewportWidth - (x + width)),
      };
    }

    // Linux keeps its standard title bar, a plain browser has no window
    // controls, and Windows reports nothing until the overlay is laid out.
    // Zero is correct for all three, and is the safe answer while waiting.
    return { ...ZERO };
  }

  computeChromeInsets.MAC_TRAFFIC_LIGHTS = MAC_TRAFFIC_LIGHTS;
  return computeChromeInsets;
}));
