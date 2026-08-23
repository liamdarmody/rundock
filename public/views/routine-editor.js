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
    };
  }

  function selectedOption() {
    if (!state || !state.selectedKey) return null;
    const choice = model().skillChoices({ skills: state.skills, agentId: state.agentId });
    return choice.options.filter(o => o.key === state.selectedKey)[0] || null;
  }

  // ===== RENDER =====

  function pickStep(m, choice) {
    let h = `<p class="re-lead">${escText(m.stepLead({ agentName: state.agentName }))}</p>`;

    if (choice.createSkill) {
      // The zero-skills state is an OFFER, so it gets the shape an offer has:
      // one line saying where a skill comes from and one thing to press. It
      // deliberately reads nothing like a fault, because nothing has failed.
      return h + `<div class="re-offer">
        <p class="re-offer-lead">${escText(choice.emptyLead)}</p>
        <button class="settings-btn-primary" type="button" data-routine-editor="create-skill"
          onclick="routineEditorBuildSkill()">${escText(choice.createSkillLabel)}</button>
      </div>`;
    }

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
    return `<div class="re-confirm">
      <p class="re-confirm-sentence">${escText(sentence)}</p>
      <p class="re-caption">${escText(caption)}
        <button class="re-link" type="button" onclick="routineEditorStep('schedule')">Edit</button></p>
      <div class="re-actions">
        <button class="settings-btn-primary" type="button" onclick="saveRoutine()">Save routine</button>
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
    openRoutineEditor({
      agentId: agent ? agent.id : null,
      agentName: agent ? agent.displayName : null,
      skills: typeof skills !== 'undefined' && skills ? skills : [],
      zone: browserTimezone(),
    });
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

  function routineEditorLeave() {
    state = null;
    if (typeof switchNav === 'function') switchNav('team');
  }

  /**
   * Write the routine and leave.
   *
   * A draft that cannot be built sends nothing AND does not navigate. Leaving
   * on a failed save returns the reader to a list that does not contain what
   * they think they just made, which is worse than staying put.
   */
  function saveRoutine() {
    const m = model();
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
    if (typeof ws !== 'undefined' && ws) {
      ws.send(JSON.stringify({
        type: 'save_routine',
        agentId: draft.agentId,
        routine: {
          name: draft.name, schedule: draft.schedule, skill: draft.skill,
          prompt: draft.prompt, runOn: draft.runOn,
        },
      }));
    }
    state = null;
    // One fact with one reader: where a save goes is the model's answer, so
    // both entries into this editor leave to the same place.
    if (typeof switchNav === 'function') switchNav(m.SAVE_DESTINATION);
  }

  return {
    openRoutineEditor, addRoutineForAgent, addRoutine, browserTimezone,
    renderRoutineEditor, routineEditorHtml,
    routineEditorPick, routineEditorStep, routineEditorSetField, routineEditorRunOn,
    routineEditorBuildSkill, routineEditorLeave, saveRoutine,
  };
}));
