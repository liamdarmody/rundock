'use strict';
// Four small cards, one bar: what the client renders is styled, escaped and
// operable the same way everywhere.
//
// The deferred client findings are each fixed or closed here with the closing
// fact proven rather than narrated; the layout-ownership gate gets its
// specimen; callout bodies and instruction cards render through the one
// markdown pipeline the file viewer uses; and the escaping decision is made
// once, in the one helper every view shares.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { makeRenderer } = require('../helpers/markdown-harness.js');

const ROOT = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const APP_SRC = read('public', 'app.js');
const PROFILE_SRC = read('public', 'views', 'profile.js');
const SKILLS_SRC = read('public', 'views', 'skills.js');
const PANEL_SRC = read('public', 'views', 'routines-panel.js');
const ROUTINES_SRC = read('public', 'views', 'routines.js');
const ROUTINES_MODEL_SRC = read('public', 'routines-model.js');
const EDITOR_MODEL_SRC = read('public', 'routine-editor-model.js');
const SKILLS_MODEL_SRC = read('public', 'skills-model.js');
const SCOPE_MODEL_SRC = read('public', 'routines-scope-model.js');
const EDITOR_CSS = read('public', 'styles', 'views', 'editor.css');

const { renderMarkdown } = makeRenderer();

function appPiece(pattern, label) {
  const m = APP_SRC.match(pattern);
  assert.ok(m && m[1] && m[1].trim(), `app.js no longer carries ${label}`);
  return m[1];
}

// The one escaper, cut out of the shell and run, so what is asserted is the
// helper every view shares rather than a restatement of it.
function realEsc() {
  const body = appPiece(/(function esc\(t\)\{[^\n]*\})/, 'the shared esc helper');
  return new Function(`${body}; return esc;`)();
}

describe('the escaping decision, made once', () => {
  // Two of the deferred findings close here. The rollback-proof window and
  // the skill-page arrival closed earlier, on main, and their closing facts
  // are pinned below rather than restated: reasons live beside the pins.
  test('esc escapes both quote characters, and null says nothing', () => {
    const esc = realEsc();
    assert.strictEqual(esc('"a" & \'b\' <c>'), '&quot;a&quot; &amp; &#39;b&#39; &lt;c&gt;');
    assert.strictEqual(esc(null), '');
    assert.strictEqual(esc(undefined), '');
    assert.strictEqual(esc(0), '0');
  });

  test('escAttr and esc agree, so no position is a guess', () => {
    const escAttrBody = appPiece(/(function escAttr\(t\)\{[^\n]*\})/, 'the attribute escaper');
    const escAttr = new Function(`${escAttrBody}; return escAttr;`)();
    const esc = realEsc();
    const probe = '"a" & \'b\' <c>';
    assert.strictEqual(esc(probe), escAttr(probe),
      'the two escapers must produce one answer, or the next reader is back to guessing which positions are safe');
  });

  test('a name carrying an attribute breakout stays inert in a scope row', () => {
    const { doc } = panelShell({ name: '" onmouseover="window.pwned=1' });
    const row = doc.querySelector('.scope-item[data-scope="piper"]');
    assert.ok(row, 'the row rendered');
    assert.strictEqual(row.getAttribute('onmouseover'), null,
      'a quote in a rendered name must never become a second attribute');
  });
});

