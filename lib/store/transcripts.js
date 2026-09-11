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

/** What joins two turns in a rendered delta. Counted wherever budget is spent. */
const SEP = '\n\n';
const SEP_LEN = SEP.length;

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
function deltaSince(transcript, agentId, cap = DELTA_CAP_CHARS, alsoExclude = [], names = null) {
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
  // A TURN WITH NOTHING LEFT IS NOT A MISSED TURN. Once tool summaries are
  // stripped, an entry that was only `[Read /a] [Grep b]` has no content at
  // all. Dropped here rather than later so it is neither rendered as an empty
  // speaker line nor counted among the turns the cap omitted: it carried
  // nothing, so nothing was lost with it, and saying otherwise would make the
  // truncation notice overstate what the agent is missing.
  const missed = transcript.slice(lastOwn + 1)
    .filter((t) => t && !skip.has(t.agent) && renderDeltaEntryBody(t) !== '');
  if (!missed.length) return none;

  // THE NOTICE COUNTS TOO. It is prepended after the loop has already spent the
  // budget, so unless its length is reserved up front the returned text runs
  // past the cap by however long the notice is: the one number this module
  // names stops being true exactly when the delta is at its largest. Reserved
  // against the worst case, because how many turns get dropped is not known
  // until the loop has run.
  const noticeBudget = missed.length > 1 ? truncationNotice(missed.length).length : 0;
  const budget = Math.max(0, cap - noticeBudget);

  // USER TURNS ARE NEVER DROPPED. Newest-first is right for agent turns, but
  // applied to everything it discards intent and keeps elaboration: the user's
  // original request is the oldest thing in the window, so it is the first
  // thing to go, and every later turn exists to serve it. Measured on a real
  // conversation: the user's turns were 3.2% of it, and the first of them was
  // "write me a short thread on ..." with everything after it downstream of
  // that sentence.
  //
  // Reserving them is close to free and it gives the far end of a long absence
  // an anchor: the opening request survives beside the recent work rather than
  // the agent receiving the middle of a story.
  // NEWEST KEPT, OLDEST DROPPED, for everything else. What happened most
  // recently is what the agent is about to act on; the far end of a long
  // absence is the part it can most afford to lose.
  // THE SEPARATOR IS PART OF THE TEXT. kept.join(SEP) puts two characters
  // between every pair, and the admission loop used to count only the entries
  // themselves. The assembled text could then run past the cap by two
  // characters per gap, and the final clamp would chop the tail off the NEWEST
  // kept turn, the one the agent most needs, while reporting clipped: 0. Third
  // defect of this shape in this function, and all three were the same lie:
  // the metadata saying nothing was lost while something was.
  // Admitted by index, so the delta can be reassembled in the order the
  // conversation actually happened. Keeping the pinned user turns and the
  // newest agent turns in two lists and concatenating them would hand the
  // agent every question first and every answer second, which reads as a
  // different conversation from the one that took place.
  const admitted = new Set();
  let size = 0;
  let clipped = 0;
  // CLIPPED AGAINST WHAT IS LEFT, not against the whole budget.
  //
  // Clipping only a line that exceeds the FULL budget admits several turns that
  // are each comfortably under it and together are not: six user turns of 2,200
  // characters are 13,200 against a 12,000 cap, all admitted whole, and the
  // final clamp then chops the tail off the newest one. Measured: text exactly
  // at the cap, truncated 0, the cut invisible in the text. That is the fourth
  // time this function has reported that nothing was lost while something was,
  // and the first three are described in the comments above it.
  //
  // `remaining` is what the budget has left once earlier turns are paid for, so
  // a turn is cut only as much as it must be, and the cut says so.
  const CLIP_NOTE = '\n[…this turn was longer than the limit and is cut off here.]';
  const clip = (line, remaining) => {
    const room = Math.min(budget, remaining);
    if (line.length <= room) return line;
    // NO ROOM IS NOT A SHORT TURN. Below the length of the note itself there is
    // nothing useful left to say, and returning just the note kept the loop
    // going: every further turn added another ~60 characters of placeholder,
    // the assembled text ran past the cap, and the final clamp then cut the
    // tail off with `truncated` already counting those placeholders as kept.
    // Same lie as before, one loop deeper. An empty result tells the caller to
    // stop instead.
    if (room <= CLIP_NOTE.length) return '';
    clipped = 1;
    return line.slice(0, room - CLIP_NOTE.length) + CLIP_NOTE;
  };

  // The user's turns first, because they are never dropped. Their cost is
  // spent before anything competes for it.
  const rendered = missed.map((t) => renderDeltaEntry(t, names));
  for (let i = 0; i < missed.length; i++) {
    if (!missed[i] || missed[i].role !== 'user') continue;
    if (!rendered[i]) continue;
    const sep = admitted.size ? SEP_LEN : 0;
    const fitted = clip(rendered[i], budget - size - sep);
    // NEVER DROPPED TO MAKE ROOM FOR AN AGENT TURN, which is the guarantee.
    // It cannot mean more user turns than the cap can hold: when they alone
    // exhaust it the cap has to win, and the only honest thing is to stop and
    // let the notice say how many went. Oldest first, so the request the
    // conversation exists to serve is the one that survives.
    if (!fitted) break;
    rendered[i] = fitted;
    admitted.add(i);
    size += sep + rendered[i].length;
  }

  // Then agent turns, newest first, with whatever budget remains.
  let newestAgentTurn = true;
  for (let i = missed.length - 1; i >= 0; i--) {
    if (admitted.has(i) || !rendered[i]) continue;
    const sep = admitted.size ? SEP_LEN : 0;
    // CLIP BEFORE DECIDING, always. The old single loop admitted the newest
    // entry unconditionally and clipped it if it alone exceeded the cap, so the
    // turn the agent is about to act on was always represented. Splitting the
    // loop lost that: a pinned user turn makes admitted.size nonzero before
    // this loop starts, so the newest agent turn was measured at full length
    // against the remaining budget and dropped whole, with thousands of
    // characters of room left and clip() never called. Measured: a 20,000
    // character turn dropped entirely with 11,400 characters free.
    // THE NEWEST IS CLIPPED; OLDER ONES ARE DROPPED WHOLE.
    //
    // The turn the agent is about to act on must be represented even if it
    // alone exceeds the budget, so the first candidate here is clipped to fit
    // rather than dropped. Splitting the loop had lost that: a pinned user
    // turn made admitted.size nonzero, the newest agent turn was measured at
    // full length and dropped entire with thousands of characters free.
    //
    // Older turns are a different case. A fragment of the far end of a long
    // absence is worth less than a clean notice saying it went, and clipping
    // them to fill the remaining space would hand the agent the middle of a
    // sentence from something it can most afford to lose.
    if (newestAgentTurn) {
      const fitted = clip(rendered[i], budget - size - sep);
      newestAgentTurn = false;
      if (!fitted) break;
      rendered[i] = fitted;
    } else if (size + sep + rendered[i].length > budget) {
      break;
    }
    admitted.add(i);
    size += sep + rendered[i].length;
  }

  const kept = [];
  for (let i = 0; i < missed.length; i++) if (admitted.has(i)) kept.push(rendered[i]);
  const truncated = missed.length - kept.length;

  // SAID OUT LOUD WHEN IT BIT. An agent handed a silently trimmed history has no
  // way to know it is working from a partial account, which is the same defect
  // as any other measurement that does not admit its own limits.
  const notice = truncated ? truncationNotice(truncated) : '';
  const text = notice + kept.join(SEP);
  // A LAST UNCONDITIONAL CLAMP, AND IT ADMITS WHEN IT FIRES. The reservation
  // above is what keeps the text readable at the cap; this makes the bound
  // true whatever `cap` a caller passes, including one smaller than the
  // notice. If it ever trims a byte, the caller is told: a clamp that cuts
  // content while reporting clipped: 0 is the defect, not the cut.
  if (text.length > cap) return { text: text.slice(0, cap), truncated, clipped: 1 };
  return { text, truncated, clipped };
}

