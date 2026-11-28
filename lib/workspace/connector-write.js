'use strict';
// The one writer of a workspace's `.mcp.json` for a connector change. An
// agent's change reaches it through the save and delete handlers
// (lib/protocol/handlers/team.js), and Rundock's own setup may call it to add
// one. Every change is checked, raises its own card, and is written only on an
// Allow given on that card while the file still holds what the card showed.
const fs = require('fs');
const path = require('path');
const util = require('util');
const { noteOwnWrite, answerFilesWatched, answerFileToBuildOn, answerFileChangeUntaken } = require('./answer-file-guard.js');
const { writeFileNoFollow } = require('./link-safe-write.js');

const UNREADABLE = 'The connector file could not be read, so nothing was changed. Its current contents are unknown and writing now would drop whatever it holds.';
const LINK_REFUSED = 'The connector file is a link, so Rundock does not write through it and nothing was changed.';
const SERVERS_NOT_AN_OBJECT = 'The connector file\'s "mcpServers" does not hold an object, so nothing was changed.';
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isLink = (file) => { try { return fs.lstatSync(file).isSymbolicLink(); } catch (e) { return false; } };

// What stands at `file`, read without following a link and without waiting
// on a pipe: { bytes } for a regular file, { bytes: null } for nothing there,
// or { refused } with the message saying why it can't be built on. Where the
// platform has no O_NOFOLLOW (Windows), an lstat just before the open refuses
// a link.
function readNoFollow(file) {
  const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = fs.constants;
  let fd;
  try {
    if (!O_NOFOLLOW && fs.lstatSync(file).isSymbolicLink()) return { refused: LINK_REFUSED };
    fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (e) {
    if (isLink(file)) return { refused: LINK_REFUSED };
    return e && e.code === 'ENOENT' ? { bytes: null } : { refused: UNREADABLE };
  }
  try {
    return fs.fstatSync(fd).isFile() ? { bytes: fs.readFileSync(fd) } : { refused: UNREADABLE };
  } catch (e) {
    return { refused: UNREADABLE };
  } finally {
    fs.closeSync(fd);
  }
}

// Written in place without following a link. Where the platform has no
// O_NOFOLLOW, an lstat just before the open refuses one, as the read does.
function writeNoFollow(file, body) {
  if (!fs.constants.O_NOFOLLOW && isLink(file)) throw Object.assign(new Error('ELOOP: the connector file is a link'), { code: 'ELOOP' });
  writeFileNoFollow(file, body);
}

// The steps that touch the file, on one object so a test can stand in for one.
const io = { read: readNoFollow, write: writeNoFollow, readBack: readNoFollow };

// THE COPY A CHANGE IS BUILT ON, AND WHETHER ITS WRITE IS RECORDED AS
// RUNDOCK'S OWN (noteOwnWrite), so the answer-file guard keeps it:
//   - A turn's guard watches the workspace: its check runs first and puts
//     back any change Rundock did not make, and the change is built on the
//     copy the guard accepted (answerFileToBuildOn). Recorded.
//   - No turn watches, and the guard holds a change it has not taken yet (a
//     person's own edit made while the card waited, say): built on the file
//     as it stands, so that edit is kept, and not recorded, so the next turn
//     start still takes it with its notice naming the file.
//   - Otherwise: built on the file as it stands. Recorded.
// The file itself is read after the guard's step, never through a link.
function copyToBuildOn(workspace, file) {
  if (answerFilesWatched(workspace)) {
    const accepted = answerFileToBuildOn(workspace, file);
    const disk = io.read(file);
    if (disk.refused || !accepted) return { ...disk, record: true };
    return { bytes: accepted.bytes, record: true };
  }
  const disk = io.read(file);
  if (disk.refused) return disk;
  return { bytes: disk.bytes, record: !answerFileChangeUntaken(workspace, file, disk.bytes) };
}

/**
 * save_connector / delete_connector: write the one file an agent cannot.
 *
 * WHY THIS EXISTS AT ALL. Claude Code protects `.mcp.json` wherever it lives,
 * so an agent asked to add or remove a connector is refused by its own file
 * tools, in any workspace, with the user's approval already given. Measured:
 * two agents and three attempts, all refused, and the Connectors tab hands
 * adding a connector to the guide, so without this the hand-off went nowhere.
 * Rundock is not subject to that restriction, so the agent says what it wants
 * written and Rundock writes it, once the person has allowed it on a card (see
 * askFirst below). The same division the agent and skill markers already use,
 * for a different reason: there the marker exists so an edit lands where the
 * app reads, here because no other path exists. Claude Code's documentation
 * lists `.mcp.json` among its protected paths, whose writes it never approves
 * on its own, and a session with no one to prompt does not write them.
 *
 * NEVER WRITTEN FROM BYTES THIS DID NOT READ. A merge built on a failed read
 * drops every server already configured, which is the whole file for anyone
 * with more than one connector. A file that is absent is an empty object and
 * merges normally; a file that exists and cannot be read, or holds something
 * this cannot parse, refuses and says so, and so does one whose servers map
 * is not an object, which is never emptied to make room. The old add form
 * carried this rule on the client and it moves here intact.
 *
 * NEVER READ THROUGH A LINK, AND ONLY A REGULAR FILE. A link at `.mcp.json`
 * would hand the change a file somewhere else to be built on and written
 * through, so it is refused, as is a folder, a pipe or anything else.
 */
function connectorFile(ctx, ws, workspace) {
  const file = path.join(workspace, '.mcp.json');
  const refuse = (message) => {
    ws.send(JSON.stringify({ type: 'connector_error', message }));
    return null;
  };
  if (!ctx.workspace.isInsideWorkspace(file)) return refuse('Invalid path.');
  const copy = copyToBuildOn(workspace, file);
  if (copy.refused) return refuse(copy.refused);
  const { record } = copy;
  if (copy.bytes === null) return { file, parsed: { mcpServers: {} }, base: { mcpServers: {} }, record, created: true };
  const raw = copy.bytes.toString('utf-8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return refuse('The connector file is not valid JSON, so nothing was changed. Fix or remove it first: writing over it now would discard whatever was meant to be there.');
  }
  if (!isObject(parsed)) return refuse('The connector file does not hold an object, so nothing was changed.');
  if (Object.prototype.hasOwnProperty.call(parsed, 'mcpServers') && !isObject(parsed.mcpServers)) return refuse(SERVERS_NOT_AN_OBJECT);
  // `base` is the copy built on, kept apart from the one the change is made
  // on, so what the file holds afterwards can be held against it.
  return { file, parsed: withServers(parsed), base: withServers(JSON.parse(raw)), record };
}
// An absent servers map is made as the file's last key.
function withServers(parsed) {
  if (!Object.prototype.hasOwnProperty.call(parsed, 'mcpServers')) parsed.mcpServers = {};
  return parsed;
}

// A name the file format can actually hold, and that cannot reach anywhere
// else: a key with a slash or a dot-dot in it is a path, not a server name.
// It starts with a letter, a number or an underscore, so it never reads as an
// option or a hidden file wherever it is passed on. And it is none of the
// names every plain object already answers to: `__proto__` assigned onto the
// servers map sets its prototype and adds no key, so an allowed save would
// write nothing and still be reported as saved, and the credential merge
// skips all three (lib/workspace/mcp-secrets.js). The ONE rule for a
// connector name: save and delete both ask it, before the file is read.
const CONNECTOR_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const RESERVED_CONNECTOR_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
const CONNECTOR_NAME_REFUSED = 'That connector name can\'t be used, so nothing was changed. A name uses letters, numbers, dots, dashes and underscores, and starts with a letter, number or underscore.';
function validConnectorName(name) {
  return typeof name === 'string' && CONNECTOR_NAME.test(name) && !/\.\./.test(name) && !RESERVED_CONNECTOR_NAMES.has(name);
}

// An entry the card can show something to run or reach: a command or a URL,
// as a string. Anything else would raise a card naming nothing, and be written
// on Allow as a server that cannot start.
const CONNECTOR_ENTRY_REFUSED = 'A connector needs a command to run or a URL to reach, so nothing was changed.';
function validConnectorEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  return typeof entry.command === 'string' || typeof entry.url === 'string';
}

