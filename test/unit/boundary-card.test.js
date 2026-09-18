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
  // The attribute escaper, copied character for character from app.js:223.
  // The card writes the request id through it rather than through esc().
  global.escAttr = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  global.RundockPermissions = require('../../public/permissions.js');
  // Pure markup builder respondPermission's resolved-card path renders
  // through; no DOM of its own, so it is safe to load under Node the same
  // way the real app loads it as a sibling <script>.
  global.RundockChatMarkup = require('../../public/chat-markup.js');
  // The host and the mode, which nameTheFolderHint reads. Defaulted to the
  // combination the sentence is written for, so every existing test keeps
  // asserting the text it was written against.
  global.serverPlatform = 'darwin';
  global.workspaceMode = 'knowledge';
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
    // ASSERTED AS "the places are outside the toggle", not as "there is no
    // toggle". The earlier version checked that "Show command" was absent, which
    // was a stand-in: the only way a toggle could appear was by folding the
    // paths into it. A card may now carry a toggle holding the COMMAND while the
    // places stay in the open, and that is the shape this test should permit,
    // because what it exists to protect is that the places are readable.
    const beforeToggle = html.split('<details')[0];
    assert.match(beforeToggle, /quarterly-report-final\.md/,
      'the places are in the open, not folded away');
    assert.match(beforeToggle, /id_rsa_deployment_key/);
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

