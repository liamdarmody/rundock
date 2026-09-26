'use strict';
// THE WORKSPACE MODE, READ ONE WAY EVERYWHERE.
//
// Two modes: `code`, and `notes` for everything else. Every reader of the
// stored value goes through normalizeWorkspaceMode, so the rule "anything but
// code is the restrictive mode" is written once instead of at every reader.
//
// READ BOTH, FOREVER. The value was stored as `knowledge` until 0.15.0, and an
// older build, a second machine on an older version, a synced folder or a
// restored backup can write `knowledge` back at any time. So `knowledge`,
// absent, and anything unrecognised all read as `notes`, which is the
// restrictive direction: an unknown value never lifts a restriction.
//
// WRITE ONLY THE TWO. Every Rundock from v0.9.0 to v0.14.0 reads the stored
// value with `=== 'code'`, so `notes` on disk is read correctly by all of
// them as the restrictive mode, with no compatibility code needed there.
// WRITABLE_MODES is the contract that keeps that true: a third value added
// later would be read by those builds as Notes without anyone deciding it.
const WRITABLE_MODES = Object.freeze(['notes', 'code']);

function normalizeWorkspaceMode(raw) {
  return raw === 'code' ? 'code' : 'notes';
}

module.exports = { normalizeWorkspaceMode, WRITABLE_MODES };
