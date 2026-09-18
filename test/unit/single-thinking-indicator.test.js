'use strict';
// AN ID MEANS ONE ELEMENT, and three places create this one.
//
// `thinking-indicator` and the `thinking-status` inside it are fixed ids.
// getElementById returns the FIRST match, so a second element carrying the id
// is not merely untidy: the tool-status handlers find the wrong one and write
// into it. Two symptoms, both reported from real use:
//
//   - a specialist's file reads and web fetches appeared inside the PREVIOUS
//     agent's bubble, while its own showed a bare "Thinking"
//   - one agent working alone showed two bubbles, one with its activity and
//     one empty
//
// Three sites create the indicator. Two were fixed first and the third was
// found only by counting them, which is the reason this test counts them
// rather than trusting that they are all known.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..', '..');

const CLIENT_SOURCES = [
  'public/app.js',
  'public/views/chat.js',
  'public/views/conversations.js',
];

describe('every place that creates the thinking indicator clears the last one', () => {
  test('the creation sites are the ones we know about', () => {
    const found = [];
    for (const rel of CLIENT_SOURCES) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      for (const m of src.matchAll(/id\s*=\s*'thinking-indicator'/g)) {
        found.push(`${rel}:${src.slice(0, m.index).split('\n').length}`);
      }
    }
    assert.strictEqual(found.length, 3,
      `expected three creation sites, found ${found.length}: ${found.join(', ')}. `
      + 'A new one must clear any existing indicator before creating, or two '
      + 'elements share an id and the activity lands in whichever came first.');
  });

  test('each one removes an existing indicator first', () => {
    for (const rel of CLIENT_SOURCES) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      for (const m of src.matchAll(/id\s*=\s*'thinking-indicator'/g)) {
        const line = src.slice(0, m.index).split('\n').length;
        // The clear sits just above the creation in every case.
        const before = src.slice(Math.max(0, m.index - 400), m.index);
        assert.match(before, /getElementById\('thinking-indicator'\)[\s\S]{0,80}\.remove\(\)/,
          `${rel}:${line} creates an indicator without removing the previous one`);
      }
    }
  });

  test('and a handoff clears the outgoing agent\'s indicator', () => {
    // Creation-time clearing is not enough on its own: between a handoff and
    // the next agent's first indicator, the previous agent's is still in the
    // DOM and still the first match for the tool-status handlers.
    const src = fs.readFileSync(path.join(ROOT, 'public', 'conversation-state.js'), 'utf8');
    const at = src.indexOf('function reduceAgentSwitch');
    assert.ok(at > -1, 'the switch reducer is still here');
    const body = src.slice(at, src.indexOf('\n  function ', at + 1));
    assert.match(body, /remove-thinking-indicator/,
      'a handoff must retire the indicator belonging to the agent handing over');
  });

  test('the status element inside it is equally singular', () => {
    // Same rule, one level down: the status div carries a fixed id too, so two
    // indicators mean two status elements and the writes go to the first.
    const markup = fs.readFileSync(path.join(ROOT, 'public', 'chat-markup.js'), 'utf8');
    const hits = (markup.match(/id="thinking-status"/g) || []).length;
    assert.strictEqual(hits, 1,
      'more than one template emits this id, so clearing the indicator no '
      + 'longer guarantees a single status element');
  });
});
