'use strict';
// Reads test/fixtures/read-only-on-main.json, the verdicts main gave at the
// merge base, as test/tools/record-read-only-on-main.js wrote them.
//
// A COMMAND LONGER THAN A KIBIBYTE IS STORED IN PIECES. Those are the tests of
// the reading's own length limit, each a short text repeated thousands of
// times, so the recorder writes them as `{"pieces": [[text, times], ...]}`,
// and each piece's text repeated its times, joined in order, is the command.
// Every other command is stored as the string it is.
const LONGEST_AS_WRITTEN = 1024;

// The command a stored row holds. Anything that is neither a string nor a
// well-formed list of pieces throws, so a damaged recording is never read as
// some other command.
function decodeCommand(stored) {
  if (typeof stored === 'string') return stored;
  if (!stored || typeof stored !== 'object' || !Array.isArray(stored.pieces) || !stored.pieces.length) {
    throw new Error(`a recorded command is neither a string nor pieces: ${JSON.stringify(stored).slice(0, 200)}`);
  }
  let out = '';
  for (const piece of stored.pieces) {
    if (!Array.isArray(piece) || piece.length !== 2 || typeof piece[0] !== 'string' || !piece[0]
      || !Number.isInteger(piece[1]) || piece[1] < 1) {
      throw new Error(`a recorded piece is not [text, times]: ${JSON.stringify(piece).slice(0, 200)}`);
    }
    out += piece[0].repeat(piece[1]);
  }
  return out;
}

// The recording's rows, each [command, reads on main, risk on main], with
// every command decoded.
function recordedLines(recording = require('../fixtures/read-only-on-main.json')) {
  return recording.lines.map(([stored, reads, risk]) => [decodeCommand(stored), reads, risk]);
}

module.exports = { decodeCommand, recordedLines, LONGEST_AS_WRITTEN };
