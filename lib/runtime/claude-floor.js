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
//
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

/**
 * The version in what `claude --version` printed, as major.minor.patch, or
 * null when it carries none. What follows the three numbers, ` (Claude Code)`
 * or `-beta.1`, is read past.
 * @param {unknown} text
 * @returns {string|null}
 */
function versionIn(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(text == null ? '' : text));
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

/**
 * What spawnClaude hands the caller's error callback in place of a process.
 * Its message is the whole notice: a conversation shows it as it is, and a
 * routine's run record keeps it as the reason the run failed.
 * @param {string} version
 * @param {string} bin
 */
function tooOldError(version, bin) {
  return Object.assign(new Error(`Rundock found Claude Code ${version} at ${bin}. Rundock needs ${FLOOR} or later. `
    + 'Update that copy with `claude update`, or remove it, then send your message again.'),
  { code: 'CLAUDE_TOO_OLD', version, path: bin, floor: FLOOR });
}

module.exports = { FLAG_SINCE, FLOOR, floorOf, versionIn, compareVersions, meetsFloor, tooOldError };
