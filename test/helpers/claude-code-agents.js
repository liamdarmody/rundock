'use strict';
// HOW CLAUDE CODE READS AN AGENT FILE, for tests that cannot run Claude Code.
//
// CI has no Claude Code, and the question these tests ask is one only Claude
// Code can settle: would it load this file? It drops an agent file it cannot
// read with no error anybody sees, and a --print run started with --agent
// naming that agent then stops at once, before any session exists, with one
// line on stderr and exit code 1:
//
//   --agent 'lead' not found. Available agents: claude, Explore, ...
//
// It says exactly that for each of the three reasons a file does not load: no
// `name:`, no `description:`, or frontmatter its YAML reader cannot read. This
// module models all three, and the line.
//
// WHAT THE MODEL IS. A strict reader for the part of YAML agent frontmatter
// uses: block mappings and sequences, plain, single-quoted and double-quoted
// values, flow lists of plain or quoted items, block scalars, and comments. It
// refuses what a YAML reader refuses: a colon and a space inside a plain
// value, a value that starts with a backtick or an @, a quoted value with more
// text after its closing quote, a duplicated key, a tab in the indentation.
// And it refuses anything outside that subset (an anchor, a tag, a flow
// mapping, a quoted value over several lines) rather than guess at it. So it
// can call a file unreadable that Claude Code would load, which a test author
// meets as a loud failure, and it does not call a file loadable that Claude
// Code would drop, which is the direction a test of loading has to trust.
//
// ONE LENIENCY IS CLAUDE CODE'S OWN, as observed against the real CLI: a value
// on a top-level line that breaks the YAML is retried in quotes, so a stray
// colon in `description:` costs nothing, and only a value nested under another
// key (a routine's prompt, a starter prompt) loses the whole file.
//
// Confirming this against the real CLI is a release step rather than a test:
// CI cannot run it.

const fs = require('node:fs');
const path = require('node:path');

class YamlError extends Error {}
function fail(line, why) { throw new YamlError(`line ${line + 1}: ${why}`); }

