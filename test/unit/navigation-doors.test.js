'use strict';
// Every destination in this client, and the chrome that has to agree with it.
//
// WHY THIS IS A MANIFEST AND NOT A LIST OF FIXES.
//
// The nav rail is the only thing telling a reader which of the top-level
// surfaces they are on. It was wrong on several routes, and the routes it was
// wrong on were the ones whose author forgot to pair a view change with a nav
// change. Three of them were reported. Fixing three reported routes leaves the
// same defect on every route nobody reported, and the next feature adds another.
// Two earlier changes on this codebase were each rewritten five times learning
// exactly that.
//
// So this file enumerates the whole class rather than the instances, from the
// SOURCE rather than from any list handed to its author. The list it was handed
// named three routes, and the source had two of them:
//
//   DESTINATIONS  every call to showView in the client, with the rail section
//                 the reader should be left on
//   PANELS        every sidebar panel the page carries, and the one place
//                 allowed to decide which of them is visible
//
// Both are derived and compared. A call site added later fails here by name
// until somebody lists it and says which section it lands on. A panel added to
// the page later fails here until the one list that hides them all knows about
// it.
//
// WHAT CHANGED IN THE SOURCE, so this file's checks read as checks rather than
// as description. Nav state used to be a second thing every destination had to
// remember: showView revealed a pane, setNavState lit an icon, and forgetting
// the second was invisible to every test. Now showView resolves the section
// from the view through NAV_FOR_VIEW and sets it itself, and setNavState has
// exactly one caller. A destination cannot forget what it no longer does.
//
// WHETHER IT CAN DRIFT AGAIN. Yes, in one way, and it is written out in
// NOT_CAUGHT below rather than implied by the checks that pass.
//
// THE SHAPE IS BORROWED, deliberately, from test/unit/routine-editor-doors.js,
// test/unit/routines-view-doors.test.js and test/unit/scheduler-lifecycle-doors
// .test.js: a manifest held against what the source actually contains, which
// refuses a row naming a test nobody wrote. This is the same instrument turned
// on the whole client's navigation rather than on one surface's ways in, which
// is why it is a new file and not a fourth copy of a per-surface door list:
// those three ask who reaches one place, and this one asks whether the chrome
// agrees with the pane anywhere at all.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf-8');
const APP_SRC = read('public', 'app.js');
const INDEX_SRC = read('public', 'index.html');

