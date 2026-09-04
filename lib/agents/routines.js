'use strict';
/**
 * The routine data model: the typed representation of a routine, and the only
 * path that writes one back into an agent file.
 *
 * WHY A WRITER EXISTS AT ALL. Routines have always been readable and never
 * writable. The frontmatter format is hand-rolled, there is no YAML library in
 * the server path, and the only other frontmatter writes in the codebase are
 * targeted regex replacements on single scalar lines. So this file edits
 * LINES rather than re-serialising a parsed document: a routine block is
 * located, the named keys in it are replaced or appended, and every other byte
 * of the file is carried through untouched. Re-serialising would mean deciding
 * how to render every key an author ever wrote, and the keys this module has
 * never heard of are exactly the ones it must not lose.
 *
 * WHY THE PARSER TYPES ANYTHING. The block parser copies whatever `key: value`
 * it finds, as a string, with no whitelist. New fields therefore parse for
 * free and arrive as the wrong type, so `enabled: false` read back as the
 * string 'false', which is truthy. Typing is the work; parsing was never the
 * problem.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Where a routine runs. `local` is the only value that runs anything in this
// release. `agent-computer` is a RECOGNISED token rather than an accepted one:
// it is kept verbatim through a round trip so an author who wrote it does not
// silently lose it, and it is excluded from the supported set so nothing
// treats it as runnable yet.
const RUN_ON_SUPPORTED = ['local'];
const RUN_ON_RESERVED = ['agent-computer'];
const RUN_ON_DEFAULT = 'local';

function isRunOnSupported(runOn) {
  return RUN_ON_SUPPORTED.includes(runOn);
}

/**
 * Whether this routine has an instruction to send at all.
 *
 * WHY THE MODEL ANSWERS THIS AND NOT THE SCHEDULER. A routine with a schedule
 * and no prompt does not fail to start: nothing on the run path throws, the
 * absent value is carried to the spawn and coerced there, and the agent is
 * asked to act on the four letters n-u-l-l, unattended, with a completed run
 * recorded behind it. The scheduler is right to run whatever it is handed, so
 * the question of whether a routine says anything belongs beside the fields
 * that decide what a routine IS.
 *
 * BLANK AND ABSENT ARE ONE ANSWER HERE, which is the opposite of the rule
 * `timezone` follows and deliberately so. A zone that was declared and emptied
 * is a record of an edit somebody made, and something later has to be able to
 * read that. A prompt of spaces is not a record of anything: it is the same
 * nothing an absent key is, and sending it would spend a run asking an agent
 * to act on whitespace.
 *
 * IT DOES NOT TYPE THE FIELD, and must not. `normalizeRoutine` keeps `prompt`
 * exactly as the file wrote it, quotes and all, because trimming it would
 * change what the scheduler already sends to the CLI for every routine that
 * works today. This asks a question about the value and changes nothing.
 */
function hasRunnablePrompt(routine) {
  const prompt = routine ? routine.prompt : null;
  return typeof prompt === 'string' && prompt.trim() !== '';
}

// Quotes are stripped only from the fields this module types. Stripping them
// from `prompt` or `schedule` too would change what the scheduler already
// sends to the CLI, which is a different card's decision.
function unquote(value) {
  return String(value).trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').trim();
}

function readString(raw, key) {
  const value = raw[key];
  if (value === undefined || value === null) return null;
  const text = unquote(value);
  return text === '' ? null : text;
}

// Every spelling YAML calls a boolean is read as one.
//
// WHY MORE THAN true AND false. These files are hand written, and `yes` and
// `on` are booleans in YAML 1.1 that somebody may reasonably type. Reading
// them as anything else matters more than it used to: while an absent
// `enabled` meant the routine ran, an unrecognised value meant it ran too, so
// no spelling could be held back by being misread. Now one can, and taking a
// routine whose author wrote `enabled: yes` and switching it off on upgrade is
// exactly the over-correction the rule exists to avoid.
//
// It reaches `paused` too, where these words were silently ignored: a file
// saying `paused: yes` left its routine running.
//
// Unrecognised values still fall back rather than being kept, so a frontmatter
// typo cannot leave a routine in a state nothing knows how to read. This
// mirrors how the agent `runtime` field already behaves, and for `enabled` the
// fallback is the safe direction: the routine waits to be turned on rather
// than starting because nobody could read what was meant.
const TRUE_WORDS = ['true', 'yes', 'on'];
const FALSE_WORDS = ['false', 'no', 'off'];

function readBoolean(raw, key, fallback) {
  const value = raw[key];
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null) return fallback;
  const text = unquote(value).toLowerCase();
  if (TRUE_WORDS.includes(text)) return true;
  if (FALSE_WORDS.includes(text)) return false;
  return fallback;
}

// ===== THE TIMEZONE A SCHEDULE WAS SET IN =====

/**
 * The zone a schedule was built in, as location words: `Europe/London`.
 *
 * WORDS RATHER THAN AN OFFSET, because an offset is true until the next clock
 * change and then silently wrong, twice a year, in the direction nobody
 * notices until a routine runs an hour late.
 *
 * ABSENT AND BLANK ARE DIFFERENT ANSWERS, which is the whole reason this does
 * not go through readString. A file with no `timezone` key never recorded one,
 * and every routine written before this field existed is in that state. A file
 * carrying `timezone:` with nothing after it was written by somebody who
 * declared the field and left it empty. readString folds both to null, and
 * whatever later decides what to do about a routine with no zone has to be
 * able to tell "never recorded" from "deliberately blank": the first is a gap
 * to fill and the second is an answer already given.
 *
 * NOTHING HERE ASKS THE MACHINE. `Intl.DateTimeFormat().resolvedOptions()
 * .timeZone` returns location words and looks exactly like the value this
 * field wants. It answers a different question: what this computer is set to,
 * rather than what the person chose when they built the schedule. The two are
 * the same string on the machine a routine was made on and different
 * everywhere else, including on the server that later reads the file, so a
 * value defaulted from the machine is a value that changes when nothing about
 * the routine did. A routine with no zone stays a routine with no zone.
 */
