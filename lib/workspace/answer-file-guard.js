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
// script does once it runs: a write made by a script, or by code given to
// `node -e` or `python3 -c` that builds its path as it runs, is not a path the
// hook can see. So the protection that holds however
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
//   job an agent started that outlived its turn) is found when the next turn
//   starts, and `outsideTurn` is set on it. Rundock's own permission answers
//   (`.rundock/permissions.json`, `.rundock/state.json`) have no other
//   writer, so such a change to them is put back and asked about: taking it
//   as the next turn's starting point would let a late write stand for good.
//   The launcher is put back too, without a card (see LAUNCHERS).
//
//   EXCEPT THE FILES OTHER TOOLS EDIT TOO (SHARED_FILES, and the hook
//   scripts). The Claude Code settings files, `.mcp.json`, the per-user
//   connector file and the hook scripts are also edited outside Rundock, by
//   the person, a terminal session, git or file sync, so a change to one
//   found as a turn starts is left alone and becomes the new baseline. That is
//   also how a late write by an agent's background job would stand, so for
//   the ones that decide what runs (SAID_WHEN_KEPT) the person is told in a
//   quiet notice naming the file; the settings files are taken with no
//   notice. During a turn they are all guarded like the rest.
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
// The server applies a standing allow itself with no window open, and never
// from the file as it stands: it runs the check first and reads the baseline
// (answerFileBaseline), which a planted allow never reaches.
const fs = require('fs');
const os = require('os');
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
const { WORKSPACE_ANSWER_FILES, LAUNCHER_FILES, shellStartupEntries, canonicalize } = require('../../scripts/permission-hook.js');
const ANSWER_FILES = [...WORKSPACE_ANSWER_FILES];
const HOOK_SCRIPTS_DIR = '.claude/hooks';
const HOOK_SCRIPTS_MAX = 64;
// THE LAUNCHER IS THIS RUNDOCK'S OWN. Two copies of Rundock open on one
// workspace (an installed app and one run from source, say) each write a
// launcher naming their own hook, and each took the other's as a change to
// put back and offer on a card, every time. A change to the launcher, whoever
// made it and whenever, is put back to the one this copy last wrote (or to
// the baseline, if it wrote none), with no card and no line to the agent:
// there is nothing a person could choose to keep.
const LAUNCHERS = new Set(LAUNCHER_FILES);
const ownLaunchers = new Map(); // absolute path -> { bytes, mode } this copy last wrote
const isLauncherPath = file => LAUNCHER_FILES.some(rel => key(file).endsWith(path.sep + rel.split('/').join(path.sep)));
// The files other tools edit too: left alone when changed between turns. A
// person edits `.mcp.json`, the per-user connector file and the hook scripts
// by hand, and git changes them; only Rundock writes the launcher.
const SHARED_FILES = new Set(['.claude/settings.local.json', '.claude/settings.json', '.mcp.json', '.rundock/mcp-secrets.json']);
const isShared = relative => SHARED_FILES.has(relative) || relative.startsWith(`${HOOK_SCRIPTS_DIR}/`);
// Of those, the ones whose change, taken as it stands between turns, is said
// in a quiet notice naming the file: they decide what runs, and taking a
// change as it stands is the one way a late write by an agent's background
// job can stand. The settings files are taken with no notice.
const SAID_WHEN_KEPT = relative => relative === '.mcp.json' || relative === '.rundock/mcp-secrets.json' || relative.startsWith(`${HOOK_SCRIPTS_DIR}/`);
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
  const rel = path.relative(root, path.dirname(file));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return out;
  for (const part of rel.split(path.sep).filter(Boolean)) {
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
    const bytes = content === null ? null : (Buffer.isBuffer(content) ? content : Buffer.from(String(content)));
    own.set(key(file), bytes === null ? ABSENT : digest(bytes));
    if (bytes !== null && isLauncherPath(file)) {
      let mode;
      try { mode = fs.statSync(file).mode & 0o7777; } catch (e) { /* not written yet */ }
      ownLaunchers.set(key(file), { bytes, mode });
    }
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
    let mode;
    try { link = fs.readlinkSync(file); } catch (e) { /* unreadable link */ }
    try { const t = fs.statSync(file); mode = t.mode & 0o7777; if (t.isFile()) bytes = fs.readFileSync(file); } catch (e) { /* dangling */ }
    return { link, bytes, real: realOrNull(file), mode };
  }
  return st.isDirectory() ? { other: true, dir: true } : { other: true };
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
  return a.link === b.link && a.real === b.real && a.mode === b.mode && sameBytes(a.bytes, b.bytes);
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
  // Only a real folder is removed as one. A file or a link is unlinked, never
  // followed, the same on every platform: on macOS fs.rmSync throws on a
  // link to a folder.
  if (st) { if (st.isDirectory()) fs.rmSync(file, { recursive: true, force: true }); else fs.unlinkSync(file); }
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
  if (was.dir && !(read(file) || {}).dir) { writePlain(file, null); fs.mkdirSync(file, { recursive: true }); }
  if (was.other || was.link === null) return undefined;
  const now = read(file);
  if (!(now && !isPlain(now) && !now.other && now.link === was.link)) {
    writePlain(file, null);
    fs.symlinkSync(was.link, file);
  }
  // What it led to, put back as the plain file it was, so nothing is written
  // through a link put in its place since.
  const at = read(file);
  if (was.bytes !== null && !(at.real === was.real && at.mode === was.mode && sameBytes(at.bytes, was.bytes))) writePlain(was.real, was.bytes, was.mode);
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
  if (mark.digest !== null && !(now && !now.other && now.bytes && digest(now.bytes) === mark.digest)) return false;
  allowedChanges.delete(at);
  return true;
}

