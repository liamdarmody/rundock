'use strict';
// The routine editor as a browser renders it.
//
// WHY THIS EXISTS ALONGSIDE THE MODEL'S TESTS. The model decides what the
// editor offers and in what words; it cannot say whether any of that reaches
// the page. A model whose local option carries the right copy, wired into a
// view that renders the other option's copy anyway, passes every model test.
// So these drive the real render function in a real DOM and read the copy back
// out of the elements, including the absence.
//
// The save path is driven through the wiring rather than through the decision
// function underneath it. A save that builds a correct draft and never sends
// it, or sends it and stays on the editor, is the failure this catches, and
// asserting the draft alone would miss both.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const MODEL_SRC = fs.readFileSync(path.join(ROOT, 'public', 'routine-editor-model.js'), 'utf-8');
const VIEW_SRC = fs.readFileSync(path.join(ROOT, 'public', 'views', 'routine-editor.js'), 'utf-8');

// The promise that belongs to the always-on option alone. Named here as well
// as in the model's tests, because this file asserts it about the DOM and the
// model's asserts it about the data, and a reader of either should be able to
// see which string is meant without opening the other.
const OFF_COMPUTER_PROMISE = 'while your computer is off';

function skillFixture() {
  return [
    { id: 'ops-summary', slug: 'ops-summary', name: 'Compile the ops summary',
      assignedAgents: [{ id: 'piper', name: 'Piper' }] },
    { id: 'reading-digest', slug: 'reading-digest', name: 'Refresh the reading digest',
      assignedAgents: [{ id: 'doc', name: 'Doc' }] },
  ];
}

// A window with the two modules loaded the way index.html loads them, plus
// stubs for the globals the app supplies. Nothing here reads the machine: the
// time zone is handed in.
function mount(opts = {}) {
  const dom = new JSDOM('<!doctype html><html><body>'
    + '<div id="view-routine-editor" class="hidden"><div id="routine-editor-content"></div></div>'
    + '</body></html>',
    // The modules are evaluated inside the window, the way index.html loads
    // them. Without this jsdom evaluates them in the runner's scope, where
    // node's own `module` is in view, so the browser branch of the UMD
    // wrapper never runs and every module appears to load into nothing.
    { runScripts: 'dangerously' });
  const w = dom.window;
  w.eval(MODEL_SRC);
  w.eval(VIEW_SRC);
  w.sent = [];
  w.ws = { send(text) { w.sent.push(JSON.parse(text)); } };
  w.navigatedTo = null;
  w.switchNav = (nav) => { w.navigatedTo = nav; };
  w.shownView = null;
  w.showView = (v) => { w.shownView = v; };
  w.setNavState = () => {};
  w.startedConversationWith = null;
  w.startConversation = (id) => { w.startedConversationWith = id; };
  w.getGuide = () => ({ id: 'doc' });
  w.openRoutineEditor({
    agentId: opts.agentId || null,
    agentName: opts.agentName || null,
    skills: opts.skills || skillFixture(),
    zone: opts.zone || 'Europe/London',
  });
  return { dom, w, doc: w.document };
}

function text(doc) {
  return doc.getElementById('routine-editor-content').textContent.replace(/\s+/g, ' ').trim();
}

