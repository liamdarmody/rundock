'use strict';
// WHAT RUNDOCK DID WITH A REPLY'S AGENT AND SKILL MARKERS, told to the next
// turn and kept in the conversation's history.
//
// applyTeamMarkers (team-markers.js) decides each marker at the end of the
// turn that wrote it, after the reply has finished, so the agent that wrote it
// cannot know what happened. keepOutcomes takes those outcomes and:
//   - keeps them for the conversation's next turn, whichever agent runs it,
//     on the conversation's record as well so a restart does not lose them,
//     and puts them in front of that turn's input once, under Rundock's own
//     heading (catch-up.js teamOutcomeNote). A Claude Code turn is reached
//     where every message is written to its process (noteOnNextMessage, wired
//     to every process at spawn); a Codex turn where its input is composed
//     (withAgentNotice in codex-glue.js, through withTeamNote).
//   - stores the line a person reads, once per outcome, in the conversation's
//     history, so it is shown when the conversation is opened later.
//
// A caller that acts on markers calls keepOutcomes(convoId, applyTeamMarkers(...)).
//
// FAILS CLOSED FOR THE PERSON. Any step that throws is logged and the turn's
// input goes as it would have gone with no note: a note is put in whole or not
// at all. Seams for tests are the `seams` members, patched in-process.
const { readConversations, writeConversations } = require('../store/persistence.js');
const { getWorkspace } = require('../config.js');
const { teamOutcomeNote } = require('../delegation/catch-up.js');
const { displayNameOf } = require('./team-markers.js');
const { discoverAgents } = require('./discovery.js');

/** @type {{appendTranscript: ((...args: any[]) => void)|null}} */
let deps = { appendTranscript: null };
/** @param {object} next */
function wireTeamNotes(next) { deps = { ...deps, ...next }; }

// The outcomes waiting for each conversation's next turn, mirrored on its
// record (`teamOutcomes`) and read back from there the first time a workspace
// is used after a start.
const waiting = new Map();
let loadedFor = null;
function load() {
  const workspace = getWorkspace();
  if (loadedFor === workspace) return;
  loadedFor = workspace;
  waiting.clear();
  const stopped = [];
  for (const c of readConversations()) {
    if (c && Array.isArray(c.teamOutcomes) && c.teamOutcomes.length) waiting.set(c.id, c.teamOutcomes);
    for (const [id, card] of Object.entries((c && c.teamCards) || {})) if (card && card.run !== RUN) stopped.push([c.id, id, card.outcome]);
  }
  for (const [convoId, id, outcome] of stopped) { dropCard(convoId, id); keepOutcomes(convoId, [outcome]); }
}

// A CARD STILL OPEN WHEN RUNDOCK STOPS decides nothing, so the change it asked
// about is never made (team-markers.js). Each open card is held on its
// conversation's record, under this run, with the outcome a stop gives it, and
// dropped once decided. The first read after a start (load, also run when a
// window connects) turns a card an earlier run held into that outcome: told to
// the next turn, and stored as the line a person reads.
const RUN = require('crypto').randomBytes(8).toString('hex');
/** @param {string} convoId @param {string} id @param {object} outcome */
function holdCard(convoId, id, outcome) { editCards(convoId, (cards) => { cards[id] = { run: RUN, outcome }; }); }
/** @param {string} convoId @param {string} id */
function dropCard(convoId, id) { editCards(convoId, (cards) => { delete cards[id]; }); }
/** @param {string} convoId @param {(cards: any) => void} edit */
function editCards(convoId, edit) {
  try {
    const convos = readConversations();
    const convo = convos.find((c) => c.id === convoId);
    if (!convo) return;
    const cards = { ...(convo.teamCards || {}) };
    edit(cards);
    if (Object.keys(cards).length) convo.teamCards = cards;
    else delete convo.teamCards;
    writeConversations(convos);
  } catch (e) { log(convoId, 'could not keep the open card on the record', e); }
}

/** Write a conversation's waiting outcomes to its record, or remove them with null. */
function persist(convoId, list) {
  const convos = readConversations();
  const convo = convos.find((c) => c.id === convoId);
  if (!convo || (!list && convo.teamOutcomes === undefined)) return;
  if (list) convo.teamOutcomes = list;
  else delete convo.teamOutcomes;
  writeConversations(convos);
}