// The card shows each of these keys only in one shape (connectorCardInput),
// and `args` only beside a command string, and converts or leaves out any
// other, while Allow writes the entry as sent.
// So an entry holding one in another shape is refused, naming the first in
// this order, and an Allow never writes something the card did not show.
const isString = (v) => typeof v === 'string';
const isStringMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(isString);
const SHOWN_CONNECTOR_SHAPES = [
  ['command', isString],
  ['args', (v, e) => isString(e.command) && Array.isArray(v) && v.every(isString)],
  ['url', isString],
  ['type', isString],
  ['headersHelper', isString],
  ['env', isStringMap],
  ['headers', isStringMap],
];
const connectorShapeRefused = (key) => `The connector entry's "${key}" isn't in a form the approval card can show exactly, so nothing was changed.`;
function unshownConnectorKey(entry) {
  const bad = SHOWN_CONNECTOR_SHAPES.find(([key, shows]) => Object.prototype.hasOwnProperty.call(entry, key) && !shows(entry[key], entry));
  return bad ? bad[0] : null;
}

// The card shows the seven settings in SHOWN_CONNECTOR_KEYS and no others,
// and Allow writes the entry as sent, so an entry holding any other setting
// would write a value nobody was shown: it is refused, after the rules above
// and before anything is read or asked. The setting is named only when it is a
// plain word, so the message can't carry text of the agent's choosing.
const PLAIN_SETTING = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
function hiddenSettingRefusal(entry) {
  const hidden = Object.keys(entry).find((key) => !SHOWN_CONNECTOR_KEYS.has(key));
  if (hidden === undefined) return null;
  return PLAIN_SETTING.test(hidden)
    ? `The connector entry's "${hidden}" isn't a setting the approval card can show, so nothing was changed.`
    : 'The connector entry holds a setting the approval card can\'t show, so nothing was changed.';
}

