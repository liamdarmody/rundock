'use strict';
/**
 * Rundock session persistence: the .rundock/ directory in the workspace root.
 * Conversations, conversation lists, and UI state live here as JSON files,
 * read and written wholesale (they are small and the server is the only
 * writer). Extracted from server.js verbatim; the only change is that the
 * workspace root is read from lib/config at use time, because the root is
 * live state that changes when the user switches workspace.
 */

const fs = require('fs');
const path = require('path');
const { getWorkspace } = require('../config.js');

function rundockDir() { return path.join(getWorkspace(), '.rundock'); }

function readConversations() {
  try {
    const file = path.join(rundockDir(), 'conversations.json');
    const list = JSON.parse(fs.readFileSync(file, 'utf-8'));
    // One-time migration: status: 'done' -> status: 'archived'. The UI renamed
    // Done to Archive; the data model follows so the rest of the code can
    // assume 'archived' without a backwards-compat fallback. Idempotent:
    // already-migrated workspaces hit no writes and no log lines.
    let migrated = 0;
    for (const c of list) {
      if (c.status === 'done') {
        c.status = 'archived';
        migrated++;
      }
    }
    if (migrated > 0) {
      try {
        // Snapshot the pre-migration file once before the first write so a
        // manual recovery path exists if anything later goes wrong. Skips on
        // every subsequent migration attempt since the backup is preserved.
        const backupPath = file + '.pre-archive-backup';
        if (!fs.existsSync(backupPath)) {
          fs.copyFileSync(file, backupPath);
        }
        writeConversations(list);
        console.log(`[migrate] conversations.json: ${migrated} done -> archived`);
      } catch (err) {
        // Migration is safe to retry: the in-memory list is already migrated
        // for this session, and the next workspace open will attempt the
        // write again. Do not throw; the rest of read should still return.
        console.error('[migrate] persist failed:', err && err.message ? err.message : err);
      }
    }
    return list;
  } catch (e) { return []; }
}

function writeConversations(list) {
  const dir = rundockDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'conversations.json'), JSON.stringify(list, null, 2));
}

// Conversation lists (user-named, many-to-many groupings shown as sidebar
// pills). The registry lives in .rundock/lists.json; membership lives on each
// conversation entry (listIds) so it rides the existing conversation
// persistence. Deleting a list removes the registry entry and strips the id
// from every conversation, never touching the conversations themselves.
function readLists() {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(rundockDir(), 'lists.json'), 'utf-8'));
    return Array.isArray(list) ? list.filter(l => l && typeof l.id === 'string' && typeof l.name === 'string') : [];
  } catch (e) { return []; }
}

function writeLists(lists) {
  const dir = rundockDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'lists.json'), JSON.stringify(lists, null, 2));
}

function deleteListEverywhere(listId) {
  writeLists(readLists().filter(l => l.id !== listId));
  const convos = readConversations();
  let changed = false;
  for (const c of convos) {
    if (Array.isArray(c.listIds) && c.listIds.includes(listId)) {
      c.listIds = c.listIds.filter(id => id !== listId);
      changed = true;
    }
  }
  if (changed) writeConversations(convos);
}

function readState() {
  try {
    const file = path.join(rundockDir(), 'state.json');
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) { return {}; }
}

function writeState(state) {
  const dir = rundockDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
}

module.exports = {
  rundockDir,
  readConversations, writeConversations,
  readLists, writeLists, deleteListEverywhere,
  readState, writeState,
};
