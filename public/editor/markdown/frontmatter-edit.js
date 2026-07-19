// Byte-honest frontmatter property editing. The raw YAML block is the
// source of truth on save (pipeline.js), so editing a property is surgical
// line replacement inside that block: the edited key's lines change,
// every other byte of the block stays identical. No YAML re-emission, no
// reformatting of untouched keys: the byte-honesty rule from the story
// ("editing one property changes only that property").
//
// Scope matches the panel: top-level scalar values (string, number, date,
// bool) and lists (block `- item` style or flow `[a, b]` style). Nested
// objects are not editable (the panel hides them).

import { extractFrontmatter } from './frontmatter.js';

// A bare YAML scalar would misparse for these shapes: quote them.
function needsQuoting(s) {
  if (s === '') return true;
  if (/^[\s]|[\s]$/.test(s)) return true;
  if (/^[\[\]{}&*!|>%@`"',#-]/.test(s)) return true; // leading indicator chars (covers [[wikilinks]])
  if (/: |\s#/.test(s)) return true;
  if (/^(true|false|null|~|yes|no|on|off)$/i.test(s)) return true;
  if (/^-?\d+(\.\d+)?$/.test(s)) return true;
  return false;
}

// Format one scalar, preserving the old value's quote style where possible.
function formatScalar(newValue, oldRaw) {
  const s = String(newValue);
  const old = (oldRaw || '').trim();
  if (typeof newValue === 'boolean' || typeof newValue === 'number') return String(newValue);
  if (old.startsWith('"')) return JSON.stringify(s);
  if (old.startsWith("'")) return `'${s.replace(/'/g, "''")}'`;
  return needsQuoting(s) ? JSON.stringify(s) : s;
}

function isTopLevelKeyLine(line) {
  return /^[^\s#-][^:\n]*:/.test(line);
}

// If `valueText` (everything after the `key:`) opens a quoted scalar, return
// the quote character; otherwise null. A quote that also closes on the same
// line is a single-line scalar and returns null (no continuation to track).
function opensUnclosedQuote(valueText) {
  const trimmed = valueText.replace(/^[ \t]*/, '');
  const quote = trimmed[0];
  if (quote !== '"' && quote !== "'") return null;
  return quoteCloses(trimmed, quote, 1) ? null : quote;
}

// Does a closing `quote` occur in `text` at or after `from`? Honours YAML
// escaping: backslash escapes inside double quotes, doubled quotes inside
// single quotes.
function quoteCloses(text, quote, from) {
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (quote === '"') {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') return true;
    } else {
      if (ch === "'") {
        if (text[i + 1] === "'") { i++; continue; }
        return true;
      }
    }
  }
  return false;
}

// The scalar value of a `- item` line, unquoted, for matching survivors
// against the panel's new string array (which are always strings).
function parseItemScalar(line) {
  const raw = line.replace(/^\s*-\s+/, '').trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    const inner = raw.slice(1, -1);
    return raw[0] === "'" ? inner.replace(/''/g, "'") : inner;
  }
  return raw;
}