const indentOf = (raw) => raw.length - raw.replace(/^ */, '').length;
const skippable = (raw) => /^\s*(#.*)?$/.test(raw);
const startsSequence = (content) => content === '-' || content.startsWith('- ');
// A plain key, its colon, and the space after it (or the end of the line).
const ENTRY = /^([A-Za-z0-9_][A-Za-z0-9_ .-]*?) *:(?:[ \t]+|$)/;
const leadingBlanks = (text) => text.length - text.replace(/^[ \t]+/, '').length;

/**
 * The value a YAML document holds, or a YamlError saying why it cannot be read.
 * Types are YAML 1.2's core schema: null, booleans, numbers and strings.
 */
function readYaml(text) {
  const lines = String(text).split('\n');
  lines.forEach((raw, i) => { if (!skippable(raw) && /^ *\t/.test(raw)) fail(i, 'a tab in the indentation'); });
  const st = { lines, at: 0 };
  skip(st);
  if (st.at >= lines.length) return null;
  const top = indentOf(lines[st.at]);
  const value = readBlock(st, top, -1);
  skip(st);
  if (st.at < lines.length) fail(st.at, 'this line does not fit the indentation above it');
  return value;
}

function skip(st) { while (st.at < st.lines.length && skippable(st.lines[st.at])) st.at++; }

// A node that starts on its own line, at indent `n`.
function readBlock(st, n, parent) {
  const content = st.lines[st.at].slice(n);
  if (startsSequence(content)) return readSequence(st, n);
  if (ENTRY.test(content)) return readMapping(st, n);
  const line = st.at++;
  return readInline(st, content, line, parent);
}

function readMapping(st, n) {
  const out = {};
  for (;;) {
    skip(st);
    if (st.at >= st.lines.length) break;
    const raw = st.lines[st.at];
    const ind = indentOf(raw);
    if (ind < n) break;
    if (ind > n) fail(st.at, 'a key indented further than the keys beside it');
    const content = raw.slice(n);
    const m = ENTRY.exec(content);
    if (!m) fail(st.at, 'a line here has to be a key and a colon');
    const key = m[1];
    if (Object.prototype.hasOwnProperty.call(out, key)) fail(st.at, `the key ${key} appears twice`);
    const line = st.at++;
    out[key] = readValue(st, content.slice(m[0].length), line, n, true);
  }
  return out;
}

function readSequence(st, n) {
  const out = [];
  for (;;) {
    skip(st);
    if (st.at >= st.lines.length) break;
    const raw = st.lines[st.at];
    const ind = indentOf(raw);
    if (ind < n) break;
    if (ind > n) fail(st.at, 'an item indented further than the items beside it');
    const content = raw.slice(n);
    if (!startsSequence(content)) break;
    const after = content.slice(1);
    const pad = leadingBlanks(after);
    const rest = after.slice(pad);
    const line = st.at;
    if (startsSequence(rest)) fail(line, 'a list inside a list item on one line is not modelled');
    if (ENTRY.test(rest)) {
      // A mapping whose first key shares the dash's line: read from the column
      // that key starts in, as YAML does.
      if (/\t/.test(after.slice(0, pad))) fail(line, 'a tab before a key is not modelled');
      st.lines[line] = ' '.repeat(n + 1 + pad) + rest;
      out.push(readMapping(st, n + 1 + pad));
      continue;
    }
    st.at++;
    out.push(readValue(st, rest, line, n, false));
  }
  return out;
}

// What follows `key:` or `- `, on that line or on the lines below it.
function readValue(st, rest, line, n, compactSequence) {
  if (rest === '' || rest.startsWith('#')) {
    skip(st);
    if (st.at < st.lines.length) {
      const ind = indentOf(st.lines[st.at]);
      if (ind > n) return readBlock(st, ind, n);
      if (ind === n && compactSequence && startsSequence(st.lines[st.at].slice(ind))) return readSequence(st, n);
    }
    return null;
  }
  return readInline(st, rest, line, n);
}

function readInline(st, raw, line, n) {
  const text = raw.slice(leadingBlanks(raw));
  const first = text[0];
  if (first === '"' || first === "'") {
    const { value, end } = first === '"' ? readDoubleQuoted(text, line) : readSingleQuoted(text, line);
    endOfValue(st, text.slice(end), line, n);
    return value;
  }
  if (first === '[') {
    const { value, end } = readFlowList(text, line);
    endOfValue(st, text.slice(end), line, n);
    return value;
  }
  if (first === '|' || first === '>') return readBlockScalar(st, text, line, n);
  if ('{&*!%'.includes(first)) fail(line, `a value starting with ${first} is not modelled`);
  if (first === '@' || first === '`') fail(line, `a value cannot start with ${first}, which YAML reserves`);
  if (',]}'.includes(first)) fail(line, `a value cannot start with ${first}`);
  if ('-?:'.includes(first) && (text.length === 1 || /\s/.test(text[1]))) fail(line, `a value cannot start with "${first} " here`);
  let value = plain(text, line);
  // A plain value runs on over the lines indented under it.
  for (;;) {
    skip(st);
    if (st.at >= st.lines.length || indentOf(st.lines[st.at]) <= n) break;
    value += ` ${plain(st.lines[st.at].trim(), st.at)}`;
    st.at++;
  }
  return typed(value);
}

// The text of a plain value: it stops at a comment, and may not hold a colon
// followed by a space, or end in a colon, either of which starts a mapping.
function plain(text, line) {
  const comment = text.search(/\s#/);
  const body = (comment === -1 ? text : text.slice(0, comment)).trimEnd();
  if (/:(\s|$)/.test(body)) fail(line, 'a colon and a space inside a plain value');
  return body;
}

// After a quoted value or a flow list: a comment at most, and nothing indented
// under it.
function endOfValue(st, tail, line, n) {
  if (!/^\s*(#.*)?$/.test(tail)) fail(line, 'more text after the end of a quoted value');
  skip(st);
  if (st.at < st.lines.length && indentOf(st.lines[st.at]) > n) fail(st.at, 'a line indented under a value that has ended');
}

const ESCAPES = {
  0: '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b',
  ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0', L: '\u2028', P: '\u2029',
};
const HEX_ESCAPES = { x: 2, u: 4, U: 8 };

function readDoubleQuoted(text, line) {
  let out = '';
  for (let i = 1; i < text.length; i++) {
    const c = text[i];
    if (c === '"') return { value: out, end: i + 1 };
    if (c !== '\\') { out += c; continue; }
    const e = text[++i];
    if (e === undefined) fail(line, 'a quoted value over several lines is not modelled');
    if (Object.prototype.hasOwnProperty.call(ESCAPES, e)) { out += ESCAPES[e]; continue; }
    const width = HEX_ESCAPES[e];
    const hex = width ? text.slice(i + 1, i + 1 + width) : '';
    if (!width || !/^[0-9a-fA-F]+$/.test(hex) || hex.length !== width) fail(line, `\\${e} is not an escape YAML has`);
    out += String.fromCodePoint(parseInt(hex, 16));
    i += width;
  }
  return fail(line, 'a quoted value with no closing quote');
}

function readSingleQuoted(text, line) {
  let out = '';
  for (let i = 1; i < text.length; i++) {
    if (text[i] !== "'") { out += text[i]; continue; }
    if (text[i + 1] === "'") { out += "'"; i++; continue; }
    return { value: out, end: i + 1 };
  }
  return fail(line, 'a quoted value with no closing quote');
}

// `[a, "b c", d]` on one line. Nesting is not modelled.
function readFlowList(text, line) {
  const out = [];
  let i = 1;
  for (;;) {
    while (text[i] === ' ') i++;
    if (i >= text.length) fail(line, 'a flow list over several lines is not modelled');
    // An empty list, or a comma before the closing bracket, which YAML allows.
    if (text[i] === ']') return { value: out, end: i + 1 };
    let item;
    if (text[i] === '"' || text[i] === "'") {
      const read = text[i] === '"' ? readDoubleQuoted(text.slice(i), line) : readSingleQuoted(text.slice(i), line);
      item = read.value;
      i += read.end;
    } else {
      const stop = text.slice(i).search(/[,\]]/);
      if (stop === -1) fail(line, 'a flow list with no closing bracket');
      const raw = text.slice(i, i + stop).trim();
      if (/[[{}#&*!|>%@`'"]/.test(raw[0] || '') || /[[\]{}]|:\s|:$|\s#/.test(raw)) fail(line, `"${raw}" is not modelled inside a flow list`);
      item = typed(raw);
      i += stop;
    }
    out.push(item);
    while (text[i] === ' ') i++;
    if (text[i] === ',') { i++; continue; }
    if (text[i] === ']') return { value: out, end: i + 1 };
    fail(line, 'a flow list item followed by something other than a comma');
  }
}

function readBlockScalar(st, text, line, n) {
  if (!/^[|>]([+-]?[1-9]?|[1-9][+-])([ \t]+#.*)?[ \t]*$/.test(text)) fail(line, 'a block scalar header with more text after it');
  const parts = [];
  while (st.at < st.lines.length) {
    const raw = st.lines[st.at];
    if (raw.trim() !== '' && indentOf(raw) <= n) break;
    parts.push(raw.trim());
    st.at++;
  }
  while (parts.length && parts[parts.length - 1] === '') parts.pop();
  if (!parts.length) return '';
  return text[0] === '|' ? `${parts.join('\n')}\n` : `${parts.join(' ')}\n`;
}

function typed(value) {
  if (/^(~|null|Null|NULL)?$/.test(value)) return null;
  if (/^(true|True|TRUE)$/.test(value)) return true;
  if (/^(false|False|FALSE)$/.test(value)) return false;
  if (/^[-+]?[0-9]+$/.test(value) || /^0o[0-7]+$/.test(value) || /^0x[0-9a-fA-F]+$/.test(value)) return Number(value);
  if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(value)) return Number(value);
  if (/^[-+]?\.(inf|Inf|INF)$/.test(value)) return value.startsWith('-') ? -Infinity : Infinity;
  if (/^\.(nan|NaN|NAN)$/.test(value)) return NaN;
  return value;
}

// Claude Code's own leniency, as observed: a top-level line whose value broke
// the YAML is tried again with that value in quotes.
function quoteTopLevelValues(fm) {
  return fm.split('\n').map((line) => {
    const m = /^([A-Za-z0-9_-]+):[ \t]+(.+)$/.exec(line);
    if (!m) return line;
    const value = m[2].trim();
    if (/^"([^"\\]|\\.)*"$/.test(value) || /^'([^']|'')*'$/.test(value) || /^[|>[]/.test(value)) return line;
    return `${m[1]}: ${JSON.stringify(value)}`;
  }).join('\n');
}

/**
 * Claude Code's reading of one agent file: `{ loads: true, name, data }`, or
 * `{ loads: false, why }` naming which of the three reasons it is.
 */
function readAgentFile(text) {
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(\n|$)/.exec(String(text).replace(/\r\n/g, '\n'));
  if (!m) return { loads: false, why: 'it has no frontmatter' };
  let data;
  try {
    data = readYaml(m[1]);
  } catch (first) {
    if (!(first instanceof YamlError)) throw first;
    try {
      data = readYaml(quoteTopLevelValues(m[1]));
    } catch (second) {
      if (!(second instanceof YamlError)) throw second;
      return { loads: false, why: `its YAML cannot be read (${first.message})` };
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { loads: false, why: 'its frontmatter is not a set of keys' };
  if (typeof data.name !== 'string' || !data.name) return { loads: false, why: 'it has no name' };
  if (typeof data.description !== 'string' || !data.description) return { loads: false, why: 'it has no description' };
  return { loads: true, name: data.name, data };
}

// The agents Claude Code ships with, which it lists beside a workspace's own.
const BUILT_IN_AGENTS = ['claude', 'Explore', 'general-purpose', 'Plan', 'statusline-setup'];

/** The names Claude Code would accept for --agent, run in this workspace. */
function loadableAgentNames(workspaceDir) {
  const dir = path.join(workspaceDir, '.claude', 'agents');
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.md')); } catch (e) { /* no agents */ }
  const names = new Set(BUILT_IN_AGENTS);
  for (const file of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(dir, file), 'utf8'); } catch (e) { continue; }
    const read = readAgentFile(text);
    if (read.loads) names.add(read.name);
  }
  return [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

/** What Claude Code writes to stderr for an --agent it has not loaded. */
function agentNotFoundLine(name, available) {
  return `--agent '${name}' not found. Available agents: ${available.join(', ')}`;
}

module.exports = { readYaml, readAgentFile, loadableAgentNames, agentNotFoundLine, YamlError, BUILT_IN_AGENTS };
