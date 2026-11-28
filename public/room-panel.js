'use strict';
// The panel under a lead's message while its teammates and helpers work, one
// per batch: a title saying who started what, a line saying how fast the
// plan's allowance goes, and a row for each with who it is, its task, what it
// is doing now and Stop. And the note under the composer while only helpers
// work. Same UMD pattern as markers.js: a classic script in the browser,
// required in Node.
//
// Everything a helper or agent wrote (a task, a step, a file name, a nickname,
// a role) is drawn with textContent, never markup. A finished row's file is a
// link only while treePathOf finds it in the workspace's tree, asked again at
// click time, and it opens through openWorkspaceFilePath.
//
// Reached at call time: activeConversation, agents, getConvoState, ws,
// treePathOf, openWorkspaceFilePath, RundockRoomWords and RundockChatMarkup.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RundockRoomPanel = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  const SVG_NS = 'http://www.w3.org/2000/svg';
  // Conversation id to { lead, batches }: each batch's rows, its most at
  // once, whoever else ran beside it, and its panel once drawn.
  const rooms = new Map();

  const words = () => RundockRoomWords;
  const unfinished = (row) => !row.capped && (row.state === 'running' || row.state === 'waiting');
  const agentOf = (id) => (typeof agents !== 'undefined' ? agents : []).find((a) => a && a.id === id) || null;
  const nameOf = (id) => (agentOf(id) ? agentOf(id).displayName : String(id || ''));
  const member = (row) => ({ name: row.kind === 'teammate' ? nameOf(row.agent) : null });
  const send = (msg) => { if (typeof ws !== 'undefined' && ws) ws.send(JSON.stringify(msg)); };
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(className, text, onclick) {
    const b = el('button', className, text);
    b.type = 'button';
    b.onclick = onclick;
    return b;
  }

  // The helper icon: a bolt drawn as a stroked path, for every helper outside the team.
  function bolt() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    const attributes = { class: 'room-bolt', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8',
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' };
    for (const [key, value] of Object.entries(attributes)) svg.setAttribute(key, value);
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M13 2 3 14h9l-1 8 10-12h-9l1-8z');
    svg.appendChild(path);
    return svg;
  }

  // A teammate's avatar, its glyph drawn by CSS from data-icon.
  function avatar(id) {
    const agent = agentOf(id) || {};
    const span = el('span', 'avatar xs');
    span.style.background = RundockChatMarkup.safeColour(agent.colour);
    span.setAttribute('aria-hidden', 'true');
    span.setAttribute('data-icon', String(agent.icon || '?'));
    return span;
  }

  // A helpers_changed, or a reloaded row of active_processes. Each batch it
  // carries takes its rows and its most at once, which never goes down; a
  // batch it leaves out keeps what it had.
  function changed(convoId, msg) {
    const room = rooms.get(convoId) || { lead: null, batches: new Map() };
    rooms.set(convoId, room);
    if (msg.agentId) room.lead = msg.agentId;
    const rows = Array.isArray(msg.helpers) ? msg.helpers : [];
    const groups = new Map();
    for (const row of rows) groups.set(row.batch || row.toolUseId, (groups.get(row.batch || row.toolUseId) || []).concat(row));
    for (const [key, list] of groups) {
      const batch = room.batches.get(key) || { rows: [], most: 0, others: new Map(), el: null };
      batch.rows = list;
      batch.most = Math.max(batch.most, Number(msg.most && msg.most[key]) || 0);
      // Whoever else runs while this batch runs, named by a batch of one.
      if (list.some((r) => r.state === 'running')) {
        for (const r of rows) if (!list.includes(r) && r.state === 'running') batch.others.set(r.toolUseId, r);
      }
      room.batches.set(key, batch);
    }
    draw(convoId);
  }

  // Each batch's panel in the conversation on screen, put in place the first
  // time and filled again each time; then the note under the composer.
  function draw(convoId) {
    const room = rooms.get(convoId);
    const messages = document.getElementById('messages');
    if (room && messages && typeof activeConversation !== 'undefined' && activeConversation && activeConversation.id === convoId) {
      for (const [key, batch] of room.batches) {
        if (!batch.el || !batch.el.isConnected) batch.el = place(convoId, messages, key);
        fill(convoId, room, batch);
      }
    }
    note(convoId);
  }

  // Directly after the lead's message in the thread as the batch's first row
  // arrives, the streaming message or else the last agent message, and after
  // any panel already there. It keeps that place as later messages arrive.
  function place(convoId, messages, key) {
    const panel = el('div', 'room-panel');
    panel.setAttribute('data-batch', key);
    const streaming = getConvoState(convoId).currentStreamingMsg;
    let at = streaming && streaming.parentNode === messages ? streaming
      : [...messages.children].filter((n) => n.matches('.msg.msg-agent') && n.id !== 'thinking-indicator').pop();
    while (at && at.nextElementSibling && at.nextElementSibling.classList.contains('room-panel')) at = at.nextElementSibling;
    if (at) at.after(panel);
    else messages.appendChild(panel);
    const head = el('div', 'room-head');
    head.append(el('span', 'room-title'));
    const rows = el('div', 'room-rows');
    rows.setAttribute('aria-live', 'polite');
    panel.append(head, el('div', 'room-rate'), el('div', 'room-notice'), rows);
    return panel;
  }

  function fill(convoId, room, batch) {
    const W = words();
    const lead = nameOf(room.lead);
    const { rows, el: panel } = batch;
    const head = panel.querySelector('.room-head');
    setText(head.querySelector('.room-title'), W.title(lead, rows.filter((r) => r.kind === 'teammate').map((r) => nameOf(r.agent)), rows.filter((r) => r.kind !== 'teammate').length));
    const stopAll = head.querySelector('.room-stop-all');
    if (rows.some(unfinished) && !stopAll) head.append(button('room-stop-all', 'Stop all', () => send({ type: 'cancel', conversationId: convoId })));
    if (!rows.some(unfinished) && stopAll) stopAll.remove();
    const others = W.names(lead, [...batch.others.values()].map(member));
    setText(panel.querySelector('.room-rate'), W.rateLine(lead, rows.filter((r) => !r.capped).map(member), batch.most + 1, others));
    const notice = panel.querySelector('.room-notice');
    setText(notice, rows.some((r) => r.firstBatch) ? W.codexNotice(lead, rows.length) : '');
    notice.hidden = !notice.textContent;
    // A row is drawn again only when something in it changed, so a step that
    // changes is read once.
    const box = panel.querySelector('.room-rows');
    const labels = labelsOf(rows);
    const old = [...box.children];
    rows.forEach((row, i) => {
      const drawn = rowEl(convoId, row, labels[i]);
      if (old[i] && old[i].outerHTML === drawn.outerHTML) return;
      if (old[i]) old[i].replaceWith(drawn);
      else box.append(drawn);
    });
    for (const extra of old.slice(rows.length)) extra.remove();
  }

  // Who each row is: a teammate by name, a Codex helper by its nickname, any
  // other helper by its label, a repeated label taking its number.
  function labelsOf(rows) {
    const W = words();
    const labels = W.numbered(rows.filter((r) => r.kind === 'builtin').map((r) => W.helperLabel(r.agent)));
    return rows.map((r) => (r.kind === 'teammate' ? nameOf(r.agent) : r.kind === 'builtin' ? labels.shift() : String(r.agent || '')));
  }

  function rowEl(convoId, row, label) {
    const box = el('div', 'room-row');
    box.setAttribute('data-state', row.capped ? 'capped' : String(row.state));
    const who = el('span', 'room-who');
    who.append(row.kind === 'teammate' ? avatar(row.agent) : bolt(), el('span', 'room-name', label));
    if (row.kind === 'codex' && row.role) who.append(el('span', 'room-role', String(row.role)));
    box.append(who);
    if (row.kind !== 'codex') box.append(el('div', 'room-task', String(row.task || '')));
    box.append(stateEl(row));
    if (unfinished(row)) {
      const stop = button('room-stop', 'Stop', () => send({ type: 'stop_helper', conversationId: convoId, toolUseId: row.toolUseId }));
      stop.setAttribute('aria-label', words().stopLabel(label));
      box.append(stop);
    }
    return box;
  }

  // "Done: <name>", the name a link while the tree has the file.
  function stateEl(row) {
    const W = words();
    const state = el('div', 'room-state', W.stateWords(row));
    if (row.state !== 'completed' || !row.file || row.capped) return state;
    const name = W.fileName(row.file);
    state.textContent = 'Done: ';
    if (typeof treePathOf !== 'function' || !treePathOf(row.file)) {
      state.append(name);
      return state;
    }
    const link = button('room-file', name, () => {
      const found = treePathOf(row.file);
      if (found && typeof openWorkspaceFilePath === 'function') openWorkspaceFilePath(found);
    });
    state.append(link);
    return state;
  }

  // While a row runs and the lead isn't replying, who still works and where a
  // message goes.
  function note(convoId) {
    if (typeof activeConversation === 'undefined' || !activeConversation || activeConversation.id !== convoId) return;
    const after = document.getElementById('composer-notice');
    let box = document.getElementById('helpers-note');
    if (!box && after) {
      box = el('div', 'helpers-note');
      box.id = 'helpers-note';
      box.setAttribute('aria-live', 'polite');
      after.after(box);
    }
    if (!box) return;
    const room = rooms.get(convoId);
    const state = getConvoState(convoId);
    const running = room && !state.isProcessing ? [...room.batches.values()].flatMap((b) => b.rows).filter((r) => r.state === 'running') : [];
    const to = nameOf(state.activeAgentId || activeConversation.agentId);
    setText(box, running.length ? words().noteWords(nameOf(room.lead), to, running.map(member)) : '');
    box.hidden = !running.length;
  }

  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }

  return { changed, draw, note, bolt, avatar };
}));
