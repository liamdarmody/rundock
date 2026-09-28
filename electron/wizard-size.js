// First-run wizard window size. Pure: no Electron, no I/O.
//
// The wizard is sized so every setup state fits without scrolling. Electron
// does not shrink a window to fit the display, so on a display whose usable
// area is smaller than that, the size is capped to the usable area minus a
// margin that keeps the title bar clear of the screen edge. Only on that
// capped path does the wizard's scrolling body ever come into play.

'use strict';

const WIZARD_WIDTH = 680;
const WIZARD_HEIGHT = 610;
const SCREEN_MARGIN = 40;

// One dimension: the target, capped to the usable length minus the margin.
// A reading that is not a usable length (missing, not finite, or no bigger
// than the margin) leaves the target alone rather than shrinking the window
// to nothing.
function capped(target, available) {
  if (typeof available !== 'number' || !Number.isFinite(available)) return target;
  const room = Math.floor(available) - SCREEN_MARGIN;
  if (room <= 0) return target;
  return Math.min(target, room);
}

/**
 * @param {{ width: number, height: number }} workArea
 *   the primary display's usable area (screen.getPrimaryDisplay().workAreaSize)
 * @returns {{ width: number, height: number }} the wizard's content size
 */
function wizardSize(workArea) {
  const area = workArea && typeof workArea === 'object' ? workArea : {};
  return {
    width: capped(WIZARD_WIDTH, area.width),
    height: capped(WIZARD_HEIGHT, area.height),
  };
}

module.exports = { wizardSize, WIZARD_WIDTH, WIZARD_HEIGHT, SCREEN_MARGIN };