const WRITE_FAILED = 'Rundock couldn\'t save the connector file, so nothing was changed.';
const NOT_PUT_BACK = 'Rundock couldn\'t save the connector file, and couldn\'t put back what it held before. Check Connectors in Settings.';

// A write that failed on a file it made leaves that file empty: it is taken
// away again, so the workspace has no connector file, as before.
function removeIfEmpty(file) {
  try {
    const st = fs.lstatSync(file);
    if (st.isFile() && st.size === 0) fs.unlinkSync(file);
  } catch (e) { /* left as it stands */ }
}

const NOT_CONFIRMED = 'Rundock saved the connector file but couldn\'t confirm it holds the change. Check Connectors in Settings.';

// WHAT THE FILE MUST HOLD ONCE THE CHANGE IS WRITTEN, read again without
// following a link: exactly the bytes written, the entry under its name (or
// no entry after a remove), and every other setting and connector as in the
// copy built on, in the same order.
function holdsChange(back, body, base, change, name, entry) {
  if (!back || !Buffer.isBuffer(back.bytes) || !back.bytes.equals(Buffer.from(body, 'utf-8'))) return false;
  const now = JSON.parse(back.bytes.toString('utf-8'));
  const servers = { ...base.mcpServers };
  if (change === 'remove') delete servers[name];
  else servers[name] = entry;
  const inOrder = (a, b) => util.isDeepStrictEqual(Object.keys(a), Object.keys(b));
  return inOrder(now, base) && inOrder(now.mcpServers, servers)
    && Object.keys(base).every((key) => key === 'mcpServers' || util.isDeepStrictEqual(now[key], base[key]))
    && Object.keys(servers).every((n) => util.isDeepStrictEqual(now.mcpServers[n], servers[n]));
}

// Writes `now` (connectorFile's read, with the change made on its servers) in
// place, without following a link, and records it as Rundock's own only once
// the write has returned. A write that fails puts back what the file held
// where it can (lib/workspace/link-safe-write.js), and the window is told so
// in plain words; the error's own goes to the log. Only a read-back holding
// the change is called saved. Not crash-atomic: the file is rewritten in
// place, as the editor's save rewrites one. Returns null once confirmed, or
// the { reason, message } it sent.
function writeConnectorFile(ctx, ws, now, change, name, entry) {
  const { file, parsed } = now;
  const said = change === 'remove' ? 'removed' : 'saved';
  const body = `${JSON.stringify(parsed, null, 2)}\n`;
  const fail = (reason, message) => {
    ws.send(JSON.stringify({ type: 'connector_error', message }));
    return { reason, message };
  };
  try {
    io.write(file, body);
  } catch (e) {
    console.warn(`[Connector] ${name} was not ${said}: ${e && e.message}`);
    if (now.created) removeIfEmpty(file);
    return fail('write-failed', e && e.restoreFailed ? NOT_PUT_BACK : WRITE_FAILED);
  }
  // Recorded in the same step as the write that returned, so the answer-file
  // guard takes it as Rundock's own, except over a change the guard has not
  // taken yet (copyToBuildOn).
  if (now.record) noteOwnWrite(file, body);
  let back = null;
  try { back = io.readBack(file); } catch (e) { console.warn(`[Connector] ${name}: the file could not be read again: ${e && e.message}`); }
  if (!holdsChange(back, body, now.base, change, name, entry)) {
    console.warn(`[Connector] ${name} was written, but the file does not hold the change`);
    return fail('not-confirmed', NOT_CONFIRMED);
  }
  console.log(`[Connector] ${said}: ${name}`);
  // Agents read their connectors when they start, so a change is not live in
  // a conversation already running. Said here rather than left to be noticed.
  ws.send(JSON.stringify({ type: 'connector_saved', name, action: said, takesEffect: 'next agent start' }));
  return null;
}

