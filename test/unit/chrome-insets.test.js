'use strict';
// The two numbers that carry every platform difference in the window chrome.
//
// macOS puts its window controls top-LEFT, Windows top-RIGHT. Designing for
// that directly means two layouts and two test matrices. Instead the layout
// reserves an inset on each side and the platform supplies the values, so
// there is one layout everywhere and this is the only platform-aware code.
//
// Pure, so the matrix below is exhaustive without launching four builds.
const { test, describe } = require('node:test');
const assert = require('node:assert');

const computeChromeInsets = require('../../public/chrome-insets.js');

// A Windows overlay rect: the DRAGGABLE area, not the controls. Controls sit
// in whatever the rect leaves over, which is what the maths below recovers.
const winOverlay = (over = {}) => ({
  visible: true,
  rect: { x: 0, y: 0, width: 1142, height: 40 },
  ...over,
});

describe('computeChromeInsets', () => {
  describe('macOS: traffic lights on the left', () => {
    test('reserves space on the left, nothing on the right', () => {
      const i = computeChromeInsets({ platform: 'darwin', viewportWidth: 1280 });
      assert.ok(i.left > 0, 'traffic lights need room');
      assert.strictEqual(i.right, 0);
    });

    test('collapses to zero in fullscreen, where the lights are hidden', () => {
      // Leaving the inset would carry a permanent empty gap in fullscreen.
      const i = computeChromeInsets({ platform: 'darwin', viewportWidth: 1280, fullScreen: true });
      assert.deepStrictEqual(i, { left: 0, right: 0 });
    });

    test('the inset does not depend on window width', () => {
      const narrow = computeChromeInsets({ platform: 'darwin', viewportWidth: 900 });
      const wide = computeChromeInsets({ platform: 'darwin', viewportWidth: 2560 });
      assert.deepStrictEqual(narrow, wide);
    });
  });

  describe('Windows: caption buttons on the right, measured not assumed', () => {
    test('derives the right inset from what the overlay rect leaves over', () => {
      // 1280 wide, draggable area 1142 => 138px of caption buttons.
      const i = computeChromeInsets({ platform: 'win32', viewportWidth: 1280, overlay: winOverlay() });
      assert.strictEqual(i.left, 0);
      assert.strictEqual(i.right, 138);
    });

    test('tracks a different caption width, which is why it is measured', () => {
      // DPI scaling and maximising both change this. Hardcoding 138 is the
      // classic bug this test exists to prevent.
      const i = computeChromeInsets({
        platform: 'win32', viewportWidth: 1280, overlay: winOverlay({ rect: { x: 0, y: 0, width: 1073, height: 48 } }),
      });
      assert.strictEqual(i.right, 207);
    });

    test('falls back to zero before the overlay is ready', () => {
      // getTitlebarAreaRect reports nothing until the overlay is enabled and
      // laid out. Zero is the safe answer: content sits where it always did.
      const i = computeChromeInsets({ platform: 'win32', viewportWidth: 1280, overlay: { visible: false, rect: null } });
      assert.deepStrictEqual(i, { left: 0, right: 0 });
    });

    test('handles controls on the LEFT without a special case', () => {
      // Not a Windows arrangement today, but the maths is derived from the
      // rect rather than from the platform name, so it costs nothing to be
      // right if that ever changes.
      const i = computeChromeInsets({
        platform: 'win32', viewportWidth: 1280, overlay: winOverlay({ rect: { x: 138, y: 0, width: 1142, height: 40 } }),
      });
      assert.strictEqual(i.left, 138);
      assert.strictEqual(i.right, 0);
    });

    test('never returns a negative inset', () => {
      // A rect wider than the viewport is nonsense, but it must not produce a
      // negative padding that pulls content off-screen.
      const i = computeChromeInsets({
        platform: 'win32', viewportWidth: 800, overlay: winOverlay({ rect: { x: 0, y: 0, width: 1200, height: 40 } }),
      });
      assert.ok(i.right >= 0 && i.left >= 0);
    });
  });

  describe('everything else is the same zero-inset path', () => {
    test('Linux keeps its standard title bar, so reserves nothing', () => {
      assert.deepStrictEqual(computeChromeInsets({ platform: 'linux', viewportWidth: 1280 }), { left: 0, right: 0 });
    });

    test('a plain browser, where there are no window controls at all', () => {
      // This is the case every e2e test runs in.
      assert.deepStrictEqual(computeChromeInsets({ platform: null, viewportWidth: 1280 }), { left: 0, right: 0 });
    });
  });

  describe('total: it runs on every resize and every window-state change', () => {
    test('junk input yields zero insets rather than throwing', () => {
      for (const junk of [undefined, null, {}, 'nonsense', 42, { platform: 'darwin' }]) {
        const i = computeChromeInsets(junk);
        assert.ok(i && typeof i.left === 'number' && typeof i.right === 'number', `bad result for ${JSON.stringify(junk)}`);
        assert.ok(i.left >= 0 && i.right >= 0);
      }
    });

    test('a malformed overlay rect does not take the layout down', () => {
      const i = computeChromeInsets({ platform: 'win32', viewportWidth: 1280, overlay: { visible: true, rect: { x: 'x' } } });
      assert.deepStrictEqual(i, { left: 0, right: 0 });
    });
  });
});
