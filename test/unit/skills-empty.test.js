'use strict';
// What the Skills view says when the workspace has no skills.
//
// WHY THIS FILE EXISTS AT ALL. Skills is the one section of the rail that has
// never had an empty state. renderSkills returned before rendering anything,
// so a workspace with no skills had no pane to look at, which is why the rail
// entry was withdrawn rather than the other way round. A rail that names what
// the app can do has to open onto something, so the pane comes first.
//
// EVERY WORD ASSERTED HERE IS THE MODEL'S, not the render's. The same split
// the routines list and the routine editor already make: copy written inline
// in a template literal is reachable only by a browser, and a copy rule that
// can only be screenshotted is a copy rule nobody can keep.
//
// THE THREE STATES THIS SURFACE HAS, and they are not two. Skills have not
// arrived, there are no skills, and there are skills. Only the middle one is
// an offer, and showing it while the reply is still in flight tells somebody
// with a dozen skills that they have none.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf-8');
const INDEX_SRC = read('public', 'index.html');
const EDITOR_MODEL_SRC = read('public', 'routine-editor-model.js');
const SKILLS_MODEL_SRC = read('public', 'skills-model.js');
const SKILLS_SRC = read('public', 'views', 'skills.js');
const RAIL_SRC = read('public', 'rail-presence.js');
// The real handler behind the button, not a stub. The offer this pane makes
// and the offer the routine editor makes are the same offer, and a stub here
// would let the two drift into two different conversations.
const EDITOR_VIEW_SRC = read('public', 'views', 'routine-editor.js');

const m = require(path.join(ROOT, 'public', 'skills-model.js'));
const editor = require(path.join(ROOT, 'public', 'routine-editor-model.js'));

// The mock's section 5 draws this pane, and these are the exact lines on it.
// Held here as literals rather than read off the model, because a test that
// reads its expectation out of the thing under test agrees with any change.
const STATE_LINE = 'No skills yet.';
const MECHANISM = 'A skill is a job written down once, so an agent does it the same way every '
  + 'time and you can put it on a schedule.';
const DOC_LINE = 'Tell Doc what you find yourself repeating and he will write the first one.';
const ACTION = 'Build a skill';

// A shell built out of the REAL page: the skills panel and the skills view
// panel are cut from index.html rather than restated here. A copy of the
// markup in this file would keep passing after the page stopped carrying it,
// which is the whole class of proof this project keeps finding it has written.
function shellMarkup() {
  const sidebar = /<div id="sidebar-skills"[\s\S]*?<\/div>\s*<\/div>/.exec(INDEX_SRC);
  assert.ok(sidebar, 'index.html no longer carries a skills sidebar panel');
  const panel = /<div id="view-skills"[\s\S]*?<\/div>\s*<\/div>/.exec(INDEX_SRC);
  assert.ok(panel, 'index.html no longer carries the skills view panel');
  const rail = /<nav class="nav-rail"[\s\S]*?<\/nav>/.exec(INDEX_SRC);
  assert.ok(rail, 'index.html no longer carries a nav rail');
  return '<!doctype html><html><body>' + rail[0] + sidebar[0] + panel[0] + '</body></html>';
}

function shell({ skills = [], skillsLoaded = true, guide = true } = {}) {
  const dom = new JSDOM(shellMarkup(), { runScripts: 'dangerously' });
  const w = dom.window;
  w.eval(EDITOR_MODEL_SRC);
  w.eval(SKILLS_MODEL_SRC);
  w.eval(RAIL_SRC);
  w.eval(SKILLS_SRC);
  w.eval(EDITOR_VIEW_SRC);
  w.skills = skills;
  w.skillsLoaded = skillsLoaded;
  w.currentSkillId = null;
  w.currentView = 'skills';
  w.agents = guide ? [{ id: 'doc', displayName: 'Doc', type: 'platform' }] : [];
  w.getGuide = () => w.agents.filter(a => a.type === 'platform')[0];
  w.esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  w.showView = () => {};
  w.startConversation = (id) => { w.conversationWith = id; };
  return { w, doc: w.document, dom };
}

const pane = (doc) => doc.getElementById('skill-detail-content');
const text = (el) => el.textContent.replace(/\s+/g, ' ').trim();

describe('the words the empty pane ships', () => {
  test('the state line says what is true and does not welcome anybody', () => {
    assert.strictEqual(m.EMPTY.lead, STATE_LINE);
    assert.ok(!/welcome/i.test(m.EMPTY.lead));
  });

  test('the mechanism says what a skill is and what happens after', () => {
    assert.strictEqual(m.EMPTY.body, MECHANISM);
    assert.strictEqual(m.EMPTY.guideLine, DOC_LINE);
  });

  // The action is the editor's word, not a second one written here. Two
  // surfaces one screen apart offering the same thing under two labels is the
  // drift this pass exists to argue against.
  test('the action is the one the routine editor already offers', () => {
    assert.strictEqual(m.EMPTY.action, ACTION);
    assert.strictEqual(m.EMPTY.action, editor.STEP_LEADS.build);
  });

  test('the empty state ends in a specific next step', () => {
    const state = m.emptyState({ hasGuide: true });
    assert.strictEqual(state.body, `${MECHANISM} ${DOC_LINE}`);
    assert.strictEqual(state.action, ACTION);
  });

  test('there is no aside, because there is no second way to get a skill', () => {
    assert.strictEqual(m.emptyState({ hasGuide: true }).aside, null);
    assert.ok(!('aside' in m.EMPTY), 'an aside on this surface would name a path that does not exist');
  });
});

