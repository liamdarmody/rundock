'use strict';
// WS handlers: file pins. Three messages, one reply.
//
// get_pins, pin_file and unpin_file each answer `pins` carrying the FULL list
// for the current workspace, in the order the files were pinned. One reply
// shape for every message means the client redraws from the list it was sent
// and never reasons about a delta, and a refused pin_file answers the list as
// it was, so the interface it drew stays true rather than optimistic.
//
// THE REFUSAL WRITES NOTHING. A pin is a workspace-relative path the client
// chose, so it is resolved against the workspace root and held to the same
// boundary guard every other file handler uses, injected through ctx exactly
// as read_file and save_file receive it. A path that resolves outside the
// workspace, names nothing, or names a folder is refused before the store is
// touched: no file is written, and the reply is the unchanged list.
//
// The store is lib-owned (lib/store/pins.js) and keyed by workspace; the
// workspace is read at USE time through lib/config, never captured.
const fs = require('fs');
const path = require('path');
const { getWorkspace } = require('../../config.js');
const store = require('../../store/pins.js');

function reply(ws, pins) {
  ws.send(JSON.stringify({ type: 'pins', pins }));
}

function handleGetPins(ctx, ws, msg) {
  const root = getWorkspace();
  reply(ws, root ? store.loadPins(root) : []);
}

function handlePinFile(ctx, ws, msg) {
  const root = getWorkspace();
  if (!root) { reply(ws, []); return; }
  const rel = String(msg.path || '').replace(/^\/+/, '');
  const full = path.resolve(root, rel);
  const isFile = () => { try { return fs.statSync(full).isFile(); } catch (e) { return false; } };
  if (!rel || !ctx.workspace.isInsideWorkspace(full) || !isFile()) {
    reply(ws, store.loadPins(root));
    return;
  }
  reply(ws, store.pinFile(root, rel));
}

function handleUnpinFile(ctx, ws, msg) {
  const root = getWorkspace();
  if (!root) { reply(ws, []); return; }
  reply(ws, store.unpinFile(root, String(msg.path || '')));
}

module.exports = { handleGetPins, handlePinFile, handleUnpinFile };
