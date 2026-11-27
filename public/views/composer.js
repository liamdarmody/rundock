'use strict';
// The composer's attached files: the + button beside the message field, the
// picker it opens, a chip per picked file in a row above the field, and one
// inline message under it. Same UMD pattern as the other view modules
// (node-requireable, window-attached), republishing every function on the
// root object because the static inline handlers (openAttachPicker,
// pickFiles), setupChat (showComposerFor) and the delegation header effect in
// app.js (refreshAttachButton) reach these by bare name.
//
// EACH CONVERSATION HAS ITS OWN COMPOSER, as each keeps its own unsent text
// (switchComposerTo): the files picked and not yet sent and the inline message
// showing. The composer on screen is always the one of activeConversation, and
// showComposerFor draws it whenever setupChat opens a conversation.
//
// A PICK IS TAKEN WHOLE OR NOT AT ALL. One that would pass 5 files or
// 20,000,000 bytes, counting the files already there, adds nothing and says
// why; the per-file checks are the server's until the composer has its own.
//
// A FILE NAME IS TEXT. It reaches the page only through textContent and
// setAttribute, never through markup.
//
// Shared state reached through the global lexical environment at call time:
// agents, conversations, activeConversation, getConvoState, ws, addUserMsg,
// startProcessing, persistConversation, renderConvoList, plus the
// classic-script globals RundockAttachmentWording and
// RundockConversationState.
(/** @param {any} root @param {() => object} factory */ function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    root.RundockComposerView = factory();
    Object.assign(root, root.RundockComposerView);
  }
}(typeof self !== 'undefined' ? self : this, function () {

const FILE_LIMIT = 5;
const BYTE_LIMIT = 20000000;
const CHIP_TYPES = new Map([['png', 'PNG'], ['jpg', 'JPEG'], ['jpeg', 'JPEG'], ['gif', 'GIF'], ['webp', 'WebP'],
  ['pdf', 'PDF'], ['txt', 'Text'], ['md', 'Markdown'], ['csv', 'CSV']]);

// Conversation id to its composer: `files` (the picked File objects, in
// chip order), `notice` (the inline message showing, or null), `waiting`
// (the send awaiting its answer, or null) and `clearText` (a stored send's
// text still to clear from the field when the conversation is next shown).
const composers = new Map();

function composerFor(convoId) {
  if (!composers.has(convoId)) composers.set(convoId, { files: [], notice: null, waiting: null, clearText: false });
  return composers.get(convoId);
}

function shownComposer() {
  return activeConversation ? composerFor(activeConversation.id) : null;
}

function attachmentWording() {
  return typeof RundockAttachmentWording !== 'undefined' ? RundockAttachmentWording : require('../attachment-wording.js');
}

// The chip's type, by the name's extension with case ignored.
function chipType(name) {
  const dot = name.lastIndexOf('.');
  return (dot !== -1 && CHIP_TYPES.get(name.slice(dot + 1).toLowerCase())) || 'File';
}

// Drawn for the conversation setupChat opens: its chips, its inline message
// and the + button.
function showComposerFor(convo) {
  const composer = composerFor(convo.id);
  if (composer.clearText) {
    composer.clearText = false;
    const input = document.getElementById('msg-input');
    if (input) input.value = '';
  }
  // While a send waits, the field holds the text sent and takes no edits.
  const field = document.getElementById('msg-input');
  if (field) field.readOnly = !!composer.waiting;
  renderComposer(composer);
  refreshAttachButton(convo);
}

// Shown whatever the agent a message would go to runs on: an agent on Codex
// takes files too, and the server refuses what Codex can't be sent.
function refreshAttachButton(convo) {
  const button = document.getElementById('attach-btn');
  if (!button || !convo) return;
  button.hidden = false;
}

function openAttachPicker() {
  document.getElementById('attach-input').click();
}

// The picker's change. Its value is cleared so the same file can be picked
// again after it was removed.
function pickFiles(input) {
  const picked = Array.from(input.files || []);
  input.value = '';
  const composer = shownComposer();
  if (!composer || composer.waiting || !picked.length) return;
  const all = composer.files.concat(picked);
  const bytes = all.reduce((sum, file) => sum + file.size, 0);
  const refusal = all.length > FILE_LIMIT ? { code: 'too-many-files', count: all.length, limit: FILE_LIMIT }
    : bytes > BYTE_LIMIT ? { code: 'too-many-bytes', bytes, limit: BYTE_LIMIT } : null;
  if (refusal) {
    if (picked.length === 1) refusal.name = picked[0].name;
    composer.notice = attachmentWording().refusalWording(refusal, picked.length);
  } else {
    composer.files = all;
    composer.notice = null;
  }
  renderComposer(composer);
}

// After a removal, focus goes to the next chip's remove button, or the
// previous one's when it was the last, or the field when none is left, so it
// never stays on a button that is gone.
function removeComposerFile(composer, index) {
  if (composer.waiting) return;
  composer.files = composer.files.filter((_, i) => i !== index);
  composer.notice = null;
  renderComposer(composer);
  const buttons = document.querySelectorAll('#composer-chips .composer-chip-remove');
  (buttons[index] || buttons[index - 1] || document.getElementById('msg-input')).focus();
}

function renderComposer(composer) {
  const row = document.getElementById('composer-chips');
  if (row) row.replaceChildren(...composer.files.map((file, i) => chipFor(composer, file, i)));
  renderComposerNotice(composer);
  relightSend();
}

function chipFor(composer, file, index) {
  const chip = document.createElement('div');
  chip.className = 'composer-chip';
  const text = document.createElement('div');
  text.className = 'composer-chip-text';
  const name = document.createElement('span');
  name.className = 'composer-chip-name';
  name.textContent = file.name;
  const meta = document.createElement('span');
  meta.className = 'composer-chip-meta';
  meta.textContent = `${chipType(file.name)} · ${attachmentWording().formatSize(file.size)}`;
  text.append(name, meta);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'composer-chip-remove';
  remove.setAttribute('aria-label', `Remove ${file.name}`);
  remove.title = `Remove ${file.name}`;
  remove.textContent = '×';
  remove.onclick = () => removeComposerFile(composer, index);
  chip.append(text, remove);
  return chip;
}

// One inline message at a time, a bold title above the text. It is announced
// by its container and never takes focus.
function renderComposerNotice(composer) {
  const box = document.getElementById('composer-notice');
  if (!box) return;
  box.replaceChildren();
  if (!composer.notice) return;
  const body = document.createElement('div');
  body.className = 'composer-notice-body';
  const title = document.createElement('strong');
  title.className = 'composer-notice-title';
  title.textContent = composer.notice.title;
  const text = document.createElement('div');
  text.textContent = composer.notice.text;
  body.append(title, text);
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'composer-notice-dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss');
  dismiss.title = 'Dismiss';
  dismiss.textContent = '×';
  dismiss.onclick = () => { composer.notice = null; renderComposerNotice(composer); };
  box.append(body, dismiss);
}

// Send reads as ready for text or files. Left alone while it is the Stop
// button.
function relightSend() {
  const button = document.getElementById('send-btn');
  const input = document.getElementById('msg-input');
  if (button && input && !button.classList.contains('cancel')) button.classList.toggle('active', sendReady(input.value));
}

function sendReady(text) {
  const composer = shownComposer();
  if (composer && composer.waiting) return false;
  return !!String(text).trim() || (!!composer && composer.files.length > 0);
}

// ===== SENDING FILES =====
//
// A MESSAGE WITH FILES IS SHOWN ONLY ONCE IT IS STORED. Send puts one chat
// frame on the socket carrying the files, and the composer keeps the text
// and chips, with Send off and the field taking no edits (so the text there
// is the text sent), until the server answers for that conversation:
// chat_stored (draw the stored text and start the turn, as dispatchMessage
// does for text), chat_refused (say why, keep everything), or the socket
// closing first (say the message wasn't confirmed, keep everything).
// `waiting` holds a token per send so a file read that finishes after the
// wait ended sends nothing.

// The largest frame the server reads, as MAX_PAYLOAD is on the server.
const COMPOSER_FRAME_LIMIT = 28000000;
const CONNECTION_LOST = {
  title: 'Message not confirmed',
  text: 'The connection closed before Rundock confirmed this message. Check the conversation before sending it again.',
};

function sendWaiting(convoId) {
  const composer = composers.get(convoId);
  return !!composer && !!composer.waiting;
}

function firstAttachedName(convoId) {
  const composer = composers.get(convoId);
  return composer && composer.files.length ? composer.files[0].name : '';
}

function base64Of(file) {
  return file.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  });
}

