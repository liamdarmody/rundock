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
// state until the app boots. Function bodies are byte-identical to the
// app.js originals at column 0.
(/** @param {any} root @param {() => object} factory */ function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    root.RundockProfileView = factory();
    Object.assign(root, root.RundockProfileView);
  }
}(typeof self !== 'undefined' ? self : this, function () {

function showProfile(agentId) {
  const a=agents.find(x=>x.id===agentId);
  // Missing target (a search hit whose agent is absent from the client list,
  // server/client desync): land in the Team section consistently instead of
  // leaving the rail on its previous section with no matching pane.
  if(!a) { switchNav('team'); return; }
  // Agent profiles belong to the Team section (the profile's back link goes
  // there); sync the rail and sidebar for callers arriving from elsewhere,
  // e.g. the search palette or a skill page's agent chips.
  setNavState('team');
  const existing=conversations.filter(c=>c.agentId===agentId||(c.sessionIds||[]).some(s=>s.agentId===agentId));
  let h=`<a class="profile-back" onclick="switchNav('team')">&#8592; Back</a>
    <div class="profile-header">
      <div class="profile-avatar" style="background:${a.colour}">${a.icon}</div>
      <div>
        <div class="profile-name">${a.displayName}</div>
        ${a.role?`<div style="font-size:var(--body);color:var(--text-2)">${a.role}</div>`:''}
      </div>
    </div>`;
  if(a.description) h+=`<p class="profile-desc" style="margin-bottom:24px">${esc(a.description)}</p>`;
  if(a.status === 'raw') {
    h+=`<div class="profile-cta"><button class="profile-cta-btn" onclick="startConversation(getGuide()?.id || 'default')">Setup with Doc</button></div>`;
  } else if(a.status === 'available') {
    h+=`<div class="profile-cta"><button class="profile-cta-btn" onclick="addToTeam('${a.id}')">Add to team</button></div>`;
  } else {
    h+=`<div class="profile-cta"><button class="profile-cta-btn" onclick="startConversation('${a.id}')">New conversation</button></div>`;
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
      h+=`<div class="profile-card-item" style="display:flex;flex-direction:column;gap:2px;cursor:pointer" onclick="switchNav('skills');selectSkill('${s.id}')">
        <span style="font-weight:600">${esc(s.name)}</span>
        ${s.description ? `<span style="font-size:var(--caption);color:var(--text-2)">${esc(s.description)}</span>` : ''}
      </div>`;
    }
    h+=`</div></div>`;
  }
  // Routines + Configuration card. Always rendered: the Runtime row appears
  // for every agent, so the card always has content.
  const hasRoutines = a.routines && a.routines.length;
  const hasConnectors = a.capabilities?.connectors;
  {
    h+=`<div class="profile-card">`;
    if(hasRoutines) {
      h+=`<div class="profile-card-section"><div class="profile-section-label">Routines</div>`;
      for(const r of a.routines) {
        const stateText = r.state ? (r.state.status === 'running' ? '<span style="color:var(--working)">Running now</span>' : `Last run: ${formatTimeAgo(r.state.lastRun)} (${r.state.status})`) : '<span style="color:var(--text-2)">Not yet run</span>';
        h+=`<div class="profile-card-item" style="display:flex;flex-direction:column;gap:3px">
          <span style="font-weight:600">${esc(r.name)}</span>
          <span style="font-size:var(--caption);color:var(--text-2)">${esc(r.schedule)}</span>
          <span style="font-size:var(--caption)">${stateText}</span>
        </div>`;
      }
      h+=`</div>`;
    }
    if(hasConnectors) {
      h+=`<div class="profile-card-section"><div class="profile-section-label">Connectors</div>${a.capabilities.connectors.split(',').map(cn=>`<div class="profile-card-item" style="display:flex;align-items:center;justify-content:space-between">${cn.trim()}<span style="color:var(--success);font-size:var(--caption)">Connected</span></div>`).join('')}</div>`;
    }
    const modelLabels = {opus:'Opus (most capable)',sonnet:'Sonnet (fast, efficient)',haiku:'Haiku (lightweight)'};
    if(a.model) h+=`<div class="profile-card-section"><div class="profile-section-label">Model</div><div class="profile-card-item">${modelLabels[a.model]||a.model}</div></div>`;
    // Runtime is stated for every agent, not just Codex ones, so it reads as
    // a fact about the agent rather than a special mark.
    h+=`<div class="profile-card-section"><div class="profile-section-label">Runtime</div><div class="profile-card-item">${a.runtime === 'codex' ? 'Codex' : 'Claude Code'}</div></div>`;
    if(a.runtime === 'codex') h+=`<div class="profile-card-section"><div class="profile-section-label">Permissions</div><div class="profile-card-text">${esc(a.displayName)} runs on Codex and uses Codex's built-in sandbox. Claude agents use Rundock's permission prompts.</div></div>`;
    h+=`</div>`;
  }
  // Instructions card (collapsible)
  if(a.instructions) h+=`<div class="profile-card" style="cursor:pointer" onclick="document.getElementById('agent-instructions').classList.toggle('hidden')">
    <div class="profile-card-section"><div class="profile-section-label">Instructions ▾</div>
    <div id="agent-instructions" class="hidden"><div style="font-size:var(--caption);line-height:1.6;white-space:pre-wrap;color:var(--text-2);padding-top:8px">${esc(a.instructions)}</div></div>
    </div></div>`;
  // Existing conversations (rendered last so the page reads as a profile first,
  // conversation index second; preserves the hide-when-empty guard).
  if(existing.length) {
    h+=`<div class="profile-existing"><div class="profile-section-label">Existing conversations</div>`;
    for(const c of existing) {
      const n = c.messageCount ?? c.messages.length;
      h+=`<div class="profile-existing-item" onclick="openConversation('${c.id}')"><span class="profile-existing-title">${esc(c.title)}</span><span class="profile-existing-meta">${n} message${n === 1 ? '' : 's'}</span></div>`;
    }
    h+=`</div>`;
  }
  document.getElementById('profile-content').innerHTML=h;
  showView('profile');
  // Highlight in sidebar
  document.querySelectorAll('.agent-status-item').forEach(el=>el.classList.remove('active'));
  document.querySelector(`[data-agent="${agentId}"]`)?.classList.add('active');
}

return { showProfile };
}));
