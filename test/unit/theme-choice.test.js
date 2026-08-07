// Tests for the theme decision (public/theme-choice.js).
//
// The app used to default to dark unconditionally; the OS setting was never
// consulted. The rule now: an explicit choice the user once made wins
// forever, and until they make one the app follows the OS. This only became
// possible when renderer storage started surviving relaunches; before that,
// "the user chose" was forgotten on every launch and following the OS would
// have fought a phantom preference.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const chooseTheme = require('../../public/theme-choice.js');

describe('an explicit choice wins over the OS', () => {
  test('stored light beats an OS that prefers dark', () => {
    assert.deepStrictEqual(chooseTheme({ stored: 'light', osPrefersLight: false }), { light: true, followOs: false });
  });

  test('stored dark beats an OS that prefers light', () => {
    assert.deepStrictEqual(chooseTheme({ stored: 'dark', osPrefersLight: true }), { light: false, followOs: false });
  });
});

describe('no choice yet means follow the OS, live', () => {
  test('nothing stored, OS light', () => {
    assert.deepStrictEqual(chooseTheme({ stored: null, osPrefersLight: true }), { light: true, followOs: true });
  });

  test('nothing stored, OS dark', () => {
    assert.deepStrictEqual(chooseTheme({ stored: null, osPrefersLight: false }), { light: false, followOs: true });
  });
});

describe('junk in storage is treated as no choice', () => {
  test('an unrecognised stored value follows the OS', () => {
    assert.deepStrictEqual(chooseTheme({ stored: 'blue', osPrefersLight: true }), { light: true, followOs: true });
  });

  test('missing input entirely follows a dark OS default', () => {
    assert.deepStrictEqual(chooseTheme({}), { light: false, followOs: true });
  });
});
