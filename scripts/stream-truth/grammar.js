'use strict';
// Stream-truth grammar: reduce a stream-json envelope stream to a canonical
// token sequence, and diff sequences loudly.
//
// Why this exists: the stub `claude` binary is a MODEL of the real runtime's
// stream, and 0.11.6 proved that nothing checking the model against reality
// means the suite certifies drift: 1,333 green tests validated a dead
// delegation engine because the stub emitted the consolidated assistant
// envelope end-of-message while the real CLI emits it per block, mid-message.
// This module is the comparison layer: capture reduces reality to a grammar,
// the stub reduces to the same grammar, and any divergence outside the NAMED
// known gaps fails with both shapes side by side.
//
// Real shape on 2.1.227 (captured; see captured-grammar.json):
//   rate_limit_event, system:init, system:status
//   stream_event:message_start
//   per block: content_block_start(X), deltas, assistant[X]  <- PER BLOCK,
//              BEFORE content_block_stop
//   stream_event:message_delta, stream_event:message_stop
//   (tool turns: user[tool_result], then a NEW message_start frame)
//   result:success
// No consolidated assistant envelope ever follows message_stop: that is the
// invariant the interception decision point (message_stop + result fallback)
// rests on.

// ---------------------------------------------------------------------------
// Reduction
// ---------------------------------------------------------------------------

// One envelope -> one token, or null for blank lines.
function tokenize(envelope) {
  const t = envelope.type;
  if (t === 'stream_event') {
    const ev = envelope.event || {};
    const et = ev.type;
    if (et === 'content_block_start') {
      const block = ev.content_block || {};
      return `stream_event:content_block_start(${block.type || 'unknown'})`;
    }
    if (et === 'content_block_delta') {
      const delta = ev.delta || {};
      return `stream_event:content_block_delta(${delta.type || 'unknown'})`;
    }
    return `stream_event:${et}`;
  }
  if (t === 'assistant') {
    const content = (envelope.message && envelope.message.content) || [];
    const kinds = content.map(b => b.type).join('+');
    return `assistant[${kinds}]`;
  }
  if (t === 'user') {
    const content = (envelope.message && envelope.message.content) || [];
    const kinds = Array.isArray(content) ? content.map(b => b.type || 'str').join('+') : 'str';
    return `user[${kinds}]`;
  }
  if (t === 'result') return `result:${envelope.subtype || ''}`;
  if (t === 'system') return `system:${envelope.subtype || ''}`;
  return String(t);
}