const seams = {
  /** Keep the outcomes waiting for a conversation's next turn. */
  store(convoId, list) { waiting.set(convoId, list); persist(convoId, list); },
  /** The note for those outcomes. */
  build: (list) => teamOutcomeNote(list, displayNameOf),
  /** The turn's input with the note in front of it. */
  deliver: (input, note) => note + input,
};

const log = (convoId, what, e) => console.error(`[TeamNotes] convo=${convoId} ${what}: ${e && e.message}`);

/** Only the fixed fields of an outcome are kept. */
const fixed = (o) => ({
  kind: String(o.kind), name: o.name == null ? null : String(o.name), author: o.author == null ? null : String(o.author),
  outcome: String(o.outcome), ...(o.message ? { message: String(o.message) } : {}),
});

const NOUNS = { save_agent: 'Agent', delete_agent: 'Agent', save_skill: 'Skill', delete_skill: 'Skill' };
/** The line a person reads: the words the window draws for the same outcome (public/app.js). */
function storedLine(o) {
  const noun = NOUNS[o.kind];
  if (!noun || o.outcome === 'refused' || o.outcome === 'error') return o.message || `${noun || 'Agent'} operation failed`;
  if (o.outcome === 'deleted') return `${noun} "${o.name}" removed`;
  let codex = false;
  try { codex = o.kind === 'save_agent' && discoverAgents().some((a) => a.id === o.name && a.runtime === 'codex'); } catch (e) { /* the line stands without it */ }
  return `${noun} "${o.name}" ${o.outcome === 'updated' ? 'updated' : 'created'}${codex ? ' · runs on Codex' : ''}`;
}

/** Keep a turn's outcomes for the next turn, and store each one's line in the history. */
function keepOutcomes(convoId, outcomes) {
  if (!convoId || !Array.isArray(outcomes) || !outcomes.length) return;
  const list = outcomes.map(fixed);
  try {
    load();
    seams.store(convoId, [...(waiting.get(convoId) || []), ...list]);
  } catch (e) { log(convoId, 'could not keep the outcomes for the next turn', e); }
  try {
    for (const o of list) if (deps.appendTranscript) deps.appendTranscript(convoId, 'system', null, storedLine(o), 'team');
  } catch (e) { log(convoId, 'could not store the line in the history', e); }
}

/** The next turn's input with the note in front of it, once; the input unchanged when there is none. */
function withTeamNote(convoId, input, proc = null) {
  let list = null;
  try {
    load();
    list = waiting.get(convoId) || null;
    if (!list) return input;
    waiting.delete(convoId);
    persist(convoId, null);
  } catch (e) { log(convoId, 'could not read the outcomes', e); return input; }
  try {
    const told = seams.deliver(input, seams.build(list));
    if (proc) proc.teamOutcomesGiven = list;
    return told;
  } catch (e) { log(convoId, 'could not tell the next turn what Rundock did', e); return input; }
}

// Every Claude Code process, as it starts (server.js onClaudeSpawn): the next
// user message written to it opens with the note, if one is waiting. Every
// turn a Claude agent is sent is a write here, whichever path sends it.
function noteOnNextMessage(proc, convoId) {
  const stdin = proc && proc.stdin;
  if (!convoId || !stdin || typeof stdin.write !== 'function') return;
  const write = stdin.write;
  stdin.write = function (/** @type {any} */ chunk, /** @type {any[]} */ ...rest) {
    let out = chunk;
    try {
      load();
      if (waiting.has(convoId)) {
        const line = JSON.parse(String(chunk));
        const content = line && line.type === 'user' && line.message ? line.message.content : null;
        if (typeof content === 'string') {
          const told = withTeamNote(convoId, content, proc);
          if (told !== content) out = JSON.stringify({ ...line, message: { ...line.message, content: told } }) + '\n';
        }
      }
    } catch (e) { out = chunk; }
    return write.call(this, out, ...rest);
  };
}

// A process that never read its message (a resume Claude Code refused) gives
// back what it was told, so the turn started in its place is told instead.
function putBack(convoId, proc) {
  const list = proc && proc.teamOutcomesGiven;
  if (!list) return;
  proc.teamOutcomesGiven = null;
  try {
    load();
    seams.store(convoId, [...list, ...(waiting.get(convoId) || [])]);
  } catch (e) { log(convoId, 'could not keep the outcomes for the turn started again', e); }
}

module.exports = { keepOutcomes, withTeamNote, noteOnNextMessage, putBack, storedLine, wireTeamNotes, holdCard, dropCard, load, seams };