// Takes the send when the conversation has chips, and answers false
// otherwise so the text goes the usual way. Either way the send takes the
// conversation's inline message away.
function sendWithFiles(convo, text) {
  const composer = composerFor(convo.id);
  if (!composer.files.length) {
    composer.notice = null;
    renderComposerNotice(composer);
    return false;
  }
  const token = {};
  const files = composer.files.slice();
  composer.waiting = token;
  composer.notice = null;
  renderComposer(composer);
  document.getElementById('send-btn').disabled = true;
  document.getElementById('msg-input').readOnly = true;
  Promise.all(files.map(base64Of)).then((data) => {
    if (composer.waiting !== token) return;
    const agent = getConvoState(convo.id).activeAgentId || convo.agentId;
    const sessionId = RundockConversationState.resumeSessionFor(convo, agent);
    const chatMsg = { type: 'chat', content: text, agent, conversationId: convo.id };
    if (sessionId) chatMsg.sessionId = sessionId;
    chatMsg.attachments = files.map((file, i) => ({ name: file.name, data: data[i] }));
    const frame = JSON.stringify(chatMsg);
    const bytes = new TextEncoder().encode(frame).length;
    if (bytes > COMPOSER_FRAME_LIMIT) endWait(convo.id, attachmentWording().refusalWording({ code: 'too-large', bytes }, files.length));
    else if (!ws || ws.readyState !== WebSocket.OPEN) endWait(convo.id, CONNECTION_LOST);
    else ws.send(frame);
  }, () => endWait(convo.id, CONNECTION_LOST));
  return true;
}

