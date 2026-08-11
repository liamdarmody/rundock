'use strict';
// Phase 0 instruments: the coverage tool becomes an enforcement gate, and the
// packaged-contents gate learns to see nested requires.
//
// Why: the decomposition programme moves code out of server.js into lib/.
// Three instruments must hold through every move or the programme flies
// blind: (1) per-AREA coverage keeps its number when code moves file (area
// definitions carry their file, and an anchor that fails to resolve is a
// HARD failure, not a warning that scrolls past); (2) committed floors make
// coverage regression a CI failure, not a vibe (floors ratchet up, never
// down); (3) the afterPack require-scan sees `require('./lib/...')` paths,
// which its character class excluded until now: server.js already requires
// three lib/ modules that the packaged gate silently never checked.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  resolveAreas,
  parseLcov,
  areaCoverage,
  checkFloors,
  mergeFloors,
  FLOOR_TOLERANCE,
} = require('../tools/coverage-areas.js');
const { extractLocalRequires } = require('../../scripts/afterPack.js');

// ---------------------------------------------------------------------------
// Per-file area definitions with hard anchor failure
// ---------------------------------------------------------------------------

describe('per-file area resolution', () => {
  const SOURCES = {
    'server.js': [
      '// prologue',
      'function alpha() {',
      '}',
      'function beta() {',
      '}',
    ].join('\n'),
    'lib/things/alpha.js': [
      'function alpha() {',
      '  return 1;',
      '}',
      'module.exports = { alpha };',
    ].join('\n'),
  };
  const readFile = (file) => {
    if (!(file in SOURCES)) throw new Error(`no such file ${file}`);
    return SOURCES[file];
  };

  test('areas resolve against the file each definition names', () => {
    const defs = [
      ['server.js', 'alpha (still in the monolith)', /^function alpha\(/, /^function beta\(/],
      ['lib/things/alpha.js', 'alpha (moved)', /^function alpha\(/, /^module\.exports/],
    ];
    const areas = resolveAreas(defs, readFile);
    assert.deepStrictEqual(areas, [
      ['server.js', 'alpha (still in the monolith)', 2, 3],
      ['lib/things/alpha.js', 'alpha (moved)', 1, 3],
    ]);
  });

  test('an anchor that fails to resolve is a HARD failure naming the area', () => {
    const defs = [
      ['server.js', 'gone area', /^function vanished\(/, /^function beta\(/],
    ];
    assert.throws(() => resolveAreas(defs, readFile), /gone area/);
  });

  test('an end anchor before the start anchor is a hard failure too', () => {
    const defs = [
      ['server.js', 'inverted area', /^function beta\(/, /^function alpha\(/],
    ];
    assert.throws(() => resolveAreas(defs, readFile), /inverted area/);
  });
});

// ---------------------------------------------------------------------------
// Floors: enforce and ratchet
// ---------------------------------------------------------------------------

describe('coverage floors', () => {
  test('measured below floor (beyond tolerance) is a violation naming area, floor, and measured', () => {
    const floors = { 'Delegation engine': 90.0, 'OVERALL server.js': 80.0 };
    const measured = { 'Delegation engine': 84.2, 'OVERALL server.js': 80.1 };
    const violations = checkFloors(measured, floors);
    assert.strictEqual(violations.length, 1);
    assert.match(violations[0], /Delegation engine/);
    assert.match(violations[0], /90/);
    assert.match(violations[0], /84\.2/);
  });

  test('within tolerance passes: floors gate regressions, not timing noise', () => {
    const floors = { 'Area X': 90.0 };
    const measured = { 'Area X': 90.0 - FLOOR_TOLERANCE + 0.01 };
    assert.deepStrictEqual(checkFloors(measured, floors), []);
  });

  test('an area in the floors file but missing from the measurement is a violation (deleting the area does not silence its floor)', () => {
    const floors = { 'Area X': 90.0 };
    const violations = checkFloors({}, floors);
    assert.strictEqual(violations.length, 1);
    assert.match(violations[0], /Area X/);
  });

  test('ratchet: merging floors never lowers one', () => {
    const existing = { 'Area X': 92.0, 'Area Y': 70.0 };
    const fresh = { 'Area X': 89.5, 'Area Y': 75.3, 'Area Z': 100.0 };
    assert.deepStrictEqual(mergeFloors(existing, fresh), {
      'Area X': 92.0,   // never down
      'Area Y': 75.3,   // up is fine
      'Area Z': 100.0,  // new areas enter at their measurement
    });
  });
});

// ---------------------------------------------------------------------------
// The committed floors file is real and enforced against the real tool
// ---------------------------------------------------------------------------

describe('the committed floors file', () => {
  const FLOORS_PATH = path.join(__dirname, '..', 'tools', 'coverage-floors.json');

  test('exists, is stamped with a commit, and floors every defined area', () => {
    assert.ok(fs.existsSync(FLOORS_PATH), 'test/tools/coverage-floors.json is committed');
    const floors = JSON.parse(fs.readFileSync(FLOORS_PATH, 'utf8'));
    assert.match(floors.commit, /^[0-9a-f]{7,40}$/);
    assert.ok(!Number.isNaN(Date.parse(floors.generatedAt)));
    assert.ok(Object.keys(floors.floors).length >= 10, 'floors cover the area set');
    for (const [key, value] of Object.entries(floors.floors)) {
      assert.strictEqual(typeof value, 'number', `${key} floor is a number`);
      assert.ok(value >= 0 && value <= 100);
    }
  });
});

// ---------------------------------------------------------------------------
// afterPack: nested requires are seen
// ---------------------------------------------------------------------------

describe('packaged-contents gate require extraction', () => {
  test('sees root-level and nested local requires, ignores package requires', () => {
    const src = [
      "const { markers } = require('./lib/delegation/markers.js');",
      "const search = require('./search.js');",
      "const ws = require('ws');",
      "const path = require('path');",
      "const handback = require('./lib/delegation/handback.js');",
    ].join('\n');
    assert.deepStrictEqual(extractLocalRequires(src).sort(), [
      'lib/delegation/handback.js',
      'lib/delegation/markers.js',
      'search.js',
    ]);
  });

  test('the live blind spot, closed: server.js lib requires are in the gate set', () => {
    const serverSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
    const required = extractLocalRequires(serverSrc);
    assert.ok(required.includes('lib/delegation/markers.js'), `lib requires visible, got: ${required.join(', ')}`);
    assert.ok(required.includes('search.js'), 'root requires still visible');
  });
});
