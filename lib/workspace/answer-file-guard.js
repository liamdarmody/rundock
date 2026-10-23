'use strict';
// THE WORKSPACE'S OWN PERMISSION ANSWERS, GUARDED AGAINST ANY CHANGE RUNDOCK
// DID NOT MAKE.
//
// `.rundock/permissions.json`, `.rundock/state.json`,
// `.claude/settings.local.json` and `.claude/settings.json` hold the answers a
// person gave about what agents may do, and the checks that ask them.
//
// Codex never runs the permission hook, and measured against codex-cli
// 0.156.1, a thread started the way Rundock starts one (cwd = the workspace,
// sandbox workspace-write, approvalPolicy on-request) wrote them, by file edit
// and by shell redirect, with no approval request at all. Claude agents meet
// the hook, but the hook reads the command a tool call carries, not what a
// script does once it runs: a write made inside `node -e`, `python3 -c` or any
// script is not a path the hook can see. So the protection that holds however
// a write was made sits here, outside both runtimes:
//
//   DETECT AND RESTORE AGAINST A BASELINE THAT OUTLIVES EVERY TURN. The first
//   turn in a workspace records what stands at each path; that baseline is
//   kept for as long as Rundock runs, and only Rundock's own writes (or a
//   person's approval) move it. Whenever a turn starts (a Codex turn, or a
//   Claude turn: direct chats, delegates and routines alike), every
//   CHECK_INTERVAL_MS while any turn runs, before any Codex approval is
//   answered, and once more when each turn ends, the files are compared with
//   it. A change Rundock did not make is put back at once, byte for byte and
//   mode for mode (or removed, if the file did not exist), and handed to one
//   caller, which tells the person and asks whether to keep it.
//
//   A CHANGE MADE WHILE NO TURN RAN (a person editing by hand, or a background
//   job an agent started that outlived its turn) is caught when the next turn
//   starts, and says so: `outsideTurn` is set on it. Adopting it silently as
//   the next turn's starting point would let a late write stand for good.
//
//   EXCEPT THE CLAUDE CODE SETTINGS FILES. `.claude/settings.local.json` and
//   `.claude/settings.json` are also edited outside Rundock, by the person, a
//   terminal session or file sync. A change to one of them found as a turn
//   starts is left alone: it quietly becomes the new baseline, with no notice
//   and no card. During a turn they are guarded like the rest. Rundock's own
//   two files have no other writer, so a change to them is always put back
//   and asked about.
//
// What stands at each path is read without following links. A path turned
// into a link, a folder or anything else is removed and the file restored as
// a plain file, so a restore never writes through a link to somewhere else.
// The same holds for the folders on the way: one swapped for a link is taken
// away before anything is put back (see putBackFolders).
// A file's mode is part of what it is: one made read-only would stop Rundock
// itself from recording or withdrawing an answer, so it is a change too.
//
// Rundock's own writes (a setting changed, a folder named, a standing allow
// stored, during a turn or between turns) are recognised by content: every
// writer records what it wrote through noteOwnWrite, and a plain file whose
// bytes match the last write Rundock recorded for it, and whose mode is
// unchanged, is taken as the new baseline, not restored.
//
// The window between an agent's write and the check is bounded by the
// interval. Within it, the permission hook reads the file fresh on every call,
// so a standing allow planted and restored inside that window could answer at
// most a card raised in the same instant; the change is reported either way.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

//
// THE FILES THAT DECIDE WHAT RUNS are watched the same way, because a Codex
// agent's write inside the workspace never escalates to a card: the launcher
// the runtime starts the permission hook through, `.mcp.json`, the per-user
// connector file, and the hook scripts under `.claude/hooks/`. The list is the
// permission hook's own registry (WORKSPACE_ANSWER_FILES), so the two never
// name different files. The hook-scripts folder is listed again at every
// check, up to HOOK_SCRIPTS_MAX files a few folders deep, so a script that
// was not there when the baseline was taken is a change from nothing: removed
// and offered on the card when it appears during a turn, and the starting
// point when it is found as a turn starts. The folder is listed only while it
// is still where it was when the guard started, never through a link put in
// its place, so nothing outside the workspace is taken for a new script.
const { WORKSPACE_ANSWER_FILES } = require('../../scripts/permission-hook.js');
const ANSWER_FILES = [...WORKSPACE_ANSWER_FILES];
const HOOK_SCRIPTS_DIR = '.claude/hooks';
const HOOK_SCRIPTS_MAX = 64;
// The files other tools edit too: left alone when changed between turns. A
// person edits `.mcp.json`, the per-user connector file and the hook scripts
// by hand, and git changes them; only Rundock writes the launcher.
const SHARED_FILES = new Set(['.claude/settings.local.json', '.claude/settings.json', '.mcp.json', '.rundock/mcp-secrets.json']);
const isShared = relative => SHARED_FILES.has(relative) || relative.startsWith(`${HOOK_SCRIPTS_DIR}/`);
const CHECK_INTERVAL_MS = 250;