function readTimezone(raw) {
  const value = raw.timezone;
  if (value === undefined || value === null) return null;
  return unquote(value);
}

// What a timezone may be when one is WRITTEN: an area and a place, e.g.
// `Europe/London` or `America/Argentina/Buenos_Aires`.
//
// CHECKED BY SHAPE, NOT AGAINST A ZONE DATABASE. Intl knows which zones exist,
// and asking it would make what a file may contain depend on the ICU data of
// whichever machine did the writing: the same zone accepted on one computer
// and refused on another, and refused everywhere on a Node built without full
// ICU. Which zones exist is not this module's question, and answering it from
// the runtime is the machine reaching a stored value by a second road.
// Whether this is location words rather than an offset is the question, and
// the shape answers it.
//
// What it refuses is the point. `+01:00` and `GMT+1` are offsets. `BST` and
// `PST` name several places at once and change meaning with the season. `UTC`
// names no place at all and is what a machine in a container reports, which is
// exactly the value this field must not silently accept as somebody's choice.
const TIMEZONE_WORDS = /^[A-Za-z][A-Za-z0-9_-]*(?:\/[A-Za-z0-9_+-]+)+$/;
// The longest name in the zone database is about half this. The cap is here
// because the value arrives from a message rather than from a person, and a
// line in somebody's agent file is not the place to discover that.
const TIMEZONE_MAX = 64;

function assertTimezoneWords(value) {
  if (value.length > TIMEZONE_MAX || !TIMEZONE_WORDS.test(value)) {
    throw new Error(`timezone "${value.slice(0, TIMEZONE_MAX)}" is not location words, like Europe/London`);
  }
}

/**
 * What the WRITER accepts for a timezone: location words, or nothing.
 *
 * The empty value is how this module clears a field. For this field it reads
 * back as blank rather than as absent, which is the honest record of what
 * happened: the key was declared and then emptied, which is not the same as
 * never having recorded a zone at all. Removing a zone somebody recorded is an
 * ordinary edit, so it is not refused here.
 *
 * Creating a routine with an empty one is a different act, and is refused
 * where routines are made.
 *
 * THE QUOTES COME OFF BEFORE THE QUESTION IS ASKED, because the question is
 * what this value will read back as. Authors quote things and this module
 * writes a value literally, so `"Europe/London"` is a zone written with
 * quotation marks around it rather than a zone with quotation marks in it. The
 * reader takes them off; a check that did not would refuse a value it then
 * accepts on the way back in.
 */
function assertWritableTimezone(value) {
  const text = unquote(value);
  if (text === '') return;
  assertTimezoneWords(text);
}

// ===== WHEN A ROUTINE RUNS =====

// What a schedule may be when one is WRITTEN: every day, or every named
// weekday, at a wall-clock time.
//
// THIS IS THE SCHEDULER'S GRAMMAR, NOT THE EDITOR'S LIST, and the difference is
// deliberate in both directions. The editor offers the half hour, so it can
// neither build nor show `every day at 07:03`; the scheduler reads that
// perfectly well and a routine written by hand for it fires every morning.
// Refusing it here would be a second opinion about what a routine may be, held
// by the layer that has no business holding one. What is refused is a schedule
// that fires NOTHING: `every fortnight`, `every weekday`, an hour without its
// leading zero, a cron expression. Each of those parses into a routine that
// saves, appears in the list, and waits forever, which is the one outcome no
// part of this product can notice on its own.
//
// STRICTER THAN THE SCHEDULER IN THE TWO PLACES THE SCHEDULER IS LOOSE, so
// everything accepted here is something it runs. It matches its patterns
// unanchored, so `run every day at 07:00 please` reads as a schedule, and it
// takes any two digits for the hour, so `every day at 99:00` rolls silently
// into another day. Anchoring, and holding the clock to a real one, is a subset
// of what the scheduler accepts rather than a disagreement with it.
//
// THE CASE IS FOLDED BEFORE THE MATCH, because the scheduler folds it before it
// reads. A routine written `Every Monday at 07:00` fires today, and refusing to
// write one would refuse a schedule the product already runs.
const SCHEDULE_WORDS =
  /^every (day|monday|tuesday|wednesday|thursday|friday|saturday|sunday) at ([01]\d|2[0-3]):[0-5]\d$/;

function isWritableSchedule(value) {
  if (typeof value !== 'string') return false;
  return SCHEDULE_WORDS.test(value.trim().toLowerCase());
}

/**
 * What the WRITER accepts for a schedule: words the scheduler reads, and
 * nothing else.
 *
 * NO EMPTY VALUE HERE, which is where this parts company with the timezone
 * rule beside it. Emptying a field is how this module clears one, and a routine
 * with no zone is an ordinary routine that never recorded where it was set. A
 * routine with no schedule is not a routine: nothing decides when it runs, so
 * it sits in the file forever doing nothing, which is the same silence a
 * schedule that cannot be parsed produces. Removing a routine is what removing
 * a routine's schedule means, and there is already a path for that.
 */
function assertWritableSchedule(value) {
  if (!isWritableSchedule(value)) {
    throw new Error(`schedule "${String(value).slice(0, 64)}" is not one the scheduler reads, `
      + 'like every day at 09:00 or every monday at 07:00');
  }
}

