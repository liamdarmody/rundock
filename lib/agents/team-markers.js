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
// Seams for tests are the `seams` members, patched in-process. There is no
// environment variable, argument or file that changes any of this.
const { scanMarkers } = require('../../public/markers.js');
const team = require('../protocol/handlers/team.js');
const { discoverAgents, parseAgentFrontmatter } = require('./discovery.js');

const DOC_ID = 'rundock-guide';

// The four action kinds the marker scan returns for agents and skills (both
// SAVE_AGENT and the legacy CREATE_AGENT scan as save_agent), and the handler
// that writes each.
const KINDS = {
  save_agent: { handler: 'handleSaveAgent', noun: 'agent', verb: 'save', past: 'saved', error: 'agent_error' },
  save_skill: { handler: 'handleSaveSkill', noun: 'skill', verb: 'save', past: 'saved', error: 'skill_error' },
  delete_skill: { handler: 'handleDeleteSkill', noun: 'skill', verb: 'delete', past: 'deleted', error: 'skill_error' },
  delete_agent: { handler: 'handleDeleteAgent', noun: 'agent', verb: 'delete', past: 'deleted', error: 'agent_error' },
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

// Doc's own file and platform identity are never written by a marker, Doc's
// included: the id `rundock-guide`, or an agent file declaring `type: platform`.
/** @param {{kind: string, name: string, content?: string}} action */
function platformLine(action) {
  if (action.kind !== 'save_agent' && action.kind !== 'delete_agent') return null;
  let platform = action.name === DOC_ID;
  if (!platform && action.kind === 'save_agent') {
    platform = String(parseAgentFrontmatter(action.content || '').type || '').trim().toLowerCase() === 'platform';
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
  const outcomes = [];
  for (const action of actions) {
    if (author !== DOC_ID) {
      outcomes.push(notWritten(action, author, 'refused', refusalLine(displayNameOf(author), action), conversationId));
      continue;
    }
    const platform = platformLine(action);
    if (platform) {
      outcomes.push(notWritten(action, author, 'refused', platform, conversationId));
      continue;
    }
    let result;
    try {
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

module.exports = { applyTeamMarkers, wireTeamMarkers, refusalLine, seams, DOC_ID };
