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

// WHAT NOTES MODE KEEPS AN AGENT FROM WRITING: files of these types, which run
// as code. One array, read by both halves of the list below, so the halves
// cannot name different types.
const NOTES_BLOCKED_EXTENSIONS = Object.freeze(['js', 'jsx', 'ts', 'tsx', 'py', 'sh', 'bash', 'rb', 'pl', 'exe', 'dll', 'so']);

// THE --disallowed-tools VALUE FOR NOTES MODE, the one value a Notes-mode spawn
// is handed.
//
// THE Edit HALF IS THE HALF CLAUDE CODE ENFORCES. It matches a path rule only
// when the rule is written as Edit(...), and an Edit(path) rule covers every
// tool that writes a file: Write, Edit and NotebookEdit. Claude Code's own rule
// check says a Write(path) rule never matches. The Write half is kept, from
// the same array, so the value still reads as what it means; but a type
// missing from the Edit half is a type an agent can write, which is how .dll
// and .so were writable while the Write half named them.
//
// THE SAME RULES HOLD A SHELL RENAME OR DELETE. Claude Code checks the paths a
// shell `rm` or `mv` names against Edit(path) rules too, so in Notes mode
// `rm tool.py` and `mv note.md note.py` are refused even when a person approves
// the card, while renaming or deleting a note is not.
//
// NotebookEdit is turned off outright rather than limited by type: it writes
// only notebooks, and a notebook is code. MultiEdit is not named, because it is
// not a tool in the Claude Code this was checked against, and a rule for a
// tool that does not exist protects nothing.
const NOTES_DISALLOWED_TOOLS = [
  ...NOTES_BLOCKED_EXTENSIONS.map(ext => `Write(*.${ext})`),
  ...NOTES_BLOCKED_EXTENSIONS.map(ext => `Edit(*.${ext})`),
  'NotebookEdit',
].join(',');

module.exports = { normalizeWorkspaceMode, WRITABLE_MODES, NOTES_BLOCKED_EXTENSIONS, NOTES_DISALLOWED_TOOLS };