/** The line that tells an agent its history was trimmed, and by how much. */
function truncationNotice(count) {
  return `[${count} earlier turn${count === 1 ? '' : 's'} omitted for length; `
    + 'ask if you need what came before this.]\n\n';
}

// A turn's leading tool-call summary: `[Read /path] [WebFetch https://...]`.
// Stored on the turn so the conversation can show HOW work was done.
// buildToolSummary writes its groups as one line and the turn's own text
// follows after a newline, so the line is the unit to remove, not a run of
// bracket groups. Matching groups character by character breaks on a bracket
// INSIDE a command, which is ordinary: `[Bash grep '[abc]' file.txt]` matched
// only as far as the `]` in `[abc]`, leaving `' file.txt]` glued to the front
// of what the agent actually said. That is both summary residue and a
// corruption of the agent's own words.
/**
 * Is this line nothing but tool-call groups?
 *
 * buildToolSummary writes `[Tool arg] [Tool] [Tool arg]` and the turn's own
 * text follows on the next line, so the unit to remove is the line. Deciding
 * that with a regex fails in both directions:
 *
 *   /^(?:\[[^\]]*\]\s*)+/  stops at a `]` INSIDE a command, so
 *                            `[Bash grep '[abc]' file.txt]` was half-stripped
 *                            and the remainder glued to the agent's words.
 *   /^\[.*\]\s*$/           strips any line that opens and closes with a
 *                            bracket, so `[IMPORTANT] read this first]` loses
 *                            its whole first line, and a one-line message of
 *                            that shape vanishes from the delta entirely,
 *                            counted as a turn omitted for length.
 *
 * Counting depth answers both: a summary line is groups and whitespace and
 * nothing else, whatever the groups contain.
 */
