'use strict';
// The team panel: the agent roster, and nothing else.
//
// WHY THIS FILE IS A SWEEP AND NOT A LIST OF TESTS.
//
// Removing a listing is the easy half. The half that costs somebody a day is
// what the listing leaves behind: a render function nothing calls, a formatter
// with no caller, an empty element in the page that another module is quietly
// using as a sentinel. A listing left unreferenced is the shape the next
// person re-wires when they need something like it, and a helper left behind
// is the shape they re-wire it out of.
//
// So this file enumerates two things and checks both against the source:
//
//   SWEPT  what went, asserted absent everywhere rather than absent from the
//          one file somebody remembered to look in
//   KEPT   what the listing touched that survives, each with the reason it
//          survives, so a reader can tell a decision from an oversight
//
// And the panel itself is PRESSED: the roster arrives through the real client
// dispatch, cut out of app.js and run, into the real sidebar markup, cut out
// of index.html. A copy of either in this file would keep passing after the
// page stopped carrying it.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf-8');
const APP_SRC = read('public', 'app.js');
const INDEX_SRC = read('public', 'index.html');
const TEAM_SRC = read('public', 'views', 'team.js');

// ===== THE SWEEP =====

// Gone, and gone from everywhere. Each row names the symbol and what it was,
// so a reader coming back to this does not have to reconstruct why it is
// listed. `where` is the tree the symbol must not appear in: the client for
// markup and behaviour, the suite and the instruments for anything that
// propped it up, because a mutation harness still naming a deleted guard is a
// check that silently stopped checking.
const SWEPT = [
  {
    name: 'renderRoutinesSidebar',
    was: 'the listing itself, in views/team.js, and its call in the roster dispatch',
  },
  {
    name: 'formatScheduleShort',
    was: 'the schedule words the listing showed, in app.js. The listing was its only caller, '
      + 'and the profile\'s new Routines box takes its words from routines-model instead, '
      + 'so the whole surface has one vocabulary rather than two.',
  },
  {
    name: 'SIDEBAR_FOR',
    was: 'the router\'s alias map, which pointed the routines section at the team panel',
    why: 'the card that was carded separately landed: the routines section has a sidebar '
      + 'panel of its own, so the map held nothing. An alias map with nothing in it is a '
      + 'redirection waiting to be reintroduced without anybody noticing.',
  },
];

// Touched by the listing and still here, each with the reason. An unlisted
// survivor reads as something nobody looked at.
const KEPT = [
  {
    name: 'sidebar-routines',
    where: 'public/index.html',
    why: 'the name is back and it is a different thing. It was an empty sentinel nested '
      + 'inside the team panel, which is why revealing it by name succeeded and showed a '
      + 'reader nothing. It is now the routines section\'s own top-level panel, holding the '
      + 'agent scope list, and the router and the editor\'s save destination both resolve to '
      + 'it by that name.',
  },
  {
    name: 'addRoutine',
    where: 'public/views/routines.js',
    why: 'the unscoped way into the editor. The listing carried one and so does the routines '
      + 'view\'s empty state; removing the listing removes one of two doors, not the only one.',
  },
  {
    name: '.re-link',
    where: 'public/styles/views/routine-editor.css',
    why: 'the listing borrowed this class for its Add control, which is the pattern the card '
      + 'objected to. It belongs to the routine editor, which still uses it on the '
      + 'confirmation step\'s Edit link.',
  },
];

function filesUnder(dir, keep, skip) {
  const out = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      if (entry.name === 'vendor' || entry.name === 'node_modules') continue;
      if (skip && skip.has(rel + '/' + entry.name)) continue;
      const next = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(next);
      else if (keep(entry.name)) out.push(next);
    }
  };
  walk(dir);
  return out;
}

// Everywhere a swept name could still be named: the client, the suite, and the
// scripts that run against both.
//
// THE MUTATION HARNESS IS THE ONE EXCLUSION, and it is the check working
// rather than a hole in it. What this card leaves behind is a rule about
// ABSENCE, and an absence no instrument can break is an absence no instrument
// is checking, so the harness's job here is to write the swept element back
// into the page and require this file to notice. It names the thing it
// reinstates, necessarily. Excluding anything wider would let a swept name
// come back through a test.
const NOT_SEARCHED = new Set(['test/tools']);

