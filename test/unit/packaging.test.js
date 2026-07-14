'use strict';
// Packaging manifest guard. The 0.10.0 release shipped a macOS app without
// codex.js: the electron-builder files whitelist was never updated when the
// module landed, so the packaged server died on its first require, after
// install, where no test had ever looked. This suite ties the whitelist to
// the code's actual local requires so the omission class fails in every CI
// run, not in a user's dock. A second gate in scripts/afterPack.js asserts
// the same thing against the packed asar during release builds.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
const files = pkg.build && pkg.build.files || [];

// A whitelist entry covers a root-level file if it names it exactly or is a
// directory glob whose prefix contains it (e.g. public/**/* covers
// public/code-language.js).
function covered(relPath) {
  return files.some(entry => {
    if (entry === relPath) return true;
    const dir = entry.split('/**')[0];
    return entry.includes('**') && relPath.startsWith(dir + '/');
  });
}

function localRequires(file) {
  const src = fs.readFileSync(path.join(root, file), 'utf-8');
  return [...src.matchAll(/require\('\.\/([\w./-]+\.js)'\)/g)].map(m => m[1]);
}

describe('electron-builder files whitelist', () => {
  test('every local module server.js requires is packaged', () => {
    const required = localRequires('server.js');
    assert.ok(required.includes('codex.js'), 'sanity: the regression module is in the require list');
    for (const f of required) {
      assert.ok(covered(f), `server.js requires ./${f} but build.files does not package it`);
    }
  });

  test('every local module the packaged entry point requires is packaged', () => {
    for (const f of localRequires('electron/main.js')) {
      const rel = f.startsWith('electron/') ? f : `electron/${f}`.replace('electron/../', '');
      assert.ok(covered(f) || covered(rel), `electron/main.js requires ./${f} but build.files does not package it`);
    }
  });

  test('client scripts referenced by index.html are packaged', () => {
    const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf-8');
    // /marked.min.js is a server ROUTE serving the file out of node_modules
    // (covered by the node_modules glob), not a public/ file.
    const ROUTED = new Set(['marked.min.js']);
    const srcs = [...html.matchAll(/<script src="\/([\w./-]+)"><\/script>/g)]
      .map(m => m[1]).filter(f => !ROUTED.has(f)).map(f => `public/${f}`);
    assert.ok(srcs.includes('public/code-language.js'), 'sanity: the new client module is referenced');
    for (const f of srcs) {
      assert.ok(covered(f), `index.html loads /${f.replace('public/', '')} but build.files does not package it`);
      assert.ok(fs.existsSync(path.join(root, f)), `${f} referenced by index.html does not exist`);
    }
  });
});
