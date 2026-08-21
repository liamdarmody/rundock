'use strict';
// WS handlers: workspace file access (tree, read with live watch, save,
// create, reveal). Extracted verbatim from server.js. The boundary guard,
// file caches, open-file watcher, and search engine are root-owned
// (injected via ctx); normalised reads are lib-owned. Workspace read at
// USE time.
const fs = require('fs');
const path = require('path');
const { getWorkspace } = require('../../config.js');
const { readNormalisedFile } = require('../../agents/discovery.js');

function handleGetFiles(ctx, ws, msg) {
  if (!getWorkspace()) return;
  try { ws.send(JSON.stringify({ type: 'file_tree', tree: ctx.workspace.fileTreeForSend() })); } catch (e) { console.warn('  File tree failed:', e.message); }
}

function handleReadFile(ctx, ws, msg) {
  const fullPath = path.resolve(getWorkspace(), msg.path);
  if (ctx.workspace.isInsideWorkspace(fullPath) && fs.existsSync(fullPath)) {
    ws.send(JSON.stringify({ type: 'file_content', path: msg.path, content: readNormalisedFile(fullPath) }));
    // Watch the now-open file so a change made outside Rundock (Obsidian,
    // an agent, another tool) pushes a live refresh to this client.
    ctx.workspace.watchOpenFile(ws, msg.path, fullPath);
  }
}

function handleSaveFile(ctx, ws, msg) {
  const fullPath = path.resolve(getWorkspace(), msg.path);
  if (ctx.workspace.isInsideWorkspace(fullPath)) {
    fs.writeFileSync(fullPath, msg.content, 'utf-8');
    // Keep the search index and the title-layer file list fresh on the
    // save hot path; guarded so an index failure can never affect the
    // save itself.
    ctx.workspace.invalidateFileListCache(); ctx.workspace.invalidateFileTreeCache();
    const engine = ctx.store.ensureSearchEngine();
    if (engine) {
      try { engine.noteFileSaved(getWorkspace(), msg.path); } catch (e) { /* reconcile catches up */ }
    }
    ws.send(JSON.stringify({ type: 'file_saved', path: msg.path }));
  }
}

// Create a note, board, or folder from the Files sidebar. Files must not
// clobber an existing path; folders are idempotent (mkdir -p). A fresh
// file tree is pushed so the sidebar updates without a manual reload.
function handleCreatePath(ctx, ws, msg) {
  const rel = String(msg.path || '').replace(/^\/+/, '');
  const full = path.resolve(getWorkspace(), rel);
  if (!rel || !ctx.workspace.isInsideWorkspace(full) || !ctx.workspace.isSafeCreatePath(rel)) {
    ws.send(JSON.stringify({ type: 'create_error', path: rel, reason: 'invalid path' }));
  } else if (msg.kind !== 'folder' && fs.existsSync(full)) {
    ws.send(JSON.stringify({ type: 'create_error', path: rel, reason: 'already exists' }));
  } else {
    try {
      if (msg.kind === 'folder') {
        fs.mkdirSync(full, { recursive: true });
      } else {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, msg.content || '', 'utf-8');
        ctx.workspace.invalidateFileListCache(); ctx.workspace.invalidateFileTreeCache();
        const engine = ctx.store.ensureSearchEngine(); if (engine) { try { engine.noteFileSaved(getWorkspace(), rel); } catch (e) {} }
      }
      ws.send(JSON.stringify({ type: 'file_tree', tree: ctx.workspace.fileTreeForSend() }));
      ws.send(JSON.stringify({ type: 'path_created', path: rel, kind: msg.kind }));
    } catch (e) {
      ws.send(JSON.stringify({ type: 'create_error', path: rel, reason: String((e && e.message) || e) }));
    }
  }
}

// Reveal a workspace path in the OS file manager (macOS only; a no-op
// elsewhere). Guarded to the workspace and a fixed command.
function handleRevealInFinder(ctx, ws, msg) {
  const full = path.resolve(getWorkspace(), String(msg.path || ''));
  if (ctx.workspace.isInsideWorkspace(full) && process.platform === 'darwin') {
    try { require('child_process').spawn('open', ['-R', full], { stdio: 'ignore' }); } catch (e) {}
  }
}

module.exports = { handleGetFiles, handleReadFile, handleSaveFile, handleCreatePath, handleRevealInFinder };