// A jsdom shell for the routines panel, small enough to live here: the panel
// module is evaluated with the globals it reaches for, and the scope rows are
// read back off the page.
function panelShell({ name = 'Piper' } = {}) {
  const dom = new JSDOM('<!doctype html><html><body>'
    + '<div id="sidebar-routines"></div>'
    + '</body></html>', { runScripts: 'dangerously' });
  const w = dom.window;
  w.eval(SCOPE_MODEL_SRC);
  w.eval(PANEL_SRC);
  const escBody = appPiece(/(function esc\(t\)\{[^\n]*\})/, 'the shared esc helper');
  const escAttrBody = appPiece(/(function escAttr\(t\)\{[^\n]*\})/, 'the attribute escaper');
  w.eval(escBody);
  w.eval(escAttrBody);
  // Two owners, because the panel only offers scoping when there is a choice.
  w.agents = [
    { id: 'piper', displayName: name, status: 'onTeam', colour: '#E87A5A', routines: [
      { name: 'Morning brief', schedule: 'every day at 07:00', prompt: 'p', enabled: true },
    ] },
    { id: 'wren', displayName: 'Wren', status: 'onTeam', colour: '#6BC67E', routines: [
      { name: 'Evening digest', schedule: 'every day at 18:00', prompt: 'p', enabled: true },
    ] },
  ];
  w.routinesScopeAgentId = () => null;
  w.setRoutinesScope = () => {};
  w.showFilesPanel = () => {};
  w.renderRoutines = () => {};
  w.eval('renderRoutinesPanel();');
  return { w, doc: w.document, dom };
}

describe('the scope rows are real controls', () => {
  test('a scope row is a button, so Enter and Space work without costume attributes', () => {
    const { doc } = panelShell();
    const rows = [...doc.querySelectorAll('.scope-item')];
    assert.ok(rows.length >= 1, 'the panel drew scope rows');
    for (const row of rows) {
      assert.strictEqual(row.tagName, 'BUTTON',
        'a div with role="button" answers clicks and nothing else; a button answers the keyboard too');
      assert.strictEqual(row.getAttribute('type'), 'button');
      assert.strictEqual(row.getAttribute('role'), null,
        'the role leaves with the div rather than being carried as costume');
      assert.strictEqual(row.getAttribute('tabindex'), null,
        'a button is already a tab stop');
    }
  });
});

// The routines list under a scope, for the pause-retarget question the panel
// work left untested: the message must carry the pressed row's own triple,
// whatever the scope did to the list's numbering.
function routinesShell() {
  const dom = new JSDOM('<!doctype html><html><body>'
    + '<nav class="nav-rail"><button class="nav-item" data-nav="routines"></button></nav>'
    + '<div id="view-routines"><div id="routines-content"></div></div>'
    + '</body></html>', { runScripts: 'dangerously' });
  const w = dom.window;
  w.eval(EDITOR_MODEL_SRC);
  w.eval(SKILLS_MODEL_SRC);
  w.eval(ROUTINES_MODEL_SRC);
  w.eval(ROUTINES_SRC);
  w.agents = [
    { id: 'piper', displayName: 'Piper', status: 'onTeam', routines: [
      { name: 'Piper brief', schedule: 'every day at 07:00', prompt: 'p', enabled: true },
    ] },
    { id: 'wren', displayName: 'Wren', status: 'onTeam', routines: [
      { name: 'Wren digest', schedule: 'every day at 08:00', prompt: 'p', enabled: true },
    ] },
  ];
  w.skills = [];
  w.skillsLoaded = true;
  const escBody = appPiece(/(function esc\(t\)\{[^\n]*\})/, 'the shared esc helper');
  w.eval(escBody);
  w.sent = [];
  w.ws = { send: (raw) => w.sent.push(JSON.parse(raw)) };
  w.routinesNow = () => new Date(2026, 8, 3, 9, 0);
  w.Intl = { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'Europe/London' }) }) };
  return { w, doc: w.document, dom };
}

describe('pause under a scope', () => {
  test('pausing the visible row pauses that row\'s own routine, not the scoped index\'s namesake', () => {
    const { w, doc } = routinesShell();
    // Scoped to the SECOND agent, so a message built from a list index that
    // ignored the scope would name Piper's routine instead of Wren's.
    w.routinesScopeAgentId = () => 'wren';
    w.eval('renderRoutines();');
    const pause = doc.querySelector('[data-routines-action="pause"]');
    assert.ok(pause, 'the scoped list offers a pause control');
    pause.click();
    assert.strictEqual(w.sent.length, 1, 'one press, one message');
    assert.strictEqual(w.sent[0].type, 'set_routine_paused');
    assert.strictEqual(w.sent[0].agentId, 'wren',
      'the message names the agent whose row was pressed: the scope changed the numbering, not the target');
    assert.strictEqual(w.sent[0].name, 'Wren digest');
    assert.strictEqual(w.sent[0].paused, true);
  });
});