function readRunOn(raw) {
  const text = readString(raw, 'runOn');
  if (!text) return RUN_ON_DEFAULT;
  const token = text.toLowerCase();
  if (RUN_ON_SUPPORTED.includes(token) || RUN_ON_RESERVED.includes(token)) return token;
  return RUN_ON_DEFAULT;
}

/**
 * Turn one raw block into the typed representation.
 *
 * Unknown keys are carried through untouched: a key this module does not
 * understand still belongs to whoever wrote it. `owner` falls back to the id
 * of the agent whose file declares the routine, which is what ownership has
 * always meant here (it was positional and unwritten), so a file with no
 * owner keeps exactly the meaning it has today.
 */
function normalizeRoutine(raw, opts = {}) {
  return {
    ...raw,
    name: readString(raw, 'name'),
    schedule: raw.schedule === undefined ? null : raw.schedule,
    prompt: raw.prompt === undefined ? null : raw.prompt,
    skill: readString(raw, 'skill'),
    runOn: readRunOn(raw),
    timezone: readTimezone(raw),
    owner: readString(raw, 'owner') || opts.owner || null,
    // AN ABSENT `enabled` MEANS NOT ENABLED, and this line is where the whole
    // rule lives.
    //
    // A block with no `enabled` key was written by hand, before this product
    // could run anything, beside a cron job that was already doing the work.
    // The editor has written the key explicitly since this model shipped, so
    // absence is not ambiguous: it marks a routine that predates the
    // scheduler. Defaulting it to true meant the day Rundock first ran over
    // such a workspace, every routine in it went live at once, next to the
    // cron jobs still running them, and the morning briefing went out twice.
    //
    // ABSENT AND FALSE ARE THE SAME TO THE SCHEDULER AND DIFFERENT TO THE
    // USER, which is why this is a fallback rather than a coercion.
    // readBoolean returns what the file says when the file says anything, so
    // an `enabled: true` somebody typed is still true and a routine they
    // switched off stays off. Only silence reads as "not yet".
    //
    // AND IT IS THE READ, not the migration, that had to change. The
    // migration returns migrated content whether or not its write lands, so a
    // workspace nobody can write to is served by this line alone. Filling the
    // key with false on the way to disk and leaving the reader defaulting to
    // true would fix every workspace except the ones that cannot be fixed.
    // The migration takes its fill value from here, so the two cannot part.
    enabled: readBoolean(raw, 'enabled', false),
    paused: readBoolean(raw, 'paused', false),
    planHash: readString(raw, 'planHash'),
    planApprovedHash: readString(raw, 'planApprovedHash'),
    planApprovedAt: readString(raw, 'planApprovedAt'),
  };
}

// ===== BLOCK LOCATION =====
// Both the reader and the writer need the same idea of where a routine block
// starts and stops, so they share one locator rather than two regexes that
// can drift apart.

const ROUTINES_KEY = /^routines:[ \t]*$/;
const ROUTINE_ITEM = /^[ \t]*-[ \t]*name:/;

// The `routines:` section runs from the key to the first line that is neither
// indented nor blank, i.e. the next top-level key.
function locateSection(lines) {
  const start = lines.findIndex(l => ROUTINES_KEY.test(l));
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === '' || /^[ \t]/.test(lines[end]))) end++;
  return { start, end };
}

// Item ranges within the section, one per `- name:` line.
function locateItems(lines, section) {
  const items = [];
  for (let i = section.start + 1; i < section.end; i++) {
    if (ROUTINE_ITEM.test(lines[i])) {
      if (items.length) items[items.length - 1].end = i;
      items.push({ start: i, end: section.end });
    }
  }
  return items;
}

function parseRoutineBlocks(fmText) {
  const lines = fmText.split('\n');
  const section = locateSection(lines);
  if (!section) return [];
  const routines = [];
  for (const item of locateItems(lines, section)) {
    const routine = {};
    for (let i = item.start; i < item.end; i++) {
      const kv = lines[i].match(/^[ \t]*-?[ \t]*(\w+):[ \t]*(.*)$/);
      if (kv) routine[kv[1]] = kv[2].trim();
    }
    if (routine.name) routines.push(routine);
  }
  return routines;
}

// ===== THE WRITE PATH =====

// The parser reads back `\w+` keys and nothing else, so a key outside that
// shape could never survive a round trip anyway. Refusing it here also means
// the pattern built from it below is made only of word characters, which is
// what keeps a caller-supplied key from becoming a pattern of its own.
const FIELD_NAME = /^\w+$/;

function assertFieldName(key) {
  if (!FIELD_NAME.test(key)) {
    throw new Error(`"${key}" is not a routine field name`);
  }
}

function formatValue(key, value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const text = String(value);
  // A newline in a value would silently split one key into two and corrupt
  // every routine below it. Refuse loudly rather than write a broken file.
  if (/[\r\n]/.test(text)) {
    throw new Error(`routine field "${key}" cannot contain a line break`);
  }
  return text;
}

// Per-field value rules, applied wherever a key becomes bytes.
//
// THE WRITER IS OTHERWISE FIELD-AGNOSTIC BY DESIGN. It knows the shape of a
// key and that a value cannot carry a line break, and nothing about what any
// key means. Two fields need more than that, and both fail the same way: the
// value is accepted, the file is written, nothing throws, and the routine runs
// at the wrong time or at no time at all.
//
// A timezone is the answer to where a schedule was set, and an offset or an
// abbreviation written into it is wrong in a way that is only discovered twice
// a year, on the morning a routine runs an hour late.
//
// A schedule is when the routine runs, and one the scheduler cannot parse fires
// nothing at all: the routine saves, appears in the list with a next run its
// row cannot name, and waits forever. Nothing downstream can notice that, which
// is exactly why the refusal belongs on the way in.
//
// IT LIVES HERE RATHER THAN BESIDE THE PATH THAT CREATES A ROUTINE, and that
// placement is the point. This is the road every edit takes. A rule on the
// creating road alone is a rule the first edit flow walks straight past, and by
// then it looks like a decision somebody made rather than a road nobody had
// built yet.
//
// A MAP RATHER THAN AN OBJECT, because the key comes from the caller. `\w+`
// admits `constructor`, `toString` and every other name on Object's prototype,
// and a plain object hands those back from it, so the lookup would find a
// function that is not a rule and call it with somebody's value. Nothing on
// that prototype does damage when called that way, so this is hygiene rather
// than a guard, and it carries no mutation for that reason: a container with
// no inherited keys is simply the right container to look up caller input in.
const FIELD_VALUE_RULES = new Map([
  ['timezone', assertWritableTimezone],
  ['schedule', assertWritableSchedule],
]);

