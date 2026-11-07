'use strict';
// A state file replaced whole.
//
// Used by the scheduler's routine state, slot records and run records, and by
// the runtime's child pid list: small files rewritten often, and read back by
// the next process to decide what has already run and what may be signalled.
// lib/workspace/atomic-write.js is the journaled multi-file transaction, which
// is far more than a write a minute needs.
//
// WHY A RENAME. Writing the file under its own name truncates it and then
// writes, so for as long as that takes it is empty or half written, and a
// process stopped in between, or a disk that fills, leaves it that way. A
// rename within one folder swaps the name in one step: a reader opens either
// the previous file or the new one, never part of either.
//
// WHY THE FLUSH, AND ONLY OF THE FILE. The rename alone does not make the new
// bytes durable: after a power cut the name can be on disk before the data is,
// which leaves an empty file under it. So the temporary file is flushed before
// it is renamed. The folder is not: losing the rename itself leaves the
// previous whole file, which is what a write cut off is allowed to leave.
const fs = require('fs');

let written = 0;

/**
 * Replace `file` with `contents`, whole. When it cannot, it throws and leaves
 * the previous file as it was, with no temporary file beside it.
 * @param {string} file
 * @param {string} contents
 */
function writeWholeFile(file, contents) {
  // The process and a count, so no two writes share a name. Never of the form
  // `<uuid>.json`, which is what the run record reader reads.
  const temp = `${file}.${process.pid}.${++written}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(temp, 'w');
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, file);
  } catch (e) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (closing) { /* the write's own error is the one to report */ }
    }
    try { fs.rmSync(temp, { force: true }); } catch (removing) { /* the write's own error is the one to report */ }
    throw e;
  }
}

module.exports = { writeWholeFile };