describe('closed findings, each pinned to its closing fact', () => {
  // The two failure-dot findings (letter-not-substance, and danger-versus-
  // attention token) closed when the rail dot was removed as a product
  // decision on main; what would reopen them is the dot returning. The pin is
  // the absence itself.
  test('the rail carries no failure dot for the dot findings to apply to', () => {
    assert.ok(!APP_SRC.includes('updateRoutineFailureBadge'),
      'the shell no longer knows the badge; the dot findings closed with the feature');
    assert.ok(!read('public', 'styles', 'components', 'sidebar.css').includes('failure-dot'),
      'and no stylesheet keeps a dot to take the wrong token');
  });

  // The skill-page arrival finding closed when the editor door was fixed and
  // then scoped; the door suite pins the behaviour. What is pinned here is
  // that the pin exists, so deleting that test reopens this finding loudly.
  test('the skill-page arrival stays pinned by the door suite', () => {
    const doors = read('test', 'unit', 'routine-editor-doors.test.js');
    assert.ok(doors.includes('the skill door opens the editor at the schedule step for that skill'),
      'the door suite must keep pinning the arrival the finding was about');
    assert.ok(ROOT && read('public', 'views', 'routine-editor.js').includes('selectedKey: only ?'),
      'and the door still passes the pressed skill through as the selection');
  });

  // The rollback-proof window closed when the quiet assertion was anchored
  // before the switch; the anchor and its reason live in the integration
  // test. Pinned so a rewrite that reopens the window fails here first.
  test('the rollback proof keeps its window anchored before the switch', () => {
    const proof = read('test', 'integration', 'workspace-rollback-poll.test.js');
    assert.ok(proof.includes('beforeTheFailedSwitch = since;'),
      'the quiet assertion must anchor its window before the switch is sent');
    assert.ok(proof.includes('the signal escapes through'),
      'and the reason stays beside the anchor, so the next rewrite meets it');
  });
});

describe('a view container belongs to its own stylesheet', () => {
  const drift = require('../tools/style-drift.js');

  test('the exact incident line is a finding, wherever it is written', () => {
    const specimen = '#view-chat { flex-direction: row; }';
    const found = drift.layoutFindings('public/styles/components/sidebar.css', specimen);
    assert.strictEqual(found.length, 1, 'the incident that motivated the gate must be a finding');
    assert.strictEqual(found[0].selector, '#view-chat');
    assert.strictEqual(found[0].owner, 'public/styles/views/chat.css',
      'the finding names the owning stylesheet, so the fix is stated, not hunted');
  });

  test('the same line in the owning stylesheet is not a finding', () => {
    const specimen = '#view-chat { flex-direction: column; }';
    assert.deepStrictEqual(drift.layoutFindings('public/styles/views/chat.css', specimen), [],
      'a view styling itself is the rule working, not an offence');
  });

  test('the shipped stylesheets carry no undeclared cross-file override', () => {
    const findings = drift.layoutScan();
    const allow = JSON.parse(read('test', 'tools', 'style-drift-allowlist.json'));
    const declared = allow.viewOverrides || [];
    const undeclared = findings.filter(f => !declared.some(d => d.file === f.file && d.selector === f.selector));
    assert.deepStrictEqual(undeclared, [],
      'every cross-file view override must be moved to the owner or declared with a reason');
  });

  test('a comment cannot hide the override from the scan', () => {
    const specimen = '/* #view-chat is not a rule */\n#view-chat { flex-direction: row; }';
    const found = drift.layoutFindings('public/styles/base.css', specimen);
    assert.strictEqual(found.length, 1, 'the commented mention is skipped and the live rule is caught');
    assert.strictEqual(found[0].line, 2);
  });
});

