'use strict';
// The routines sidebar panel: a scope list, not a roster.
//
// WHY THIS FILE CUTS ITS SHELL OUT OF index.html RATHER THAN WRITING ONE.
//
// The thing this panel is has been settled twice and reversed once. It was a
// child of the team panel by construction: `#sidebar-routines` nested inside
// `#sidebar-team`, with the rail mapping routines onto team and a comment
// arguing for it. Every fact this file asserts about where the panel sits is
// therefore a fact about the page, and a copy of that page written here would
// keep agreeing with itself after the page stopped agreeing with it.
//
// That is not hypothetical on this codebase. An earlier card found a test
// supplying the very panel whose existence it was checking, which made the
// editor's save destination unfalsifiable: rename the panel and the save lands
// on the team chart with the suite green. So the rail and the sidebar are cut
// out of the real file, every time, and a rename fails this rather than
// passing through it.
//
// WHAT THE MODEL DECIDES AND WHAT THIS FILE PRESSES. Every count, every row
// and every word comes from public/routines-scope-model.js, which has no DOM
// in it. This file drives the rendered panel, because a scope list that is
// correct in a model and never drawn is the defect this panel exists to fix.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf-8');
const INDEX_SRC = read('public', 'index.html');
const APP_SRC = read('public', 'app.js');
const SCOPE_MODEL_SRC = read('public', 'routines-scope-model.js');
const SKILLS_MODEL_SRC = read('public', 'skills-model.js');
const ROUTINES_MODEL_SRC = read('public', 'routines-model.js');
const EDITOR_MODEL_SRC = read('public', 'routine-editor-model.js');
const PANEL_SRC = read('public', 'views', 'routines-panel.js');
const ROUTINES_VIEW_SRC = read('public', 'views', 'routines.js');
const EDITOR_VIEW_SRC = read('public', 'views', 'routine-editor.js');

const SCOPE_MODEL = require(path.join(ROOT, 'public', 'routines-scope-model.js'));
const EDITOR_MODEL = require(path.join(ROOT, 'public', 'routine-editor-model.js'));
const ROUTINES_MODEL = require(path.join(ROOT, 'public', 'routines-model.js'));

// ===== THE SHELL, CUT OUT OF THE PAGE =====

function pageShell() {
  const rail = /<nav class="nav-rail"[\s\S]*?<\/nav>/.exec(INDEX_SRC);
  assert.ok(rail, 'index.html no longer carries a nav rail');
  const sidebar = /<aside class="sidebar"[\s\S]*?<\/aside>/.exec(INDEX_SRC);
  assert.ok(sidebar, 'index.html no longer carries a sidebar');
  const view = /<div id="view-routines"[\s\S]*?<\/div>\s*<\/div>/.exec(INDEX_SRC);
  assert.ok(view, 'index.html no longer carries the routines view panel');
  return '<!doctype html><html><body>' + rail[0] + sidebar[0]
    + '<div id="view-home"></div>' + view[0]
    + '<div id="view-routine-editor"><div id="routine-editor-content"></div></div>'
    + '</body></html>';
}

function routine(name, extra) {
  return Object.assign({
    name, schedule: 'every day at 07:00', prompt: 'p', runOn: 'local',
    enabled: true, paused: false, state: null,
    nextRun: new Date(2026, 7, 25, 7, 0).toISOString(),
    lastStart: null, lastSlot: null, missedSlot: null,
  }, extra || {});
}