// ===== THE ENUMERATION =====
//
// Every call to showView anywhere in the client, keyed by the file and the
// construct that carries it, so two calls in two functions are two rows and
// two calls in one arm are one. The construct is named rather than the line,
// because the body around a call moves and the function or branch holding it
// does not.
//
// `section` is the rail section the reader should be left on. It is checked
// against NAV_FOR_VIEW in app.js rather than trusted, so a row here cannot
// disagree with the table the product actually uses.
//
// `noSection` marks a destination that deliberately sets no nav state, and
// carries the reason. One or the other, never neither.
const DESTINATIONS = [
  {
    site: "app.js: case 'needs_workspace': -> showView('workspace')",
    view: 'workspace',
    noSection: true,
    why: 'a rail entry names a section of a workspace, and this is the screen shown when there is '
      + 'no workspace to have a section of, so there is no section it could set. It reaches that '
      + 'screen when the server says it has no workspace, which can happen after it had one: the '
      + 'server drops the pointer when the directory stops existing or a switch fails. So this '
      + 'route takes the chrome down itself rather than assuming the other one already did, and '
      + 'both routes take it down through the same function.',
    surface: 'the server saying there is no workspace open',
    pressedBy: 'the route that says there is no workspace takes the chrome down with it',
  },
  {
    site: "app.js: function showWorkspacePicker(recent, discovered) -> showView('workspace')",
    view: 'workspace',
    noSection: true,
    why: 'the same screen reached the other way, with the same reason: there is no section to set '
      + 'for a screen that means you have no workspace. This route takes the chrome down through '
      + 'the same function as the other one, which is what makes the reason true of both rather '
      + 'than of whichever was written first.',
    surface: 'the workspace picker being drawn',
    pressedBy: 'the workspace picker takes no nav state, because it has no rail to take one on',
  },
  {
    site: "app.js: if(nav==='settings') -> showView('settings')",
    view: 'settings',
    section: 'settings',
    surface: 'the Settings entry on the nav rail',
    pressedBy: 'every view the shell can show lands the rail on the section its own table names',
  },
  {
    site: "app.js: else if(nav==='files') -> showView('editor')",
    view: 'editor',
    section: 'files',
    surface: 'the Files entry on the nav rail, with a file open and with none',
    pressedBy: 'every view the shell can show lands the rail on the section its own table names',
  },
  {
    site: "app.js: else if(nav==='skills') -> showView('skills')",
    view: 'skills',
    section: 'skills',
    surface: 'the Skills entry on the nav rail',
    pressedBy: 'every view the shell can show lands the rail on the section its own table names',
  },
  {
    site: "app.js: else if(nav==='conversations') -> showView('chat')",
    view: 'chat',
    section: 'conversations',
    surface: 'the Conversations entry on the nav rail with a conversation already open',
    pressedBy: 'every view the shell can show lands the rail on the section its own table names',
  },
  {
    site: "app.js: else if(nav==='team') -> showView('home')",
    view: 'home',
    section: 'team',
    surface: 'the Team entry on the nav rail',
    pressedBy: 'every view the shell can show lands the rail on the section its own table names',
  },
  {
    site: "views/routines.js: function showRoutinesForAgent(agentId) -> showView('routines')",
    view: 'routines',
    section: 'routines',
    surface: 'the Routines entry on the nav rail, and an agent page asking for that agent\'s routines',
    // The rail's own arm stopped showing a view directly and calls this
    // instead, so the row moved with the call rather than being deleted: the
    // destination is the same one, reached through a function that also carries
    // the scope.
    pressedBy: 'every view the shell can show lands the rail on the section its own table names',
  },
  {
    site: "views/run-detail.js: function openRunDetail(agentId, routine) -> showView('run-detail')",
    view: 'run-detail',
    section: 'routines',
    surface: "a routine's last run, opened from its row on the routines list",
    // A run belongs to a routine, so its screen is one of the routines
    // surfaces and the rail says Routines throughout, which is the same rule
    // that puts the routine editor there.
    pressedBy: 'every view the shell can show lands the rail on the section its own table names',
  },
  {
    site: "views/conversations.js: function createConversation(agentId, title) -> showView('chat')",
    view: 'chat',
    section: 'conversations',
    surface: 'a conversation being started, from a profile, the org chart or an empty state',
    pressedBy: 'every view the shell can show lands the rail on the section its own table names',
  },
  {
    site: "views/conversations.js: function newConversation() -> showView('convo-empty')",
    view: 'convo-empty',
    section: 'conversations',
    surface: 'New conversation on a workspace with team agents and no orchestrator to pick',
    pressedBy: 'every view the shell can show lands the rail on the section its own table names',
  },
  {
    site: "views/conversations.js: function openConversation(id, withAnchor) -> showView('chat')",
    view: 'chat',
    section: 'conversations',
    surface: 'a conversation being opened, from the sidebar, the palette or a profile',
    pressedBy: 'every view the shell can show lands the rail on the section its own table names',
  },
  {
    site: "views/files.js: function buildTree(items,container) -> showView('editor')",
    view: 'editor',
    section: 'files',
    surface: 'a row in the file tree being clicked',
    pressedBy: 'every view the shell can show lands the rail on the section its own table names',
  },
  {
    site: "views/files.js: function openWikilink(name) -> showView('editor')",
    view: 'editor',
    section: 'files',
    surface: 'a wikilink inside a note being followed',
    pressedBy: 'every view the shell can show lands the rail on the section its own table names',
  },
  {
    site: "views/files.js: function openWorkspaceFilePath(path) -> showView('editor')",
    view: 'editor',
    section: 'files',
    surface: 'a link inside a rendered artifact being followed',
    pressedBy: 'every view the shell can show lands the rail on the section its own table names',
  },
  {
    site: "views/files.js: function openSkillFile(filePath) -> showView('editor')",
    view: 'editor',
    section: 'files',
    surface: "a skill's own file being opened from the skill page",
    // Named because this is the route nobody reported and the enumeration found.
    // It used to set no nav state at all, so the rail kept saying Skills
    // while the pane was the editor, and the sidebar kept offering skills the
    // reader could no longer see the detail of.
    pressedBy: 'every view the shell can show lands the rail on the section its own table names',
  },
  {
    site: 'views/files.js: function editorGoBack() -> showView(editorReturnView)',
    view: null,
    section: null,
    dynamic: 'editorReturnView',
    surface: 'Back in the editor, returning to the view the file was opened from',
    // The one call whose view is a variable, so its section cannot be read off
    // a literal. The variable is held to its two values by a check of its own
    // rather than left as the hole in the table.
    pressedBy: 'the one destination whose view is a variable can only hold views the table knows',
  },
  {
    site: "views/palette.js: function paletteOpenFile(filePath) -> showView('editor')",
    view: 'editor',
    section: 'files',
    surface: 'a file result in the search palette',
    pressedBy: 'every view the shell can show lands the rail on the section its own table names',
  },
  {
    site: "views/profile.js: function showProfile(agentId) -> showView('profile')",
    view: 'profile',
    section: 'team',
    surface: "an agent's page, from the org chart, the sidebar, the palette or a skill's agent chip",
    pressedBy: 'every view the shell can show lands the rail on the section its own table names',
  },
  {
    site: "views/routine-editor.js: function openRoutineEditor(input) -> showView('routine-editor')",
    view: 'routine-editor',
    section: 'routines',
    surface: 'the routine editor, from an agent page or from the routines list',
    // The reported instance most people will look for. This used to light Team
    // on a routines surface, against the locked mock's chrome-parity rule that a
    // surface's entry stays active across that surface's own screens.
    pressedBy: 'the routine editor is a routines surface and the rail says so',
  },
  {
    site: "views/skills.js: function selectSkill(id) -> showView('skills')",
    view: 'skills',
    section: 'skills',
    surface: 'a skill being selected, from the skills sidebar or from the search palette',
    // The second reported instance, and the one where a single file disagreed
    // with itself twelve lines apart: the agent chip navigated and the selector
    // did not.
    pressedBy: 'every view the shell can show lands the rail on the section its own table names',
  },
];

// Every top-level sidebar panel, and who is allowed to decide it is the
// visible one.
//
// WHY THIS IS HERE AND NOT IN A SECOND FILE. A rail that lights the wrong icon
// and a sidebar that shows the wrong panel are the same defect to a reader, and
// they were the same defect in the source: two hard-coded lists of the same
// panels, in setNavState and in the workspace-switch reset, drifting apart
// because each was extended by whoever happened to be looking at it. That is
// this change's own defect one level up, so it belongs in this manifest.
const PANEL_DECIDERS = [
  {
    what: 'showing a view',
    caller: 'app.js: function showView(v)',
    why: 'the rule. Every destination lands on a view, the view names its section in NAV_FOR_VIEW, '
      + 'and showView asks for it. This is the caller that makes the other twenty destinations '
      + 'unable to get it wrong, because they no longer do it.',
    pressedBy: 'every view the shell can show lands the rail on the section its own table names',
  },
  {
    what: 'the workspace reset, which settles the chrome before it knows the view',
    caller: 'app.js: function resetSidebarForWorkspace()',
    // The one exception, and it is an exception to the rule rather than a hole
    // in it: this is the single moment the chrome is decided and the pane is
    // deliberately not, so there is no view to resolve a section from.
    why: 'switching to a different workspace puts the reader back on Conversations, and does it '
      + 'BEFORE any view is shown: which view comes next is the answer to a request still in '
      + 'flight, and the pane stays blank until it lands because blank reads as loading where an '
      + 'empty state reads as "you have nothing here". So there is no view to take a section from, '
      + 'and this asks for one directly. It used to hide the panels by a second hard-coded list of '
      + 'its own and light the icon by hand, which is how the two lists drifted, and the copy never '
      + 'learned about the New conversation footer, so a reader who switched workspace from any '
      + 'other section arrived at Conversations with no way to start one.',
    pressedBy: 'switching workspace resets the chrome through the one place that owns it',
  },
];

