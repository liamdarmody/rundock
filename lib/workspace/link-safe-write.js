'use strict';
// WRITES THE SERVER MAKES INTO A WORKSPACE NEVER LEAVE IT THROUGH A LINK.
//
// The boundary check every file route uses compares path strings, so a link
// inside the workspace that points somewhere else reads as inside. For a read
// in the person's own window that is deliberate: someone who links single
// notes in from elsewhere still sees them. For a write it is not: the server
// writes outside every agent sandbox, so a write through such a link would
// land wherever the link points.
//
// So a write is allowed only when the real place it lands, links followed, is
// inside the real workspace or one of its named working folders. For a file
// that does not exist yet, that is the nearest folder above it that does.
// The file itself is then opened without following a link, so a link that
// appears between the check and the write is refused rather than followed,
// the same rule extension saves already keep (lib/workspace/extension-file.js).

const fs = require('node:fs');
const path = require('node:path');

function realOrNull(p) {
  try { return fs.realpathSync.native(p); } catch (e) { return null; }
}

// The real path a write to `target` would land in: the target's own, or for a
// path that does not exist yet, its nearest existing ancestor's plus the rest.
function realLanding(target) {
  let current = path.resolve(target);
  const rest = [];
  for (;;) {
    const real = realOrNull(current);
    if (real) return path.join(real, ...rest.reverse());
    const parent = path.dirname(current);
    if (parent === current) return null;
    rest.push(path.basename(current));
    current = parent;
  }
}

function within(child, root) {
  return child === root || child.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}

// Is `target` a place the server may write, given the workspace and the
// folders it names? Every root is compared by its real path too.
function writeLandsInside(target, roots) {
  const landing = realLanding(target);
  if (!landing) return false;
  return roots.filter(Boolean).some((root) => {
    const real = realOrNull(root);
    return !!real && within(landing, real);
  });
}

// Write all of `bytes` into the open file `fd`, from its start. One write
// call may take fewer bytes than it is handed (a nearly full drive, a limit
// on file size), and the count it returns is the only sign, so the rest is
// written again. Each write names its position, so where an earlier read
// left the file's offset cannot move it. A call that takes nothing is an
// error rather than a reason to retry forever.
function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
    if (!(written > 0)) {
      throw Object.assign(new Error(`EIO: a write made no progress with ${bytes.length - offset} bytes left, write`), { code: 'EIO', syscall: 'write' });
    }
    offset += written;
  }
}

// Replace the content of the file open at `fd` (for reading and writing)
// with `content`. The file stays the same file: it is never renamed,
// replaced or made again, so its other names, permissions and dates stay its
// own. Content that is not text is refused before the file is touched.
//
// What the file held is read first. When a write fails or stops making
// progress, that content is written back where it can be, and the error is
// thrown, so the save is always reported as failed. A restore that fails too
// still throws the write's error, marked `restoreFailed`. What this cannot
// put back: a file the save created is left empty; a process killed or a
// machine that loses power mid-write leaves whatever was written; and an
// error a filesystem reports only when the file is closed fails the save
// with nothing restored. Nothing here syncs to disk.
function replaceContent(fd, content) {
  if (typeof content !== 'string') throw new TypeError('The content to save must be text.');
  const next = Buffer.from(content, 'utf-8');
  const previous = fs.readFileSync(fd);
  fs.ftruncateSync(fd, 0);
  try {
    writeAll(fd, next);
  } catch (e) {
    try {
      fs.ftruncateSync(fd, 0);
      writeAll(fd, previous);
    } catch {
      if (e && typeof e === 'object') Object.assign(e, { restoreFailed: true });
    }
    throw e;
  }
}

// Write `content` to `fullPath` without following a link at the last step.
// Throws ELOOP when the file itself is a link. A save that fails throws,
// after putting the previous content back where it can (see
// replaceContent); a file this call created is left empty.
function writeFileNoFollow(fullPath, content) {
  const flags = fs.constants.O_RDWR | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(fullPath, flags, 0o644);
  try {
    replaceContent(fd, content);
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { realLanding, writeLandsInside, writeFileNoFollow, replaceContent };