// The launcher put back without a card (see LAUNCHERS). The baseline moves
// only once the write has landed, so a failed one is tried again.
function putLauncherBack(root, g, f, was, relative) {
  const mine = ownLaunchers.get(f);
  try {
    putBackFolders(root, g, f);
    if (mine) writePlain(f, mine.bytes, mine.mode); else restore(f, was);
    g.snapshot.set(f, read(f));
    console.warn(`[Answer files] put back ${relative} to the launcher this Rundock wrote`);
  } catch (e) { /* tried again at the next check */ }
}

// The workspace's files and the startup files are checked apart, so a failure
// in one never stops the other being checked.
function check(workspace, { outsideTurn = false } = {}) {
  const g = guards.get(key(workspace));
  if (!g) return [];
  let failed = null;
  const part = (fn) => { try { return fn(); } catch (e) { failed = failed || e; return []; } };
  part(() => watchNewHookScripts(key(workspace), g));
  const found = part(() => checkGuard(g, outsideTurn));
  const all = outsideTurn ? found : found.concat(part(checkShellStartupFiles));
  if (failed) throw failed;
  return all;
}
// EACH FILE IS CHECKED ON ITS OWN, so one whose check throws, on every pass
// if need be, never stops the files after it being checked. A file whose
// check threw is taken as changed (see putBackUnchecked). A check that threw
// still reaches its caller, once every file has been checked: every check a
// turn's guard makes for itself is made through safely(), and tried again at
// the next.
function checkGuard(g, outsideTurn) {
  const found = [];
  let failed = null;
  for (const f of [...g.files]) {
    let change;
    try {
      change = checkFile(g, f, outsideTurn);
      g.unchecked.delete(f);
    } catch (e) {
      failed = failed || e;
      change = putBackUnchecked(g, f, outsideTurn);
    }
    if (change) found.push(change);
  }
  if (failed) throw failed;
  return found;
}
// A FILE WHOSE CHECK THREW is put back from the baseline where that can be
// done, and carded either way. What stands there is told apart without
// reading it, by its inode, size, time and mode: unchanged since this file was
// last put back or carded, it is not carded again (only put back, if that
// failed before), so a check that keeps throwing raises one card, not one per
// pass. What the agent left there was not read, so Keep has nothing to keep.
function stampOf(f) {
  try { const s = fs.lstatSync(f); return `${s.ino}:${s.size}:${s.mtimeMs}:${s.mode}`; } catch (e) { return e.code === 'ENOENT' ? 'none' : 'unknown'; }
}
function putBackUnchecked(g, f, outsideTurn) {
  const was = g.snapshot.get(f);
  const relative = g.relativeOf(f);
  if (LAUNCHERS.has(relative)) { putLauncherBack(g.root, g, f, was, relative); return null; }
  const last = g.unchecked.get(f);
  const seen = !!last && last.stamp === stampOf(f);
  if (seen && last.restored) return null;
  let restored = false;
  try { putBackFolders(g.root, g, f); restore(f, was); restored = same(read(f), was); } catch (e) { /* carded below either way */ }
  g.unchecked.set(f, { stamp: stampOf(f), restored });
  if (seen) return null;
  let before = null;
  try { before = textOf(was); } catch (e) { /* too large to show */ }
  const change = { file: f, relative, agentContent: null, restoredContent: before, restored, outsideTurn, unread: true, mode: isPlain(was) ? was.mode : undefined };
  tellTurn(g, change);
  return change;
}
function checkFile(g, f, outsideTurn) {
  const now = read(f);
  const was = g.snapshot.get(f);
  if (same(now, was)) return null;
  // Rundock's own write. Rundock only ever writes plain files, and never
  // changes a file's mode, so nothing else is taken as one.
  const ownBytes = now === null ? own.get(f) === ABSENT : isPlain(now) && own.get(f) === digest(now.bytes);
  const modeKept = !(isPlain(now) && isPlain(was)) || now.mode === was.mode;
  if (ownBytes && modeKept) { g.snapshot.set(f, now); return null; }
  const relative = g.relativeOf(f);
  if (LAUNCHERS.has(relative)) { putLauncherBack(g.root, g, f, was, relative); return null; }
  // A change the person allowed on the hook's card, during this turn.
  if (!outsideTurn && modeKept && takeAllowed(g, f, now)) { g.snapshot.set(f, now); return null; }
  // Changed outside Rundock between turns: the new baseline, and for a file
  // that decides what runs, a quiet notice naming it (`kept` on the change
  // tells the caller it is a notice, not a card).
  if (outsideTurn && g.keptBetweenTurns(relative)) {
    g.snapshot.set(f, now);
    if (g.saidWhenKept(relative)) tellTurn(g, { file: f, relative, kept: true, outsideTurn: true });
    return null;
  }
  // Not Rundock's: put it back, then report it.
  try { putBackFolders(g.root, g, f); restore(f, was); } catch (e) { /* reported below either way */ }
  const change = {
    file: f,
    relative,
    agentContent: textOf(now),
    // What the file was put back to, so the card can show the change.
    restoredContent: textOf(was),
    restored: same(read(f), was),
    outsideTurn,
    // The mode an approved version is written with: the file's own.
    mode: isPlain(was) ? was.mode : undefined,
    // A file that stood there but could not be read (made unreadable, say):
    // there is no version of the agent's to keep.
    ...(now && now.other && !now.dir ? { unread: true } : {}),
  };
  // A startup file that is the person's link stays one: Keep writes through
  // it, and only while it leads where it did (keepAnswerFileChange).
  if (g.home && was && typeof was.link === 'string' && was.real) change.link = { real: was.real, mode: was.mode };
  tellTurn(g, change);
  return change;
}
function safely(fn) {
  try { return fn(); } catch (e) { console.warn(`[Answer files] check failed, tried again at the next: ${e && e.message}`); return []; }
}
// One change, one card or notice: it goes to the turn that started most
// recently, never to every turn running in the workspace.
function tellTurn(g, change) {
  const l = [...g.listeners].pop();
  if (l) { try { l(change); } catch (e) { /* reported by the caller's own logging */ } }
}

