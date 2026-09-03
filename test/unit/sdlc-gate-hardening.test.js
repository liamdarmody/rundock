'use strict';
// The repository's own instruments, held to the standard they hold the code
// to: a gate that cannot fail honestly is not a gate.
//
// Five claims live here. Documented steps do not destroy uncommitted work,
// and a new destructive step fails this suite before it finds a victim. Every
// source-walking enumeration in the test tree is registered with the property
// that makes it fail loudly when its extraction goes blind, and a new
// extraction cannot ship unregistered. A mutation harness whose suite output
// cannot be parsed refuses with a named row instead of crashing. The
// internal-reference scanner knows the acceptance-label shape and its amnesty
// list can only shrink. And a fresh checkout works without the one dependency
// fetched from outside the npm registry.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

// ---------------------------------------------------------------------------
// Documented steps and uncommitted work
// ---------------------------------------------------------------------------

// Commands that throw away working-tree state. A document that names one is
// telling its reader to run it, whatever the surrounding tense, because a
// reproduce narrative is read as a recipe.
const DESTRUCTIVE = /git checkout (?:HEAD )?--|git checkout HEAD\b|git reset --hard|git clean -f/;

// Every documented destructive command the repository is allowed to carry,
// and what must stand beside it. `mustContainNearby` is required within a few
// lines of the hit, so deleting a caution un-allowlists its command: the
// allowlist entry is the caution's presence, not the file's name alone.
const ALLOWED_DESTRUCTIVE = [
  {
    file: 'docs/evidence/setup-race-flakes-evidence.md',
    mustContainNearby: /erases any uncommitted\s+work|it is erased, not restored/,
    reason: 'historical narrative of a measured break, with the hazard named beside the command',
    expected: 2,
  },
];

function markdownDocs() {
  const out = ['CONTRIBUTING.md', 'README.md'].filter(f => fs.existsSync(path.join(ROOT, f)));
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.md')) out.push(rel);
    }
  };
  walk('docs');
  return out;
}

describe('documented steps and uncommitted work', () => {
  test('every destructive command in the docs stands beside its caution, and nowhere else', () => {
    // The pattern proves it still bites before an empty result is believed.
    assert.ok(DESTRUCTIVE.test('Reverted with `git checkout -- scripts/red-first.js`'),
      'the destructive-command pattern no longer matches its own specimen');

    const offenders = [];
    const allowedHits = new Map(ALLOWED_DESTRUCTIVE.map(a => [a.file, 0]));
    for (const file of markdownDocs()) {
      const lines = read(file).split('\n');
      lines.forEach((line, i) => {
        if (!DESTRUCTIVE.test(line)) return;
        const entry = ALLOWED_DESTRUCTIVE.find(a => a.file === file);
        if (!entry) {
          offenders.push(`${file}:${i + 1} documents a destructive command with no allowlist entry: ${line.trim().slice(0, 100)}`);
          return;
        }
        // The caution must live within a few lines of the command it excuses.
        const nearby = lines.slice(Math.max(0, i - 3), i + 7).join('\n');
        if (!entry.mustContainNearby.test(nearby)) {
          offenders.push(`${file}:${i + 1} carries an allowlisted destructive command whose caution is gone`);
          return;
        }
        allowedHits.set(file, allowedHits.get(file) + 1);
      });
    }
    assert.deepStrictEqual(offenders, [],
      'a documented step that destroys uncommitted work needs its caution beside it, or needs rewriting: refuse on a dirty tree, or copy the file aside and restore from the copy');
    for (const entry of ALLOWED_DESTRUCTIVE) {
      assert.strictEqual(allowedHits.get(entry.file), entry.expected,
        `${entry.file}: expected ${entry.expected} allowlisted destructive commands, found ${allowedHits.get(entry.file)}; update the entry with the change that moved them`);
    }
  });

  test('the mutation envelope states what a clean tree cannot prove', () => {
    // The check a reader will trust is the check that has the blind spot, so
    // the limitation is stated where the check lives.
    assert.match(read('test', 'tools', 'mutation-run.js'), /cannot tell\s+(?:\/\/\s*)?untouched from erased/,
      'the residue limitation statement has left the mutation envelope header');
  });
});

