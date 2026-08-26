'use strict';
// WS handler: read one run's record.
//
// The first consumer the run-record store has ever had. The store has been
// written since the observation work and nothing has read it, which is the
// whole reason this file is careful about one thing above all others.
//
// THE RECORD IS FORWARDED WHOLE, NEVER REBUILT.
//
// A record answers two different questions about files with two different
// shapes: `filesStatus: 'known'` with `files: []` is a run that changed
// nothing, and `filesStatus: 'unknown'` with `files: null` and a named reason
// is a run whose changes nobody can read. A routine that changed nothing is
// working normally; a routine whose changes are unknown is one where the
// observation is broken, and the two demand opposite responses from somebody
// deciding whether to trust an unattended run or revert it.
//
// A handler that named the fields it forwards would be one line from
// `files: record.files || []`, which type-checks, reads as tidiness and
// collapses those two answers into one permanently. It would also silently
// drop anything a later writer adds, in a store whose whole reason for
// existing is that the write and the read can happen in different versions of
// Rundock. So the record crosses the wire exactly as the reader handed it
// over, and the screen does the reading.
//
// THE ORDER IS THIS FILE'S BUSINESS. readRunRecords promises none, and says so:
// a directory listing has an order that belongs to the filesystem. Every
// record carries the instant its run started, so that is what the newest is
// resolved on rather than on whatever the disk happened to hand back.
//
// THE READER IS REACHED THROUGH THE MODULE rather than destructured off it, so
// the enumeration is a seam a test can drive. Directory order is a function of
// the filenames, so writing the same two names in a different order enumerates
// the same way both times: a test that varied only the write order would pass
// against a resolver that took whichever record came first. Ordering is what
// this file adds, so ordering has to be drivable.
const scheduler = require('../../scheduler.js');

/**
 * The most recent of a set of records, by the instant each run started.
 *
 * NOTHING HERE GUARDS AGAINST A NULL OR SHAPELESS RECORD, and that is stated
 * rather than left to be inferred. readRunRecords admits a parsed file only
 * when it is an object carrying a string id, and skips everything else, so by
 * the time a record reaches this function it is safe to dereference. An
 * earlier version guarded here and dereferenced unguarded in the filter two
 * lines below, which is worse than either choice made consistently: a guard
 * implies a case, and the next reader trusts the implication and writes a
 * third caller that does not survive it. If one ever did get through, the
 * handler would throw before sending anything, no reply would go out, and the
 * screen would wait forever, which is this card's own failure mode arriving by
 * another road. Pinned by "a record the reader would refuse never reaches the
 * resolver" rather than by this paragraph.
 *
 * The reader promises the id and nothing else, so a MISSING START is still a
 * real case and is handled below.
 */
function newest(records) {
  let best = null;
  let bestAt = -Infinity;
  for (const record of records) {
    const at = Date.parse(record.startedAt);
    // A record with no readable start still counts, at the bottom, rather than
    // being dropped: it is a run that happened, and hiding it would be a
    // stranger answer than showing it.
    const when = isFinite(at) ? at : -Infinity;
    if (best === null || when > bestAt) { best = record; bestAt = when; }
  }
  return best;
}

/**
 * One run, by its own id or as the latest run of a named routine.
 *
 * ALWAYS ANSWERS. A request this cannot meet is answered with `run: null`
 * rather than dropped, because a screen waiting on a reply that never comes
 * shows a spinner forever and says nothing about why.
 *
 * `run: null` IS NOT A RUN THAT CHANGED NOTHING. It is the absence of a
 * record, which the screen states as its own condition.
 *
 * The reply names what was asked for, so an answer that arrives after the
 * reader has moved on can be recognised as belonging to somewhere else.
 */
function handleGetRun(ctx, ws, msg) {
  const ask = msg || {};
  let run = null;
  const records = scheduler.readRunRecords();
  if (typeof ask.runId === 'string' && ask.runId) {
    run = records.find(record => record.id === ask.runId) || null;
  } else if (typeof ask.agentId === 'string' && typeof ask.routine === 'string') {
    run = newest(records.filter(record => record.agent === ask.agentId && record.routine === ask.routine));
  }
  ws.send(JSON.stringify({
    type: 'run',
    runId: ask.runId || null,
    agentId: ask.agentId || null,
    routine: ask.routine || null,
    run,
  }));
}

module.exports = { handleGetRun };