// The wiring between two already-tested ends: the hook's tagging
// (agentHomeTags) and the copy table meet here, in renderPermissionCard and
// respondPermission. Neither end proves the join on its own.
// The card is where being outside the workspace is actually felt. A person
// meeting it thirty times in one build has a setting that would end it, and
// no way to learn that from here unless the card says so.
describe('the card names the setting that would stop it asking', () => {
  test('an ordinary outside crossing points at the working folders setting', () => {
    const html = render({
      tool_name: 'Bash', input: { command: 'npm run build' },
      boundary: true, resolved_path: '/home/u/Projects/alchemist', grant_dir: null,
    });
    assert.match(html, /name the folder in Settings under Workspace/,
      'the answer to meeting this repeatedly is named where it is met');
  });

  test('it appears on a file crossing and on a multi-place command alike', () => {
    const fileCard = render({
      tool_name: 'Write', input: { file_path: '/home/u/Projects/x/a.js' },
      boundary: true, resolved_path: '/home/u/Projects/x/a.js', grant_dir: '/home/u/Projects/x',
    });
    assert.match(fileCard, /name the folder in Settings under Workspace/);
    const multi = render({
      tool_name: 'Bash', input: { command: 'cp a b' },
      boundary: true, resolved_path: null, grant_dir: null,
      crossings: [{ path: '/home/u/Projects/a' }, { path: '/home/u/Projects/b' }],
    });
    assert.match(multi, /reaches more than one place/, 'the existing warning survives');
    assert.match(multi, /name the folder in Settings under Workspace/, 'and the hint is composed with it');
  });

  // THE OPERATING-SYSTEM SENTENCE IS ABOUT A DIFFERENT CARD, and a reader who
  // does not know that concludes the mode switch is broken.
  //
  // Reported from the field: in Code mode, a card for `cat ../.mcp.json` (a
  // genuine crossing, one level above the workspace) carried the sentence
  // "Code mode is where those end" while the reader was sitting in Code mode
  // holding the card. The decision was right and the copy made it look wrong.
  //
  // In Code mode the sandbox is off, so this card IS the whole boundary and
  // naming the folder is the only remedy there is. Pinned to appear in one
  // combination and no other, because a conditional caveat that stops
  // appearing when its condition is miscomputed disappears in silence.
  describe('the operating-system sentence appears only where it is true', () => {
    const crossing = {
      tool_name: 'Bash', input: { command: 'cat ../.mcp.json' },
      boundary: true, resolved_path: '/home/u/Rundock/.mcp.json', grant_dir: null,
    };
    const OS_SENTENCE = /Code mode is where those end/;
    const BASE = /name the folder in Settings under Workspace/;

    function withEnv(platform, mode, fn) {
      const p = global.serverPlatform, m = global.workspaceMode;
      global.serverPlatform = platform; global.workspaceMode = mode;
      try { return fn(); } finally { global.serverPlatform = p; global.workspaceMode = m; }
    }

    test('Knowledge mode on macOS: the sentence is shown, because there it is the missing half', () => {
      const html = withEnv('darwin', 'knowledge', () => render(crossing));
      assert.match(html, BASE, 'the remedy is always named');
      assert.match(html, OS_SENTENCE, 'and so is the card the reader has not met yet');
    });

    test('Code mode on macOS: the remedy stays, the sentence goes', () => {
      const html = withEnv('darwin', 'code', () => render(crossing));
      assert.match(html, BASE, 'naming the folder is still the answer, and in Code mode it is the ONLY answer');
      assert.doesNotMatch(html, OS_SENTENCE,
        'telling a reader in Code mode that Code mode ends this, on a card Code mode did not end, reads as a broken switch');
    });

    test('off macOS the sentence never appears, in either mode', () => {
      for (const mode of ['knowledge', 'code']) {
        for (const platform of ['win32', 'linux']) {
          const html = withEnv(platform, mode, () => render(crossing));
          assert.match(html, BASE, `the remedy still applies on ${platform} in ${mode} mode`);
          assert.doesNotMatch(html, OS_SENTENCE,
            `there is no sandbox on ${platform}, so there is no such card to warn about`);
        }
      }
    });

    test('an unknown platform says less rather than guessing', () => {
      // serverPlatform is null until the server says otherwise, and a card can
      // render in that window. Claiming the macOS behaviour before knowing the
      // host would be a guess shown as a fact.
      const html = withEnv(null, 'knowledge', () => render(crossing));
      assert.match(html, BASE);
      assert.doesNotMatch(html, OS_SENTENCE, 'not yet known is not the same as darwin');
    });
  });

  test('it is NOT offered on a sandbox-retry card, which carries no path to name', () => {
    // THE CARD THE REPORTED USER ACTUALLY MEETS in the default mode on macOS.
    // The operating system established this crossing, not a target the hook
    // could read, so there is no path here to compare against a named folder,
    // and the OS write block is unchanged by naming one. A reader who has
    // ALREADY named the folder would meet this card and be told to name it,
    // which is the same false advice the runtime-home branch avoids.
    const html = render({
      tool_name: 'Bash', input: { command: 'make install', dangerouslyDisableSandbox: true },
      boundary: true, resolved_path: null, grant_dir: null,
    });
    assert.doesNotMatch(html, /name the folder in Settings under Workspace/);
    // AND IT SAYS WHAT IS ACTUALLY HAPPENING. Silence here is what sends a
    // reader to the setting that cannot help them: the operating system refused
    // this write, not a path check, so the card names the refusal and the one
    // switch that ends it.
    assert.match(html, /operating system refusing a write outside your workspace/i);
    assert.match(html, /Naming a working folder does not change it/i);
    assert.match(html, /Code mode is where these end/i);
  });

  test('it is NOT offered for a runtime-home crossing, where naming a folder changes nothing', () => {
    // The one place the advice would be false. The secrets tier and the
    // persistence surfaces are unmoved by any named folder, so pointing at the
    // setting here would be an instruction that quietly does nothing, which is
    // worse than saying nothing at all.
    const crossingPath = '/home/u/.claude/.credentials.json';
    const html = render({
      tool_name: 'Read', input: { file_path: crossingPath },
      boundary: true, resolved_path: crossingPath, grant_dir: null,
      crossings: [{ path: crossingPath, secret: true, agentHome: true }],
    });
    assert.doesNotMatch(html, /name the folder in Settings under Workspace/);
  });
});

