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

// The scanned set is DERIVED, never listed: every markdown file git tracks,
// wherever it lives, so a destructive step added to a root document, a
// scaffold instruction that ships into user workspaces, or a directory that
// does not exist yet is scanned the day it appears. No exclusions today; an
// exclusion added later must be named here with its reason. A file git names
// that cannot be read is a failure, not a skip: a scan that quietly drops
// documents is the blindness this suite exists to remove.
function trackedMarkdown() {
  const { execFileSync } = require('node:child_process');
  return execFileSync('git', ['ls-files', '*.md'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean);
}

describe('documented steps and uncommitted work', () => {
  test('every destructive command in the tracked docs stands beside its caution, and nowhere else', () => {
    // The pattern proves it still bites, in both directions, before an empty
    // result is believed.
    assert.ok(DESTRUCTIVE.test('Reverted with `git checkout -- scripts/red-first.js`'),
      'the destructive-command pattern no longer matches its own specimen');
    assert.ok(!DESTRUCTIVE.test('run `git checkout -b my-branch` and `git status` first'),
      'the destructive-command pattern matches ordinary branch and status commands');

    const docs = trackedMarkdown();
    // Dozens are tracked today (62 at the time of writing); a walk that finds
    // far fewer has stopped finding documents, which must never read as an
    // empty offender list.
    assert.ok(docs.length >= 30, `only ${docs.length} tracked markdown files found; the document walk has gone blind`);

    const offenders = [];
    const allowedHits = new Map(ALLOWED_DESTRUCTIVE.map(a => [a.file, 0]));
    for (const file of docs) {
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
  { file: 'test/unit/sdlc-gate-hardening.test.js', extraction: 'destructive commands in tracked markdown, redTests and report bodies out of the harnesses, scanner rules out of check-internal-refs', failLoudBy: 'count', where: 'specimen self-tests, document and per-directory floors, and exact extraction counts throughout this file' },
  { file: 'test/helpers/scheduler-statuses.js', extraction: 'status literals out of the scheduler writers', failLoudBy: 'count', where: 'its consumers assert the vocabulary in both directions (profile-boxes) and drive every word' },
  { file: 'test/integration/http-api.test.js', extraction: 'script and stylesheet links out of served index.html', failLoudBy: 'count', where: 'floors on both lists plus a token-sheet canary' },
  { file: 'test/integration/ws-handler-edges.test.js', extraction: 'frontmatter and order lines out of written agent files', failLoudBy: 'count', where: 'exact match counts; missing frontmatter refuses' },
  { file: 'test/tools/innerhtml-sites.js', extraction: 'innerHTML assignment sites across the client', failLoudBy: 'count', where: 'pinned per-file totals in innerhtml-inventory.test.js' },
  { file: 'test/unit/app-retentions.test.js', extraction: 'DOM-writing functions out of app.js', failLoudBy: 'count', where: 'owners.size floor plus the stale-manifest check in both directions' },
  { file: 'test/unit/client-namespace.test.js', extraction: 'top-level declarations and uses across client sources', failLoudBy: 'count', where: 'declaration-count floor beside the extraction' },
  { file: 'test/unit/guide-name.test.js', extraction: 'pronoun scan over rendered surfaces', failLoudBy: 'count', where: 'specimen pair beside the pattern, added with this registry row' },
  { file: 'test/unit/markdown-render.test.js', extraction: 'renderer call sites and script tags out of client sources', failLoudBy: 'count', where: 'call-site and script-count floors beside each scan' },
  { file: 'test/unit/routine-editor-view.test.js', extraction: 'navigation arms cut out of app.js', failLoudBy: 'count', where: 'the cut refuses when the arm is missing' },
  { file: 'test/unit/routines-panel.test.js', extraction: 'markup regions cut out of index.html and app.js', failLoudBy: 'count', where: 'every cut refuses when its region is missing' },
  { file: 'test/unit/run-detail-view.test.js', extraction: 'the run-detail panel cut out of index.html', failLoudBy: 'count', where: 'the cut refuses when the panel is missing' },
  { file: 'test/unit/scheduler-lifecycle-doors.test.js', extraction: 'lifecycle call sites and their enclosing functions out of the server sources', failLoudBy: 'count', where: 'manifest equality plus a self-arming floor' },
  { file: 'test/unit/skills-empty.test.js', extraction: 'markup regions cut out of index.html', failLoudBy: 'count', where: 'every cut refuses when its region is missing' },
  { file: 'test/unit/style-drift.test.js', extraction: 'value literals out of allowlist reasons', failLoudBy: 'count', where: 'specimen beside the pattern, added with this registry row' },
];

// What makes a file a source-walking extraction. Deliberately the same
// heuristic a person would use scanning for the shape: it reads a file and
// runs a pattern over the text. Over-collection is handled by registering the
// file with what its extraction actually is, never by narrowing the detector.
//
// WHAT THIS CANNOT SEE, stated beside the check the way the residue scan's
// blind spot is: an extraction that splits on a delimiter instead of matching,
// one that walks with indexOf, or a pattern assembled at runtime from pieces.
// A new extraction idiom belongs in the predicate with a specimen below, not
// in a registry row on trust.
const EXTRACTION_IDIOMS = /\.matchAll\(|\.match\(\/|\.match\([A-Z_]|\.exec\(|appPiece\(/;
function looksLikeExtraction(src) {
  return src.includes('readFileSync(') && EXTRACTION_IDIOMS.test(src);
}

// The WHOLE test tree, recursively, so an extraction lands in the walk
// wherever it lands in the tree. node_modules is the one exclusion, with the
// obvious reason: dependencies are not this repository's instruments.
function detectorHits() {
  const hits = [];
  const walked = new Set();
  const walk = (dir) => {
    walked.add(dir);
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(rel);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      if (looksLikeExtraction(read(rel))) hits.push(rel);
    }
  };
  walk('test');
  return { hits: hits.sort(), walked };
}

describe('source-walking enumerations', () => {
  test('the detection predicate fires on every recognised idiom and not on a plain read', () => {
    // The predicate is what decides the registration gate's whole reach, so
    // each idiom it claims to recognise is proven on a specimen, and a file
    // that merely reads bytes is proven invisible. A predicate that silently
    // stops recognising an idiom fails here, by name, before an empty
    // unregistered list is believed.
    const reads = "const src = fs.readFileSync('a.js', 'utf8');\n";
    const specimens = {
      'matchAll': reads + 'for (const m of src.matchAll(/x/g)) {}',
      'match with a literal': reads + 'const m = src.match(/^function (\\w+)/);',
      'match with a named pattern': reads + 'const m = src.match(CALL_SHAPE);',
      'exec': reads + 'const m = RE.exec(src);',
      'appPiece': reads + "const body = appPiece(/case 'x':/, 'the x case');",
    };
    for (const [idiom, snippet] of Object.entries(specimens)) {
      assert.ok(looksLikeExtraction(snippet), `the predicate no longer recognises the ${idiom} idiom`);
    }
    assert.ok(!looksLikeExtraction(reads + 'const n = src.length;'),
      'the predicate fires on a file that reads bytes and extracts nothing');
  });

  test('every extraction in the test tree is registered with a fail-loud property', () => {
    const { hits, walked } = detectorHits();
    // The walk's reach is asserted directly, so losing a directory from the
    // recursion is loud rather than absorbed by the total.
    for (const dir of ['test/unit', 'test/tools', 'test/e2e', 'test/integration', 'test/helpers']) {
      assert.ok(walked.has(dir), `the detector no longer walks ${dir}`);
    }
    const byDir = (d) => hits.filter(h => h.startsWith(d + '/')).length;
    assert.ok(byDir('test/unit') >= 20, `only ${byDir('test/unit')} unit extraction files detected; the detector has gone blind there`);
    assert.ok(byDir('test/tools') >= 3, `only ${byDir('test/tools')} tools extraction files detected; the detector has gone blind there`);
    assert.ok(byDir('test/integration') >= 2, `only ${byDir('test/integration')} integration extraction files detected; the detector has gone blind there`);
    assert.ok(byDir('test/helpers') >= 1, `only ${byDir('test/helpers')} helper extraction files detected; the detector has gone blind there`);

    const registered = new Set(ENUMERATIONS.map(e => e.file));
    const unregistered = hits.filter(h => !registered.has(h));
    assert.deepStrictEqual(unregistered, [],
      'a file walks source with a pattern and is not in the ENUMERATIONS registry. An extraction '
      + 'can stop matching and return a short list that agrees with itself, so register it here '
      + 'with the property that makes that loud: a count or specimen, imported values, or a '
      + 'mutation row that removes a member');
  });

  test('every registered enumeration still walks source', () => {
    const hits = new Set(detectorHits().hits);
    const gone = ENUMERATIONS.filter(e => !hits.has(e.file)).map(e => e.file);
    assert.deepStrictEqual(gone, [],
      'a registered file no longer walks source (or no longer exists); remove its row so the registry stays true');
  });

  // Well-formedness only: `where` is descriptive prose pointing a reader at
  // the guard, and this suite does not verify the prose still names a live
  // line. The property itself is exercised where it lives, per row.
  test('every registry row is well formed', () => {
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

  // The parser refusing is half the rule; the report is where a person reads
  // the verdict, and one harness proved the two can drift: its parser refused
  // and its report printed the refusal as a guard nobody was watching. So
  // every harness's report is cut out and driven with a refusal row, in both
  // shapes, and must say no verdict was obtained rather than any definite
  // thing.
  for (const file of HARNESSES) {
    test(`${path.basename(file)} reports a refusal as no verdict, in both shapes`, () => {
      const src = read(file);
      const m = src.match(/function report\(results, markdown\) \{[\s\S]*?\n\}/);
      assert.ok(m, `${file}: report could not be cut out; if it moved or was renamed, update this extraction`);
      const probe = [{ label: 'probe-mutation', applied: true, unparsable: true, red: [], matches: 1 }];
      for (const markdown of [true, false]) {
        const said = [];
        const fakeConsole = { log: (line) => said.push(String(line)), error: (line) => said.push(String(line)) };
        // The copies may print module-level extras after their table (the
        // fence harness lists what it deliberately does not mutate); those
        // identifiers are stubbed empty so the refusal row itself is what is
        // driven.
        const factory = new Function('console', 'NOT_MUTATED', `${m[0]}; return report;`);
        const failures = factory(fakeConsole, [])(probe, markdown);
        const out = said.join('\n');
        assert.ok(out.includes('probe-mutation'),
          `${file}: the ${markdown ? 'markdown' : 'plain'} report does not name the mutation that got no verdict`);
        assert.match(out, /no verdict/i,
          `${file}: the ${markdown ? 'markdown' : 'plain'} report must say no verdict was obtained, not a definite result`);
        assert.doesNotMatch(out, /NOTHING TURNED RED/,
          `${file}: a refusal must never be printed as a mutation nothing noticed`);
        assert.ok(failures >= 1,
          `${file}: a refusal row must count as a failure so the gate stays red`);
      }
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

  test('the amnesty list only shrinks, by membership and not by count', () => {
    const { AC_LABEL_AMNESTY } = buildScanner();
    // The exact membership on the day the ratchet was added. A size cap would
    // let one file leave and another arrive with the count holding, so the
    // check is subset: every current member must be one of these, and burning
    // a file down means removing it from the scanner's list (this copy needs
    // no edit; it is the ceiling, not the state). A new member here means a
    // new file shipped the shape, which the rule exists to stop: reword the
    // file instead.
    const RATCHETED = new Set([
    'docs/TEST-TIMING.md',
    'docs/evidence/red-first-orphans-evidence.md',
    'docs/evidence/scheduler-lifecycle-evidence.md',
    'docs/evidence/setup-race-flakes-evidence.md',
    'scripts/red-first.js',
    'test/e2e/file-tree-icons.spec.js',
    'test/e2e/theme.spec.js',
    'test/integration/scheduler-gating.test.js',
    'test/integration/scheduler-output-drain.test.js',
    'test/integration/scheduler-predating-routines.test.js',
    'test/integration/scheduler-run-observation.test.js',
    'test/integration/scheduler-run-records.test.js',
    'test/integration/scheduler-workspace-lifecycle.test.js',
    'test/tools/mutate-routines-guards.js',
    'test/tools/mutate-run-detail-guards.js',
    'test/unit/boundary.test.js',
    'test/unit/guide-name.test.js',
    'test/unit/profile-boxes.test.js',
    'test/unit/red-first-orphans.test.js',
    'test/unit/red-first.test.js',
    'test/unit/routine-actions.test.js',
    'test/unit/routine-editor-contract.test.js',
    'test/unit/routine-editor-doors.test.js',
    'test/unit/routine-editor-model.test.js',
    'test/unit/routine-editor-view.test.js',
    'test/unit/routine-model.test.js',
    'test/unit/routine-timezone.test.js',
    'test/unit/routines-end-to-end.test.js',
    'test/unit/routines-model.test.js',
    'test/unit/routines-next-run.test.js',
    'test/unit/routines-panel.test.js',
    'test/unit/routines-view-doors.test.js',
    'test/unit/routines-view.test.js',
    'test/unit/scheduler-lib.test.js',
    'test/unit/scheduler-lifecycle-doors.test.js',
    'test/unit/session-transcript-capture.test.js',
    'test/unit/session-transcript.test.js',
    'test/unit/team-sidebar.test.js',
    ]);
    const arrivals = [...AC_LABEL_AMNESTY].filter(f => !RATCHETED.has(f));
    assert.deepStrictEqual(arrivals, [],
      'a file joined the amnesty after the ratchet date; the list may only burn down');
  });
});

// ---------------------------------------------------------------------------
// The optional encoder
// ---------------------------------------------------------------------------

// The criterion's named proof, measured 2026-09-03 rather than reasoned: a
// clean `npm ci --omit=optional --ignore-scripts` against this manifest
// completed (318 packages, no encoder), and this suite's own green run was
// made in a working tree whose encoder download had been refused by a
// restricted network at install time, which is the environment the criterion
// describes running the focused gate.
describe('a fresh install works without the media encoder', () => {
  test('ffmpeg-static is optional, and its consumer guards the require', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.ok(!(pkg.dependencies || {})['ffmpeg-static'],
      'ffmpeg-static must not be a hard dependency: it downloads from outside the npm registry at install time, and nothing the tests need uses it');
    assert.strictEqual((pkg.optionalDependencies || {})['ffmpeg-static'], '^5.2.0',
      'the capture pipeline still wants the encoder where the optional install succeeds');
    // The property, not the formatting: the optional require must sit inside
    // a try block so its absence degrades instead of throwing, whatever the
    // statement's spacing or the local names around it.
    assert.match(read('scripts', 'screenshots', 'motion.mjs'),
      /try\s*\{[^{}]*require\('ffmpeg-static'\)[^{}]*\}\s*catch/,
      'motion.mjs must keep guarding the require, so an install without the optional package still runs');
  });

  test('the packaged application does not carry the encoder', () => {
    // Measured 2026-09-03: moving the encoder to optionalDependencies made it
    // a production dependency, and the desktop build packs the production
    // tree, so without this exclusion the shipped app gains a large encoder
    // binary no shipped code path uses. The exclusion is what keeps the
    // packaged output indifferent to the install-time class; this assertion
    // is what keeps the exclusion.
    const files = JSON.parse(read('package.json')).build.files;
    assert.ok(files.includes('!node_modules/ffmpeg-static/**'),
      'the build file set must exclude the optional encoder, or the shipped app carries it for nothing');
  });
});