describe('routine editor view: choosing a skill', () => {
  test('opening with no agent offers every agent\'s skills and names each one', () => {
    const { doc, dom } = mount({ agentId: null });
    const rows = [...doc.querySelectorAll('[data-skill-key]')];
    assert.strictEqual(rows.length, 2);
    const body = text(doc);
    assert.match(body, /Compile the ops summary/);
    assert.match(body, /Piper/);
    assert.match(body, /Doc/);
    dom.window.close();
  });

  test('opening from an agent offers only that agent\'s skills', () => {
    const { doc, dom } = mount({ agentId: 'piper', agentName: 'Piper' });
    const names = [...doc.querySelectorAll('[data-skill-key]')].map(r => r.getAttribute('data-skill-key'));
    assert.deepStrictEqual(names, ['ops-summary:piper']);
    assert.ok(!text(doc).includes('Refresh the reading digest'));
    dom.window.close();
  });

  // AC-13. The zero-skills state, driven through the same function that
  // renders every other state, with an empty workspace.
  test('a workspace with no skills renders the create-a-skill path', () => {
    const { doc, dom } = mount({ skills: [] });
    const offer = doc.querySelector('[data-routine-editor="create-skill"]');
    assert.ok(offer, 'the zero-skills state offers a way to build one');
    assert.ok(offer.getAttribute('onclick'), 'the offer is something you can press');
    assert.ok(!doc.querySelector('[data-skill-key]'), 'there is nothing to pick');
    dom.window.close();
  });

  // AC-17's diff-visible half: the state reads as an offer, so it carries an
  // action and none of the words an error state uses.
  test('the zero-skills state names no fault', () => {
    const { doc, dom } = mount({ skills: [] });
    const body = text(doc).toLowerCase();
    for (const alarm of ['error', 'failed', 'cannot', 'unable', 'invalid']) {
      assert.ok(!body.includes(alarm), `the offer must not read as a fault: found "${alarm}"`);
    }
    dom.window.close();
  });

  // The lead line asks the reader to pick a skill. Above an offer to build the
  // first one it reads as an instruction the page has already made impossible,
  // which is how a state that is not an error comes across as one.
  test('the zero-skills state does not ask the reader to pick from nothing', () => {
    const { doc, dom } = mount({ skills: [] });
    assert.ok(!text(doc).includes('Pick a skill'), 'there is nothing to pick, so nothing asks');
    assert.match(text(doc), /Build a skill/, 'what it offers instead is still there');
    dom.window.close();
  });

  // Pressing the offer hands over to the agent that builds skills rather than
  // opening a skill editor this screen does not have.
  test('the create-a-skill path leads somewhere', () => {
    const { doc, w, dom } = mount({ skills: [] });
    doc.querySelector('[data-routine-editor="create-skill"]').click();
    assert.strictEqual(w.startedConversationWith, 'doc');
    dom.window.close();
  });
});

describe('routine editor view: the two ways in', () => {
  // The entry points read the app's roster and the browser's time zone, which
  // is the only place any of this touches the machine. The zone is stubbed
  // here rather than inherited, so this test says the same thing wherever it
  // runs; what it checks is that the value travels, not what the value is.
  function withRoster(agentId) {
    const dom = new JSDOM('<!doctype html><html><body>'
      + '<div id="view-routine-editor"><div id="routine-editor-content"></div></div>'
      + '</body></html>', { runScripts: 'dangerously' });
    const w = dom.window;
    w.eval(MODEL_SRC);
    w.eval(VIEW_SRC);
    w.showView = () => {};
    w.setNavState = () => {};
    w.agents = [{ id: 'piper', displayName: 'Piper' }, { id: 'doc', displayName: 'Doc' }];
    w.skills = skillFixture();
    w.Intl = { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'Pacific/Auckland' }) }) };
    w.addRoutineForAgent(agentId);
    return { w, doc: w.document, dom };
  }

  test('from an agent, the picker is that agent\'s and the page names it', () => {
    const { doc, dom } = withRoster('piper');
    assert.match(text(doc), /Pick a skill Piper already has/);
    assert.deepStrictEqual(
      [...doc.querySelectorAll('[data-skill-key]')].map(r => r.getAttribute('data-skill-key')),
      ['ops-summary:piper'],
    );
    dom.window.close();
  });

  test('with no agent, the picker spans the team and names who runs each skill', () => {
    const { doc, dom } = withRoster(null);
    assert.match(text(doc), /Pick a skill any of your agents already has/);
    assert.strictEqual(doc.querySelectorAll('[data-skill-key]').length, 2);
    dom.window.close();
  });

  test('the browser\'s zone reaches the schedule step as words', () => {
    const { w, doc, dom } = withRoster('piper');
    w.routineEditorPick('ops-summary:piper');
    w.routineEditorStep('schedule');
    assert.match(text(doc), /Your time zone: Auckland\./);
    dom.window.close();
  });

  test('a zone the browser will not give up drops the line rather than guessing', () => {
    const { w, doc, dom } = withRoster('piper');
    w.Intl = { DateTimeFormat: () => { throw new Error('no'); } };
    w.addRoutineForAgent('piper');
    w.routineEditorPick('ops-summary:piper');
    w.routineEditorStep('schedule');
    assert.ok(!text(doc).includes('Your time zone'));
    dom.window.close();
  });
});