function assertFieldValue(key, value) {
  const rule = FIELD_VALUE_RULES.get(key);
  if (rule) rule(value);
}

// The indent authors actually used for this block's keys, so an appended key
// lines up with the ones already there. Falls back to the position implied by
// the `- ` marker when the block has nothing but a name.
function keyIndent(lines, item) {
  for (let i = item.start + 1; i < item.end; i++) {
    const m = lines[i].match(/^([ \t]+)\w+:/);
    if (m) return m[1];
  }
  const dash = lines[item.start].match(/^([ \t]*)-([ \t]*)/);
  return ' '.repeat(dash[1].length + 1 + dash[2].length);
}

/**
 * Replace or append the given keys inside one routine block, leaving every
 * other byte of the file alone.
 *
 * ABSENT VALUES ARE SKIPPED, BOTH null AND undefined. A caller is meant to be
 * able to hand this a whole routine, and the reader produces null for every
 * field a file does not declare, so writing those through would put the four
 * letters n-u-l-l in the file. The next read hands back a string that is not
 * null, is truthy, and hashes differently, which is the worst of the three.
 * Skipping leaves any existing line for that key exactly as it was.
 *
 * To CLEAR a field, pass an empty string: `key: ` with nothing after it reads
 * back as null, which is the same absence the file started with.
 *
 * Nothing makes a routine name unique within a file, and a copy-pasted block
 * is an ordinary thing to find in one, so `occurrence` picks which block of
 * that name to edit. It defaults to the first, which is what a caller holding
 * a name and no index means.
 *
 * VALUES ARE TEXT, NEVER PATTERNS. A value is inserted literally, and a key
 * outside `\w+` is refused rather than compiled. The name is compared with
 * `===` against what the item line captured, so it is not a pattern either.
 */
function updateRoutineBlock(content, name, updates, occurrence = 0) {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return content;
  const fmText = fmMatch[1];
  const lines = fmText.split('\n');
  const section = locateSection(lines);
  if (!section) return content;

  const target = locateItems(lines, section).filter(item => {
    const m = lines[item.start].match(/^[ \t]*-[ \t]*name:[ \t]*(.*)$/);
    return m && unquote(m[1]) === name;
  })[occurrence];
  if (!target) return content;

  const indent = keyIndent(lines, target);
  const appended = [];
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined || value === null) continue;
    assertFieldName(key);
    const formatted = formatValue(key, value);
    assertFieldValue(key, formatted);
    const existing = findKeyLine(lines, target, key);
    if (existing === -1) {
      appended.push(`${indent}${key}: ${formatted}`);
    } else {
      // Keep the author's exact prefix and concatenate the value onto it,
      // rather than splicing it in as a replacement string. A value is text
      // somebody wrote, and a prompt saying "$1 per run" is ordinary; through
      // a replacement template those two characters become the captured
      // prefix, and $&, $` and $' pull in the surrounding line. The value
      // would be corrupted silently, with no error to notice.
      const prefix = lines[existing].match(keyLinePattern(key))[0];
      lines[existing] = prefix + formatted;
    }
  }
  // Appended keys go at the end of the block, which is where a hand edit would
  // put them and which keeps the author's existing key order intact.
  lines.splice(target.end, 0, ...appended);

  const nextFm = lines.join('\n');
  return content.slice(0, 4) + nextFm + content.slice(4 + fmText.length);
}

/**
 * The routine block `name`/`occurrence` names, read back out of a file's
 * CONTENT, or null when this module cannot find one there.
 *
 * WHY A CALLER NEEDS THIS AND NOT A BYTE COMPARISON. The writers in this file
 * return the content unchanged for two entirely different reasons: the edit
 * was a no-op because the field already held that value, and the file could
 * not be addressed at all. A file checked out with CRLF endings is the second
 * one, and it is not exotic: discovery normalises line endings when it reads a
 * file, so such an agent appears on the roster with all its routines, and then
 * every pattern in this module fails to match it. A caller that reads
 * unchanged bytes as success announces a change that never happened.
 *
 * So a caller asks this instead, before and after: is the block there, and
 * does it now say what I asked for. That is a question about the file rather
 * than an inference from its length.
 *
 * It reads through the same pair of functions the ROSTER is built from, so the
 * occurrence it counts is the occurrence a client counted off the roster.
 */
function readRoutineBlocks(content, name) {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return [];
  return parseRoutineBlocks(fmMatch[1])
    .map(raw => normalizeRoutine(raw))
    .filter(routine => routine.name === name);
}

function readRoutineBlock(content, name, occurrence = 0) {
  return readRoutineBlocks(content, name)[occurrence] || null;
}

