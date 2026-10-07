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

// Write `content` to `fullPath` without following a link at the last step.
// Throws ELOOP when the file itself is a link.
function writeFileNoFollow(fullPath, content) {
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(fullPath, flags, 0o644);
  try {
    fs.writeSync(fd, content, null, 'utf-8');
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { realLanding, writeLandsInside, writeFileNoFollow };