// Ways the chrome could still end up wrong that nothing here catches, each
// with what a person would have to notice instead. Whether this can drift again
// is answered by this list rather than by the checks that pass: a mechanism that
// looks total and is not is worse than an honest hole.
const NOT_CAUGHT = [
  {
    what: 'a section in NAV_FOR_VIEW that is the wrong section for its view',
    why: 'no check can know that the routine editor belongs to Routines rather than to Team. The '
      + 'table can be held to the views and to the rail, which is done below, but not to the '
      + 'design. What a person has to notice: NAV_FOR_VIEW in public/app.js is one screen long and '
      + 'names every view, so reviewing a navigation change means reading it in full against the '
      + 'locked mock, whose chrome-parity rule is what decides these values.',
  },
  {
    what: 'a pane or a panel revealed without going through the functions that own it',
    why: 'a view panel and a sidebar panel are both divs, and any code can un-hide one directly. '
      + 'The scans below catch a file that lights a rail item, or that hides a panel it addressed '
      + 'by its id, which is the form this took both times. Three things they do not catch: a '
      + 'view-* panel un-hidden by hand, a sidebar panel reached by walking the DOM rather than by '
      + 'id, and a write split across two lines, since the scans read one line at a time and need '
      + 'the lookup and the class change on the same one. What a person has to notice: a change '
      + 'that adds or removes the hidden class on a view-* or sidebar-* element, or the active '
      + 'class on a rail entry, anywhere but showView and setNavState.',
  },
  {
    what: 'a destination that shows the right view and then navigates away from it',
    why: 'every row is pressed by a test that presses showView, because showView is what carries '
      + 'the section now. A destination that calls showView and then calls switchNav to another '
      + 'section would end on the wrong rail with every test here green, since nothing presses the '
      + 'destination functions themselves end to end. Nothing in the client does this today. What '
      + 'a person has to notice: two navigation calls in one function, which is the shape every '
      + 'defect this file was built for already had.',
  },
  {
    what: 'the workspace-switch reset pressed end to end',
    why: 'onWorkspaceReady is pressed here only through the nav line cut out of it, not by running '
      + 'the whole function, which needs the conversation store, the badge DOM and the workspace '
      + 'picker. The line is the part this change touches and the rest is watched by the tests '
      + 'that own it. What a person has to notice: a second nav reset added elsewhere in that '
      + 'function, '
      + 'which the scans below would catch only if it touched the rail or the panels directly.',
  },
  {
    what: 'a route into a view that is correct but lands on the wrong content',
    why: 'this file is about the chrome agreeing with the pane, not about what the pane draws. '
      + 'Whether the right routine, skill or file is shown is the business of the door files for '
      + 'those surfaces, which press what gets drawn.',
  },
];

// ===== DERIVING IT FROM THE SOURCE =====

function clientFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.name === 'vendor') continue;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.js')) out.push(rel);
    }
  };
  walk('public');
  return out;
}

// THE UNIVERSE THE ENUMERATION IS OVER, and it is stated here because an
// inventory that scans less than the client runs is worse than no inventory:
// everyone downstream reads it as total.
//
// The page runs two kinds of code. Every `.js` under `public/`, which the shell
// loads by script tag, and the inline `on*` attributes in `public/index.html`,
// which resolve bare window names and are how the nav rail itself calls
// switchNav. A call written in the second kind reaches exactly the same
// functions as one written in the first, so both are scanned.
//
// `vendor/` is outside it, and that is a decision rather than an oversight:
// third-party code the page loads is not this product's navigation, and a
// destination written there would be a defect of a different kind. Nothing
// else under `public/` is excluded.
//
// What is NOT scanned, and cannot be: code that arrives at runtime. There is
// none today, and `no destination arrives as text at runtime` below asserts
// that rather than leaving it to be believed.
function commentsStripped(src) {
  // Block comments go first, newlines kept so line numbers survive. Then line
  // comments, but only where the slashes are not part of a URL, because
  // stripping those would eat half the strings in the file.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

// Every inline handler attribute in the page, as {file, owner, text}. The owner
// names the element the way a reader would find it: its id or data-nav if it
// has one, otherwise its tag.
function inlineHandlers() {
  const src = INDEX_SRC.replace(/<!--[\s\S]*?-->/g, '');
  const out = [];
  for (const m of src.matchAll(/\son([a-z]+)\s*=\s*"([^"]*)"/g)) {
    const open = src.lastIndexOf('<', m.index);
    const tag = /<\s*([a-z][\w-]*)/i.exec(src.slice(open, m.index + 1));
    const element = src.slice(open, m.index + 1);
    const named = /\s(?:id|data-nav)="([^"]*)"/.exec(element);
    const who = named ? `<${tag ? tag[1] : '?'} ${named[0].trim()}>` : `<${tag ? tag[1] : '?'}>`;
    out.push({ file: 'index.html', owner: `${who} on${m[1]}`, text: m[2] });
  }
  return out;
}

