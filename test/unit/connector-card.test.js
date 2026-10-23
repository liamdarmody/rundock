'use strict';
// THE CARD FOR AN AGENT'S CONNECTOR CHANGE, rendered by the real card code.
//
// The server raises it before writing `.mcp.json` for an agent's
// SAVE_CONNECTOR or DELETE_CONNECTOR marker (lib/protocol/handlers/team.js).
// It names the server and exactly what it would run, offers Allow and Deny
// only, and nothing already stored answers it.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');

let chat, dom, RP;
before(() => {
  dom = new JSDOM('<div id="messages"></div>');
  global.window = dom.window;
  global.document = dom.window.document;
  global.pendingPermissions = new Map();
  global.pendingPermissionsByConvo = new Map();
  global.alwaysAllowedTools = new Set();
  global.ws = { send() {} };
  global.userScrolledUp = false;
  global.esc = (t) => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };
  global.escAttr = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  RP = require('../../public/permissions.js');
  global.RundockPermissions = RP;
  global.RundockChatMarkup = require('../../public/chat-markup.js');
  global.serverPlatform = 'darwin';
  global.workspaceMode = 'knowledge';
  global.activeConversation = { id: 'convo-1' };
  chat = require('../../public/views/chat.js');
});
after(() => { if (dom) dom.window.close(); });

let seq = 0;
function ask(request, standing = []) {
  document.getElementById('messages').innerHTML = '';
  global.pendingPermissions.clear();
  chat.setStandingToolAllows(standing);
  chat.handlePermissionRequest({ request_id: `req-${++seq}`, request: { subtype: 'can_use_tool', ...request } }, 'convo-1');
  const html = document.getElementById('messages').innerHTML;
  chat.setStandingToolAllows([]);
  return html;
}
const STDIO = { tool_name: 'SaveConnector', input: { name: 'local-tools', action: 'add', command: 'node', args: ['tools/server.js', '--root', 'My Files'], env: ['NODE_OPTIONS'] } };
const HTTP = { tool_name: 'SaveConnector', input: { name: 'calendar', action: 'replace', url: 'https://mcp.example.com/mcp', transport: 'http', headers: ['Authorization'] } };
const REMOVE = { tool_name: 'DeleteConnector', input: { name: 'notion', action: 'remove', command: 'npx', args: ['-y', 'notion-mcp'] } };

describe('the card for an agent\'s connector change', () => {
  test('a stdio server is named, with the exact command it would run and what is set for it', () => {
    const html = ask(STDIO);
    assert.match(html, /Add the connector local-tools/);
    assert.match(html, /node tools\/server\.js --root 'My Files'/, 'the command and its arguments, quoted as a shell would need them');
    assert.match(html, /outside the sandbox/);
    assert.match(html, /NODE_OPTIONS/, 'and the environment it would be started with, by name');
  });

  test('a server at a URL is named by its URL', () => {
    const html = ask(HTTP);
    assert.match(html, /Change the connector calendar/);
    assert.match(html, /https:\/\/mcp\.example\.com\/mcp/);
    assert.match(html, /Authorization/);
  });

  test('a removal names what would stop', () => {
    const html = ask(REMOVE);
    assert.match(html, /Remove the connector notion/);
    assert.match(html, /npx -y notion-mcp/);
  });

  test('Allow and Deny only, and no saved answer stands in for the person', () => {
    for (const request of [STDIO, HTTP, REMOVE]) {
      const keys = [RP.toolAllowKey(request.tool_name, request.input), request.tool_name, `${request.tool_name}(*)`];
      const html = ask(request, keys);
      assert.match(html, /data-perm-action="allow"/, `${request.tool_name}: the card is shown, not answered from a saved allow`);
      assert.match(html, /data-perm-action="deny"/);
      assert.doesNotMatch(html, /data-perm-action="always"|data-perm-action="allow-folder"|>Always allow/, `${request.tool_name}: and nothing would be remembered`);
      assert.match(html, /there is no Always allow/, 'and the card says why');
      assert.strictEqual(RP.offersAlwaysAllow(RP.classifyRisk(request.tool_name, request.input)), false);
    }
  });
});
