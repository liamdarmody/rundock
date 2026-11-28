'use strict';
// Every color a message under the composer is drawn in, in both themes, read
// from public/styles/views/chat.css and resolved against tokens.css
// (test/helpers/contrast.js). Each message sits on --surface.
const { test, describe } = require('node:test');
const { rules, rowsClear } = require('../helpers/contrast.js');

const CHAT = rules('public/styles/views/chat.css');
const ITEM = ['.composer-notice-item', 'background', '--surface'];
const DISMISS = '.composer-notice-dismiss';

describe('a message\'s text and Dismiss clear their bar in both themes', () => {
  rowsClear(test, CHAT, [
    ['the title, --text-1 on --surface', ['.composer-notice-title', 'color', '--text-1'], ITEM, 4.5],
    ['the reason, --text-2-strong on --surface', ['.composer-notice-text', 'color', '--text-2-strong'], ITEM, 4.5],
    ['the icon, --attention-text on --surface', ['.composer-notice-icon', 'color', '--attention-text'], ITEM, 3],
    ['Dismiss, --text-2-strong on --surface', [DISMISS, 'color', '--text-2-strong'], ITEM, 3],
    ['Dismiss on hover, --text-1 on --card', [`${DISMISS}:hover`, 'color', '--text-1'], [`${DISMISS}:hover`, 'background', '--card'], 3],
    ['Dismiss\'s focus ring against --surface', [`${DISMISS}:focus-visible`, 'outline', '--accent-control'], ITEM, 3],
  ]);
});