/**
 * Remove a routine block from an agent file's frontmatter, by name.
 *
 * LINES, NOT A REWRITE, for the same reason the writer edits lines: the
 * frontmatter is hand rolled, carries keys nothing here has heard of, and the
 * parts most easily lost are the ones nobody thought to preserve. Removing a
 * block is deleting a contiguous run of lines and touching nothing else.
 *
 * THE LAST ROUTINE TAKES THE `routines:` KEY WITH IT. A key left behind with
 * nothing under it is not "an agent with no routines", it is a key whose value
 * is missing, and what a parser makes of that is a question nobody should have
 * to ask. So the whole section goes when its last item does.
 *
 * `occurrence` picks which block of that name to remove, because nothing makes
 * a routine name unique within a file and a copy-pasted block is an ordinary
 * thing to find in one. A name that is not there returns the content
 * unchanged, so a caller can tell a removal from a no-op by comparing bytes.
 */
function removeRoutineBlock(content, name, occurrence = 0) {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return content;
  const fmText = fmMatch[1];
  const lines = fmText.split('\n');
  const section = locateSection(lines);
  if (!section) return content;

  const items = locateItems(lines, section);
  const target = items.filter(item => {
    const m = lines[item.start].match(/^[ \t]*-[ \t]*name:[ \t]*(.*)$/);
    return m && unquote(m[1]) === name;
  })[occurrence];
  if (!target) return content;

  const from = items.length === 1 ? section.start : target.start;
  lines.splice(from, target.end - from);

  const nextFm = lines.join('\n');
  return content.slice(0, 4) + nextFm + content.slice(4 + fmText.length);
}

// The prefix of a key's line: leading space, an optional item marker, the key
// and its colon, and the space after it. Built from a key already checked to
// be word characters only.
function keyLinePattern(key) {
  return new RegExp(`^[ \\t]*-?[ \\t]*${key}:[ \\t]*`);
}

function findKeyLine(lines, item, key) {
  const re = keyLinePattern(key);
  for (let i = item.start; i < item.end; i++) if (re.test(lines[i])) return i;
  return -1;
}

// ===== IS THE FILE STILL WELL FORMED =====

// Top-level frontmatter keys, counted, by a route that shares NOTHING with the
// locators above.
//
// WHY IT IS WRITTEN TWICE RATHER THAN REUSING locateSection. A read-back that
// parses with the writer's own parser confirms the writer is SELF-CONSISTENT.
// It cannot confirm the file is valid, because it asks the same question that
// produced the error. That is not hypothetical: appending a second `routines:`
// key to a file whose existing one this module does not recognise produces a
// document with two mappings of the same name, and the locator finds the one
// it just wrote and reports success.
//
// So this asks a different question, in different terms: which names appear at
// column zero, and how many times. It knows nothing about routines, items,
// indents or sections.
const TOP_LEVEL_KEY = /^([A-Za-z_][A-Za-z0-9_-]*):/;

function topLevelKeyCounts(content) {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  const counts = new Map();
  for (const line of fm[1].split('\n')) {
    const m = line.match(TOP_LEVEL_KEY);
    if (m) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  }
  return counts;
}

/**
 * Refuse a write that changed the shape of the document rather than its
 * contents.
 *
 * A routine is item text inside an existing key, so writing one may add the
 * `routines` key where there was none and must change no other count. Anything
 * else means the write restructured the file, and a duplicated key is invalid
 * YAML that nothing downstream can read.
 *
 * Compares BEFORE with AFTER rather than judging the result alone, so a file
 * that already carried a duplicate is not blamed on this write and not made
 * worse by it either.
 */
function assertFrontmatterKeysIntact(before, after) {
  const was = topLevelKeyCounts(before);
  const now = topLevelKeyCounts(after);
  if (!now) throw new Error('the frontmatter is no longer readable after writing');
  for (const [key, count] of now) {
    const previous = was ? (was.get(key) || 0) : 0;
    const allowed = key === 'routines' ? Math.max(previous, 1) : previous;
    if (count > allowed) {
      throw new Error(`writing would have left ${count} "${key}" keys in the frontmatter, which nothing can read`);
    }
  }
}

/**
 * Add a routine that is not in the file yet.
 *
 * WHY THIS IS NOT THE WRITER ABOVE. `updateRoutineBlock` replaces or appends
 * KEYS inside a block that already exists. Nothing made the block. This does
 * exactly that much and then hands every field to the writer, so the value
 * rules that path already enforces (a value is text and never a pattern, a
 * line break is refused rather than written, an unknown field name is refused)
 * apply to a created routine on the same terms as an edited one.
 *
 * THE NAME IS THE PART THIS FUNCTION WRITES ITSELF, so it carries its own
 * refusals. A line break in a name would split one key into two and corrupt
 * every routine below it, and an empty name produces a block the parser drops
 * on the next read, which is a write that silently did nothing.
 *
 * The reserved run target is refused here as well as in the interface. A file
 * is reachable by more than one road, and an unrunnable routine on disk is
 * worse than a rejected message.
 *
 * A file with no frontmatter is returned untouched: there is nowhere to put a
 * routine, and inventing a frontmatter block is a bigger decision than this.
 */