describe('routine editor view: the schedule is built, not typed', () => {
  function atSchedule(opts) {
    const mounted = mount(opts);
    mounted.w.routineEditorPick('ops-summary:piper');
    mounted.w.routineEditorStep('schedule');
    return mounted;
  }

  // AC-3. The strongest form this can take in a DOM: there is nowhere to type.
  test('the schedule step has no field anything can be typed into', () => {
    const { doc, dom } = atSchedule({ agentId: 'piper', agentName: 'Piper' });
    assert.strictEqual(doc.querySelectorAll('textarea').length, 0);
    const typeable = [...doc.querySelectorAll('input')]
      .filter(i => !['radio', 'checkbox', 'button'].includes((i.getAttribute('type') || 'text').toLowerCase()));
    assert.deepStrictEqual(typeable, [], 'a routine is assembled from words, never typed as an expression');
    dom.window.close();
  });

  test('the schedule is assembled from two lists of offered words', () => {
    const { doc, dom } = atSchedule({ agentId: 'piper', agentName: 'Piper' });
    const frequency = doc.querySelector('select[data-routine-field="frequency"]');
    const time = doc.querySelector('select[data-routine-field="time"]');
    assert.ok(frequency && time, 'both halves of the sentence are chosen, not written');
    assert.strictEqual(frequency.querySelectorAll('option').length, 8);
    assert.strictEqual(time.querySelectorAll('option').length, 48);
    dom.window.close();
  });

  test('the sentence reads back in plain words as the fields change', () => {
    const { doc, w, dom } = atSchedule({ agentId: 'piper', agentName: 'Piper' });
    w.routineEditorSetField('frequency', 'monday');
    w.routineEditorSetField('time', '07:00');
    assert.match(
      doc.querySelector('[data-routine-editor="sentence"]').textContent,
      /Every Monday at 7:00am, run: Compile the ops summary, on this computer\./,
    );
    dom.window.close();
  });
});

describe('routine editor view: where it runs', () => {
  function atSchedule() {
    const mounted = mount({ agentId: 'piper', agentName: 'Piper' });
    mounted.w.routineEditorPick('ops-summary:piper');
    mounted.w.routineEditorStep('schedule');
    return mounted;
  }

  // AC-5, AC-6, AC-14.
  test('the local option renders its two lines', () => {
    const { doc, dom } = atSchedule();
    const local = doc.querySelector('[data-run-on="local"]');
    assert.ok(local, 'the local option is on the page');
    const body = local.textContent.replace(/\s+/g, ' ');
    assert.match(body, /This computer/);
    assert.match(body, /Runs while Rundock is open here\./);
    dom.window.close();
  });

  // AC-7, AC-14. THE ASSERTION OF ABSENCE, MADE ABOUT THE PAGE.
  //
  // Paired with its presence on the option it belongs to, in the same test.
  // An absence on its own passes against a page that rendered nothing, and a
  // page that rendered nothing is exactly the failure mode a copy test is
  // least likely to notice.
  test('the local option on the page promises nothing about the computer being off', () => {
    const { doc, dom } = atSchedule();
    const local = doc.querySelector('[data-run-on="local"]');
    assert.ok(
      !local.textContent.toLowerCase().includes(OFF_COMPUTER_PROMISE),
      `the local option must not carry "${OFF_COMPUTER_PROMISE}" on the page`,
    );
    const alwaysOn = doc.querySelector('[data-run-on="agent-computer"]');
    assert.ok(
      alwaysOn.textContent.toLowerCase().includes(OFF_COMPUTER_PROMISE),
      'the promise is on the page, on the other option, so its absence here means something',
    );
    // The two rows are two options and say so. Without this, a render that
    // printed the local option's name on both would pass every assertion
    // above: the promise would still be present on one row and absent from the
    // other, and the page would name one option twice.
    assert.match(local.textContent, /This computer/);
    assert.match(alwaysOn.textContent, /Your Agent Computer/);
    dom.window.close();
  });

  test('the always-on option cannot be picked', () => {
    const { doc, w, dom } = atSchedule();
    const alwaysOn = doc.querySelector('[data-run-on="agent-computer"]');
    assert.strictEqual(alwaysOn.getAttribute('data-selectable'), 'false');
    // Pressing it changes nothing about where the routine runs.
    alwaysOn.click();
    assert.strictEqual(w.routineEditorRunOn(), 'local');
    dom.window.close();
  });

  // AC-9, AC-10. Inside the field, not merely somewhere on the page.
  test('the caveat is rendered inside the run-on field', () => {
    const { doc, dom } = atSchedule();
    const field = doc.querySelector('[data-routine-editor="run-on-field"]');
    assert.ok(field, 'the run-on choice is one field');
    const caveat = field.querySelector('[data-routine-editor="caveat"]');
    assert.ok(caveat, 'the caveat belongs to the field, not to a help page');
    const body = caveat.textContent.replace(/\s+/g, ' ');
    assert.match(body, /machine they were made on/i);
    assert.match(body, /more than one computer/i);
    assert.match(body, /each of them/i);
    // Both options are inside the same field, so the caveat cannot be rendered
    // without the choice it qualifies being on screen.
    assert.ok(field.querySelector('[data-run-on="local"]'));
    dom.window.close();
  });

  test('the time zone reads as a place and never as an offset', () => {
    const { doc, dom } = mount({ agentId: 'piper', agentName: 'Piper', zone: 'Australia/Sydney' });
    dom.window.routineEditorPick('ops-summary:piper');
    dom.window.routineEditorStep('schedule');
    const body = text(doc);
    assert.match(body, /Your time zone: Sydney\./);
    assert.ok(!/GMT|UTC[+-]|[+-]\d{2}:?\d{2}/.test(body), `an offset leaked: ${body}`);
    dom.window.close();
  });
});

