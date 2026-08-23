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
const path = require('node:path');
const { JSDOM } = require('jsdom');

let chat, dom;
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
  global.RundockPermissions = require('../../public/permissions.js');
  chat = require('../../public/views/chat.js');
});
after(() => { if (dom) dom.window.close(); });

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
