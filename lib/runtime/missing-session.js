'use strict';
// A SESSION CLAUDE CODE NO LONGER HAS.
//
// Claude Code keeps every session as a file on this machine and removes old
// ones on its own schedule. Rundock stores session ids so it can resume them,
// and nothing told it when one went. A resume of a removed id fails the same
// way every time, and the paths that read stored ids (a delegation, a handback)
// kept reading the same dead one back, so a conversation holding one could not
// get past it: every delegation to that agent resumed it, failed, and left the
// next attempt to do the same.
//
// This module is the one place that recognizes Claude Code's refusal and the
// one place that remembers which ids are gone, so every path that resumes, and
// the store that saves what the window sends, agree about them.

const { readConversations, writeConversations } = require('../store/persistence.js');

// Claude Code's own words when it is asked to resume an id it has no file for.
// Matched on the words rather than on the exit code, because a resume can fail
// for other reasons and only this one means the id will never work again.
const REFUSAL = 'No conversation found with session ID';

// Ids Claude Code has said it no longer has, for the life of this server.
// Session ids are unique across workspaces, so one set serves every workspace.
const expired = new Set();

/**
 * The session a process was asked to resume, read from the arguments it was
 * actually started with rather than from anything a caller remembered.
 * @param {{spawnargs?: string[]}} proc
 * @returns {string|null}
 */
function resumedSessionOf(proc) {
  const args = proc && Array.isArray(proc.spawnargs) ? proc.spawnargs : [];
  const at = args.indexOf('--resume');
  return at >= 0 && args[at + 1] ? args[at + 1] : null;
}

/**
 * The id a process was refused, when `text` is Claude Code refusing its
 * resume; null for anything else, including the same words from a process
 * that was not resuming.
 * @param {{spawnargs?: string[]}} proc
 * @param {string} text
 */
function refusedResume(proc, text) {
  if (!String(text || '').includes(REFUSAL)) return null;
  return resumedSessionOf(proc);
}

/** Remember that Claude Code no longer has this session. */
function noteExpired(sessionId) {
  if (sessionId) expired.add(sessionId);
}

/** Whether Claude Code has said it no longer has this session. */
function isExpired(sessionId) {
  return expired.has(sessionId);
}

/**
 * The same arguments without the resume, which is how a turn starts again in
 * a fresh session. Every other argument is kept, so the agent, its prompt and
 * its permissions are exactly the ones the refused resume was given.
 * @param {string[]} args
 */
function withoutResume(args) {
  const at = args.indexOf('--resume');
  return at < 0 ? args.slice() : [...args.slice(0, at), ...args.slice(at + 2)];
}

/**
 * Whether stderr written so far could still be the start of a refusal, which
 * is when none of it is shown yet: a fragment of the refusal means as little
 * to a person as the whole of it.
 *
 * Asked of the line still being written, not of everything written: a
 * warning on an earlier line (Claude Code's note that it read no stdin, for
 * one) says nothing about whether this line is a refusal.
 */
function mayBeRefusal(text) {
  const all = String(text || '');
  const so = all.slice(all.lastIndexOf('\n') + 1).trimStart();
  return so.length > 0 && REFUSAL.startsWith(so);
}

// WHAT THE PERSON SAID WHILE A RESUME WAS STILL STARTING.
//
// A message sent into a live process goes straight to its stdin. A process
// that is about to be refused never reads it, so a message sent in that
// moment (typed while the agent was starting, or one held back while a
// handoff was in progress and replayed into the new process) died with it.
// Each one is kept until the process has answered a turn, and handed to the
// turn that starts again in its place. Not until its init: nothing promises
// Claude Code sends that only once a resume is accepted, so a refusal can
// still follow it. A result proves a turn ran, so nothing is kept past it and
// nothing a live session read is sent again.

/** Keep a message written into a process that has not yet answered a turn. */
function noteUnstartedWrite(entry, content) {
  if (!entry || entry.answered) return;
  (entry.unstartedWrites || (entry.unstartedWrites = [])).push(content);
}

/** A turn's result: the session ran, so what was kept for a refusal is spent. */
function noteAnswered(entry) {
  if (!entry) return;
  entry.answered = true;
  entry.unstartedWrites = [];
}

/** Every message kept for a turn starting again, in the order they were sent. */
function takeUnstartedWrites(entry) {
  const kept = (entry && entry.unstartedWrites) || [];
  if (entry) entry.unstartedWrites = [];
  return kept;
}

