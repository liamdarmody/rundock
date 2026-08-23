'use strict';
// The routine editor: pick a skill, then say when it runs, in one sentence.
//
// Same UMD pattern as the other view modules (node-requireable,
// window-attached) and additionally republished on the root object, because
// the generated onclick handlers resolve as window properties at click time.
//
// WHAT THIS FILE IS AND IS NOT. Every word the editor shows, and every rule
// about what can be chosen, lives in routine-editor-model.js. This file turns
// that into elements and reads events back. The split is not tidiness: the
// copy rule this editor exists to hold is that the option a user can pick must
// not promise it runs while the computer is off, and a rule written inside a
// template literal is checkable only by a browser.
//
// So no run-on copy is written here. The rows read their name, their second
// line and their selectability off the option, which is why adding an option
// later changes nothing in this file.
//
// STATE IS MODULE-LOCAL. The other views keep theirs in app.js because they
// were extracted from it. This one is new, nothing else reads a half-built
// routine, and a draft that survives leaving the editor is a bug rather than a
// feature.
(/** @param {any} root @param {() => object} factory */ function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else {
    root.RundockRoutineEditorView = factory(root);
    Object.assign(root, root.RundockRoutineEditorView);
  }
}(typeof self !== 'undefined' ? self : this, function (root) {

  function model() {
    // Resolved at call time rather than at load time: in a browser the two
    // scripts load in either order, and in node the module is required.
    if (root && root.RundockRoutineEditorModel) return root.RundockRoutineEditorModel;
    return require('../routine-editor-model.js');
  }

  // Local rather than the app's global `esc`, so this module is complete on
  // its own under node. A skill name is author text and reaches an attribute
  // as well as a body, so quotes are escaped too.
  function escText(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** @type {any} */
  let state = null;

  function freshState(input) {
    return {
      step: 'pick',
      agentId: (input && input.agentId) || null,
      agentName: (input && input.agentName) || null,
      skills: (input && input.skills) || [],
      zone: (input && input.zone) || null,
      selectedKey: null,
      frequency: 'day',
      time: '09:00',
      // The default is the only value this release can honour. It is read from
      // the supported set rather than typed, so it cannot drift from it.
      runOn: model().RUN_ON_SUPPORTED[0],
      saving: false,
      error: null,
      // Whether the skill list has arrived. NOT the same as it being
      // empty, and the two were indistinguishable: an empty array before
      // the reply lands looks exactly like a workspace with nothing to
      // schedule, so the offer to build a first skill was shown to people
      // whose agents already have several.
      loading: !!(input && input.loading),
    };
  }

  function selectedOption() {
    if (!state || !state.selectedKey) return null;
    const choice = model().skillChoices({ skills: state.skills, agentId: state.agentId });
    return choice.options.filter(o => o.key === state.selectedKey)[0] || null;
  }

  // ===== RENDER =====

  function pickStep(m, choice) {
    // Nothing is known yet, so nothing is claimed. A workspace with no
    // skills and a workspace whose skills have not arrived are different
    // states and only one of them is an offer.
    if (state.loading) {
      return `<p class="re-lead">${escText(m.STEP_LEADS.loading)}</p>`;
    }
    if (choice.createSkill) {
      // NO LEAD LINE HERE. The lead asks the reader to pick a skill, and there
      // is nothing to pick. Printed above an offer to build one it reads as an
      // instruction the page has already made impossible, which is how a state
      // that is not an error comes across as one.

      // The zero-skills state is an OFFER, so it gets the shape an offer has:
      // one line saying where a skill comes from and one thing to press. It
      // deliberately reads nothing like a fault, because nothing has failed.
      return `<div class="re-offer">
        <p class="re-offer-lead">${escText(choice.emptyLead)}</p>
        <button class="settings-btn-primary" type="button" data-routine-editor="create-skill"
          onclick="routineEditorBuildSkill()">${escText(choice.createSkillLabel)}</button>
      </div>`;
    }

    let h = `<p class="re-lead">${escText(m.stepLead({ agentName: state.agentName }))}</p>`;
    h += '<div class="re-list">';
    for (const option of choice.options) {
      const on = option.key === state.selectedKey;
      // The agent is named only when the reader has not already chosen one.
      // The model decides that; this only renders what it was handed.
      const meta = option.agentName ? `<div class="re-meta">${escText(option.agentName)}</div>` : '';
      h += `<div class="re-row${on ? ' sel' : ''}" data-skill-key="${escText(option.key)}"
        onclick="routineEditorPick('${escText(option.key)}')">
        <div class="re-dot">${on ? '&#10003;' : ''}</div>
        <div class="re-body"><div class="re-name">${escText(option.name)}</div>${meta}</div>
      </div>`;
    }
    h += '</div>';

    h += `<div class="re-actions">
      <button class="settings-btn-primary" type="button" ${state.selectedKey ? '' : 'disabled'}
        onclick="routineEditorStep('schedule')">Continue</button>
    </div>`;
    return h;
  }

  function runOnField(m) {
    const field = m.runOnField();
    let h = `<div class="re-field" data-routine-editor="run-on-field">
      <p class="re-field-label">${escText(field.label)}</p>
      <div class="re-list">`;
    for (const option of field.options) {
      const on = option.value === state.runOn;
      // A row that cannot be chosen still renders, because it is how someone
      // learns the other option exists. It carries no control: the flow that
      // sets one up does not exist in this release, and a button that goes
      // nowhere is the same defect as copy that promises what cannot be done.
      h += `<div class="re-row re-compact${on ? ' sel' : ''}${option.selectable ? '' : ' muted'}"
        data-run-on="${escText(option.value)}" data-selectable="${option.selectable}"
        onclick="routineEditorRunOn('${escText(option.value)}')">
        <div class="re-dot">${on ? '&#10003;' : ''}</div>
        <div class="re-body">
          <div class="re-name">${escText(option.name)}</div>
          <div class="re-meta">${escText(option.meta)}</div>
        </div>
      </div>`;
    }
    h += '</div>';
    // Inside the field, because the requirement is that it appears where the
    // choice is made. A caveat rendered next to the field is a caveat one
    // layout change away from a help page.
    h += `<p class="re-caveat" data-routine-editor="caveat">${escText(field.caveat)}</p>`;
    return h + '</div>';
  }

  function scheduleStep(m, option) {
    const sentence = m.previewSentence({
      frequency: state.frequency, time: state.time, skillName: option && option.name, runOn: state.runOn,
    });
    const zone = m.timezoneCaption({ zone: state.zone, agentName: state.agentName });

    let h = `<p class="re-lead">${escText(m.STEP_LEADS.schedule)}</p>`;
    h += '<div class="re-sentence"><span class="re-word">Every</span>';
    h += `<select class="re-select" data-routine-field="frequency"
      onchange="routineEditorSetField('frequency', this.value)">`;
    for (const f of m.FREQUENCIES) {
      h += `<option value="${escText(f.value)}"${f.value === state.frequency ? ' selected' : ''}>${escText(f.label)}</option>`;
    }
    h += '</select><span class="re-word">at</span>';
    h += `<select class="re-select" data-routine-field="time"
      onchange="routineEditorSetField('time', this.value)">`;
    for (const t of m.times()) {
      h += `<option value="${escText(t.value)}"${t.value === state.time ? ' selected' : ''}>${escText(t.label)}</option>`;
    }
    h += '</select><span class="re-word">, run:</span>';
    h += `<span class="re-pill">${escText(option ? option.name : '')}</span></div>`;

    if (sentence) h += `<p class="re-preview" data-routine-editor="sentence">${escText(sentence)}</p>`;
    h += runOnField(m);
    if (zone) h += `<p class="re-caption">${escText(zone)}</p>`;
    h += `<div class="re-actions">
      <button class="settings-btn-primary" type="button" ${sentence ? '' : 'disabled'}
        onclick="routineEditorStep('ready')">Continue</button>
    </div>`;
    return h;
  }

  function readyStep(m, option) {
    const sentence = m.previewSentence({
      frequency: state.frequency, time: state.time, skillName: option && option.name, runOn: state.runOn,
    });
    const caption = m.readyCaption({ zone: state.zone, runOn: state.runOn });
    if (!sentence) {
      // Nothing to confirm. Sending the reader back to the step that can fix
      // it beats a confirmation page with a blank sentence on it.
      return scheduleStep(m, option);
    }
    // A refusal from the server is shown HERE, next to the button that caused
    // it, rather than only as a passing notice elsewhere. The editor is still
    // on screen precisely so this has somewhere to go.
    const problem = state.error
      ? `<p class="re-problem" data-routine-editor="error">${escText(state.error)}</p>`
      : '';
    return `<div class="re-confirm">
      <p class="re-confirm-sentence">${escText(sentence)}</p>
      <p class="re-caption">${escText(caption)}
        <button class="re-link" type="button" onclick="routineEditorStep('schedule')">Edit</button></p>
      ${problem}
      <div class="re-actions">
        <button class="settings-btn-primary" type="button" data-routine-editor="save"
          ${state.saving ? 'disabled' : ''} onclick="saveRoutine()">${state.saving ? 'Saving' : 'Save routine'}</button>
      </div>
    </div>`;
  }

  function routineEditorHtml() {
    const m = model();
    const choice = m.skillChoices({ skills: state.skills, agentId: state.agentId });
    const option = selectedOption();
    let h = '';
    if (state.agentName) {
      h += `<a class="profile-back" onclick="routineEditorLeave()">&#8592; Back to ${escText(state.agentName)}</a>`;
    }
    h += '<div class="settings-section-title">Add routine</div>';
    if (state.step === 'schedule' && option) return h + scheduleStep(m, option);
    if (state.step === 'ready' && option) return h + readyStep(m, option);
    return h + pickStep(m, choice);
  }

  function renderRoutineEditor() {
    const mount = document.getElementById('routine-editor-content');
    if (!mount || !state) return;
    mount.innerHTML = routineEditorHtml();
  }

  // ===== ENTRY AND EXIT =====

  /**
   * Open the editor, scoped to an agent or not.
   *
   * Two entries reach this. From an agent's page `agentId` is set and the
   * picker is that agent's. From the routines view it is not, so every agent's
   * skills are offered and each row names which agent runs it.
   */
  function openRoutineEditor(input) {
    state = freshState(input);
    if (typeof setNavState === 'function') setNavState('team');
    if (typeof showView === 'function') showView('routine-editor');
    renderRoutineEditor();
  }

  /**
   * The time zone the schedule is read in.
   *
   * THE ONE PLACE THIS CODE READS THE MACHINE, and it is at an entry point
   * rather than anywhere a test can inherit it. Everything downstream takes
   * the zone as a value, which is why the editor's tests say the same thing
   * in London and in Auckland. The zone travels as WORDS from here on: no
   * offset is ever computed from it.
   */
  function browserTimezone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (e) { return null; }
  }

  /**
   * Open the editor from an agent's page, scoped to that agent.
   *
   * Passing no id opens the agent-agnostic picker, which is the entry from
   * the routines surface: every agent's skills, each row naming its agent.
   */
  function addRoutineForAgent(agentId) {
    const roster = typeof agents !== 'undefined' && agents ? agents : [];
    const agent = agentId ? roster.filter(a => a.id === agentId)[0] : null;
    // An empty list is only meaningful once the reply has arrived. Until then
    // the editor asks for it and waits, rather than reading nothing as none.
    const loaded = typeof skillsLoaded === 'undefined' || skillsLoaded;
    openRoutineEditor({
      agentId: agent ? agent.id : null,
      agentName: agent ? agent.displayName : null,
      skills: loaded && typeof skills !== 'undefined' && skills ? skills : [],
      loading: !loaded,
      zone: browserTimezone(),
    });
    if (!loaded && typeof ws !== 'undefined' && ws) ws.send(JSON.stringify({ type: 'get_skills' }));
  }

  /**
   * The skill list arrived while the editor was open. Show it.
   *
   * Called from the client's own skills dispatch, so an editor opened before
   * the reply landed fills in rather than sitting on a loading line for the
   * rest of the session.
   */
  function routineEditorSkillsArrived(list) {
    if (!state || !state.loading) return;
    state.skills = list || [];
    state.loading = false;
    renderRoutineEditor();
  }

  function addRoutine() { addRoutineForAgent(null); }

  function routineEditorPick(key) {
    if (!state) return;
    state.selectedKey = key;
    renderRoutineEditor();
  }

  function routineEditorStep(step) {
    if (!state) return;
    state.step = step;
    renderRoutineEditor();
  }

  function routineEditorSetField(field, value) {
    if (!state) return;
    if (field === 'frequency' || field === 'time') state[field] = value;
    renderRoutineEditor();
  }

  /**
   * Read or set where the routine runs.
   *
   * REFUSES ANYTHING THE RELEASE CANNOT HONOUR. The row for the reserved
   * option renders and is pressable, because a row nothing happens on is
   * easier to reason about than one that silently is not there. Pressing it
   * changes nothing, which is the truthful outcome.
   */
  function routineEditorRunOn(value) {
    if (!state) return null;
    if (value === undefined) return state.runOn;
    const option = model().runOnOption(value);
    if (!option || !option.selectable) return state.runOn;
    state.runOn = value;
    renderRoutineEditor();
    return state.runOn;
  }

  // Skills are built by talking to the agent that builds them; this screen
  // never writes one itself.
  function routineEditorBuildSkill() {
    const guide = typeof getGuide === 'function' ? getGuide() : null;
    if (guide && typeof startConversation === 'function') startConversation(guide.id);
  }

  /**
   * The section to leave to, resolved against what the shell actually has.
   *
   * WHY THIS IS A FUNCTION AND NOT A LINE IN THE ROUTER. The routines surface
   * has no rail entry yet, and handing the router a section it does not know
   * is not a no-op: it hides every sidebar, reveals one that is nested inside
   * another, and matches no branch, so the editor stays on screen and the save
   * appears to have done nothing. Written inside the router that line could
   * only be reached by loading the whole shell, so it had no test and could be
   * deleted with the suite green.
   *
   * A destination is usable only if the shell has BOTH halves of it: a rail
   * button carrying the name, and the sidebar panel the router reveals by that
   * name. Checking the pair is what makes this a resolution rather than a
   * guess, and it is why this returns the section that lists routines today
   * and the routines surface itself the day that one is built, with nothing
   * here edited.
   */
  function navigable(nav) {
    if (typeof document === 'undefined') return false;
    return !!(document.querySelector(`[data-nav="${nav}"]`) && document.getElementById(`sidebar-${nav}`));
  }

  function routinesListNav() {
    const destination = model().SAVE_DESTINATION;
    return navigable(destination) ? destination : 'team';
  }

  function routineEditorLeave() {
    state = null;
    if (typeof switchNav === 'function') switchNav(routinesListNav());
  }

  /**
   * Ask for the routine to be written.
   *
   * IT DOES NOT LEAVE HERE, and that is the point. Writing a routine can be
   * refused by the server for reasons this screen cannot know: the agent was
   * removed since the editor opened, its file is outside the workspace, or the
   * file is one a routine cannot be placed in. Navigating on send means a
   * refusal arrives after the editor is gone, and the reader is looking at a
   * list that does not contain the routine with nothing to explain it. That is
   * the worst outcome this flow has, so the editor waits to be told.
   *
   * A draft that cannot be built sends nothing and does not navigate either,
   * for the same reason.
   */
  function saveRoutine() {
    const m = model();
    if (!state || state.saving) return;
    const option = selectedOption();
    if (!option) return;
    const draft = m.routineDraft({
      skill: { id: option.id, slug: option.slug, name: option.name },
      agentId: option.agentId,
      frequency: state.frequency,
      time: state.time,
      runOn: state.runOn,
    });
    if (!draft) return;
    if (typeof ws === 'undefined' || !ws) return;
    state.saving = true;
    state.error = null;
    renderRoutineEditor();
    ws.send(JSON.stringify({
      type: 'save_routine',
      agentId: draft.agentId,
      routine: {
        name: draft.name, schedule: draft.schedule, skill: draft.skill,
        prompt: draft.prompt, runOn: draft.runOn,
      },
    }));
  }

  /**
   * The server wrote it. Now leave.
   *
   * One fact with one reader: where a save goes is the model's answer, so both
   * entries into this editor leave to the same place.
   */
  function routineEditorSaved() {
    if (!state || !state.saving) return;
    state = null;
    if (typeof switchNav === 'function') switchNav(routinesListNav());
  }

  /**
   * The server refused it. Stay, and say so where the reader is looking.
   */
  function routineEditorFailed(message) {
    if (!state || !state.saving) return;
    state.saving = false;
    state.error = message || 'That routine could not be saved.';
    renderRoutineEditor();
  }

  return {
    openRoutineEditor, addRoutineForAgent, addRoutine, browserTimezone,
    routinesListNav, routineEditorSaved, routineEditorFailed, routineEditorSkillsArrived,
    renderRoutineEditor, routineEditorHtml,
    routineEditorPick, routineEditorStep, routineEditorSetField, routineEditorRunOn,
    routineEditorBuildSkill, routineEditorLeave, saveRoutine,
  };
}));
