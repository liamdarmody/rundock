'use strict';
// The new-workspace form's two notices, driven against the shipped markup:
// the form is cut out of index.html rather than restated, so a renamed id in
// either place fails here.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const notice = require('../../public/workspace-create-notice.js');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf-8');
const start = html.indexOf('<div id="create-workspace-form"');
const end = html.indexOf('<div id="workspace-error"', start);
const FORM = html.slice(start, end);

let doc;
beforeEach(() => {
  assert.ok(start !== -1 && end !== -1, 'the create form is in index.html');
  doc = new JSDOM(`<body>${FORM}</body>`).window.document;
});

const $ = (id) => doc.getElementById(id);
const shown = (el) => el.style.display === 'block';

describe('the name is taken', () => {
  test('the notice and "Open it" show, and the hint stays plain', () => {
    const message = 'A workspace called "Acme" already exists in ~/Documents/Rundock, so nothing was changed. You can open it instead.';
    notice.showNameTaken(doc, { message, openPath: '/w/Acme' });
    assert.ok(shown($('workspace-name-notice')));
    assert.strictEqual($('workspace-name-notice-text').textContent, message);
    assert.ok(shown($('workspace-open-existing')));
    assert.strictEqual(notice.openPath(doc), '/w/Acme');
    assert.strictEqual($('create-workspace-hint').textContent, notice.DEFAULT_HINT);
  });

  test('without a folder to open, there is no "Open it"', () => {
    notice.showNameTaken(doc, { message: 'taken', openPath: null });
    assert.ok(shown($('workspace-name-notice')));
    assert.ok(!shown($('workspace-open-existing')));
    assert.strictEqual(notice.openPath(doc), null);
  });

  test('clearing hides both again', () => {
    notice.showNameTaken(doc, { message: 'taken', openPath: '/w/Acme' });
    notice.clear(doc);
    assert.ok(!shown($('workspace-name-notice')));
    assert.ok(!shown($('workspace-open-existing')));
    assert.strictEqual(notice.openPath(doc), null);
  });
});

describe('characters were removed', () => {
  test('the field takes the cleaned name and the hint says what happened', () => {
    $('create-workspace-name').value = 'My/Space?';
    const message = 'Rundock removed / and ? from the name. Press Create again to make the folder at ~/Documents/Rundock/MySpace';
    notice.showNameNotice(doc, { name: 'MySpace', message });
    assert.strictEqual($('create-workspace-name').value, 'MySpace');
    assert.strictEqual($('create-workspace-hint').textContent, message);
    assert.ok($('create-workspace-hint').classList.contains('is-notice'));
    assert.ok($('create-workspace-name').classList.contains('is-notice'));
  });

  test('a taken name after a notice replaces it, and clearing restores the plain hint', () => {
    notice.showNameNotice(doc, { name: 'MySpace', message: 'removed' });
    notice.showNameTaken(doc, { message: 'taken', openPath: '/w/MySpace' });
    assert.ok(!$('create-workspace-hint').classList.contains('is-notice'));
    assert.ok(!$('create-workspace-name').classList.contains('is-notice'));
    notice.clear(doc);
    assert.strictEqual($('create-workspace-hint').textContent, notice.DEFAULT_HINT);
  });
});
