'use strict';
// The agent and skill changes a reply asks for, decided on the server when
// the turn that wrote them ends.
//
// Agents ask for an agent or skill file to be saved or deleted by writing a
// marker in a reply (SAVE_AGENT, CREATE_AGENT, DELETE_AGENT, SAVE_SKILL,
// DELETE_SKILL). Only Doc (`rundock-guide`) may change the team. Who wrote a
// reply is never read from the reply, from a marker's attributes, or from
// anything a window sends: it is the agent id the server recorded for the
// process whose turn just ended, passed in as that turn's entry. Any other
// author is refused, nothing is written, and the conversation is told why.
//
// THE DECISION IS MADE ONCE PER TURN, here. The runtime glue calls
// applyTeamMarkers at the end of every turn it delivers, with the text it
// collected from the process it ran. Windows no longer send these changes,
// and the socket handlers refuse them if anything does.
//
// ONE FUNCTION PRODUCES EVERY OUTCOME (saved, updated, deleted, refused,
// error) and broadcasts each to the conversation's windows. A caller that
// needs to keep the outcomes or tell the agent wraps this function rather
// than deciding again.
//
// IN A HAND-OFF, EACH CHANGE IS ASKED ABOUT. Doc takes a delegating agent's
// "go ahead" as the person's consent, and any agent can bring Doc in with a
// brief it wrote. So when Doc's process was started for another agent (the
// delegation record the engine sets on the entry, lib/delegation/engine.js,
// never the reply, a marker, the brief or a window message), each change
// raises its own card, as a connector change does (askFirst in team.js), and
// only an Allow a person gave on that card writes it: exactly the bytes the
// card showed, if the disk still holds what the card said. Deny, an allow from
// no card, no answer, a cancel or a restart writes nothing. The outcome is kept
// for the next turn when the card decides it, and Doc's hand-back waits for
// the cards (afterTeamCards). The person talking to Doc directly is not asked.
//
// Seams for tests are the `seams` members, patched in-process. There is no
// environment variable, argument or file that changes any of this.
const fs = require('fs');
const path = require('path');
const { scanMarkers } = require('../../public/markers.js');
const team = require('../protocol/handlers/team.js');
const { getWorkspace } = require('../config.js');
const { discoverAgents, parseAgentFrontmatter } = require('./discovery.js');

const DOC_ID = 'rundock-guide';

// The four action kinds the marker scan returns for agents and skills (both
// SAVE_AGENT and the legacy CREATE_AGENT scan as save_agent), and the handler
// that writes each.
const KINDS = {
  save_agent: { handler: 'handleSaveAgent', noun: 'agent', verb: 'save', past: 'saved', error: 'agent_error', card: 'SaveAgent' },
  save_skill: { handler: 'handleSaveSkill', noun: 'skill', verb: 'save', past: 'saved', error: 'skill_error', card: 'SaveSkill' },
  delete_skill: { handler: 'handleDeleteSkill', noun: 'skill', verb: 'delete', past: 'deleted', error: 'skill_error', card: 'DeleteSkill' },
  delete_agent: { handler: 'handleDeleteAgent', noun: 'agent', verb: 'delete', past: 'deleted', error: 'agent_error', card: 'DeleteAgent' },
};

// The composition root's handler context (roster caches, the boundary guard,
// the broadcast), wired once at boot.
let ctx = null;
/** @param {any} next the server's WS handler context */
function wireTeamMarkers(next) { ctx = next; }

const seams = {
  /** The agent and skill actions in a turn's text, in the scan's order. @param {string} text */
  scan: (text) => scanMarkers(text).actions.filter((a) => Object.prototype.hasOwnProperty.call(KINDS, a.kind)),
  /** Who wrote the turn: the agent id recorded on its entry, or null. @param {any} entry */
  authorOf: (entry) => (entry && typeof entry.agentId === 'string' && entry.agentId ? entry.agentId : null),
};

/** @param {any} payload */
function broadcast(payload) {
  if (ctx && typeof ctx.broadcast === 'function') ctx.broadcast(typeof payload === 'string' ? payload : JSON.stringify(payload));
}

