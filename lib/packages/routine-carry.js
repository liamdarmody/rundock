'use strict';
// A PERSON'S ROUTINE SWITCHES, CARRIED ONTO THE AUTHOR'S NEW VERSION of an
// agent a package update rewrites. Turning a routine on or off, pausing it,
// choosing where it runs and approving its plan are the person's decisions,
// not edits, so an update must neither undo them nor count them as edits
// (see package-fingerprint.js). They are copied by routine name and
// occurrence, through the routines module's own writer; everything the
// author wrote stays as they wrote it. `planHash` is not carried: it is
// computed from the routine itself, so a changed instruction no longer
// matches the carried approval and the next run asks again.

const { parseRoutineBlocks, updateRoutineBlock, normalizeRoutine } = require('../agents/routines.js');

const CARRIED = ['enabled', 'paused', 'runOn', 'planApprovedHash', 'planApprovedAt'];

function frontmatterOf(text) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  return fm ? fm[1] : null;
}

// Each block with its unquoted name and its position among namesakes, the
// way the writer addresses it.
function namedBlocks(text) {
  const fm = frontmatterOf(text);
  if (fm === null) return [];
  const seen = new Map();
  return parseRoutineBlocks(fm).map((raw) => {
    const name = normalizeRoutine(raw).name;
    const occurrence = seen.get(name) || 0;
    seen.set(name, occurrence + 1);
    return { name, occurrence, raw };
  });
}

function routineStateOf(text) {
  return namedBlocks(String(text).replace(/\r\n/g, '\n')).map(({ name, occurrence, raw }) => ({
    name, occurrence,
    fields: Object.fromEntries(CARRIED.filter((key) => typeof raw[key] === 'string').map((key) => [key, raw[key]])),
  }));
}

function withRoutineState(text, states) {
  if (!states.length) return text;
  if (frontmatterOf(text) === null) {
    throw new Error('cannot carry routine switches onto an agent whose frontmatter this cannot address');
  }
  const present = namedBlocks(text);
  let next = text;
  for (const { name, occurrence, fields } of states) {
    for (const key of Object.keys(fields)) {
      if (!CARRIED.includes(key)) throw new Error(`"${key}" is not a routine switch an update carries`);
    }
    if (!present.some((b) => b.name === name && b.occurrence === occurrence)) continue;
    next = updateRoutineBlock(next, name, fields, occurrence);
    // Asked of the file, not inferred from bytes: the writer returns the
    // content unchanged both for a no-op and for a block it cannot address.
    const landed = namedBlocks(next).find((b) => b.name === name && b.occurrence === occurrence);
    for (const [key, value] of Object.entries(fields)) {
      if (!landed || landed.raw[key] !== value) throw new Error(`cannot carry "${key}" onto the routine "${name}"`);
    }
  }
  return next;
}

module.exports = { routineStateOf, withRoutineState, CARRIED_ROUTINE_FIELDS: CARRIED };