// The construct that carries a call, as "the case label", "the nav arm" or
// "the function declaration", whichever is nearest above it. Named rather than
// numbered: a line number moves on every edit above it, and a row keyed by one
// would fail for reasons that have nothing to do with navigation.
function ownerOf(lines, i) {
  for (let j = i; j >= 0; j--) {
    const t = lines[j].trim();
    if (/^case\s+'[^']*':/.test(t)) return t.slice(0, t.indexOf(':') + 1);
    // switchNav's arms, which are the one branch shape that means a different
    // destination rather than a different way of reaching the same one.
    if (/^(?:\}\s*)?(?:else\s+)?if\s*\(nav===/.test(t)) {
      const s = t.replace(/^\}\s*/, '');
      return s.slice(0, s.indexOf('{')).trim();
    }
    // Cut at the head, not at a trailing brace: showView's whole body sits on
    // its declaration line, and a call inside it has to be attributed to the
    // function rather than to the line it happens to share.
    if (/^(?:async\s+)?function\s+\w+\s*\(/.test(t)) return t.replace(/\s*\{[\s\S]*$/, '');
  }
  return '(top level)';
}

// Every call to `name` in the client, as "file: owner", skipping the
// declaration itself so a function is never counted as its own caller.
//
// Both kinds of source, and both kinds of call. A call written `showView(x)`
// and one written `window.showView(x)` reach the same function, so the second
// is matched rather than skipped: skipping it was how the first version of
// this scan could be walked around without failing anything.
function callSites(name, { withArgument = false } = {}) {
  const sites = [];
  const call = new RegExp(`(?<![.\\w$])(?:(?:window|self|root|globalThis)\\.)?${name}\\(([^)]*)\\)`, 'g');
  for (const rel of clientFiles()) {
    const lines = commentsStripped(fs.readFileSync(path.join(ROOT, rel), 'utf-8')).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const declaration = new RegExp(`^\\s*function ${name}\\s*\\(`).test(lines[i]);
      for (const m of lines[i].matchAll(call)) {
        // The declaration's own line still carries real calls when the body is
        // on it, so only the declaring call is skipped, not the line.
        if (declaration && lines[i].indexOf(`function ${name}(`) === m.index - 'function '.length) continue;
        const owner = `${rel.replace('public/', '')}: ${ownerOf(lines, i)}`;
        sites.push(withArgument ? `${owner} -> ${name}(${m[1].trim()})` : owner);
      }
    }
  }
  // The page's own handlers, which are code the shell runs and were outside
  // this scan until a reviewer pointed out that the rail is written in them.
  for (const handler of inlineHandlers()) {
    for (const m of handler.text.matchAll(call)) {
      const owner = `${handler.file}: ${handler.owner}`;
      sites.push(withArgument ? `${owner} -> ${name}(${m[1].trim()})` : owner);
    }
  }
  return [...new Set(sites)].sort();
}

// A call this scan can see is one whose arguments end on the line they start
// on, because the scan reads lines. Rather than silently miss a call broken
// across lines, they are refused: keeping a navigation call on one line costs
// nothing and is what makes the inventory checkable.
function callsSpanningLines(name) {
  const bad = [];
  for (const rel of clientFiles()) {
    const lines = commentsStripped(fs.readFileSync(path.join(ROOT, rel), 'utf-8')).split('\n');
    const open = new RegExp(`(?<![.\\w$])(?:(?:window|self|root|globalThis)\\.)?${name}\\(`, 'g');
    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i].matchAll(open)) {
        const rest = lines[i].slice(m.index + m[0].length);
        let depth = 1;
        let closed = false;
        for (const ch of rest) {
          if (ch === '(') depth++;
          else if (ch === ')') { depth--; if (depth === 0) { closed = true; break; } }
        }
        if (!closed) bad.push(`${rel.replace('public/', '')}:${i + 1}`);
      }
    }
  }
  return bad;
}

// Every showView call in the client, as "file: owner -> showView(argument)".
// The argument is part of the key because one function can land on two views
// and those are two destinations, not one.
function showViewCallSites() {
  return callSites('showView', { withArgument: true });
}

// A named piece of app.js, cut out so it can be RUN rather than matched. The
// extraction asserts the piece exists, so a deleted one fails here rather than
// yielding an empty body that then passes every assertion about what it did
// not do.
function appPiece(pattern, label) {
  const m = APP_SRC.match(pattern);
  assert.ok(m && m[1] && m[1].trim(), `app.js no longer carries ${label}`);
  return m[1];
}

const NAV_FOR_VIEW_SRC = /const NAV_FOR_VIEW = \{[\s\S]*?\n\};/.exec(APP_SRC);

function navForView() {
  assert.ok(NAV_FOR_VIEW_SRC, 'app.js no longer carries a NAV_FOR_VIEW table, so nothing resolves '
    + 'a view to the section the rail should show');
  // eslint-disable-next-line no-new-func
  return new Function(`${NAV_FOR_VIEW_SRC[0]}\nreturn NAV_FOR_VIEW;`)();
}

// The views showView knows how to reveal, read off its own hide list rather
// than written again here. A view added there and nowhere else is what this
// exists to catch.
function viewsShowViewKnows() {
  const body = appPiece(/^function showView\(v\) \{(.*)\}\s*$/m, 'showView');
  const list = /\[([^\]]*)\]\.forEach/.exec(body);
  assert.ok(list, 'showView no longer carries the list of views it hides');
  return list[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''));
}