/** @param {string|null} agentId */
function displayNameOf(agentId) {
  if (!agentId) return 'An agent';
  try {
    const agent = discoverAgents().find((a) => a.id === agentId);
    if (agent && agent.displayName) return agent.displayName;
  } catch (e) { /* the id still names it */ }
  return agentId;
}

/** @param {{kind: string, name: string}} action */
function asked(action) {
  const k = KINDS[action.kind];
  return `${k.verb} the ${k.noun} "${action.name}"`;
}

/** The line a person reads when an agent other than Doc asks. @param {string} who @param {{kind: string, name: string}} action */
function refusalLine(who, action) {
  return `${who} asked to ${asked(action)}, but only Doc can change the team, so nothing was ${KINDS[action.kind].past}. Ask Doc to make this change.`;
}

/** @param {string|null|undefined} content an agent file's text */
function declaresPlatform(content) {
  return String(parseAgentFrontmatter(content || '').type || '').trim().toLowerCase() === 'platform';
}

// The agent file a save would replace, as it is on disk now, or null when
// there is none or the name is one the save refuses. A read that fails for
// any other reason throws, and nothing is written.
/** @param {string} name */
function existingAgentFile(name) {
  const workspace = getWorkspace();
  if (!workspace || !ctx || !ctx.agents || !ctx.agents.validateAgentSlug(name)) return null;
  try {
    return fs.readFileSync(path.join(workspace, '.claude', 'agents', `${name}.md`), 'utf-8');
  } catch (e) {
    if (e && /** @type {any} */ (e).code === 'ENOENT') return null;
    throw e;
  }
}

// Doc's own file and platform identity are never written by a marker, Doc's
// included: the id `rundock-guide`, an agent file declaring `type: platform`,
// or a save over an existing file that declares it, whatever the new content
// declares.
/** @param {{kind: string, name: string, content?: string}} action */
function platformLine(action) {
  if (action.kind !== 'save_agent' && action.kind !== 'delete_agent') return null;
  let platform = action.name === DOC_ID;
  if (!platform && action.kind === 'save_agent') {
    platform = declaresPlatform(action.content) || declaresPlatform(existingAgentFile(action.name));
  }
  if (!platform) return null;
  return `Doc asked to ${asked(action)}, but Doc's own file and platform agents cannot be changed from a reply, so nothing was ${KINDS[action.kind].past}.`;
}

/**
 * @param {{kind: string, name: string}} action
 * @param {string|null} author
 * @param {'refused'|'error'} outcome
 * @param {string} message
 * @param {string|null} conversationId
 */
function notWritten(action, author, outcome, message, conversationId) {
  const k = KINDS[action.kind];
  broadcast({ type: k ? k.error : 'agent_error', message, ...(outcome === 'refused' ? { refused: true } : {}), ...(conversationId ? { conversationId } : {}) });
  return { kind: action.kind, name: action.name, author, outcome, message };
}

// Doc's change, written by the same handler a window's message used to reach,
// with its replies broadcast to every window rather than one socket.
/** @param {{kind: string, name: string, content?: string}} action @param {string|null} conversationId */
function write(action, conversationId) {
  const k = KINDS[action.kind];
  const replies = [];
  const ws = { readyState: 1, send: (/** @type {string} */ payload) => { replies.push(payload); broadcast(payload); } };
  const msg = action.kind === 'delete_agent'
    ? { type: action.kind, agentId: action.name }
    : { type: action.kind, name: action.name, ...(action.kind.startsWith('save') ? { content: action.content } : {}) };
  /** @type {any} */ (team)[k.handler](ctx, ws, { ...msg, ...(conversationId ? { conversationId } : {}) });
  for (const raw of replies) {
    let m;
    try { m = JSON.parse(raw); } catch (e) { continue; }
    if (m.type === 'agent_saved' || m.type === 'skill_saved') return { outcome: m.updated ? 'updated' : 'saved' };
    if (m.type === 'agent_deleted' || m.type === 'skill_deleted') return { outcome: 'deleted' };
    if (m.type === k.error) return { outcome: 'error', message: m.message };
  }
  return null;
}