// THE SHELL STARTUP FILES, AND RUNDOCK'S RECORD OF WHICH OF THEM AN AGENT
// COULD HAVE CHANGED (the permission hook's registry, shellStartupEntries),
// are watched in every turn of either runtime and in every workspace, against
// one baseline for the whole process, so a change is put back and asked about
// once, by the turn that started most recently. They sit outside every
// workspace, where a write the hook cannot see (code given to `node -e` that
// builds its path as it runs, or Codex in a home folder it was given) reaches
// them. A change to a startup file found as a turn starts was made while no
// turn ran, usually by the person: kept as it stands, with a quiet notice
// naming it. The record has no writer but Rundock, so a change to it is put
// back whenever it is found. Fish's `conf.d/` is listed again at every check,
// as the hook scripts are, while it is where it was.
const homeGuards = new Map(); // home folder -> its guard
const turns = new Set(); // every turn running, in any workspace, in the order they started
// Built whole or not at all, and kept only once built, so a build that throws
// is tried again by the next check rather than leaving the files unwatched.
function homeGuard() {
  const home = key(os.homedir());
  if (homeGuards.has(home)) return homeGuards.get(home);
  const entries = shellStartupEntries(home).filter(e => mayWatch(e.path));
  const names = new Map(entries.map(e => [e.path, e.name]));
  const record = (entries.find(e => e.record) || {}).name;
  const g = { root: home, home: true, files: [], snapshot: new Map(), folders: new Map(), unchecked: new Map(), listeners: turns, names,
    dirs: entries.filter(e => e.dir).map(e => ({ at: e.path, name: e.name, real: canonicalize(e.path) })),
    relativeOf: f => names.get(f), keptBetweenTurns: rel => rel !== record, saidWhenKept: () => true };
  for (const e of entries) watchHomeFile(g, e.path, read(e.path));
  watchNewSnippets(g, true);
  homeGuards.set(home, g);
  return g;
}
// WHICH STARTUP FILES MAY BE WATCHED: every listed one, unless a caller has
// narrowed it. Rundock never does. A test run does, through its preload
// (test/helpers/account-home-refused.js), so no test ever watches, or puts
// back, a startup file of the account running it.
let mayWatch = () => true;
function refuseStartupFiles(refuses) {
  mayWatch = typeof refuses === 'function' ? p => !refuses(p) : () => true;
}
function watchHomeFile(g, f, was) {
  g.files.push(f);
  g.snapshot.set(f, was);
  noteFolders(g.root, g, f);
}
function watchNewSnippets(g, initial) {
  for (const d of g.dirs) {
    if (canonicalize(d.at) !== d.real) continue;
    let found = [];
    try { found = fs.readdirSync(d.at, { withFileTypes: true }).filter(e => !e.isDirectory()).map(e => e.name).sort(); } catch (e) { continue; }
    for (const n of found.slice(0, HOOK_SCRIPTS_MAX)) {
      const f = path.join(d.at, n);
      if (g.snapshot.has(f) || !mayWatch(f)) continue;
      g.names.set(f, `${d.name}/${n}`);
      watchHomeFile(g, f, initial ? read(f) : null);
    }
  }
}
// The guard's check over the shell startup files and the record: every check
// made while a turn runs makes it (at each interval, after each tool call,
// and as a turn ends). Between turns it does nothing, since a change then
// belongs to the next turn's start. The guard is built here if the build as
// the turn started threw.
function checkShellStartupFiles() {
  if (!turns.size) return [];
  const g = homeGuard();
  watchNewSnippets(g, false);
  return checkGuard(g, false);
}
// As the first turn starts after none ran: the folders on the way are taken
// as they stand now, so a link the person made in between is theirs.
function checkShellStartupFilesAtStart() {
  const g = homeGuard();
  g.folders = new Map();
  for (const f of g.files) noteFolders(g.root, g, f);
  watchNewSnippets(g, false);
  checkGuard(g, true);
}