function isToolSummaryLine(line) {
  const t = line.trim();
  if (!t.startsWith('[')) return false;
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '[') depth++;
    else if (c === ']') { if (--depth < 0) return false; }
    // Between groups only whitespace is allowed. Prose outside a group means
    // this is someone writing, not a summary.
    else if (depth === 0 && !/\s/.test(c)) return false;
  }
  return depth === 0;
}

/**
 * One transcript entry as the delegate reads it.
 *
 * TOOL SUMMARIES ARE DROPPED. A returning agent is being told what happened
 * while it was away, and `[ToolSearch] [Read /Users/...] [WebFetch ...]` is a
 * record of how a turn was carried out rather than what it found. Measured on
 * a real conversation: 8.1% of the transcript, and one of the two turns the
 * cap dropped in a live handoff was tool summary and nothing else. Spending
 * budget on it costs the substance further down the list.
 *
 * The summary stays in the transcript, so the conversation still shows it to
 * the person. Only the catch-up drops it.
 */
/**
 * @param {Record<string,string>} [names] agent id to the name people use
 */
function renderDeltaEntry(t, names) {
  const body = renderDeltaEntryBody(t);
  if (!body) return '';
  if (t.role === 'user') return `USER: ${body}`;
  // THE NAME THEY ARE CALLED BY, not the id they are filed under. An agent's
  // roster lists Ren, Sage and Vox, and the agents address each other that way
  // in their own text ("That's the full list, Ren"). Labelling the same turns
  // RESEARCH-LEAD and FACT-CHECKER asks the reader to hold two naming schemes
  // at once, and `default` for the orchestrator names nobody at all.
  const id = String(t.agent || 'agent');
  const shown = (names && names[id]) || id;
  return `${shown.toUpperCase()}: ${body}`;
}

// The handoff markers, which are control signals between the server and one
// agent, never content for another. Left in, a returning agent reads someone
// else's RUNDOCK:CONTINUE as part of what was said to it.
const HANDOFF_MARKERS = /<!--\s*RUNDOCK:(?:RETURN|COMPLETE|CONTINUE)\s*-->/g;

/** What a turn says once the record of how it was done is removed. */
function renderDeltaEntryBody(t) {
  if (!t) return '';
  const raw = String(t.text || '');
  const nl = raw.indexOf('\n');
  const first = nl === -1 ? raw : raw.slice(0, nl);
  const rest = nl === -1 ? '' : raw.slice(nl + 1);
  // Only when the whole first line is bracket groups. A turn that merely
  // begins with a bracket keeps its text.
  const body = isToolSummaryLine(first) ? rest : raw;
  return body.replace(HANDOFF_MARKERS, '').trim();
}

module.exports = {
  convoTranscripts,
  transcriptDir, recoverTranscriptData,
  loadTranscript, saveTranscript, buildToolSummary,
  deltaSince, DELTA_CAP_CHARS,
};