describe('a crossing into the agent\'s own folder, rendered and answered', () => {
  test('a secrets-tier crossing renders the copy naming the stakes, offers no folder grant, and answering sends no grantDir', () => {
    const crossingPath = '/home/u/.claude/.credentials.json';
    // grant_dir is truthy, as if the server had sent one by mistake, so this
    // exercises the card's OWN secret gate rather than an absent grant.
    const request = {
      tool_name: 'Read', input: { file_path: crossingPath },
      boundary: true, resolved_path: crossingPath, grant_dir: '/home/u/.claude',
      crossings: [{ path: crossingPath, grantDir: '/home/u/.claude', secret: true, agentHome: true }],
    };
    const html = render(request);
    assert.match(html, /permission-context">This is the credential file/, 'the rendered context is the secret\'s own copy, not the ordinary one');
    assert.match(html, /cannot be undone/);
    assert.doesNotMatch(html, /data-perm-action="allow-folder"/,
      'no grant may suppress a secrets-tier card, so the whole-folder grant is removed, not merely demoted');

    const sent = [];
    global.ws = { send: (s) => sent.push(JSON.parse(s)) };
    try {
      document.querySelector('[data-perm-action="allow"]').click();
    } finally {
      global.ws = null;
    }
    assert.strictEqual('grantDir' in sent[0], false, 'no folder is remembered for a secrets-tier crossing, however it was answered');
  });

  test('a persistence-surface write renders the persistence copy and still offers the ordinary folder grant', () => {
    const crossingPath = '/home/u/.claude/agents/new.md';
    const html = render({
      tool_name: 'Write', input: { file_path: crossingPath },
      boundary: true, resolved_path: crossingPath, grant_dir: '/home/u/.claude/agents',
      crossings: [{ path: crossingPath, grantDir: '/home/u/.claude/agents', persistenceSurface: true, agentHome: true }],
    });
    assert.match(html, /permission-context">Writing here persists/, 'the persistence stakes are named');
    assert.match(html, /Always allow this folder/,
      'unlike a secret, an ordinary persistence-surface write may still be remembered for a folder');
  });

  test('a command reaching more than one place composes the multi-crossing warning with the stakes copy, rather than one replacing the other', () => {
    const taggedPath = '/home/u/.claude/commands/new.md';
    const plainPath = '/etc/hosts';
    const html = render({
      tool_name: 'Bash', input: { command: `cp a ${taggedPath} && cp b ${plainPath}` },
      boundary: true, resolved_path: taggedPath, grant_dir: null,
      crossings: [
        { path: taggedPath, agentHome: true, persistenceSurface: true },
        { path: plainPath },
      ],
    });
    assert.match(html, /reaches more than one place outside your workspace/,
      'the multi-crossing fact survives: every listed place is still what approving allows');
    assert.match(html, /persists/, 'and the persistence-surface stakes are stated alongside it, not instead of it');
  });

  test('a shell crossing into a persistence surface states the stakes but offers no folder grant, secret or not', () => {
    for (const [tag, needle] of [[{ secret: true }, /cannot be undone/], [{ persistenceSurface: true }, /persists/]]) {
      const crossingPath = tag.secret ? '/home/u/.claude/.credentials.json' : '/home/u/.claude/agents/new.md';
      const html = render({
        tool_name: 'Bash', input: { command: `cat ${crossingPath}` },
        boundary: true, resolved_path: crossingPath, grant_dir: null,
        // The hook never attaches grantDir to a shell crossing; the tags
        // still apply to the path.
        crossings: [{ path: crossingPath, agentHome: true, ...tag }],
      });
      assert.match(html, needle, 'the stakes are still stated for a shell crossing');
      assert.doesNotMatch(html, /Always allow this folder/, 'a shell request never carries a standing folder grant, for either tier');
    }
  });
});

describe('the card for the file that records permission answers', () => {
  test('shows copy naming what the file governs, through the real card path', () => {
    // The helper returning the right sentence is not the same as the card
    // showing it: the wiring between them is a line of its own and was the
    // only thing carrying it.
    const html = render({
      tool_name: 'Write', input: { file_path: '/ws/.claude/settings.local.json' },
      boundary: true, resolved_path: '/ws/.claude/settings.local.json', grant_dir: null,
      crossings: [{ path: '/ws/.claude/settings.local.json', grantDir: null, answerFile: true }],
    });
    assert.match(html, /what agents may do/, 'the card says what the file governs');
    assert.match(html, /every time/, 'and that this one keeps asking');
  });

  test('offers no standing grant, even when another place in the same request would', () => {
    // A request can reach several places at once. With the ordinary crossing
    // first, the folder button would still have been offered, and one click
    // would grant lasting authority over the mechanism that stores the answers.
    const html = render({
      tool_name: 'Bash', input: { command: 'touch /etc/probe && echo x > /ws/.claude/settings.local.json' },
      boundary: true, resolved_path: '/etc/probe', grant_dir: '/etc',
      crossings: [
        { path: '/etc/probe', grantDir: '/etc' },
        { path: '/ws/.claude/settings.local.json', grantDir: null, answerFile: true },
      ],
    });
    assert.doesNotMatch(html, /Always allow this folder/,
      'no folder button while an answer file is among the places being reached');
  });
});

// A write to the workspace's own answer files always asks and can never be
// remembered. It used to get that behaviour by being classified as a boundary
// crossing, which was the only classification that forced both, so the card
// announced that the workspace had been left above a path plainly inside it.
// The behaviour was right and its stated reason was false, which on a security
// prompt is worse than it sounds: a card that misstates why it is asking
// devalues every other card.
describe('the answer-file card', () => {
  const WRITE = {
    tool_name: 'Write',
    input: { file_path: '/ws/.claude/settings.local.json' },
    answer_file: true,
    resolved_path: '/ws/.claude/settings.local.json',
    grant_dir: null,
  };

  test('it names the stake instead of claiming the workspace was left', () => {
    const html = render(WRITE);
    assert.match(html, /Wants to change what agents are allowed to do/,
      'the heading says what the request would actually do');
    assert.doesNotMatch(html, /outside your workspace/,
      'this file is inside the workspace and the card must not say otherwise');
  });

  test('it still says why it can never be remembered', () => {
    const html = render(WRITE);
    assert.match(html, /holds your own answers/, 'the reason survives the reclassification');
    assert.match(html, /no option to stop being asked/);
  });

  // Asserted on the CONTROL, not on one label. The first version of this test
  // checked only "Always allow this folder" and passed, while the plain
  // "Always allow" button rendered right next to it: the guarantee had a second
  // door and the test was watching the first.
  test('it offers no standing grant of any kind', () => {
    const html = render(WRITE);
    assert.doesNotMatch(html, /data-perm-action="always"/,
      'no standing-allow control may render for a file that must ask every time');
    assert.doesNotMatch(html, /Always allow/,
      'and no wording of one either, folder-scoped or tool-scoped');
    assert.match(html, /data-perm-action="allow"/, 'a one-time allow is still offered');
  });

  test('it names the file, so the reader knows which one', () => {
    assert.match(render(WRITE), /settings\.local\.json/);
  });

  // The same file reached by a shell redirect. The command grader still calls
  // it a crossing, so the heading is decided from the crossings themselves.
  test('a shell redirect into it reads the same way, not as a crossing', () => {
    const html = render({
      tool_name: 'Bash', input: { command: "echo '{}' > /ws/.claude/settings.local.json" },
      boundary: true, resolved_path: '/ws/.claude/settings.local.json', grant_dir: null,
      crossings: [{ path: '/ws/.claude/settings.local.json', answerFile: true }],
    });
    assert.match(html, /Wants to change what agents are allowed to do/);
    assert.doesNotMatch(html, /outside your workspace/);
  });

  // But a command that touches one of these AND somewhere genuinely outside HAS
  // left the workspace, and that is the more urgent fact to lead with.
  test('a command that also reaches outside still says so', () => {
    const html = render({
      tool_name: 'Bash', input: { command: "cp /etc/hosts /ws/.claude/settings.local.json" },
      boundary: true, resolved_path: '/etc/hosts', grant_dir: '/etc',
      crossings: [
        { path: '/ws/.claude/settings.local.json', answerFile: true },
        { path: '/etc/hosts', grantDir: '/etc' },
      ],
    });
    assert.match(html, /outside your workspace/,
      'a real crossing in the same command is the headline');
  });

  // AF-3 at the decision path, not at the button. A key stored from an
  // unrelated Write or Edit approval lives in the session's always-allowed set,
  // and decidePermission would have answered this request from it without a
  // card ever rendering. Suppressing the button alone would have left that door
  // open, and it is the quieter of the two.
  // handlePermissionRequest routes on whether the conversation is on screen,
  // which renderPermissionCard (used by render() above) never asks about.
  function ask(requestId, request) {
    global.activeConversation = { id: 'convo-1' };
    document.getElementById('messages').innerHTML = '';
    global.pendingPermissions.clear();
    chat.handlePermissionRequest({ request_id: requestId, request }, 'convo-1');
    return document.getElementById('messages').innerHTML;
  }

  test('a stored always-allow for the same tool cannot answer it', () => {
    document.getElementById('messages').innerHTML = '';
    global.pendingPermissions.clear();
    // Whatever key an ordinary Write approval would have stored.
    const key = RundockPermissions.toolAllowKey('Write', { file_path: '/ws/notes.md' });
    chat.setStandingToolAllows([key, 'Write', 'Write(*)']);
    const html = ask('req-af', WRITE);
    assert.match(html, /Wants to change what agents are allowed to do/,
      'the card must still be shown: this question is never pre-answered');
    assert.doesNotMatch(html, /data-perm-action="always"/);
    chat.setStandingToolAllows([]);
  });

  test('asking twice asks twice', () => {
    for (const n of ['first', 'second']) {
      assert.match(ask(`req-${n}`, WRITE), /Wants to change what agents are allowed to do/,
        `the ${n} identical write must ask`);
    }
  });

  // The case whose mechanism this borrowed. Asserted in the same file so the
  // two cannot drift apart: fixing one must not capture the other.
  test('a genuine crossing still reads as one', () => {
    const html = render({
      tool_name: 'Write', input: { file_path: '/etc/probe' },
      boundary: true, resolved_path: '/etc/probe', grant_dir: '/etc',
      crossings: [{ path: '/etc/probe', grantDir: '/etc' }],
    });
    assert.match(html, /outside your workspace/, 'a real crossing still says so');
    assert.doesNotMatch(html, /Wants to change what agents are allowed to do/);
  });
});

// A SHELL CARD SHOWS THE COMMAND, not only the place it reached.
//
// The single-crossing branch used to overwrite `detail` with the resolved path,
// and for a Bash request `detail` WAS the command. So the card asked for
// approval of a shell command while showing only a folder. Found by the owner
// meeting one: a card naming the folder above his workspace, for a command he
// could not see, which he correctly judged made no sense and could not verify.
describe('a boundary card for a command', () => {
  const REQ = {
    tool_name: 'Bash',
    input: { command: 'cd /ws && ls -la && echo --- && ls ..' },
    boundary: true,
    resolved_path: '/Users/x/Documents/Rundock',
    grant_dir: '/Users/x/Documents/Rundock',
    crossings: [{ path: '/Users/x/Documents/Rundock', grantDir: '/Users/x/Documents/Rundock' }],
  };

  test('the place it reaches is named', () => {
    assert.match(render(REQ), /Documents\/Rundock/);
  });

  test('and the command is still there to read', () => {
    const html = render(REQ);
    assert.match(html, /Show command/, 'the command is reachable');
    assert.match(html, /ls \.\./, 'and it is the command, not a summary of it');
  });

  // The first fix covered the single-crossing branch only, so a card listing
  // several paths still threw the command away. Both branches, pinned together.
  test('a command reaching several places shows all of them AND the command', () => {
    const html = render({
      tool_name: 'Bash',
      input: { command: 'ls /Users/.claude/skills/design-content /Users/.claude/skills/design-export' },
      boundary: true, resolved_path: '/Users/.claude/skills/design-content', grant_dir: null,
      crossings: [
        { path: '/Users/.claude/skills/design-content' },
        { path: '/Users/.claude/skills/design-export' },
      ],
    });
    assert.match(html, /design-content/, 'every place is listed');
    assert.match(html, /design-export/);
    assert.match(html, /Show command/, 'and the command that built those paths is readable');
    assert.match(html, /ls \/Users\/\.claude/);
  });

  test('a file tool keeps its path and offers no command', () => {
    const html = render({
      tool_name: 'Write', input: { file_path: '/etc/probe' },
      boundary: true, resolved_path: '/etc/probe', grant_dir: '/etc',
      crossings: [{ path: '/etc/probe', grantDir: '/etc' }],
    });
    assert.match(html, /\/etc\/probe/);
    assert.doesNotMatch(html, /Show command/, 'there is no command to show for a file tool');
  });
});