// What a change would do on disk now and the file it touches, or why it
// cannot be made, in the handlers' own words: decided before a card is raised,
// and again once it is allowed.
/** @param {{kind: string, name: string}} action @returns {{does?: string, file?: string, why?: string}} */
function onDisk(action) {
  const workspace = getWorkspace();
  const k = KINDS[action.kind];
  if (action.kind === 'delete_agent') {
    const target = discoverAgents().find((a) => a.id === action.name);
    if (!target || !target.fileName || !fs.existsSync(path.join(workspace, '.claude', 'agents', target.fileName))) return { why: `Agent "${action.name}" not found.` };
    if (target.type === 'platform') return { why: 'Cannot delete platform agents.' };
    return { does: 'delete', file: `.claude/agents/${target.fileName}` };
  }
  if (!ctx.agents.validateAgentSlug(action.name)) {
    return { why: action.kind === 'delete_skill' ? 'Invalid skill name.' : `Invalid ${k.noun} name. Use lowercase letters, numbers, and hyphens only.` };
  }
  const parts = action.kind === 'save_agent' ? ['agents', `${action.name}.md`] : ['skills', action.name, ...(action.kind === 'save_skill' ? ['SKILL.md'] : [])];
  const there = fs.existsSync(path.join(workspace, '.claude', ...parts));
  if (action.kind === 'delete_skill' && !there) return { why: `Skill "${action.name}" not found.` };
  return { does: action.kind === 'delete_skill' ? 'delete' : (there ? 'replace' : 'add'), file: ['.claude', ...parts].join('/') };
}

/** The line for a card that did not end in an Allow given on it. @param {{kind: string, name: string}} action @param {string} reason */
function unanswered(action, reason) {
  const why = reason === 'user' ? 'it was not allowed on the card'
    : reason === 'cancelled' ? 'the turn was cancelled before the card was answered'
      : reason === 'restart' ? 'Rundock stopped before anyone answered the card' : 'nobody answered the card in time';
  return `Doc asked to ${asked(action)}, but ${why}, so nothing was ${KINDS[action.kind].past}.`;
}

// The change a person allowed, written by the same handler exactly as the card
// showed it, if Doc may still make it and the disk still holds what was shown.
/** @param {{kind: string, name: string}} action @param {string} does @param {string|undefined} content @param {string|null} conversationId */
function writeShown(action, does, content, conversationId) {
  const k = KINDS[action.kind];
  const why = platformLine({ ...action, content })
    || (onDisk(action).does !== does ? `Doc asked to ${asked(action)}, but the ${k.noun} changed on disk after the card was shown, so nothing was ${k.past}.` : null);
  if (why) return notWritten(action, DOC_ID, 'refused', why, conversationId);
  const result = write({ ...action, content }, conversationId);
  return result ? { kind: action.kind, name: action.name, author: DOC_ID, ...result }
    : notWritten(action, DOC_ID, 'error', `Doc asked to ${asked(action)}, but it could not be done.`, conversationId);
}

// Ask about one of Doc's changes in a hand-off. Returns its outcome when that
// is decided now, and null when the card will decide it.
/** @param {any} entry @param {{kind: string, name: string, content?: string}} action @param {string} by @param {string|null} conversationId */
function ask(entry, action, by, conversationId) {
  const k = KINDS[action.kind];
  const where = onDisk(action);
  if (where.why) return notWritten(action, DOC_ID, 'error', where.why, conversationId);
  const content = action.kind === 'save_agent' ? team.agentFileToWrite(action.content || '', where.does === 'replace')
    : (action.kind === 'save_skill' ? String(action.content || '') : undefined);
  const notes = require('./team-notes.js');
  const id = require('crypto').randomBytes(8).toString('hex');
  const cards = entry.teamCards || (entry.teamCards = { open: 0, then: null });
  let decided = false;
  const close = () => {
    decided = true;
    notes.dropCard(conversationId, id);
    if (!--cards.open && cards.then) { const then = cards.then; cards.then = null; then(); }
  };
  cards.open += 1;
  notes.holdCard(conversationId, id, { kind: action.kind, name: action.name, author: DOC_ID, outcome: 'refused', message: unanswered(action, 'restart') });
  try {
    ctx.runtime.requestServerPermission({
      convoId: conversationId || '', toolName: k.card,
      toolInput: { kind: k.noun, action: where.does, name: action.name, file: where.file, by: displayNameOf(by), ...(content === undefined ? {} : { content }) },
      onDecision: (/** @type {any} */ allow, /** @type {any} */ reason, /** @type {any} */ how) => {
        if (decided) return;
        decided = true;
        let outcome;
        try {
          outcome = allow === true && how && how.card === true ? writeShown(action, String(where.does), content, conversationId)
            : notWritten(action, DOC_ID, 'refused', unanswered(action, String(reason)), conversationId);
        } catch (e) {
          outcome = notWritten(action, DOC_ID, 'error', `Doc asked to ${asked(action)}, but it could not be done (${/** @type {any} */ (e).message}).`, conversationId);
        }
        try { notes.keepOutcomes(conversationId, [outcome]); } finally { close(); }
      },
    });
  } catch (e) {
    if (!decided) {
      close();
      return notWritten(action, DOC_ID, 'error', `Doc asked to ${asked(action)}, but Rundock could not show the card, so nothing was ${k.past}.`, conversationId);
    }
  }
  return null;
}

