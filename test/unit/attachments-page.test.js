'use strict';
// What the page does with this change: the line it draws when a deleted
// conversation's attached files couldn't be removed, and the editor's saves,
// which stop before a frame the server would refuse to read.
//
// The code under test is cut out of public/app.js and public/views/files.js
// and run in a window, so it is the code that ships, and a renamed or missing
// piece fails here by name.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf-8');
const APP_SRC = read('public', 'app.js');

// One function, or one line, by its opening; refuses when it is missing.
function cutFrom(src, pattern, label) {
  const found = src.match(pattern);
  assert.ok(found, `the client no longer carries ${label}`);
  return found[0];
}

const KEPT = 'Rundock deleted the conversation but couldn\'t remove its attached files. They\'re still in .rundock/attachments/alpha/.';

describe('conversation_files_kept', () => {
  // handle(d) holding only the new arm, with the line drawer it calls cut
  // from source and the chat view's addSystemMsg recorded.
  function page(activeConversation) {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'dangerously' });
    const w = dom.window;
    w.__drawn = [];
    w.eval(`window.__api = (function () {
      const conversations = [{ id: 'alpha', messages: [{ role: 'user', content: 'hello' }] }];
      const activeConversation = ${JSON.stringify(activeConversation)};
      const addSystemMsg = (text) => window.__drawn.push(text);
      ${cutFrom(APP_SRC, /function addSystemMsgToConvo\(text, convoId, isError = true, keep = false\) \{[\s\S]*?\n\}/, 'addSystemMsgToConvo')}
      function handle(d) { switch (d.type) { ${cutFrom(APP_SRC, /case 'conversation_files_kept':[^\n]*/, 'the conversation_files_kept arm')} } }
      return { handle, messages: () => JSON.stringify(conversations) };
    })();`);
    return w;
  }

  for (const [label, active] of [['with no conversation open', null], ['with another conversation open', { id: 'beta' }], ['with that conversation open', { id: 'alpha' }]]) {
    test(`draws the text as a system line that isn't an error, ${label}`, () => {
      const w = page(active);
      const before = w.__api.messages();
      w.__api.handle({ type: 'conversation_files_kept', id: 'alpha', text: KEPT });
      assert.deepStrictEqual(Array.from(w.__drawn), [KEPT]);
      assert.strictEqual(w.__api.messages(), before, 'no conversation\'s messages change');
    });
  }
});
