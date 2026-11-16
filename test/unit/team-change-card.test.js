'use strict';
// THE CARD FOR A CHANGE DOC MAKES WHILE ANOTHER AGENT BROUGHT IT IN, rendered
// by the real card code.
//
// The server raises it before Doc's SAVE_AGENT, DELETE_AGENT, SAVE_SKILL or
// DELETE_SKILL marker is written in a hand-off (lib/agents/team-markers.js).
// It says whether the agent or skill is added, replaced or deleted, who
// brought Doc in, and for a save the whole file that would be written. It
// offers Allow and Deny only, and nothing already stored answers it.
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
const summaryOf = (html) => (html.match(/<span class="permission-summary">([\s\S]*?)<\/span>/) || [])[1] || '';
const contextOf = (html) => (html.match(/<div class="permission-context">([\s\S]*?)<\/div>/) || [])[1] || '';
const detailOf = (html) => (html.match(/<details class="permission-detail-collapse" open="">[\s\S]*?<\/details>/) || [])[0] || '';

const FILE = '---\nname: helper\ndisplayName: Helper\nrole: Example Role\ndescription: An example agent\ntype: specialist\norder: 7\n---\n\nYou are Helper.\n  Keep this indent.';
const ADD = { tool_name: 'SaveAgent', input: { kind: 'agent', action: 'add', name: 'helper', file: '.claude/agents/helper.md', by: 'Cos', content: FILE } };
const REPLACE = { tool_name: 'SaveSkill', input: { kind: 'skill', action: 'replace', name: 'notes', file: '.claude/skills/notes/SKILL.md', by: 'Wren', content: '---\nname: notes\n---\n\nTake notes.' } };
const DELETE_AGENT = { tool_name: 'DeleteAgent', input: { kind: 'agent', action: 'delete', name: 'helper', file: '.claude/agents/helper.md', by: 'Cos' } };
const DELETE_SKILL = { tool_name: 'DeleteSkill', input: { kind: 'skill', action: 'delete', name: 'notes', file: '.claude/skills/notes', by: 'Cos' } };
const ALL = [ADD, REPLACE, DELETE_AGENT, DELETE_SKILL];

describe('the card for a change Doc makes in a hand-off', () => {
  test('each of the four is graded high, as a connector change is', () => {
    for (const request of ALL) {
      assert.strictEqual(RP.classifyRisk(request.tool_name, request.input), 'high', request.tool_name);
    }
    assert.strictEqual(RP.classifyRisk('SaveConnector', {}), 'high', 'beside the connector change');
  });

  test('Allow and Deny only, and no saved answer stands in for the person', () => {
    for (const request of ALL) {
      const keys = [RP.toolAllowKey(request.tool_name, request.input), request.tool_name, `${request.tool_name}(*)`];
      assert.deepStrictEqual(RP.decidePermission(RP.classifyRisk(request.tool_name, request.input), keys[0], new Set(keys)), { action: 'card' },
        `${request.tool_name}: a standing allow for its name does not answer it`);
      const html = ask(request, keys);
      assert.match(html, /data-perm-action="allow"/, `${request.tool_name}: the card is shown, not answered from a saved allow`);
      assert.match(html, /data-perm-action="deny"/);
      assert.doesNotMatch(html, /data-perm-action="always"|data-perm-action="allow-folder"|>Always allow/, `${request.tool_name}: and nothing would be remembered`);
      assert.match(contextOf(html), /there is no Always allow/, 'and the card says why');
      assert.strictEqual(RP.offersAlwaysAllow(RP.classifyRisk(request.tool_name, request.input)), false);
    }
  });

  test('a save names the kind, the action, the name and who brought Doc in, in words a person reads', () => {
    const html = ask(ADD);
    assert.strictEqual(summaryOf(html), 'Add the agent helper');
    assert.strictEqual(contextOf(html), 'Cos brought Doc in, and Doc asked Rundock to add this agent (.claude/agents/helper.md). '
      + 'Agents follow their instructions every time they run, so check what would be written before you allow it. '
      + 'Rundock asks about every change Doc makes when another agent brought it in, so there is no Always allow.');
    assert.strictEqual(summaryOf(ask(REPLACE)), 'Replace the skill notes');
    assert.match(contextOf(ask(REPLACE)), /^Wren brought Doc in, and Doc asked Rundock to replace this skill \(\.claude\/skills\/notes\/SKILL\.md\)\./);
  });

  test('a delete names what would go', () => {
    for (const [request, summary, sentence] of [
      [DELETE_AGENT, 'Delete the agent helper', 'Cos brought Doc in, and Doc asked Rundock to delete this agent (.claude/agents/helper.md).'],
      [DELETE_SKILL, 'Delete the skill notes', 'Cos brought Doc in, and Doc asked Rundock to delete this skill (.claude/skills/notes).'],
    ]) {
      const html = ask(request);
      assert.strictEqual(summaryOf(html), summary);
      assert.ok(contextOf(html).startsWith(sentence), contextOf(html));
      assert.match(detailOf(html), /What would be deleted/);
    }
  });

  test('the whole file is shown, open, with nothing clipped and its lines and indents kept', () => {
    const long = `${FILE}\n${Array.from({ length: 300 }, (_, n) => `Line ${n} of the instructions.`).join('\n')}`;
    const html = ask({ ...ADD, input: { ...ADD.input, content: long } });
    const detail = detailOf(html);
    assert.ok(detail, 'the file is in the disclosure, open, where it is not clipped');
    assert.match(detail, /What would be written/);
    assert.match(detail, /class="permission-detail permission-file"/, 'drawn with its line breaks and spaces kept');
    assert.ok(detail.includes('Line 299 of the instructions.'), 'down to the last line');
    assert.ok(detail.includes('\n  Keep this indent.'), 'each line and indent as written');
    assert.strictEqual(RP.describeToolRequest('SaveAgent', ADD.input).detail, FILE, 'the detail is the content, byte for byte');
  });

  // A CONTROL CHARACTER IS SHOWN, NEVER ACTED ON. Line breaks and tabs are the
  // file's own and are kept; a character that hides or reorders text is shown
  // by its escape. Made from code points, so this file holds none of them.
  test('a character that reorders or hides text is shown by its code', () => {
    const RIGHT_TO_LEFT_OVERRIDE = String.fromCharCode(0x202e);
    const NUL = String.fromCharCode(0);
    const detail = RP.describeToolRequest('SaveAgent', { ...ADD.input, content: `a${RIGHT_TO_LEFT_OVERRIDE}b\n\tc${NUL}d` }).detail;
    assert.strictEqual(detail, 'a\\u202eb\n\tc\\u0000d');
    const named = RP.describeToolRequest('DeleteAgent', { ...DELETE_AGENT.input, by: `Cos${RIGHT_TO_LEFT_OVERRIDE}` });
    assert.ok(named.context.startsWith('Cos\\u202e brought Doc in'), named.context);
  });
});
