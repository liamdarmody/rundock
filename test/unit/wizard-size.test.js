// Tests for the first-run wizard's window size (electron/wizard-size.js) and
// its wiring in electron/main.js.
//
// The wizard is sized so every setup state fits without scrolling, and capped
// to the display's usable area, because Electron will otherwise create a
// window that runs off a small display.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { wizardSize, WIZARD_WIDTH, WIZARD_HEIGHT, SCREEN_MARGIN } = require('../../electron/wizard-size.js');

describe('wizardSize', () => {
  test('the target is 680 by 610 with a 40px screen margin', () => {
    assert.strictEqual(WIZARD_WIDTH, 680);
    assert.strictEqual(WIZARD_HEIGHT, 610);
    assert.strictEqual(SCREEN_MARGIN, 40);
  });

  test('a display with room to spare gets the target size', () => {
    assert.deepStrictEqual(wizardSize({ width: 1440, height: 875 }), { width: 680, height: 610 });
  });

  test('a display exactly the target plus the margin still gets the target size', () => {
    assert.deepStrictEqual(wizardSize({ width: 720, height: 650 }), { width: 680, height: 610 });
  });

  test('a short display caps the height to its usable height minus the margin', () => {
    assert.deepStrictEqual(wizardSize({ width: 1280, height: 600 }), { width: 680, height: 560 });
  });

  test('a narrow display caps the width to its usable width minus the margin', () => {
    assert.deepStrictEqual(wizardSize({ width: 700, height: 900 }), { width: 660, height: 610 });
  });

  test('both dimensions cap independently on a small display', () => {
    assert.deepStrictEqual(wizardSize({ width: 640, height: 480 }), { width: 600, height: 440 });
  });

  test('a fractional usable area rounds down to whole pixels', () => {
    assert.deepStrictEqual(wizardSize({ width: 700.6, height: 600.9 }), { width: 660, height: 560 });
  });

  test('a missing or unusable reading leaves the target alone', () => {
    const target = { width: 680, height: 610 };
    assert.deepStrictEqual(wizardSize(undefined), target);
    assert.deepStrictEqual(wizardSize(null), target);
    assert.deepStrictEqual(wizardSize({}), target);
    assert.deepStrictEqual(wizardSize({ width: NaN, height: Infinity }), target);
    assert.deepStrictEqual(wizardSize({ width: '1440', height: '900' }), target);
    assert.deepStrictEqual(wizardSize({ width: 40, height: 0 }), target);
    assert.deepStrictEqual(wizardSize({ width: -100, height: -1 }), target);
  });
});

// A quick static check of the wiring only.
describe('the wizard window takes its size from wizardSize', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'electron', 'main.js'), 'utf-8');
  const start = main.indexOf('function showWizard()');
  const end = main.indexOf('wizard.loadFile(', start);
  const block = main.slice(start, end);

  test('screen is imported from electron', () => {
    assert.match(main, /const \{[^}]*\bscreen\b[^}]*\} = require\('electron'\);/);
  });

  test('the size comes from the primary display work area, before the window is created', () => {
    assert.ok(start > -1 && end > start, 'showWizard and its loadFile call are both found');
    const sized = block.indexOf('wizardSize(screen.getPrimaryDisplay().workAreaSize)');
    const created = block.indexOf('new BrowserWindow(');
    assert.ok(sized > -1 && created > sized, 'wizardSize is read from the work area, then the window is created');
    assert.match(block, /width: size\.width,\s*\n\s*height: size\.height,/);
  });

  test('the size stays a content size and the window stays fixed', () => {
    assert.match(block, /useContentSize: true,/);
    assert.match(block, /resizable: false,/);
    assert.doesNotMatch(block, /width: 520|height: 520/, 'the old fixed size is gone');
  });
});
