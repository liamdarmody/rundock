'use strict';
// Team view: agent list/sidebar (app.js section 5) + org chart (section 6),
// extracted verbatim as a Foundations view module. Same UMD pattern as
// markers.js (node-requireable, window-attached); additionally republishes
// each view function on the root object, because classic-script function
// declarations were window properties and the callers rely on that: the WS
// dispatch (renderAgentList, renderOrgChart), routing
// (renderOrgChart on the team nav), message handling (getWorkingAgentIds),
// and the generated onclick handlers (showProfile, addToTeam, orgZoom,
// orgToggleOrientation, startConversation, startSetupConversation).
//
// Shared state stays in app.js and is reached through the global lexical
// environment at call time: agents, conversations, convoState,
// agentLastActivity, workspaceAnalysis, currentWorkspacePath, ws, and
// orgZoomOffset (read by renderOrgChart, written by orgZoom, and reset by
// the debounced resize listener that stays in app.js as top-level window
// wiring), and orgOrientation with its storage key and the persist helper
// (read by renderOrgChart, written by orgToggleOrientation). ORG_PRESETS
// moved here as view-local state: no external touchpoints. d3 is the
// CDN-loaded d3-hierarchy global, resolved on window at call time. Helpers
// reached the same way: getTeamAgents, getPlatformAgents, formatTimeAgo, esc,
// getGuide. Every sentence that names
// the guide comes from RundockGuideCopy, reached the same way, so no view
// carries a guide's name and no copy check has to read four files.
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

// The guide copy, reached off the global at call time, the same way this file
// reaches every other helper it does not own.
function guideLine(key, guideName) {
  const copy = typeof RundockGuideCopy !== 'undefined' ? RundockGuideCopy : null;
  return (copy && copy.guideLine(key, guideName)) || '';
}

// ATTRIBUTE-POSITION ESCAPER, reached off the global at call time the same way
// guideLine above reaches its copy module.
//
// `esc` is already a global here and is right for ELEMENT CONTENT: it
// round-trips through textContent, so it escapes & < > and leaves both quote
// characters alone. That makes it the wrong escaper for an attribute value,
// and an agent id is the agent file's own filename, which an agent can choose.
// `escAttr` in app.js is the one for that position; it had a single caller in
// the entire client before this change. The local equivalent behind it keeps
// this module rendering under node --test, where app.js cannot load.
function escA(value) {
  if (typeof escAttr === 'function') return escAttr(value);
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// A colour is JUDGED, not escaped. public/agent-colour.js carries the reason:
// escaping stops a value ending its style attribute and does nothing about one
// that stays inside it and is still CSS. Fails CLOSED to the fallback when the
// module is absent, because a colour that cannot be checked is one that should
// not be written.
function agentColour(value, fallback) {
  const safe = fallback === undefined ? 'var(--accent)' : fallback;
  return typeof RundockAgentColour !== 'undefined'
    ? RundockAgentColour.safeColour(value, safe) : safe;
}

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
      h += `<div class="agent-status-item" onclick="showProfile(this.dataset.agent)" data-agent="${escA(a.id)}">
        <div class="avatar sm" style="background:${agentColour(a.colour)}">${esc(a.icon)}</div>
        <span class="agent-status-name">${esc(a.displayName)}</span>
        <span class="agent-status-state${workingClass}" data-status="${escA(a.id)}">${statusText}</span>
      </div>`;
    }
  } else if (platform.length) {
    const guide = platform[0];
    h += `<div class="sidebar-empty-state">
      <div class="sidebar-empty-text">${esc(guideLine('sidebar', guide.displayName))}</div>
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
      h += `<div class="agent-status-item" onclick="showProfile(this.dataset.agent)" data-agent="${escA(a.id)}">
        <div class="avatar sm" style="background:${agentColour(a.colour)}">${esc(a.icon)}</div>
        <span class="agent-status-name">${esc(a.displayName)}</span>
        <span class="agent-status-state${workingClass}" data-status="${escA(a.id)}">${statusText}</span>
      </div>`;
    }
  }
  // Available agents
  if (available.length) {
    h += `<div class="sidebar-section-divider" style="cursor:pointer" onclick="document.getElementById('available-agents').classList.toggle('hidden')"><span class="sidebar-label">Available (${available.length}) &#x25BE;</span></div>`;
    h += `<div id="available-agents" class="hidden" style="padding:4px 0">`;
    for (const a of available) {
      const isRaw = a.status === 'raw';
      h += `<div class="agent-status-item" style="${isRaw ? 'opacity:0.6;' : ''}cursor:pointer" data-agent="${escA(a.id)}" onclick="showProfile(this.dataset.agent)">
        <div class="avatar sm" style="background:${agentColour(a.colour)}">${esc(a.icon)}</div>
        <div style="flex:1;min-width:0">
          <span class="agent-status-name">${esc(a.displayName)}</span>
          <span class="agent-status-desc">${esc(a.description ? a.description.substring(0, 50) : (isRaw ? 'Needs setup' : 'Ready to add'))}</span>
        </div>
        ${isRaw
          ? `<button class="agent-action-btn onboard" onclick="event.stopPropagation(); startConversation(getGuide()?.id || 'default')">Setup</button>`
          : `<button class="agent-action-btn add" data-add-agent="${escA(a.id)}" onclick="event.stopPropagation(); addToTeam(this.dataset.addAgent)">Add to team</button>`
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
      `<div data-agent-id="${escA(a.id)}" onclick="startConversation(this.dataset.agentId)" class="convo-agent-card">
        <div class="avatar" style="background:${agentColour(a.colour)}">${esc(a.icon)}</div>
        <span class="convo-agent-card-name">${esc(a.displayName)}</span>
        <span class="convo-agent-card-role">${esc(a.role || '')}</span>
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
      ? `<div class="sidebar-empty-text" style="text-align:center;max-width:280px;margin:0 auto 8px">${esc(guideLine('conversations', guide.displayName))}</div><button class="empty-cta" style="margin-top:4px" onclick="startSetupConversation()">Set up your team</button>`
      : '';
  }
}

