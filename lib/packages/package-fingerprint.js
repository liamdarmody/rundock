'use strict';
// THE AUTHORED FINGERPRINT: what a package update compares, beside the
// whole-file fingerprint the receipt already keeps.
//
// Rundock writes into a package agent's file by itself. The routine
// migration adds runOn, enabled, paused, planHash and planApprovedHash to a
// hand-written routine on first read, and the Routines view writes a switch,
// a pause or a plan approval into the same block. None of that is an edit by
// the person, and none of it is the author's either, so an update that read
// it as one would call every routine-carrying agent "edited by you" within
// seconds of arriving. This digest leaves exactly those keys out, and only
// inside the routines section: the same word anywhere else is content.
//
// For a skill or a starter file nothing is written behind the person's back,
// so its authored fingerprint is its ordinary one.

const crypto = require('node:crypto');

const { MIGRATED_KEYS, locateSection, locateItems } = require('../agents/routines.js');

const DIGEST_VERSION = 'rundock-content-v1';
// The routine keys Rundock owns: the migration's, plus the moment an approval
// was given, which the Routines view writes beside the approval's hash.
const ROUTINE_STATE_KEYS = [...MIGRATED_KEYS, 'planApprovedAt'];
const STATE_LINE = new RegExp(`^[ \\t]*(?:${ROUTINE_STATE_KEYS.join('|')})[ \\t]*:`);

function withoutRoutineState(text) {
  const normal = String(text).replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const fm = /^---\n([\s\S]*?)\n---/.exec(normal);
  if (!fm) return normal;
  const lines = fm[1].split('\n');
  const section = locateSection(lines);
  if (!section) return normal;
  const drop = new Set();
  for (const item of locateItems(lines, section)) {
    // The item's own line carries its name, never a state key.
    for (let i = item.start + 1; i < item.end; i += 1) {
      if (STATE_LINE.test(lines[i])) drop.add(i);
    }
  }
  const kept = lines.filter((_, i) => !drop.has(i)).join('\n');
  return `---\n${kept}${normal.slice(4 + fm[1].length)}`;
}

/**
 * The authored fingerprint of one item. `bytes` is an agent's file as it
 * stands; `fingerprint` is the item's ordinary one, returned unchanged for
 * every other kind.
 */
function authoredDigest(kind, bytes, fingerprint) {
  if (kind !== 'agent') return fingerprint;
  const hash = crypto.createHash('sha256');
  hash.update(`${DIGEST_VERSION}:authored\0`);
  hash.update(withoutRoutineState(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : bytes));
  return `sha256:${hash.digest('hex')}`;
}

module.exports = { authoredDigest, ROUTINE_STATE_KEYS };