// Run `then` once every card this entry has open is answered or has timed
// out, and at once when none is open. Doc's hand-back waits here
// (lib/delegation/engine.js), so the next turn is told what each card decided.
// One waits at a time: a later turn's hand-back replaces an earlier one's.
function afterTeamCards(entry, then) {
  const cards = entry && entry.teamCards;
  if (cards && cards.open > 0) { cards.then = then; return; }
  then();
}

/**
 * Act on the agent and skill markers in one turn's text.
 *
 * @param {any} entry the process entry whose turn just ended: its recorded
 *   agentId is the only author this reads.
 * @param {string} text the reply text the server collected from that process.
 * @param {string|null} conversationId the conversation the turn belongs to.
 * @returns {Array<{kind: string, name: string|null, author: string|null,
 *   outcome: 'saved'|'updated'|'deleted'|'refused'|'error', message?: string}>}
 *   one outcome per marker, in the scan's order, each already broadcast.
 */
function applyTeamMarkers(entry, text, conversationId) {
  let actions;
  try {
    actions = seams.scan(text || '');
  } catch (e) {
    const message = 'Rundock could not read the changes to the team this reply asked for, so nothing was changed.';
    broadcast({ type: 'agent_error', message, ...(conversationId ? { conversationId } : {}) });
    return [{ kind: 'unknown', name: null, author: null, outcome: 'error', message }];
  }
  if (!actions.length) return [];
  let author = null;
  try { author = seams.authorOf(entry); } catch (e) { author = null; }
  // Who brought Doc in: the engine's record on this entry, and only that; null
  // when the person is talking to Doc. A record that cannot be read asks.
  /** @type {string|null} */
  let by = '';
  try { by = entry.delegation ? String(entry.delegation.originalAgentId || '') : null; } catch (e) { by = ''; }
  const outcomes = [];
  for (const action of actions) {
    if (author !== DOC_ID) {
      outcomes.push(notWritten(action, author, 'refused', refusalLine(displayNameOf(author), action), conversationId));
      continue;
    }
    let result;
    try {
      const platform = platformLine(action);
      if (platform) {
        outcomes.push(notWritten(action, author, 'refused', platform, conversationId));
        continue;
      }
      if (by !== null) {
        const now = ask(entry, action, by, conversationId);
        if (now) outcomes.push(now);
        continue;
      }
      result = write(action, conversationId);
    } catch (e) {
      const reason = e && /** @type {any} */ (e).message ? ` (${/** @type {any} */ (e).message})` : '';
      outcomes.push(notWritten(action, author, 'error', `Doc asked to ${asked(action)}, but it could not be done${reason}.`, conversationId));
      continue;
    }
    if (!result) {
      outcomes.push(notWritten(action, author, 'error', `Doc asked to ${asked(action)}, but it could not be done.`, conversationId));
      continue;
    }
    outcomes.push({ kind: action.kind, name: action.name, author, ...result });
  }
  return outcomes;
}

module.exports = { applyTeamMarkers, afterTeamCards, wireTeamMarkers, refusalLine, displayNameOf, seams, DOC_ID };