function appendRoutineBlock(content, routine) {
  // A name is text or it is absent. `null`, a number and a whitespace-only
  // string all reached the writer before this and were written as their own
  // characters, so a routine could be created called "null".
  const rawName = routine ? routine.name : null;
  const name = typeof rawName === 'string' ? unquote(rawName) : null;
  if (!name) throw new Error('a routine needs a name');
  if (/[\r\n]/.test(name)) throw new Error('a routine name cannot contain a line break');
  const runOn = routine.runOn === undefined || routine.runOn === null ? RUN_ON_DEFAULT : String(routine.runOn);
  if (!isRunOnSupported(runOn)) {
    throw new Error(`runOn "${runOn}" is reserved and cannot be written`);
  }

  // The zone, when the caller names one. Its SHAPE is not checked here: every
  // field this function writes goes through the writer below, and the writer
  // refuses a value that is not location words on whichever road it arrives
  // by. Reading, by contrast, keeps whatever an author wrote, because their
  // bytes are theirs and a read that coerced them would lose the only record
  // of what the file says.
  //
  // ABSENT STAYS ABSENT. There is no zone this code could invent that would be
  // true, and the one it could reach for is the machine's. A routine created
  // without a zone gets no key, which is the same absence every routine
  // written before this field had.
  //
  // AN EMPTY ONE IS REFUSED, and this is the one rule that belongs to creating
  // rather than to editing. Empty is how the writer clears a field, which
  // leaves a key declared and blank. That is a true record of an edit that
  // removed a zone, and it is a state a routine being made has no way to have
  // reached: a new routine names a place or records nothing, and recording
  // nothing is leaving the key out.
  const timezone = routine.timezone === undefined || routine.timezone === null
    ? null
    : String(routine.timezone);
  if (timezone !== null && unquote(timezone) === '') {
    throw new Error('a new routine names a timezone or leaves it out, rather than carrying an empty one');
  }

  // THIS REFUSES RATHER THAN RETURNING THE CONTENT IT WAS GIVEN, and the
  // difference is the whole point. Handing back the original bytes makes a
  // file this function cannot edit indistinguishable from one it edited
  // successfully, and the caller then writes the unchanged bytes, says the
  // routine was added, and it is not there.
  //
  // Two real files land here. One with no frontmatter has nowhere to put a
  // routine. One with Windows line endings does not match, because every
  // locator in this module is built on lines that end at "\n" and a line ending
  // "\r" matches none of them. Widening those locators is a change to the
  // migration and the writer as well, which is a bigger decision than this;
  // refusing is the honest half of it and says which file it means.
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    throw new Error(/\r\n/.test(content)
      ? 'this file uses Windows line endings, which this editor cannot write to yet'
      : 'this file has no frontmatter, so there is nowhere to put a routine');
  }
  const fmText = fmMatch[1];
  const lines = fmText.split('\n');
  const declaredRoutines = (topLevelKeyCounts(content) || new Map()).get('routines') || 0;

  let section = locateSection(lines);
  if (!section) {
    // A `routines:` key this module cannot address is NOT the same as no key.
    //
    // The locator recognises the key only with nothing after it. `routines: []`
    // and `routines: # none yet` are both ordinary things to write and both
    // read as absent, so appending a section produced a document with two
    // `routines` keys: invalid YAML, written into somebody's agent file, from
    // an editor that then said it had saved.
    //
    // Refused rather than rewritten. Turning `routines: []` into a block
    // sequence is a transformation with its own decisions, and guessing at one
    // inside a save is how the first version of this went wrong.
    // Asked of the INDEPENDENT counter rather than of a second regex written
    // here. "Does this file already declare routines" and "can I find the
    // section" are two different questions, and answering the first with the
    // locator that answers the second is the whole of this defect.
    if (declaredRoutines > 0) {
      throw new Error('this file declares routines in a form this editor cannot add to yet');
    }
    // No key at all. The section goes at the END of the frontmatter, which is
    // where a hand edit would put a new key and which leaves every existing key
    // in the order its author wrote it.
    lines.push('routines:');
    section = locateSection(lines);
  }

  // Count the blocks already carrying this name, so the writer edits the one
  // just added rather than an earlier namesake. A copy pasted routine is an
  // ordinary thing to find in a file.
  const items = locateItems(lines, section);
  const occurrence = items.filter(item => {
    const m = lines[item.start].match(/^[ \t]*-[ \t]*name:[ \t]*(.*)$/);
    return m && unquote(m[1]) === name;
  }).length;

  // Match the indent the file already uses for its items, so an appended
  // routine lines up with the ones above it.
  const marker = items.length
    ? lines[items[items.length - 1].start].match(/^([ \t]*)-([ \t]*)/)
    : null;
  const dash = marker ? `${marker[1]}-${marker[2]}` : '  - ';
  lines.splice(section.end, 0, `${dash}name: ${name}`);

  const nextFm = lines.join('\n');
  const withBlock = content.slice(0, 4) + nextFm + content.slice(4 + fmText.length);

  // Every remaining field goes through the writer, which is the only path that
  // formats a value. planHash is computed from the normalised routine so a new
  // routine arrives with the same plan record a migrated one gets.
  const normalized = normalizeRoutine({ ...routine, name, runOn });
  const next = updateRoutineBlock(withBlock, name, {
    schedule: routine.schedule,
    prompt: routine.prompt,
    skill: routine.skill,
    runOn,
    timezone,
    // NULL AND ABSENT ARE THE SAME QUESTION, and both are answered true.
    //
    // The writer skips null exactly as it skips undefined, so testing only for
    // undefined let a null through to a write that then put no `enabled` key
    // in the file at all. A block with no key reads as not enabled, so a
    // routine created here would arrive switched off: the fault the reader's
    // default exists to prevent, pointed at the person who just made one.
    //
    // Not the caller's decision either way. This path is how a routine is
    // CREATED, and a created routine is live.
    enabled: routine.enabled == null ? true : routine.enabled,
    planHash: computePlanHash(normalized),
    // A routine somebody just made has a plan nobody has approved yet, and
    // the file says so in as many words. The first run meets the approval
    // step; the grandfather in the migration never fires for this block,
    // because the key is present from birth.
    planApprovedHash: APPROVAL_PENDING,
  }, occurrence);

  // READ IT BACK BEFORE HANDING IT OVER.
  //
  // Every refusal above names a cause somebody thought of. This names none:
  // it parses the result and requires the routine to be in it, so a shape that
  // defeats the locators in some way nobody has met yet is a refusal too,
  // rather than a caller writing bytes that changed less than it believes.
  // The writer's own contract is to return the content unchanged when it
  // cannot find its target, so without this check that silence arrives here
  // looking like success.
  const written = parseRoutineBlocks(next.match(/^---\n([\s\S]*?)\n---/)[1])
    .filter(block => unquote(block.name) === name)[occurrence];
  if (!written || (routine.schedule !== undefined && written.schedule !== routine.schedule)) {
    throw new Error('the routine could not be written into this file');
  }
  // And the same result judged by something that does not share this module's
  // idea of where a section is. The check above says the writer agrees with
  // itself; this one says the document is still one nothing will choke on.
  assertFrontmatterKeysIntact(content, next);
  return next;
}