describe('the pane waits for the reply before it offers anything', () => {
  // THE DEFECT THIS EXISTS FOR. An empty list before the reply lands looks
  // exactly like a workspace with nothing in it, so the offer to build a first
  // skill reaches people whose agents already have several.
  test('skills that have not arrived are not the same as no skills', () => {
    const waiting = m.emptyState({ loading: true, hasGuide: true });
    assert.strictEqual(waiting.action, null, 'an offer was made before anything was known');
    assert.strictEqual(waiting.lead, null, 'the pane claimed there were none before it knew');
    assert.strictEqual(waiting.body, editor.STEP_LEADS.loading,
      'the editor already has a line for this state and the two must not disagree');
  });

  test('the pane says it is looking rather than offering, while it is looking', () => {
    const { w, doc, dom } = shell({ skills: [], skillsLoaded: false });
    w.renderSkills();
    const shown = text(pane(doc));
    assert.ok(!shown.includes(ACTION), 'the build offer was made to a workspace whose skills had not arrived');
    assert.ok(!shown.includes(STATE_LINE), 'the pane claimed there were no skills before it knew');
    assert.match(shown, /Looking for skills your agents can run\./);
    dom.window.close();
  });

  test('the reply arriving turns the wait into the offer', () => {
    const { w, doc, dom } = shell({ skills: [], skillsLoaded: false });
    w.renderSkills();
    w.skillsLoaded = true;
    w.renderSkills();
    const shown = text(pane(doc));
    assert.match(shown, /No skills yet\./);
    assert.match(shown, /Build a skill/);
    dom.window.close();
  });
});

describe('the pane a workspace with no skills opens onto', () => {
  test('a workspace with no skills gets a pane rather than a blank one', () => {
    const { w, doc, dom } = shell({ skills: [] });
    w.renderSkills();
    const shown = text(pane(doc));
    assert.ok(shown, 'the skills pane is still blank on a workspace with no skills');
    assert.match(shown, /No skills yet\./);
    assert.match(shown, /A skill is a job written down once/);
    assert.match(shown, /Tell Doc what you find yourself repeating/);
    dom.window.close();
  });

  test('the pane carries one thing to press and it is pressed, not called', () => {
    const { w, doc, dom } = shell({ skills: [] });
    w.renderSkills();
    const buttons = doc.querySelectorAll('#skill-detail-content button');
    assert.strictEqual(buttons.length, 1, 'an empty state offers one action, never two');
    assert.strictEqual(buttons[0].textContent.trim(), ACTION);
    buttons[0].click();
    assert.strictEqual(w.conversationWith, 'doc',
      'the action does not open a conversation with the agent that writes skills');
    dom.window.close();
  });

  test('a skill arriving replaces the empty pane with that skill', () => {
    const { w, doc, dom } = shell({ skills: [] });
    w.renderSkills();
    assert.match(text(pane(doc)), /No skills yet\./);
    w.skills = [{ id: 's1', name: 'Compile the ops summary', assignedAgents: [], description: '', instructions: '' }];
    w.renderSkills();
    const shown = text(pane(doc));
    assert.ok(!shown.includes(STATE_LINE), 'the empty state outlived the first skill');
    assert.match(shown, /Compile the ops summary/);
    dom.window.close();
  });
});

describe('the action disappears with the agent that fulfils it', () => {
  // Every other call to action in the app that names the guide is guarded on
  // the guide existing. The STATE and the MECHANISM stay, because they are
  // still true; the sentence naming an agent that is not there does not.
  test('with no guide there is no button and no sentence naming one', () => {
    const state = m.emptyState({ hasGuide: false });
    assert.strictEqual(state.action, null);
    assert.strictEqual(state.lead, STATE_LINE, 'the state is still true with no guide');
    assert.strictEqual(state.body, MECHANISM, 'the mechanism is still true with no guide');
    assert.ok(!/Doc/.test(state.body), 'the pane names an agent the workspace does not have');
  });

  test('the pane with no guide says what the section is for and offers nothing', () => {
    const { w, doc, dom } = shell({ skills: [], guide: false });
    w.renderSkills();
    const shown = text(pane(doc));
    assert.match(shown, /No skills yet\./);
    assert.match(shown, /A skill is a job written down once/);
    assert.ok(!/Doc/.test(shown), 'the pane names a guide this workspace does not have');
    assert.strictEqual(doc.querySelectorAll('#skill-detail-content button').length, 0,
      'a button was offered with no agent to fulfil it');
    dom.window.close();
  });
});

describe('the copy this surface ships', () => {
  const BANNED = ['leverage', 'streamline', 'empower', 'utilize', 'robust', 'seamless', 'dive into'];

  function copyShipped() {
    const out = [];
    for (const value of Object.values(m.EMPTY)) if (typeof value === 'string') out.push(value);
    for (const input of [{ hasGuide: true }, { hasGuide: false }, { loading: true }]) {
      for (const value of Object.values(m.emptyState(input))) if (typeof value === 'string') out.push(value);
    }
    return out;
  }

  test('no banned word reaches this pane', () => {
    for (const line of copyShipped()) {
      for (const word of BANNED) assert.ok(!line.toLowerCase().includes(word), `"${word}" in: ${line}`);
    }
  });

  test('no em dash or en dash reaches this pane', () => {
    for (const line of copyShipped()) assert.ok(!/[\u2014\u2013]/.test(line), `dash in: ${line}`);
  });

  test('the copy is UK spelling', () => {
    for (const line of copyShipped()) {
      assert.ok(!/\b\w+ize[sd]?\b/i.test(line), `US spelling in: ${line}`);
      assert.ok(!/\bcolor\b/i.test(line), `US spelling in: ${line}`);
    }
  });
});