// The wait ends without the message: the text and chips stay, the reason
// shows, and Send comes back on.
function endWait(convoId, notice) {
  const composer = composerFor(convoId);
  composer.waiting = null;
  composer.notice = notice;
  if (!activeConversation || activeConversation.id !== convoId) return;
  renderComposer(composer);
  document.getElementById('send-btn').disabled = false;
  document.getElementById('msg-input').readOnly = false;
}

// chat_stored and chat_refused, acted on only for a conversation with a send
// waiting. A stored message sent from a conversation no longer on screen
// changes only that conversation: its text is cleared when it is next shown.
function fileSendAnswered(d) {
  const composer = composers.get(d.conversationId);
  if (!composer || !composer.waiting) return;
  if (d.type === 'chat_refused') { endWait(d.conversationId, { title: d.title, text: d.text }); return; }
  composer.waiting = null;
  composer.files = [];
  composer.notice = null;
  const convo = conversations.find(c => c.id === d.conversationId);
  const onScreen = !!activeConversation && activeConversation.id === d.conversationId;
  if (onScreen) {
    const input = document.getElementById('msg-input');
    input.value = ''; input.style.height = '44px';
    input.readOnly = false;
    renderComposer(composer);
  } else composer.clearText = true;
  if (!convo) return;
  if (onScreen) addUserMsg(d.content);
  convo.messages.push({ role: 'user', content: d.content, timestamp: new Date().toISOString() });
  if (convo.persisted) {
    convo.persisted = false;
    convo.status = 'active';
    renderConvoList();
  }
  startProcessing(convo.id);
  persistConversation(convo);
}

// The socket closed: no send still waiting will be answered.
function attachmentsConnectionLost() {
  for (const [convoId, composer] of composers) if (composer.waiting) endWait(convoId, CONNECTION_LOST);
}

// The workspace changed. Its conversations are different conversations, even
// under the same id, so every composer goes: the files picked, the inline
// messages and the sends still waiting, whose file reads then send nothing.
function composersWorkspaceChanged() {
  for (const composer of composers.values()) composer.waiting = null;
  composers.clear();
  const field = document.getElementById('msg-input');
  if (field) field.readOnly = false;
}

return {
  showComposerFor, refreshAttachButton, openAttachPicker, pickFiles,
  sendReady, sendWaiting, firstAttachedName, sendWithFiles, fileSendAnswered, attachmentsConnectionLost,
  composersWorkspaceChanged,
};
}));
