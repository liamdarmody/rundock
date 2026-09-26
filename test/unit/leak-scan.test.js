'use strict';
// The leak scan applied before a push and to pull request text
// (scripts/leak-scan.js): the repository's generic rules plus a private
// denylist. Every specimen is invented or assembled at run time, so this file
// carries none of the shapes it proves.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { scanText, GENERIC_RULES } = require('../../scripts/leak-scan.js');
const { parseDenylist } = require('../../scripts/private-denylist.js');

const TOOL = (server, tool) => ['mcp', server, tool].join('__');
const deny = parseDenylist('[person]\nzorblat\n').entries;
const labels = (text, opts = {}) => scanText('notes.md', text, { denylist: deny, ...opts }).map((f) => f.label);

describe('generic rules', () => {
  test('a concrete MCP tool name is flagged', () => {
    assert.ok(labels(`calls ${TOOL('claude_ai_Frobnic', 'list_things')}`).some((l) => /MCP tool name/.test(l)));
    assert.ok(labels(`calls ${TOOL('frobnic', 'get')}`).some((l) => /MCP tool name/.test(l)));
  });
  test('a placeholder MCP server passes', () => {
    for (const server of ['server', 'service', 'example', 'placeholder', 'my_server', 'example-tasks', 'example_notes', 'claude_ai_Example']) {
      assert.deepStrictEqual(labels(`calls ${TOOL(server, 'tool')}`), [], server);
    }
    assert.deepStrictEqual(labels('matcher mcp__.*'), []);
  });
  // The capture scrubber (scripts/capture-scrub.js) writes every connected
  // service as a numbered placeholder, so a scrubbed capture must not block a
  // push, while a real tool name, or a real tool under a placeholder server,
  // still does.
  test("the capture scrubber's own placeholders pass", () => {
    const scrubbed = [
      `calls ${TOOL('connector_1', 'tool_2')} and ${TOOL('connector_12', 'tool_3')}`,
      `a server with no tools yet: ${['mcp', 'connector_4', ''].join('__')} and ${['mcp', 'connector_4'].join('__')}`,
      'the server "connector 3" offers skill_7',
    ];
    for (const text of scrubbed) assert.deepStrictEqual(labels(text), [], text);
  });
  test('a real tool name still fails, under a real server or a placeholder one', () => {
    assert.ok(labels(`calls ${TOOL('claude_ai_Frobnic', 'list_things')}`).some((l) => /MCP tool name/.test(l)));
    assert.ok(labels(`calls ${TOOL('connector_1', 'list_things')}`).some((l) => /MCP tool name/.test(l)));
    assert.ok(labels(`calls ${TOOL('frobnic', 'tool_2')}`).some((l) => /MCP tool name/.test(l)));
  });
  test('the MCP match is masked', () => {
    const [f] = scanText('a.md', TOOL('frobnic', 'get'), { denylist: [] });
    assert.ok(!f.match.includes('frobnic'), f.match);
  });
  test('owner-address phrasing is flagged', () => {
    assert.ok(labels(`left as ${['the', "owner's"].join(' ')} call`).some((l) => /internal-address/.test(l)));
    assert.ok(labels(`flagging this for ${['the', 'maintainer'].join(' ')}`).some((l) => /internal-address/.test(l)));
    assert.deepStrictEqual(labels('the file owner can read it'), []);
  });
  test('every generic rule has a label and a regex', () => {
    for (const r of GENERIC_RULES) assert.ok(r.label && r.re instanceof RegExp);
  });
});

describe('scanText combines every rule set', () => {
  test('personal data from the repository rules', () => {
    assert.ok(labels(`mail ${['a.person', 'gmail.com'].join('@')}`).some((l) => /email/.test(l)));
  });
  test('a private term', () => {
    assert.deepStrictEqual(labels('met Zorblat'), ['private person']);
  });
  test('planning labels, honouring the skip list for captured files', () => {
    const planning = `see ${['Review', 'R2'].join(' ')}`;
    assert.ok(labels(planning).some((l) => /review-round/.test(l)));
    const captured = scanText('scripts/stream-truth/captured-grammar.json', planning, { denylist: [] });
    assert.deepStrictEqual(captured, []);
  });
  test('the private list is applied to captured files too', () => {
    const f = scanText('scripts/stream-truth/captured-grammar.json', 'zorblat', { denylist: deny });
    assert.strictEqual(f.length, 1);
  });
  test('a scoped exception in the private list is honoured through the scope', () => {
    const scoped = parseDenylist('[person]\nzorblat  !^Site/index\\.html$\n').entries;
    assert.strictEqual(scanText('index.html', 'zorblat', { denylist: scoped, scope: 'Site/index.html' }).length, 0);
    assert.strictEqual(scanText('index.html', 'zorblat', { denylist: scoped, scope: 'Other/index.html' }).length, 1);
  });
  test('clean text has no findings', () => {
    assert.deepStrictEqual(labels('Adds a button that saves the note.'), []);
  });
});
