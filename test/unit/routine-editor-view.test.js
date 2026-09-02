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
// The shipped page and the shipped router, read rather than restated, because
// the claim below is about what the real shell can show.
const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf-8');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf-8');

/**
 * The panel the router shows for a section, off the router's own arm.
 *
 * A SECTION IS NOT ALWAYS SHOWN BY A PANEL NAMED AFTER IT, and Team is the
 * case that matters here: its arm shows the home panel. A test that planted a
 * panel called after the section would answer its own question, which is the
 * pattern the routines doors file exists to record.
 */
function panelShownFor(nav) {
  const arm = new RegExp(`nav==='${nav}'\\)\\s*\\{\\s*showView\\('([\\w-]+)'\\)`).exec(APP_SRC);
  assert.ok(arm, `app.js has no arm that shows anything for the ${nav} section`);
  return arm[1];
}

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
    // A rail button for each section the router can reach, and NO VIEW PANEL
    // FOR EITHER OF THEM. The routines surface has neither, which is the
    // condition the save destination has to resolve against, and the fallback
    // it lands on is checked against the shipped page rather than against a
    // panel this file could plant: `panelShownFor` asks the router which panel
    // a section shows and index.html whether that panel exists.
    + '<button class="nav-item" data-nav="team"></button>'
    + '<button class="nav-item" data-nav="skills"></button>'
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
  w.profileShown = null;
  w.showProfile = (id) => { w.profileShown = id; };
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

  // An empty list before the reply arrives is not a workspace with no skills.
  // Shown as one, it offers to build a first skill to somebody whose agents
  // already have several.
  test('an editor opened before the skills arrive waits instead of offering', () => {
    const dom = new JSDOM('<!doctype html><html><body>'
      + '<div id="view-routine-editor"><div id="routine-editor-content"></div></div>'
      + '</body></html>', { runScripts: 'dangerously' });
    const w = dom.window;
    w.eval(MODEL_SRC);
    w.eval(VIEW_SRC);
    w.showView = () => {};
    w.setNavState = () => {};
    w.agents = [{ id: 'piper', displayName: 'Piper' }];
    w.skills = [];
    w.skillsLoaded = false;
    w.sent = [];
    w.ws = { send: (m) => w.sent.push(JSON.parse(m)) };
    w.Intl = { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'Europe/London' }) }) };

    w.addRoutineForAgent('piper');
    const body = w.document.getElementById('routine-editor-content').textContent;
    assert.ok(!body.includes('Build a skill'), 'nothing is known yet, so nothing is offered');
    assert.ok(!w.document.querySelector('[data-routine-editor="create-skill"]'));
    assert.ok(w.sent.some(m => m.type === 'get_skills'), 'it asks for the list it is missing');

    // And it fills in when the reply lands, rather than sitting there.
    w.routineEditorSkillsArrived(skillFixture());
    assert.strictEqual(w.document.querySelectorAll('[data-skill-key]').length, 1);
    dom.window.close();
  });

  // A workspace that genuinely has none still gets the offer.
  test('a loaded and empty workspace still gets the offer', () => {
    const dom = new JSDOM('<!doctype html><html><body>'
      + '<div id="view-routine-editor"><div id="routine-editor-content"></div></div>'
      + '</body></html>', { runScripts: 'dangerously' });
    const w = dom.window;
    w.eval(MODEL_SRC);
    w.eval(VIEW_SRC);
    w.showView = () => {};
    w.setNavState = () => {};
    w.agents = [{ id: 'piper', displayName: 'Piper' }];
    w.skills = [];
    w.skillsLoaded = true;
    w.Intl = { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'Europe/London' }) }) };
    w.addRoutineForAgent('piper');
    assert.ok(w.document.querySelector('[data-routine-editor="create-skill"]'), 'this one really has none');
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

