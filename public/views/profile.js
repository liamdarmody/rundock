'use strict';
// Agent profile view (app.js section 7), extracted verbatim as a Foundations
// view module. Same UMD pattern as markers.js (node-requireable,
// window-attached); additionally republishes showProfile on the root object,
// because classic-script function declarations were window properties and
// the callers rely on that: the generated onclick handlers (agent list, org
// chart, agent chips in the skills view), the search palette, and routing.
//
// Shared state stays in app.js and is reached through the global lexical
// environment at call time: agents, conversations, skills. Helpers reached
// the same way: switchNav, setNavState, esc, formatTimeAgo, getGuide,
// showView. The generated onclick strings (startConversation, addToTeam,
// openConversation, selectSkill) resolve on window at click time. Load
// order (views before app.js) is safe because nothing here touches shared
// state until the app boots. The Routines box reaches RundockRoutinesModel
// for a schedule's words and showRoutinesForAgent for a row's destination,
// and the Setup button reaches RundockGuideCopy for its label, all off the
// global at call time, in the same way.
(/** @param {any} root @param {() => object} factory */ function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    root.RundockProfileView = factory();
    Object.assign(root, root.RundockProfileView);
  }
}(typeof self !== 'undefined' ? self : this, function () {

// ATTRIBUTE-POSITION ESCAPER and the colour rule, both reached off the global
// at call time the same way this file reaches every other helper it does not
// own. `esc` is right for element content and wrong for an attribute value: it
// leaves both quote characters alone. An agent id is the agent file's own
// filename and a skill id is its directory name, so both are chosen by
// whoever can write into the workspace. See public/agent-colour.js for why a
// colour is judged rather than escaped.
function escA(value) {
  if (typeof escAttr === 'function') return escAttr(value);
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function agentColour(value, fallback) {
  const safe = fallback === undefined ? 'var(--accent)' : fallback;
  return typeof RundockAgentColour !== 'undefined'
    ? RundockAgentColour.safeColour(value, safe) : safe;
}

function showProfile(agentId) {
  const a=agents.find(x=>x.id===agentId);
  // Missing target (a search hit whose agent is absent from the client list,
  // server/client desync): land in the Team section consistently instead of
  // leaving the rail on its previous section with no matching pane.
  if(!a) { switchNav('team'); return; }
  // Agent profiles belong to the Team section (the profile's back link goes
  // there), and showView resolves that from the view, so callers arriving from
  // elsewhere (the search palette, a skill page's agent chips) get the rail and
  // the sidebar without asking for them.
  const existing=conversations.filter(c=>c.agentId===agentId||(c.sessionIds||[]).some(s=>s.agentId===agentId));
  let h=`<a class="profile-back" onclick="switchNav('team')">&#8592; Back</a>
    <div class="profile-header">
      <div class="profile-avatar" style="background:${agentColour(a.colour)}">${esc(a.icon)}</div>
      <div>
        <div class="profile-name">${esc(a.displayName)}</div>
        ${a.role?`<div style="font-size:var(--body);color:var(--text-2)">${esc(a.role)}</div>`:''}
      </div>
    </div>`;
  if(a.description) h+=`<p class="profile-desc" style="margin-bottom:24px">${esc(a.description)}</p>`;
  if(a.status === 'raw') {
    // The label names the guide the button opens, so the two cannot disagree:
    // it used to name one agent and open a conversation with whichever agent
    // the workspace's platform slot actually held.
    const guideCopy = typeof RundockGuideCopy !== 'undefined' ? RundockGuideCopy : null;
    const setupLabel = (guideCopy && guideCopy.guideLine('setup', getGuide()?.displayName)) || '';
    h+=`<div class="profile-cta"><button class="profile-cta-btn" onclick="startConversation(getGuide()?.id || 'default')">${esc(setupLabel)}</button></div>`;
  } else if(a.status === 'available') {
    h+=`<div class="profile-cta"><button class="profile-cta-btn" data-agent-id="${escA(a.id)}" onclick="addToTeam(this.dataset.agentId)">Add to team</button></div>`;
  } else {
    h+=`<div class="profile-cta"><button class="profile-cta-btn" data-agent-id="${escA(a.id)}" onclick="startConversation(this.dataset.agentId)">New conversation</button></div>`;
  }
  // Capabilities card
  if(a.capabilities) {
    const c = a.capabilities;
    h+=`<div class="profile-card">`;
    // Split on commas that are NOT inside parentheses, so phrase/parenthetical
    // entries (e.g. "Reddit (r/ClaudeAI, r/LocalLLaMA)") stay on one line.
    const splitCaps = s => s.split(/,(?![^(]*\))/).map(x => x.trim()).filter(Boolean);
    if(c.does) h+=`<div class="profile-card-section"><div class="profile-section-label">What ${esc((a.displayName||'').trim())} does</div><div class="profile-card-text">${esc(c.does)}</div></div>`;
    if(c.reads) h+=`<div class="profile-card-section"><div class="profile-section-label">Reads from</div>${splitCaps(c.reads).map(r=>`<div class="profile-card-item">${esc(r)}</div>`).join('')}</div>`;
    if(c.writes) h+=`<div class="profile-card-section"><div class="profile-section-label">Writes to</div>${splitCaps(c.writes).map(w=>`<div class="profile-card-item">${esc(w)}</div>`).join('')}</div>`;
    h+=`</div>`;
  }
  // Skills card
  const agentSkills = skills.filter(s => s.assignedAgents.some(aa => aa.id === a.id));
  if(agentSkills.length) {
    h+=`<div class="profile-card"><div class="profile-card-section"><div class="profile-section-label">Skills</div>`;
    for(const s of agentSkills) {
      h+=`<div class="profile-card-item" style="display:flex;flex-direction:column;gap:2px;cursor:pointer" data-skill-id="${escA(s.id)}" onclick="switchNav('skills');selectSkill(this.dataset.skillId)">
        <span style="font-weight:600">${esc(s.name)}</span>
        ${s.description ? `<span style="font-size:var(--caption);color:var(--text-2)">${esc(s.description)}</span>` : ''}
      </div>`;
    }
    h+=`</div></div>`;
  }
  // Routines box. ALWAYS RENDERED, in both of its states. A box that vanished
  // once you had used it would take the concept with it, and an agent's own
  // schedules are what a reader came to this page to see.
  //
  // A ROW IS A NAME AND A SCHEDULE, AND THAT DELETES A DEFECT RATHER THAN
  // FIXING ONE. This surface used to interpolate the run record's status word
  // straight into the markup and print things like "Last run: 4h ago
  // (interrupted)". The three-tone ruling decides what an outcome is called
  // and what tone it gets, it took three rounds to settle, and it never
  // reached here, so the one place a person met a routine while looking at an
  // agent was the one place the vocabulary was raw. What happened last time is
  // not restated here in better words: it is not on this page. It belongs to
  // the routines view, where routines-model.js already owns both, and a row
  // here goes there.
  const hasRoutines = a.routines && a.routines.length;
  const hasConnectors = a.capabilities?.connectors;
  {
    // The routines model, reached the way every other module reaches a
    // sibling: off the global at call time, with no dependency added to this
    // view's wrapper for one string.
    const routinesModel = typeof RundockRoutinesModel !== 'undefined' ? RundockRoutinesModel : null;
    h+=`<div class="profile-card"><div class="profile-card-section"><div class="profile-section-label">Routines</div>`;
    if(hasRoutines) {
      for(const r of a.routines) {
        // The schedule in the words the routines view uses, so the two places
        // an agent's schedule is written cannot read differently. A schedule
        // the editor never offered has no plain words, and the stored string
        // is shown rather than nothing.
        const when = (routinesModel && routinesModel.scheduleWords(r.schedule)) || r.schedule;
        h+=`<div class="profile-card-item" style="display:flex;flex-direction:column;gap:3px;cursor:pointer" data-agent-id="${escA(a.id)}" onclick="showRoutinesForAgent(this.dataset.agentId)">
          <span style="font-weight:600">${esc(r.name)}</span>
          <span style="font-size:var(--caption);color:var(--text-2)">${esc(when)}</span>
        </div>`;
      }
    } else {
      // FEATURE DISCOVERY, AND ONLY THAT. The offer exists to teach that
      // routines are a thing, in the one place where an agent with no schedule
      // is being looked at. Once this agent has one it goes, and the next is
      // added from the routines view's own header control, which inherits the
      // scope it is pressed in.
      // SECONDARY WEIGHT, matching "Schedule this skill" on the skill page:
      // both are a shortcut into the same routine editor, not the primary
      // action of this screen, and reading as loud as "New conversation"
      // overstated it.
      h+=`<div class="profile-card-text" style="padding-bottom:10px">Give one of ${esc(a.displayName)}'s skills a schedule and it runs without being asked.</div>
      <button class="settings-btn" type="button" data-profile-action="add-routine"
        data-agent-id="${escA(a.id)}" onclick="addRoutineForAgent(this.dataset.agentId)">Add routine</button>`;
    }
    h+=`</div></div>`;
  }
  // Configuration box. Model and runtime by the direction; connectors sits
  // with them because it is configuration by the same reading, and moves only
  // if the owner says otherwise.
  {
    const row = (label, value) => `<div class="profile-card-item" style="display:flex;align-items:center;justify-content:space-between">${label}${value}</div>`;
    const modelLabels = {opus:'Opus (most capable)',sonnet:'Sonnet (fast, efficient)',haiku:'Haiku (lightweight)'};
    h+=`<div class="profile-card"><div class="profile-card-section"><div class="profile-section-label">Configuration</div>`;
    if(hasConnectors) {
      h+=a.capabilities.connectors.split(',').map(cn=>row(esc(cn.trim()), '<span style="color:var(--success);font-size:var(--caption)">Connected</span>')).join('');
    }
    if(a.model) h+=row('Model', `<span style="color:var(--text-2)">${esc(modelLabels[a.model]||a.model)}</span>`);
    // Runtime is stated for every agent, not just Codex ones, so it reads as
    // a fact about the agent rather than a special mark.
    h+=row('Runtime', `<span style="color:var(--text-2)">${a.runtime === 'codex' ? 'Codex' : 'Claude Code'}</span>`);
    if(a.runtime === 'codex') h+=`<div class="profile-card-text" style="padding-top:8px">${esc(a.displayName)} runs on Codex and uses Codex's built-in sandbox. Claude agents use Rundock's permission prompts.</div>`;
    h+=`</div></div>`;
  }
  // Instructions card (collapsible)
  //
  // Rendered through the shared markdown pipeline rather than dumped as
  // escaped plain text, so the one place instructions were hardest to read
  // reads like the file viewer. Same pipeline, same escaping-at-lex-time
  // safety story; read-only, editing stays where it is. In a shell without
  // the pipeline the text falls back to escaped plain text, which is the
  // safe direction: unrendered, never unescaped.
  if(a.instructions) h+=`<div class="profile-card" style="cursor:pointer" onclick="document.getElementById('agent-instructions').classList.toggle('hidden')">
    <div class="profile-card-section"><div class="profile-section-label">Instructions ▾</div>
    <div id="agent-instructions" class="hidden"><div class="instructions-md">${typeof renderInstructionsMd === 'function' ? renderInstructionsMd(a.instructions) : esc(a.instructions)}</div></div>
    </div></div>`;
  // Existing conversations (rendered last so the page reads as a profile first,
  // conversation index second; preserves the hide-when-empty guard).
  if(existing.length) {
    h+=`<div class="profile-existing"><div class="profile-section-label">Existing conversations</div>`;
    for(const c of existing) {
      const n = c.messageCount ?? c.messages.length;
      h+=`<div class="profile-existing-item" data-convo-id="${escA(c.id)}" onclick="openConversation(this.dataset.convoId)"><span class="profile-existing-title">${esc(c.title)}</span><span class="profile-existing-meta">${n} message${n === 1 ? '' : 's'}</span></div>`;
    }
    h+=`</div>`;
  }
  document.getElementById('profile-content').innerHTML=h;
  showView('profile');
  // Highlight in sidebar
  document.querySelectorAll('.agent-status-item').forEach(el=>el.classList.remove('active'));
  // Matched by reading the attribute back rather than by building a selector
  // out of it. The id is a filename an agent chooses, and a quote in it makes
  // querySelector throw rather than inject, which took the sidebar highlight
  // out with it.
  for (const el of document.querySelectorAll('[data-agent]')) {
    if (el.dataset.agent === agentId) { el.classList.add('active'); break; }
  }
}

return { showProfile };
}));