// The sidebar panels the page carries, read off the page. Direct children of
// the sidebar whose id names a panel: the nested ones (the routines block
// inside the team panel, the pill row inside conversations) are parts of a
// panel rather than panels, and the footer is not a panel at all.
function panelsOnPage() {
  const aside = /<aside class="sidebar"[\s\S]*?<\/aside>/.exec(INDEX_SRC);
  assert.ok(aside, 'index.html no longer carries a sidebar');
  const dom = new JSDOM(`<!doctype html><html><body>${aside[0]}</body></html>`);
  const el = dom.window.document.querySelector('aside.sidebar');
  const ids = [...el.children].map(c => c.id).filter(id => id && id.startsWith('sidebar-'));
  dom.window.close();
  return ids.map(id => id.replace('sidebar-', '')).sort();
}

// The list setNavState hides, read off setNavState.
function panelsSetNavStateHides() {
  const body = appPiece(/function setNavState\(nav\) \{([\s\S]*?)\n\}/, 'setNavState');
  const list = /\[([^\]]*)\]\.forEach\(s=>document\.getElementById\(`sidebar-/.exec(body);
  assert.ok(list, 'setNavState no longer carries the list of panels it hides');
  return list[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).sort();
}

function railSections() {
  return [...INDEX_SRC.matchAll(/class="nav-item[^"]*" data-nav="([\w-]+)"/g)].map(m => m[1]);
}

// Every line in the client that decides which sidebar panel is visible, and
// every line that decides which rail item is lit, attributed to the function
// that carries it. Two of these existed and drifted; the rule is that there is
// one of each.
function chromeWriters() {
  const panels = [];
  const rail = [];
  for (const rel of clientFiles()) {
    const lines = fs.readFileSync(path.join(ROOT, rel), 'utf-8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
      const hides = /classList\.(?:add|remove|toggle)\(\s*['"`]hidden/.test(line);
      const lights = /classList\.(?:add|remove|toggle)\(\s*['"`]active/.test(line);
      // A panel is recognised by being ADDRESSED as one: a lookup whose
      // selector STARTS with the panel id. Matched anywhere on the line
      // instead, this flags every list that renders a class name beginning
      // "sidebar-" and hides something else on the same line, which is two of
      // them, and matched anywhere in the selector it flags the skills list,
      // whose id ends in one.
      const addressesPanel =
        /(?:getElementById|querySelector(?:All)?)\(\s*[`'"]#?sidebar-/.test(line);
      if (hides && addressesPanel) {
        panels.push(`${rel.replace('public/', '')}: ${ownerOf(lines, i)}`);
      }
      if (lights && /\.nav-item\[data-nav\]|\[data-nav="/.test(line)) {
        rail.push(`${rel.replace('public/', '')}: ${ownerOf(lines, i)}`);
      }
    }
  }
  return { panels: [...new Set(panels)].sort(), rail: [...new Set(rail)].sort() };
}

// Every assignment to editorReturnView, which is the argument of the one
// showView call whose view is not a literal.
//
// BOTH KINDS, and that is the point of returning two lists. Collecting only the
// string literals made the check that reads this vacuous the moment somebody
// wrote `editorReturnView = currentView`: the asserted set stayed
// ['editor','skills'] while Back could land anywhere. A non-literal assignment
// is now a failure rather than an absence.
function editorReturnViews() {
  const literals = [];
  const computed = [];
  for (const rel of clientFiles()) {
    const src = commentsStripped(fs.readFileSync(path.join(ROOT, rel), 'utf-8'));
    for (const m of src.matchAll(/editorReturnView\s*=\s*([^;\n]+)/g)) {
      const value = m[1].trim();
      const literal = /^'([\w-]+)'$/.exec(value);
      if (literal) literals.push(literal[1]);
      else computed.push(`${rel.replace('public/', '')}: editorReturnView = ${value}`);
    }
  }
  return { literals: [...new Set(literals)].sort(), computed: [...new Set(computed)].sort() };
}

// ===== THE CHECKS THAT END THE LOOP =====

describe('every destination in this client is enumerated', () => {
  // The list is compared against what the source
  // contains, so it cannot have come from a bug report: a route a report names
  // and the source does not have fails here just as loudly as one the source has
  // and no report ever mentioned.
  test('no call that lands the reader somewhere exists that this file does not name', () => {
    assert.deepStrictEqual(showViewCallSites(), DESTINATIONS.map(d => d.site).sort(),
      'something shows a view from a place this file does not list, or a listed one no longer '
      + 'exists. Add the row with the rail section it should land on, or remove it.');
  });

  // Why this is one rule rather than two: a destination that sets no nav state
  // on purpose and one that forgot look identical from outside, so the
  // difference has to be written down.
  test('every destination either names its section or says why it has none', () => {
    for (const d of DESTINATIONS) {
      if (d.noSection) {
        assert.ok(d.why && d.why.length > 60,
          `${d.site} sets no nav state and the reason is missing or too thin to be a decision`);
        continue;
      }
      assert.ok(d.section || d.dynamic,
        `${d.site} names neither a section nor a reason for having none`);
    }
  });

  test('every destination names a test, and every named test exists', () => {
    const suite = fs.readFileSync(__filename, 'utf-8');
    for (const entry of [...DESTINATIONS, ...PANEL_DECIDERS]) {
      const name = entry.site || entry.what;
      assert.ok(entry.pressedBy, `${name} needs a test`);
      assert.ok(suite.includes(`test('${entry.pressedBy}'`),
        `this file names "${entry.pressedBy}" for ${name} but no test here has that name`);
    }
  });

  // The row's section is held to the table the product uses, not to the row's
  // author. Written the other way round, this file would be a second opinion
  // that drifts from the first.
  test('the section every destination names is the one the source resolves', () => {
    const table = navForView();
    for (const d of DESTINATIONS) {
      if (d.dynamic) continue;
      if (d.noSection) {
        assert.strictEqual(table[d.view], null,
          `${d.site} says it takes no nav state but the source gives ${d.view} a section`);
        continue;
      }
      assert.strictEqual(table[d.view], d.section,
        `${d.site} says ${d.view} lands on ${d.section} and the source says ${table[d.view]}`);
    }
  });

  test('the one destination whose view is a variable can only hold views the table knows', () => {
    const table = navForView();
    const { literals, computed } = editorReturnViews();
    assert.deepStrictEqual(computed, [],
      'editorReturnView is assigned something that is not a view name written out, so what Back '
      + 'shows cannot be read from the source and this check would pass while saying nothing. '
      + 'Assign a literal, or bound it here another way.');
    assert.deepStrictEqual(literals, ['editor', 'skills'],
      'editorReturnView now holds another view, so Back can land somewhere this file has not '
      + 'checked. Add it here once the table has a section for it.');
    for (const v of literals) {
      assert.ok(Object.prototype.hasOwnProperty.call(table, v),
        `Back can return to ${v} and the table has no section for it`);
    }
  });

  // The hole this closes: a view added to showView and not to the table would
  // silently take no nav state, which is this whole defect reintroduced one
  // level down.
  test('every view the shell can show has a section, or an explicit none', () => {
    const table = navForView();
    const views = viewsShowViewKnows();
    assert.deepStrictEqual(Object.keys(table).sort(), [...views].sort(),
      'showView and NAV_FOR_VIEW disagree about which views exist. A view in one and not the '
      + 'other either takes no nav state or names a section for a pane nobody can reach.');
    for (const v of views) {
      assert.ok(INDEX_SRC.includes(`id="view-${v}"`),
        `the table names a section for ${v} and the page carries no view-${v} to show`);
    }
  });

  // A section reveals the panel of its own name, with no map in between. There
  // used to be one, with a single entry, and it went when routines got a panel
  // of its own. The check below reads the panel by the section's name, which is
  // only right while that stays true; test/unit/team-sidebar.test.js sweeps the
  // whole client, suite and instruments for the alias returning, so this file
  // leans on that rather than carrying a second copy of the same question.
  test('every section a view names is a section the rail actually carries', () => {
    const table = navForView();
    const rail = railSections();
    const panels = panelsOnPage();
    for (const [view, section] of Object.entries(table)) {
      if (section === null) continue;
      assert.ok(rail.includes(section),
        `${view} lands on "${section}" and the rail carries no entry by that name`);
      assert.ok(panels.includes(section),
        `${view} lands on "${section}" and the sidebar carries no panel for it`);
    }
  });

  // The removal this protects. Nav state used to be set at the top of switchNav
  // for every arm; it is now set by the view each arm shows. An arm that shows
  // no view would therefore leave the rail alone, so every entry the rail
  // carries has to have one.
  // THE SCAN'S OWN REACH, asserted rather than assumed. Every check above is
  // only as wide as what it reads, so what it reads is checked too.
  test('every navigation call is one the enumeration can see', () => {
    for (const name of ['showView', 'setNavState']) {
      assert.deepStrictEqual(callsSpanningLines(name), [],
        `a ${name} call is broken across lines, so the enumeration cannot read its arguments and `
        + 'would list it wrongly or not at all. Keep a navigation call on one line.');
    }
  });

  test('no destination arrives as text at runtime', () => {
    for (const rel of clientFiles()) {
      const src = commentsStripped(fs.readFileSync(path.join(ROOT, rel), 'utf-8'));
      // Handlers written into generated markup are still text in a .js file, so
      // the scan sees them like any other call. What it could not see is a name
      // assembled at runtime, and there is none: asserted here rather than left
      // as a claim, because it is the one way a destination could exist that no
      // reading of the source would find.
      assert.doesNotMatch(src, /new Function\(|(?:^|[^.\w$])eval\(/,
        `${rel} builds code at runtime, so a destination could exist that no scan of the source `
        + 'can find. Enumerate it here or stop building it.');
      assert.doesNotMatch(src, /(?:window|self|globalThis|root)\s*\[/,
        `${rel} reaches a global by computed name, which can spell showView or setNavState `
        + 'without either appearing in the source. Call it by its name.');
    }
  });

  test('every entry on the rail has an arm that shows a view', () => {
    const body = appPiece(/function switchNav\(nav\) \{([\s\S]*?)\n\}/, 'switchNav');
    for (const section of railSections()) {
      assert.match(body, new RegExp(`nav===['"]${section}['"]`),
        `the rail carries a ${section} entry and switchNav has no arm for it, so pressing it `
        + 'would change nothing at all');
    }
  });
});

describe('one place decides what the chrome shows', () => {
  // The rule, mechanically. Both halves of the chrome had two writers and both
  // pairs drifted: the rail because destinations forgot the second call, the
  // panels because a change extended one hard-coded list and not the other.
  // THE RULE ITSELF, and the one check the other two cannot stand in for.
  // Every destination that got this wrong got it wrong by naming a section
  // here, in its own file, next to its own showView call, and naming the wrong
  // one. Scanning for rail and panel writes does not see that, because
  // setNavState is exactly the function that hides those writes behind a name.
  test('nothing but showView asks for a section', () => {
    assert.deepStrictEqual(callSites('setNavState'), PANEL_DECIDERS.map(d => d.caller).sort(),
      'a destination is setting its own nav state. That is the defect this file exists to end: '
      + 'the section belongs to the view, so show the view and let showView resolve it. Every '
      + 'caller that did this for itself named the wrong section at least once. If a new caller '
      + 'genuinely sets the chrome with no view to take it from, list it above with the reason.');
    for (const d of PANEL_DECIDERS) {
      assert.ok(d.why && d.why.length > 100,
        `${d.what} asks for a section directly and the reason is too thin to be a decision`);
    }
  });

  test('nothing outside setNavState decides which sidebar panel is visible', () => {
    assert.deepStrictEqual(chromeWriters().panels, ['app.js: function setNavState(nav)'],
      'a second place hides or reveals sidebar panels. There were two once and they drifted '
      + 'apart, leaving two panels stacked in one column. Ask setNavState instead.');
  });

  test('nothing outside setNavState decides which rail entry is lit', () => {
    assert.deepStrictEqual(chromeWriters().rail, ['app.js: function setNavState(nav)'],
      'a second place lights a rail entry. Every route that did this forgot the panel half of '
      + 'it at least once. Show the view and let showView resolve the section.');
  });

  // THE REASON THE TWO NO-SECTION ROWS GIVE, held rather than asserted. Both say
  // the chrome comes down on the way to the picker. That was true of one route
  // and not the other: the hide and the show were written into the two
  // functions that happened to need them, so the reply carrying "no workspace"
  // reached the picker with the rail still up. One owner, and every route to
  // that screen goes through it.
  test('one place decides whether there is any chrome at all', () => {
    const writers = [];
    for (const rel of clientFiles()) {
      const lines = commentsStripped(fs.readFileSync(path.join(ROOT, rel), 'utf-8')).split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!/\.(?:nav-rail|sidebar)['"`]\s*\)\s*(?:\?\.)?\.?style|['"`]no-workspace['"`]/.test(lines[i])) continue;
        writers.push(`${rel.replace('public/', '')}: ${ownerOf(lines, i)}`);
      }
    }
    assert.deepStrictEqual([...new Set(writers)].sort(), ['app.js: function setWorkspaceChrome(present)'],
      'a second place decides whether the rail and the sidebar are on screen. There were two, and '
      + 'a third route to the workspace picker went through neither, showing that screen with the '
      + 'rail still up and the previous entry still lit over it.');
  });

  test('the panels setNavState hides are the panels the page carries', () => {
    assert.deepStrictEqual(panelsSetNavStateHides(), panelsOnPage(),
      'the sidebar carries a panel setNavState does not know about, or knows about one the page '
      + 'no longer carries. The first leaves two panels visible at once.');
  });
});

// ===== PRESSING THEM =====

// A shell carrying the REAL nav rail and the REAL sidebar, cut out of
// index.html rather than written again here. Written here, this file would
// keep passing after the page stopped carrying the elements the functions
// under test resolve by name, which is the failure the routines door file
// records having had.
function shellMarkup(views) {
  const rail = /<nav class="nav-rail"[\s\S]*?<\/nav>/.exec(INDEX_SRC);
  assert.ok(rail, 'index.html no longer carries a nav rail');
  const sidebar = /<aside class="sidebar"[\s\S]*?<\/aside>/.exec(INDEX_SRC);
  assert.ok(sidebar, 'index.html no longer carries a sidebar');
  // The view panels are stubs, and only these are: the assertions below are
  // about which icon is lit and which panel is revealed, and every view id
  // comes from showView's own list, checked against the real page by the
  // enumeration above.
  const panes = views.map(v => `<div id="view-${v}" class="hidden"></div>`).join('');
  // The app wrapper and the search control, because taking the chrome down
  // touches both and a function that silently found neither would assert
  // nothing about them.
  return `<!doctype html><html><body><div class="app">${rail[0]}${sidebar[0]}`
    + `<div id="tb-search"></div>${panes}</div></body></html>`;
}

// The shipped setNavState and the shipped showView, cut out of app.js and run.
// A copy of either written here would pass forever after the real one changed.
function shell() {
  const views = viewsShowViewKnows();
  const dom = new JSDOM(shellMarkup(views), { runScripts: 'dangerously' });
  const w = dom.window;
  // ONE eval, and it has to be one: a lexical declaration inside an eval lives
  // in that eval's own environment, so the two tables loaded separately would
  // be gone by the time the functions ran. Loaded together, the functions close
  // over them, which is also how they sit in app.js.
  w.eval([
    NAV_FOR_VIEW_SRC[0],
    `function setNavState(nav) {${appPiece(/function setNavState\(nav\) \{([\s\S]*?)\n\}/, 'setNavState')}\n}`,
    `function showView(v) {${appPiece(/^function showView\(v\) \{(.*)\}\s*$/m, 'showView')}}`,
    `function setWorkspaceChrome(present) {${appPiece(/function setWorkspaceChrome\(present\) \{([\s\S]*?)\n\}/, 'setWorkspaceChrome')}\n}`,
  ].join('\n'));
  return { w, doc: w.document, dom, views };
}

function litSections(doc) {
  return [...doc.querySelectorAll('.nav-item[data-nav].active')].map(e => e.dataset.nav);
}

function visiblePanels(doc) {
  return [...doc.querySelectorAll('aside.sidebar > [id^="sidebar-"]')]
    .filter(e => !e.classList.contains('hidden')).map(e => e.id.replace('sidebar-', ''));
}

describe('the chrome, pressed', () => {
  // THE ONE TEST THAT COVERS EVERY DESTINATION, and it covers them because the
  // source changed shape rather than because it was written wide. Nav state
  // used to be a second call each destination made for itself, so pressing all
  // of them meant pressing twenty functions. It is now resolved from the view,
  // so pressing every view presses every destination that shows one.
  test('every view the shell can show lands the rail on the section its own table names', () => {
    const table = navForView();
    for (const view of viewsShowViewKnows()) {
      const section = table[view];
      if (section === null) continue;
      const { w, doc, dom } = shell();
      w.showView(view);
      assert.deepStrictEqual(litSections(doc), [section],
        `showing ${view} lit ${litSections(doc).join(', ') || 'nothing'} rather than ${section}`);
      assert.deepStrictEqual(visiblePanels(doc), [section],
        `showing ${view} left ${visiblePanels(doc).length} sidebar panels visible`);
      assert.ok(!doc.getElementById(`view-${view}`).classList.contains('hidden'),
        `showing ${view} lit the rail and did not reveal the pane`);
      dom.window.close();
    }
  });

  // Kept as a test of its own because it is the one a reader will look for. It
  // is pressed through the shipped mechanism rather than by matching a string in
  // the editor.
  test('the routine editor is a routines surface and the rail says so', () => {
    const { w, doc, dom } = shell();
    // A REAL VIEW, and it has to be: 'team' is a rail section and not a view, so
    // showing it moved nothing and left the assertion below with nothing to
    // discriminate. The org chart is the view that lands on Team.
    w.showView('home');
    assert.deepStrictEqual(litSections(doc), ['team'],
      'sanity: the rail is on another section before the editor is opened, or this proves nothing');
    w.showView('routine-editor');
    assert.deepStrictEqual(litSections(doc), ['routines'],
      'opening the routine editor lights the wrong entry. It lit Team for as long as the editor '
      + 'existed, on a surface whose whole subject is routines.');
    dom.window.close();
  });

  // THE ROUTE THAT SAYS THERE IS NO WORKSPACE, pressed as the dispatch runs it.
  // It is a different route to the same screen from the picker's own, and it
  // used to differ: it showed the screen and left the chrome up, so the rail
  // stayed lit over a page meaning you have no workspace to have a section of.
  test('the route that says there is no workspace takes the chrome down with it', () => {
    const { w, doc, dom } = shell();
    // THE CHROME HAS TO BE UP FIRST. The rail ships hidden in index.html, which
    // the shell cuts out whole, so a test that presses this without raising it
    // asserts 'none' against a rail that was never up: the mutation that takes
    // the hide away turns nothing red and the proof is an ornament.
    w.setWorkspaceChrome(true);
    w.showView('home');
    const before = litSections(doc);
    assert.deepStrictEqual(before, ['team'], 'sanity: a section is lit before the reply arrives');
    assert.strictEqual(doc.querySelector('.nav-rail').style.display, '',
      'sanity: the rail is up before the reply arrives, or hiding it proves nothing');
    const body = appPiece(/case 'needs_workspace':([\s\S]*?)break;/,
      'the needs_workspace case of the client dispatch');
    w.eval(`(function () {${body}\n})()`);
    assert.strictEqual(doc.querySelector('.nav-rail').style.display, 'none',
      'the reply saying there is no workspace showed that screen with the rail still up');
    assert.strictEqual(doc.querySelector('.sidebar').style.display, 'none',
      'the reply saying there is no workspace showed that screen with the sidebar still up');
    assert.deepStrictEqual(litSections(doc), before,
      'the reply saying there is no workspace moved the rail as well as hiding it');
    assert.ok(!doc.getElementById('view-workspace').classList.contains('hidden'),
      'the reply saying there is no workspace did not show the picker');
    dom.window.close();
  });

  test('the workspace picker takes no nav state, because it has no rail to take one on', () => {
    const { w, doc, dom } = shell();
    // The rail has to be somewhere before this can show it stays there. It used
    // to be set with showView('team'), which is a section and not a view, so
    // nothing was lit and the assertion compared an empty list with an empty
    // one: it could not have caught the picker clearing the rail, which is the
    // defect its own message describes.
    w.showView('home');
    const before = litSections(doc);
    const panelsBefore = visiblePanels(doc);
    assert.deepStrictEqual(before, ['team'], 'sanity: a section is lit before the picker is shown');
    assert.strictEqual(panelsBefore.length, 1, 'sanity: a panel is open before the picker is shown');
    w.showView('workspace');
    assert.deepStrictEqual(litSections(doc), before,
      'showing the workspace picker moved the rail behind it. There is no section to be on when '
      + 'there is no workspace, and the chrome is taken down while it is up.');
    assert.deepStrictEqual(visiblePanels(doc), panelsBefore,
      'showing the workspace picker changed which sidebar panel is open behind it');
    dom.window.close();
  });

  test('exactly one sidebar panel is visible after any section is set', () => {
    for (const section of railSections()) {
      const { w, doc, dom } = shell();
      w.setNavState(section);
      assert.strictEqual(visiblePanels(doc).length, 1,
        `setting ${section} left ${visiblePanels(doc).length} panels visible`);
      dom.window.close();
    }
  });

  // The second hard-coded panel list, pressed at the line that used to be it.
  // The copy lit the icon and hid the panels by hand and never touched the
  // footer, so switching workspace from any section but Conversations left the
  // reader on Conversations with no New conversation button.
  test('switching workspace resets the chrome through the one place that owns it', () => {
    const line = /function resetSidebarForWorkspace\(\)[\s\S]*?\n(\s*setNavState\('conversations'\);)/
      .exec(APP_SRC);
    assert.ok(line, 'the workspace reset no longer settles the chrome through setNavState');
    const { w, doc, dom } = shell();
    w.setNavState('skills');
    assert.ok(doc.getElementById('convo-footer').classList.contains('hidden'),
      'sanity: the New conversation footer is down while another section is up');
    w.eval(line[1]);
    assert.deepStrictEqual(litSections(doc), ['conversations']);
    assert.deepStrictEqual(visiblePanels(doc), ['conversations']);
    assert.ok(!doc.getElementById('convo-footer').classList.contains('hidden'),
      'switching workspace put the reader on Conversations with no New conversation button');
    dom.window.close();
  });
});

describe('what this file does not catch, said rather than implied', () => {
  test('every hole is named with what a person would have to notice instead', () => {
    assert.ok(NOT_CAUGHT.length >= 3, 'a manifest with no holes has not been read honestly');
    for (const hole of NOT_CAUGHT) {
      assert.ok(hole.what && hole.why && hole.why.length > 80,
        `"${hole.what}" is listed as a hole with no account of what would catch it instead`);
      assert.match(hole.why, /person has to notice|business of|What a person/,
        `"${hole.what}" says what is not caught and not who catches it`);
    }
  });
});
