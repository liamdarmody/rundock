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
// agents, activeConversation, getConvoState, plus the classic-script global
// RundockAttachmentWording.
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
// chip order) and `notice` (the inline message showing, or null).
const composers = new Map();

function composerFor(convoId) {
  if (!composers.has(convoId)) composers.set(convoId, { files: [], notice: null });
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
// and whether its agent can take files.
function showComposerFor(convo) {
  renderComposer(composerFor(convo.id));
  refreshAttachButton(convo);
}

// Hidden while the agent a message would go to, the one dispatchMessage
// resolves, runs on Codex: it can't open attached files yet.
function refreshAttachButton(convo) {
  const button = document.getElementById('attach-btn');
  if (!button || !convo) return;
  const agentId = getConvoState(convo.id).activeAgentId || convo.agentId;
  const agent = agents.find(a => a.id === agentId);
  button.hidden = !!agent && agent.runtime === 'codex';
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
  if (!composer || !picked.length) return;
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
  return !!String(text).trim() || (!!composer && composer.files.length > 0);
}

return {
  showComposerFor, refreshAttachButton, openAttachPicker, pickFiles,
};
}));
