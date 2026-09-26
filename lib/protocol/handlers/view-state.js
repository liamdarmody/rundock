'use strict';
// WS handlers: an extension view's own state (lib/packages/extension-state.js).
//
// The page names the extension and the note from its mount: the extension
// that claimed the note and the path it mounted. The frame never sends
// either; its `setState` carries the state and nothing else, and the host
// adds the rest. State is kept only for a note an extension may be handed
// (lib/workspace/extension-file.js), so a hidden or linked path never gets
// a state file, and a read for one answers null.
//
// A write that lands says nothing. A refusal answers `view_state_refused`
// with a reason written for the extension's author, which the page passes
// to the live view as `refused` of `setState`.

const { getWorkspace } = require('../../config.js');
const { readState, writeState } = require('../../packages/extension-state.js');
const { extensionFileRefusal } = require('../../workspace/extension-file.js');

// The store's refusals, whose messages are written for the author. Anything
// else (a disk error) is reported without its message, which can name the
// workspace's path.
const NAMED = new Set(['not-object', 'not-json', 'too-deep', 'too-large', 'over-limit', 'not-installed', 'invalid-path']);

function send(ws, message) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(message));
}

function named(msg) {
  return {
    extension: msg && typeof msg.extension === 'string' ? msg.extension : '',
    path: msg && typeof msg.path === 'string' ? msg.path : '',
  };
}

function handleGetViewState(ctx, ws, msg) {
  const { extension, path } = named(msg);
  const requestId = msg && typeof msg.requestId === 'string' ? msg.requestId.slice(0, 64) : '';
  const workspace = getWorkspace();
  const state = workspace && !extensionFileRefusal(workspace, path) ? readState(workspace, extension, path) : null;
  send(ws, { type: 'view_state', extension, path, requestId, state });
}

function refusalFor(workspace, extension, path, state) {
  if (!workspace) return 'no workspace is open';
  const refusal = extensionFileRefusal(workspace, path);
  if (refusal) return refusal;
  if (!state || typeof state !== 'object' || Array.isArray(state)) return 'the view state must be an object';
  try {
    writeState(workspace, extension, path, state);
    return null;
  } catch (e) {
    return NAMED.has(e && e.code) ? e.message : 'the view state could not be saved';
  }
}

function handleSetViewState(ctx, ws, msg) {
  const { extension, path } = named(msg);
  const reason = refusalFor(getWorkspace(), extension, path, msg && msg.state);
  if (reason) send(ws, { type: 'view_state_refused', extension, path, reason });
}

module.exports = { handleGetViewState, handleSetViewState };