// AN AGENT'S CONNECTOR CHANGE ASKS THE PERSON FIRST, EVERY TIME. These two
// messages come from an agent: the window sends them when a reply carries a
// SAVE_CONNECTOR or DELETE_CONNECTOR marker (public/app.js), and Settings has
// no writer of its own (its Connectors tab hands adding one to the guide). A
// stdio server is a command the runtime starts as its own process, outside the
// sandbox, at the next spawn, so a marker alone is never enough. Each message
// raises its own card, naming the server and what it would run, and the window
// grades it high, so no standing allow answers it and none is offered. Only an
// Allow a person gave on that card writes: Deny, an allow that came from no
// card, or no answer before the timeout (no window to ask included) writes
// nothing. The same marker in a later reply is a new message and a new card.
// What could not be written anyway is refused before anyone is asked, and the
// file is read again once allowed, since it may have changed meanwhile.
// `msg` is the change's request: its conversation id, and `refuse`, which
// says why nothing was written.
function askFirst(ctx, ws, msg, toolName, toolInput, write) {
  ctx.runtime.requestServerPermission({
    convoId: typeof msg.conversationId === 'string' ? msg.conversationId : '',
    toolName,
    toolInput,
    onDecision: (allow, reason, how) => {
      if (allow === true && how && how.card === true) { write(); return; }
      const timedOut = reason === 'timeout';
      const why = timedOut ? 'Nobody answered the card in time' : 'The change was not allowed';
      msg.refuse(timedOut ? 'timeout' : 'denied', `${why}, so nothing was changed.`);
    },
  });
}

// What the card shows: the server, and exactly what it would run or reach.
// Environment and header names only: their values are commonly credentials.
const SHOWN_CONNECTOR_KEYS = new Set(['command', 'args', 'url', 'type', 'env', 'headers', 'headersHelper']);
function connectorCardInput(name, action, entry) {
  const e = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
  const keys = v => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : []);
  const input = { name, action };
  if (typeof e.command === 'string') {
    input.command = e.command;
    input.args = Array.isArray(e.args) ? e.args.map(String) : [];
  }
  if (typeof e.url === 'string') input.url = e.url;
  if (typeof e.type === 'string') input.transport = e.type;
  if (keys(e.env).length) input.env = keys(e.env);
  if (keys(e.headers).length) input.headers = keys(e.headers);
  if (typeof e.headersHelper === 'string') input.headersHelper = e.headersHelper;
  const others = Object.keys(e).filter(k => !SHOWN_CONNECTOR_KEYS.has(k));
  if (others.length) input.others = others;
  return input;
}

// A replace card shows the entry it would replace, drawn the same way as the
// new one, so its environment and header values stay off the card too.
function currentCardInput(entry) {
  const shown = connectorCardInput('', 'replace', entry);
  delete shown.name;
  delete shown.action;
  return shown;
}

const has = (found, name) => Object.prototype.hasOwnProperty.call(found.parsed.mcpServers, name);

const CHANGES = new Set(['add', 'replace', 'remove']);
const SOURCES = new Set(['agent', 'rundock']);
const CHANGE_REFUSED = 'That connector change can\'t be made, so nothing was changed.';
const SETUP_ADDS_ONLY = 'Rundock\'s setup can only add a connector, so nothing was changed.';
const NO_CONVERSATION = 'That connector change didn\'t say which conversation it came from, so nothing was changed.';
// An add never lands on a name already there: the card showed no entry to lose.
const alreadySetUp = (name) => `A connector named "${name}" is already set up, so nothing was changed. Ask to replace it if you meant to change it.`;
// Said rather than silently succeeding: an agent told "done" for a name
// that was never there reports a removal that did not happen.
const notConfigured = (name) => `No connector named "${name}" is configured in this workspace, so nothing was changed.`;
const CHANGED = 'The connectors changed after you were asked, so nothing was changed. Ask again to see the change as it stands now.';
// A replace card draws the entry it would overwrite with the same seven
// settings, each in one form, and Allow overwrites all of it, so an entry the
// card can't draw exactly would lose values nobody was shown: such a replace
// is refused before any card, by the same rules a new entry is held to.
const currentUnshown = (name) => `The connector "${name}" as it is now holds a setting the approval card can't show, so nothing was changed. Change it in .mcp.json yourself.`;
const shownExactly = (entry) => !!entry && typeof entry === 'object' && !Array.isArray(entry)
  && hiddenSettingRefusal(entry) === null && unshownConnectorKey(entry) === null;

