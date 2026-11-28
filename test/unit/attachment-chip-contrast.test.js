'use strict';
// Every color a file waiting in the composer is drawn in, in both themes,
// read from public/styles/views/chat.css and resolved against tokens.css
// (test/helpers/contrast.js). A chip sits on --elevated inside the field's
// --card, and its tile is --card again.
const { test, describe } = require('node:test');
const { rules, rowsClear } = require('../helpers/contrast.js');

const CHAT = rules('public/styles/views/chat.css');
const FIELD = ['.composer-field', 'background', '--card'];
const CHIP = ['.composer-chip', 'background', '--elevated'];
const REMOVE = '.composer-chip-remove';

describe('a chip\'s text and states clear their bar in both themes', () => {
  rowsClear(test, CHAT, [
    ['the name, --text-1 on --elevated', ['.composer-chip-name', 'color', '--text-1'], CHIP, 4.5],
    ['the meta, --text-2-strong on --elevated', ['.composer-chip-meta', 'color', '--text-2-strong'], CHIP, 4.5],
    ['the tile\'s icon, --text-2-strong on --card', ['.composer-chip-tile', 'color', '--text-2-strong'], ['.composer-chip-tile', 'background', '--card'], 3],
    ['the remove button, --text-2-strong on --elevated', [REMOVE, 'color', '--text-2-strong'], CHIP, 3],
    ['the remove on hover, --text-1 on --card', [`${REMOVE}:hover`, 'color', '--text-1'], [`${REMOVE}:hover`, 'background', '--card'], 3],
    ['the remove\'s focus ring against --card', [`${REMOVE}:focus-visible`, 'outline', '--accent-control'], FIELD, 3],
    ['the remove\'s focus ring against --elevated', [`${REMOVE}:focus-visible`, 'outline', '--accent-control'], CHIP, 3],
  ]);
});

// An image's second line saying it was scaled, or that an animated image is
// seen as its first frame only, and the icon before those words.
describe('an image\'s "Scaled to" and "First frame only" line and its icon clear their bar in both themes', () => {
  rowsClear(test, CHAT, [
    ['"Scaled to" and "First frame only", --text-2-strong on --elevated', ['.composer-chip-meta.state', 'color', '--text-2-strong'], CHIP, 4.5],
    ['their icon, --text-2-strong on --elevated', ['.composer-chip-meta.state svg', 'color', '--text-2-strong'], CHIP, 3],
  ]);
});

describe('a PDF held for an agent on Codex is edged clear of the field and the chip in both themes', () => {
  rowsClear(test, CHAT, [
    ['the Codex outline against --card', ['.composer-chip.warn', 'border-color', '--attention-text'], FIELD, 3],
    ['the Codex outline against --elevated', ['.composer-chip.warn', 'border-color', '--attention-text'], CHIP, 3],
  ]);
});
