"use strict";
// Every status the scheduler can record for a routine, read out of the
// scheduler itself.
//
// WHY IT IS READ RATHER THAN LISTED. Two suites drive "every status" through a
// surface and assert none of them reaches a reader as its own raw word. A list
// written in a test names the statuses its author knew about, so a status
// added to the scheduler later is never driven and the suite goes on reporting
// that it covers all of them.
//
// WHY IT LIVES HERE RATHER THAN IN EACH SUITE. The walk tracks the shape of
// the writer, which is the thing most likely to move. Copied into two files it
// has to be found and corrected in both, and the copy that goes blind keeps
// passing, which is exactly the failure the walk exists to prevent happening
// one level up. The sanity checks that name the words a suite expects stay
// with that suite; only the reading lives here.
//
// WHAT IT READS. Every quoted word on the `status:` line of a call that
// records a routine's state, however many the writer chooses between, plus the
// startup rewrite, which is the one writer that does not go through the
// recorder.
const fs = require("node:fs");
const path = require("node:path");

function statusesTheSchedulerRecords() {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "lib", "scheduler.js"), "utf-8");
  const found = new Set();
  for (const call of src.matchAll(/recordRoutineRun\(key, \{[\s\S]*?\}\)/g)) {
    for (const line of call[0].split("\n")) {
      if (!/\bstatus:/.test(line)) continue;
      for (const m of line.matchAll(/'(\w+)'/g)) found.add(m[1]);
    }
  }
  for (const m of src.matchAll(/state\.status = '(\w+)'/g)) found.add(m[1]);
  return [...found].sort();
}

module.exports = { statusesTheSchedulerRecords };