describe('callouts render their own markdown', () => {
  test('bold and lists inside a callout body render as markup, through the shared pipeline', async () => {
    const { bootEditorEnv } = await import('../helpers/editor-harness.js');
    const env = await bootEditorEnv();
    env.window.renderMarkdown = (text, opts) => renderMarkdown(text, opts);
    const element = env.window.document.createElement('div');
    const { editor } = env.createEditor({
      element,
      rawMarkdown: '> [!note] Briefing\n> **Goal pulse** is *steady*\n> - **Penn:** drafting\n> - **Des:** mocks',
    });
    const dom = new JSDOM(element.innerHTML);
    const md = dom.window.document.querySelector('.callout .callout-md');
    assert.ok(md, 'the body rendered through the pipeline container');
    assert.ok(md.querySelector('strong'), 'bold renders as markup, not asterisks');
    assert.ok(md.querySelector('em'), 'italics too');
    assert.strictEqual(md.querySelectorAll('li').length, 2, 'list lines become a real list');
    assert.ok(!md.textContent.includes('**'), 'no literal asterisks survive');
    env.destroyEditor(editor);
  });

  test('a shell without the pipeline falls back to escaped lines, never unescaped text', async () => {
    const { bootEditorEnv } = await import('../helpers/editor-harness.js');
    const env = await bootEditorEnv();
    delete env.window.renderMarkdown;
    const element = env.window.document.createElement('div');
    const { editor } = env.createEditor({
      element,
      rawMarkdown: '> [!note] Plain\n> **still** <img src=x onerror=alert(1)>',
    });
    const dom = new JSDOM(element.innerHTML);
    const body = dom.window.document.querySelector('.callout-body');
    assert.ok(body, 'the callout still renders');
    assert.ok(body.querySelector('.callout-line'), 'the fallback per-line rendering is what appears');
    assert.strictEqual(body.querySelector('img'), null,
      'the fallback is unrendered, never unescaped: no element materialises from body text');
    env.destroyEditor(editor);
  });

  test('the disclosure control is designed, at the title scale, in both themes', () => {
    const caret = EDITOR_CSS.match(/summary\.callout-header::before \{([^}]*)\}/);
    assert.ok(caret, 'the caret rule exists');
    assert.ok(caret[1].includes('font-size: var(--title)'),
      'the control takes the title scale rather than reading as a browser leftover');
    assert.ok(caret[1].includes('var(--callout-color)'),
      'and its colour rides the callout token, which is what makes it right in both themes');
    assert.ok(/summary\.callout-header:hover::before/.test(EDITOR_CSS),
      'a designed control answers hover');
    assert.ok(EDITOR_CSS.includes("content: '\\25BE'"), 'and the open state swaps the glyph');
  });
});