describe('routine editor view: saving', () => {
  function atReady() {
    const mounted = mount({ agentId: 'piper', agentName: 'Piper' });
    mounted.w.routineEditorPick('ops-summary:piper');
    mounted.w.routineEditorStep('schedule');
    mounted.w.routineEditorSetField('frequency', 'monday');
    mounted.w.routineEditorSetField('time', '07:00');
    mounted.w.routineEditorStep('ready');
    return mounted;
  }

  test('the confirmation step reads the whole thing back in one sentence', () => {
    const { doc, dom } = atReady();
    const body = text(doc);
    assert.match(body, /Every Monday at 7:00am, run: Compile the ops summary, on this computer\./);
    assert.match(body, /London time\. Runs while Rundock is open here\./);
    dom.window.close();
  });

  // The wiring, not the decision function under it. A save that builds a
  // correct draft and never sends it passes a test of the draft alone.
  test('saving sends the routine that was built', () => {
    const { w, dom } = atReady();
    w.saveRoutine();
    assert.strictEqual(w.sent.length, 1);
    const msg = w.sent[0];
    assert.strictEqual(msg.type, 'save_routine');
    assert.strictEqual(msg.agentId, 'piper');
    assert.strictEqual(msg.routine.schedule, 'every monday at 07:00');
    assert.strictEqual(msg.routine.skill, 'ops-summary');
    assert.strictEqual(msg.routine.runOn, 'local');
    dom.window.close();
  });

  // AC-11.
  test('save returns to the list', () => {
    const { w, dom } = atReady();
    w.saveRoutine();
    assert.strictEqual(w.navigatedTo, w.RundockRoutineEditorModel.SAVE_DESTINATION);
    dom.window.close();
  });

  // A skill IS picked here, so this reaches the guard on the DRAFT rather than
  // the earlier one on the selection. Mutation showed that the two are not the
  // same guard and only the first had a test: a value the builder never
  // offered can be set on a field, and the routine it would make is refused.
  test('a schedule value that was never offered saves nothing and stays put', () => {
    const { w, dom } = mount({ agentId: 'piper', agentName: 'Piper' });
    w.routineEditorPick('ops-summary:piper');
    w.routineEditorSetField('time', '07:15');
    w.routineEditorStep('ready');
    w.saveRoutine();
    assert.deepStrictEqual(w.sent, [], 'nothing the builder refuses reaches an agent file');
    assert.strictEqual(w.navigatedTo, null, 'a failed save does not return to a list without it');
    dom.window.close();
  });

  // A save that cannot be built must not leave, or the user is returned to a
  // list that does not contain what they thought they made.
  test('a save that cannot be built sends nothing and stays put', () => {
    const { w, dom } = mount({ agentId: 'piper', agentName: 'Piper' });
    w.routineEditorStep('ready');
    w.saveRoutine();
    assert.deepStrictEqual(w.sent, []);
    assert.strictEqual(w.navigatedTo, null);
    dom.window.close();
  });
});

describe('routine editor view: the words on the page', () => {
  test('no em dash or en dash reaches the page', () => {
    for (const opts of [{ skills: [] }, { agentId: 'piper', agentName: 'Piper' }, {}]) {
      const { doc, dom } = mount(opts);
      assert.ok(!/[\u2014\u2013]/.test(text(doc)), `dash in: ${text(doc)}`);
      dom.window.close();
    }
  });

  test('a skill name carrying markup renders as text', () => {
    const hostile = [{
      id: 'x', slug: 'x', name: '<img src=x onerror=alert(1)>',
      assignedAgents: [{ id: 'piper', name: 'Piper' }],
    }];
    const { doc, dom } = mount({ skills: hostile, agentId: 'piper', agentName: 'Piper' });
    assert.strictEqual(doc.querySelectorAll('img').length, 0, 'a skill name is text, never markup');
    assert.match(text(doc), /<img src=x onerror=alert\(1\)>/);
    dom.window.close();
  });
});