function addToTeam(agentId) {
  if (ws) ws.send(JSON.stringify({ type: 'add_to_team', agentId }));
}


// The chart's layout, reached off the global at call time like every other
// shared value. Anything but 'horizontal' reads as vertical.
function orgOrientationNow() {
  return orgOrientation === 'horizontal' ? 'horizontal' : 'vertical';
}

// Card dimension presets at 1:1 scale (before scaling)
const ORG_PRESETS = {
  leader:  { w: 280, h: 108, padV: 30, padH: 44, gap: 16, avatar: 64, icon: 28, name: 28, role: 15 },
  normal:  { w: 220, h: 86,  padV: 16, padH: 20, gap: 12, avatar: 40, icon: 18, name: 15, role: 13 },
  compact: { w: 170, h: 67,  padV: 10, padH: 14, gap: 10, avatar: 28, icon: 12, name: 14, role: 12 },
};

// The platform section's vertical metrics at 1:1 scale. The section is drawn
// from these and the horizontal fit reserves its height from the same values,
// so the two cannot drift apart. labelLine is the browser's default line box
// for 12px type, so the reserve is an estimate that errs a pixel or two high.
const ORG_PLATFORM = { top: 24, topNoTeam: 32, dividerH: 1, dividerGap: 24, labelSize: 12, labelLine: 15, labelGap: 16 };
const orgPlatformHeight = () => ORG_PLATFORM.top + ORG_PLATFORM.dividerH + ORG_PLATFORM.dividerGap
  + ORG_PLATFORM.labelLine + ORG_PLATFORM.labelGap + ORG_PRESETS.normal.h;

