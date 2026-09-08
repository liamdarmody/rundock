'use strict';
/**
 * The folders a workspace's agents work in besides the workspace itself.
 *
 * Stored on the workspace's own state, passed to every agent the workspace
 * spawns as RUNDOCK_EXTRA_DIRS, and read there by the permission hook, which
 * treats a named folder as inside the workspace for the boundary comparison.
 * A parent covers everything beneath it, including folders that do not exist
 * yet, which is the whole reason the setting is worth having: naming
 * `~/Projects` once is a statement about where this team works, and it does not
 * need revisiting every time a project starts.
 *
 * THIS MODULE DECIDES NOTHING ABOUT PERMISSIONS. It stores a list and renders
 * it for the environment; the hook alone decides what a named folder covers,
 * and it re-canonicalises every entry itself at comparison time. That division
 * is deliberate. The most expensive defect of the previous release was two
 * layers that both graded command text and learned different rules, each
 * internally correct and independently tested. There must be exactly one place
 * that answers "is this path inside", and it is not this file.
 */

const os = require('os');
const path = require('path');
const { readState, writeState } = require('../store/persistence.js');

// A folder whose own name contains the environment list's separator cannot be
// carried in that list: joined and split again it becomes two shorter paths,
// and a shorter path covers MORE than the one that was named. Legal on POSIX,
// vanishingly rare, and silently dangerous, so it is refused at the door rather
// than corrupted downstream.
function containsListSeparator(dir) {
  return dir.includes(path.delimiter);
}

/**
 * One folder, as it will be stored: `~` expanded, resolved absolute, trailing
 * separators removed. Returns null for anything that cannot be stored, so a
 * caller reports a reason rather than persisting something that means
 * something else.
 */
function normalizeOne(raw, home = os.homedir()) {
  if (typeof raw !== 'string') return null;
  let value = raw.trim();
  if (!value) return null;
  if (value === '~') value = home;
  else if (value.startsWith('~/') || value.startsWith('~\\')) value = path.join(home, value.slice(2));
  if (!path.isAbsolute(value)) return null;
  const resolved = path.resolve(value);
  if (containsListSeparator(resolved)) return null;
  // The filesystem root is not a statement about where a team works, it is the
  // absence of one: naming it makes every other folder on the machine inside,
  // permanently and invisibly, which no reader of the settings list would
  // expect from one row. The tiers under the runtime home would still hold,
  // but everything else on the disk would not.
  if (resolved === path.parse(resolved).root) return null;
  return resolved;
}

/**
 * The stored list: normalised and de-duplicated, in the order it was given.
 *
 * NO PREFIX COMPARISON HAPPENS HERE, and that is the point. An earlier version
 * collapsed a child into a named parent as a tidiness rule, which meant this
 * file answered "is this path inside that one" and so became the second place
 * answering a question the header above says has exactly one home. The two
 * disagreed immediately: the hook canonicalises and folds case by the host's
 * filesystem, this used the server platform, and the client's typing hint folded
 * no case at all. On macOS, with `~/Projects` named, typing `~/projects/x` got
 * no hint, was accepted, was silently collapsed here, and the row simply never
 * appeared, which is the vanishing row this setting must never produce.
 *
 * Nothing is lost by dropping it: the hook covers a child under a named parent
 * whether or not the child is also listed, so a redundant row is untidy and
 * never wrong. The interface discourages one while it is being typed.
 *
 * Entries are never dropped for not existing: a folder that has gone is shown
 * as missing, because silently removing a row a person deliberately added is
 * how a setting stops being trustworthy.
 */
function normalizeWorkingFolders(list, home = os.homedir()) {
  const kept = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const one = normalizeOne(raw, home);
    // Exact duplicates only. An identical string is the same folder by any
    // comparison anyone could implement, so removing it needs no rule.
    if (one && !kept.includes(one)) kept.push(one);
  }
  return kept;
}

function readWorkingFolders() {
  try {
    return normalizeWorkingFolders(readState().workingFolders);
  } catch (e) { return []; }
}

function writeWorkingFolders(list) {
  const kept = normalizeWorkingFolders(list);
  const state = readState();
  state.workingFolders = kept;
  writeState(state);
  return kept;
}

/**
 * The value the spawn path puts in the environment. Built from the stored list
 * at every spawn rather than captured once, so adding or removing a folder
 * reaches the next agent without restarting the app.
 */
function workingFoldersEnv(list = readWorkingFolders()) {
  return list.join(path.delimiter);
}

module.exports = {
  normalizeOne, normalizeWorkingFolders, readWorkingFolders, writeWorkingFolders, workingFoldersEnv,
};