// Check at once, for a tool call that has just finished, rather than waiting
// for the next poll: what the call changed is put back and handed to the turn
// before the agent's next step. Only while a turn runs; a check between turns
// belongs to the next turn's start.
//
// `finishedFor` names the conversation whose tool call finished. A shell
// command's allow names no content, so its mark covers that command alone:
// it is dropped here, once the check that follows the command has had its
// chance to use it, and a later write in the same turn is put back.
function checkAnswerFilesNow(workspace, { finishedFor = null } = {}) {
  if (!workspace) return [];
  const g = guards.get(key(workspace));
  if (!g || !g.listeners.size) return [];
  const found = safely(() => check(workspace));
  if (finishedFor) {
    for (const [p, m] of allowedChanges) if (m.convoId === finishedFor && m.digest === null) allowedChanges.delete(p);
  }
  return found;
}

// WHETHER A TURN'S GUARD WATCHES `workspace` NOW. checkAnswerFilesNow checks
// only then, so a reader that must apply nothing an agent put in an answer
// file (the server's saved answers, lib/http-router.js) asks this first, and
// with no turn running it applies nothing.
function answerFilesWatched(workspace) {
  if (!workspace) return false;
  const g = guards.get(key(workspace));
  return !!(g && g.listeners.size);
}

// WHAT AN ANSWER FILE HOLDS AS RUNDOCK LAST LEFT IT: the baseline, never the
// file as it stands. Only Rundock's own writes and a person's choices move
// the baseline, and checkAnswerFilesNow takes a write of Rundock's own into it
// and puts any other change back, so read right after that check this is
// content Rundock wrote. The file as it stands is not: a script rewriting it
// in a loop can land a write between the check and a read of the disk, and it
// never moves the baseline. Null when no guard holds the file, or holds no
// bytes for it.
function answerFileBaseline(workspace, file) {
  if (!workspace || !file) return null;
  const g = guards.get(key(workspace));
  const was = g ? g.snapshot.get(key(file)) : null;
  return was && Buffer.isBuffer(was.bytes) ? was.bytes : null;
}