// The roster in FILE ORDER, which is roster order, which is the order the
// panel draws. Deliberately not sorted by count: Piper is first and owns the
// most, so a panel that sorted by count would look identical here. Doc owns
// fewer than Mira, so count order and roster order disagree below Piper and
// the order assertions can actually fail.
function roster() {
  return [
    { id: 'piper', displayName: 'Piper', colour: '#E87A5A', icon: 'P', status: 'onTeam',
      routines: [routine('Compile the ops summary'), routine('Sweep the inbox'), routine('Chase the stragglers')] },
    { id: 'doc', displayName: 'Doc', colour: '#6BC67E', icon: 'D', status: 'onTeam',
      routines: [routine('Refresh the reading digest')] },
    { id: 'mira', displayName: 'Mira', colour: '#A07AE8', icon: 'M', status: 'onTeam',
      routines: [routine('Post the weekly note'), routine('Archive last month')] },
    // Owns none, so she is not a scope.
    { id: 'ana', displayName: 'Ana', colour: '#7AA2E8', icon: 'A', status: 'onTeam', routines: [] },
  ];
}

function shell({ agents = roster() } = {}) {
  const dom = new JSDOM(pageShell(), { runScripts: 'dangerously' });
  const w = dom.window;
  w.eval(EDITOR_MODEL_SRC);
  w.eval(SKILLS_MODEL_SRC);
  w.eval(ROUTINES_MODEL_SRC);
  w.eval(SCOPE_MODEL_SRC);
  w.eval(ROUTINES_VIEW_SRC);
  w.eval(PANEL_SRC);
  w.agents = agents;
  w.skills = [];
  w.skillsLoaded = true;
  w.esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  w.ws = { send: () => {} };
  w.showView = () => {};
  w.routinesNow = () => new Date(2026, 7, 24, 9, 20);
  w.Intl = { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'Europe/London' }) }) };
  return { w, doc: w.document, dom };
}

const scopeRows = (doc) => [...doc.querySelectorAll('#sidebar-routines [data-scope]')];
const scopeNames = (doc) => scopeRows(doc).map(el => el.querySelector('.scope-name').textContent);
const editorLead = (doc) => {
  const el = doc.querySelector('#routine-editor-content .re-lead');
  return el ? el.textContent : null;
};
const activeScope = (doc) => {
  const el = doc.querySelector('#sidebar-routines [data-scope].active');
  return el ? el.getAttribute('data-scope') : null;
};

// ===== AC-1: THE PANEL IS NOT THE TEAM PANEL =====

describe('the routines rail entry reveals a panel of its own', () => {
  // THE DECISION THIS REVERSES, asserted against the page rather than against
  // a belief about it. The panel was a child of the team one, so revealing it
  // by name succeeded, threw nothing, and left the reader looking at a sidebar
  // that stayed hidden because its parent did.
  test('the routines panel is not inside the team panel', () => {
    const { doc, dom } = shell();
    const panel = doc.getElementById('sidebar-routines');
    assert.ok(panel, 'index.html carries no routines sidebar panel');
    const team = doc.getElementById('sidebar-team');
    assert.ok(team, 'sanity: index.html still carries a team panel');
    assert.ok(!team.contains(panel),
      'the routines panel is still a child of the team panel, so the two sidebars are one element');
    assert.strictEqual(panel.parentElement.className, 'sidebar',
      'the routines panel is not a sidebar in its own right');
    dom.window.close();
  });

  test('the rail maps routines to the routines panel and to nothing else', () => {
    // setNavState is cut out of app.js and RUN, so the mapping under test is
    // the one the page ships rather than one restated here.
    const { doc, w, dom } = shell();
    const body = /function setNavState\(nav\) \{([\s\S]*?)\n\}/.exec(APP_SRC);
    assert.ok(body && body[1], 'app.js no longer carries setNavState');
    w.eval(`function setNavState(nav) {${body[1]}\n}`);
    w.setNavState('routines');

    const panel = doc.getElementById('sidebar-routines');
    for (let el = panel; el; el = el.parentElement) {
      assert.ok(!el.classList.contains('hidden'),
        `the routines panel stays out of sight inside #${el.id || el.tagName}`);
    }
    assert.ok(doc.getElementById('sidebar-team').classList.contains('hidden'),
      'the routines section still reveals the team panel');
    dom.window.close();
  });

});

// ===== AC-2, AC-4, AC-5: WHAT THE PANEL DRAWS =====

