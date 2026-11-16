'use strict';
// WHETHER THIS COMPUTER RUNS A WORKSPACE'S ROUTINES: on unless the person
// turned them off here, for that workspace, on this computer.
//
// One workspace synced to two computers (through a sync folder, or opened on
// a laptop and on a server) runs every routine once on each: a routine
// carries no machine, and every computer with the workspace open fires it.
// `paused` in the agent file cannot pick one of them, because the file syncs
// and pauses it everywhere. This switch is the answer that does not sync: it
// is kept in this install's own record, outside every workspace, beside the
// routine approvals record (lib/agents/approval-store.js) and the
// recent-workspaces file, so a sync tool never carries it.
//
// A WORKSPACE IS KEYED BY ITS PATH ON THIS COMPUTER, the same key the
// approvals record uses (its real path, so two spellings of one folder are
// one workspace). Turning routines off in one workspace leaves every other
// workspace on this computer running. A workspace that moves to a new path
// starts on, as a new one does.
//
// ON IS THE DEFAULT, AND THE ANSWER WHENEVER THE RECORD CANNOT BE READ. A
// record that does not parse is set aside under a dated name, as the
// scheduler's state files are, and the switch reads on. Choosing on over off
// is deliberate: a routine that runs twice is a duplicate the person can see
// and fix, and a routine that silently runs nowhere is not.
//
// Nothing here is written unless the answer changes: turning routines off
// twice leaves one record, and turning them on when they are on writes
// nothing. A write goes through the whole-file writer, so a write that fails
// leaves the previous record whole, and a record that could not be read is
// set aside under a dated name before one is written in its place.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { workspaceKey } = require('./approval-store.js');
const { writeWholeFile, parseOrSetAside, removeLeftTemps } = require('../store/whole-file.js');

let storeFile = null;
// The record when no file is configured: a test or a tool that never set one.
let memory = { workspaces: {} };
// Where the computer's name comes from: the server process, so a browser on a
// server is told the server's name. A seam for tests, which use a made-up one.
let readHostname = () => os.hostname();

function storePath() { return storeFile; }

function configureRoutinesHere(filePath) {
  storeFile = filePath || null;
  memory = { workspaces: {} };
  // A write cut off between its open and its rename leaves a temporary file
  // beside the record. Swept here, once, as the scheduler sweeps its own.
  if (storeFile) removeLeftTemps(path.dirname(storeFile), (name) => name === path.basename(storeFile));
}

// A fresh copy each call: the caller changes what it reads and writes it back.
// An empty record when there is none yet, and null when the one there cannot
// be read, does not parse (it is then set aside), or is not a record's shape.
function read() {
  if (!storeFile) return JSON.parse(JSON.stringify(memory));
  let text;
  try {
    text = fs.readFileSync(storeFile, 'utf-8');
  } catch (e) {
    if (e.code === 'ENOENT') return { workspaces: {} };
    console.error(`[Routines] ${storeFile} could not be read (${e.message}), so routines are on here`);
    return null;
  }
  const data = parseOrSetAside(storeFile, text, () => new Date());
  if (!data || typeof data !== 'object' || !data.workspaces || typeof data.workspaces !== 'object' || Array.isArray(data.workspaces)) {
    return null;
  }
  return data;
}

// The workspace's key: its real path on this computer, as the approvals
// record keys it, so each workspace has a switch of its own.
function keyOf(dir) {
  return workspaceKey(dir);
}

// A record that is there but could not be read, or is not a record's shape,
// may still hold off entries for other workspaces. Before anything is written
// in its place it is kept under a dated name beside it, as a record that does
// not parse already is, so no save writes over it. Throws when it cannot be
// kept, and then nothing is written.
function setAsideUnread() {
  if (!storeFile) return;
  try {
    fs.lstatSync(storeFile);
  } catch (e) {
    // Nothing under the name: a record that did not parse is already aside.
    if (e.code === 'ENOENT') return;
  }
  const aside = `${storeFile}.unparsed-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try {
    fs.renameSync(storeFile, aside);
  } catch (e) {
    throw new Error(`${storeFile} could not be read, and setting it aside failed (${e.message}), so nothing was written`);
  }
  console.error(`[Routines] ${storeFile} could not be read as a record, so it was set aside as ${aside}`);
}

function write(data) {
  if (!storeFile) { memory = JSON.parse(JSON.stringify(data)); return; }
  fs.mkdirSync(path.dirname(storeFile), { recursive: true });
  writeWholeFile(storeFile, JSON.stringify(data, null, 2));
}

function offIn(data, key) {
  const entry = key ? data.workspaces[key] : null;
  return !!(entry && entry.off === true);
}

/** Whether routines are off on this computer for the workspace at `dir`. */
function offHere(dir) {
  if (!dir) return false;
  const data = read();
  // A record nobody can read says nothing, and nothing said is on.
  if (!data) return false;
  return offIn(data, keyOf(dir));
}

/**
 * Turn routines off (`off` true) or back on for the workspace at `dir`, on
 * this computer. Returns whether anything was written. Throws when the record
 * cannot be written, leaving it as it was.
 */
function setOffHere(dir, off) {
  if (!dir) throw new Error('no workspace is open');
  const key = keyOf(dir);
  let data = read();
  if (offIn(data || { workspaces: {} }, key) === !!off) return false;
  if (!data) {
    setAsideUnread();
    data = { workspaces: {} };
  }
  if (off) data.workspaces[key] = { off: true };
  else delete data.workspaces[key];
  write(data);
  return true;
}

/**
 * This computer's name as a person would read it, or null when none can be
 * read. The `.local` a Mac adds to its network name is dropped.
 */
function computerName() {
  let name;
  try { name = readHostname(); } catch (e) { return null; }
  if (typeof name !== 'string') return null;
  const plain = name.trim().replace(/\.local$/i, '');
  return plain || null;
}

/** For tests: where the computer's name is read from. Returns the previous reader. */
function wireHostname(next) {
  const previous = readHostname;
  readHostname = next;
  return previous;
}

/** What a window is told about this workspace on this computer, beside its roster. */
function routinesHereFor(dir) {
  if (!dir) return null;
  return { off: offHere(dir), computer: computerName() };
}

module.exports = {
  configureRoutinesHere, storePath, offHere, setOffHere, computerName, wireHostname, routinesHereFor,
};
