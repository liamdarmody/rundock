'use strict';
// A state file replaced whole, and one that does not parse kept rather than
// read as empty.
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

/**
 * `text`, read from `file`, parsed. Null when it does not parse: the file has
 * then been renamed aside under a dated name, so no later save can overwrite
 * it, and one error line names both paths. Starting from nothing is the
 * caller's decision, made knowing that this happened.
 *
 * The clock is asked only for that name, so a file that parses is read
 * whatever the clock does.
 * @param {string} file
 * @param {string} text
 * @param {() => Date} clock
 */
function parseOrSetAside(file, text, clock) {
  try {
    return JSON.parse(text);
  } catch (e) {
    let aside = null;
    try {
      aside = asideName(file, clock());
      fs.renameSync(file, aside);
      console.error(`[State] ${file} does not parse (${e.message}), so it was set aside as ${aside}`);
    } catch (moving) {
      console.error(`[State] ${file} does not parse (${e.message}), and setting it aside${aside ? ` as ${aside}` : ''} failed: ${moving.message}`);
    }
    return null;
  }
}

/**
 * Put what `write` writes in place of `file`, which does not parse, and keep
 * the bytes it holds under a dated name beside it, where no later save can
 * overwrite them. For a file the caller rebuilds and writes back at once.
 *
 * WHY THE BYTES KEEP THEIR OWN NAME UNTIL THE WRITE HAS SUCCEEDED. Renamed
 * aside first, a write that then failed (a full disk fails a write, where a
 * rename needs no space) or was cut off would leave no file under the name,
 * and the next start would load that as empty: for the routine state, every
 * routine that already ran this period would run again. So the dated name is
 * added as a second name for the same bytes, a hard link, and `write` then
 * renames the new file over the first: at no moment is there no file under
 * it. When `write` throws, the dated name is taken away again, the folder is
 * as it was, and the next start finds the same bytes and does what this load
 * did. A filesystem with no hard links gets a copy, written whole.
 *
 * Never throws. One error line says what happened, naming the file and, once
 * the bytes are kept, where.
 * @param {string} file
 * @param {Error} reason why it does not parse
 * @param {() => Date} clock asked only for the dated name
 * @param {() => void} write writes the file that takes its place
 */
function setAsideOnceReplaced(file, reason, clock, write) {
  const said = `[State] ${file} does not parse (${reason.message})`;
  let aside = null;
  try {
    aside = asideName(file, clock());
    keepAs(file, aside);
  } catch (e) {
    console.error(`${said}, and keeping it${aside ? ` as ${aside}` : ''} failed (${e.message}), so it was left where it is`);
    return;
  }
  try {
    write();
  } catch (e) {
    try { fs.rmSync(aside, { force: true }); } catch (removing) { /* the write's own error is the one to report */ }
    console.error(`${said}, and writing the file that takes its place failed (${e.message}), so it was left where it is`);
    return;
  }
  console.error(`${said}, so it was set aside as ${aside}`);
}

/** `file`'s bytes under the name `aside` as well, never over one already there. */
function keepAs(file, aside) {
  try {
    fs.linkSync(file, aside);
  } catch (e) {
    if (e.code === 'EEXIST') throw e;
    writeWholeFile(aside, fs.readFileSync(file));
  }
}

/** The dated name a file that does not parse is kept under, beside it. */
function asideName(file, now) {
  return `${file}.unparsed-${now.toISOString().replace(/[:.]/g, '-')}`;
}

module.exports = { writeWholeFile, parseOrSetAside, setAsideOnceReplaced };
