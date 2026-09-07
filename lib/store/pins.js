'use strict';
/**
 * Where pins live, and what they are keyed by.
 *
 * PER MACHINE, PER USER, NOT IN THE WORKSPACE. A pin is one person's answer
 * to "which files do I live in", and a shared or synced workspace does not
 * share one person's answer. So the list lives beside the recent-workspaces
 * file in the home directory, as `.rundock-pins.json`, resolved through
 * os.homedir() at USE time (which is how the tests point it at a temporary
 * home), and nothing here ever writes under the workspace root. Conversation
 * pins are a different object in `.rundock/conversations.json` and are not
 * reused.
 *
 * THE FILE IS ONE OBJECT KEYED BY WORKSPACE, each value a list of
 * workspace-relative paths in the order they were pinned:
 *
 *   { "/Users/me/vault": ["Roadmap.md", "notes/backlog.md"] }
 *
 * THE KEY IS THE REALPATH OF THE WORKSPACE ROOT. That is the builder's stated
 * choice, and its consequences are the ones a reader should expect:
 *
 *   - a workspace opened at a new path is a new key and starts with no pins;
 *   - an entry whose path no longer exists is pruned on load, exactly as
 *     loadRecentWorkspaces in server.js prunes its own list;
 *   - a symlinked path and its target are one workspace, because the realpath
 *     is the same.
 *
 * A stable-identity rule would keep pins across a move, and it is admissible
 * only where the identity marker is something Rundock already holds. Nothing
 * Rundock holds today identifies a workspace across a rename, so the rule is
 * the path, and the recent-workspaces precedent says the same.
 *
 * THE RULES ARE THE MODEL'S. add, remove and normalize come from
 * public/pins-model.js, which the client's view also calls, so the wire and
 * the file agree about order and idempotence without a second copy here.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const model = require('../../public/pins-model.js');

function pinsFile() {
  return path.join(os.homedir(), '.rundock-pins.json');
}

/** @param {string} root */
function workspaceKey(root) {
  try { return fs.realpathSync(root); } catch (e) { return path.resolve(root); }
}

// The whole file, as an object, or nothing. A missing file, a hand-edit that
// is not JSON, or a JSON value that is not an object all read as empty: a
// pins file can never stop the server or the view.
function readAll() {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(pinsFile(), 'utf-8')); } catch (e) { return {}; }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function writeAll(all) {
  fs.writeFileSync(pinsFile(), JSON.stringify(all, null, 2));
}

// Load, pruning entries for workspace paths that no longer exist. Written
// back only when something was pruned, and only when the file already
// exists, so a read never creates the file.
function loadAll() {
  const all = readAll();
  const valid = {};
  let pruned = false;
  for (const [key, list] of Object.entries(all)) {
    if (fs.existsSync(key)) valid[key] = list;
    else pruned = true;
  }
  if (pruned) {
    try { writeAll(valid); } catch (e) {}
  }
  return valid;
}

/**
 * The pins for one workspace, in the order they were pinned.
 * @param {string} root
 * @returns {string[]}
 */
function loadPins(root) {
  return model.normalize(loadAll()[workspaceKey(root)]);
}

/**
 * Replace one workspace's list. An empty list removes the key rather than
 * leaving an empty entry behind.
 * @param {string} root @param {string[]} list
 */
function savePins(root, list) {
  const all = loadAll();
  const key = workspaceKey(root);
  const next = model.normalize(list);
  if (next.length) all[key] = next;
  else delete all[key];
  writeAll(all);
  return next;
}

/** @param {string} root @param {string} rel */
function pinFile(root, rel) {
  return savePins(root, model.add(loadPins(root), rel));
}

/** @param {string} root @param {string} rel */
function unpinFile(root, rel) {
  return savePins(root, model.remove(loadPins(root), rel));
}

module.exports = { pinsFile, workspaceKey, loadPins, savePins, pinFile, unpinFile };