describe('the scope list', () => {
  test('All routines is drawn, and drawn first, wherever there are owners', () => {
    const { doc, w, dom } = shell();
    w.renderRoutinesPanel();
    assert.strictEqual(scopeNames(doc)[0], SCOPE_MODEL.COPY.all,
      'All routines is not the first row of the panel');
    dom.window.close();
  });

  // AC-2, and the state it is actually about. A filter whose only row is the
  // one that filters nothing still has a stable top edge; a panel that draws
  // nothing at all reads as broken.
  test('All routines is present when no agent owns a routine', () => {
    const { doc, w, dom } = shell({ agents: [{ id: 'ana', displayName: 'Ana', colour: '#7AA2E8', icon: 'A', routines: [] }] });
    w.renderRoutinesPanel();
    assert.deepStrictEqual(scopeNames(doc), [SCOPE_MODEL.COPY.all],
      'the empty panel drew something other than the pinned row alone');
    dom.window.close();
  });

  test('All routines is present when the workspace has no agents at all', () => {
    const { doc, w, dom } = shell({ agents: [] });
    w.renderRoutinesPanel();
    assert.deepStrictEqual(scopeNames(doc), [SCOPE_MODEL.COPY.all]);
    dom.window.close();
  });

  test('only agents that own a routine are drawn', () => {
    const { doc, w, dom } = shell();
    w.renderRoutinesPanel();
    assert.deepStrictEqual(scopeNames(doc), [SCOPE_MODEL.COPY.all, 'Piper', 'Doc', 'Mira'],
      'the panel drew the roster rather than the owners');
    dom.window.close();
  });

  // AC-4. A paused routine still exists, so it counts. The count answers how
  // many an agent has, not how many will fire this week.
  test('a paused routine is counted', () => {
    const agents = roster();
    agents[1].routines = [routine('Refresh the reading digest', { paused: true, nextRun: null })];
    const { doc, w, dom } = shell({ agents });
    w.renderRoutinesPanel();
    const doc_ = scopeRows(doc).filter(el => el.getAttribute('data-scope') === 'doc')[0];
    assert.ok(doc_, 'the agent whose only routine is paused lost its scope row');
    assert.strictEqual(doc_.querySelector('.scope-count').textContent, '1',
      'a paused routine was left out of its agent\'s count');
    assert.strictEqual(
      doc.querySelector('#sidebar-routines [data-scope="all"] .scope-count').textContent, '6',
      'a paused routine was left out of the total');
    dom.window.close();
  });

  // AC-5. A filter with one option is decoration, and a panel that goes
  // silently blank reads as broken, so it says which agent owns everything
  // and what would change that.
  test('with one owner no agent rows are drawn and the panel says why', () => {
    const agents = roster();
    agents[1].routines = [];
    agents[2].routines = [];
    const { doc, w, dom } = shell({ agents });
    w.renderRoutinesPanel();
    assert.deepStrictEqual(scopeNames(doc), [SCOPE_MODEL.COPY.all],
      'a filter with one option was drawn anyway');
    const quiet = doc.querySelector('#sidebar-routines .sidebar-quiet');
    assert.ok(quiet, 'the panel went blank rather than saying why');
    assert.strictEqual(quiet.textContent, SCOPE_MODEL.soleOwnerLine('Piper'));
    assert.match(quiet.textContent, /Piper/, 'the line does not name the agent that owns everything');
    dom.window.close();
  });

  test('with two owners the list is drawn and nothing explains its absence', () => {
    const agents = roster();
    agents[2].routines = [];
    const { doc, w, dom } = shell({ agents });
    w.renderRoutinesPanel();
    assert.deepStrictEqual(scopeNames(doc), [SCOPE_MODEL.COPY.all, 'Piper', 'Doc']);
    assert.strictEqual(doc.querySelector('#sidebar-routines .sidebar-quiet'), null,
      'the panel explained an absence that is not there');
    dom.window.close();
  });
});