// The layout toggle shows the layout it switches TO: a small tree drawn top
// down (one card over two, joined by right-angled lines) or the same tree
// drawn left to right. Same 24-unit grid and 1.8 stroke as the app's icons.
const ORG_ICON_SVG = (d) => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
const ORG_ICON_VERTICAL = ORG_ICON_SVG('M9 3h6v5H9zM3 16h6v5H3zM15 16h6v5h-6zM12 8v4M6 12h12M6 12v4M18 12v4');
const ORG_ICON_HORIZONTAL = ORG_ICON_SVG('M3 9v6h5V9zM16 3v6h5V3zM16 15v6h5v-6zM8 12h4M12 6v12M12 6h4M12 18h4');

// Render a single org card with all dimensions scaled by factor `s`
function orgCardHtml(agent, preset, s, posStyle) {
  const r = (v) => Math.round(v * s);
  const p = ORG_PRESETS[preset];
  const br = Math.round(14 * s);
  const isWorking = getWorkingAgentIds().has(agent.id);
  const dotSize = Math.max(6, r(10));
  const dotClass = isWorking ? 'org-status-dot working' : 'org-status-dot';
  // data-org-agent rather than data-agent: the sidebar's rows already own
  // [data-agent], and the profile highlight looks a row up by that attribute.
  // An org card answering to it too would take the highlight whenever it came
  // first in the document.
  let h = `<div class="org-card ${preset === 'normal' ? '' : preset}" style="${posStyle}width:${r(p.w)}px;height:${r(p.h)}px;padding:${r(p.padV)}px ${r(p.padH)}px;gap:${r(p.gap)}px;border-radius:${br}px" data-org-agent="${escA(agent.id)}" onclick="showProfile(this.dataset.orgAgent)">`;
  h += `<div class="avatar" style="background:${agentColour(agent.colour)};width:${r(p.avatar)}px;height:${r(p.avatar)}px;font-size:${r(p.icon)}px;flex-shrink:0">${esc(agent.icon)}</div>`;
  h += `<div><div class="org-card-name" style="font-size:${r(p.name)}px">${esc(agent.displayName)}</div>`;
  h += `<div class="org-card-role" style="font-size:${r(p.role)}px">${esc(agent.role || '')}</div></div>`;
  h += `<span class="${dotClass}" data-org-status="${escA(agent.id)}" style="width:${dotSize}px;height:${dotSize}px"></span>`;
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
    const horizontal = orgOrientationNow() === 'horizontal';

    // A column is one level of the tree. When several agents have no resolvable
    // parent the hierarchy gets a virtual root above them, which is not drawn,
    // so the first drawn level is one deeper than the root.
    const levelOf = (n) => n.depth - (treeRoot === rootData ? 1 : 0);
    const levelSize = {};
    hierarchy.each(n => {
      if (n.data.id !== '__root__') levelSize[levelOf(n)] = (levelSize[levelOf(n)] || 0) + 1;
    });

    // Horizontal rows are one card height plus a gap. The taller leader card
    // only sets the pitch when it shares a column with other cards.
    const leaderShares = hierarchy.descendants().some(n => n.data.type === 'orchestrator' && levelSize[levelOf(n)] > 1);
    const rowGap = isCompact ? 22 : 30;
    const colGap = isCompact ? 90 : 110;
    const rowStep = (leaderShares ? P.leader.h : P[preset].h) + rowGap;

    // Uniform separation so a lead with one report takes the same width as a
    // childless lead (it centres over its single report); a lead only widens
    // when it has two or more reports, spanning them exactly as the top row
    // spreads its own children. The d3 default (2x between different-parent
    // nodes) doubled the gap between two adjacent leads that each had a report.
    // In horizontal the breadth axis (n.x) runs down the page, one row apart.
    // In vertical, a leader that shares its level with other cards needs room
    // for its wider card beside a compact one, or the two overlap.
    const colStep = leaderShares ? Math.max(nodeW, (P.leader.w + P[preset].w) / 2 + 12) : nodeW;
    d3.tree().nodeSize(horizontal ? [rowStep, 1] : [colStep, nodeH]).separation(() => 1)(hierarchy);

    const cardW = (n) => Math.min(n.data.type === 'orchestrator' ? P.leader.w : P[preset].w, 320);
    const cardH = (n) => n.data.type === 'orchestrator' ? P.leader.h : P[preset].h;

    // Get bounds of d3 node centres
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let maxLevel = 0;
    hierarchy.each(n => {
      if (n.data.id === '__root__') return;
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
      maxLevel = Math.max(maxLevel, levelOf(n));
    });

    // Full-scale tree dimensions (centre-to-edge + padding)
    const pad = 20;
    const halfMaxCard = Math.max(P.leader.w, P[preset].w) / 2;
    let fullW, fullH;
    // Horizontal columns: each is as wide as its widest card, with a gap wide
    // enough for the connector stubs. colCentre[level] is in full-scale units.
    const colCentre = [];
    let halfMaxH = 0;
    if (horizontal) {
      const colW = [];
      hierarchy.each(n => {
        if (n.data.id === '__root__') return;
        colW[levelOf(n)] = Math.max(colW[levelOf(n)] || 0, cardW(n));
        halfMaxH = Math.max(halfMaxH, cardH(n) / 2);
      });
      let left = pad;
      for (let k = 0; k <= maxLevel; k++) {
        colCentre[k] = left + colW[k] / 2;
        left += colW[k] + colGap;
      }
      fullW = left - colGap + pad;
      fullH = (maxX - minX) + halfMaxH * 2 + pad * 2;
    } else {
      fullW = (maxX - minX) + halfMaxCard * 2 + pad * 2;
      fullH = (maxY - minY) + P.leader.h + P[preset].h + pad * 2;
    }

    // Compute scale: auto-fit viewport, then apply user zoom offset. A tall
    // horizontal chart would otherwise fit the viewport and push the platform
    // row below the fold, so its height is reserved in the fit.
    const platformReserve = horizontal && platformAgents.length ? orgPlatformHeight() : 0;
    const chartW = chart.clientWidth - 64;
    const chartH = chart.clientHeight - 64;
    const fitScale = Math.min(chartW / fullW, chartH / (fullH + platformReserve), 1);
    s = Math.max(0.15, Math.min(2, fitScale + orgZoomOffset));

    // Scaled coordinate helpers
    const r = (v) => Math.round(v * s);
    const sx = (x) => Math.round((x - minX + halfMaxCard + pad) * s);
    const sy = (y) => Math.round((y - minY + pad) * s);
    // Horizontal: the card's centre column, and its centre row.
    const colX = (n) => Math.round(colCentre[levelOf(n)] * s);
    const rowY = (n) => Math.round((n.x - minX + halfMaxH + pad) * s);
    const totalW = r(fullW);
    const totalH = r(fullH);

    h += `<div class="org-layout" style="width:${totalW}px;height:${totalH}px">`;
    h += `<svg class="org-connectors" width="${totalW}" height="${totalH}"><g>`;

    // Right-angled trunk-bar-drop connectors, one group per parent. Vertical:
    // a trunk down from the parent's bottom edge, a bar across its reports,
    // and a drop into each report's top edge. Horizontal mirrors it: a stub out
    // of the parent's right edge, a bar down its reports, and a stub into each
    // report's left edge. The links from the virtual root are not drawn.
    const parentGroups = new Map();
    hierarchy.each(n => {
      if (n.data.id === '__root__' || !n.parent || n.parent.data.id === '__root__') return;
      const pid = n.parent.data.id;
      if (!parentGroups.has(pid)) parentGroups.set(pid, { parent: n.parent, children: [] });
      parentGroups.get(pid).children.push(n);
    });

    parentGroups.forEach(({ parent: p, children: kids }) => {
      if (kids.length === 0) return;
      if (horizontal) {
        const srcRight = colX(p) + Math.round(r(cardW(p)) / 2);
        const py = rowY(p);
        const tx = Math.min(...kids.map(c => colX(c) - Math.round(r(cardW(c)) / 2)));
        const midX = srcRight + Math.round((tx - srcRight) / 2);
        h += `<path d="M${srcRight},${py} L${midX},${py}"/>`;
        const childYs = kids.map(c => rowY(c));
        if (kids.length > 1) {
          h += `<path d="M${midX},${Math.min(...childYs)} L${midX},${Math.max(...childYs)}"/>`;
        }
        kids.forEach(c => {
          h += `<path d="M${midX},${rowY(c)} L${colX(c) - Math.round(r(cardW(c)) / 2)},${rowY(c)}"/>`;
        });
      } else {
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
      }
    });

    h += '</g></svg>';

    // Place cards at computed positions
    hierarchy.each(n => {
      if (n.data.id === '__root__') return;
      const isLeader = n.data.type === 'orchestrator';
      const p = isLeader ? 'leader' : preset;
      const pos = horizontal
        ? `left:${colX(n)}px;top:${Math.round(rowY(n) - r(cardH(n)) / 2)}px;`
        : `left:${sx(n.x)}px;top:${sy(n.y)}px;`;
      h += orgCardHtml(n.data, p, s, pos);
    });

    h += '</div>'; // close .org-layout

    // Set scroll/centering after DOM update
    requestAnimationFrame(() => {
      const overflowX = fullW * s > chartW;
      const overflowY = (fullH + platformReserve) * s > chartH;
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
      // The one sentence of the four that draws whether or not a guide exists,
      // so it is the one that needs a line for a workspace with none. It kept
      // promising a guide either way, which is the defect in its loudest form.
      h += `<div class="sidebar-empty-text" style="text-align:center;max-width:320px">${esc(guideLine('fresh', guide && guide.displayName))}</div>`;
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
    h += `<div class="org-platform-section" style="margin-top:${r(hasTeam ? ORG_PLATFORM.top : ORG_PLATFORM.topNoTeam)}px">`;
    h += `<div class="org-platform-divider" style="max-width:${r(200)}px;margin-bottom:${r(ORG_PLATFORM.dividerGap)}px"></div>`;
    h += `<div class="org-platform-label" style="font-size:${r(ORG_PLATFORM.labelSize)}px;margin-bottom:${r(ORG_PLATFORM.labelGap)}px">Rundock Agents</div>`;
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
    // No pressed state: the button shows the layout it switches to. The
    // tooltip stays "Switch layout"; the accessible name names the target and
    // changes with the layout.
    const isHorizontal = orgOrientationNow() === 'horizontal';
    const orientLabel = isHorizontal ? 'Switch to top-down layout' : 'Switch to left-to-right layout';
    h += '<div class="org-zoom-divider"></div>';
    h += `<button class="org-orient" onclick="orgToggleOrientation()" aria-label="${orientLabel}" title="Switch layout">${isHorizontal ? ORG_ICON_VERTICAL : ORG_ICON_HORIZONTAL}</button>`;
    h += '</div>';
  }

  chart.innerHTML = h;
}

function orgZoom(dir) {
  orgZoomOffset += dir * 0.1;
  renderOrgChart();
}

// Pivot the chart 90 degrees. The fit is recomputed for the new shape, so any
// zoom applied to the old one is dropped. The chart is redrawn from scratch,
// which discards the focused button, so focus goes back to it for keyboard use.
// The new layout fades in briefly; zoom and other redraws do not.
function orgToggleOrientation() {
  orgOrientation = orgOrientationNow() === 'horizontal' ? 'vertical' : 'horizontal';
  persist.set(ORG_ORIENTATION_KEY, orgOrientation);
  orgZoomOffset = 0;
  renderOrgChart();
  const tree = document.querySelector('#org-chart .org-tree');
  if (tree) tree.classList.add('org-tree-switched');
  const btn = document.querySelector('.org-zoom .org-orient');
  if (btn) btn.focus();
}

return { getWorkingAgentIds, renderAgentList, renderConvoEmptyAgents, addToTeam, orgCardHtml, renderOrgChart, orgZoom, orgToggleOrientation };
}));
