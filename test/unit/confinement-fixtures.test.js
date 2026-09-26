'use strict';
// The hostile fixtures are safe to run on anyone's machine, and these keep
// them that way (the fixture rules of the confinement criteria).
//
// They are checked rather than trusted because the failure they prevent is
// quiet: a fixture edited to point at a real host, or a harness changed to
// read a real workspace, would still make every confinement test pass, and
// the first anyone would know is data leaving a developer's laptop.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const harness = require('../helpers/confinement-harness.js');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURE_FILES = fs.readdirSync(harness.FIXTURES).filter((f) => f !== 'README.md');

// Every address a file names, in any form a fixture could reach something
// by: URLs, protocol-relative references, STUN and TURN servers, and bare
// IPv4 addresses. The only allowed destinations are the harness's own
// placeholders and loopback.
function destinationsIn(text) {
  const found = [];
  const patterns = [
    /\b(?:https?|wss?|ftp):\/\/[^\s'"`<>)]+/gi,
    /(?:^|[\s'"`(=])\/\/[a-z0-9.-]+\.[a-z]{2,}[^\s'"`<>)]*/gi,
    /\b(?:stuns?|turns?):[^\s'"`<>)]+/gi,
    /\b\d{1,3}(?:\.\d{1,3}){3}\b/g,
  ];
  for (const p of patterns) for (const m of text.matchAll(p)) found.push(m[0].trim());
  return found;
}

function offMachine(dest) {
  const d = dest.replace(/^[\s'"`(=]+/, '');
  if (d.includes('__LOGGER__') || d.includes('__UDP__')) return false;
  return !/^(?:[a-z]+:\/\/)?(?:127\.0\.0\.1|localhost)(?::\d+)?(?:[/?#].*)?$/i.test(d.replace(/^(?:stuns?|turns?):/i, ''))
    && !/^127\.0\.0\.1$/.test(d);
}

describe('no hostile fixture can reach anything off the machine', () => {
  test('there are fixtures to check, so an empty read cannot pass', () => {
    assert.ok(FIXTURE_FILES.length >= 5, `found ${FIXTURE_FILES.length} fixtures`);
  });

  test('every destination a fixture names is a placeholder or loopback', () => {
    for (const file of FIXTURE_FILES) {
      const text = fs.readFileSync(path.join(harness.FIXTURES, file), 'utf8');
      const bad = destinationsIn(text).filter(offMachine);
      assert.deepStrictEqual(bad, [], `${file} names a destination off this machine`);
    }
  });

  test('the check sees a planted external address, in every form', () => {
    for (const planted of ["location.href='https://evil.example/x'", "fetch('//evil.example/x')",
      "{urls:'stun:stun.evil.example:3478'}", "new WebSocket('wss://evil.example')", "img.src='http://203.0.113.9/'"]) {
      assert.ok(destinationsIn(planted).some(offMachine), `the scan missed: ${planted}`);
    }
    assert.ok(!destinationsIn("location.href='__LOGGER__/leak'").some(offMachine));
    assert.ok(!destinationsIn("fetch('http://127.0.0.1:4000/x')").some(offMachine));
  });

  test('the placeholders are filled only with the harness\'s loopback listener', async () => {
    const listener = await harness.startListener();
    try {
      assert.match(listener.url, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.match(listener.udp, /^127\.0\.0\.1:\d+$/);
      for (const file of FIXTURE_FILES) {
        const filled = harness.fixtureSource(file, listener);
        assert.deepStrictEqual(destinationsIn(filled).filter(offMachine), [], `${file} once filled`);
      }
    } finally { listener.close(); }
  });
});

describe('a hostile run touches only a canary workspace in the temporary directory', () => {
  test('the canary workspace is in the temporary directory and holds only fake values', () => {
    const ws = harness.canaryWorkspace();
    assert.ok(ws.startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
    const mcp = fs.readFileSync(path.join(ws, '.mcp.json'), 'utf8');
    assert.match(mcp, new RegExp(harness.CANARY_KEY));
  });

  test('a run pointed anywhere else refuses to start', () => {
    for (const elsewhere of [ROOT, os.homedir(), path.join(ROOT, 'test')]) {
      assert.throws(() => harness.assertTemporaryWorkspace(elsewhere), /refusing to run against/,
        `${elsewhere} was accepted`);
    }
  });

  test('the harness page is only ever built from a checked workspace', async () => {
    const listener = await harness.startListener();
    try {
      await assert.rejects(harness.startHarness({ workspace: ROOT, listener }), /refusing to run against/);
    } finally { listener.close(); }
  });
});

describe('hostile fixtures are never installed', () => {
  const ids = FIXTURE_FILES.map((f) => f.replace(/\.[a-z]+$/, ''));

  test('the harness mounts directly and never reaches the install flow or the record store', () => {
    const source = fs.readFileSync(path.join(ROOT, 'test', 'helpers', 'confinement-harness.js'), 'utf8');
    assert.doesNotMatch(source, /lib\/packages|extensions\.json|installExtension|plan_package|confirm_/,
      'the harness must not touch anything that installs or records an extension');
  });

  test('no extension record anywhere in the repository names a hostile fixture', () => {
    const records = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name === 'extensions.json') records.push(full);
      }
    };
    walk(ROOT);
    for (const file of records) {
      const text = fs.readFileSync(file, 'utf8');
      for (const id of ids) assert.ok(!text.includes(id), `${path.relative(ROOT, file)} names hostile fixture ${id}`);
    }
  });

  test('no fixture carries a package manifest, so none could be installed from a link', () => {
    assert.ok(!fs.existsSync(path.join(harness.FIXTURES, 'rundock.json')));
  });
});

// The sources and ask harness is held to the same fixture rules as the
// confinement harness is, and every link its canary world plants points
// inside that run's own temporary root, never at a real file.
describe('the trust-boundary harness is as safe as the confinement harness', () => {
  const tb = require('../helpers/trust-boundary-harness.js');
  const os = require('node:os');

  // The check, as a function, so a test can prove it would catch a link that
  // escapes the root.
  function linksEscaping(world) {
    return tb.plantedLinks(world).filter((l) => !l.target.startsWith(world.root + path.sep));
  }

  test('every planted symlink and hard link resolves inside the run\'s temporary root, which is under the system temporary directory', () => {
    const world = tb.sourcesWorld();
    assert.ok(world.root.startsWith(fs.realpathSync(os.tmpdir()) + path.sep));
    const links = tb.plantedLinks(world);
    assert.ok(links.length >= 4, 'the world plants its links');
    assert.deepStrictEqual(linksEscaping(world), []);
  });

  test('the check fails on a link that points outside the root', () => {
    const world = tb.sourcesWorld();
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-elsewhere-'));
    fs.symlinkSync(elsewhere, path.join(world.ws, 'escape'));
    assert.strictEqual(linksEscaping(world).length, 1);
  });

  test('it installs nothing and serves only the real host modules and the real resolver', () => {
    const source = fs.readFileSync(path.join(ROOT, 'test', 'helpers', 'trust-boundary-harness.js'), 'utf8');
    assert.doesNotMatch(source, /extensions\.json|installExtension|plan_package|confirm_/);
    assert.match(source, /listen\(0, '127\.0\.0\.1'/, 'loopback only');
  });

  test('every control it can apply still matches the shipped host, so none is silently a no-op', () => {
    for (const name of Object.keys(tb.CONTROLS)) {
      assert.notStrictEqual(tb.hostSource(name), tb.hostSource(''), name);
    }
  });
});