// ===== AC-3: THE SEQUENCE, DRIVEN =====

describe('scope order', () => {
  // AC-3, and the reason it is a criterion. A row that appears at the bottom
  // of a list goes unnoticed; a row that MOVES does not, and a reader who has
  // learnt where Doc sits should not have to find him again because a routine
  // was added somewhere else.
  test('adding and deleting routines does not move any scope row', () => {
    const agents = roster();
    const { doc, w, dom } = shell({ agents });
    w.renderRoutinesPanel();
    const before = scopeNames(doc);
    assert.deepStrictEqual(before, [SCOPE_MODEL.COPY.all, 'Piper', 'Doc', 'Mira'], 'sanity: the starting order');

    // Doc becomes the largest owner. In count order he would jump to the top.
    agents[1].routines.push(routine('Sweep the archive'), routine('Rebuild the index'),
      routine('Post the digest'), routine('Check the links'));
    w.renderRoutinesPanel();
    assert.deepStrictEqual(scopeNames(doc), before,
      'adding routines reordered the scope list, so the panel is in count order');
    assert.strictEqual(
      doc.querySelector('#sidebar-routines [data-scope="doc"] .scope-count').textContent, '5',
      'sanity: the count moved even though the row did not');

    // And back down to one, which in count order would send him to the bottom.
    agents[1].routines = [routine('Refresh the reading digest')];
    w.renderRoutinesPanel();
    assert.deepStrictEqual(scopeNames(doc), before,
      'deleting routines reordered the scope list');
    dom.window.close();
  });

  test('the order is the roster order, not the count order', () => {
    // Stated against the model as well, because the row order and the row
    // contents are decided in one place and this is the half a render cannot
    // accidentally satisfy by luck of the fixture.
    const list = SCOPE_MODEL.scopeList({ agents: roster(), scope: null });
    assert.deepStrictEqual(list.owners.map(o => o.id), ['piper', 'doc', 'mira']);
    const counts = list.owners.map(o => o.count);
    assert.deepStrictEqual(counts, [3, 1, 2],
      'the fixture no longer disagrees with count order, so this test cannot fail');
  });
});

// ===== AC-6: THE FALLBACK, DRIVEN =====

describe('a scope whose agent stops owning routines', () => {
  // AC-6. The sequence, driven rather than described: scope to Doc, delete his
  // last routine, and the panel must land on All rather than on a selection
  // whose row is no longer drawn and whose list is empty.
  test('scoping to an agent whose last routine is deleted falls back to All', () => {
    const agents = roster();
    const { doc, w, dom } = shell({ agents });
    w.renderRoutinesPanel();

    doc.querySelector('#sidebar-routines [data-scope="doc"]').click();
    assert.strictEqual(activeScope(doc), 'doc', 'sanity: the panel scoped to Doc');
    assert.strictEqual(w.routinesScopeAgentId(), 'doc');
    w.renderRoutines();
    assert.strictEqual(doc.querySelectorAll('#routines-content .routine-row').length, 1,
      'sanity: the list is scoped to the one routine Doc owns');

    // The server takes it away and broadcasts the roster again.
    agents[1].routines = [];
    w.renderRoutinesPanel();

    assert.strictEqual(activeScope(doc), 'all',
      'the panel kept a selection whose row it no longer draws');
    assert.strictEqual(w.routinesScopeAgentId(), null);
    w.renderRoutines();
    assert.strictEqual(doc.querySelectorAll('#routines-content .routine-row').length, 5,
      'the list fell back to an empty list rather than to every routine');
    dom.window.close();
  });

  // The same fallback from the other direction: an owner count that drops
  // below two withdraws the whole list, so any scope on it goes with it.
  // The same fallback from the other direction, and it is a different guard.
  // Here the scoped agent KEEPS its routines and the other owners lose theirs,
  // so the scope still names a real owner. What has gone is the list: below
  // two owners no rows are drawn, so a selection held here would be a
  // selection with nothing on screen carrying it, beside a pane filtered by it.
  test('a scope goes when the list it belonged to is withdrawn', () => {
    const agents = roster();
    const { doc, w, dom } = shell({ agents });
    w.renderRoutinesPanel();
    doc.querySelector('#sidebar-routines [data-scope="piper"]').click();
    assert.strictEqual(activeScope(doc), 'piper', 'sanity');

    agents[1].routines = [];
    agents[2].routines = [];
    w.renderRoutinesPanel();
    assert.deepStrictEqual(scopeNames(doc), [SCOPE_MODEL.COPY.all],
      'sanity: the list itself is withdrawn, and Piper still owns every routine');
    assert.strictEqual(w.routinesScopeAgentId(), null,
      'a scope survived the withdrawal of the list that offered it');
    w.renderRoutines();
    assert.strictEqual(doc.querySelectorAll('#routines-content .routine-row').length, 3,
      'the pane stayed filtered by a scope the panel no longer draws');
    dom.window.close();
  });
});

