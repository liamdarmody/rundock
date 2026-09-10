'use strict';
/**
 * Conversation transcripts: the in-memory cache and its on-disk mirror at
 * .rundock/transcripts/<convoId>.json. This module OWNS convoTranscripts;
 * server.js re-exports the module's own Map through _internal BY IDENTITY
 * (tests mutate it live), so object identity is part of the public test
 * contract. Extracted from server.js verbatim; the only change is that the
 * workspace root is read from lib/config at use time.
 *
 * appendTranscript stays in the composition root for now: its body is the
 * convergence point for the signal layer and the live search reconcile,
 * which belong to later extraction slices. It builds on the primitives here.
 */

const fs = require('fs');
const path = require('path');
const { getWorkspace } = require('../config.js');
const { rundockDir } = require('./persistence.js');

const convoTranscripts = new Map(); // conversationId -> [{ role: 'user'|'agent', agent: string, text: string }]

function transcriptDir() { return path.join(rundockDir(), 'transcripts'); }

// Best-effort recovery of a corrupt (e.g. truncated) transcript JSON array.
// A transcript file is normally overwritten wholesale on the next append, so a
// mid-write truncation that JSON.parse rejects must NOT be masked as an empty
// array: doing so lets the next append clobber the file and silently wipe all
// prior history. This salvages as much history as possible instead.
// Attempt 1 balances any string/brackets left open by the truncation; attempt
// 2 keeps only the complete leading objects. Returns [] only if nothing at all
// can be recovered.
function recoverTranscriptData(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  const stack = [];
  let inString = false, escaped = false, lastCompleteObjEnd = -1;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') {
      stack.pop();
      // A complete top-level object just closed (only the outer array remains).
      if (ch === '}' && stack.length === 1 && stack[0] === '[') lastCompleteObjEnd = i;
    }
  }
  let patched = raw;
  if (inString) patched += '"';
  for (let i = stack.length - 1; i >= 0; i--) patched += stack[i] === '{' ? '}' : ']';
  try {
    const data = JSON.parse(patched);
    if (Array.isArray(data)) return data;
  } catch { /* fall through to complete-object salvage */ }
  if (lastCompleteObjEnd >= 0) {
    try {
      const data = JSON.parse(raw.slice(0, lastCompleteObjEnd + 1) + ']');
      if (Array.isArray(data)) return data;
    } catch { /* nothing recoverable */ }
  }
  return [];
}

function loadTranscript(convoId) {
  if (convoTranscripts.has(convoId)) return convoTranscripts.get(convoId);
  const file = path.join(transcriptDir(), `${convoId}.json`);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (e) {
    // File absent (or otherwise unreadable): legitimately empty history.
    const empty = [];
    convoTranscripts.set(convoId, empty);
    return empty;
  }
  try {
    const data = JSON.parse(raw);
    convoTranscripts.set(convoId, data);
    return data;
  } catch (e) {
    // File exists but is corrupt. Salvage rather than mask as empty, so the
    // next append does not overwrite recoverable history.
    const recovered = recoverTranscriptData(raw);
    convoTranscripts.set(convoId, recovered);
    return recovered;
  }
}

