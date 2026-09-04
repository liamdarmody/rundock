'use strict';
// The boundary permission card, rendered.
//
// The card is the whole point of this boundary: a Bash card asks whether to
// run a command, a boundary card asks whether to let an agent reach outside
// the workspace, and only the second is the containment promise. So what the
// card SAYS and what it OFFERS are the behaviour, not decoration.
//
// Two cases exist now that shell commands reach this card. A crossing with a
// known target can offer a standing folder grant. A crossing established by
// the runtime sandbox rather than by a path has no one folder it is about,
// and offering "Always allow this folder" there would be a button that
// remembers nothing.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');

let chat, hook, dom;
const made = [];
before(() => {
  dom = new JSDOM('<div id="messages"></div>');
  global.window = dom.window;
  global.document = dom.window.document;
  global.pendingPermissions = new Map();
  global.pendingPermissionsByConvo = new Map();
  global.alwaysAllowedTools = new Set();
  global.ws = null;
  global.userScrolledUp = false;
  global.esc = (t) => { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; };
  // The attribute escaper, copied character for character from app.js:223.
  // The card writes the request id through it rather than through esc().
  global.escAttr = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  global.RundockPermissions = require('../../public/permissions.js');
  // Pure markup builder respondPermission's resolved-card path renders
  // through; no DOM of its own, so it is safe to load under Node the same
  // way the real app loads it as a sibling <script>.
  global.RundockChatMarkup = require('../../public/chat-markup.js');
  chat = require('../../public/views/chat.js');
  hook = require('../../scripts/permission-hook.js');
});
after(() => {
  if (dom) dom.window.close();
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});
function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
}

function render(request) {
  document.getElementById('messages').innerHTML = '';
  global.pendingPermissions.clear();
  chat.renderPermissionCard({ request_id: 'req-1', request }, 'convo-1');
  return document.getElementById('messages').innerHTML;
}

