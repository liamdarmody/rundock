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
      // Almost always 'pick', because almost every door has nothing chosen
      // yet. The skill page is the exception: the reader chose the skill by
      // being on its page, so opening on the picker would ask again.
      step: (input && input.step) || 'pick',
      agentId: (input && input.agentId) || null,
      agentName: (input && input.agentName) || null,
      skills: (input && input.skills) || [],
      zone: (input && input.zone) || null,
      // The skill page this was opened from, if any. It owns the breadcrumb,
      // because a breadcrumb belongs to the door rather than to the state:
      // the skill door can carry an agent as well, and "Back to Piper" on a
      // press that came from a skill page is a label naming somewhere the
      // press does not go.
      originSkillId: (input && input.originSkillId) || null,
      originSkillName: (input && input.originSkillName) || null,
      selectedKey: (input && input.selectedKey) || null,
      // The routine being CHANGED, or nothing when one is being made.
      //
      // ITS PRESENCE IS WHAT THE WHOLE EDIT MODE IS. A routine that already
      // exists is addressed by the same triple every other control on the
      // routines list uses (the agent that declares it, its name, and which of
      // that agent's routines of that name it is), because nothing makes a name
      // unique in a file and a message that dropped the last part would change
      // whichever namesake came first.
      //
      // It carries the STORED schedule as well as the identity, so the step can
      // account for a schedule the controls below cannot show rather than
      // quietly presenting the defaults as the routine's own times.
      edit: (input && input.edit) || null,
      // Pre-filled when a routine is being changed, and the defaults otherwise.
      // The values arrive already looked up against what this editor offers, so
      // a stored schedule it cannot show leaves the defaults standing and the
      // step says so out loud.
      frequency: (input && input.frequency) || 'day',
      time: (input && input.time) || '09:00',
      // The default is the only value this release can honour. It is read from
      // the supported set rather than typed, so it cannot drift from it. An
      // edit carries the routine's own value instead, which it SHOWS and never
      // offers to change: a routine already declaring the reserved target keeps
      // it, because this screen is not where that is decided.
      runOn: (input && input.runOn) || model().RUN_ON_SUPPORTED[0],
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

  /**
   * WHAT IS BEING SCHEDULED, whichever way the reader got here.
   *
   * Making a routine, that is the skill they picked, and it comes out of the
   * picker. Changing one, it is the routine itself, which was named when it was
   * made and is not being renamed here.
   *
   * ONE FUNCTION RATHER THAN A BRANCH AT EVERY READER, because three places ask
   * (both step renders and the gate that chooses between them) and a branch
   * missed at any one of them draws a step with an empty pill in it.
   */
  function subject() {
    if (state && state.edit) return { name: state.edit.name };
    return selectedOption();
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
        onclick="routineEditorPick(this.dataset.skillKey)">
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
        onclick="routineEditorRunOn(this.dataset.runOn)">
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

  /**
   * The same field on the edit road: the routine's run target, SHOWN.
   *
   * WHY IT IS SHOWN AND NOT OFFERED. Changing where a routine runs is a
   * different edit with a different consequence, and this release has one
   * supported value anyway, so a picker here would be a control with nothing to
   * choose. Leaving the field out instead would be worse than either: the
   * reader is about to change when this routine runs and is entitled to see
   * where it will do it, and a field that disappears on the edit road reads as
   * a setting that has been lost rather than one that is settled.
   *
   * NO MARK AND NO ROW SHAPE, deliberately. The picker's rows carry a tick and
   * a border that says "pressable", and a row wearing that shape which does
   * nothing when pressed teaches the reader a wrong model of the screen. This
   * is a value on a card, which is what a settled value looks like everywhere
   * else in this app.
   *
   * THE COPY IS STILL READ OFF THE OPTION, exactly as the picker reads it. That
   * is the rule this whole module exists to hold: the words that promise a
   * routine keeps running while the computer is off belong to the option that
   * does it, and a second surface writing its own version of that sentence is
   * how the promise ends up on the option that cannot keep it.
   *
   * THE CAVEAT STAYS. It qualifies the field rather than the act of choosing,
   * and it is as true of a routine being moved as of one being made: a
   * workspace open on four computers runs this routine on each of them, whether
   * the reader is setting its time for the first time or the second.
   */
  function fixedRunOnField(m) {
    const field = m.runOnField();
    const option = m.runOnOption(state.runOn);
    if (!option) return '';
    return `<div class="re-field" data-routine-editor="run-on-field">
      <p class="re-field-label">${escText(field.label)}</p>
      <div class="re-fixed" data-routine-editor="run-on-fixed">
        <div class="re-name">${escText(option.name)}</div>
        <div class="re-meta">${escText(option.meta)}</div>
      </div>
      <p class="re-caveat" data-routine-editor="caveat">${escText(field.caveat)}</p>
    </div>`;
  }

  function scheduleStep(m, option) {
    const sentence = m.previewSentence({
      frequency: state.frequency, time: state.time, skillName: option && option.name, runOn: state.runOn,
    });
    const zone = m.timezoneCaption({ zone: state.zone, agentName: state.agentName });

    // EDITING IS NOT STEP TWO OF TWO. There is no step one behind an edit: the
    // skill and the run target are settled and shown rather than asked for, so
    // a step counter would offer a first step that does not exist.
    let h = `<p class="re-lead">${escText(state.edit ? m.STEP_LEADS.edit : m.STEP_LEADS.schedule)}</p>`;
    // Reads as one sentence in the order a person would say it: the skill
    // first, because that is the thing being scheduled, then the cadence.
    // "Every day at 9:00am, run: X" buried the subject at the end of a
    // clause; "Run X every day at 9:00am" states it first and needs no comma
    // to separate the two halves.
    h += '<div class="re-sentence"><span class="re-word">Run</span>';
    h += `<span class="re-pill">${escText(option ? option.name : '')}</span>`;
    h += '<span class="re-word">every</span>';
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
    // NO TRAILING FULL STOP HERE. This row is a form, not a sentence someone
    // reads start to finish: a period on the same line as two open dropdowns
    // read as one more thing to click through rather than as punctuation. The
    // preview directly below it, and the confirmation line on the next step,
    // both still end in one: those ARE finished sentences, read once and not
    // interacted with, which is where the owner's own reading of a full stop
    // applies.
    h += '</select></div>';

    if (sentence) h += `<p class="re-preview" data-routine-editor="sentence">${escText(sentence)}</p>`;
    // WHEN THE ROUTINE'S OWN SCHEDULE IS NOT ONE THESE CONTROLS CAN SHOW.
    //
    // Agent files are written by hand, and the scheduler reads more than this
    // editor offers: any minute of the hour, in any case. The model refuses to
    // pre-fill from a schedule the dropdowns cannot display, which is right,
    // and leaves the step showing values that are not the routine's. Without
    // this line those defaults would read as its current times, and the reader
    // would replace a schedule they never saw. The note names the stored one
    // verbatim and says what saving does to it.
    const stored = state.edit ? m.storedScheduleNote({ schedule: state.edit.schedule }) : null;
    if (stored) h += `<p class="re-caveat" data-routine-editor="stored-schedule">${escText(stored)}</p>`;
    h += state.edit ? fixedRunOnField(m) : runOnField(m);
    // ONE NOTE, NOT TWO. The zone and the workspace fact used to be two
    // separate paragraphs stacked under the run-on field, on top of that
    // field's own caveat: three blocks of grey text in a row, which is the
    // "too much text" the design review pass was asked to fix. Both are
    // still true and neither dropped a word the tests pin, but they are one
    // thought a reader has once, right after building the sentence ("here is
    // what this actually means"), so they share one paragraph now.
    //
    // WHERE THE ROUTINE BEING MADE WILL ACTUALLY RUN is still read off the
    // step rather than off a bare constant, the same way the run-on caveat is
    // read off its field: a sentence the model hands back as part of the step
    // cannot be left out of a render of that step without the omission being
    // visible here. The `data-routine-editor="workspace-caveat"` attribute
    // stays on this element, unmoved, because the doors test that checks this
    // screen names which workspace a routine will run in reads it there.
    const note = [zone, m.scheduleStepFields().workspaceCaveat].filter(Boolean).join(' ');
    if (note) h += `<p class="re-caveat" data-routine-editor="workspace-caveat">${escText(note)}</p>`;
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
    // WHAT THE BUTTON SAYS IT WILL DO, and the two roads do different things.
    // "Save routine" on an edit would read as making one, next to a sentence
    // describing a routine that already exists.
    const label = state.edit ? 'Save changes' : 'Save routine';
    return `<div class="re-confirm">
      <p class="re-confirm-sentence">${escText(sentence)}</p>
      <p class="re-caption">${escText(caption)}
        <button class="re-link" type="button" onclick="routineEditorStep('schedule')">Edit</button></p>
      ${problem}
      <div class="re-actions">
        <button class="settings-btn-primary" type="button" data-routine-editor="save"
          ${state.saving ? 'disabled' : ''} onclick="saveRoutine()">${state.saving ? 'Saving' : label}</button>
      </div>
    </div>`;
  }

  function routineEditorHtml() {
    const m = model();
    const choice = m.skillChoices({ skills: state.skills, agentId: state.agentId });
    const option = subject();
    let h = '';
    // The breadcrumb belongs to the DOOR that opened the editor, not to what
    // the state happens to carry. The skill door can carry an agent as well,
    // so the skill is asked first; then the agent; otherwise none. Rendered
    // only when there is somewhere to name, so the label can never name a
    // destination this editor does not have.
    if (state.originSkillId && state.originSkillName) {
      h += `<a class="profile-back" data-routine-editor="back" data-back-to-skill="${escText(state.originSkillId)}"
        onclick="routineEditorLeave()">&#8592; Back to ${escText(state.originSkillName)}</a>`;
    } else if (state.edit) {
      // AN EDIT CAME FROM THE LIST, and the breadcrumb names where the press
      // came from rather than what the state happens to carry. An edit carries
      // the owning agent, so without this branch the label would read "Back to
      // Piper" and go to that agent's profile, which is not where the reader
      // was. A control that does not do what its label says is worse than no
      // control: the reader believes the label and learns a wrong model of the
      // app from being shown one.
      h += `<a class="profile-back" data-routine-editor="back" data-back-to-routines
        onclick="routineEditorLeave()">&#8592; Back to routines</a>`;
    } else if (state.agentId && state.agentName) {
      h += `<a class="profile-back" data-routine-editor="back" data-back-to="${escText(state.agentId)}"
        onclick="routineEditorLeave()">&#8592; Back to ${escText(state.agentName)}</a>`;
    }
    h += `<div class="settings-section-title">${state.edit ? 'Edit routine' : 'Add routine'}</div>`;
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
   * Three doors reach this. From an agent's page, and from the routines panel
   * which inherits that page's scope, `agentId` is set and the picker is that
   * agent's. From the routines view it is not, so every agent's skills are
   * offered and each row names which agent runs it. From a skill's own page it
   * is set only when exactly one agent has that skill, so the skill door is
   * the one that can carry both a skill and an agent, or a skill and no agent.
   */
  function openRoutineEditor(input) {
    state = freshState(input);
    // The rail follows the view, resolved by showView from NAV_FOR_VIEW in
    // app.js. This used to name a section here, and the section it named was
    // Team, so the editor lit the team entry on a screen about routines.
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
   * Ask for the skill list when the editor was opened before it arrived.
   *
   * ONE LINE IN ONE PLACE, because every door that can open the editor ahead
   * of the reply needs it and a copy per door is a door that silently stops
   * asking the day somebody edits only the other one.
   */
  function requestSkillsIfMissing(loaded) {
    if (loaded) return;
    if (typeof ws === 'undefined' || !ws) return;
    ws.send(JSON.stringify({ type: 'get_skills' }));
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
    requestSkillsIfMissing(loaded);
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

  /**
   * Open the editor from a skill's own page.
   *
   * TWO OUTCOMES, AND THE SECOND ONE IS WHY THIS IS NOT A ONE-LINER.
   *
   * One agent has the skill: nothing is ambiguous, so the editor opens on the
   * schedule step with that skill and that agent already chosen. The reader
   * pressed a control that said "Schedule this skill" and lands on the step
   * that schedules it.
   *
   * Several agents have it: the editor opens the agent-agnostic picker with
   * nothing selected, because choosing an agent on the reader's behalf would
   * be a guess wearing the shape of a decision. They would only discover which
   * agent they had been given by reading the routine afterwards.
   *
   * The pressed skill's rows come FIRST in that picker, one per agent that
   * could run it. The reader chose the skill by being on its page, so the only
   * thing left to choose is the agent, and they should never have to find the
   * skill a second time to do it.
   *
   * Either way the breadcrumb goes back to the skill, because that is where
   * the press came from.
   *
   * NO LOADING PATH, AND THAT IS A FACT ABOUT THE DOOR RATHER THAN AN
   * OMISSION. This door is a control on a skill's own detail page, and that
   * page is rendered from the skill list. There is no skill page to press
   * before the list has arrived, so the state the other doors guard against
   * cannot be reached from here.
   */
  function addRoutineForSkill(skillId) {
    const list = (typeof skills !== 'undefined' && skills) ? skills : [];
    const skill = list.filter(s => s.id === skillId)[0] || null;
    const assigned = (skill && skill.assignedAgents) || [];
    // Exactly one, and never "the first of several".
    const only = assigned.length === 1 ? assigned[0] : null;
    // The agent's name comes from the ROSTER, the way the agent door resolves
    // it, so both doors put the same words in the same field for the same
    // agent. A skill's assignedAgents entry carries a name of its own, and the
    // two vocabularies drift: the roster resolves a display name and this does
    // not have to agree with it.
    const roster = typeof agents !== 'undefined' && agents ? agents : [];
    const rostered = only ? roster.filter(a => a.id === only.id)[0] : null;
    openRoutineEditor({
      agentId: only ? only.id : null,
      agentName: only ? ((rostered && rostered.displayName) || only.name || null) : null,
      // Scoped to the one skill when the agent came with it. Otherwise every
      // skill, which is what makes the picker agent-agnostic, with the pressed
      // one first so the reader is never asked to find it again.
      skills: only ? [skill] : (skill ? [skill].concat(list.filter(s => s.id !== skill.id)) : list),
      step: only ? 'schedule' : 'pick',
      selectedKey: only ? `${skill.id}:${only.id}` : null,
      originSkillId: skill ? skill.id : null,
      originSkillName: skill ? skill.name : null,
      zone: browserTimezone(),
    });
  }

  function addRoutine() { addRoutineForAgent(null); }

  /**
   * Open the editor on a routine that already exists, to change when it runs.
   *
   * ADDRESSED BY THE TRIPLE, NOT BY A ROW. The caller hands over the agent that
   * declares the routine, its name, and which of that agent's routines of that
   * name it is, because nothing makes a name unique within a file and the
   * writer counts namesakes on purpose. Handing over a row object instead would
   * work until the roster arrived again underneath an open editor, at which
   * point the save would name a routine nobody is looking at.
   *
   * THE ROUTINE IS RESOLVED FROM THE ROSTER HERE rather than passed in, for the
   * reason the agent door resolves its agent name from the roster: the roster
   * is the one copy of what the file says, and a caller passing its own would
   * be a second one free to go stale. A triple that matches nothing opens
   * nothing, which is the honest outcome for a routine deleted between a render
   * and a click.
   *
   * IT OPENS ON THE SCHEDULE STEP because there is no other step: the skill was
   * chosen when the routine was made and is not being chosen again.
   *
   * THE SCHEDULE IS LOOKED UP RATHER THAN SPLIT. A stored schedule this editor
   * could not have built pre-fills nothing, and the step says so; filling the
   * controls from whatever a pattern captured would show the reader a schedule
   * that is not theirs.
   */
  function editRoutineSchedule(agentId, name, occurrence) {
    const roster = typeof agents !== 'undefined' && agents ? agents : [];
    const agent = roster.filter(a => a && a.id === agentId)[0] || null;
    if (!agent) return;
    // Counted the way the list counts them, in roster order, which is file
    // order: the nth namesake here is the nth block in the file.
    const routine = (agent.routines || []).filter(r => r && r.name === name)[occurrence] || null;
    if (!routine) return;
    const parsed = model().readSchedule(routine.schedule);
    openRoutineEditor({
      step: 'schedule',
      agentId: agent.id,
      agentName: agent.displayName || agent.name || null,
      skills: [],
      zone: browserTimezone(),
      runOn: routine.runOn || null,
      frequency: parsed ? parsed.frequency : null,
      time: parsed ? parsed.time : null,
      edit: { agentId: agent.id, name: routine.name, occurrence, schedule: routine.schedule },
    });
  }

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
   * WHY THIS IS A FUNCTION AND NOT A LINE IN THE ROUTER. Handing the router a
   * section the shell does not have is not a no-op: it hides every sidebar,
   * reveals one that is nested inside another, and matches no branch, so the
   * editor stays on screen and the save appears to have done nothing. Written
   * inside the router that line could only be reached by loading the whole
   * shell, so it had no test and could be deleted with the suite green.
   *
   * THE ROUTINES SURFACE HAS A PERMANENT RAIL ENTRY AND A SIDEBAR PANEL OF ITS
   * OWN, so this resolves to it. That panel used to be a child of the team
   * one, revealed by an alias in the router, which is the arrangement the
   * fallback below was written against. The day it was lifted out and given
   * its own place in the rail, this function was already correct and nothing
   * here needed editing, which is the whole argument for resolving against the
   * shell rather than against a belief about it.
   *
   * A destination is usable only if the shell has BOTH halves of it: a rail
   * button carrying the name, and the view panel the router shows by that
   * name. Checking the pair is what makes this a resolution rather than a
   * guess.
   *
   * IT ASKS FOR ALL THREE, and each is here because a parent of this file
   * needed it. The routines section had no sidebar of its own and resolved
   * against `sidebar-routines` anyway, because an empty element of that name
   * sat nested inside the team panel holding the old listing: revealing it by
   * name succeeded and left the reader staring at a hidden parent. That
   * sentinel is gone and the section now has a real panel of its own, so both
   * halves the router touches are real and both are asked for. `setNavState`
   * reveals the sidebar by name and `showView` reveals the view by name, so a
   * shell missing either cannot show this section, and asking for only one of
   * them is how the old accident passed as a check.
   *
   * THE FALLBACK IS SILENT, which is why the trio is asserted against the real
   * markup in the doors suite rather than against a shell a test writes for
   * itself: renaming any of them sends a real save to the team chart with
   * nothing thrown and nothing logged.
   */
  function navigable(nav) {
    if (typeof document === 'undefined') return false;
    return !!(document.querySelector(`[data-nav="${nav}"]`)
      && document.getElementById(`sidebar-${nav}`)
      && document.getElementById(`view-${nav}`));
  }

  function routinesListNav() {
    const destination = model().SAVE_DESTINATION;
    return navigable(destination) ? destination : 'team';
  }

  /**
   * Leave by the breadcrumb, which means going back where you came from.
   *
   * THIS IS NOT THE SAME EXIT AS A SAVE and the two must not share a
   * destination. A save has produced a routine and belongs on the list of
   * routines. The breadcrumb has produced nothing and says, in its own label,
   * which agent it came from.
   *
   * They did share one, so a control reading "Back to Piper" went to the team
   * chart instead. A control that does not do what its label says is worse
   * than no control at all: the reader believes the label, and learns a wrong
   * model of where things are from being shown one.
   */
  function routineEditorLeave() {
    const skillId = state && state.originSkillId;
    const agentId = state && state.agentId;
    // An edit was opened from the routines list, so leaving it goes back there,
    // which is what the breadcrumb this road renders says. Taken before the
    // agent, because an edit carries the owning agent too and the agent branch
    // below would otherwise send the reader to a profile they never came from.
    const editing = !!(state && state.edit);
    state = null;
    if (editing) {
      if (typeof switchNav === 'function') switchNav(routinesListNav());
      return;
    }
    // The skill page first, because the skill door can also carry an agent and
    // the breadcrumb it rendered names the skill.
    //
    // ONLY IF THAT PAGE CAN STILL BE OPENED, and this is a dead end rather
    // than a detail. selectSkill returns doing nothing when the id is not in
    // the list, and the list is replaced whenever a skill is saved in the
    // background or the workspace changes while the editor is open. State is
    // already null by then, so every control in the editor answers nothing:
    // the reader is left looking at a screen that has stopped working, with
    // the rail as the only way out. Falling through costs one condition.
    if (skillId && canSelectSkill(skillId)) { selectSkill(skillId); return; }
    if (agentId && typeof showProfile === 'function') { showProfile(agentId); return; }
    // No skill to go back to and no agent, so the list of routines it is.
    if (typeof switchNav === 'function') switchNav(routinesListNav());
  }

  /**
   * Whether the skill page for this id can still be opened.
   *
   * Asked of the LIST rather than of selectSkill, because selectSkill reports
   * nothing back: it returns identically whether it drew a page or found no
   * such skill, so a caller cannot tell the difference afterwards.
   */
  function canSelectSkill(skillId) {
    if (typeof selectSkill !== 'function') return false;
    const list = (typeof skills !== 'undefined' && skills) ? skills : [];
    return list.some(s => s.id === skillId);
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
    // ONE BUTTON, TWO ASKS, and the branch is here rather than at the button so
    // that the in-flight guard above covers both. A second handler with its own
    // copy of that guard is a second place for a double send to come back.
    if (state.edit) { sendScheduleEdit(m); return; }
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
   * Ask for an existing routine to be moved to a different time.
   *
   * IT ASKS FOR A CHANGE AND NEVER FOR A ROUTINE. save_routine appends a block
   * the file does not have; sent from here it would leave the routine's old
   * schedule firing beside its new one, under one name, which is worse than
   * either. This names the routine that is already there, by the same triple
   * every other control on the routines list uses, so the server edits that
   * block and no other.
   *
   * IT DOES NOT LEAVE HERE, for the reason the create road does not: the write
   * can be refused for things this screen cannot know, and navigating on send
   * means the refusal arrives after the editor is gone. The reader would be
   * looking at a list showing the old time with nothing to explain it.
   *
   * A SCHEDULE THAT CANNOT BE BUILT SENDS NOTHING. Both halves go through the
   * builder rather than being read off the controls, so a value that was never
   * offered assembles into nothing and this returns rather than asking the
   * server to store it.
   */
  function sendScheduleEdit(m) {
    const schedule = m.buildSchedule({ frequency: state.frequency, time: state.time });
    if (!schedule) return;
    if (typeof ws === 'undefined' || !ws) return;
    state.saving = true;
    state.error = null;
    renderRoutineEditor();
    ws.send(JSON.stringify({
      type: 'set_routine_schedule',
      agentId: state.edit.agentId,
      name: state.edit.name,
      occurrence: state.edit.occurrence,
      schedule,
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
    openRoutineEditor, addRoutineForAgent, addRoutineForSkill, addRoutine, editRoutineSchedule, browserTimezone,
    routinesListNav, routineEditorSaved, routineEditorFailed, routineEditorSkillsArrived,
    renderRoutineEditor, routineEditorHtml,
    routineEditorPick, routineEditorStep, routineEditorSetField, routineEditorRunOn,
    routineEditorBuildSkill, routineEditorLeave, saveRoutine,
  };
}));