function sweptSearchPaths() {
  const isSource = (name) => /\.(js|html|css|json)$/.test(name);
  return [
    ...filesUnder('public', isSource),
    ...filesUnder('test', isSource, NOT_SEARCHED),
    ...filesUnder('scripts', isSource),
  ];
}

describe('the routines listing left nothing behind', () => {
  // THE CHECK THAT MAKES THE REMOVAL A REMOVAL. A function left in place with
  // no caller passes every behavioural test in this file: nothing renders it,
  // so nothing sees it. This is the only assertion that can tell "removed"
  // from "unreferenced".
  test('nothing swept is named anywhere in the client, the suite or the instruments', () => {
    for (const swept of SWEPT) {
      const survivors = sweptSearchPaths().filter((rel) => (
        path.join(ROOT, rel) !== __filename
        && fs.readFileSync(path.join(ROOT, rel), 'utf-8').includes(swept.name)
      ));
      assert.deepStrictEqual(survivors, [],
        `${swept.name} was ${swept.was}, and is still named in ${survivors.join(', ')}`);
    }
  });

  test('everything kept says where it lives and why', () => {
    for (const kept of KEPT) {
      assert.ok(kept.why && kept.why.length > 40,
        `${kept.name} is kept without a reason, which reads as something nobody looked at`);
      assert.ok(read(...kept.where.split('/')).includes(kept.name),
        `${kept.name} is listed as kept and ${kept.where} no longer names it`);
    }
  });

  // The listing's own stylesheet rules. A rule with nothing to match is dead
  // in the way that is hardest to see, because no test ever renders it.
  test('the listing took its stylesheet rules with it', () => {
    const styles = filesUnder('public/styles', (n) => n.endsWith('.css'))
      .map(rel => read(...rel.split('/').filter(Boolean)))
      .join('\n');
    for (const selector of ['.routine-item', '.routine-name', '.avatar.xxs']) {
      assert.ok(!styles.includes(selector),
        `${selector} was only ever matched by the sidebar listing and is still in the stylesheet`);
    }
  });
});

// ===== PRESSING THE PANEL =====

// The real sidebar, cut out of the real page. The roster is delivered through
// the real dispatch. Nothing about the panel is written here, so a panel that
// starts carrying something again fails this rather than agreeing with it.
function shellMarkup() {
  const sidebar = /<aside class="sidebar"[\s\S]*?<\/aside>/.exec(INDEX_SRC);
  assert.ok(sidebar, 'index.html no longer carries a sidebar');
  return '<!doctype html><html><body>' + sidebar[0] + '</body></html>';
}

function appPiece(pattern, label) {
  const m = APP_SRC.match(pattern);
  assert.ok(m && m[1] && m[1].trim(), `app.js no longer carries ${label}`);
  return m[1];
}

const ROUTINE = { name: 'Compile the ops summary', schedule: 'every day at 07:00', state: null };