// ---------------------------------------------------------------------------
// Source-walking enumerations
// ---------------------------------------------------------------------------

// Every file in the test tree that derives values by walking source text with
// a pattern, each with the property that makes a blind extraction loud:
//
//   'count'    the extraction's completeness is asserted: a set equality in
//              both directions, a floor or exact count, a specimen the
//              pattern must still match, or an extraction that refuses when
//              its target is missing (the appPiece idiom).
//   'imports'  the values come from require/import and the pattern is
//              secondary.
//   'mutation' a harness row removes a member and a named test reddens.
//
// A file that walks source and appears in none of these rows fails the test
// below. That is the point: an enumeration nobody has broken on purpose is an
// unexecuted experiment, and this registry is where the experiment's name is
// recorded.
const ENUMERATIONS = [
  { file: 'test/unit/client-styles.test.js', extraction: 'stylesheet links out of index.html', failLoudBy: 'count', where: 'sheets.length floor beside the extraction' },
  { file: 'test/unit/config.test.js', extraction: 'workspace-root assignments out of server.js', failLoudBy: 'count', where: 'exact deepStrictEqual against the two permitted assignments' },
  { file: 'test/unit/design-doc.test.js', extraction: 'declared tokens and documented tokens', failLoudBy: 'count', where: 'set difference asserted empty in both directions' },
  { file: 'test/unit/doc-claims.test.js', extraction: 'changelog headings, hook directory list, doc-named files and statuses', failLoudBy: 'count', where: 'each match asserted found, list sizes floored, status sets equal' },
  { file: 'test/unit/doc-links.test.js', extraction: 'relative markdown links across the docs', failLoudBy: 'count', where: 'checked-links floor beside the scan' },
  { file: 'test/unit/navigation-doors.test.js', extraction: 'inline handlers and call sites out of index.html and the client', failLoudBy: 'count', where: 'manifest equality over the collected sites' },
  { file: 'test/unit/package-import-apply.test.js', extraction: 'frontmatter field counts out of written agent files', failLoudBy: 'count', where: 'exact strictEqual on each match count' },
  { file: 'test/unit/packaging.test.js', extraction: 'local requires and asset tags out of server.js, electron/main.js and index.html', failLoudBy: 'count', where: 'canary membership plus a non-empty floor per list' },
  { file: 'test/unit/profile-boxes.test.js', extraction: 'app.js arms cut out for pressing', failLoudBy: 'count', where: 'appPiece refuses when a piece is missing' },
  { file: 'test/unit/regression.test.js', extraction: 'pinned call-shape occurrences in client source', failLoudBy: 'count', where: 'every match wrapped in an exact or floored count assertion' },
  { file: 'test/unit/routine-editor-doors.test.js', extraction: 'editor entry calls and rendered handler names', failLoudBy: 'count', where: 'found-vs-DOORS equality and a handlers.size floor' },
  { file: 'test/unit/routine-schedule-edit.test.js', extraction: 'routines-section counts out of written files', failLoudBy: 'count', where: 'exact strictEqual on each match count' },
  { file: 'test/unit/routine-timezone.test.js', extraction: 'frontmatter block out of a written file', failLoudBy: 'count', where: 'indexing the match throws when the pattern misses' },
  { file: 'test/unit/routine-write.test.js', extraction: 'routines-section counts and frontmatter out of written files', failLoudBy: 'count', where: 'exact counts asserted; missing frontmatter throws' },
  { file: 'test/unit/routines-end-to-end.test.js', extraction: 'app.js pieces cut out for pressing', failLoudBy: 'count', where: 'appPiece refuses when a piece is missing' },
  { file: 'test/unit/routines-truth.test.js', extraction: 'status literals out of the scheduler writers and refusal returns', failLoudBy: 'count', where: 'set equality against the declared vocabulary; every return accounted for' },
  { file: 'test/unit/routines-view-doors.test.js', extraction: 'navigation calls across the client and the palette', failLoudBy: 'count', where: 'specimen self-test beside the prohibition scan; palette set equality' },
  { file: 'test/unit/routines-view.test.js', extraction: 'app.js arms cut out for pressing', failLoudBy: 'count', where: 'appPiece refuses when a piece is missing' },
  { file: 'test/unit/run-detail-doors.test.js', extraction: 'run-detail entry calls across the client', failLoudBy: 'count', where: 'found-vs-manifest equality' },
  { file: 'test/unit/run-detail-model.test.js', extraction: 'unknown-reason words out of the transcript reader and scheduler', failLoudBy: 'count', where: 'floor asserted against the scan, per its own comment' },
  { file: 'test/unit/scaffold-integrity.test.js', extraction: 'skill references out of scaffold markdown', failLoudBy: 'count', where: 'specimen self-test beside the prohibition scan' },
  { file: 'test/unit/session-transcript-capture.test.js', extraction: 'the content-block union out of types.d.ts', failLoudBy: 'count', where: 'size floor and set equality against the known block types' },
  { file: 'test/unit/style-resolve-diff.test.js', extraction: 'var() fallbacks out of stylesheets', failLoudBy: 'count', where: 'a dedicated that-check-can-actually-fail specimen pair' },
  { file: 'test/unit/team-sidebar.test.js', extraction: 'the roster dispatch case cut out of app.js', failLoudBy: 'count', where: 'appPiece refuses when the case is missing' },
  { file: 'test/unit/token-references.test.js', extraction: 'declared and referenced custom properties across public/', failLoudBy: 'count', where: 'used.size floor and a named-token canary' },
  { file: 'test/unit/workspace-modes.test.js', extraction: 'gitignore entry count', failLoudBy: 'count', where: 'exact strictEqual on the match count' },
  { file: 'test/tools/coverage-areas.js', extraction: 'SF and DA records out of the lcov', failLoudBy: 'count', where: 'a floored area that was not measured raises a violation' },
  { file: 'test/tools/style-drift.js', extraction: 'colour, function and radius literals out of stylesheets', failLoudBy: 'count', where: 'stale allowlist entries error when a listed literal is no longer found' },
  { file: 'test/tools/style-resolve-diff.js', extraction: 'declarations and rule blocks out of stylesheets', failLoudBy: 'count', where: 'its companion test file proves the patterns on specimens' },
  { file: 'test/unit/sdlc-gate-hardening.test.js', extraction: 'destructive commands in docs, redTests bodies out of the harnesses, scanner rules out of check-internal-refs', failLoudBy: 'count', where: 'specimen self-tests and exact extraction counts throughout this file' },
];

