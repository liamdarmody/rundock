// Renderer persistence. Plain Node: no Electron imports, unit-testable.
//
// The desktop app loads http://localhost:<port> with an OS-assigned port, so
// the web origin changes every launch and localStorage silently loses
// everything between sessions. Durable renderer state therefore lives here,
// in a JSON file under userData, which no port ever touches. The renderer
// reads a snapshot synchronously at boot (via preload) and writes through
// IPC; in a plain browser the app keeps using localStorage.
//
// Semantics mirror localStorage: string keys, string values. Values are
// coerced with String() on write and non-strings found in the file are
// dropped on load, so the renderer can trust the shape without checking.
//
// Storage loss must never break boot: a missing, corrupt, or wrongly-shaped
// file loads as empty storage.

'use strict';

const fs = require('fs');
const path = require('path');

const FILE_NAME = 'renderer-storage.json';

function loadRendererStorage(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, FILE_NAME), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const clean = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') clean[k] = v;
    }
    return clean;
  } catch {
    return {};
  }
}

function setRendererStorageKey(dir, key, value) {
  const snapshot = loadRendererStorage(dir);
  snapshot[String(key)] = String(value);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, FILE_NAME);
  // Write-then-rename so a crash mid-write leaves the previous file intact
  // rather than a truncated one (which would load as empty and silently
  // discard every stored preference).
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return snapshot;
}

module.exports = { loadRendererStorage, setRendererStorageKey };
