'use strict';
// The message field's placeholder against the field it sits in, in both
// themes, read from public/styles/views/chat.css and resolved against
// tokens.css (test/helpers/contrast.js), with the color it was drawn in
// before as a specimen that falls short of the bar.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { THEMES, rules, rgb, ratio, rowsClear } = require('../helpers/contrast.js');

const CHAT = rules('public/styles/views/chat.css');
const FIELD = ['.composer-field', 'background', '--card'];

describe('the message field\'s placeholder clears 4.5:1 in both themes', () => {
  rowsClear(test, CHAT, [
    ['the placeholder, --text-2-strong on the field', ['.chat-input textarea::placeholder', 'color', '--text-2-strong'], FIELD, 4.5],
  ]);

  for (const name of ['dark', 'light']) {
    test(`a placeholder in --text-2 falls short on --card, ${name}`, () => {
      const theme = THEMES[name];
      const r = ratio(rgb('var(--text-2)', theme, 'the specimen'), rgb('var(--card)', theme, 'the field'));
      assert.ok(r < 4.5, `--text-2 on --card in ${name} measures ${r.toFixed(2)}:1, which the bar should refuse`);
    });
  }
});
