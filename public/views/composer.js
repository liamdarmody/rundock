'use strict';
// The composer's attached files: the + button beside the message field, the
// picker it opens, a chip per added file in a row above the field, and the
// messages under it. Same UMD pattern as the other view modules
// (node-requireable, window-attached), republishing every function on the
// root object because the static inline handlers (openAttachPicker,
// pickFiles), setupChat (showComposerFor) and the delegation header effect in
// app.js (refreshAttachButton) reach these by bare name.
//
// EACH CONVERSATION HAS ITS OWN COMPOSER, as each keeps its own unsent text
// (switchComposerTo): the files added and not yet sent and the messages
// showing. The composer on screen is always the one of activeConversation, and
// showComposerFor draws it whenever setupChat opens a conversation.
//
// A FILE IS CHECKED AS IT IS ADDED. A pick, a paste and a drop all go through
// addFiles, which reads each file's bytes in the window (attachment-sniff.js)
// and refuses a file Rundock can't take on its own, saying why, and an add
// that would pass 5 files or 20,000,000 bytes whole. The server checks every
// file again before it stores one.
//
// A FILE NAME IS TEXT. It reaches the page only through textContent and
// setAttribute, never through markup.
//
// Shared state reached through the global lexical environment at call time:
// agents, conversations, activeConversation, getConvoState, ws, addUserMsg,
// startProcessing, persistConversation, renderConvoList, plus the
// classic-script globals RundockAttachmentWording, RundockAttachmentSniff and
// RundockConversationState.
(/** @param {any} root @param {() => object} factory */ function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    root.RundockComposerView = factory();
    Object.assign(root, root.RundockComposerView);
  }
}(typeof self !== 'undefined' ? self : this, function () {

const CHIP_TYPES = new Map([['png', 'PNG'], ['jpg', 'JPEG'], ['jpeg', 'JPEG'], ['gif', 'GIF'], ['webp', 'WebP'],
  ['pdf', 'PDF'], ['txt', 'Text'], ['md', 'Markdown'], ['csv', 'CSV']]);

// Conversation id to its composer: `files` (the added File objects, in
// chip order), `notices` (the messages showing, oldest first), `waiting`
// (the send awaiting its answer, or null), `clearText` (a stored send's
// text still to clear from the field when the conversation is next shown),
// `adds` (the adds not yet drawn) and `queue` (the last of them, which the
// next one waits for).
const composers = new Map();

function composerFor(convoId) {
  if (!composers.has(convoId)) {
    composers.set(convoId, { files: [], notices: [], waiting: null, clearText: false, adds: 0, queue: Promise.resolve() });
  }
  return composers.get(convoId);
}

function shownComposer() {
  return activeConversation ? composerFor(activeConversation.id) : null;
}

function attachmentWording() {
  return typeof RundockAttachmentWording !== 'undefined' ? RundockAttachmentWording : require('../attachment-wording.js');
}

function attachmentSniff() {
  return typeof RundockAttachmentSniff !== 'undefined' ? RundockAttachmentSniff : require('../attachment-sniff.js');
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
  return addFiles(picked, 'pick');
}

// After a removal, focus goes to the next chip's remove button, or the
// previous one's when it was the last, or the field when none is left, so it
// never stays on a button that is gone.
function removeComposerFile(composer, index) {
  if (composer.waiting) return;
  composer.files = composer.files.filter((_, i) => i !== index);
  composer.notices = [];
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
  meta.textContent = `${CHIP_TYPES.get((kinds.get(file) || {}).type) || 'File'} · ${attachmentWording().formatSize(file.size)}`;
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

// The messages, oldest first, each a bold title above the text. They are
// announced by their container and never take focus. A message that stays
// keeps its element, so it is announced once.
function renderComposerNotice(composer) {
  const box = document.getElementById('composer-notice');
  if (!box) return;
  const items = composer.notices.map((notice) => noticeElements.get(notice) || noticeFor(composer, notice));
  for (const child of [...box.children]) if (!items.includes(child)) child.remove();
  items.forEach((item, i) => { if (box.children[i] !== item) box.insertBefore(item, box.children[i] || null); });
}

// A Dismiss takes its own message away, then focus goes to the next
// message's Dismiss, or the previous one's, or the field when none is left.
function noticeFor(composer, notice) {
  const item = document.createElement('div');
  item.className = 'composer-notice-item';
  const icon = document.createElement('span');
  icon.className = 'composer-notice-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.appendChild(iconOf(ICON_INFO, '2'));
  const body = document.createElement('div');
  body.className = 'composer-notice-body';
  const title = document.createElement('strong');
  title.className = 'composer-notice-title';
  title.textContent = notice.title;
  const text = document.createElement('div');
  text.className = 'composer-notice-text';
  text.textContent = notice.text;
  body.append(title, text);
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'composer-notice-dismiss';
  dismiss.setAttribute('aria-label', 'Dismiss');
  dismiss.appendChild(iconOf(ICON_CLOSE, '1.8'));
  dismiss.onclick = () => {
    const index = composer.notices.indexOf(notice);
    composer.notices = composer.notices.filter((n) => n !== notice);
    renderComposerNotice(composer);
    const left = document.querySelectorAll('#composer-notice .composer-notice-dismiss');
    const next = left[index] || left[index - 1] || document.getElementById('msg-input');
    next.focus();
  };
  item.append(icon, body, dismiss);
  noticeElements.set(notice, item);
  return item;
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
  if (composer && (composer.waiting || composer.adds)) return false;
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
// conversation's messages away.
function sendWithFiles(convo, text) {
  const composer = composerFor(convo.id);
  if (!composer.files.length) {
    composer.notices = [];
    renderComposerNotice(composer);
    return false;
  }
  const token = {};
  const files = composer.files.slice();
  composer.waiting = token;
  composer.notices = [];
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
// shows as the only message, and Send comes back on.
function endWait(convoId, notice) {
  const composer = composerFor(convoId);
  composer.waiting = null;
  composer.notices = [{ ...notice }];
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
  composer.notices = [];
  if (typeof RundockSentFiles !== 'undefined') RundockSentFiles.mergeStoredFiles(d.conversationId, d.entry);
  const convo = conversations.find(c => c.id === d.conversationId);
  const onScreen = !!activeConversation && activeConversation.id === d.conversationId;
  if (onScreen) {
    const input = document.getElementById('msg-input');
    input.value = ''; input.style.height = '44px';
    input.readOnly = false;
    renderComposer(composer);
  } else composer.clearText = true;
  if (!convo) return;
  if (onScreen) addUserMsg(d.content, true, d.conversationId);
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

// ===== ADDING FILES =====
//
// An add is a pick, a paste or a drop, and takes these steps in order:
//   1. The count: files held plus files added over LIMITS.files refuses the
//      whole add before any file is read.
//   2. Each file's bytes are read and checked on its own (checkFile), and a
//      pasted image is named "Pasted image", then "Pasted image 2" and on.
//   3. Each refused file gets its own message.
//   4. The total: bytes held plus the passing files' bytes over
//      LIMITS.messageBytes refuses every passing file, with one message.
//   5. The passing files are appended in the order given.
// An add that attaches files replaces the messages showing with its own; one
// that attaches none adds its messages after them. An add belongs to the
// conversation shown when it began, and adds run one after another, so each
// counts the files the one before it attached. While one runs Send is off.

// A held File to the kind its bytes were read as.
const kinds = new WeakMap();

function addFiles(files, source) {
  const added = Array.from(files || []);
  const composer = shownComposer();
  if (!composer || composer.waiting || !added.length) return Promise.resolve();
  const convoId = activeConversation.id;
  composer.adds += 1;
  relightSend();
  const done = () => {
    composer.adds -= 1;
    if (composers.get(convoId) === composer && activeConversation && activeConversation.id === convoId) renderComposer(composer);
  };
  const turn = composer.queue.then(() => addInTurn(convoId, composer, added, source)).finally(done);
  composer.queue = turn.catch(() => {});
  return turn;
}

async function addInTurn(convoId, composer, added, source) {
  const live = () => composers.get(convoId) === composer && !composer.waiting;
  if (!live()) return;
  const { LIMITS, checkFile } = attachmentSniff();
  const { refusalWording } = attachmentWording();
  const one = (list) => (list.length === 1 ? { name: list[0].name } : {});
  const count = composer.files.length + added.length;
  if (count > LIMITS.files) {
    composer.notices = composer.notices.concat(refusalWording({ code: 'too-many-files', count, limit: LIMITS.files, ...one(added) }, added.length));
    return;
  }
  const checked = await Promise.all(added.map((file) => file.arrayBuffer().then(
    (buffer) => checkFile(new Uint8Array(buffer), file.name),
    () => ({ code: 'unsupported', name: file.name }))));
  if (!live()) return;
  const own = [];
  const passed = [];
  added.forEach((file, i) => {
    if (checked[i].code) { own.push(refusalWording(checked[i], 1)); return; }
    // An image's answer carries its size.
    const kept = source === 'paste' && checked[i].width ? pastedImage(file, composer.files.concat(passed)) : file;
    kinds.set(kept, checked[i]);
    passed.push(kept);
  });
  const bytes = composer.files.concat(passed).reduce((sum, file) => sum + file.size, 0);
  if (passed.length && bytes > LIMITS.messageBytes) {
    own.push(refusalWording({ code: 'too-many-bytes', bytes, limit: LIMITS.messageBytes, ...one(passed) }, passed.length));
    passed.length = 0;
  }
  if (!passed.length) {
    composer.notices = composer.notices.concat(own);
    return;
  }
  composer.files = composer.files.concat(passed);
  composer.notices = own;
}

// A pasted image under its new name: "Pasted image" while no file held is so
// named, else "Pasted image <m>", m one more than the highest number held and
// the bare name counting as 1.
function pastedImage(file, held) {
  let highest = 0;
  for (const { name } of held) {
    const match = /^Pasted image(?: (\d+))?$/.exec(name);
    if (match) highest = Math.max(highest, match[1] ? Number(match[1]) : 1);
  }
  return new File([file], highest ? `Pasted image ${highest + 1}` : 'Pasted image', { type: file.type });
}

// ===== PASTE =====
//
// A paste into the field adds the files on the clipboard. Its default is
// never prevented, so text on the clipboard still goes into the field.
function pasteFiles(event) {
  const files = event.clipboardData ? event.clipboardData.files : null;
  if (files && files.length) addFiles(files, 'paste');
}

// Wired once, when the page loads after the composer's markup. Required in
// Node there is no page.
if (typeof document !== 'undefined') {
  const field = document.getElementById('msg-input');
  if (field) field.addEventListener('paste', pasteFiles);
}

// ===== ICONS =====

// A message to the element drawn for it.
const noticeElements = new WeakMap();
const SVG_NS = 'http://www.w3.org/2000/svg';
const ICON_INFO = [['circle', { cx: '12', cy: '12', r: '10' }], ['path', { d: 'M12 8v4' }], ['path', { d: 'M12 16h.01' }]];
const ICON_CLOSE = [['path', { d: 'M18 6 6 18' }], ['path', { d: 'm6 6 12 12' }]];

// A 24 by 24 icon stroked in the text's color, each shape a tag and its
// attributes.
function iconOf(shapes, strokeWidth) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  const attributes = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': strokeWidth,
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' };
  for (const [key, value] of Object.entries(attributes)) svg.setAttribute(key, value);
  for (const [tag, shape] of shapes) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(shape)) node.setAttribute(key, value);
    svg.appendChild(node);
  }
  return svg;
}

return {
  showComposerFor, refreshAttachButton, openAttachPicker, pickFiles,
  sendReady, sendWaiting, firstAttachedName, sendWithFiles, fileSendAnswered, attachmentsConnectionLost,
  composersWorkspaceChanged, addFiles,
};
}));