// Accept a change a person approved as the new baseline.
function acceptAnswerFileChange(file) {
  const f = key(file);
  for (const g of [...guards.values(), ...homeGuards.values()]) if (g.snapshot.has(f)) g.snapshot.set(f, read(f));
}
// Keep the version a person chose on the put-back card, as the new baseline:
// a plain file, never written through whatever link stands at the path by
// now, except a startup file that is the person's link, written through only
// while it leads where the baseline had it.
function keepAnswerFileChange(change) {
  if (change.unread) throw new Error('what the agent left there could not be read, so there is nothing to keep');
  const at = change.link ? change.link.real : change.file;
  if (change.link && realOrNull(change.file) !== at) throw new Error('the link no longer leads where it did');
  writePlain(at, change.agentContent, change.link ? change.link.mode : change.mode);
  noteOwnWrite(at, change.agentContent);
  acceptAnswerFileChange(change.file);
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
    g = { root: k, files, snapshot: snapshotOf(files), hooksAt: hooksFolderAt(k), folders: new Map(), unchecked: new Map(), timer: null, listeners: new Set(),
      relativeOf: f => path.relative(k, f).split(path.sep).join('/'), keptBetweenTurns: isShared, saidWhenKept: SAID_WHEN_KEPT };
    for (const f of files) noteFolders(k, g, f);
    // The launcher this copy wrote is the baseline, whatever stands there now,
    // so one another copy wrote since is put back at the first check.
    for (const f of files) {
      const mine = ownLaunchers.get(f);
      if (mine) g.snapshot.set(f, { file: true, bytes: mine.bytes, mode: mine.mode });
    }
    guards.set(k, g);
  }
  // A fresh function per turn, so two turns handing in the same callback are
  // still two turns.
  const listener = (change) => { if (typeof onChange === 'function') onChange(change); };
  listener.convoId = typeof convoId === 'string' && convoId ? convoId : null;
  const idle = g.listeners.size === 0;
  const noneRan = turns.size === 0;
  g.listeners.add(listener);
  turns.add(listener);
  // Anything that changed while no turn ran is caught now, before this turn
  // can act on it.
  if (noneRan) safely(checkShellStartupFilesAtStart);
  if (idle) {
    safely(() => check(k, { outsideTurn: true }));
    // A check that throws is tried again at the next interval; the polling
    // and the turn go on.
    g.timer = setInterval(() => safely(() => check(k)), intervalMs);
    if (g.timer.unref) g.timer.unref();
  }
  let released = false;
  return {
    check: () => check(k),
    release() {
      if (released) return;
      released = true;
      safely(() => check(k)); // once more at the end of the turn
      g.listeners.delete(listener);
      turns.delete(listener);
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

module.exports = { acquireAnswerFileGuard, acceptAnswerFileChange, allowAnswerFileChange, answerFileBaseline, answerFilesWatched, checkAnswerFilesNow, checkShellStartupFiles, keepAnswerFileChange, noteOwnWrite, refuseStartupFiles, writePlain, ANSWER_FILES, SHARED_FILES, HOOK_SCRIPTS_MAX, CHECK_INTERVAL_MS };