// ===== THE PLAN HASH =====

// What a routine DOES: the instruction, the skill it runs, and where it runs.
//
// Deliberately not the schedule, because a routine moved by ten minutes is
// the same plan and re-approving it would make approval worthless. Not
// enabled or paused either: turning a routine off changes whether it happens,
// not what happens when it does.
//
// And deliberately not the owner, which is the subtler case. Files declare an
// owner only rarely, so for almost every routine it is resolved by the caller
// from the agent file's name and its position on the roster. Hashing it would
// mean that renaming an agent file, or an agent gaining or losing order zero
// and so answering to the id `default`, silently invalidated an approval while
// every byte of the routine stayed exactly where it was. That is the schedule
// problem arriving by a different road. The rule that closes the whole class:
// the hash reads only what the routine itself declares, never a value the
// caller supplies.
//
// The cost, named rather than hidden: changing a DECLARED owner no longer
// invalidates an approval. Owner is a field in its own right, so an approval
// flow can compare it directly, and it does not need smuggling through a hash
// to be noticed.
//
// AND DELIBERATELY NOT THE TIMEZONE, decided here rather than settled by
// leaving it out.
//
// The argument for including it is real and worth stating: changing a zone
// changes when a routine runs, by up to a day, which is a bigger move than the
// ten minutes the schedule exclusion is written around. Both answers are
// defensible, and whichever is chosen here is the one plan approval inherits,
// because approval is exactly "this hash, approved once".
//
// It is excluded, for the reason the schedule is. The line this hash draws is
// what a routine DOES against WHEN it happens, not big changes against small
// ones. A zone is the second half of a schedule: "08:00" is not a time until
// something says where, and moving a routine from one zone to another is the
// same edit as moving it by an hour, said differently. An approval that
// survived a schedule edit and broke on a zone edit would be drawing the line
// somewhere nobody could explain, and the person re-approving would be
// confirming a plan that had not changed.
//
// The cost, named rather than hidden: a routine moved across the world runs at
// a genuinely different moment and nobody is asked again. That is the same
// cost the schedule exclusion already accepts. What approval covers is what a
// run will do and which files it will touch, and neither of those moves when
// the zone does.
//
// Read by name from a normalised routine, so the order the fields appear in
// the file cannot reach the hash either.
const PLAN_FIELDS = ['prompt', 'skill', 'runOn'];

