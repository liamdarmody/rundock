'use strict';
// `extension.rundockUi`: the Rundock UI version an extension was built
// against, and the install's refusal of one this Rundock cannot honour.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readExtensionManifest } = require('../../lib/packages/extension-manifest.js');
const { RUNDOCK_UI_VERSION, rundockUiCompatible } = require('../../lib/packages/rundock-ui-version.js');

function snapshot(extension) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-ui-manifest-'));
  fs.mkdirSync(path.join(dir, 'view'));
  fs.writeFileSync(path.join(dir, 'view', 'main.js'), 'parent.postMessage({type:"ready"},"*");');
  fs.writeFileSync(path.join(dir, 'rundock.json'), JSON.stringify({
    name: 'starter', version: '0.1.0', extension: { entry: 'view/main.js', match: '*.md', ...extension },
  }));
  return dir;
}
function read(extension) {
  const dir = snapshot(extension);
  try { return readExtensionManifest(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

describe('the compatibility rule', () => {
  test('the same major and an older or equal minor is compatible', () => {
    assert.deepStrictEqual(rundockUiCompatible('1.0', '1.0'), { ok: true });
    assert.deepStrictEqual(rundockUiCompatible('1.2', '1.4'), { ok: true });
  });

  test('a newer minor is refused, naming both versions and what to do', () => {
    const verdict = rundockUiCompatible('1.3', '1.0');
    assert.strictEqual(verdict.ok, false);
    assert.match(verdict.reason, /built against Rundock UI 1\.3, newer than the 1\.0 this Rundock provides: update Rundock/);
  });

  test('another major is refused in either direction', () => {
    assert.match(rundockUiCompatible('2.0', '1.9').reason, /a different major version/);
    assert.match(rundockUiCompatible('1.0', '2.0').reason, /a different major version/);
  });

  test('a malformed version is refused by its shape', () => {
    for (const bad of ['1', '1.0.0', 'v1.0', '01.0', '1.x', '', ' 1.0']) {
      assert.match(rundockUiCompatible(bad, '1.0').reason, /must be a version of the form MAJOR\.MINOR/, bad);
    }
  });
});

describe('the manifest field', () => {
  test('absent is allowed and reads as null', () => {
    assert.strictEqual(read({}).rundockUi, null);
  });

  test('this Rundock\'s own version installs', () => {
    assert.strictEqual(read({ rundockUi: RUNDOCK_UI_VERSION }).rundockUi, RUNDOCK_UI_VERSION);
  });

  test('a version this Rundock cannot honour is refused by name, with its own code', () => {
    const [major, minor] = RUNDOCK_UI_VERSION.split('.').map(Number);
    assert.throws(() => read({ rundockUi: `${major}.${minor + 1}` }), (e) => e.code === 'rundock-ui-incompatible' && /update Rundock/.test(e.message));
    assert.throws(() => read({ rundockUi: `${major + 1}.0` }), (e) => e.code === 'rundock-ui-incompatible');
  });

  test('a value is read exactly as declared: surrounding space is malformed, never trimmed into a version', () => {
    for (const padded of [' 1.0', '1.0 ', '\t1.0', '1.0\n']) {
      assert.throws(() => read({ rundockUi: padded }), (e) => e.code === 'rundock-ui-incompatible' && /must be a version of the form MAJOR\.MINOR/.test(e.message), JSON.stringify(padded));
    }
  });

  test('a value that is not a string is refused', () => {
    assert.throws(() => read({ rundockUi: 1 }), /extension\.rundockUi must be a version string/);
  });
});
