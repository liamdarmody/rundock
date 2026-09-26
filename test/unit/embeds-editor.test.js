// Embeds in the editor.
//
// A line of `![[file]]` embeds is drawn as panels by a decoration, and the
// document stays exactly what was written, whether or not anything on the
// page can render the files. Driven through the real editor: the round trip
// is measured with the mounter absent and present, and with it present the
// panels are asserted to be drawn for the lines that are embed rows only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { bootEditorEnv, roundTrip } from '../helpers/editor-harness.js';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = fs.readFileSync(path.join(HERE, '..', 'fixtures', 'ofm', 'embeds.md'), 'utf8');
const ROW = 'A dashboard.\n\n![[holdings.csv]] ![[allocation.csv]] ![[risk]]\n\nSee ![[inline.csv]] in a sentence.\n';

test('a document carrying embeds round-trips byte for byte with the renderers absent and present', async () => {
  const env = await bootEditorEnv();
  delete env.window.rundockMountEmbeds;
  env.window.RundockEmbedModel = require('../../public/embed-model.js');
  assert.strictEqual(await roundTrip(CORPUS), CORPUS, 'absent');
  assert.strictEqual(await roundTrip(ROW), ROW, 'absent, with a row');
  const mounted = [];
  env.window.rundockMountEmbeds = (holder, embeds) => {
    mounted.push(embeds.map((e) => e.name));
    const panel = env.window.document.createElement('div');
    panel.className = 'embed-panel';
    holder.replaceChildren(panel);
  };
  try {
    assert.strictEqual(await roundTrip(CORPUS), CORPUS, 'present');
    assert.strictEqual(await roundTrip(ROW), ROW, 'present, with a row');
  } finally {
    delete env.window.rundockMountEmbeds;
  }
  assert.ok(mounted.some((names) => names.join(',') === 'holdings.csv,allocation.csv,risk'), 'the row of three was mounted as one row');
  assert.ok(!mounted.some((names) => names.includes('inline.csv')), 'an embed inside a sentence stays a link');
});

test('the panels are drawn after the line, and the line stays in the document', async () => {
  const env = await bootEditorEnv();
  env.window.RundockEmbedModel = require('../../public/embed-model.js');
  env.window.rundockMountEmbeds = (holder, embeds) => {
    for (const e of embeds) {
      const p = env.window.document.createElement('div');
      p.className = 'embed-panel';
      p.textContent = e.name;
      holder.appendChild(p);
    }
  };
  const element = env.window.document.createElement('div');
  env.window.document.body.appendChild(element);
  const { editor } = env.createEditor({ element, rawMarkdown: ROW });
  try {
    const panels = [...element.querySelectorAll('.embed-holder .embed-panel')].map((p) => p.textContent);
    assert.deepStrictEqual(panels, ['holdings.csv', 'allocation.csv', 'risk'], 'three views for three embeds');
    assert.ok(element.querySelector('.embed-source-hidden'), 'the source line is present, marked quiet');
    assert.strictEqual(env.getMarkdown(editor), ROW);
  } finally {
    env.destroyEditor(editor);
    delete env.window.rundockMountEmbeds;
  }
});