// ===== AC-7: THE SCOPE DOES NOT SURVIVE A VISIT =====

describe('arriving from the rail', () => {
  // AC-7, and it reads smaller than it is. A filter that survives a session is
  // a filter that hides a failed overnight run from the person who opened the
  // view to look for one.
  test('opening routines from the rail always opens on All', () => {
    const { doc, w, dom } = shell();
    // switchNav's routines branch, cut out of app.js and run, so the reset is
    // the one the page ships.
    const body = /else if\(nav==='routines'\) \{([\s\S]*?)\}/.exec(APP_SRC);
    assert.ok(body && body[1], 'app.js no longer carries a routines branch in switchNav');

    w.renderRoutinesPanel();
    doc.querySelector('#sidebar-routines [data-scope="mira"]').click();
    assert.strictEqual(w.routinesScopeAgentId(), 'mira', 'sanity: the reader scoped to Mira');

    w.eval(`(function () {${body[1]}\n})()`);
    assert.strictEqual(w.routinesScopeAgentId(), null,
      'the scope survived a visit, so the view can open filtered');
    assert.strictEqual(activeScope(doc), 'all');
    dom.window.close();
  });
});

// ===== AC-8: THE PLUS INHERITS THE SCOPE =====

describe('the header control', () => {
  test('pressing it on All opens the editor with no agent chosen', () => {
    const { doc, w, dom } = shell();
    w.eval(EDITOR_VIEW_SRC);
    w.skills = [{ id: 'sk', slug: 'ops', name: 'Compile the ops summary', assignedAgents: [{ id: 'piper', name: 'Piper' }] }];
    w.renderRoutinesPanel();
    doc.getElementById('routines-add-btn').click();
    // Read off the editor the reader is now looking at rather than off any
    // state it keeps: the lead line is the difference a user can see.
    assert.strictEqual(editorLead(doc), EDITOR_MODEL.STEP_LEADS.pickAny,
      'the plus scoped the editor to an agent nobody had chosen');
    dom.window.close();
  });

  // AC-8, and it is load-bearing rather than a nicety: the agent page no
  // longer offers Add routine once that agent has one, so this is where
  // "Piper should do one more thing" survives.
  test('pressing it while scoped to an agent opens the editor scoped to that agent', () => {
    const { doc, w, dom } = shell();
    w.eval(EDITOR_VIEW_SRC);
    w.skills = [{ id: 'sk', slug: 'ops', name: 'Compile the ops summary', assignedAgents: [{ id: 'piper', name: 'Piper' }] }];
    w.renderRoutinesPanel();
    doc.querySelector('#sidebar-routines [data-scope="piper"]').click();
    doc.getElementById('routines-add-btn').click();
    assert.strictEqual(editorLead(doc), EDITOR_MODEL.STEP_LEADS.pick.replace('{agent}', 'Piper'),
      'the plus opened the agent-agnostic picker while the panel was scoped to an agent');
    dom.window.close();
  });

  test('the control is the one Files uses, and says what it does', () => {
    const { doc, w, dom } = shell();
    w.renderRoutinesPanel();
    const btn = doc.getElementById('routines-add-btn');
    assert.ok(btn, 'the panel header carries no Add routine control');
    assert.ok(btn.classList.contains('files-add-btn'),
      'the routines plus is a control that exists nowhere else in the app');
    assert.strictEqual(btn.getAttribute('title'), SCOPE_MODEL.COPY.add);
    assert.strictEqual(btn.getAttribute('aria-label'), SCOPE_MODEL.COPY.add);
    dom.window.close();
  });
});