/**
 * Propose one change to the workspace's connectors: 'add' or 'replace' `name`
 * with `entry`, or 'remove' it. `source` is 'agent' (an agent's marker, which
 * must name its conversation) or 'rundock' (Rundock's own setup). Sends exactly
 * one message to `ws` for the outcome, at the decision, and resolves
 * `{ ok: true, change, name, takesEffect }` or `{ ok: false, reason, message }`.
 * Never rejects.
 *
 * The order of the checks is the contract: the name, the entry's shape and its
 * settings, the change and who asks for it, then the conversation, all before
 * the file is read, so a change refused for what it is never opens the file or
 * raises a card. The read then refuses an add of a name already there, a
 * replace or remove of one that isn't, and a replace of an entry the card
 * can't show exactly. An Allow reads the file again and writes
 * only while it still holds what the card stood for: the name still absent for
 * an add, and the same entry, compared by value, for a replace or a remove.
 */
function proposeConnectorChange(ctx, ws, request) {
  const { workspace, conversationId, change, name, entry, source } = request || {};
  return new Promise((resolve) => {
    const refuse = (reason, message) => {
      ws.send(JSON.stringify({ type: 'connector_error', message }));
      resolve({ ok: false, reason, message });
    };
    if (!validConnectorName(name)) return refuse('invalid', CONNECTOR_NAME_REFUSED);
    if (change === 'add' || change === 'replace') {
      if (!validConnectorEntry(entry)) return refuse('invalid', CONNECTOR_ENTRY_REFUSED);
      const unshown = unshownConnectorKey(entry);
      if (unshown) return refuse('invalid', connectorShapeRefused(unshown));
      const hidden = hiddenSettingRefusal(entry);
      if (hidden) return refuse('invalid', hidden);
    }
    if (!CHANGES.has(change) || !SOURCES.has(source) || typeof workspace !== 'string' || !workspace) return refuse('invalid', CHANGE_REFUSED);
    if (source === 'rundock' && change !== 'add') return refuse('invalid', SETUP_ADDS_ONLY);
    if (source !== 'rundock' && !(typeof conversationId === 'string' && conversationId)) return refuse('invalid', NO_CONVERSATION);
    // connectorFile says why it could not read; that message is the outcome.
    let unread = '';
    const heard = { send: (data) => { unread = JSON.parse(data).message; } };
    // What the file must still hold for the change to be the one asked about.
    const stillAsAsked = (read) => {
      if (change === 'add' && has(read, name)) return ['exists', alreadySetUp(name)];
      if (change !== 'add' && !has(read, name)) return ['absent', notConfigured(name)];
      return null;
    };
    const found = connectorFile(ctx, heard, workspace);
    if (!found) return refuse('unreadable', unread);
    const unlike = stillAsAsked(found);
    if (unlike) return refuse(...unlike);
    const before = found.parsed.mcpServers[name];
    if (change === 'replace' && !shownExactly(before)) return refuse('invalid', currentUnshown(name));
    const input = change === 'remove' ? connectorCardInput(name, 'remove', before) : connectorCardInput(name, change, entry);
    if (change === 'replace') input.current = currentCardInput(before);
    askFirst(ctx, ws, { conversationId, refuse }, change === 'remove' ? 'DeleteConnector' : 'SaveConnector', input, () => {
      const now = connectorFile(ctx, heard, workspace);
      if (!now) return refuse('unreadable', unread);
      const moved = stillAsAsked(now);
      if (moved) return refuse(...moved);
      if (change !== 'add' && !util.isDeepStrictEqual(now.parsed.mcpServers[name], before)) return refuse('changed', CHANGED);
      if (change === 'remove') delete now.parsed.mcpServers[name];
      else now.parsed.mcpServers[name] = entry;
      const failed = writeConnectorFile(ctx, ws, now, change, name, entry);
      resolve(failed ? { ok: false, ...failed } : { ok: true, change, name, takesEffect: 'next agent start' });
    });
  });
}

module.exports = {
  validConnectorName,
  CONNECTOR_NAME_REFUSED,
  validConnectorEntry,
  CONNECTOR_ENTRY_REFUSED,
  unshownConnectorKey,
  connectorShapeRefused,
  hiddenSettingRefusal,
  connectorFile,
  connectorCardInput,
  proposeConnectorChange,
  io,
};