// The hook scripts under `.claude/hooks/` now, as workspace-relative paths:
// files and links, a few folders deep, never followed through a link.
function hookScriptsIn(root) {
  const found = [];
  const walk = (rel, depth) => {
    if (depth > 4 || found.length >= HOOK_SCRIPTS_MAX) return;
    let entries = [];
    try { entries = fs.readdirSync(path.join(root, ...rel.split('/')), { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (found.length >= HOOK_SCRIPTS_MAX) return;
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(child, depth + 1);
      else found.push(child);
    }
  };
  walk(HOOK_SCRIPTS_DIR, 0);
  return found;
}

function realOrNull(p) { try { return fs.realpathSync(p); } catch (e) { return null; } }
// Where the hook-scripts folder really is, or would be if it were made inside
// the `.claude` folder that stands now.
function hooksFolderAt(root) {
  const claude = path.join(root, '.claude');
  return realOrNull(path.join(root, ...HOOK_SCRIPTS_DIR.split('/')))
    || path.join(realOrNull(claude) || path.join(realOrNull(root) || root, '.claude'), 'hooks');
}
// Watch every hook script there now that the baseline does not hold yet, as a
// file that did not exist.
function watchNewHookScripts(root, g) {
  if (realOrNull(path.join(root, ...HOOK_SCRIPTS_DIR.split('/'))) !== g.hooksAt) return;
  for (const rel of hookScriptsIn(root)) {
    const f = path.join(root, ...rel.split('/'));
    if (!g.snapshot.has(f)) { g.files.push(f); g.snapshot.set(f, null); }
  }
}

// THE FOLDERS ON THE WAY TO A WATCHED FILE, as they stood when it was first
// watched: where each really is, and the link it was if it was one. Reading
// through a folder swapped for a link makes the files look changed, and
// putting them back through it would overwrite, or remove, files wherever it
// points: `.claude` linked to the runtime's own folder would have its
// settings replaced, or removed when the workspace had none.
function foldersOn(root, file) {
  const out = [];
  let at = root;
  for (const part of path.relative(root, path.dirname(file)).split(path.sep).filter(Boolean)) {
    at = path.join(at, part);
    out.push(at);
  }
  return out;
}
function noteFolders(root, g, file) {
  for (const at of foldersOn(root, file)) {
    if (g.folders.has(at)) continue;
    let link = null;
    try { if (fs.lstatSync(at).isSymbolicLink()) link = fs.readlinkSync(at); } catch (e) { /* not there yet */ }
    g.folders.set(at, { real: realOrNull(at), link });
  }
}
// Before a file is put back: a folder on the way that is a link it was not
// when first seen is removed, so the restore makes a real folder inside the
// workspace; a link the person had there (`.claude` kept elsewhere, say) is
// theirs, kept while it points where it did and pointed back if it does not.
function putBackFolders(root, g, file) {
  for (const at of foldersOn(root, file)) {
    let st;
    try { st = fs.lstatSync(at); } catch (e) { return; }
    if (!st.isSymbolicLink()) continue;
    const was = g.folders.get(at);
    if (was && was.link !== null && realOrNull(at) === was.real) continue;
    fs.unlinkSync(at);
    if (!(was && was.link !== null)) return;
    fs.symlinkSync(was.link, at);
  }
}

const own = new Map(); // absolute path -> sha256 of the bytes Rundock last wrote there
function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function key(p) { return path.resolve(p); }

// Every Rundock writer of an answer file calls this with what it wrote.
// `content` null records that Rundock removed the file.
function noteOwnWrite(file, content) {
  try {
    own.set(key(file), content === null ? ABSENT : digest(Buffer.isBuffer(content) ? content : Buffer.from(String(content))));
  } catch (e) { /* never block a write */ }
}
const ABSENT = 'absent';

// What stands at an answer file's path, read without following a link first:
//   null                      nothing
//   { file, bytes, mode }     a plain file: its bytes and permission bits
//   { link, bytes }           a symlink: where it points, and what reading
//                             through it gives (null if nothing readable)
//   { other: true }           a folder, or anything else
function read(file) {
  let st;
  try { st = fs.lstatSync(file); } catch (e) { return null; }
  if (st.isFile()) {
    try { return { file: true, bytes: fs.readFileSync(file), mode: st.mode & 0o7777 }; } catch (e) { return { other: true, mode: st.mode & 0o7777 }; }
  }
  if (st.isSymbolicLink()) {
    let link = null;
    let bytes = null;
    try { link = fs.readlinkSync(file); } catch (e) { /* unreadable link */ }
    try { if (fs.statSync(file).isFile()) bytes = fs.readFileSync(file); } catch (e) { /* dangling */ }
    return { link, bytes };
  }
  return { other: true };
}
const isPlain = s => !!(s && s.file);
function sameBytes(a, b) {
  if (a === null || b === null) return a === b;
  return a.equals(b);
}
function same(a, b) {
  if (a === null || b === null) return a === b;
  if (isPlain(a) || isPlain(b)) return isPlain(a) && isPlain(b) && a.mode === b.mode && a.bytes.equals(b.bytes);
  if (a.other || b.other) return !!(a.other && b.other) && a.mode === b.mode;
  return a.link === b.link && sameBytes(a.bytes, b.bytes);
}
// The text a card shows as the changed version.
function textOf(state) {
  return state && state.bytes ? state.bytes.toString('utf-8') : null;
}

// Put `bytes` (a Buffer or string; null for nothing) at `file` as a plain
// file, with `mode` when one is given. Whatever stands there first, a link or
// a folder included, is removed, and the new file is created exclusively, so
// nothing is ever written through a link that appears in between.
function writePlain(file, bytes, mode) {
  let st = null;
  try { st = fs.lstatSync(file); } catch (e) { /* nothing there */ }
  if (st) fs.rmSync(file, { force: true, recursive: st.isDirectory() });
  if (bytes === null) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes, { flag: 'wx' });
  if (typeof mode === 'number') fs.chmodSync(file, mode);
}

// Put back what stood at `file` in the baseline. A plain file, or nothing, is
// restored as such, mode included. A link the person had there themselves (a
// settings file kept elsewhere, say) is recreated, and its content restored
// through it; a folder or anything else cannot be recreated and is reported.
function restore(file, was) {
  if (was === null) return writePlain(file, null);
  if (isPlain(was)) return writePlain(file, was.bytes, was.mode);
  if (was.other || was.link === null) return undefined;
  const now = read(file);
  if (!(now && !isPlain(now) && !now.other && now.link === was.link)) {
    writePlain(file, null);
    fs.symlinkSync(was.link, file);
  }
  if (was.bytes !== null && !sameBytes(read(file).bytes, was.bytes)) fs.writeFileSync(file, was.bytes);
  return undefined;
}

// One guard per workspace, kept for as long as Rundock runs, and shared by
// every turn in it: { files, snapshot, timer, listeners }. The snapshot is the
// baseline; the timer runs only while a turn does.
const guards = new Map();

function snapshotOf(files) {
  const snap = new Map();
  for (const f of files) snap.set(f, read(f));
  return snap;
}

// A CHANGE A PERSON ALLOWED ON THE HOOK'S CARD STANDS. The hook asked before
// a Claude agent's write ran and the person allowed it, so putting the write
// back and asking again would ask twice about one change. The server marks
// each path an Allow covered, for the conversation it was given in, with the
// content the card showed where the tool names it (null for a shell command,
// which names no content). The next change to that path while one of that
// conversation's turns runs here is taken as the new baseline, once, if its
// content matches; a mark nothing used goes when that conversation's turn
// ends. Keyed by the real folder the file is in, so a folder swapped for a
// link since never matches.
const allowedChanges = new Map(); // path -> { convoId, digest }
function markKey(p) {
  const abs = path.resolve(p);
  const dir = realOrNull(path.dirname(abs));
  return dir ? path.join(dir, path.basename(abs)) : abs;
}
function allowAnswerFileChange(file, { convoId, content = null } = {}) {
  if (!file || typeof convoId !== 'string' || !convoId) return;
  try {
    const bytes = content === null ? null : (Buffer.isBuffer(content) ? content : Buffer.from(String(content)));
    allowedChanges.set(markKey(file), { convoId, digest: bytes === null ? null : digest(bytes) });
  } catch (e) { /* never block an answer */ }
}
function takeAllowed(g, f, now) {
  const at = markKey(f);
  const mark = allowedChanges.get(at);
  if (!mark || ![...g.listeners].some(l => l.convoId === mark.convoId)) return false;
  if (mark.digest !== null && !(isPlain(now) && digest(now.bytes) === mark.digest)) return false;
  allowedChanges.delete(at);
  return true;
}

function check(workspace, { outsideTurn = false } = {}) {
  const g = guards.get(key(workspace));
  if (!g) return [];
  watchNewHookScripts(key(workspace), g);
  const found = [];
  for (const f of g.files) {
    const now = read(f);
    const was = g.snapshot.get(f);
    if (same(now, was)) continue;
    // Rundock's own write. Rundock only ever writes plain files, and never
    // changes a file's mode, so nothing else is taken as one.
    const ownBytes = now === null ? own.get(f) === ABSENT : isPlain(now) && own.get(f) === digest(now.bytes);
    const modeKept = !(isPlain(now) && isPlain(was)) || now.mode === was.mode;
    if (ownBytes && modeKept) { g.snapshot.set(f, now); continue; }
    // A change the person allowed on the hook's card, during this turn.
    if (!outsideTurn && modeKept && takeAllowed(g, f, now)) { g.snapshot.set(f, now); continue; }
    const relative = path.relative(key(workspace), f).split(path.sep).join('/');
    // Changed outside Rundock between turns: the new baseline, said nowhere.
    if (outsideTurn && isShared(relative)) { g.snapshot.set(f, now); continue; }
    // Not Rundock's: put it back, then report it.
    try { putBackFolders(key(workspace), g, f); restore(f, was); } catch (e) { /* reported below either way */ }
    const change = {
      file: f,
      relative: path.relative(key(workspace), f).split(path.sep).join('/'),
      agentContent: textOf(now),
      // What the file was put back to, so the card can show the change.
      restoredContent: textOf(was),
      restored: same(read(f), was),
      outsideTurn,
      // The mode an approved version is written with: the file's own.
      mode: isPlain(was) ? was.mode : undefined,
    };
    found.push(change);
    // One change, one card: it goes to the turn that started most recently,
    // never to every turn running in the workspace.
    const l = [...g.listeners].pop();
    if (l) { try { l(change); } catch (e) { /* reported by the caller's own logging */ } }
  }
  return found;
}

// Check at once, for a tool call that has just finished, rather than waiting
// for the next poll: what the call changed is put back and handed to the turn
// before the agent's next step. Only while a turn runs; a check between turns
// belongs to the next turn's start.
function checkAnswerFilesNow(workspace) {
  if (!workspace) return [];
  const g = guards.get(key(workspace));
  if (!g || !g.listeners.size) return [];
  return check(workspace);
}

// Accept a change a person approved as the new baseline.
function acceptAnswerFileChange(file) {
  const f = key(file);
  for (const g of guards.values()) if (g.snapshot.has(f)) g.snapshot.set(f, read(f));
}

// Start guarding `workspace` for one turn, of either runtime. Returns
// { check, release }. `onChange(change)` hears about each change that was put
// back while this is the most recently started turn, including one found as
// it starts that was made while no turn ran. `convoId` names the conversation
// the turn belongs to, for the changes a person allowed in it.
function acquireAnswerFileGuard(workspace, onChange, { intervalMs = CHECK_INTERVAL_MS, convoId = null } = {}) {
  if (!workspace) return { check: () => [], release: () => {} };
  const k = key(workspace);
  let g = guards.get(k);
  if (!g) {
    const files = [...ANSWER_FILES, ...hookScriptsIn(k)].map(f => path.join(k, ...f.split('/')));
    g = { files, snapshot: snapshotOf(files), hooksAt: hooksFolderAt(k), folders: new Map(), timer: null, listeners: new Set() };
    for (const f of files) noteFolders(k, g, f);
    guards.set(k, g);
  }
  // A fresh function per turn, so two turns handing in the same callback are
  // still two turns.
  const listener = (change) => { if (typeof onChange === 'function') onChange(change); };
  listener.convoId = typeof convoId === 'string' && convoId ? convoId : null;
  const idle = g.listeners.size === 0;
  g.listeners.add(listener);
  if (idle) {
    // Anything that changed while no turn ran is caught now, before this turn
    // can act on it.
    check(k, { outsideTurn: true });
    g.timer = setInterval(() => check(k), intervalMs);
    if (g.timer.unref) g.timer.unref();
  }
  let released = false;
  return {
    check: () => check(k),
    release() {
      if (released) return;
      released = true;
      check(k); // once more at the end of the turn
      g.listeners.delete(listener);
      // An allow nothing used ends with the last turn of its conversation.
      const c = listener.convoId;
      if (c && ![...g.listeners].some(l => l.convoId === c)) {
        for (const [p, m] of allowedChanges) if (m.convoId === c) allowedChanges.delete(p);
      }
      // The baseline stays; only the polling stops.
      if (!g.listeners.size && g.timer) { clearInterval(g.timer); g.timer = null; }
    },
  };
}

module.exports = { acquireAnswerFileGuard, acceptAnswerFileChange, allowAnswerFileChange, checkAnswerFilesNow, noteOwnWrite, writePlain, ANSWER_FILES, SHARED_FILES, HOOK_SCRIPTS_MAX, CHECK_INTERVAL_MS };
