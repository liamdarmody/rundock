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

// Unrecognised values fall back to the default rather than being kept, so a
// frontmatter typo cannot leave a routine in a state nothing knows how to
// read. This mirrors how the agent `runtime` field already behaves.
function readBoolean(raw, key, fallback) {
  const value = raw[key];
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null) return fallback;
  const text = unquote(value).toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
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
    enabled: readBoolean(raw, 'enabled', true),
    paused: readBoolean(raw, 'paused', false),
    planHash: readString(raw, 'planHash'),
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
// key means. One field needs more than that: a timezone is the answer to where
// a schedule was set, and an offset or an abbreviation written into it is
// wrong in a way that is only discovered twice a year, on the morning a
// routine runs an hour late.
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
    enabled: routine.enabled === undefined ? true : routine.enabled,
    planHash: computePlanHash(normalized),
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
const MIGRATED_KEYS = ['runOn', 'enabled', 'paused', 'planHash'];
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
  const seen = new Map();
  for (const block of blocks) {
    const occurrence = seen.get(block.name) || 0;
    seen.set(block.name, occurrence + 1);
    if (!needsMigration(block)) continue;
    const routine = normalizeRoutine(block, opts);
    const updates = {};
    for (const key of MIGRATED_KEYS) {
      if (block[key] !== undefined) continue;
      updates[key] = key === 'planHash' ? computePlanHash(routine) : routine[key];
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
  MIGRATED_KEYS, BACKUP_SUFFIX, migrateAgentRoutines,
  RUN_ON_SUPPORTED, RUN_ON_RESERVED, RUN_ON_DEFAULT, isRunOnSupported,
  normalizeRoutine, parseRoutineBlocks, updateRoutineBlock, appendRoutineBlock,
  assertFrontmatterKeysIntact, topLevelKeyCounts,
  PLAN_FIELDS, computePlanHash,
};
