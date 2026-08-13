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

// Does build.files package this path?
//
// electron-builder applies the list IN ORDER and a later entry overrides an
// earlier one, so a leading `!` excludes what a previous glob included. This
// used to be a plain `.some()` over positive matches, which meant negation
// entries were invisible to it: `public/**/*` followed by `!public/styles/**`
// read as covered, and the guard would have stayed green while the packaged
// app shipped with no stylesheets. build.files already carries three negations
// today, so the hole was real rather than hypothetical. Found on 2026-08-13
// while proving the stylesheet guard below could fail; it could not.
function covered(relPath) {
  let included = false;
  for (const entry of files) {
    const negated = entry.startsWith('!');
    const pattern = negated ? entry.slice(1) : entry;
    if (matches(pattern, relPath)) included = !negated;
  }
  return included;
}

// The glob shapes build.files uses: an exact path, or a directory prefix
// followed by `/**`, `/**/*`, or `/**/*.ext`.
//
// The extension is honoured rather than ignored. A first cut treated
// `public/**/*.css` as covering everything under public/, so excluding the
// stylesheets appeared to exclude the scripts too and the red proof pointed at
// the wrong test. A matcher that over-matches makes the guard fail for reasons
// that are not true, which is its own kind of useless.
function matches(pattern, relPath) {
  if (pattern === relPath) return true;
  const at = pattern.indexOf('/**');
  if (at === -1) return false;
  const dir = pattern.slice(0, at);
  if (!relPath.startsWith(dir + '/')) return false;
  const tail = pattern.slice(at + 3);              // '', '/*', '/*.css'
  const ext = /^\/\*(\.[\w.]+)$/.exec(tail);
  return ext ? relPath.endsWith(ext[1]) : true;
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

  test('client stylesheets referenced by index.html are packaged', () => {
    // Same gate as the scripts above, for <link> tags. A stylesheet missing
    // from the packaged app does not throw on boot the way a missing module
    // does: the app opens looking wrong, which is a worse failure to diagnose
    // and one no smoke test would name.
    const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf-8');
    const hrefs = [...html.matchAll(/<link[^>]+href="\/([\w./-]+\.css)"/g)]
      .map(m => `public/${m[1]}`);
    assert.ok(hrefs.includes('public/styles/tokens.css'), 'sanity: the token sheet is linked');
    for (const f of hrefs) {
      assert.ok(covered(f), `index.html links /${f.replace('public/', '')} but build.files does not package it`);
      assert.ok(fs.existsSync(path.join(root, f)), `${f} linked by index.html does not exist`);
    }
  });
});