function computePlanHash(routine) {
  const plan = PLAN_FIELDS.map(field => {
    const value = routine[field];
    return value === undefined || value === null ? null : String(value);
  });
  return crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

// ===== PLAN APPROVAL =====

// Approval is exactly "this hash, approved once": the file records the hash
// that was approved, and a routine is approved only while its CURRENT plan
// still computes to that hash. Editing what the routine does changes the
// computed hash and the approval lapses by mismatch, with nothing needing to
// remember to revoke it; editing when it runs changes nothing the hash reads,
// so approval survives, which is the whole point of the hash excluding the
// schedule and the timezone.
//
// COMPUTED, NEVER TRUSTED FROM THE FILE. The stored `planHash` is a record
// stamped by the writer and can go stale under a hand edit; comparing the
// approval against a recomputation of the live fields means a hand-edited
// prompt lapses the approval exactly as an editor edit would.
//
// ABSENCE IS NEVER-APPROVED, and so is the written word `pending`. The
// sentinel exists so a file can SAY a routine awaits approval rather than
// leaving the reader to infer it from a missing key, and so the migration
// can settle: a key the migration cannot fill would re-trigger it on every
// read. It can never equal a hash, so the comparison needs no special case.
const APPROVAL_PENDING = 'pending';

function planApproved(routine) {
  if (!routine || !routine.planApprovedHash) return false;
  return routine.planApprovedHash === computePlanHash(routine);
}

// The save-agent bound: a whole agent file written verbatim by a save (the
// RUNDOCK:SAVE_AGENT path, or the profile editor) can carry routine blocks
// the feature has never seen. Migration's file-level grandfather would treat
// a wholly key-less file as pre-feature and approve it, which for a file that
// arrived AFTER the feature is the one thing the approval step exists to
// stop. So the save path stamps the pending sentinel onto every routine block
// that carries no approval record before the file is trusted: the writer that
// introduces a block owns its consent state, exactly as appendRoutineBlock
// does for a single one. A block that already carries a record is left
// untouched, so saving an edited agent never lapses an approval that stands.
function stampPendingApprovals(content) {
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return content;
  const blocks = parseRoutineBlocks(fm[1]);
  let next = content;
  const seen = new Map();
  for (const block of blocks) {
    const occurrence = seen.get(block.name) || 0;
    seen.set(block.name, occurrence + 1);
    if (block.planApprovedHash !== undefined) continue;
    next = updateRoutineBlock(next, block.name, { planApprovedHash: APPROVAL_PENDING }, occurrence);
  }
  return next;
}

// ===== MIGRATION =====

// The keys a migrated routine carries. There is no schema version anywhere:
// whether a file has been migrated is a question the data answers, the same
// way the conversation store decides, so nothing has to keep a marker honest.
// `owner` is deliberately absent. Ownership was positional and unwritten, and
// writing it into every file that never named an owner would turn an implicit
// meaning into an explicit one that is then free to drift from the file it
// lives in.
//
// `timezone` is deliberately absent too, and for a sharper reason. Every other
// key here has a true value the migration can work out from the file: the run
// target defaults, the two switches have the meaning files already had, and
// the plan hash is computed from the routine itself. A routine written before
// this field existed was set in a zone nobody recorded, and there is no value
// in the file that says which. The only value this process could supply is the
// machine it happens to be running on, which is not the person's choice and is
// wrong for every routine somebody else's computer wrote. So the field is left
// absent, which is the honest record, and stays readable as "never recorded"
// rather than becoming a plausible wrong answer nobody can tell from a right
// one.
const MIGRATED_KEYS = ['runOn', 'enabled', 'paused', 'planHash', 'planApprovedHash'];
const BACKUP_SUFFIX = '.pre-routine-model-backup';

function needsMigration(rawRoutine) {
  return MIGRATED_KEYS.some(key => rawRoutine[key] === undefined);
}

/**
 * Bring one agent file's routines up to the new representation, lazily, on
 * read. Returns the migrated file content, and persists it best effort.
 *
 * The migrated content is computed BEFORE anything is written, and returned
 * whether or not the write lands. That is the whole reason a workspace nobody
 * can write to still runs: the caller's routines are migrated in memory, and
 * persisting is only how that is remembered for next time.
 *
 * Idempotent by construction: a file with nothing pending returns the content
 * it was given, having touched no disk and said nothing.
 */
function migrateAgentRoutines(filePath, content, opts = {}) {
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return content;
  const blocks = parseRoutineBlocks(fm[1]);
  if (!blocks.some(needsMigration)) return content;

  let next = content;
  let migrated = 0;
  // Count every block of a given name, not just the ones being migrated, so
  // the index handed to the writer is the block's real position among its
  // namesakes. Appending keys never reorders items, so the count stays valid
  // as the text is rewritten under it.
  // Does the file, as it sits on disk right now, carry an approval record on
  // any routine block? This is the pre-feature-vs-later discriminator the
  // grandfather line below reads. Computed from the RAW parsed blocks, so it
  // asks about the file's own text rather than a normalised default.
  const fileHasApproval = blocks.some(block => block.planApprovedHash !== undefined);
  const seen = new Map();
  for (const block of blocks) {
    const occurrence = seen.get(block.name) || 0;
    seen.set(block.name, occurrence + 1);
    if (!needsMigration(block)) continue;
    const routine = normalizeRoutine(block, opts);
    const updates = {};
    for (const key of MIGRATED_KEYS) {
      if (block[key] !== undefined) continue;
      if (key === 'planHash') { updates[key] = computePlanHash(routine); continue; }
      // THE GRANDFATHER LINE, drawn on the card's own words: approval is
      // for the first run of a NEW OR EDITED routine, and a routine that
      // predates the feature is neither. An upgrade that halted or
      // re-questioned an existing routine would be the predating-routines
      // defect in mirror image.
      //
      // WHAT TELLS A PRE-FEATURE PLAN FROM A LATER ONE, since both arrive
      // with no approval key. The signal is the FILE, not the block: a file
      // written before the feature carries the key on none of its blocks,
      // and the first read stamps every block at once. So a key-less block
      // sitting beside a block that DOES carry the key is a later addition,
      // to a file the feature has already touched, and it must meet the step
      // rather than inherit consent nobody gave. A block whose approval
      // record was lost (a hand edit, a copy) lands in exactly that state and
      // is refused, which is AC-3's lost-record clause. Only a wholly
      // key-less file is grandfathered.
      if (key === 'planApprovedHash') {
        updates[key] = fileHasApproval ? APPROVAL_PENDING : computePlanHash(routine);
        continue;
      }
      updates[key] = routine[key];
    }
    next = updateRoutineBlock(next, routine.name, updates, occurrence);
    migrated++;
  }
  try {
    // Write only when the file on disk is byte for byte what was read. That
    // covers two cases at once: a file someone edited since the read, which
    // must not be clobbered to record four keys, and a checkout with Windows
    // line endings, which differs from the newline-normalised text every
    // editor here works on and would otherwise be rewritten line by line.
    if (fs.readFileSync(filePath, 'utf-8') === content) {
      // Snapshot the file once, before the first migrating write, so a manual
      // recovery path exists. Every later attempt skips it: the copy worth
      // keeping is the one taken before anything touched the file.
      const backup = filePath + BACKUP_SUFFIX;
      if (!fs.existsSync(backup)) fs.copyFileSync(filePath, backup);
      fs.writeFileSync(filePath, next);
      console.log(`[migrate] ${path.basename(filePath)}: ${migrated} routines gained the new representation`);
    }
  } catch (err) {
    // Safe to retry: the next read attempts the same write again.
    console.error('[migrate] routine persist failed:', err && err.message ? err.message : err);
  }
  return next;
}

module.exports = {
  removeRoutineBlock, readRoutineBlock, readRoutineBlocks,
  MIGRATED_KEYS, BACKUP_SUFFIX, migrateAgentRoutines,
  RUN_ON_SUPPORTED, RUN_ON_RESERVED, RUN_ON_DEFAULT, isRunOnSupported,
  hasRunnablePrompt, isWritableSchedule,
  normalizeRoutine, parseRoutineBlocks, updateRoutineBlock, appendRoutineBlock,
  PLAN_FIELDS, computePlanHash, planApproved, APPROVAL_PENDING, stampPendingApprovals,
  assertFrontmatterKeysIntact, topLevelKeyCounts,
};