// Reduce raw jsonl text (or an array of envelope objects) to a token list
// with consecutive duplicate tokens collapsed (delta counts are model noise).
function reduceToGrammar(input) {
  const envelopes = Array.isArray(input)
    ? input
    : String(input).split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  const tokens = [];
  for (const envelope of envelopes) {
    const token = tokenize(envelope);
    if (token && tokens[tokens.length - 1] !== token) tokens.push(token);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Normalisation: the NAMED gaps between stub and reality
// ---------------------------------------------------------------------------

// Every gap the stub is allowed to have is named here, with its reason.
// Anything not on this list that differs is a FAILURE. Closing a gap means
// upgrading the stub and deleting its entry, never widening the list quietly.
const KNOWN_GAPS = [
  {
    name: 'transport-noise',
    reason: 'rate_limit_event, system:status and system:thinking_tokens carry no conversation structure; server code ignores them',
    drop: (token) => token === 'rate_limit_event' || token === 'system:status' || token === 'system:thinking_tokens',
  },
  {
    name: 'stub-omits-message_start',
    reason: 'the stub does not open messages with message_start; no server decision point reads it',
    drop: (token) => token === 'stream_event:message_start',
  },
  {
    name: 'stub-omits-thinking-blocks',
    reason: 'the stub emits no extended-thinking blocks; server treats them as passthrough',
    drop: null, // handled structurally by dropThinkingSpans
  },
  {
    name: 'stub-omits-per-block-assistant-envelopes',
    reason: 'the real CLI consolidates each block into an assistant envelope mid-message; the stub (realStream mode) omits them. Server decision points anchor on message_stop, never on these.',
    drop: (token) => token.startsWith('assistant['),
  },
  {
    name: 'tool-result-position-floats',
    reason: 'the real CLI forwards tool_result user envelopes asynchronously, so they arrive either side of the message_delta/message_stop close (both orderings observed live on 2.1.227). The server consumes only string-content user envelopes and excludes tool_result entries at every parse site, so the position is provably irrelevant; normalisation floats user envelopes to after the message close.',
    drop: null, // handled structurally by floatUserEnvelopes
  },
];

// Canonicalise the floating position of user envelopes: any user[...] token
// sitting immediately before message_delta/message_stop tokens moves after
// them, so both real-world orderings reduce to one canonical grammar.
function floatUserEnvelopes(tokens) {
  const out = [...tokens];
  let moved = true;
  while (moved) {
    moved = false;
    for (let i = 0; i < out.length - 1; i++) {
      const isUser = out[i].startsWith('user[');
      const nextIsClose = out[i + 1] === 'stream_event:message_delta' || out[i + 1] === 'stream_event:message_stop';
      if (isUser && nextIsClose) {
        [out[i], out[i + 1]] = [out[i + 1], out[i]];
        moved = true;
      }
    }
  }
  return out;
}

// Remove thinking-block spans: content_block_start(thinking) through its
// content_block_stop, including deltas and the per-block assistant envelope.
function dropThinkingSpans(tokens) {
  const out = [];
  let inThinking = false;
  for (const token of tokens) {
    if (token === 'stream_event:content_block_start(thinking)') { inThinking = true; continue; }
    if (inThinking) {
      if (token === 'stream_event:content_block_stop') inThinking = false;
      continue;
    }
    out.push(token);
  }
  return out;
}

// Apply every known gap, collapse duplicates the removals may have created.
function normalize(tokens) {
  let out = dropThinkingSpans(tokens);
  for (const gap of KNOWN_GAPS) {
    if (gap.drop) out = out.filter(t => !gap.drop(t));
  }
  out = floatUserEnvelopes(out);
  return out.filter((t, i) => out[i - 1] !== t);
}

// ---------------------------------------------------------------------------
// Invariants on the REAL capture (checked before any stub comparison)
// ---------------------------------------------------------------------------

// The contract the interception engine rests on, checked directly against
// reality. If a runtime update breaks one of these, the harness fails before
// any code change hides behind the stub.
// The grammar as STORED for invariant checking.
//
// The captured section that invariants read cannot be the normalised grammar:
// normalisation drops consolidated `assistant[...]` envelopes via the
// stub-omits-per-block-assistant-envelopes gap, and the invariant that no such
// envelope appears after the final message_stop is exactly the guard for the
// 0.11.6 interception regression. Normalise it and the guard reads nothing.
//
// It also cannot be the unreduced grammar, because two of its tokens are
// non-deterministic and neither is read by any invariant: the number of
// thinking deltas varies per run, and transport noise (rate_limit_event and
// friends) arrives in a different position each time. Storing those made every
// re-capture produce a diff whether or not anything real had moved, which
// trains a reader to skim the one artifact whose whole purpose is to be read.
//
// So: drop precisely the two noise sources, keep everything an invariant
// reads. Idempotent by construction, since both steps are filters.
function stableGrammar(tokens) {
  const transportNoise = KNOWN_GAPS.find(g => g.name === 'transport-noise');
  return dropThinkingSpans(tokens).filter(t => !transportNoise.drop(t));
}

function checkStreamInvariants(rawTokens) {
  // The documented tool_result float applies here too: a result envelope
  // drifting inside the final message close is position noise, not a
  // contract break.
  const tokens = floatUserEnvelopes(rawTokens);
  const errors = [];
  const lastStop = tokens.lastIndexOf('stream_event:message_stop');
  if (lastStop === -1) {
    errors.push('no message_stop: messages must close with message_delta + message_stop');
  } else {
    if (tokens[lastStop - 1] !== 'stream_event:message_delta') {
      errors.push(`the final message_stop is not preceded by message_delta (got "${tokens[lastStop - 1]}")`);
    }
    const after = tokens.slice(lastStop + 1);
    const strayAssistant = after.find(t => t.startsWith('assistant['));
    if (strayAssistant) {
      errors.push(`consolidated assistant envelope AFTER the final message_stop (${strayAssistant}): the message_stop decision anchor would be wrong`);
    }
  }
  const resultIndex = tokens.findIndex(t => t.startsWith('result:'));
  if (resultIndex === -1) {
    errors.push('no result envelope: turns must end with result');
  } else if (resultIndex !== tokens.length - 1) {
    errors.push(`result is not the final envelope (followed by "${tokens[resultIndex + 1]}")`);
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

// Side-by-side diff of two normalised grammars. Returns null when equal,
// otherwise a printable string with a marker on every divergent row.
function diffGrammars(expected, actual, { expectedLabel = 'captured (real CLI)', actualLabel = 'stub' } = {}) {
  const rows = Math.max(expected.length, actual.length);
  let equal = expected.length === actual.length;
  const lines = [];
  const width = Math.max(expectedLabel.length, ...expected.map(t => t.length), 10) + 2;
  lines.push(`${expectedLabel.padEnd(width)}| ${actualLabel}`);
  lines.push('-'.repeat(width) + '+' + '-'.repeat(width));
  for (let i = 0; i < rows; i++) {
    const left = expected[i] || '(absent)';
    const right = actual[i] || '(absent)';
    const same = expected[i] === actual[i];
    if (!same) equal = false;
    lines.push(`${left.padEnd(width)}| ${right}${same ? '' : '   <-- DIVERGES'}`);
  }
  return equal ? null : lines.join('\n');
}

module.exports = { tokenize, reduceToGrammar, normalize, dropThinkingSpans, floatUserEnvelopes, stableGrammar, checkStreamInvariants, diffGrammars, KNOWN_GAPS };
