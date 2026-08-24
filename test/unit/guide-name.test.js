'use strict';
// The guide is found by type and never by name, so nothing may name it.
//
// THE DEFECT, AND WHY IT READS AS FINE UNTIL IT DOES NOT. `getGuide()` matches
// on `type === 'platform'`. It has never matched on a name. Four strings a
// person reads named one anyway, so a workspace whose platform agent is called
// anything else was told to talk to somebody it does not have, with the button
// beside the sentence opening a conversation with a differently named agent.
// On the shipped default workspace the name happens to be right, which is why
// four surfaces carried it for as long as they did.
//
// SO THE WORKSPACE HERE IS NOT THE DEFAULT ONE. Its platform agent is Wren,
// the same name the empty-states card used for the same reason: with the
// default name in the fixture, a hard-coded literal passes every assertion
// below on the strength of a coincidence.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf-8');
// THE COPY MODULE IS LOADED IF IT IS THERE, AND THAT IS ABOUT WHAT THIS FILE
// FAILS ON. Against the code before this change there is no such module and
// the views carry the four sentences themselves, so the walks below have to go
// red for what the page says rather than for a file that could not be read.
// The claims about the module itself, further down, are the ones entitled to
// fail because it is missing.
const COPY_PATH = path.join(ROOT, 'public', 'guide-copy.js');
const COPY_SRC = fs.existsSync(COPY_PATH) ? fs.readFileSync(COPY_PATH, 'utf-8') : '';
const TEAM_SRC = read('public', 'views', 'team.js');
const PROFILE_SRC = read('public', 'views', 'profile.js');

// The name the shipped workspace's guide happens to have, and the one no
// string may carry. Matched as a word so "Docs" and "document" are not hits.
const DEFAULT_GUIDE = /\bDoc\b/;

// A guide named anything cannot be assumed to be a "he", or a "they". Matched
// as words, and deliberately not including "it": a schedule that runs is an
// "it", and that is a pronoun for a routine rather than for an agent.
const PRONOUNS = /\b(he|him|his|she|her|hers|they|them|their|theirs)\b/i;

// The four surfaces, each named with the function that draws it and the
// question a reader is answering when they meet it. A fifth one naming the
// guide is a fifth row here.
const SURFACES = [
  { key: 'sidebar', draws: 'renderAgentList', where: 'the team sidebar with no team on it' },
  { key: 'conversations', draws: 'renderConvoEmptyAgents', where: 'the conversations pane with no team on it' },
  { key: 'fresh', draws: 'renderOrgChart', where: 'the org chart on a fresh workspace' },
  { key: 'setup', draws: 'showProfile', where: 'the Setup button on an agent that has not been set up' },
];

function shellMarkup() {
  return '<!doctype html><html><body>'
    + '<div id="agent-list"></div><div id="sidebar-team-header"></div>'
    + '<div id="convo-empty-label"></div><div id="convo-empty-content"></div>'
    + '<div id="org-chart"></div>'
    + '<div id="profile-content"></div>'
    + '</body></html>';
}

function shell({ guideName = 'Wren', guide = true } = {}) {
  const dom = new JSDOM(shellMarkup(), { runScripts: 'dangerously' });
  const w = dom.window;
  if (COPY_SRC) w.eval(COPY_SRC);
  w.eval(TEAM_SRC);
  w.eval(PROFILE_SRC);
  const platform = guide
    ? [{ id: 'archivist', displayName: guideName, role: 'Guide', colour: '#6BC67E', icon: 'W', status: 'onTeam', type: 'platform' }]
    : [];
  w.agents = [
    ...platform,
    // An agent that has never been set up, which is the state the Setup button
    // belongs to.
    { id: 'ted', displayName: 'Ted', role: 'Inventory', colour: '#E87A5A', icon: 'T', status: 'raw', runtime: 'claude' },
  ];
  w.conversations = [];
  w.skills = [];
  w.convoState = {};
  w.agentLastActivity = {};
  w.workspaceAnalysis = null;
  w.currentWorkspacePath = null;
  w.orgZoomOffset = 0;
  w.esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  w.formatTimeAgo = () => 'a while ago';
  w.getTeamAgents = () => w.agents.filter(a => a.status === 'onTeam' && a.type !== 'platform');
  w.getPlatformAgents = () => w.agents.filter(a => a.status === 'onTeam' && a.type === 'platform');
  w.getGuide = () => w.agents.filter(a => a.type === 'platform')[0] || null;
  w.setNavState = () => {};
  w.showView = () => {};
  w.switchNav = () => {};
  w.startConversation = () => {};
  w.startSetupConversation = () => {};
  w.addToTeam = () => {};
  w.openConversation = () => {};
  w.selectSkill = () => {};
  w.showRoutinesForAgent = () => {};
  w.addRoutineForAgent = () => {};
  return { w, doc: w.document, dom };
}

// Every surface, drawn, one entry each. Kept apart rather than joined into one
// blob, because "the name is somewhere on the page" is a claim two of these
// surfaces satisfy for free: both draw the roster, and the guide is a row in
// it. What is asked below is that the SENTENCE names the guide, surface by
// surface.
function drawAll(w, doc) {
  w.renderAgentList();
  w.renderConvoEmptyAgents();
  w.renderOrgChart();
  w.showProfile('ted');
  return SURFACES.map((surface, i) => ({
    ...surface,
    text: [
      doc.getElementById('agent-list'),
      doc.getElementById('convo-empty-content'),
      doc.getElementById('org-chart'),
      doc.getElementById('profile-content'),
    ][i].textContent.replace(/\s+/g, ' ').trim(),
  }));
}

function allText(surfaces) {
  return surfaces.map(s => s.text).join(' · ');
}