// Locate a top-level key inside the raw block's lines. Returns
// { keyLine, valueStart, valueEnd } where [valueStart, valueEnd) are the
// indented/list continuation lines following the key line, or null.
function locateKey(lines, key) {
  // Line 0 is the opening ---; the closing --- ends the searchable region.
  let close = lines.length;
  for (let i = 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i])) { close = i; break; }
  }
  for (let i = 1; i < close; i++) {
    const m = lines[i].match(/^([^\s#-][^:\n]*):/);
    if (!m || m[1].trim() !== key) continue;
    // A double/single-quoted scalar can continue on UNINDENTED lines at
    // column 0 until its closing quote. locateKey used to miss that, so the
    // continuation (which may itself look like `other: key`) was left behind
    // and promoted to a spurious top-level key on edit. Consume those lines
    // first so the multi-line refusal below fires.
    const valueText = lines[i].slice(lines[i].indexOf(':') + 1);
    const openQuote = opensUnclosedQuote(valueText);
    if (openQuote) {
      let end = i + 1;
      while (end < close && !quoteCloses(lines[end], openQuote, 0)) end++;
      // The line that closes the quote is part of the value; include it.
      if (end < close) end++;
      return { keyLine: i, valueStart: i + 1, valueEnd: end, close };
    }
    // Continuation lines: indented (nested map / indented list / wrapped
    // scalar), a zero-indent `- ` block-list item (Obsidian writes lists at
    // column 0), or a blank line followed by more of either.
    const isContinuation = (l) => /^\s+\S/.test(l) || /^-\s/.test(l);
    let end = i + 1;
    while (end < close && (isContinuation(lines[end]) || (/^\s*$/.test(lines[end]) && end + 1 < close && isContinuation(lines[end + 1])))) end++;
    return { keyLine: i, valueStart: i + 1, valueEnd: end, close };
  }
  return null;
}

// Replace a top-level property's value in the raw frontmatter block.
// newValue: string | number | boolean | array of strings.
// Returns { raw, changed }; unlocatable keys and unsupported shapes return
// changed:false with the block untouched (never a guess).
export function replaceProperty(raw, key, newValue) {
  if (typeof raw !== 'string' || !raw.startsWith('---')) return { raw, changed: false };
  const lines = raw.split('\n');
  const loc = locateKey(lines, key);
  if (!loc) return { raw, changed: false };

  const keyLine = lines[loc.keyLine];
  const after = keyLine.slice(keyLine.indexOf(':') + 1);
  const keyPart = keyLine.slice(0, keyLine.indexOf(':') + 1);

  if (Array.isArray(newValue)) {
    const spacing = after.match(/^[ \t]*/)[0];
    const flow = after.trim().startsWith('[');
    const blockItems = lines.slice(loc.valueStart, loc.valueEnd).filter((l) => /^\s*- /.test(l));
    if (flow) {
      // Flow style [a, b]: re-emit in flow. Flow context adds its own
      // hazards (commas, brackets) on top of the plain-scalar rules.
      const flowFormat = (v) => {
        if (typeof v === 'boolean' || typeof v === 'number') return String(v);
        const s = String(v);
        return (needsQuoting(s) || /[,\[\]{}]/.test(s)) ? JSON.stringify(s) : s;
      };
      const items = newValue.map(flowFormat).join(', ');
      lines[loc.keyLine] = `${keyPart}${spacing || ' '}[${items}]`;
      lines.splice(loc.valueStart, loc.valueEnd - loc.valueStart);
    } else if (newValue.length === 0) {
      lines[loc.keyLine] = `${keyPart}${spacing || ' '}[]`;
      lines.splice(loc.valueStart, loc.valueEnd - loc.valueStart);
    } else {
      // Block style, byte-honest: keep each surviving item's ORIGINAL line
      // verbatim (its indentation, quote style, and scalar type), so an edit
      // that removes one item touches only that item's bytes. Only genuinely
      // new values are formatted, using an existing item as the style
      // template (indent + quote style), or the vault default.
      const template = blockItems[0] || '  - "x"';
      const indent = template.match(/^\s*/)[0];
      const oldItemRaw = template.replace(/^\s*- /, '');
      const available = blockItems.map((l) => ({ raw: l, value: parseItemScalar(l), used: false }));
      const itemLines = newValue.map((v) => {
        const want = String(v);
        const hit = available.find((it) => !it.used && it.value === want);
        if (hit) { hit.used = true; return hit.raw; }
        return `${indent}- ${formatScalar(v, oldItemRaw)}`;
      });
      lines.splice(loc.valueStart, loc.valueEnd - loc.valueStart, ...itemLines);
    }
    return { raw: lines.join('\n'), changed: true };
  }

  // (list edits go through editListItem, which is index-based and never
  // reparses survivors; the Array branch above is kept only for direct
  // full-list replacement callers.)

  // Scalar. Refuse whenever the key has ANY continuation lines: a nested
  // object/list (empty inline value) OR a block/folded/multi-line scalar
  // (`title: >` + indented lines, or a plain scalar wrapped across lines).
  // Editing only the key line there would leave the stale continuation body
  // behind, and for a plain multi-line scalar the result is still valid YAML
  // that silently merges the old body into the new value. Refuse; the panel
  // snaps back to the file's truth.
  if (loc.valueEnd > loc.valueStart) return { raw, changed: false };
  const spacing = after.match(/^[ \t]*/)[0] || ' ';
  // Preserve a trailing comment if one sits after the value? YAML comments
  // in property lines are rare in this vault; a value edit replaces the
  // whole remainder deliberately (documented behaviour).
  lines[loc.keyLine] = `${keyPart}${spacing}${formatScalar(newValue, after.trim())}`;
  return { raw: lines.join('\n'), changed: true };
}

// General byte-honesty backstop. Given the frontmatter block before and after
// an edit to `key`, confirm the edit touched nothing else: the set of
// top-level keys is unchanged, and every key other than `key` keeps its exact
// parsed value. Catches any valid-but-wrong transform (a truncation that
// invents a key, a collateral value change) that still parses as a valid
// object. Returns true when the edit is honest, false otherwise. On a parse
// failure it returns false (refuse rather than guess).
export function onlyEditedKeyChanged(beforeRaw, afterRaw, key) {
  const before = extractFrontmatter(beforeRaw);
  const after = extractFrontmatter(afterRaw);
  if (!before.parsed || typeof before.parsed !== 'object') return false;
  if (!after.parsed || typeof after.parsed !== 'object') return false;
  const beforeKeys = Object.keys(before.parsed);
  const afterKeys = Object.keys(after.parsed);
  if (beforeKeys.length !== afterKeys.length) return false;
  const afterSet = new Set(afterKeys);
  for (const k of beforeKeys) {
    if (!afterSet.has(k)) return false;
    if (k === key) continue;
    if (JSON.stringify(before.parsed[k]) !== JSON.stringify(after.parsed[k])) return false;
  }
  return true;
}

// Byte-honest single-item list edit. mutation is { remove: index } or
// { add: valueString }. Untouched item lines are NEVER re-parsed or
// re-emitted: a removal splices out exactly one line, an add appends one
// formatted line. This sidesteps the survivor-matching hazard entirely
// (a `- ~`, a comment-bearing item, or a quote-twin can never be corrupted
// by editing a DIFFERENT item). Returns { raw, changed }.
export function editListItem(raw, key, mutation) {
  if (typeof raw !== 'string' || !raw.startsWith('---')) return { raw, changed: false };
  const lines = raw.split('\n');
  const loc = locateKey(lines, key);
  if (!loc) return { raw, changed: false };
  const keyLine = lines[loc.keyLine];
  const after = keyLine.slice(keyLine.indexOf(':') + 1);
  const keyPart = keyLine.slice(0, keyLine.indexOf(':') + 1);
  const spacing = after.match(/^[ \t]*/)[0] || ' ';
  const flow = after.trim().startsWith('[');

  // Flow lists ([a, b]) have no per-item bytes to preserve (single line);
  // parse, mutate, re-emit. Block lists are edited by line, byte-honestly.
  if (flow) {
    const inner = after.trim().replace(/^\[/, '').replace(/\]\s*$/, '').trim();
    const items = inner ? inner.match(/(?:"[^"]*"|'[^']*'|[^,])+/g).map((s) => s.trim()) : [];
    if (mutation.remove != null) {
      if (mutation.remove < 0 || mutation.remove >= items.length) return { raw, changed: false };
      items.splice(mutation.remove, 1);
    } else if (mutation.add != null) {
      const s = String(mutation.add);
      items.push((needsQuoting(s) || /[,\[\]{}]/.test(s)) ? JSON.stringify(s) : s);
    }
    lines[loc.keyLine] = `${keyPart}${spacing}[${items.join(', ')}]`;
    return { raw: lines.join('\n'), changed: true };
  }

  // Block: the item lines within the value region, with their line indices.
  const itemLineIdxs = [];
  for (let i = loc.valueStart; i < loc.valueEnd; i++) if (/^\s*- /.test(lines[i])) itemLineIdxs.push(i);

  if (mutation.remove != null) {
    if (mutation.remove < 0 || mutation.remove >= itemLineIdxs.length) return { raw, changed: false };
    lines.splice(itemLineIdxs[mutation.remove], 1);
    // Last item gone: collapse to an inline empty list so the key stays valid.
    if (itemLineIdxs.length === 1) lines[loc.keyLine] = `${keyPart}${spacing}[]`;
    return { raw: lines.join('\n'), changed: true };
  }
  if (mutation.add != null) {
    const template = itemLineIdxs.length ? lines[itemLineIdxs[0]] : '  - "x"';
    const indent = template.match(/^\s*/)[0];
    const oldItemRaw = template.replace(/^\s*- /, '');
    const newLine = `${indent}- ${formatScalar(mutation.add, oldItemRaw)}`;
    if (itemLineIdxs.length) {
      lines.splice(itemLineIdxs[itemLineIdxs.length - 1] + 1, 0, newLine);
    } else {
      // Was inline `key: []` or empty: convert to a block list.
      lines[loc.keyLine] = `${keyPart}`;
      lines.splice(loc.keyLine + 1, 0, newLine);
    }
    return { raw: lines.join('\n'), changed: true };
  }
  return { raw, changed: false };
}
