'use strict';
// AN AGENT'S CONNECTOR CHANGE ASKS THE PERSON FIRST, EVERY TIME, through the
// real server.
//
// An agent adds or removes a connector by putting a SAVE_CONNECTOR or
// DELETE_CONNECTOR marker in its reply; the window turns the marker into a
// save_connector or delete_connector message, and the server writes `.mcp.json`
// (public/app.js, lib/protocol/handlers/team.js). A stdio server is a command
// the runtime starts, outside the sandbox, at the next spawn. So each message
// raises its own permission card naming the server and what it would run, and
// only an Allow on that card writes. Deny, no answer, or an answer to another
// card writes nothing.
//
// The card timeout is shortened in this process, before the server is loaded,
// so "nobody answered" is reached in seconds.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');

const PERM_TIMEOUT = 1500;
let client;
before(async () => {
  await h.boot({ env: { RUNDOCK_PERMISSION_TIMEOUT_MS: String(PERM_TIMEOUT) } });
  client = await h.connect();
});
after(async () => h.shutdown());

const mcp = () => path.join(h.workspaceDir, '.mcp.json');
const servers = () => (fs.existsSync(mcp()) ? JSON.parse(fs.readFileSync(mcp(), 'utf-8')).mcpServers : null);
const isConnectorCard = tool => m => m.type === 'control_request' && m.request && m.request.tool_name === tool;
function answer(msg, allow) {
  client.send({ type: 'permission_response', requestId: msg.request_id, conversationId: msg._conversationId, allow, card: true });
}
const STDIO = { command: 'node', args: ['tools/server.js', '--stdio'] };
const NAME_REFUSED = 'That connector name can\'t be used, so nothing was changed. A name uses letters, numbers, dots, dashes and underscores, and starts with a letter, number or underscore.';
const ENTRY_REFUSED = 'A connector needs a command to run or a URL to reach, so nothing was changed.';