function shell() {
  const dom = new JSDOM(shellMarkup(), { runScripts: 'dangerously' });
  const w = dom.window;
  w.eval(TEAM_SRC);
  w.agents = [
    {
      id: 'piper', displayName: 'Piper', role: 'Ops', colour: '#E87A5A', icon: 'P',
      status: 'onTeam', type: 'specialist',
      routines: [ROUTINE, { name: 'Draft the stand-up notes', schedule: 'every day at 08:30', state: null }],
    },
    { id: 'ted', displayName: 'Ted', role: 'Inventory', colour: '#6BC67E', icon: 'T', status: 'onTeam', type: 'specialist' },
  ];
  w.convoState = {};
  w.conversations = [];
  w.agentLastActivity = {};
  w.esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  w.formatTimeAgo = () => 'a while ago';
  w.getTeamAgents = () => w.agents.filter(a => a.status === 'onTeam' && a.type !== 'platform');
  w.getPlatformAgents = () => w.agents.filter(a => a.type === 'platform');
  w.renderOrgChart = () => {};
  w.renderConvoList = () => {};
  w.renderRoutines = () => {};
  // The routines panel draws into its own sidebar, which this suite is not
  // about. Stubbed beside the list for the same reason the list is.
  w.renderRoutinesPanel = () => {};
  // The run detail screen this suite never opens, so there is nothing for a
  // roster update to refresh: stubbed so the roster case this file evals can
  // run at all.
  w.runDetailRosterUpdated = () => {};
  // Every swept global, stubbed BY THE NAME THE SWEEP LISTS rather than
  // written out here, and only where nothing already answers to it.
  //
  // WITHOUT THIS THESE TESTS FAIL FOR THE WRONG REASON IN BOTH DIRECTIONS.
  // Against the code before this card the listing renders, reaches for the
  // schedule formatter on the global, and throws, so the assertion about what
  // the panel shows is never reached and the red says nothing. Against the
  // code after it, nothing reads the stub at all. What fails these tests is
  // the panel's contents, which is what they are about.
  for (const swept of SWEPT) {
    if (!/^[A-Za-z_$][\w$]*$/.test(swept.name)) continue;
    if (typeof w[swept.name] !== 'undefined') continue;
    w[swept.name] = (value) => value;
  }
  return { w, doc: w.document, dom };
}

// The roster arriving, through the dispatch that delivers it, into the page.
function deliverRoster(w) {
  const body = appPiece(/case 'agents':([\s\S]*?)\bbreak;/, 'the roster case of the client dispatch');
  // The case also records the workspace the roster was read from, which the
  // routines list compares each row against. Nothing in this panel reads it,
  // so it is stubbed here and driven where it is read, in
  // test/unit/routines-end-to-end.test.js.
  if (typeof w.setServingWorkspace !== 'function') w.setServingWorkspace = () => {};
  w.d = { type: 'agents', agents: w.agents, workspace: '/w/open' };
  w.eval(`(function () {${body}\n})()`);
}

describe('the team panel shows the agent roster and nothing else', () => {
  test('a roster full of routines draws no routine in the team panel', () => {
    const { w, doc, dom } = shell();
    deliverRoster(w);
    const panel = doc.getElementById('sidebar-team');
    assert.ok(panel, 'index.html no longer carries a team panel');
    const shown = panel.textContent.replace(/\s+/g, ' ').trim();
    assert.match(shown, /Piper/, 'sanity: the roster is on the page');
    for (const routine of w.agents[0].routines) {
      assert.ok(!shown.includes(routine.name),
        `the team panel still lists "${routine.name}", which is the listing this card removes`);
    }
    assert.ok(!/Routines/.test(shown), 'the team panel still carries a Routines heading');
    assert.ok(!/7:00|07:00|8:30|08:30/.test(shown),
      'the team panel still shows a schedule, so the listing is drawn somewhere in it');
    dom.window.close();
  });

  // AC-A2, and it is a check on what was NOT built as much as what was
  // removed. The locked mock replaced the listing with a per-agent count pill;
  // the owner overruled that, so an agent row carries a name and a working
  // state and no number at all.
  test('no agent row carries a routine count', () => {
    const { w, doc, dom } = shell();
    deliverRoster(w);
    for (const row of doc.querySelectorAll('#agent-list .agent-status-item')) {
      const text = row.textContent.replace(/\s+/g, ' ').trim();
      assert.ok(!/\d/.test(text),
        `an agent row reads "${text}", and a number on a row is the count pill the owner overruled`);
      assert.strictEqual(row.querySelector('.rcount'), null, 'an agent row carries a count pill');
    }
    dom.window.close();
  });

  // The panel's own contents, enumerated rather than sampled. "Nothing else"
  // is a claim about everything the panel holds, so it is asserted against
  // everything the panel holds.
  test('the team panel holds its header and its roster and no third thing', () => {
    const { w, doc, dom } = shell();
    deliverRoster(w);
    const panel = doc.getElementById('sidebar-team');
    const children = [...panel.children].map(el => el.id || el.className);
    assert.deepStrictEqual(children, ['sidebar-team-header', 'agent-list'],
      'the team panel carries something beyond its header and its roster');
    dom.window.close();
  });
});
