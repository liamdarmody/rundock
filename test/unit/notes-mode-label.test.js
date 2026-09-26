'use strict';
// THE MODE A PERSON SEES IS CALLED NOTES. The stored value stays `knowledge`
// (every reader of `.rundock/state.json` since the value was introduced asks
// only "is it `code`?", and the knowledge layer keeps the word), so this guard
// is about what reaches a reader, never about the value on disk.
//
// Two layers, because a scan alone misses a label assembled at runtime and a
// render alone misses docs and copy on screens this file does not draw.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
// "Knowledge mode", "Knowledge-mode", and the pairings the old docs used
// ("Knowledge vs Code", "Knowledge and Code mode", "Knowledge or Code",
// "Knowledge/Code"). The bare word is fine: knowledge files, knowledge work.
const OLD_LABEL = /knowledge[\s-]+mode|knowledge\s*(?:\/|or|and|vs\.?)\s*code/i;

// What a person or a contributor reads as the product's own words.
function userFacingFiles() {
  const out = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) { if (e.name !== 'vendor') walk(child); }
      else if (/\.(js|html|css|md)$/.test(e.name)) out.push(child);
    }
  };
  for (const dir of ['public', 'docs', 'scaffold']) walk(dir);
  out.push('README.md', 'ARCHITECTURE.md');
  return out;
}

describe('no user-facing string says Knowledge mode', () => {
  test('the shipped client, the docs and the scaffold never name the old label', () => {
    const hits = [];
    for (const rel of userFacingFiles()) {
      fs.readFileSync(path.join(ROOT, rel), 'utf-8').split('\n').forEach((line, i) => {
        if (OLD_LABEL.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
    assert.deepStrictEqual(hits, [], 'the mode is called Notes wherever a person reads it');
  });

  // The server's own display text: errors and notices it sends for a person to
  // read. Comments are stripped first, because a comment is read by
  // contributors and the value `knowledge` legitimately appears in code.
  test('no text the server sends for display names the old label', () => {
    const files = ['server.js', ...fs.readdirSync(path.join(ROOT, 'lib', 'protocol', 'handlers')).map((f) => `lib/protocol/handlers/${f}`)];
    const hits = [];
    for (const rel of files) {
      const code = fs.readFileSync(path.join(ROOT, rel), 'utf-8')
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
      code.split('\n').forEach((line, i) => { if (OLD_LABEL.test(line)) hits.push(`${rel}:${i + 1}`); });
    }
    assert.deepStrictEqual(hits, []);
  });

  test('the pattern catches every spelling the old copy used', () => {
    for (const specimen of ['Knowledge mode', 'knowledge-mode workspace', 'Knowledge vs Code', 'Knowledge and Code mode', 'Knowledge or Code', 'Knowledge/Code']) {
      assert.match(specimen, OLD_LABEL, specimen);
    }
    for (const fine of ['knowledge files', 'knowledge work', 'a knowledge management platform']) {
      assert.doesNotMatch(fine, OLD_LABEL, fine);
    }
  });

  test('the Permissions pane, rendered in either mode, names Notes and never the old label', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'views', 'settings.js'), 'utf-8');
    for (const mode of ['knowledge', 'code']) {
      const dom = new JSDOM('<!doctype html><body><div id="settings-content"></div></body>', { runScripts: 'dangerously' });
      const w = dom.window;
      w.esc = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      w.escAttr = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      w.eval(src);
      Object.assign(w, { serverPlatform: 'darwin', workspaceMode: mode, sandboxManaged: true, currentView: 'settings',
        agents: [], skills: [], runtimeStatus: null, ws: { readyState: 1, send() {} }, WebSocket: { OPEN: 1 } });
      w.renderSettingsSection('permissions');
      const text = w.document.getElementById('settings-content').textContent;
      dom.window.close();
      assert.doesNotMatch(text, OLD_LABEL, `${mode}: nothing on the pane says the old label`);
      assert.match(text, /\bNotes\b/, `${mode}: the Notes tab is on the pane`);
    }
  });

  test('the Notes tab asks for notes, the value this build stores for it', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'views', 'settings.js'), 'utf-8');
    assert.match(src, /data-mode="notes" onclick="setWorkspaceMode\('notes'\)">Notes</);
  });
});
