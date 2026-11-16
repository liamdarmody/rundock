'use strict';
// THE OLDEST CLAUDE CODE RUNDOCK STARTS, worked out from the flags it passes.
//
// Rundock starts the first `claude` it finds. A copy older than a flag Rundock
// passes refuses the whole command line before it reads a message: Claude
// Code 2.0.0 to 2.0.58 declare `--agents <json>` and no `--agent`, so every
// chat on one ended in its parser's own words, `error: unknown option
// '--agent' (Did you mean --agents?)` (#401). spawnClaude in
// lib/runtime/claude.js reads the version first and, below the floor, starts
// nothing and says which copy it found and what to do about it.
const os = require('os');
const { claudeFolders, nativeInstallerFolder, pathFor } = require('./claude-folders.js');

// ONE ROW PER FLAG Rundock passes to Claude Code, with the first release that
// accepts it, from Claude Code's changelog. null means that release is not
// recorded: the row says so and sets nothing. The floor is the highest
// recorded row, so a flag whose first release is newer raises it without
// anyone remembering to. test/unit/claude-version-floor.test.js reads every
// flag the spawn paths pass and fails on one with no row here.
const FLAG_SINCE = Object.freeze({
  '--add-dir': null,
  // "Added --agent CLI flag" (2.0.59). 2.0.58 declares only `--agents <json>`.
  '--agent': '2.0.59',
  '--allowed-tools': null,
  '--append-system-prompt': null,
  '--dangerously-skip-permissions': null,
  '--disallowed-tools': null,
  '--include-partial-messages': null,
  '--input-format': null,
  '--mcp-config': null,
  '--model': null,
  '--output-format': null,
  '--permission-mode': null,
  '--print': null,
  '--resume': null,
  '--session-id': null,
  '--settings': null,
  '--verbose': null,
  '--version': null,
});

// THE VERSION LINE, and only that line. `claude --version` prints
// `2.1.318 (Claude Code)`; an older or a wrapped copy may print the version
// alone. Anything else it prints, a warning or a notice that an update is
// available, can carry a number of its own, and reading that one would refuse
// a current copy or start an old one. A suffix (`-beta.1`) is read past.
const VERSION = String.raw`(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`;
const NAMED_LINE = new RegExp(String.raw`^\s*${VERSION}\s+\(Claude Code\)\s*$`);
const BARE_LINE = new RegExp(String.raw`^\s*${VERSION}\s*$`);
const firstLine = (lines, pattern) => lines.map((line) => pattern.exec(line)).find(Boolean) || null;

/**
 * The version on the version line of what `claude --version` printed, as
 * major.minor.patch: the line naming Claude Code, else a line that is only a
 * version. null when there is no such line.
 * @param {unknown} text
 * @returns {string|null}
 */
function versionIn(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const m = firstLine(lines, NAMED_LINE) || firstLine(lines, BARE_LINE);
  return m ? `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}` : null;
}

/**
 * Numeric, part by part: 2.0.100 is newer than 2.0.59, and 2.10.0 than 2.9.0.
 * @param {string} a
 * @param {string} b
 * @returns {-1|0|1}
 */
function compareVersions(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/** The highest recorded row of a flag table; 0.0.0 when nothing is recorded. */
function floorOf(table) {
  return Object.values(table).filter((since) => since !== null)
    .reduce((highest, since) => (compareVersions(since, highest) > 0 ? since : highest), '0.0.0');
}

const FLOOR = floorOf(FLAG_SINCE);

/**
 * true at or above the floor, false below it, null when there is no version.
 * @param {string|null} version
 */
function meetsFloor(version) {
  return version ? compareVersions(version, FLOOR) >= 0 : null;
}

// A path as the notice shows it: one inside the home folder starts at `~`.
/** @param {string} dir @param {string} home @param {typeof import('path')} p */
function shown(dir, home, p) {
  const inside = p.relative(home, dir);
  return inside && inside.split(p.sep)[0] !== '..' && !p.isAbsolute(inside) ? `~${p.sep}${inside}` : dir;
}
/** @param {string[]} items */
const listed = (items) => (items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : items[0]);

// THE WHOLE NOTICE STAYS UNDER 400 CHARACTERS, however long the path of the
// copy found. A path that would take it past is cut in the middle, keeping
// its start and its file name, so the person can still tell which copy it is.
// A file name too long to keep whole keeps its last half of the room.
const MOST = 399;
const LEAST_ROOM = 24;
const LEAST_START = 8;
/** @param {string} text @param {number} room @param {string} sep */
function shortened(text, room, sep) {
  if (text.length <= room) return text;
  const at = text.lastIndexOf(sep);
  const end = at >= 0 && text.length - at <= room - 3 - LEAST_START ? text.slice(at) : text.slice(text.length - Math.floor((room - 3) / 2));
  return `${text.slice(0, room - 3 - end.length)}...${end}`;
}

// WHAT TO DO ABOUT IT. Removing the copy found is never offered on its own:
// the current copy may sit outside every folder Rundock searches (one under a
// Node version manager, say), and with the old one gone Rundock finds none.
// So the notice names the folders the app puts first on PATH, read from that
// one list and in its order, and offers the two ways that leave a copy
// Rundock finds: update that one, or install a current one with the native
// installer, whose folder is first in the list (where an old copy is already
// there, the installer replaces it). When the list cannot be read (no home
// folder), it still says to update the copy.
/** @param {{ platform: string, env: Record<string, string|undefined>, home?: string|null }} where */
function whatToDo({ platform, env, home }) {
  const p = pathFor(platform);
  try {
    const at = home === undefined ? os.homedir() : home;
    const folders = claudeFolders({ platform, env, home: at }).map((dir) => shown(dir, at, p));
    const native = shown(nativeInstallerFolder(at, platform), at, p);
    return {
      home: at,
      text: `The Rundock app looks for it in ${listed(folders)} first. `
        + `Update that copy, or install a current one with the native installer, which puts it in ${native}. `
        + 'Then send your message again.',
    };
  } catch (e) {
    return { home: null, text: 'Update that copy, then send your message again.' };
  }
}

/**
 * What spawnClaude hands the caller's error callback in place of a process.
 * Its message is the whole notice: a conversation shows it as it is, and a
 * routine's run record keeps it as the reason the run failed. So it is plain
 * text, with no markup. `where` stands in for the platform, environment and
 * home folder Rundock runs with; spawnClaude passes none.
 * @param {string} version
 * @param {string} bin
 * @param {{ platform?: string, env?: Record<string, string|undefined>, home?: string|null }} [where]
 */
function tooOldError(version, bin, { platform = process.platform, env = process.env, home } = {}) {
  const p = pathFor(platform);
  const next = whatToDo({ platform, env, home });
  /** @param {string} copy */
  const notice = (copy) => `Rundock found Claude Code ${version} at ${copy}. Rundock needs ${FLOOR} or later. ${next.text}`;
  const copy = next.home ? shown(bin, next.home, p) : bin;
  const room = Math.max(MOST - notice('').length, LEAST_ROOM);
  return Object.assign(new Error(notice(shortened(copy, room, p.sep))),
    { code: 'CLAUDE_TOO_OLD', version, path: bin, floor: FLOOR });
}

module.exports = { FLAG_SINCE, FLOOR, floorOf, versionIn, compareVersions, meetsFloor, tooOldError };
