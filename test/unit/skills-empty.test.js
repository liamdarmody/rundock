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
//
// WHAT THIS FILE DOES NOT PROVE, said here so nobody reads it as proving more.
// Every test below CALLS renderSkills. That is right for a file about the
// words on a pane, and it says nothing about whether pressing the Skills entry
// reaches that render. The press is proved in test/unit/routines-view.test.js,
// by clicking the rail entry as it sits in index.html and running switchNav's
// own skills arm cut out of app.js, and that file's CALLED_NOT_PRESSED list
// records the exemption this comment describes.
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
// The next step, in its two forms. The first carries a slot, not a name: the
// pane knows only that some agent has type platform, so a literal there names
// an agent a workspace may not have.
const NEXT_STEP = 'Tell {agent} what you find yourself repeating, and that becomes your first skill.';
const NEXT_STEP_NO_GUIDE = 'Skills are listed on each agent, so add one to an agent\'s file under '
  + 'skills: and it appears here.';
const ACTION = 'Build a skill';

// The guide this workspace has, and it is deliberately NOT called Doc. Every
// test below that names an agent names this one, so a literal anywhere in the
// copy fails rather than passing on the default workspace's name.
const GUIDE = { id: 'archivist', displayName: 'Wren', type: 'platform' };

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
  w.eval(SKILLS_SRC);
  w.eval(EDITOR_VIEW_SRC);
  w.skills = skills;
  w.skillsLoaded = skillsLoaded;
  w.currentSkillId = null;
  w.currentView = 'skills';
  w.agents = guide ? [Object.assign({}, GUIDE)] : [];
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

  // THE SEAM, and it is the thing review found in the wrong place. The
  // mechanism says what a skill IS and nothing else. It names no agent, so
  // nothing about the team can take it away, which is what let the no-guide
  // state end in nothing at all when the two jobs shared one slot.
  test('the mechanism says what a skill is, and names nobody', () => {
    assert.strictEqual(m.EMPTY.mechanism, MECHANISM);
    assert.ok(!/\{agent\}|\bDoc\b|\bhe\b/.test(m.EMPTY.mechanism),
      'the mechanism names an agent, so a workspace without one would lose it');
  });

  test('the next step has a form for a workspace with a guide and one for a workspace without', () => {
    assert.strictEqual(m.EMPTY.nextStep, NEXT_STEP);
    assert.strictEqual(m.EMPTY.nextStepNoGuide, NEXT_STEP_NO_GUIDE);
  });

  // The action is the editor's word, not a second one written here. Two
  // surfaces one screen apart offering the same thing under two labels is the
  // drift this pass exists to argue against.
  test('the action is the one the routine editor already offers', () => {
    assert.strictEqual(m.EMPTY.action, ACTION);
    assert.strictEqual(m.EMPTY.action, editor.STEP_LEADS.build);
  });

  // EVERY STATE ENDS IN A NEXT STEP, which may be an action or a sentence and
  // is never a generic encouragement. No state ends with only what the thing
  // is, which is what a surface whose whole job is teaching that a feature
  // exists cannot afford.
  test('every state of this pane ends in a specific next step', () => {
    for (const [label, state] of [
      ['with a guide', m.emptyState({ guideName: 'Wren' })],
      ['with no guide', m.emptyState({})],
    ]) {
      assert.ok(state.body.startsWith(`${MECHANISM} `), `${label}: the mechanism moved`);
      const step = state.body.slice(MECHANISM.length + 1);
      assert.ok(step.length > 20, `${label}: the state ends with only what a skill is`);
      assert.ok(!/get started|dive in|explore/i.test(step), `${label}: a generic encouragement`);
      assert.ok(/\.$/.test(step), `${label}: the next step is not a sentence`);
    }
    assert.strictEqual(m.emptyState({ guideName: 'Wren' }).action, ACTION);
  });

  test('there is no aside, because there is no second way to get a skill', () => {
    assert.strictEqual(m.emptyState({ guideName: 'Wren' }).aside, null);
    assert.ok(!('aside' in m.EMPTY), 'an aside on this surface would name a path that does not exist');
  });
});

