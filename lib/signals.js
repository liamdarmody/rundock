'use strict';
// Signal layer, extracted verbatim from server.js as part of the server
// decomposition. The events directory and the skill-usage sidecar live
// INSIDE the current workspace, so the writers resolve getWorkspace() at
// use time: a workspace switch immediately changes where signals land.
const fs = require('fs');
const path = require('path');
const { getWorkspace } = require('./config.js');

// ── Signal layer (Build A) ─────────────────────────────────────────────────
// Local, append-only, skinny events at server-layer convergence points, so
// both runtimes are measured identically and a third runtime inherits
// measurement for free. Events carry structure, never content: no message
// text, no prompt text, no tool arguments. One write path; a capture failure
// is logged and dropped, never thrown, so instrumentation can never break
// the product. Files rotate monthly (.rundock/state/events-YYYY-MM.jsonl,
// already gitignored via .rundock/) and months older than the retention
// window are pruned when a new month begins. No settings.
const EVENTS_RETENTION_MONTHS = 6;
let _lastEventsKey = null;
function recordEvent(name, fields = {}) {
  try {
    const ws = getWorkspace();
    if (!ws) return;
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const dir = path.join(ws, '.rundock', 'state');
    const ev = { ts: now.toISOString(), e: name };
    if (fields.conv) ev.conv = fields.conv;
    if (fields.agent) ev.agent = fields.agent;
    if (fields.runtime) ev.runtime = fields.runtime;
    ev.d = fields.d || {};
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFile(path.join(dir, `events-${month}.jsonl`), JSON.stringify(ev) + '\n', (err) => {
      if (err) console.warn(`[Signals] event append failed: ${err.message}`);
    });
    const key = `${dir}|${month}`;
    if (key !== _lastEventsKey) {
      _lastEventsKey = key;
      pruneOldEventFiles(dir, now);
    }
  } catch (e) {
    console.warn(`[Signals] recordEvent failed: ${e.message}`);
  }
}

function pruneOldEventFiles(dir, now) {
  try {
    const cutoff = now.getFullYear() * 12 + now.getMonth() - EVENTS_RETENTION_MONTHS;
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^events-(\d{4})-(\d{2})\.jsonl$/);
      if (!m) continue;
      const fileMonths = parseInt(m[1], 10) * 12 + (parseInt(m[2], 10) - 1);
      if (fileMonths < cutoff) fs.unlink(path.join(dir, f), () => {});
    }
  } catch (e) { /* retention is best-effort */ }
}

// Per-skill usage sidecar (counts never live in the skill markdown). Closes
// the assigned-versus-used gap without scanning history on every audit.
// Observable on the Claude runtime only: Codex agents receive skills through
// their instruction body, so per-skill usage there is not measurable in v1;
// consumers must exempt skills whose assigned agents are not all
// Claude-runtime rather than falsely flag them.
function bumpSkillUsage(slug) {
  try {
    const ws = getWorkspace();
    if (!ws || !slug) return;
    const dir = path.join(ws, '.rundock', 'state');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'skill-usage.json');
    let usage = {};
    try { usage = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) { /* first use or unreadable: start fresh */ }
    const rec = usage[slug] || { useCount: 0, lastUsed: null };
    rec.useCount += 1;
    rec.lastUsed = new Date().toISOString();
    usage[slug] = rec;
    fs.writeFileSync(file, JSON.stringify(usage, null, 2));
  } catch (e) {
    console.warn(`[Signals] skill usage update failed: ${e.message}`);
  }
}

// Docs-gap topics normalize in code, not in a model: lowercase, punctuation
// out, stopwords dropped, so the same question asked twice produces the same
// key and the repeat-detection contract holds.
const DOCS_GAP_STOPWORDS = new Set(['a', 'an', 'the', 'how', 'what', 'why', 'when', 'where', 'who',
  'is', 'are', 'do', 'does', 'did', 'i', 'my', 'our', 'your', 'to', 'of', 'in', 'on', 'for',
  'it', 'this', 'that', 'with', 'and', 'or', 'we', 'you']);
function normalizeDocsGapTopic(topic) {
  return String(topic || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w && !DOCS_GAP_STOPWORDS.has(w))
    .join(' ');
}

module.exports = {
  recordEvent, pruneOldEventFiles, bumpSkillUsage, normalizeDocsGapTopic,
};