/**
 * The surfaces whose OWN LINE names the guide.
 *
 * The line is taken from the copy object and substituted here, so this asks
 * whether the page shows the sentence the object holds rather than whether the
 * name appears anywhere near it. Where the object is absent, as it is against
 * the code before this change, nothing can be named and the count is zero,
 * which is the answer that makes these tests fail for the right reason.
 */
function surfacesNamingTheGuide(surfaces, name) {
  const copy = COPY_SRC ? require(COPY_PATH) : null;
  if (!copy) return 0;
  return surfaces.filter(s => s.text.includes(copy.GUIDE_COPY[s.key].replace('{agent}', name))).length;
}

describe('the guide is named through a slot or not named at all', () => {
  // AC-C3, and the assertion the whole file exists for. The workspace's guide
  // is Wren, so a literal fails here rather than passing on a coincidence.
  test('a workspace whose guide is not called the default reads correctly everywhere', () => {
    const { w, doc, dom } = shell({ guideName: 'Wren' });
    const surfaces = drawAll(w, doc);
    const shown = allText(surfaces);
    assert.ok(!DEFAULT_GUIDE.test(shown),
      `a surface names an agent this workspace does not have: ${shown}`);
    assert.strictEqual(surfacesNamingTheGuide(surfaces, 'Wren'), SURFACES.length,
      'a surface either says nothing about the guide or says the wrong thing about it');
    dom.window.close();
  });

  // The slot takes whatever the workspace calls its guide, including a name
  // nobody would choose, because the roster is the only thing that decides it.
  test('any name the roster carries reaches every surface that names one', () => {
    for (const name of ['Wren', 'Atlas', 'Doc Brown & Co']) {
      const { w, doc, dom } = shell({ guideName: name });
      const surfaces = drawAll(w, doc);
      assert.strictEqual(surfacesNamingTheGuide(surfaces, name), SURFACES.length,
        `the guide is called ${name} and a surface does not say so`);
      assert.ok(!allText(surfaces).includes('{agent}'), 'a slot reached the page unsubstituted');
      dom.window.close();
    }
  });

  // AC-C2. Checked on what a reader sees rather than on the copy object, so a
  // pronoun written straight into a view is a hit too.
  test('nothing a reader sees carries a pronoun for an agent', () => {
    const { w, doc, dom } = shell();
    const hit = PRONOUNS.exec(allText(drawAll(w, doc)));
    assert.strictEqual(hit, null, hit && `a surface calls an agent "${hit[0]}"`);
    dom.window.close();
  });

  // The state the org chart used to promise a guide in regardless. It is the
  // only one of the four that rendered its sentence with no guide at all, so
  // it is the only one that needs a line for that case; the others do not draw
  // at all without one, and say so by returning nothing.
  test('a workspace with no guide is not told to talk to one', () => {
    const { w, doc, dom } = shell({ guide: false });
    const shown = allText(drawAll(w, doc));
    assert.ok(!DEFAULT_GUIDE.test(shown), 'a surface names a guide this workspace does not have');
    assert.ok(!/Wren/.test(shown), 'a surface names a guide this workspace does not have');
    assert.ok(!shown.includes('{agent}'), 'an empty slot reached the page');
    // And it still says what to do next, rather than stopping at what the
    // thing is.
    assert.match(doc.getElementById('org-chart').textContent, /Fresh workspace/,
      'the fresh-workspace state lost its words along with the guide');
    dom.window.close();
  });
});

describe('the strings stay readable in one place', () => {
  // AC-C4. The point of one object is that a copy check can read all of it, so
  // this asserts the object holds the surfaces rather than the views holding
  // fragments of them.
  test('every surface takes its line from the one copy object', () => {
    const copy = require(path.join(ROOT, 'public', 'guide-copy.js'));
    for (const surface of SURFACES) {
      const line = copy.GUIDE_COPY[surface.key];
      assert.ok(typeof line === 'string' && line.length,
        `${surface.where} has no line in the copy object`);
      assert.ok(line.includes('{agent}'),
        `the line for ${surface.where} names the guide some other way than through the slot`);
      assert.ok(!DEFAULT_GUIDE.test(line), `the line for ${surface.where} carries a name`);
      assert.ok(!PRONOUNS.test(line), `the line for ${surface.where} carries a pronoun`);
    }
  });

  // SUBSTITUTED RATHER THAN CONCATENATED, which is the rule the editor's own
  // step leads already state: every word shipped stays inside one object, so a
  // copy check reads all of it. A view that built the sentence around a name
  // would put half the copy at the call site.
  test('no view assembles one of these sentences at the call site', () => {
    const copy = require(path.join(ROOT, 'public', 'guide-copy.js'));
    for (const [key, line] of Object.entries(copy.GUIDE_COPY)) {
      const words = line.split('{agent}').map(part => part.trim()).filter(part => part.length > 12);
      for (const src of [TEAM_SRC, PROFILE_SRC]) {
        for (const fragment of words) {
          assert.ok(!src.includes(fragment),
            `a view carries the words of "${key}" itself, so the copy is in two places`);
        }
      }
    }
  });

  test('a name the workspace does not have is substituted, never concatenated', () => {
    const copy = require(path.join(ROOT, 'public', 'guide-copy.js'));
    assert.strictEqual(copy.guideLine('sidebar', 'Wren'), copy.GUIDE_COPY.sidebar.replace('{agent}', 'Wren'));
    assert.strictEqual(copy.guideLine('sidebar', null), null,
      'a surface with no line for a guideless workspace claims to have one');
    assert.ok(copy.guideLine('fresh', null),
      'the one surface that draws without a guide has nothing to draw');
    assert.ok(!/\{agent\}/.test(copy.guideLine('fresh', null)), 'the guideless line carries a slot');
  });
});