// WHAT A FRESH START WITH NO PROMPT OF ITS OWN STILL NEEDS.
//
// A turn started again usually carries a prompt that brings the new session
// up to date. Some have none (a handback parked behind the person's own
// message, or paused by the circuit breaker), so the first thing the person
// says to it would otherwise reach a session that knows nothing. That first
// message, carried over or sent later, is given the catch-up in front of it.

/** Put a catch-up in front of the next message this entry is sent. */
function holdFreshCatchUp(entry, prefix) {
  if (entry && prefix) entry.freshCatchUp = prefix;
}

/** The next message, with the held catch-up in front of it, which is then spent. */
function withFreshCatchUp(entry, content) {
  const prefix = (entry && entry.freshCatchUp) || '';
  if (entry) entry.freshCatchUp = '';
  // Spent in the store too, so no later process is given it again.
  if (prefix && entry.catchUpStoredIn) storeCatchUp(entry.catchUpStoredIn, null);
  return prefix + content;
}

// AND KEPT WITH THE CONVERSATION, so it outlives the process holding it. Held
// on the entry alone, it was gone when the idle reaper ended that process, or
// the server restarted, before the next message, and that message reached a
// session that knew nothing; the circuit breaker's own notice asks the person
// to send their next message, which invites exactly that wait. So a catch-up
// still held once a fresh start has carried over what it was sent is also
// stored on the conversation's record, and the next process started for that
// agent gives it to its first message. Removed once given: it is given once.

/** Store what `entry` still holds for its next message, on its conversation. */
function storeHeldCatchUp(convoId, entry) {
  if (!entry || !entry.freshCatchUp) return;
  entry.catchUpStoredIn = convoId;
  storeCatchUp(convoId, { agentId: entry.agentId, text: entry.freshCatchUp });
}

/**
 * The catch-up stored for `agentId`'s next message in this conversation,
 * removed as it is handed over; '' when none is stored, or it is another
 * agent's. One that cannot be read is logged, removed and not given: the
 * message it was meant for still goes, without it.
 */
function takeStoredCatchUp(convoId, agentId) {
  const convo = readConversations().find((c) => c.id === convoId);
  const held = convo ? convo.freshCatchUp : null;
  if (held == null) return '';
  const readable = typeof held === 'object' && typeof held.agentId === 'string' && typeof held.text === 'string';
  if (readable && held.agentId !== agentId) return '';
  if (!readable) console.warn(`[Session] convo=${convoId} the stored catch-up could not be read; dropped`);
  storeCatchUp(convoId, null);
  return readable ? held.text : '';
}

/** Write the stored catch-up, or remove it with null. A failure costs only the catch-up. */
function storeCatchUp(convoId, value) {
  try {
    const convos = readConversations();
    const convo = convos.find((c) => c.id === convoId);
    if (!convo || (!value && convo.freshCatchUp === undefined)) return;
    if (value) convo.freshCatchUp = value;
    else delete convo.freshCatchUp;
    writeConversations(convos);
  } catch (e) {
    console.warn(`[Session] convo=${convoId} could not store the held catch-up: ${e.message}`);
  }
}

// WHAT A PERSON IS TOLD, in the two cases there are. Never the refusal itself:
// "No conversation found with session ID" names an id nobody has seen and
// says nothing about what to do next. Nor any other id: an agent with no name
// to give is "The agent".
//
// The turn started again in a fresh session, so the only news is that the
// agent's earlier context is gone, and whose.
function startingFresh(name) {
  return `${name || 'The agent'}'s previous session expired. Starting fresh.`;
}

// The turn could not be started again here, so the person is told what
// happened and what to do. The id is already forgotten, which is why sending
// again is enough.
function notResumedNotice(name) {
  return `${name || 'The agent'}'s earlier session is no longer available, so it couldn't be picked up `
    + 'where it left off. Send your message again to carry on in a fresh session.';
}

module.exports = {
  REFUSAL, resumedSessionOf, refusedResume, mayBeRefusal, noteExpired, isExpired,
  withoutResume, noteUnstartedWrite, takeUnstartedWrites, noteAnswered, holdFreshCatchUp, withFreshCatchUp,
  storeHeldCatchUp, takeStoredCatchUp, startingFresh, notResumedNotice,
};
