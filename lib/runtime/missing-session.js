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
 */
function mayBeRefusal(text) {
  const so = String(text || '').trimStart();
  return so.length > 0 && REFUSAL.startsWith(so);
}

// WHAT THE PERSON SAID WHILE A RESUME WAS STILL STARTING.
//
// A message sent into a live process goes straight to its stdin. A process
// that is about to be refused never reads it, so a message sent in that
// moment (typed while the agent was starting, or one held back while a
// handoff was in progress and replayed into the new process) died with it.
// Each one is kept until the process has started its session, which is
// exactly when a refusal can no longer happen, and handed to the turn that
// starts again in its place.

/** Keep a message written into a process that has not started its session. */
function noteUnstartedWrite(entry, content) {
  if (!entry || entry.sessionId) return;
  (entry.unstartedWrites || (entry.unstartedWrites = [])).push(content);
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
  return prefix + content;
}

// WHAT A PERSON IS TOLD, in the two cases there are. Never the refusal itself:
// "No conversation found with session ID" names an id nobody has seen and
// says nothing about what to do next.
//
// The turn started again in a fresh session, so the only news is that the
// agent's earlier context is gone, and whose.
function startingFresh(name) {
  return `${name}'s previous session expired. Starting fresh.`;
}

// The turn could not be started again here, so the person is told what
// happened and what to do. The id is already forgotten, which is why sending
// again is enough.
function notResumedNotice(name) {
  return `${name}'s earlier session is no longer available, so it couldn't be picked up `
    + 'where it left off. Send your message again to carry on in a fresh session.';
}

module.exports = {
  REFUSAL, resumedSessionOf, refusedResume, mayBeRefusal, noteExpired, isExpired,
  withoutResume, noteUnstartedWrite, takeUnstartedWrites, holdFreshCatchUp, withFreshCatchUp,
  startingFresh, notResumedNotice,
};