function saveTranscript(convoId) {
  if (!getWorkspace()) return;
  const transcript = convoTranscripts.get(convoId);
  if (!transcript) return;
  const dir = transcriptDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${convoId}.json`), JSON.stringify(transcript, null, 2));
}

function buildToolSummary(toolCalls) {
  if (!toolCalls || toolCalls.length === 0) return '';
  const seen = new Set();
  const parts = [];
  for (const tc of toolCalls) {
    const key = tc.arg ? `${tc.tool}: ${tc.arg}` : tc.tool;
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(tc.arg ? `[${tc.tool} ${tc.arg}]` : `[${tc.tool}]`);
    if (parts.length >= 10) break;
  }
  return parts.join(' ');
}

// How much of what an agent missed it is given when it comes back.
//
// MEASURED, NOT GUESSED. Across 307 transcripts and 4,449 real returns to an
// agent, the median delta is 242 characters and the worst is 232,770. Twelve
// thousand leaves 94% of returns untruncated; twenty thousand buys two more
// points for two thirds more cost.
//
// The alternative is what makes this worth capping at all: handing every
// delegate the whole conversation would have cost 47 million tokens on the
// longest real 3+ agent conversation on disk, against 89 thousand for the capped
// delta. The delta scales with what an agent missed, not with how long the
// conversation has been running, which is the property that keeps it safe.
const DELTA_CAP_CHARS = 12000;

/**
 * What happened in this conversation since an agent's own last turn.
 *
 * WHY A DELTA RATHER THAN THE TRANSCRIPT. A resumed delegate already carries its
 * own history in its session; re-sending it is pure cost and invites the agent to
 * re-process work it has already done. What it lacks is everything the OTHER
 * agents did while it was away, which is exactly what a person returning to a
 * room needs and is not given today.
 *
 * @param {{role: string, agent?: string, text?: string}[]} transcript
 * @param {string} agentId the agent coming back
 * @param {number} [cap]
 * @param {string[]} [alsoExclude] other agents whose turns the caller already
 *   carries by another route, so the delta does not repeat them.
 * @returns {{text: string|null, truncated: number, clipped: number}} `text` is
 *   null when there is nothing missed, so a caller never renders an empty
 *   section. `truncated` is how many entries the cap dropped. `clipped` is 1
 *   when a single admitted turn was itself cut short, 0 otherwise. Every return
 *   path sets all three, so a caller never reads undefined.
 */
function deltaSince(transcript, agentId, cap = DELTA_CAP_CHARS, alsoExclude = []) {
  const none = { text: null, truncated: 0, clipped: 0 };
  if (!Array.isArray(transcript) || !agentId) return none;

  let lastOwn = -1;
  for (let i = 0; i < transcript.length; i++) {
    if (transcript[i] && transcript[i].agent === agentId) lastOwn = i;
  }
  // Never here before: it has missed nothing, and the cold-spawn path already
  // gives a first-time delegate the history it needs.
  if (lastOwn === -1) return none;

  // Its own turns are excluded even when they fall inside the window: a second
  // turn of its own carries no information it does not already hold.
  // ALSO EXCLUDED: turns the caller is already sending by another route. The
  // orchestrator receives the returning specialist's final message as its own
  // block; without this it would arrive twice in one prompt.
  const skip = new Set([agentId, ...(Array.isArray(alsoExclude) ? alsoExclude : [])].filter(Boolean));
  const missed = transcript.slice(lastOwn + 1).filter((t) => t && !skip.has(t.agent));
  if (!missed.length) return none;

  // THE NOTICE COUNTS TOO. It is prepended after the loop has already spent the
  // budget, so unless its length is reserved up front the returned text runs
  // past the cap by however long the notice is: the one number this module
  // names stops being true exactly when the delta is at its largest. Reserved
  // against the worst case, because how many turns get dropped is not known
  // until the loop has run.
  const noticeBudget = missed.length > 1 ? truncationNotice(missed.length).length : 0;
  const budget = Math.max(0, cap - noticeBudget);

  // NEWEST KEPT, OLDEST DROPPED. What happened most recently is what the agent
  // is about to act on; the far end of a long absence is the part it can most
  // afford to lose.
  const kept = [];
  let size = 0;
  let clipped = 0;
  for (let i = missed.length - 1; i >= 0; i--) {
    let line = renderDeltaEntry(missed[i]);
    if (kept.length && size + line.length > budget) break;
    // A SINGLE TURN CAN EXCEED THE CAP ON ITS OWN, and the newest one is
    // admitted unconditionally so the delta is never empty. Without clipping it
    // here, one long turn passed through whole while reporting nothing was
    // truncated: measured at 232,780 characters through a 12,000 cap, which is
    // the worst case in the corpus and exactly what the cap exists to bound.
    if (line.length > budget) {
      // The clip note counts toward the budget too, or the returned text is
      // longer than the number this module names, which makes the name a lie.
      const CLIP_NOTE = '\n[…this turn was longer than the limit and is cut off here.]';
      line = line.slice(0, Math.max(0, budget - CLIP_NOTE.length)) + CLIP_NOTE;
      clipped = 1;
    }
    kept.unshift(line);
    size += line.length;
  }
  const truncated = missed.length - kept.length;

  // SAID OUT LOUD WHEN IT BIT. An agent handed a silently trimmed history has no
  // way to know it is working from a partial account, which is the same defect
  // as any other measurement that does not admit its own limits.
  const notice = truncated ? truncationNotice(truncated) : '';
  const text = notice + kept.join('\n\n');
  // A LAST UNCONDITIONAL CLAMP. The reservation above is what keeps the text
  // readable at the cap; this is what makes the bound true no matter what a
  // future caller passes for `cap`, including a cap smaller than the notice.
  return { text: text.length > cap ? text.slice(0, cap) : text, truncated, clipped };
}

/** The line that tells an agent its history was trimmed, and by how much. */
function truncationNotice(count) {
  return `[${count} earlier turn${count === 1 ? '' : 's'} omitted for length; `
    + 'ask if you need what came before this.]\n\n';
}

/** One transcript entry as the delegate reads it. */
function renderDeltaEntry(t) {
  if (!t) return '';
  if (t.role === 'user') return `USER: ${t.text || ''}`;
  return `${String(t.agent || 'agent').toUpperCase()}: ${t.text || ''}`;
}

module.exports = {
  convoTranscripts,
  transcriptDir, recoverTranscriptData,
  loadTranscript, saveTranscript, buildToolSummary,
  deltaSince, DELTA_CAP_CHARS,
};
