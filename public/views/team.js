'use strict';
// Team view: agent list/sidebar (app.js section 5) + org chart (section 6),
// extracted verbatim as a Foundations view module. Same UMD pattern as
// markers.js (node-requireable, window-attached); additionally republishes
// each view function on the root object, because classic-script function
// declarations were window properties and the callers rely on that: the WS
// dispatch (renderAgentList, renderOrgChart, renderRoutinesSidebar), routing
// (renderOrgChart on the team nav), message handling (getWorkingAgentIds),
// and the generated onclick handlers (showProfile, addToTeam, orgZoom,
// startConversation, startSetupConversation).
//
// Shared state stays in app.js and is reached through the global lexical
// environment at call time: agents, conversations, convoState,
// agentLastActivity, workspaceAnalysis, currentWorkspacePath, ws, and
// orgZoomOffset (read by renderOrgChart, written by orgZoom, and reset by
// the debounced resize listener that stays in app.js as top-level window
// wiring). ORG_PRESETS moved here as view-local state: no external
// touchpoints. d3 is the CDN-loaded d3-hierarchy global, resolved on window
// at call time. Helpers reached the same way: getTeamAgents,
// getPlatformAgents, formatTimeAgo, formatScheduleShort, esc, getGuide.
// Load order (views before app.js) is safe because nothing here touches
// shared state until the app boots. Function bodies are byte-identical to
// the app.js originals at column 0.
(/** @param {any} root @param {() => object} factory */ function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    root.RundockTeamView = factory();
    Object.assign(root, root.RundockTeamView);
  }
}(typeof self !== 'undefined' ? self : this, function () {

function getWorkingAgentIds() {
  const working = new Set();
  for (const [convoId, state] of Object.entries(convoState||{})) {
    if (state.isProcessing) {
      const activeId = state.activeAgentId || conversations.find(c=>c.id===convoId)?.agentId;
      if (activeId) working.add(activeId);
    }
  }
  return working;
}
function renderAgentList() {
  const onTeam = getTeamAgents();
  const platform = getPlatformAgents();
  const available = agents.filter(a => a.status === 'available' || a.status === 'raw');
  const workingIds = getWorkingAgentIds();

  let h = '';
  // On team agents (or empty state)
  if (onTeam.length) {
    for (const a of onTeam) {
      const isWorking = workingIds.has(a.id);
      const last = agentLastActivity[a.id];
      const statusText = isWorking ? 'working' : (last ? formatTimeAgo(last.time) : 'idle');
      const workingClass = isWorking ? ' working' : '';
      h += `<div class="agent-status-item" onclick="showProfile('${a.id}')" data-agent="${a.id}">
        <div class="avatar sm" style="background:${a.colour}">${a.icon}</div>
        <span class="agent-status-name">${a.displayName}</span>
        <span class="agent-status-state${workingClass}" data-status="${a.id}">${statusText}</span>
      </div>`;
    }
  } else if (platform.length) {
    const guide = platform[0];
    h += `<div class="sidebar-empty-state">
      <div class="sidebar-empty-text">No team agents yet. Doc can explore this workspace and create a team for you.</div>
      <button class="empty-cta" style="width:100%" onclick="startSetupConversation()">Set up your team</button>
    </div>`;
  }
  // Platform agents
  if (platform.length) {
    h += `<div class="sidebar-section-divider"><span class="sidebar-label">Rundock Agents</span></div>`;
    for (const a of platform) {
      const isWorking = workingIds.has(a.id);
      const last = agentLastActivity[a.id];
      const statusText = isWorking ? 'working' : (last ? formatTimeAgo(last.time) : 'idle');
      const workingClass = isWorking ? ' working' : '';
      h += `<div class="agent-status-item" onclick="showProfile('${a.id}')" data-agent="${a.id}">
        <div class="avatar sm" style="background:${a.colour}">${a.icon}</div>
        <span class="agent-status-name">${a.displayName}</span>
        <span class="agent-status-state${workingClass}" data-status="${a.id}">${statusText}</span>
      </div>`;
    }
  }
  // Available agents
  if (available.length) {
    h += `<div class="sidebar-section-divider" style="cursor:pointer" onclick="document.getElementById('available-agents').classList.toggle('hidden')"><span class="sidebar-label">Available (${available.length}) &#x25BE;</span></div>`;
    h += `<div id="available-agents" class="hidden" style="padding:4px 0">`;
    for (const a of available) {
      const isRaw = a.status === 'raw';
      h += `<div class="agent-status-item" style="${isRaw ? 'opacity:0.6;' : ''}cursor:pointer" onclick="showProfile('${a.id}')">
        <div class="avatar sm" style="background:${a.colour}">${a.icon}</div>
        <div style="flex:1;min-width:0">
          <span class="agent-status-name">${a.displayName}</span>
          <span class="agent-status-desc">${a.description ? a.description.substring(0, 50) : (isRaw ? 'Needs setup' : 'Ready to add')}</span>
        </div>
        ${isRaw
          ? `<button class="agent-action-btn onboard" onclick="event.stopPropagation(); startConversation(getGuide()?.id || 'default')">Setup</button>`
          : `<button class="agent-action-btn add" onclick="event.stopPropagation(); addToTeam('${a.id}')">Add to team</button>`
        }
      </div>`;
    }
    h += `</div>`;
  }
  document.getElementById('agent-list').innerHTML = h;
  // Hide "Your Team" header when only platform agents exist
  const teamHeader = document.getElementById('sidebar-team-header');
  if (teamHeader) teamHeader.style.display = onTeam.length ? '' : 'none';
  renderOrgChart();
  renderConvoEmptyAgents();
}

function renderConvoEmptyAgents() {
  const labelEl = document.getElementById('convo-empty-label');
  const contentEl = document.getElementById('convo-empty-content');
  if (!contentEl) return;

  const teamAgents = getTeamAgents();
  const platformAgents = getPlatformAgents();

  if (teamAgents.length) {
    // Populated workspace: show agent cards
    if (labelEl) { labelEl.textContent = 'Start a conversation'; labelEl.className = 'empty-subtitle'; }

    const agentCard = a =>
      `<div onclick="startConversation('${a.id}')" class="convo-agent-card">
        <div class="avatar" style="background:${a.colour}">${a.icon}</div>
        <span class="convo-agent-card-name">${a.displayName}</span>
        <span class="convo-agent-card-role">${a.role}</span>
      </div>`;

    let h = `<div class="convo-agent-grid">${teamAgents.map(agentCard).join('')}</div>`;
    if (platformAgents.length) {
      h += `<div class="convo-agent-divider"></div>`;
      h += `<div class="convo-agent-grid">${platformAgents.map(agentCard).join('')}</div>`;
    }
    contentEl.className = 'convo-agent-layout';
    contentEl.innerHTML = h;
  } else {
    // Empty workspace: show Doc CTA
    if (labelEl) { labelEl.textContent = 'No team agents yet'; labelEl.className = 'empty-title'; }
    const guide = platformAgents[0];
    contentEl.className = '';
    contentEl.innerHTML = guide
      ? `<div class="sidebar-empty-text" style="text-align:center;max-width:280px;margin:0 auto 8px">Doc can explore this workspace and set up your agent team.</div><button class="empty-cta" style="margin-top:4px" onclick="startSetupConversation()">Set up your team</button>`
      : '';
  }
}

function renderRoutinesSidebar() {
  const container = document.getElementById('sidebar-routines');
  if (!container) return;
  const allRoutines = [];
  for (const a of agents) {
    if (a.routines) {
      for (const r of a.routines) {
        allRoutines.push({ ...r, agentName: a.displayName, agentColour: a.colour, agentIcon: a.icon });
      }
    }
  }
  if (allRoutines.length === 0) { container.innerHTML = ''; return; }

  // The agent-agnostic way in: no agent chosen yet, so the picker spans every
  // agent's skills and each row names which agent runs it.
  let h = '<div class="sidebar-section-divider" style="margin:12px 16px 0;padding-top:16px">'
    + '<span class="sidebar-label">Routines</span>'
    + '<button class="re-link" type="button" style="float:right"'
    + ' data-sidebar-action="add-routine" onclick="addRoutine()">Add</button>'
    + '</div>';
  h += '<div style="padding:8px 8px 16px">';
  for (const r of allRoutines) {
    const statusText = r.state?.status === 'running'
      ? '<span style="color:var(--working)">Running...</span>'
      : `<span style="color:var(--text-2)">${formatScheduleShort(r.schedule)}</span>`;
    h += `<div class="routine-item">
      <div class="avatar xxs" style="background:${r.agentColour}">${r.agentIcon}</div>
      <span class="routine-name">${esc(r.name)}</span>
      ${statusText}
    </div>`;
  }
  h += '</div>';
  container.innerHTML = h;
}

function addToTeam(agentId) {
  if (ws) ws.send(JSON.stringify({ type: 'add_to_team', agentId }));
}


// Card dimension presets at 1:1 scale (before scaling)
const ORG_PRESETS = {
  leader:  { w: 280, h: 108, padV: 30, padH: 44, gap: 16, avatar: 64, icon: 28, name: 28, role: 15 },
  normal:  { w: 220, h: 86,  padV: 16, padH: 20, gap: 12, avatar: 40, icon: 18, name: 15, role: 13 },
  compact: { w: 170, h: 67,  padV: 10, padH: 14, gap: 10, avatar: 28, icon: 12, name: 14, role: 12 },
};

// Render a single org card with all dimensions scaled by factor `s`
function orgCardHtml(agent, preset, s, posStyle) {
  const r = (v) => Math.round(v * s);
  const p = ORG_PRESETS[preset];
  const br = Math.round(14 * s);
  const isWorking = getWorkingAgentIds().has(agent.id);
  const dotSize = Math.max(6, r(10));
  const dotClass = isWorking ? 'org-status-dot working' : 'org-status-dot';
  let h = `<div class="org-card ${preset === 'normal' ? '' : preset}" style="${posStyle}width:${r(p.w)}px;height:${r(p.h)}px;padding:${r(p.padV)}px ${r(p.padH)}px;gap:${r(p.gap)}px;border-radius:${br}px" onclick="showProfile('${agent.id}')">`;
  h += `<div class="avatar" style="background:${agent.colour};width:${r(p.avatar)}px;height:${r(p.avatar)}px;font-size:${r(p.icon)}px;flex-shrink:0">${agent.icon}</div>`;
  h += `<div><div class="org-card-name" style="font-size:${r(p.name)}px">${agent.displayName}</div>`;
  h += `<div class="org-card-role" style="font-size:${r(p.role)}px">${agent.role || ''}</div></div>`;
  h += `<span class="${dotClass}" data-org-status="${agent.id}" style="width:${dotSize}px;height:${dotSize}px"></span>`;
  h += `</div>`;
  return h;
}

function renderOrgChart() {
  const orchestrator = agents.find(a => a.status === 'onTeam' && a.type === 'orchestrator');
  const specialists = agents.filter(a => a.status === 'onTeam' && a.type === 'specialist');
  const platformAgents = getPlatformAgents();
  const untyped = agents.filter(a => a.status === 'onTeam' && !a.type);
  const leader = orchestrator || agents.find(a => a.isDefault && a.type) || null;
  const team = specialists.length ? specialists : untyped.filter(a => a !== leader);
  const hasTeam = leader || team.length;

  const chart = document.getElementById('org-chart');
  if (!chart) return;

  // Defer rendering until chart has layout dimensions (e.g. view not yet visible).
  // goHome() calls renderOrgChart() again when the view becomes active.
  if (hasTeam && chart.clientWidth === 0) return;

  // Scale factor: set by tree layout when hasTeam, used by platform section too
  let s = 1;
  let h = '<div class="org-tree">';

  if (hasTeam) {
    // Build tree data: each agent has a parent (reportsTo field, or defaults to orchestrator)
    const allTeam = [];
    if (leader) allTeam.push({ ...leader, _orgParent: null });
    team.forEach(a => {
      const parentId = a.reportsTo || (leader ? leader.id : null);
      allTeam.push({ ...a, _orgParent: parentId });
    });

    // Build d3 hierarchy
    // nodeMap is keyed by both id and name so reportsTo can match either
    const rootData = { id: '__root__', children: [] };
    const nodeMap = new Map();
    allTeam.forEach(a => {
      const node = { ...a, children: [] };
      nodeMap.set(a.id, node);
      if (a.name && a.name !== a.id) nodeMap.set(a.name, node);
    });
    allTeam.forEach(a => {
      if (a._orgParent && nodeMap.has(a._orgParent)) {
        nodeMap.get(a._orgParent).children.push(nodeMap.get(a.id));
      } else {
        // No parent, OR a reportsTo that doesn't resolve to a team member
        // (a typo, or reporting to a platform agent like Doc): attach at
        // the root. An on-team agent must always be visible in the chart;
        // silently dropping it made the chart lay out an empty tree at a
        // degenerate zoom when such an agent was the whole team.
        rootData.children.push(nodeMap.get(a.id));
      }
    });

    const treeRoot = rootData.children.length === 1 ? rootData.children[0] : rootData;
    const isCompact = team.length > 10;
    const preset = isCompact ? 'compact' : 'normal';
    const P = ORG_PRESETS;

    // d3 layout at full scale (1:1 spacing)
    const nodeW = isCompact ? 220 : 280;
    const nodeH = isCompact ? 160 : 190;
    const hierarchy = d3.hierarchy(treeRoot);
    // Uniform separation so a lead with one report takes the same width as a
    // childless lead (it centres over its single report); a lead only widens
    // when it has two or more reports, spanning them exactly as the top row
    // spreads its own children. The d3 default (2x between different-parent
    // nodes) doubled the gap between two adjacent leads that each had a report.
    d3.tree().nodeSize([nodeW, nodeH]).separation(() => 1)(hierarchy);

    const cardW = (n) => Math.min(n.data.type === 'orchestrator' ? P.leader.w : P[preset].w, 320);
    const cardH = (n) => n.data.type === 'orchestrator' ? P.leader.h : P[preset].h;

    // Get bounds of d3 node centres
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    hierarchy.each(n => {
      if (n.data.id === '__root__') return;
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
    });

    // Full-scale tree dimensions (centre-to-edge + padding)
    const pad = 20;
    const halfMaxCard = Math.max(P.leader.w, P[preset].w) / 2;
    const fullW = (maxX - minX) + halfMaxCard * 2 + pad * 2;
    const fullH = (maxY - minY) + P.leader.h + P[preset].h + pad * 2;

    // Compute scale: auto-fit viewport, then apply user zoom offset
    const chartW = chart.clientWidth - 64;
    const chartH = chart.clientHeight - 64;
    const fitScale = Math.min(chartW / fullW, chartH / fullH, 1);
    s = Math.max(0.15, Math.min(2, fitScale + orgZoomOffset));

    // Scaled coordinate helpers
    const r = (v) => Math.round(v * s);
    const sx = (x) => Math.round((x - minX + halfMaxCard + pad) * s);
    const sy = (y) => Math.round((y - minY + pad) * s);
    const totalW = r(fullW);
    const totalH = r(fullH);

    h += `<div class="org-layout" style="width:${totalW}px;height:${totalH}px">`;
    h += `<svg class="org-connectors" width="${totalW}" height="${totalH}"><g>`;

    // Build parent-children groups for connectors
    const parentGroups = new Map();
    hierarchy.each(n => {
      if (n.data.id === '__root__' || !n.parent || n.parent.data.id === '__root__') return;
      const pid = n.parent.data.id;
      if (!parentGroups.has(pid)) parentGroups.set(pid, { parent: n.parent, children: [] });
      parentGroups.get(pid).children.push(n);
    });
    hierarchy.each(n => {
      if (n.parent && n.parent.data.id !== '__root__') return;
      if (!n.children || n.data.id === '__root__') return;
      const pid = n.data.id;
      if (!parentGroups.has(pid)) parentGroups.set(pid, { parent: n, children: [] });
      n.children.forEach(c => {
        if (c.data.id !== '__root__') parentGroups.get(pid).children.push(c);
      });
    });

    parentGroups.forEach(({ parent: p, children: kids }) => {
      if (kids.length === 0) return;
      const px = sx(p.x);
      const srcBottom = sy(p.y) + r(cardH(p));
      const ty = sy(kids[0].y);
      const midY = srcBottom + Math.round((ty - srcBottom) / 2);

      h += `<path d="M${px},${srcBottom} L${px},${midY}"/>`;
      const childXs = kids.map(c => sx(c.x));
      if (kids.length > 1) {
        h += `<path d="M${Math.min(...childXs)},${midY} L${Math.max(...childXs)},${midY}"/>`;
      }
      kids.forEach(c => {
        h += `<path d="M${sx(c.x)},${midY} L${sx(c.x)},${sy(c.y)}"/>`;
      });
    });

    h += '</g></svg>';

    // Place cards at computed positions
    hierarchy.each(n => {
      if (n.data.id === '__root__') return;
      const isLeader = n.data.type === 'orchestrator';
      const p = isLeader ? 'leader' : preset;
      h += orgCardHtml(n.data, p, s, `left:${sx(n.x)}px;top:${sy(n.y)}px;`);
    });

    h += '</div>'; // close .org-layout

    // Set scroll/centering after DOM update
    requestAnimationFrame(() => {
      const overflowX = fullW * s > chartW;
      const overflowY = fullH * s > chartH;
      chart.style.overflowX = overflowX ? 'auto' : 'hidden';
      chart.style.overflowY = overflowY ? 'auto' : 'hidden';
      chart.style.justifyContent = overflowY ? 'flex-start' : 'center';
      chart.style.alignItems = overflowX ? 'flex-start' : 'center';
      if (overflowX) chart.scrollLeft = Math.max(0, (totalW - chart.clientWidth) / 2);
      if (overflowY) chart.scrollTop = Math.max(0, (totalH - chart.clientHeight) / 2);
    });

  } else {
    const guide = platformAgents[0];
    const a = workspaceAnalysis;
    const hasContext = a && (a.identity.sources.length > 0 || a.skills.total > 0);

    if (hasContext && a) {
      h += '<div class="org-empty-state">';
      // Identity: show workspace name from analysis, fall back to folder name
      const identityName = a.identity.suggestedName || currentWorkspacePath?.split('/').pop() || 'Your Workspace';
      const tagline = a.identity.suggestedTagline || a.identity.suggestedRole || 'Ready to set up your team';
      h += `<div class="empty-title" style="font-size:var(--heading)">${esc(identityName)}</div>`;
      h += `<div style="color:var(--text-2);font-size:var(--body);margin-bottom:12px">${esc(tagline)}</div>`;
      // Stats line
      const stats = [];
      if (a.skills.total > 0) stats.push(`${a.skills.total} skill${a.skills.total !== 1 ? 's' : ''}`);
      if (a.structure.pattern !== 'unknown') {
        const acronyms = new Set(['para']);
        const patternLabel = a.structure.pattern.split('-').map(w => acronyms.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        stats.push(patternLabel);
      }
      const integrationCount = a.integrations.mcpReferences.length + a.integrations.configuredServers.length + a.integrations.mentionedTools.length;
      if (integrationCount > 0) stats.push(`${integrationCount} integration${integrationCount !== 1 ? 's' : ''}`);
      if (stats.length) h += `<div style="color:var(--text-2);font-size:var(--caption);margin-bottom:16px">${stats.join(' &middot; ')}</div>`;
      if (guide) {
        h += `<button class="empty-cta" style="margin-top:12px" onclick="startSetupConversation()">Set up your team</button>`;
      }
      h += '</div>';
    } else {
      h += '<div class="org-empty-state">';
      h += '<div class="empty-title">Welcome to Rundock</div>';
      h += '<div class="sidebar-empty-text" style="text-align:center;max-width:320px">Fresh workspace. Doc can help you set up your agent team from scratch.</div>';
      if (guide) {
        h += `<button class="empty-cta" style="margin-top:4px" onclick="startSetupConversation()">Set up your team</button>`;
      }
      h += '</div>';
    }
    chart.style.overflow = 'hidden';
    chart.style.justifyContent = 'center';
    chart.style.alignItems = 'center';
  }

  // Platform section: scaled to match specialist cards
  if (platformAgents.length) {
    const r = (v) => Math.round(v * s);
    h += `<div class="org-platform-section" style="margin-top:${r(hasTeam ? 24 : 32)}px">`;
    h += `<div class="org-platform-divider" style="max-width:${r(200)}px;margin-bottom:${r(24)}px"></div>`;
    h += `<div class="org-platform-label" style="font-size:${r(12)}px;margin-bottom:${r(16)}px">Rundock Agents</div>`;
    h += `<div style="display:flex;justify-content:center;gap:${r(12)}px">`;
    for (const a of platformAgents) {
      h += orgCardHtml(a, 'normal', s, '');
    }
    h += '</div></div>';
  }

  h += '</div>'; // close .org-tree

  // Zoom controls (only when there's a team to zoom)
  if (hasTeam) {
    h += '<div class="org-zoom">';
    h += '<button onclick="orgZoom(1)" title="Zoom in">+</button>';
    h += '<div class="org-zoom-divider"></div>';
    h += '<button onclick="orgZoom(-1)" title="Zoom out">&minus;</button>';
    h += '</div>';
  }

  chart.innerHTML = h;
}

function orgZoom(dir) {
  orgZoomOffset += dir * 0.1;
  renderOrgChart();
}

return { getWorkingAgentIds, renderAgentList, renderConvoEmptyAgents, renderRoutinesSidebar, addToTeam, orgCardHtml, renderOrgChart, orgZoom };
}));