// What makes a file a source-walking extraction. Deliberately the same
// heuristic a person would use scanning for the shape: it reads a file and
// runs a pattern over the text. Over-collection is handled by registering the
// file with what its extraction actually is, never by narrowing the detector.
function detectorHits() {
  const hits = [];
  const dirs = ['test/unit', 'test/tools', 'test/e2e'];
  for (const dir of dirs) {
    if (!fs.existsSync(path.join(ROOT, dir))) continue;
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      if (!name.endsWith('.js')) continue;
      const rel = `${dir}/${name}`;
      const src = read(rel);
      if (src.includes('readFileSync(') && (/\.matchAll\(|\.match\(\/|appPiece\(/.test(src))) {
        hits.push(rel);
      }
    }
  }
  return hits.sort();
}

describe('source-walking enumerations', () => {
  test('every extraction in the test tree is registered with a fail-loud property', () => {
    const hits = detectorHits();
    assert.ok(hits.length >= 20, `only ${hits.length} extraction files detected; the detector itself has gone blind`);
    const registered = new Set(ENUMERATIONS.map(e => e.file));
    const unregistered = hits.filter(h => !registered.has(h));
    assert.deepStrictEqual(unregistered, [],
      'a file walks source with a pattern and is not in the ENUMERATIONS registry. An extraction '
      + 'can stop matching and return a short list that agrees with itself, so register it here '
      + 'with the property that makes that loud: a count or specimen, imported values, or a '
      + 'mutation row that removes a member');
  });

  test('every registered enumeration still walks source', () => {
    const hits = new Set(detectorHits());
    const gone = ENUMERATIONS.filter(e => !hits.has(e.file)).map(e => e.file);
    assert.deepStrictEqual(gone, [],
      'a registered file no longer walks source (or no longer exists); remove its row so the registry stays true');
  });

  test('every registered enumeration names a real property in a real place', () => {
    for (const e of ENUMERATIONS) {
      assert.ok(['count', 'imports', 'mutation'].includes(e.failLoudBy),
        `${e.file}: failLoudBy must be count, imports or mutation`);
      assert.ok(e.extraction && e.where,
        `${e.file}: the registry row must say what is extracted and where its guard lives`);
    }
  });
});

// ---------------------------------------------------------------------------
// Mutation harness output parsing
// ---------------------------------------------------------------------------

const HARNESSES = fs.readdirSync(path.join(ROOT, 'test', 'tools'))
  .filter(f => /^mutate-.*-guards\.js$/.test(f))
  .map(f => `test/tools/${f}`)
  .sort();

// The redTests copy in each harness, cut out and built with its dependencies
// stubbed, so the parser can be fed output it cannot read without running a
// suite. The copies are deliberate (a shared module would put an instrument
// already in the gate inside every feature diff), which is exactly why this
// drives all of them: uniformity is a claim, and a claim needs a test.
function buildRedTests(file) {
  const src = read(file);
  const m = src.match(/function redTests\((?:suite)?\) \{[\s\S]*?\n\}/);
  assert.ok(m, `${file}: redTests could not be cut out; if it moved or was renamed, update this extraction`);
  const body = m[0];
  return (fakeExec) => {
    const factory = new Function('execFileSync', 'REPORTER', 'ROOT', 'SUITE', `${body}; return redTests;`);
    return factory(fakeExec, [], ROOT, 'stub-suite');
  };
}

describe('a mutation result that cannot be parsed is a refusal, not a crash', () => {
  const failWith = (stdout) => () => {
    const err = new Error('suite failed');
    err.stdout = stdout;
    err.stderr = '';
    throw err;
  };
  const WELL_FORMED = 'something\nfailing tests:\n\n✖ the guard was noticed (12.5ms)\n';
  const GARBAGE = 'Bootstrapping… progress 42%\ninterleaved output with no summary at all\n';

  for (const file of HARNESSES) {
    test(`${path.basename(file)} refuses unreadable output and reads readable output`, () => {
      const build = buildRedTests(file);

      const unparsable = build(failWith(GARBAGE))();
      assert.deepStrictEqual(unparsable, { unparsable: true },
        `${file}: a failed suite with no readable summary must come back as a named refusal, never a throw`);

      const red = build(failWith(WELL_FORMED))();
      assert.deepStrictEqual(red, ['the guard was noticed'],
        `${file}: a well-formed summary must still yield the red test names`);

      const green = build(() => 'all fine\n')();
      assert.deepStrictEqual(green, [], `${file}: a passing suite reads as no red tests`);
    });
  }

  test('the harness count matches the mutate:guards chain', () => {
    const chain = JSON.parse(read('package.json')).scripts['mutate:guards'];
    for (const file of HARNESSES) {
      assert.ok(chain.includes(path.basename(file)),
        `${file} exists but is not wired into the mutate:guards chain`);
    }
  });
});

// ---------------------------------------------------------------------------
// The internal-reference scanner
// ---------------------------------------------------------------------------

// The scanner has no exports and exits at top level, so its rule table and
// line scanner are cut from source and built directly. The extraction asserts
// what it found, per the registry above.
function buildScanner() {
  const src = read('scripts', 'check-internal-refs.js');
  const amnesty = src.match(/const AC_LABEL_AMNESTY = new Set\(\[[\s\S]*?\]\);/);
  const rules = src.match(/const RULES = \[[\s\S]*?\n\];/);
  const scan = src.match(/function scanLines\(label, text[\s\S]*?\n\}/);
  assert.ok(amnesty, 'the amnesty set could not be cut out of check-internal-refs.js');
  assert.ok(rules, 'the RULES table could not be cut out of check-internal-refs.js');
  assert.ok(scan, 'scanLines could not be cut out of check-internal-refs.js');
  const factory = new Function(`${amnesty[0]}\n${rules[0]}\n${scan[0]}\nreturn { scanLines, RULES, AC_LABEL_AMNESTY };`);
  return factory();
}

describe('the internal-reference scanner and the acceptance-label shape', () => {
  test('an acceptance label in a new file is a finding; in an amnestied file it is not; a lookalike never is', () => {
    const { scanLines, AC_LABEL_AMNESTY } = buildScanner();
    // The specimen is assembled at runtime so this file's own source never
    // carries the shape the rule forbids in new files, this one included.
    const line = '// covers the third acceptance criterion, ' + 'AC' + '-3, end to end';

    const fresh = scanLines('test/unit/some-new-file.test.js', line)
      .filter(f => f.label.includes('acceptance-criteria'));
    assert.strictEqual(fresh.length, 1, 'the label shape in a file off the amnesty must be a finding');

    const amnestied = [...AC_LABEL_AMNESTY][0];
    const excused = scanLines(amnestied, line).filter(f => f.label.includes('acceptance-criteria'));
    assert.deepStrictEqual(excused, [], `a hit in ${amnestied} is amnestied until that file burns its labels down`);

    const lookalike = scanLines('test/unit/some-new-file.test.js', '// the MAC-1 frame offset')
      .filter(f => f.label.includes('acceptance-criteria'));
    assert.deepStrictEqual(lookalike, [], 'a label shape embedded in a longer word must not trip the rule');
  });

  test('the amnesty list only shrinks', () => {
    const { AC_LABEL_AMNESTY } = buildScanner();
    // The size on the day the ratchet was added. Burning a file down lowers
    // this number; record the new, smaller size in the same change. Raising
    // it means a new file shipped the shape, which the rule exists to stop.
    const SIZE_WHEN_RATCHETED = 38;
    assert.ok(AC_LABEL_AMNESTY.size <= SIZE_WHEN_RATCHETED,
      `the amnesty list grew to ${AC_LABEL_AMNESTY.size}; it may only burn down. Reword the new file instead`);
  });
});

// ---------------------------------------------------------------------------
// The optional encoder
// ---------------------------------------------------------------------------

describe('a fresh install works without the media encoder', () => {
  test('ffmpeg-static is optional, and its consumer guards the require', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.ok(!(pkg.dependencies || {})['ffmpeg-static'],
      'ffmpeg-static must not be a hard dependency: it downloads from outside the npm registry at install time, and nothing the tests need uses it');
    assert.strictEqual((pkg.optionalDependencies || {})['ffmpeg-static'], '^5.2.0',
      'the capture pipeline still wants the encoder where the optional install succeeds');
    assert.match(read('scripts', 'screenshots', 'motion.mjs'),
      /try \{ candidates\.push\(require\('ffmpeg-static'\)\); \} catch/,
      'motion.mjs must keep guarding the require, so an install without the optional package still runs');
  });
});
