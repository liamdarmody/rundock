'use strict';
// Every color the composer's field is drawn in, in both themes, read from
// public/styles/views/chat.css and resolved against tokens.css
// (test/helpers/contrast.js): the + button and its tooltip on the field's
// --card.
const { test, describe } = require('node:test');
const { rules, rowsClear } = require('../helpers/contrast.js');

const CHAT = rules('public/styles/views/chat.css');
const FIELD = ['.composer-field', 'background', '--card'];

describe('the field\'s + button and tooltip clear their bar in both themes', () => {
  rowsClear(test, CHAT, [
    ['the + icon, --text-2-strong on --card', ['.attach-btn', 'color', '--text-2-strong'], FIELD, 3],
    ['the + on hover, --text-1 on --elevated', ['.attach-btn:hover', 'color', '--text-1'], ['.attach-btn:hover', 'background', '--elevated'], 3],
    ['the + focus ring against --card', ['.attach-btn:focus-visible', 'outline', '--accent-control'], FIELD, 3],
    ['the tooltip, --text-1 on --surface', ['.att-tip', 'color', '--text-1'], ['.att-tip', 'background', '--surface'], 4.5],
  ]);
});

const COVER = ['.composer-drop-cover', 'background', '--card'];
const CHIP = ['.composer-chip', 'background', '--elevated'];

describe('a drag of files over the conversation is drawn clear of the field in both themes', () => {
  rowsClear(test, CHAT, [
    ['"Drop to attach", --text-1 on --card', ['.composer-drop-msg b', 'color', '--text-1'], COVER, 4.5],
    ['the types it takes, --text-2-strong on --card', ['.composer-drop-msg span', 'color', '--text-2-strong'], COVER, 4.5],
    ['the drop icon, --accent-text on --card', ['.composer-drop-msg svg', 'color', '--accent-text'], COVER, 3],
    ['the dashed ring against the field', ['.composer-field.drop', 'outline', '--accent-control'], FIELD, 3],
    ['the dashed ring against a chip', ['.composer-field.drop', 'outline', '--accent-control'], CHIP, 3],
  ]);
});