describe('routine editor view: leaving without saving', () => {
  // A control that does not do what its label says is worse than a missing
  // control, because the reader believes the label. The breadcrumb named an
  // agent and went to the team chart, because it shared its destination with
  // the exit taken after a save, where the list IS right.
  test('the breadcrumb goes to the agent it names', () => {
    const { doc, w, dom } = mount({ agentId: 'piper', agentName: 'Piper' });
    const back = doc.querySelector('[data-routine-editor="back"]');
    assert.ok(back, 'a scoped editor offers a way back');
    assert.match(back.textContent, /Back to Piper/);

    back.click();
    // The label and the destination are asserted against each other rather
    // than each against a constant, so a rename of either alone fails.
    assert.strictEqual(w.profileShown, back.getAttribute('data-back-to'),
      'the breadcrumb goes to the agent whose name is written on it');
    assert.strictEqual(w.profileShown, 'piper');
    assert.strictEqual(w.navigatedTo, null, 'leaving by the breadcrumb is not the exit a save takes');
    dom.window.close();
  });

  // The two exits are different destinations, which is the whole finding.
  test('leaving by the breadcrumb and leaving after a save go to different places', () => {
    const back = mount({ agentId: 'piper', agentName: 'Piper' });
    back.doc.querySelector('[data-routine-editor="back"]').click();

    const saved = mount({ agentId: 'piper', agentName: 'Piper' });
    saved.w.routineEditorPick('ops-summary:piper');
    saved.w.routineEditorStep('schedule');
    saved.w.routineEditorStep('ready');
    saved.w.saveRoutine();
    saved.w.routineEditorSaved();

    assert.strictEqual(back.w.profileShown, 'piper');
    assert.strictEqual(back.w.navigatedTo, null);
    assert.strictEqual(saved.w.profileShown, null, 'a save does not go back to the agent');
    assert.strictEqual(saved.w.navigatedTo, saved.w.routinesListNav());
    back.dom.window.close();
    saved.dom.window.close();
  });

  // With no agent there is no profile to name, so there is no breadcrumb
  // naming one.
  test('an editor opened without an agent offers no breadcrumb to one', () => {
    const { doc, w, dom } = mount({ agentId: null });
    assert.strictEqual(doc.querySelector('[data-routine-editor="back"]'), null);
    w.routineEditorLeave();
    assert.strictEqual(w.profileShown, null, 'there is no agent to return to');
    assert.strictEqual(w.navigatedTo, w.routinesListNav());
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
      /Run Compile the ops summary every Monday at 7:00am, on this computer\./,
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

  // WHERE THE ROUTINE BEING MADE WILL RUN, on the step every route into this
  // editor passes through.
  //
  // There is one scheduler and it serves the open workspace. Somebody with
  // three workspaces was finishing this editor believing they had scheduled
  // something that fires whenever Rundock is up, and the only place that said
  // otherwise was documentation they would meet later, if at all.
  //
  // ON THE STEP RATHER THAN ANYWHERE ON THE PAGE, for the reason the run-on
  // caveat is inside its field: a sentence proven present somewhere is a
  // sentence one layout change away from a screen nobody reads.
  test('the schedule step says what happens to this routine when its workspace is not open', () => {
    const { doc, dom } = atSchedule();
    const caveat = doc.querySelector('[data-routine-editor="workspace-caveat"]');
    assert.ok(caveat, 'the step that decides when a routine runs also says where it runs');
    const body = caveat.textContent.replace(/\s+/g, ' ');
    assert.match(body, /workspace that is open/i, 'it names the rule');
    assert.match(body, /do not run/i, 'and what happens to this routine while another workspace is open');
    assert.match(body, /caught up/i, 'and that a slot gone by is served on returning that day');
    // The step this sits on is the one that carries the schedule controls, so
    // the sentence cannot be rendered away from the choice it qualifies.
    assert.ok(doc.querySelector('[data-routine-field="frequency"]'),
      'the caveat is on the step where the schedule is chosen');
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
    assert.match(body, /Run Compile the ops summary every Monday at 7:00am, on this computer\./);
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

  // AC-11, and it does NOT assert that a stub was handed a string.
  //
  // The editor waits for the server, so the sequence is the claim: sending
  // alone must not leave, and the reply is what does. Then the destination is
  // checked for the property that makes it a destination at all, which is the
  // half that was missing: a section the router cannot reach hides every
  // sidebar and matches no branch, so the editor stays on screen and the save
  // looks like it did nothing.
  test('save returns to the list, and only once the routine is written', () => {
    const { w, doc, dom } = atReady();
    w.saveRoutine();
    assert.strictEqual(w.navigatedTo, null, 'sending is not saving');

    w.routineEditorSaved();
    assert.strictEqual(w.navigatedTo, w.routinesListNav(), 'the reply is what leaves');
    assert.ok(w.navigatedTo, 'a destination was chosen');
    // Both halves, because the router needs both: the rail button it marks
    // active and a panel it can actually show. The panel is resolved through
    // the router's own arm and looked for in the shipped page, so this says
    // the destination is showable THERE rather than showable here.
    assert.ok(doc.querySelector(`[data-nav="${w.navigatedTo}"]`),
      `the router has no rail entry for "${w.navigatedTo}", so it cannot go there`);
    const panel = panelShownFor(w.navigatedTo);
    assert.ok(new RegExp(`id="view-${panel}"`).test(INDEX_SRC),
      `the router shows #view-${panel} for "${w.navigatedTo}" and index.html carries no such panel`);
    dom.window.close();
  });

  // The resolution itself, both ways round: with neither half of a destination
  // it falls back, and with both halves it lands on the routines surface, with
  // nothing here edited.
  //
  // THE HALVES PLANTED HERE ARE THE HALVES THE SHIPPED PAGE HAS, checked
  // against it first, so this constructs a condition that is real rather than
  // one only this file can satisfy.
  test('the destination is the routines surface once the shell can reach it', () => {
    const { w, doc, dom } = atReady();
    assert.strictEqual(w.routinesListNav(), 'team', 'no routines rail entry yet');
    assert.match(INDEX_SRC, /data-nav="routines"/, 'index.html carries no routines rail entry');
    assert.match(INDEX_SRC, /id="view-routines"/, 'index.html carries no routines view panel');
    assert.match(INDEX_SRC, /id="sidebar-routines"/, 'index.html carries no routines sidebar panel');

    // ALL THREE, and EVERY MISSING-ONE STATE. The router touches all three: the
    // rail lights the entry, setNavState reveals the sidebar by name and
    // showView reveals the view by name. Adding them in one order only would
    // let a check that stopped asking for the last one still pass, because the
    // pair before it already answered no. So each is taken away in turn.
    const button = doc.createElement('button');
    button.setAttribute('data-nav', 'routines');
    const view = doc.createElement('div');
    view.id = 'view-routines';
    const panel = doc.createElement('div');
    panel.id = 'sidebar-routines';

    doc.body.append(button);
    assert.strictEqual(w.routinesListNav(), 'team', 'a rail entry alone is not a destination');

    doc.body.append(view, panel);
    assert.strictEqual(w.routinesListNav(), w.RundockRoutineEditorModel.SAVE_DESTINATION,
      'the shell has all three and the save still will not go there');

    view.remove();
    assert.strictEqual(w.routinesListNav(), 'team',
      'a section with no view panel is a destination showView cannot reveal');

    doc.body.append(view);
    panel.remove();
    assert.strictEqual(w.routinesListNav(), 'team',
      'a section with no sidebar panel is a destination setNavState cannot reveal');

    doc.body.append(panel);
    assert.strictEqual(w.routinesListNav(), w.RundockRoutineEditorModel.SAVE_DESTINATION);
    dom.window.close();
  });

  // Half a destination is not one. A rail button with no view panel would
  // leave the router showing nothing at all.
  test('a destination the shell only half has is not used', () => {
    const { w, doc, dom } = atReady();
    const button = doc.createElement('button');
    button.setAttribute('data-nav', 'routines');
    doc.body.append(button);
    assert.strictEqual(w.routinesListNav(), 'team', 'a rail entry with no view panel is not a destination');
    dom.window.close();
  });

  // The refusal has to reach the reader, and the editor is still on screen so
  // that it has somewhere to go.
  test('a refused save stays put and says why', () => {
    const { w, doc, dom } = atReady();
    w.saveRoutine();
    w.routineEditorFailed('That agent was removed.');
    assert.strictEqual(w.navigatedTo, null, 'a refused save does not return to the list');
    const shown = doc.querySelector('[data-routine-editor="error"]');
    assert.ok(shown, 'the refusal is on the page');
    assert.match(shown.textContent, /That agent was removed\./);
    dom.window.close();
  });

  test('a refused save can be tried again', () => {
    const { w, doc, dom } = atReady();
    w.saveRoutine();
    w.routineEditorFailed('Temporary problem.');
    assert.ok(!doc.querySelector('[data-routine-editor="save"]').hasAttribute('disabled'));
    w.saveRoutine();
    assert.strictEqual(w.sent.length, 2, 'the second attempt is sent');
    w.routineEditorSaved();
    assert.strictEqual(w.navigatedTo, w.routinesListNav());
    dom.window.close();
  });

  test('a save in flight cannot be sent twice', () => {
    const { w, dom } = atReady();
    w.saveRoutine();
    w.saveRoutine();
    assert.strictEqual(w.sent.length, 1, 'the button is spent until the server answers');
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
    // And a reply that arrives for some other save cannot move an editor that
    // never sent one.
    w.routineEditorSaved();
    assert.strictEqual(w.navigatedTo, null, 'nothing was in flight, so nothing leaves');
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

describe('routine editor: the reply reaches the user', () => {
  // The dispatch lives in app.js, which the suite does not load. So rather
  // than matching strings in it, the two case BODIES are cut out and RUN,
  // against stubs, which is the difference between checking the words are
  // there and checking what they do.
  //
  // This exists because both replies previously fell out of the switch in
  // silence, unlike every other error the client handles. A refused save left
  // the reader on a list without the routine and with nothing said.
  const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf-8');

  // Up to the first break, so a case written on one line and a case written
  // over several are both readable. The assertion that the case EXISTS is part
  // of the extraction: a deleted case fails here rather than silently yielding
  // an empty body that then passes every assertion about what it did not do.
  function caseBody(type) {
    const m = APP_SRC.match(new RegExp(`case '${type}':([\\s\\S]*?)\\bbreak;`));
    assert.ok(m, `the client dispatch has no case for ${type}`);
    assert.ok(m[1].trim(), `the client dispatch handles ${type} with an empty body`);
    return m[1];
  }

  function runCase(type, message) {
    const w = new JSDOM('<!doctype html>', { runScripts: 'dangerously' }).window;
    w.said = [];
    w.addSystemMsg = (text) => w.said.push(text);
    w.savedCalled = 0;
    w.failedWith = [];
    w.routineEditorSaved = () => { w.savedCalled++; };
    w.routineEditorFailed = (m) => { w.failedWith.push(m); };
    // A schedule change retires the routines list's last refusal, the way
    // every other routine change that goes through does. Stubbed rather than
    // left undefined: an absent global would fail these for a reason that has
    // nothing to do with what the case does.
    w.clearedCalled = 0;
    w.routinesActionCleared = () => { w.clearedCalled++; };
    w.d = message;
    w.eval(`(function () {${caseBody(type)}\n})()`);
    return w;
  }

  test('a refusal is shown to the user and handed back to the editor', () => {
    const w = runCase('routine_error', { type: 'routine_error', message: 'That agent was removed.' });
    assert.deepStrictEqual(w.said, ['That agent was removed.'],
      'the server message is what the user sees, not a generic one');
    assert.deepStrictEqual(w.failedWith, ['That agent was removed.'],
      'the editor is told, so it can stay put and show it');
    assert.strictEqual(w.savedCalled, 0);
  });

  test('a refusal with no message still says something', () => {
    const w = runCase('routine_error', { type: 'routine_error' });
    assert.strictEqual(w.said.length, 1);
    assert.ok(w.said[0] && w.said[0].trim(), 'silence is the failure this case exists to prevent');
  });

  // THE SKILL LIST'S ARRIVAL IS DISPATCH WIRING TOO, and it was reachable only
  // by loading the whole shell. The view tests call the function directly and
  // the view mutations break the view, so deleting the call from the client
  // left every test green while an editor opened before the reply landed sat
  // on its loading line for the rest of the session.
  test('the arriving skill list is handed to an open editor', () => {
    const w = new JSDOM('<!doctype html>', { runScripts: 'dangerously' }).window;
    w.handed = null;
    w.renderSkillsCalled = 0;
    w.routineEditorSkillsArrived = (list) => { w.handed = list; };
    w.renderSkills = () => { w.renderSkillsCalled++; };
    // The same reply also redraws the routines list, whose empty state asks
    // whether the workspace has a skill. Stubbed rather than removed: this
    // test is about what the editor is handed, and a missing global would fail
    // it for a reason that has nothing to do with that.
    w.renderRoutinesCalled = 0;
    w.renderRoutines = () => { w.renderRoutinesCalled++; };
    w.selectSkill = () => {};
    w.palettePendingSkill = null;
    const list = skillFixture();
    w.d = { type: 'skills', skills: list };
    w.eval(`(function () {${caseBody('skills')}\n})()`);

    assert.ok(w.handed, 'the editor is never told the list arrived');
    assert.deepStrictEqual(w.handed.map((s) => s.id), list.map((s) => s.id),
      'the editor is handed the list that arrived, not a different one');
    assert.strictEqual(w.skillsLoaded, true, 'sanity: this is the case that marks the list loaded');
    assert.strictEqual(w.renderSkillsCalled, 1, 'sanity: the skills view still renders');
    assert.strictEqual(w.renderRoutinesCalled, 1,
      'the routines empty state asks whether this workspace has a skill and was not redrawn');
  });

  test('a written routine is confirmed and the editor is released', () => {
    const w = runCase('routine_saved', { type: 'routine_saved', agentId: 'piper', name: 'Compile the ops summary' });
    assert.strictEqual(w.savedCalled, 1, 'the editor leaves on the reply, not on send');
    assert.strictEqual(w.said.length, 1);
    assert.match(w.said[0], /Compile the ops summary/);
    assert.match(w.said[0], /piper/);
    assert.deepStrictEqual(w.failedWith, []);
  });

  // A schedule change lands on the same road, because the reader is in the same
  // place: the editor, with a save in flight, waiting to be told. Cut out and
  // RUN like the two above, so a case that exists and does nothing fails here.
  test('a rescheduled routine is confirmed and the editor is released', () => {
    const w = runCase('routine_rescheduled', {
      type: 'routine_rescheduled', agentId: 'piper',
      name: 'Compile the ops summary', schedule: 'every friday at 16:00',
    });
    assert.strictEqual(w.savedCalled, 1, 'the editor leaves on the reply, not on send');
    assert.strictEqual(w.said.length, 1);
    assert.match(w.said[0], /Compile the ops summary/, 'the confirmation names the routine');
    assert.match(w.said[0], /every friday at 16:00/, 'and the time it now runs');
    assert.strictEqual(w.clearedCalled, 1, 'a change that went through retires the last refusal');
    assert.deepStrictEqual(w.failedWith, []);
  });
});

describe('routine editor: the way in from an agent', () => {
  // THE ONLY DOOR TO THE SCOPED EDITOR, and nothing rendered it.
  //
  // Every other test of the scoped entry calls the entry function directly,
  // which proves the function works and says nothing about whether anything
  // calls it. Delete the control from the profile, or break the agent id
  // written into it, and the whole suite stays green while the scoped entry
  // point no longer exists.
  //
  // Same shape as the router line and the skill dispatch case, and the same
  // treatment: render the real profile and press the real control.
  const PROFILE_SRC = fs.readFileSync(path.join(ROOT, 'public', 'views', 'profile.js'), 'utf-8');

  function profileFor(agent) {
    const dom = new JSDOM('<!doctype html><html><body>'
      + '<div id="profile-content"></div>'
      + '<div id="view-routine-editor"><div id="routine-editor-content"></div></div>'
      + '</body></html>', { runScripts: 'dangerously' });
    const w = dom.window;
    w.eval(MODEL_SRC);
    w.eval(VIEW_SRC);
    w.eval(PROFILE_SRC);
    w.agents = [agent];
    w.conversations = [];
    w.skills = skillFixture();
    w.skillsLoaded = true;
    w.esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    w.formatTimeAgo = () => 'a while ago';
    w.getGuide = () => ({ id: 'doc' });
    w.switchNav = () => {};
    w.setNavState = () => {};
    w.showView = () => {};
    w.startConversation = () => {};
    w.addToTeam = () => {};
    w.openConversation = () => {};
    w.selectSkill = () => {};
    w.Intl = { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'Europe/London' }) }) };
    w.showProfile(agent.id);
    return { w, doc: w.document, dom };
  }

  const PIPER = {
    id: 'piper', displayName: 'Piper', role: 'Ops summaries', colour: '#E87A5A',
    icon: 'P', status: 'active', runtime: 'claude',
  };

  test('an agent profile offers a way to schedule one of its skills', () => {
    const { doc, dom } = profileFor(PIPER);
    const control = doc.querySelector('[data-profile-action="add-routine"]');
    assert.ok(control, 'the profile is the only door to the scoped editor and it has to be on the page');
    assert.match(control.textContent, /Add routine/);
    dom.window.close();
  });

  test('pressing it opens the editor scoped to that agent', () => {
    const { doc, w, dom } = profileFor(PIPER);
    const control = doc.querySelector('[data-profile-action="add-routine"]');
    control.click();

    // The agent the control was rendered for and the agent the editor opened
    // for, asserted against each other rather than each against a constant, so
    // a wrong id written into the handler fails even though both halves look
    // right on their own.
    assert.strictEqual(control.getAttribute('data-agent-id'), PIPER.id, 'sanity: the control names the agent it was rendered for');
    const body = doc.getElementById('routine-editor-content').textContent.replace(/\s+/g, ' ');
    assert.match(body, /Pick a skill Piper already has/, 'the editor opened scoped to the agent whose profile it was pressed on');

    const offered = [...doc.querySelectorAll('[data-skill-key]')].map(r => r.getAttribute('data-skill-key'));
    assert.deepStrictEqual(offered, ['ops-summary:piper'], 'and it offers that agent\'s skills, not the whole team\'s');
    dom.window.close();
  });

  // A profile for an agent with no skills still offers the way in; what it
  // reaches is the offer to build one, which is a different state and not a
  // reason to hide the door.
  test('an agent with no skills of its own still offers the way in', () => {
    const { doc, dom } = profileFor({ ...PIPER, id: 'solo', displayName: 'Solo' });
    const control = doc.querySelector('[data-profile-action="add-routine"]');
    assert.ok(control, 'the control does not depend on the agent already having a skill');
    control.click();
    assert.ok(doc.querySelector('[data-routine-editor="create-skill"]'));
    dom.window.close();
  });
});

// ===== CHANGING WHEN A SAVED ROUTINE RUNS =====
//
// The same step 2 the create road ends on, opened with a routine's own values
// already in it. What is asserted here is what a BROWSER shows: a model
// carrying the right pre-fill, wired into a view that draws the picker anyway,
// passes every model test and hands the reader a screen offering to change the
// two things this road must not touch.
describe('routine editor view: editing a saved routine', () => {
  // The routine as the roster carries it, which is what the entry point is
  // handed. Opened through openRoutineEditor rather than through the control
  // that presses it, because that control is a separate change with a door
  // enumeration of its own; what this file owns is the render.
  function openEdit(over = {}) {
    const dom = new JSDOM('<!doctype html><html><body>'
      + '<button class="nav-item" data-nav="team"></button>'
      + '<div id="view-routine-editor" class="hidden"><div id="routine-editor-content"></div></div>'
      + '</body></html>', { runScripts: 'dangerously' });
    const w = dom.window;
    w.eval(MODEL_SRC);
    w.eval(VIEW_SRC);
    w.sent = [];
    w.ws = { send: (text) => w.sent.push(JSON.parse(text)) };
    w.navigatedTo = null;
    w.switchNav = (nav) => { w.navigatedTo = nav; };
    w.showView = () => {};
    w.setNavState = () => {};
    w.profileShown = null;
    w.showProfile = (id) => { w.profileShown = id; };
    const schedule = over.schedule === undefined ? 'every monday at 07:00' : over.schedule;
    const parsed = w.RundockRoutineEditorModel.readSchedule(schedule);
    w.openRoutineEditor({
      step: 'schedule',
      agentId: 'piper',
      agentName: 'Piper',
      skills: [],
      zone: 'Europe/London',
      runOn: over.runOn || 'local',
      frequency: parsed ? parsed.frequency : null,
      time: parsed ? parsed.time : null,
      edit: {
        agentId: 'piper',
        name: over.name || 'Compile the ops summary',
        occurrence: over.occurrence === undefined ? 0 : over.occurrence,
        schedule,
      },
    });
    return { dom, w, doc: w.document };
  }

  // AC-2. The routine's own frequency and time are the ones the controls are
  // showing, read off the rendered options rather than off internal state: a
  // select asked to show a value it does not have shows its first one instead,
  // which is the failure this has to be able to see.
  test('the sentence builder opens carrying the routine\'s current times', () => {
    const { doc, dom } = openEdit({ schedule: 'every monday at 07:00' });
    assert.strictEqual(doc.querySelector('select[data-routine-field="frequency"]').value, 'monday');
    assert.strictEqual(doc.querySelector('select[data-routine-field="time"]').value, '07:00');
    assert.match(text(doc), /Compile the ops summary/, 'and it names the routine being changed');
    assert.match(text(doc), /every Monday at 7:00am/, 'the preview reads back what is on the controls');
    dom.window.close();
  });

  // AC-2, the other half: a routine on a different schedule opens on ITS
  // values. Asserting one routine's times proves the defaults were not simply
  // left standing.
  test('a different routine opens on its own times, not on the defaults', () => {
    const { doc, dom } = openEdit({ schedule: 'every day at 18:30' });
    assert.strictEqual(doc.querySelector('select[data-routine-field="frequency"]').value, 'day');
    assert.strictEqual(doc.querySelector('select[data-routine-field="time"]').value, '18:30');
    dom.window.close();
  });

  // AC-3. Neither the skill nor the run target is a control on this road, and
  // neither is missing either: both are on the page as values.
  test('the skill and the run target are shown and cannot be changed', () => {
    const { doc, dom } = openEdit();
    assert.strictEqual(doc.querySelector('[data-skill-key]'), null,
      'the skill is settled, so no picker is drawn for it');
    assert.strictEqual(doc.querySelector('[data-run-on]'), null,
      'the run target is settled, so no pressable option is drawn for it');

    const fixed = doc.querySelector('[data-routine-editor="run-on-fixed"]');
    assert.ok(fixed, 'and it is shown rather than dropped: a field that vanishes reads as a setting lost');
    assert.match(fixed.textContent, /This computer/);
    assert.match(fixed.textContent, /Runs while Rundock is open here/);
    assert.strictEqual(fixed.getAttribute('onclick'), null, 'nothing on it is pressable');

    // The skill is the pill in the sentence, which is a value rather than a
    // control by construction.
    assert.match(doc.querySelector('.re-pill').textContent, /Compile the ops summary/);
    dom.window.close();
  });

  // The rule the whole module is shaped around, on the surface this card adds.
  // A second place drawing the run target is a second place for the always-on
  // option's promise to end up on the option that cannot keep it.
  test('the shown run target does not promise what the local option cannot do', () => {
    const { doc, dom } = openEdit();
    assert.ok(!text(doc).includes(OFF_COMPUTER_PROMISE),
      `the local option must not carry "${OFF_COMPUTER_PROMISE}"`);
    dom.window.close();
  });

  // The workspace caveat qualifies the field rather than the act of choosing,
  // and it is as true of a routine being moved as of one being made.
  test('the caveat about several computers is still shown', () => {
    const { doc, dom } = openEdit();
    assert.match(doc.querySelector('[data-routine-editor="caveat"]').textContent,
      /Routines run on the machine they were made on/);
    dom.window.close();
  });

  // Editing is not step two of two: there is no step one behind it.
  test('the lead does not offer a first step that does not exist', () => {
    const { doc, dom } = openEdit();
    assert.ok(!text(doc).includes('Step 2 of 2'), 'nothing behind this screen was step one');
    assert.match(text(doc), /Nothing else about the routine changes/);
    assert.match(doc.querySelector('.settings-section-title').textContent, /Edit routine/);
    dom.window.close();
  });

  // The routine's stored schedule, when the controls cannot show it. Without
  // this the defaults read as the routine's own times and the reader replaces a
  // schedule they never saw.
  test('a schedule the picker cannot show is named on the step', () => {
    const { doc, dom } = openEdit({ schedule: 'every day at 07:03' });
    const note = doc.querySelector('[data-routine-editor="stored-schedule"]');
    assert.ok(note, 'the step accounts for the difference between the controls and the file');
    assert.match(note.textContent, /every day at 07:03/);
    dom.window.close();
  });

  test('a schedule the picker can show is left to speak for itself', () => {
    const { doc, dom } = openEdit({ schedule: 'every monday at 07:00' });
    assert.strictEqual(doc.querySelector('[data-routine-editor="stored-schedule"]'), null,
      'the controls are showing this routine\'s own times, so there is nothing to account for');
    dom.window.close();
  });

  // A routine name is author text and reaches the page through the pill and
  // through the note, so both are checked rather than only the one that is
  // obviously a value.
  test('a routine name reaches the page as text, not as markup', () => {
    const nasty = '<img src=x onerror=alert(1)>';
    const { doc, dom } = openEdit({ name: nasty, schedule: 'every fortnight at 07:00' });
    assert.strictEqual(doc.querySelector('#routine-editor-content img'), null);
    assert.strictEqual(doc.querySelector('.re-pill').textContent.trim(), nasty);
    dom.window.close();
  });

  // AC-4's client half, and the reason it is not save_routine: that message
  // appends a block, so sent from here it would leave the old schedule firing
  // beside the new one under one name.
  test('saving asks for the routine to be moved, by the identity it was opened with', () => {
    const { doc, w, dom } = openEdit({ schedule: 'every monday at 07:00', occurrence: 2 });
    const select = doc.querySelector('select[data-routine-field="time"]');
    select.value = '16:00';
    select.dispatchEvent(new w.Event('change'));
    doc.querySelector('.re-actions .settings-btn-primary').click();
    doc.querySelector('[data-routine-editor="save"]').click();

    assert.deepStrictEqual(w.sent, [{
      type: 'set_routine_schedule',
      agentId: 'piper',
      name: 'Compile the ops summary',
      occurrence: 2,
      schedule: 'every monday at 16:00',
    }]);
    assert.strictEqual(w.navigatedTo, null, 'sending is not saving: the editor waits to be told');
    dom.window.close();
  });

  test('the button says what it does, which is not making a routine', () => {
    const { doc, dom } = openEdit();
    doc.querySelector('.re-actions .settings-btn-primary').click();
    assert.match(doc.querySelector('[data-routine-editor="save"]').textContent, /Save changes/);
    dom.window.close();
  });

  test('a change in flight is not sent twice', () => {
    const { doc, w, dom } = openEdit();
    doc.querySelector('.re-actions .settings-btn-primary').click();
    doc.querySelector('[data-routine-editor="save"]').click();
    w.saveRoutine();
    assert.strictEqual(w.sent.length, 1);
    dom.window.close();
  });

  // The server refused it. The editor is still on screen precisely so the
  // answer has somewhere to go, and the reader is not moved off it.
  test('a refused change is shown where the reader is looking', () => {
    const { doc, w, dom } = openEdit();
    doc.querySelector('.re-actions .settings-btn-primary').click();
    doc.querySelector('[data-routine-editor="save"]').click();
    w.routineEditorFailed('That schedule could not be written.');
    assert.match(doc.querySelector('[data-routine-editor="error"]').textContent,
      /That schedule could not be written/);
    assert.strictEqual(w.navigatedTo, null, 'a refused change does not leave the editor');
    dom.window.close();
  });

  test('a change the server wrote returns to the list, the way a save does', () => {
    const { doc, w, dom } = openEdit();
    doc.querySelector('.re-actions .settings-btn-primary').click();
    doc.querySelector('[data-routine-editor="save"]').click();
    w.routineEditorSaved();
    assert.strictEqual(w.navigatedTo, 'team',
      'this shell has no routines section, so the destination resolves to one it does have');
    dom.window.close();
  });

  // The breadcrumb names where the press came from. An edit carries the owning
  // agent too, so without its own branch the label would read "Back to Piper"
  // and go to a profile the reader was never on.
  test('the breadcrumb goes back to the list the edit was opened from', () => {
    const { doc, w, dom } = openEdit();
    const back = doc.querySelector('[data-routine-editor="back"]');
    assert.match(back.textContent, /Back to routines/);
    assert.ok(!back.textContent.includes('Piper'), 'the press did not come from an agent profile');
    back.click();
    assert.strictEqual(w.profileShown, null, 'and it does not go to one');
    assert.strictEqual(w.navigatedTo, 'team', 'it resolves to the list, or to what this shell has instead');
    dom.window.close();
  });

  // A routine already declaring the reserved target keeps it: this screen does
  // not decide where a routine runs, so it shows what the file says.
  test('a routine on the reserved target keeps it, and it is still not offered', () => {
    const { doc, dom } = openEdit({ runOn: 'agent-computer' });
    const fixed = doc.querySelector('[data-routine-editor="run-on-fixed"]');
    assert.match(fixed.textContent, /Your Agent Computer/);
    assert.strictEqual(doc.querySelector('[data-run-on]'), null, 'and nothing offers to change it');
    dom.window.close();
  });
});
