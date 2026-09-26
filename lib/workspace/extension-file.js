'use strict';
// THE ONE RULE FOR A FILE AN EXTENSION MAY BE HANDED, OR MAY WRITE.
//
// The workspace boundary elsewhere is lexical: a path is "inside" when its
// text is. That is enough for Rundock's own editor, and not enough for a
// file handed to an extension, because a link has a visible name and a
// target anywhere: `notes/x.csv` linking to `.env`, or to a file outside the
// workspace, passes every lexical rule while its bytes are a credential. The
// trust card says hidden files and anything outside the workspace are never
// given to an extension, and this is what makes that sentence true.
//
// So a file is handed over, or written, only when all of these hold:
//   - its workspace-relative path has no hidden segment (and so no `..`);
//   - nothing on the way to it, and not the file itself, is a symlink,
//     observed with lstat so no link is ever followed to find out;
//   - it is a regular file with exactly one name: a hard link is a visible
//     second name for a file that may be hidden, and no path rule can see
//     that, so nlink > 1 is refused.
// Together these mean its real location is inside the workspace and not
// hidden, which is the rule; see the note in extensionFileRefusal.
//
// Refusals name the rule and never the target, so a reason shown to the
// person, or to the view, carries no path.

const fs = require('fs');
const path = require('path');
const { sameSources, CHANGED_LIST_REASON } = require('../../public/named-sources-model.js');

const REASONS = {
  hidden: 'a hidden file, or a file in a hidden folder, is never handed to an extension',
  linked: 'a linked file, or a file in a linked folder, is never handed to an extension',
  hardLink: 'a file with a second name elsewhere (a hard link) is never handed to an extension',
  missing: 'the file does not exist',
  notFile: 'only an ordinary file is handed to an extension',
  changedList: CHANGED_LIST_REASON,
};

function hasHiddenSegment(rel) {
  return String(rel).split(/[\\/]+/).some((segment) => segment.startsWith('.'));
}

// The refusal for this workspace-relative path, or null when an extension may
// be handed it. Reads metadata only; never the file's bytes.
function extensionFileRefusal(workspace, rel) {
  if (typeof rel !== 'string' || rel.length === 0 || path.isAbsolute(rel) || hasHiddenSegment(rel)) {
    return REASONS.hidden;
  }
  const segments = rel.split(/[\\/]+/).filter(Boolean);
  let current = workspace;
  let stat = null;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      stat = fs.lstatSync(current);
    } catch (e) {
      return REASONS.missing;
    }
    if (stat.isSymbolicLink()) return REASONS.linked;
  }
  if (!stat || !stat.isFile()) return REASONS.notFile;
  if (stat.nlink > 1) return REASONS.hardLink;
  // WHY THERE IS NO SEPARATE REALPATH COMPARISON. With no hidden segment in
  // the path and no link anywhere on the way down from the workspace, the
  // file's real location IS the workspace's real location plus this path, so
  // "resolves inside the workspace and is not hidden" is already proven. A
  // realpath check after this could never refuse anything, and a guard that
  // cannot fire reads as protection it does not give. Comparing real paths
  // as strings would also be wrong on a case-insensitive disk, where
  // realpath keeps whatever spelling it was handed.
  return null;
}

// Write an extension's bytes to this path, under the same rule, or return
// the refusal. The file is opened without following a link, so a file
// swapped for a link after the check is not written through; the open then
// fails and is reported as the link it has become. Returns null on success.
//
// NO WRITE AN EXTENSION CAUSES MAY CHANGE THE FILE'S `sources` LIST, whether
// the extension declared sources or not. A note's list is how the person
// chooses which files a view is handed; a view that could rewrite it could
// name any file and be handed it on the next read, and an extension that
// declares no sources could plant a list another one later receives. So the
// list the file holds on disk now and the list the new bytes would hold must
// be the same, or nothing is written. An edit that keeps the list is fine.
function writeExtensionFile(workspace, rel, content) {
  const refusal = extensionFileRefusal(workspace, rel);
  if (refusal) return refusal;
  const full = path.join(workspace, ...rel.split(/[\\/]+/).filter(Boolean));
  let before;
  try { before = fs.readFileSync(full, 'utf8'); } catch (e) { return REASONS.missing; }
  if (!sameSources(before, content)) return REASONS.changedList;
  let fd;
  try {
    fd = fs.openSync(full, fs.constants.O_WRONLY | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW || 0));
  } catch (e) {
    return e && e.code === 'ELOOP' ? REASONS.linked : REASONS.missing;
  }
  try {
    fs.writeSync(fd, content, null, 'utf-8');
  } finally {
    fs.closeSync(fd);
  }
  return null;
}

module.exports = { extensionFileRefusal, writeExtensionFile, REASONS };