describe('the guide is named through a slot, never as a literal', () => {
  // WHAT THIS EXISTS FOR. getGuide matches on type === 'platform' and checks
  // no name. A sentence that hard-codes one tells a workspace whose platform
  // agent is called something else to talk to somebody it does not have, and
  // the button beside it then opens a conversation with a differently named
  // agent.
  test('the sentence carries the name the workspace actually has', () => {
    for (const name of ['Wren', 'Doc', 'Atlas']) {
      assert.strictEqual(m.emptyState({ guideName: name }).body, `${MECHANISM} `
        + NEXT_STEP.replace('{agent}', name));
    }
  });

  test('no shipped line hard-codes a name or a pronoun for the guide', () => {
    for (const line of Object.values(m.EMPTY)) {
      if (typeof line !== 'string') continue;
      assert.ok(!/\bDoc\b/.test(line), `a guide's name is written into: ${line}`);
      assert.ok(!/\b(he|she|they)\b/i.test(line), `a pronoun stands in for the guide in: ${line}`);
    }
  });

  test('the token is substituted rather than concatenated, so every word is in one object', () => {
    assert.ok(m.EMPTY.nextStep.includes('{agent}'), 'the sentence carries no slot to substitute');
    const built = m.nextStep('Wren');
    assert.ok(!built.includes('{agent}'), 'the slot reached the page unsubstituted');
    // The same token and the same rule the editor's own step lead uses, one
    // file away.
    assert.ok(editor.STEP_LEADS.pick.includes('{agent}'),
      'sanity: the substitution rule this follows is the editor\'s');
  });

  // A guard rather than a state anybody should meet: the roster resolves a
  // display name for every agent, falling back to the id. A sentence with an
  // empty slot in it is worse than the one that names nobody.
  test('a guide with no name takes the sentence that names nobody', () => {
    const state = m.emptyState({ guideName: null });
    assert.strictEqual(state.body, `${MECHANISM} ${NEXT_STEP_NO_GUIDE}`);
    assert.ok(!state.body.includes('{agent}'));
  });

  test('the pane names the guide this workspace actually has, on the page', () => {
    const { w, doc, dom } = shell({ skills: [] });
    w.renderSkills();
    const shown = text(pane(doc));
    assert.match(shown, /Tell Wren what you find yourself repeating/,
      'the pane names an agent this workspace does not have');
    assert.ok(!/\bDoc\b/.test(shown), 'a literal name reached the page');
    dom.window.close();
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
    assert.match(shown, /Tell Wren what you find yourself repeating/);
    dom.window.close();
  });

  test('the pane carries one thing to press and it is pressed, not called', () => {
    const { w, doc, dom } = shell({ skills: [] });
    w.renderSkills();
    const buttons = doc.querySelectorAll('#skill-detail-content button');
    assert.strictEqual(buttons.length, 1, 'an empty state offers one action, never two');
    assert.strictEqual(buttons[0].textContent.trim(), ACTION);
    buttons[0].click();
    assert.strictEqual(w.conversationWith, GUIDE.id,
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

describe('the next step swaps with the guide, and the mechanism never moves', () => {
  // Every call to action in the app that names the guide is guarded on the
  // guide existing. What changed after review is what happens to the sentence
  // beside it: dropping the action used to drop the only thing telling the
  // reader what to do, leaving a state that ended in what a skill is. The next
  // step now swaps rather than disappearing.
  test('with no guide the action goes and the next step swaps rather than going with it', () => {
    const state = m.emptyState({});
    assert.strictEqual(state.action, null, 'a button was offered with no agent to fulfil it');
    assert.strictEqual(state.lead, STATE_LINE, 'the state is still true with no guide');
    assert.ok(state.body.startsWith(`${MECHANISM} `), 'the mechanism moved with the guide');
    assert.strictEqual(state.body, `${MECHANISM} ${NEXT_STEP_NO_GUIDE}`);
    assert.ok(!/Doc|Wren/.test(state.body), 'the pane names an agent the workspace does not have');
  });

  test('the pane with no guide still ends in something to do', () => {
    const { w, doc, dom } = shell({ skills: [], guide: false });
    w.renderSkills();
    const shown = text(pane(doc));
    assert.match(shown, /No skills yet\./);
    assert.match(shown, /A skill is a job written down once/);
    assert.match(shown, /Skills are listed on each agent, so add one to an agent's file under skills: and it appears here\./);
    assert.ok(!/Doc|Wren/.test(shown), 'the pane names a guide this workspace does not have');
    assert.strictEqual(doc.querySelectorAll('#skill-detail-content button').length, 0,
      'a button was offered with no agent to fulfil it');
    dom.window.close();
  });

  // The one thing the no-guide state must not do: promise a way in that does
  // not exist. Opening a folder from an empty state is a mechanism nobody has
  // built, so the sentence says where the file is and offers nothing to press.
  test('the no-guide next step promises nothing the product cannot do', () => {
    assert.strictEqual(m.emptyState({}).action, null);
    assert.ok(!/click|open the folder|browse/i.test(m.EMPTY.nextStepNoGuide));
  });
});

describe('the copy this surface ships', () => {
  const BANNED = ['leverage', 'streamline', 'empower', 'utilize', 'robust', 'seamless', 'dive into'];

  function copyShipped() {
    const out = [];
    for (const value of Object.values(m.EMPTY)) if (typeof value === 'string') out.push(value);
    for (const input of [{ guideName: 'Wren' }, {}, { loading: true }]) {
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