describe('the boundary card', () => {
  test('a crossing with a known folder offers to remember that folder', () => {
    const html = render({
      tool_name: 'Bash', input: { command: 'touch /etc/probe' },
      boundary: true, resolved_path: '/etc/probe', grant_dir: '/etc',
    });
    assert.match(html, /Always allow this folder/, 'the standing grant is on offer');
    assert.strictEqual(global.pendingPermissions.get('req-1').grantDir, '/etc',
      'and the folder it would remember is carried, not invented at click time');
  });

  test('a crossing with NO folder does not offer to remember one', () => {
    // The runtime sandbox denied a command and it was retried with the
    // sandbox turned off. The operating system established the crossing; no
    // path did. respondPermission already drops a folder grant it has no
    // directory for, so the button would be silently inert: it would read as
    // "I have made a standing decision" and make none.
    const html = render({
      tool_name: 'Bash', input: { command: 'make install', dangerouslyDisableSandbox: true },
      boundary: true, resolved_path: null, grant_dir: null,
    });
    assert.doesNotMatch(html, /Always allow this folder/,
      'no standing-grant button when there is no folder to grant');
    assert.match(html, /Allow/, 'the one-off decision is still available');
    assert.match(html, /Deny/);
  });

  test('a shell crossing says it reaches outside, not that it writes', () => {
    // The sandbox refuses reads and network hosts as well as writes, and the
    // retry that lands here does not say which. Naming the specific act would
    // be a guess printed as a fact.
    const html = render({
      tool_name: 'Bash', input: { command: 'make install', dangerouslyDisableSandbox: true },
      boundary: true, resolved_path: null, grant_dir: null,
    });
    assert.match(html, /reach outside your workspace/,
      'the summary names the crossing without claiming which act it is');
    assert.doesNotMatch(html, /Wants to write outside/);
  });

  test('a command reaching several places names all of them', () => {
    // A card that shows one target while the command reaches three is the
    // same defect as no card: the person approves what they can see. The
    // first is what a standing grant would be about, so it stays the headline
    // target, and the rest are listed rather than dropped.
    const html = render({
      tool_name: 'Bash', input: { command: 'cp a ~/Exports/a && cp k ~/.ssh/k' },
      boundary: true, resolved_path: '/home/u/Exports/a', grant_dir: null,
      crossings: [{ path: '/home/u/Exports/a' }, { path: '/home/u/.ssh/k' }],
    });
    assert.match(html, /\/home\/u\/Exports\/a/, 'the first target is shown');
    assert.match(html, /\/home\/u\/\.ssh\/k/, 'and so is the second');
  });

  test('the list of places is visible, not folded behind a toggle labelled as the command', () => {
    // Bash cards collapse a long detail behind "Show command", which is right
    // for a command string and wrong for this: the card says all the places
    // are listed while hiding them, and an inline code element renders the
    // newlines between them as spaces, so they run together on one line.
    const html = render({
      tool_name: 'Bash',
      input: { command: 'cp a ~/Exports/a && cp k ~/.ssh/k', description: 'Copy two files to two different places outside the workspace' },
      boundary: true, resolved_path: '/home/u/Exports/quarterly-report-final.md', grant_dir: null,
      crossings: [
        { path: '/home/u/Exports/quarterly-report-final.md' },
        { path: '/home/u/.ssh/id_rsa_deployment_key' },
      ],
    });
    // Long enough to cross the collapse threshold, which is the only state
    // where the toggle appears at all.
    assert.doesNotMatch(html, /Show command/, 'the places are not hidden behind a toggle');
    assert.match(html, /quarterly-report-final\.md/);
    assert.match(html, /id_rsa_deployment_key/);
    assert.match(html, /<br|<div|\n/, 'and they are on separate lines rather than run together');
  });

  test('a single crossing is not dressed up as a list', () => {
    const html = render({
      tool_name: 'Write', input: { file_path: '/etc/x' },
      boundary: true, resolved_path: '/etc/x', grant_dir: '/etc',
      crossings: [{ path: '/etc/x', grantDir: '/etc' }],
    });
    assert.doesNotMatch(html, /and 0 more|also reaches/i);
  });

  test('a shell card never offers to remember a folder, whatever it reaches', () => {
    // The server never sends a folder for a shell request, because a folder
    // grant and a command approval answer different questions: the grant says
    // an agent may touch that folder, and approving here says this command
    // may run. Everything in the command runs, not only the part that touches
    // the folder, so remembering the folder would retire a per-command card
    // on the strength of a decision nobody made.
    for (const command of ['cp a ~/Exports/a', 'rm -rf * ; touch ~/Exports/x']) {
      const html = render({
        tool_name: 'Bash', input: { command },
        boundary: true, resolved_path: '/home/u/Exports/a', grant_dir: null,
        crossings: [{ path: '/home/u/Exports/a' }],
      });
      assert.doesNotMatch(html, /Always allow this folder/, command);
      assert.match(html, /Allow/, 'the one-off decision is still there');
    }
  });

  test('a file crossing still says read or write, because there the act is known', () => {
    const wHtml = render({ tool_name: 'Write', input: { file_path: '/etc/x' }, boundary: true, resolved_path: '/etc/x', grant_dir: '/etc' });
    assert.match(wHtml, /write outside your workspace/);
    const rHtml = render({ tool_name: 'Read', input: { file_path: '/etc/x' }, boundary: true, resolved_path: '/etc/x', grant_dir: '/etc' });
    assert.match(rHtml, /read outside your workspace/);
  });
});

