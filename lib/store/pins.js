'use strict';
/**
 * Where pins live.
 *
 * IN THE WORKSPACE, AT `.rundock/pins.json`, beside conversations.json,
 * lists.json and permissions.json. It is the same shape as its neighbours: the
 * bare structure, two-space JSON, written after mkdir -p, and `.rundock/` is
 * gitignored, which is what keeps one person's answer out of a shared repo.
 *
 * IT USED TO LIVE IN THE HOME DIRECTORY, keyed by the realpath of the
 * workspace root, and the reasoning was that a pin is one person's answer to
 * "which files do I live in", so a shared workspace should not share it. The
 * protection was real and narrow, and it was paid for with the case that
 * actually happens: the SAME person opening the SAME synced workspace from a
 * second machine, where the absolute path differs (`/Users/...` against
 * `/home/...`) and so the key differs, and the pins are simply not there. A
 * rename or a move lost them for the same reason. Meanwhile `.rundock/`
 * already holds this workspace's permissions and its MCP secrets, so pins are
 * not the most private thing in that directory by a wide margin, and for the
 * common sharing method, git, the directory is ignored and nothing leaks.
 *
 * WHAT THIS DELETED, which is the other half of the argument. Keying by
 * realpath meant a rule about moved workspaces, a rule about symlinks
 * resolving to one key, and a prune pass that rewrote the file whenever a
 * recorded workspace no longer existed. A file that lives inside the workspace
 * it describes needs none of them: it moves when the workspace moves, and it
 * is gone when the workspace is gone.
 *
 * Paths are workspace-relative and in the order they were pinned:
 *
 *   ["Roadmap.md", "notes/backlog.md"]
 *
 * Conversation pins are a different object, inside `.rundock/conversations.json`,
 * and are not reused here.
 *
 * THE RULES ARE THE MODEL'S. add, remove and normalize come from
 * public/pins-model.js, which the client's view also calls, so the wire and
 * the file agree about order and idempotence without a second copy here.
 */
const fs = require('fs');
const path = require('path');
const model = require('../../public/pins-model.js');

/** @param {string} root */
function pinsFile(root) {
  return path.join(root, '.rundock', 'pins.json');
}

/**
 * The pins for this workspace, in the order they were pinned.
 *
 * A missing file, a hand-edit that is not JSON, or a JSON value that is not an
 * array all read as empty: a pins file can never stop the server or the view.
 * @param {string} root
 * @returns {string[]}
 */
function loadPins(root) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(pinsFile(root), 'utf-8')); } catch (e) { return []; }
  return model.normalize(parsed);
}

/**
 * Replace the list. Written even when empty, because an empty pins file and no
 * pins file mean the same thing to every reader and deleting it would make
 * "you unpinned everything" indistinguishable from "this is a fresh workspace".
 * @param {string} root @param {string[]} list
 */
function savePins(root, list) {
  const next = model.normalize(list);
  fs.mkdirSync(path.join(root, '.rundock'), { recursive: true });
  fs.writeFileSync(pinsFile(root), JSON.stringify(next, null, 2));
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

module.exports = { pinsFile, loadPins, savePins, pinFile, unpinFile };