describe('instructions render as markdown on both surfaces', () => {
  function instructionsShell(view, srcName) {
    const dom = new JSDOM('<!doctype html><html><body>'
      + '<button class="nav-item" data-nav="team"></button>'
      + '<div id="view-profile"><div id="profile-content"></div></div>'
      + '<div id="view-skills"><div id="skills-sidebar-list"></div><div id="skill-detail-content"></div></div>'
      + '</body></html>', { runScripts: 'dangerously' });
    const w = dom.window;
    w.eval(EDITOR_MODEL_SRC);
    w.eval(SKILLS_MODEL_SRC);
    w.eval(ROUTINES_MODEL_SRC);
    w.eval(view === 'profile' ? ROUTINES_SRC : 'void 0;');
    w.eval(srcName);
    const escBody = appPiece(/(function esc\(t\)\{[^\n]*\})/, 'the shared esc helper');
    w.eval(escBody);
    // The REAL helper, cut from app.js, backed by the REAL pipeline.
    const helperBody = appPiece(/(function renderInstructionsMd\(text\) \{[\s\S]*?\n\})/, 'the instructions renderer');
    w.renderMarkdown = (text, opts) => renderMarkdown(text, opts);
    w.eval(helperBody);
    w.formatTimeAgo = () => 'a while ago';
    w.getGuide = () => ({ id: 'doc', displayName: 'Wren' });
    w.ws = { send: () => {} };
    w.routinesNow = () => new Date(2026, 8, 3, 9, 0);
    w.Intl = { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'Europe/London' }) }) };
    w.setNavState = () => {}; w.showView = () => {}; w.closeFindBar = () => {};
    w.startConversation = () => {}; w.addToTeam = () => {}; w.openConversation = () => {};
    w.currentSkillId = null; w.addRoutineForAgent = () => {}; w.switchNav = () => {};
    w.addRoutineForSkill = () => {}; w.routineEditorSkillsArrived = () => {};
    w.conversations = [];
    return { w, doc: w.document, dom };
  }

  const INSTRUCTIONS = '# Purpose\n\n**Always** check the vault first.\n\n- Step one\n- Step two\n\n<img src=x onerror=alert(1)>';

  test('an agent profile renders instructions through the pipeline, sanitised the same way', () => {
    const { w, doc } = instructionsShell('profile', PROFILE_SRC);
    w.selectSkill = () => {};
    w.agents = [{ id: 'piper', displayName: 'Piper', role: 'Ops', colour: '#E87A5A', icon: 'P',
      status: 'onTeam', runtime: 'claude', model: 'sonnet', routines: [], instructions: INSTRUCTIONS }];
    w.skills = [];
    w.eval("showProfile('piper');");
    const body = doc.querySelector('#agent-instructions .instructions-md');
    assert.ok(body, 'the instructions card renders the markdown container');
    assert.ok(body.querySelector('strong'), 'bold renders as markup');
    assert.strictEqual(body.querySelectorAll('li').length, 2, 'the steps are a real list');
    assert.ok(!body.textContent.includes('**'), 'no literal syntax survives');
    assert.strictEqual(body.querySelector('img'), null,
      'raw HTML in an instructions file is escaped by the pipeline, exactly as the file viewer escapes it');
  });

  test('a skill page renders instructions through the same pipeline', () => {
    const { w, doc } = instructionsShell('skills', SKILLS_SRC);
    w.agents = [{ id: 'piper', displayName: 'Piper', status: 'onTeam', routines: [] }];
    w.skills = [{ id: 'ops', name: 'Compile the ops summary', description: 'Numbers',
      assignedAgents: [{ id: 'piper', name: 'Piper' }], instructions: INSTRUCTIONS }];
    w.currentView = 'skills';
    w.eval("selectSkill = RundockSkillsView.selectSkill; renderSkills(); selectSkill('ops');");
    const body = doc.querySelector('#skill-instructions .instructions-md');
    assert.ok(body, 'the skill page renders the markdown container');
    assert.ok(body.querySelector('strong'), 'bold renders as markup');
    assert.strictEqual(body.querySelectorAll('li').length, 2, 'the steps are a real list');
    assert.strictEqual(body.querySelector('img'), null, 'same sanitising as the file viewer');
  });

  test('a shell without the pipeline shows escaped text, never nothing and never unescaped', () => {
    const helperBody = appPiece(/(function renderInstructionsMd\(text\) \{[\s\S]*?\n\})/, 'the instructions renderer');
    const escBody = appPiece(/(function esc\(t\)\{[^\n]*\})/, 'the shared esc helper');
    const helper = new Function(`${escBody}; ${helperBody}; return renderInstructionsMd;`)();
    const out = helper('**bold** <img src=x>');
    assert.ok(out.includes('**bold**'), 'unrendered');
    assert.ok(!out.includes('<img'), 'never unescaped');
  });
});