// The wiring between two already-tested ends: the hook's sensitiveEnrichment
// (unit-tested in workspace-boundary.test.js) and the copy table
// (unit-tested in the same file) meet here, in renderPermissionCard and
// respondPermission. Neither end proves the join: the card could render the
// ordinary copy, drop the narrow button, or send the wrong grantDir with
// both suites green.
describe('the sensitive crossing, rendered and answered', () => {
  // Built the way the hook actually builds it, not a hand-written stand-in:
  // a real .claude/projects/<flattened> entry on disk is what makes
  // sensitiveEnrichment return a narrowGrantDir at all.
  function sensitiveCrossing(prefix) {
    const home = tmp(`card-sens-home-${prefix}-`);
    const ws = tmp(`card-sens-ws-${prefix}-`);
    const flattened = path.resolve(ws).replace(/[^A-Za-z0-9-]/g, '-');
    fs.mkdirSync(path.join(home, '.claude', 'projects', flattened), { recursive: true });
    const crossingPath = path.join(home, '.claude', 'settings.json');
    const enrichment = hook.sensitiveEnrichment(crossingPath, ws, home);
    assert.ok(enrichment && enrichment.sensitive === 'claude-home' && enrichment.narrowGrantDir,
      'fixture sanity: the hook must actually derive a narrow grant here, or the test below proves nothing');
    return { crossingPath, grantDir: path.dirname(crossingPath), enrichment };
  }

  test('a file crossing renders the table\'s stakes copy and a narrow-grant button beside the folder grant', () => {
    const { crossingPath, grantDir, enrichment } = sensitiveCrossing('file');
    const html = render({
      tool_name: 'Read', input: { file_path: crossingPath },
      boundary: true, resolved_path: crossingPath, grant_dir: grantDir,
      crossings: [{ path: crossingPath, grantDir, ...enrichment }],
    });
    assert.match(html, /permission-context">This is the runtime.s own home folder/, 'the rendered context is the table\'s copy, not the ordinary one');
    assert.match(html, /\.credentials\.json/);
    assert.match(html, /data-perm-action="allow-transcripts">Allow this workspace.s transcripts only</,
      'the narrow button carries the table\'s own label and action');
    assert.match(html, /data-perm-action="allow-folder"/, 'the whole-folder grant is demoted, not removed');
  });

  test('answering the narrow button sends its grantDir; plain allow and deny send none', () => {
    function pressAndCapture(action) {
      const { crossingPath, grantDir, enrichment } = sensitiveCrossing(`press-${action}`);
      document.getElementById('messages').innerHTML = '';
      global.pendingPermissions.clear();
      chat.renderPermissionCard({ request_id: `req-${action}`, request: {
        tool_name: 'Read', input: { file_path: crossingPath },
        boundary: true, resolved_path: crossingPath, grant_dir: grantDir,
        crossings: [{ path: crossingPath, grantDir, ...enrichment }],
      } }, 'convo-1');
      const sent = [];
      global.ws = { send: (s) => sent.push(JSON.parse(s)) };
      try {
        document.querySelector(`[data-perm-action="${action}"]`).click();
      } finally {
        global.ws = null;
      }
      assert.strictEqual(sent.length, 1, `the ${action} control sends exactly one response`);
      return { sent: sent[0], narrowGrantDir: enrichment.narrowGrantDir };
    }
    const narrow = pressAndCapture('allow-transcripts');
    assert.strictEqual(narrow.sent.grantDir, narrow.narrowGrantDir, 'the narrow folder travels as the ordinary grantDir field');
    const allow = pressAndCapture('allow');
    assert.strictEqual('grantDir' in allow.sent, false, 'plain Allow remembers nothing');
    const deny = pressAndCapture('deny');
    assert.strictEqual('grantDir' in deny.sent, false, 'Deny remembers nothing');
  });

  test('a shell crossing into the same sensitive path states the stakes but offers no narrow or folder grant', () => {
    const { crossingPath, enrichment } = sensitiveCrossing('shell');
    const html = render({
      tool_name: 'Bash', input: { command: `cat ${crossingPath}` },
      boundary: true, resolved_path: crossingPath, grant_dir: null,
      // The hook never attaches grantDir to a shell crossing (see the
      // "never offers to remember a folder" test above); the sensitive
      // enrichment still applies to the path, which is exactly the case
      // this guards.
      crossings: [{ path: crossingPath, ...enrichment }],
    });
    assert.match(html, /This is the runtime.s own home folder/, 'the stakes are still stated');
    assert.doesNotMatch(html, /Always allow this folder/, 'a shell request never carries a standing folder grant');
    assert.doesNotMatch(html, /data-perm-action="allow-transcripts"/, 'nor a narrow one: both are folder grants a command cannot be answered by');
  });
});