describe('an agent\'s connector change asks first', () => {
  test('a stdio server from a marker shows the card, and writes nothing until Allow', async () => {
    if (fs.existsSync(mcp())) fs.unlinkSync(mcp());
    let since = client.messages.length;
    client.send({ type: 'save_connector', name: 'local-tools', content: JSON.stringify(STDIO), conversationId: 'convo-connectors' });
    const { msg } = await client.waitFor(isConnectorCard('SaveConnector'), { since, label: 'connector card' });
    assert.deepStrictEqual(msg.request.input, { name: 'local-tools', action: 'add', ...STDIO }, 'the card names the server, the command and its arguments');
    assert.strictEqual(msg._conversationId, 'convo-connectors', 'in the conversation whose agent asked');
    await h.delay(200);
    assert.strictEqual(servers(), null, 'nothing is written while the card waits');
    since = client.messages.length;
    answer(msg, true);
    const saved = await client.waitFor(m => m.type === 'connector_saved', { since, label: 'connector_saved' });
    assert.match(saved.msg.takesEffect, /next agent start/,
      'a connector is read when an agent starts, so the reply says so rather than implying it is live');
    assert.deepStrictEqual(servers()['local-tools'], STDIO, 'written once allowed');
  });

  test('a second connector is merged in, and the first is kept', async () => {
    // Getting this wrong drops every server somebody already had.
    let since = client.messages.length;
    client.send({ type: 'save_connector', name: 'calendar', content: '{"url":"https://mcp.example.com/mcp"}' });
    const card = await client.waitFor(isConnectorCard('SaveConnector'), { since, label: 'second connector card' });
    assert.match(card.msg.request_id, /^perm-[0-9a-f]{32}$/, 'the card\'s id is random, not guessable from the clock');
    since = client.messages.length;
    answer(card.msg, true);
    await client.waitFor(m => m.type === 'connector_saved', { since, label: 'second connector saved' });
    assert.deepStrictEqual(servers()['local-tools'], STDIO, 'the first is still there');
    assert.deepStrictEqual(servers().calendar, { url: 'https://mcp.example.com/mcp' }, 'beside the second');
  });

  test('Deny writes nothing, and nor does a card nobody answers', async () => {
    let since = client.messages.length;
    client.send({ type: 'save_connector', name: 'denied', content: JSON.stringify(STDIO) });
    let card = await client.waitFor(isConnectorCard('SaveConnector'), { since, label: 'card to deny' });
    since = client.messages.length;
    answer(card.msg, false);
    let err = await client.waitFor(m => m.type === 'connector_error', { since, label: 'denied' });
    assert.match(err.msg.message, /nothing was changed/);
    assert.ok(!servers().denied, 'Deny wrote nothing');

    since = client.messages.length;
    client.send({ type: 'save_connector', name: 'unanswered', content: JSON.stringify(STDIO) });
    await client.waitFor(isConnectorCard('SaveConnector'), { since, label: 'card nobody answers' });
    err = await client.waitFor(m => m.type === 'connector_error', { since, timeout: PERM_TIMEOUT + 4000, label: 'timed out' });
    assert.match(err.msg.message, /nothing was changed/);
    assert.ok(!servers().unanswered, 'with nobody to answer, nothing is written');
  });

  test('a marker repeated in a later reply needs its own Allow, and an old answer answers nothing new', async () => {
    let since = client.messages.length;
    client.send({ type: 'save_connector', name: 'again', content: JSON.stringify(STDIO) });
    const first = await client.waitFor(isConnectorCard('SaveConnector'), { since, label: 'first card' });
    since = client.messages.length;
    answer(first.msg, true);
    await client.waitFor(m => m.type === 'connector_saved', { since, label: 'first saved' });
    const without = servers();
    delete without.again;
    fs.writeFileSync(mcp(), JSON.stringify({ mcpServers: without }));

    since = client.messages.length;
    client.send({ type: 'save_connector', name: 'again', content: JSON.stringify(STDIO) });
    const second = await client.waitFor(isConnectorCard('SaveConnector'), { since, label: 'second card' });
    assert.notStrictEqual(second.msg.request_id, first.msg.request_id, 'a card of its own');
    answer(first.msg, true);
    await h.delay(200);
    assert.ok(!servers().again, 'replaying the first Allow answers nothing');
    client.send({ type: 'permission_response', requestId: 'perm-forged', allow: true, card: true });
    await h.delay(200);
    assert.ok(!servers().again, 'nor does an answer to a card that was never raised');
    since = client.messages.length;
    answer(second.msg, false);
    await client.waitFor(m => m.type === 'connector_error', { since, label: 'second denied' });
    assert.ok(!servers().again, 'and its own Deny keeps it out');
  });

  test('a removal asks too, and merges and refusals behave as before once allowed', async () => {
    fs.writeFileSync(mcp(), JSON.stringify({ mcpServers: { notion: { command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'] }, calendar: { url: 'https://mcp.example.com/mcp' } } }));
    let since = client.messages.length;
    client.send({ type: 'delete_connector', name: 'notion' });
    const card = await client.waitFor(isConnectorCard('DeleteConnector'), { since, label: 'removal card' });
    assert.deepStrictEqual(card.msg.request.input, { name: 'notion', action: 'remove', command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'] });
    assert.ok(servers().notion, 'still there while the card waits');
    since = client.messages.length;
    answer(card.msg, true);
    await client.waitFor(m => m.type === 'connector_saved' && m.action === 'removed', { since, label: 'connector removed' });
    assert.deepStrictEqual(Object.keys(servers()), ['calendar'], 'the named one goes and the other stays');

    // Removing what is not there SAYS SO, and asks nobody.
    since = client.messages.length;
    client.send({ type: 'delete_connector', name: 'never-configured' });
    let err = await client.waitFor(m => m.type === 'connector_error', { since, label: 'absent connector' });
    assert.match(err.msg.message, /No connector named/);

    // A FILE THIS COULD NOT PARSE IS NEVER OVERWRITTEN, and nobody is asked
    // about a change that could not be made.
    fs.writeFileSync(mcp(), '{ not json', 'utf-8');
    since = client.messages.length;
    client.send({ type: 'save_connector', name: 'notion', content: '{"url":"https://x"}' });
    err = await client.waitFor(m => m.type === 'connector_error', { since, label: 'unparsable file' });
    assert.match(err.msg.message, /not valid JSON, so nothing was changed/);
    assert.strictEqual(client.messages.slice(since).filter(isConnectorCard('SaveConnector')).length, 0, 'no card for it');
    assert.strictEqual(fs.readFileSync(mcp(), 'utf-8'), '{ not json', 'and the bytes it could not read are still there, untouched');

    // A file that changes while the card waits is read again once allowed.
    fs.writeFileSync(mcp(), JSON.stringify({ mcpServers: {} }));
    since = client.messages.length;
    client.send({ type: 'save_connector', name: 'notion', content: '{"url":"https://x"}' });
    const waiting = await client.waitFor(isConnectorCard('SaveConnector'), { since, label: 'card while the file changes' });
    fs.writeFileSync(mcp(), '{ not json', 'utf-8');
    since = client.messages.length;
    answer(waiting.msg, true);
    err = await client.waitFor(m => m.type === 'connector_error', { since, label: 'changed underneath' });
    assert.match(err.msg.message, /not valid JSON, so nothing was changed/);
    assert.strictEqual(fs.readFileSync(mcp(), 'utf-8'), '{ not json', 'what changed underneath is kept, not written over');

    // A name that is a path is refused before anyone is asked.
    fs.unlinkSync(mcp());
    since = client.messages.length;
    client.send({ type: 'save_connector', name: '../../etc/passwd', content: '{}' });
    err = await client.waitFor(m => m.type === 'connector_error', { since, label: 'bad name' });
    assert.strictEqual(err.msg.message, NAME_REFUSED);
    assert.strictEqual(client.messages.slice(since).filter(isConnectorCard('SaveConnector')).length, 0, 'no card for a change that could not be made');
  });

  // A CHANGE THE RULE REFUSES IS REFUSED BEFORE ANY CARD. The first thing the
  // asking window hears about it is the refusal, in the rule's words, no card
  // follows, and .mcp.json is left byte for byte as it was.
  const isAnyConnectorCard = m => isConnectorCard('SaveConnector')(m) || isConnectorCard('DeleteConnector')(m);
  async function refusedBeforeAnyCard(holds, send, message) {
    fs.writeFileSync(mcp(), holds);
    const before = fs.readFileSync(mcp());
    const since = client.messages.length;
    client.send(send);
    const { msg } = await client.waitFor(m => m.type === 'connector_error' || isAnyConnectorCard(m), { since, label: 'refusal or card' });
    assert.deepStrictEqual({ type: msg.type, message: msg.message }, { type: 'connector_error', message }, 'the refusal comes first, in the rule\'s words');
    await h.delay(200);
    assert.strictEqual(client.messages.slice(since).filter(isAnyConnectorCard).length, 0, 'and no card follows it');
    assert.ok(fs.readFileSync(mcp()).equals(before), 'and .mcp.json is byte-identical');
  }
  const HOLDS_ALPHA = JSON.stringify({ mcpServers: { 'example-alpha': { url: 'https://mcp.example.com/mcp' } } });

  test('saving a connector named __proto__ is refused before any card', async () => {
    await refusedBeforeAnyCard(HOLDS_ALPHA, { type: 'save_connector', name: '__proto__', content: '{"command":"node"}', conversationId: 'convo-connectors' }, NAME_REFUSED);
  });

  test('removing a connector named .tools is refused before any card, and the entry stays', async () => {
    const holds = JSON.stringify({ mcpServers: { '.tools': { command: 'node' } } });
    await refusedBeforeAnyCard(holds, { type: 'delete_connector', name: '.tools', conversationId: 'convo-connectors' }, NAME_REFUSED);
  });

  test('saving a connector entry with nothing to run or reach is refused before any card', async () => {
    await refusedBeforeAnyCard(HOLDS_ALPHA, { type: 'save_connector', name: 'example-alpha', content: '{}', conversationId: 'convo-connectors' }, ENTRY_REFUSED);
  });

  test('saving a connector entry whose args hold null is refused before any card, naming args', async () => {
    const message = 'The connector entry\'s "args" isn\'t in a form the approval card can show exactly, so nothing was changed.';
    await refusedBeforeAnyCard(HOLDS_ALPHA, { type: 'save_connector', name: 'local-tools', content: '{"command":"node","args":[null]}', conversationId: 'convo-connectors' }, message);
  });

  test('saving a connector entry with args beside a URL and no command is refused before any card, naming args', async () => {
    const message = 'The connector entry\'s "args" isn\'t in a form the approval card can show exactly, so nothing was changed.';
    await refusedBeforeAnyCard(HOLDS_ALPHA, { type: 'save_connector', name: 'local-tools', content: '{"url":"https://mcp.example.com/mcp","args":["--token-file","x"]}', conversationId: 'convo-connectors' }, message);
  });

  test('a refusal goes to the window that asked and no other, and the usual next save asks and writes once allowed', async () => {
    fs.writeFileSync(mcp(), JSON.stringify({ mcpServers: {} }));
    const other = await h.connect();
    try {
      const otherSince = other.messages.length;
      let since = client.messages.length;
      client.send({ type: 'save_connector', name: '-tools', content: JSON.stringify(STDIO), conversationId: 'convo-connectors' });
      const { msg } = await client.waitFor(m => m.type === 'connector_error' || isAnyConnectorCard(m), { since, label: 'refusal to the asking window' });
      assert.deepStrictEqual({ type: msg.type, message: msg.message }, { type: 'connector_error', message: NAME_REFUSED });
      await h.delay(200);
      assert.deepStrictEqual(other.messages.slice(otherSince).filter(m => m.type === 'connector_error' || isAnyConnectorCard(m)), [],
        'another window hears nothing about a change refused for this one');

      since = client.messages.length;
      client.send({ type: 'save_connector', name: 'local-tools', content: JSON.stringify(STDIO), conversationId: 'convo-connectors' });
      const card = await client.waitFor(isConnectorCard('SaveConnector'), { since, label: 'card for the usual save' });
      assert.deepStrictEqual(card.msg.request.input, { name: 'local-tools', action: 'add', ...STDIO });
      since = client.messages.length;
      answer(card.msg, true);
      await client.waitFor(m => m.type === 'connector_saved', { since, label: 'usual save written' });
      assert.deepStrictEqual(servers(), { 'local-tools': STDIO }, 'written once allowed');
    } finally {
      other.close();
    }
  });
});
