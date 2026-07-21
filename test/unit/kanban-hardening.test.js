'use strict';
// Hardening for public/kanban.js against silent data loss on save.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const Kanban = require('../../public/kanban.js');

const board = (...body) => ['---', '', 'kanban-plugin: board', '', '---', '', '', ...body].join('\n');

describe('kanban hardening', () => {
  test('a card containing "%% kanban:settings" does not truncate the board', () => {
    const src = board(
      '## Notes', '',
      '- [ ] First card, keep me',
      '- [ ] This card documents the %% kanban:settings marker',
      '- [ ] Third card with a fence:',
      '    ```',
      '    example',
      '    ```',
      '',
    );
    const out = Kanban.serialize(Kanban.parse(src));
    assert.ok(out.includes('First card'), 'card 1 kept');
    assert.ok(out.includes('Third card'), 'card 3 kept (board not truncated at the in-card marker)');
  });

  test('malformed settings JSON is preserved, not silently reset to default', () => {
    const src = board(
      '## Todo', '', '- [ ] A card', '', '',
      '%% kanban:settings',
      '```',
      '{"kanban-plugin":"board","list-collapse":[false],"my-setting":42,}',
      '```',
      '%%',
    );
    const out = Kanban.serialize(Kanban.parse(src));
    assert.ok(out.includes('list-collapse'), 'list-collapse preserved');
    assert.ok(out.includes('my-setting'), 'custom setting preserved');
  });

  test('a CRLF board parses instead of rendering empty', () => {
    const lf = board('## Todo', '', '- [ ] A card', '- [ ] Another card', '');
    const crlf = lf.replace(/\n/g, '\r\n');
    const out = Kanban.serialize(Kanban.parse(crlf));
    assert.ok(out.includes('A card') && out.includes('Another card'), 'CRLF board cards survive');
  });
});
