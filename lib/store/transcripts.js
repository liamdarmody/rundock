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

module.exports = {
  convoTranscripts,
  transcriptDir, recoverTranscriptData,
  loadTranscript, saveTranscript, buildToolSummary,
};