// ===== AC-9: THE SAME NOTHING, SAID ONCE =====

describe('the panel and the pane do not say the same thing twice', () => {
  // AC-9, with both strings side by side rather than one of them described.
  // The pane's job is to name the state and offer the way out of it. The
  // panel's job is to say what the list would hold. Neither repeats the other.
  test('the empty panel line and the empty pane lead are different sentences', () => {
    const paneLead = ROUTINES_MODEL.EMPTY.lead;
    const panelLine = SCOPE_MODEL.COPY.none;

    assert.strictEqual(paneLead, 'No routines yet.');
    assert.strictEqual(panelLine, 'Agents with routines are listed here.');

    assert.notStrictEqual(panelLine, paneLead);
    assert.ok(!panelLine.includes(paneLead),
      'the panel repeats the pane\'s lead sentence back at the reader');
    assert.ok(!paneLead.includes(panelLine));
  });

  test('the panel draws its line and the pane draws its lead, on the same screen', () => {
    const { doc, w, dom } = shell({ agents: [] });
    w.getGuide = () => null;
    w.renderRoutinesPanel();
    w.renderRoutines();
    const panelText = doc.getElementById('sidebar-routines').textContent;
    const paneText = doc.getElementById('routines-content').textContent;

    assert.match(panelText, /Agents with routines are listed here\./);
    assert.match(paneText, /No routines yet\./);
    assert.ok(!panelText.includes('No routines yet.'),
      'the panel says the pane\'s sentence as well as its own');
    dom.window.close();
  });
});

// ===== A SCOPE ROW IS NOT A ROSTER ROW =====

describe('a scope row is visibly not a roster row', () => {
  // The complaint this whole panel answers is that the two sidebars looked the
  // same. Reusing the roster's row would answer that in code and not on
  // screen, so the two differences are asserted: a count where the roster
  // carries a status, and the selected fill rather than the hover fill.
  test('a scope row carries a count and is not an agent-status-item', () => {
    const { doc, w, dom } = shell();
    w.renderRoutinesPanel();
    for (const row of scopeRows(doc)) {
      assert.ok(row.classList.contains('scope-item'),
        'a scope row is not drawn as a scope row');
      assert.ok(!row.classList.contains('agent-status-item'),
        'a scope row reuses the roster row, so the two panels still look the same');
      assert.ok(row.querySelector('.scope-count'), 'a scope row carries no count');
      assert.strictEqual(row.querySelector('.agent-status-state'), null,
        'a scope row carries the roster\'s status');
    }
    dom.window.close();
  });

  test('selected takes a different fill from hover', () => {
    const css = read('public', 'styles', 'components', 'sidebar.css');
    const selected = /\.scope-item\.active\s*\{([^}]*)\}/.exec(css);
    const hover = /\.scope-item:hover\s*\{([^}]*)\}/.exec(css);
    assert.ok(selected, 'the scope row has no selected fill');
    assert.ok(hover, 'the scope row has no hover fill');
    assert.match(selected[1], /--accent-glow/, 'selected does not take the selected fill');
    assert.match(hover[1], /--elevated/, 'hover does not take the hover fill');
    assert.notStrictEqual(selected[1].trim(), hover[1].trim(),
      'selected and hover are the same fill, so selected reads as hovered');
  });
});
