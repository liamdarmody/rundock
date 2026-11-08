'use strict';
// The one reader for a log another process appends to, one JSON record a line.
//
// The stub runtimes write their logs with appendFileSync from their own
// processes while a test polls the same file, so a read can land after part of
// a line is on disk and before the rest. A last line with no newline is that
// append still in progress: it is left out, and the next poll reads it whole.
// Every complete line must parse. One that does not is a broken writer, not a
// race, so it throws, naming the file and the line.
//
// Kept apart from harness.js so a file that cannot load the harness (a browser
// spec, a unit test that boots nothing) reads the logs the same way.
const fs = require('node:fs');

/** Every complete record in `file`, in order; [] when there is no file. */
function readAppendedLog(file) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf-8').split('\n');
  // The text after the last newline: '' when every append has finished.
  lines.pop();
  const records = [];
  lines.forEach((text, i) => {
    if (!text) return;
    try {
      records.push(JSON.parse(text));
    } catch (e) {
      throw new Error(`${file}: line ${i + 1} does not parse: ${e.message}`);
    }
  });
  return records;
}

module.exports = { readAppendedLog };
