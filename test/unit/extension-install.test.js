'use strict';
// Installing an extension from a GitHub link, driven at every seam the flow
// has: the source rules, the acquisition, the trust step's derived facts,
// the consent order, and the installed record. Removing an extension is a
// package uninstall, covered by package-uninstall.test.js.
//
// No network anywhere: the acquirer and the ref-lister are the injectable
// dependencies the handlers expose for exactly this, and every snapshot is a
// fixture tree written by the test that reads it.

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

// The transaction seam is wrapped BEFORE the modules under test are loaded,
// so the suite can see how many transactions an install really is without
// touching what they do.
const atomicWrite = require('../../lib/workspace/atomic-write.js');
const realWriteAsUnit = atomicWrite.writeAsUnit;
let unitCalls = [];
atomicWrite.writeAsUnit = (workspace, writes, options) => {
  const relative = (p) => path.relative(workspace, p).split(path.sep).join('/');
  unitCalls.push({
    files: (writes || []).map((w) => relative(w.path)),
    dirs: ((options && options.replaceDirs) || []).map((d) => relative(d.path)),
  });
  return realWriteAsUnit(workspace, writes, options);
};
const { JSDOM } = require('jsdom');

const {
  parseGitHubSource, requirePin, requireFixedPin, acquireWithGit, acquiredCommit, acquiredPinKind,
  discardAcquisition, listRefsWithGit, MOVING_NAMES,
} = require('../../lib/packages/extension-source.js');
const {
  readExtensionManifest, classifySnapshot, deriveFacts, extensionFileSet,
} = require('../../lib/packages/extension-manifest.js');
const {
  RECORDS_PATH, EXTENSIONS_ROOT, readExtensionRecords, serialiseRecords, latestTag,
} = require('../../lib/packages/extension-record.js');
const {
  planExtensionInstall, installExtension,
} = require('../../lib/packages/extension-install.js');
const handlers = require('../../lib/protocol/handlers/packages.js');
// A fixture snapshot stands for a fetched tag unless a test says otherwise.
// What a reference is on the remote is the real acquirer's to record, and
// that record is driven against a real repository in extension-install.
const REAL_DEPS = handlers.wireExtensionDeps({ pinKindOf: () => 'tag' });
const { buildDispatch } = require('../../lib/protocol/handlers/index.js');
const { listExtensions } = require('../../lib/packages/extension-registry.js');
const { buildPlan } = require('../../lib/packages/import-plan.js');
const config = require('../../lib/config.js');
const model = require('../../public/packages-install-model.js');

// public/views/settings.js is a UMD module: under Node it reads
// RundockPackagesInstallModel off the global scope in place of the window
// property a browser gives it. Set once, before anything requires that
// module, so its own module-level state initialises correctly regardless of
// which test triggers the first require.
global.RundockPackagesInstallModel = model;

const CLEANUP = [];
afterEach(() => {
  while (CLEANUP.length) fs.rmSync(CLEANUP.pop(), { recursive: true, force: true });
});
beforeEach(() => { unitCalls = []; });

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  CLEANUP.push(dir);
  return dir;
}

// A workspace the flow can write into, opened for the modules that read the
// configured one.
function workspace() {
  return tempDir('ext-ws-');
}

// One extension snapshot: a manifest, a view directory, and optionally the
// content items the trust step counts.
function extensionSnapshot({ name = 'test-ext', version = '1.0.0', agents = 0, skills = 0, manifest = true } = {}) {
  const dir = tempDir('ext-snap-');
  fs.mkdirSync(path.join(dir, 'view'));
  fs.writeFileSync(path.join(dir, 'view', 'index.html'), '<main>rendered by the extension</main>\n');
  fs.writeFileSync(path.join(dir, 'view', 'style.css'), 'main { display: block; }\n');
  if (manifest) {
    fs.writeFileSync(path.join(dir, 'rundock.json'), JSON.stringify({
      name, version, extension: { entry: 'view/index.html', match: '*.dataview.md' },
    }, null, 2));
  }
  if (agents || skills) {
    fs.mkdirSync(path.join(dir, '.claude', 'agents'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.claude', 'skills'), { recursive: true });
    for (let i = 0; i < agents; i += 1) {
      fs.writeFileSync(path.join(dir, '.claude', 'agents', `helper-${i}.md`),
        `---\nname: helper-${i}\n---\nAn agent.\n`);
    }
    for (let i = 0; i < skills; i += 1) {
      const skill = path.join(dir, '.claude', 'skills', `craft-${i}`);
      fs.mkdirSync(skill);
      fs.writeFileSync(path.join(skill, 'SKILL.md'), 'A skill.\n');
    }
  }
  return dir;
}

const SOURCE = { url: 'https://github.com/someone/test-ext', reference: 'v1.0.0' };

describe('the pin is required, and a moving name is not a pin', () => {
  test('a URL with a tag parses, in both spellings, to one identity', () => {
    const full = parseGitHubSource('https://github.com/someone/test-ext', 'v1.0.0');
    const short = parseGitHubSource('someone/test-ext', 'v1.0.0');
    const gitSuffix = parseGitHubSource('https://github.com/someone/test-ext.git', 'v1.0.0');
    assert.strictEqual(full.url, 'https://github.com/someone/test-ext');
    assert.strictEqual(short.url, full.url, 'shorthand and URL are one identity');
    assert.strictEqual(gitSuffix.url, full.url, 'the .git suffix is spelling, not identity');
    assert.strictEqual(full.reference, 'v1.0.0', 'the pin is recorded verbatim');
  });

  test('a commit pin is a pin', () => {
    const source = parseGitHubSource('someone/test-ext', 'a1b2c3d4');
    assert.strictEqual(source.reference, 'a1b2c3d4');
  });

  test('a link that names its reference supplies it: a release URL, a tree URL, and the @ shorthand', () => {
    for (const link of [
      'https://github.com/someone/test-ext/releases/tag/v1.0.1',
      'https://github.com/someone/test-ext/tree/v1.0.1',
      'https://github.com/someone/test-ext/tree/v1.0.1/',
      'someone/test-ext@v1.0.1',
    ]) {
      const source = parseGitHubSource(link, '');
      assert.strictEqual(source.url, 'https://github.com/someone/test-ext', `${link} resolves to the one identity`);
      assert.strictEqual(source.reference, 'v1.0.1', `${link} supplies the reference from the link itself`);
    }
  });

  test('a reference named by the link passes through the same refusals a separate one does', () => {
    for (const link of ['someone/test-ext@main', 'https://github.com/someone/test-ext/tree/main',
      'https://github.com/someone/test-ext/releases/tag/refs/heads/main']) {
      assert.throws(() => parseGitHubSource(link, ''), (e) => e.code === 'unpinned-reference',
        `${link} names a moving branch and must not pass as a pin`);
    }
    assert.throws(() => parseGitHubSource('someone/test-ext@-x', ''), (e) => e.code === 'unpinned-reference',
      'a dash-leading reference in the link is refused before it can reach a git argv');
    assert.throws(() => parseGitHubSource('someone/test-ext@v1.0.1', 'v2.0.0'), /already names "v1\.0\.1"/,
      'a link naming one reference cannot also be pinned to another');
    assert.strictEqual(parseGitHubSource('someone/test-ext@v1.0.1', 'v1.0.1').reference, 'v1.0.1',
      'the same reference twice is one channel spelled twice, not a conflict');
  });

  test('a missing reference parses to null, and requirePin refuses it with the reason, never defaulted', () => {
    for (const absent of [undefined, null, '', '   ']) {
      const source = parseGitHubSource('someone/test-ext', absent);
      assert.strictEqual(source.reference, null, 'agents and skills may be read unpinned, so absence is carried as null');
      assert.throws(() => requirePin(source), (e) => e.code === 'unpinned-reference' && /exact tag, release or commit/.test(e.message));
    }
    assert.strictEqual(requirePin(parseGitHubSource('someone/test-ext', 'v1.0.0')).reference, 'v1.0.0');
  });

  test('every well-known moving name is refused as not a pin, in every spelling git accepts for a branch tip', () => {
    for (const name of MOVING_NAMES) {
      for (const spelling of [name, name.toUpperCase(), `refs/heads/${name}`, `heads/${name}`, `REFS/HEADS/${name}`]) {
        assert.throws(() => parseGitHubSource('someone/test-ext', spelling),
          (e) => e.code === 'unpinned-reference',
          `${spelling} must not pass as a pin`);
      }
    }
    assert.strictEqual(parseGitHubSource('someone/test-ext', 'refs/tags/v1.0.0').reference, 'refs/tags/v1.0.0',
      'a qualified tag is not a branch tip and passes through verbatim');
  });

  test('a non-GitHub URL is refused by name', () => {
    assert.throws(() => parseGitHubSource('https://example.com/x/y', 'v1'),
      /not a GitHub repository/);
  });

  test('a reference beginning with "-" is refused, before it can reach a git argv position', () => {
    // The reference is spelled straight into `git fetch ... origin <ref>`
    // and into the ls-remote used by the update check; a leading dash makes
    // git read it as an option instead of a thing to fetch, which changes
    // the command rather than naming a snapshot.
    assert.throws(() => parseGitHubSource('someone/test-ext', '--upload-pack=evil'),
      (e) => e.code === 'unpinned-reference', 'an argv-shaped reference is refused as not a pin');
    assert.throws(() => parseGitHubSource('someone/test-ext', '-x'),
      (e) => e.code === 'unpinned-reference');
  });
});

describe('the default ref-lister, exercised against real git with no network', () => {
  test('listRefsWithGit reads exactly the tag names from a real local repository', () => {
    // A local path is a perfectly good git remote for ls-remote, so this
    // pins the default's real parsing (tags only, split on refs/tags/)
    // against real git rather than a fixture that only copies its shape,
    // with no network involved.
    const repo = tempDir('ext-tagrepo-');
    const git = (args) => execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
    git(['init', '--quiet']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(repo, 'file.txt'), 'x\n');
    git(['add', '.']);
    git(['commit', '--quiet', '-m', 'first']);
    git(['tag', 'v1.0.0']);
    fs.writeFileSync(path.join(repo, 'file.txt'), 'y\n');
    git(['commit', '--quiet', '-am', 'second']);
    git(['tag', 'v2.0.0']);
    git(['branch', 'not-a-tag']);

    const refs = listRefsWithGit(repo);
    assert.deepStrictEqual([...refs].sort(), ['v1.0.0', 'v2.0.0'],
      'exactly the tag names come back; the branch is not among them');
  });
});

describe('the real acquirer, exercised against real git with no network', () => {
  // The same no-network technique as listRefsWithGit above, applied to the
  // one function every test elsewhere in this file fakes: acquireWithGit
  // itself is what turns a pasted URL plus pin into bytes, so this is the
  // only place that claim is checked against what it actually produces
  // rather than against a fixture built to look like it.
  function tagRepo() {
    const repo = tempDir('ext-acquire-repo-');
    const git = (args) => execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
    git(['init', '--quiet']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(repo, 'marker.txt'), 'v1 bytes\n');
    fs.mkdirSync(path.join(repo, 'nested'));
    fs.writeFileSync(path.join(repo, 'nested', 'file.txt'), 'v1 nested\n');
    git(['add', '.']);
    git(['commit', '--quiet', '-m', 'first']);
    git(['tag', 'v1.0.0']);
    fs.writeFileSync(path.join(repo, 'marker.txt'), 'v2 bytes\n');
    git(['commit', '--quiet', '-am', 'second']);
    git(['tag', 'v2.0.0']);
    return repo;
  }

  test('acquireWithGit checks out exactly the pinned tag\'s bytes and leaves no .git behind', () => {
    const repo = tagRepo();
    const snapshot = acquireWithGit({ url: repo, reference: 'v1.0.0' });
    CLEANUP.push(snapshot);
    assert.strictEqual(fs.readFileSync(path.join(snapshot, 'marker.txt'), 'utf8'), 'v1 bytes\n',
      'the checked-out bytes are the pinned tag, not the later commit on the same repository');
    assert.strictEqual(fs.readFileSync(path.join(snapshot, 'nested', 'file.txt'), 'utf8'), 'v1 nested\n');
    assert.strictEqual(fs.existsSync(path.join(snapshot, '.git')), false,
      'no .git directory remains in the snapshot the trust step would read');
  });

  test('a fetch of a reference that does not exist refuses with code acquire-failed and removes the temporary directory it created', () => {
    const repo = tagRepo();
    // acquireWithGit creates its own temp directory internally and never
    // hands its path back on failure, so the proof is by name prefix rather
    // than by the exact path: nothing new under that prefix survives.
    const before = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('rundock-ext-')));
    assert.throws(() => acquireWithGit({ url: repo, reference: 'v9.9.9-does-not-exist' }),
      (e) => e.code === 'acquire-failed');
    const after = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('rundock-ext-')));
    const leaked = [...after].filter((n) => !before.has(n));
    assert.deepStrictEqual(leaked, [],
      'the temporary directory acquireWithGit created for the failed fetch was not removed');
  });
});

describe('the manifest is required for code, and refused strictly', () => {
  test('a snapshot with no manifest is not an extension, with its own code', () => {
    const dir = tempDir('bare-');
    fs.writeFileSync(path.join(dir, 'README.md'), 'just files\n');
    assert.throws(() => readExtensionManifest(dir), (e) => e.code === 'not-an-extension');
  });

  test('an entry that does not exist, or escapes the package, is refused', () => {
    const dir = extensionSnapshot();
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'rundock.json'), 'utf8'));
    manifest.extension.entry = 'view/missing.html';
    fs.writeFileSync(path.join(dir, 'rundock.json'), JSON.stringify(manifest));
    assert.throws(() => readExtensionManifest(dir), /does not exist/);
    manifest.extension.entry = '../outside.html';
    fs.writeFileSync(path.join(dir, 'rundock.json'), JSON.stringify(manifest));
    assert.throws(() => readExtensionManifest(dir), /inside the package/);
  });

  test('an entry path passing through a symlinked directory segment is refused before any bytes are read', () => {
    const dir = tempDir('symlink-entry-');
    const outside = tempDir('symlink-outside-');
    fs.writeFileSync(path.join(outside, 'secret.html'), 'OUTSIDE BYTES\n');
    // "view" itself is a symlink pointing outside the snapshot; the entry
    // names a file reached only by walking through it.
    fs.symlinkSync(outside, path.join(dir, 'view'));
    fs.writeFileSync(path.join(dir, 'rundock.json'), JSON.stringify({
      name: 'test-ext', version: '1.0.0', extension: { entry: 'view/secret.html', match: '*.md' },
    }, null, 2));
    assert.throws(() => readExtensionManifest(dir), /symlink/,
      'a symlinked path segment is refused by name, reached only by lstat, before the file it leads to is ever opened');
  });

  test('a file inside the extension directory that is itself a symlink to outside the snapshot is refused, and nothing outside is read', () => {
    const dir = extensionSnapshot();
    const outside = tempDir('symlink-outside-');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE BYTES\n');
    // A file sitting beside the (legitimate) entry, inside the same
    // top-level directory extensionFileSet walks whole.
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'view', 'leak.txt'));
    const manifest = readExtensionManifest(dir);
    assert.throws(() => extensionFileSet(dir, manifest.entry), /symlink/,
      'a symlinked file inside the mounted directory is refused by name, whatever order the directory walk reaches it in');
    assert.throws(() => deriveFacts(dir, manifest), /symlink/,
      'deriveFacts calls extensionFileSet for facts.files too, so the trust step\'s own file list refuses the same way');
  });

  test('declared stylesheets are read from the manifest, and their absence is an empty list', () => {
    const dir = extensionSnapshot();
    const manifest = readExtensionManifest(dir);
    assert.deepStrictEqual(manifest.styles, [], 'no declaration means no stylesheets, stated rather than undefined');
    const declaring = JSON.parse(fs.readFileSync(path.join(dir, 'rundock.json'), 'utf8'));
    declaring.extension.styles = ['view/style.css'];
    fs.writeFileSync(path.join(dir, 'rundock.json'), JSON.stringify(declaring));
    assert.deepStrictEqual(readExtensionManifest(dir).styles, ['view/style.css'],
      'a declared stylesheet is a claim the manifest carries, read like the entry');
  });

  test('a declared stylesheet is validated the way the entry is: relative, present, a regular file, no symlinks', () => {
    const cases = [
      ['a styles field that is not an array', (m) => { m.extension.styles = 'view/style.css'; }, /styles must be an array/],
      ['a stylesheet that is not a path', (m) => { m.extension.styles = [5]; }, /must be a relative path/],
      ['an absolute stylesheet', (m) => { m.extension.styles = ['/etc/hosts']; }, /must not be absolute/],
      ['a stylesheet escaping the package', (m) => { m.extension.styles = ['../outside.css']; }, /must stay inside the package/],
      ['a stylesheet that does not exist', (m) => { m.extension.styles = ['view/missing.css']; }, /does not exist/],
      ['a stylesheet that is a directory', (m) => { m.extension.styles = ['view']; }, /is not a regular file/],
    ];
    for (const [label, change, expected] of cases) {
      const dir = extensionSnapshot();
      const manifestPath = path.join(dir, 'rundock.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      change(manifest);
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      assert.throws(() => readExtensionManifest(dir), expected, label);
    }
    const dir = extensionSnapshot();
    const outside = tempDir('symlink-outside-');
    fs.writeFileSync(path.join(outside, 'secret.css'), 'OUTSIDE BYTES\n');
    fs.symlinkSync(path.join(outside, 'secret.css'), path.join(dir, 'linked.css'));
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'rundock.json'), 'utf8'));
    manifest.extension.styles = ['linked.css'];
    fs.writeFileSync(path.join(dir, 'rundock.json'), JSON.stringify(manifest));
    assert.throws(() => readExtensionManifest(dir), /symlink/,
      'a symlinked stylesheet is refused before its bytes are ever read');
  });

  test('an install materializes a declared stylesheet outside the entry\'s top level, and the record carries the copy', () => {
    withWorkspace((ws) => {
      const dir = tempDir('ext-styles-');
      fs.mkdirSync(path.join(dir, 'ui'));
      fs.mkdirSync(path.join(dir, 'styles'));
      fs.writeFileSync(path.join(dir, 'ui', 'index.js'), 'draw();\n');
      fs.writeFileSync(path.join(dir, 'styles', 'table.css'), 'th{color:var(--accent)}\n');
      fs.writeFileSync(path.join(dir, 'rundock.json'), JSON.stringify({
        name: 'styled-ext', version: '1.0.0',
        extension: { entry: 'ui/index.js', match: '*.csv', styles: ['styles/table.css'] },
      }));
      const manifest = readExtensionManifest(dir);
      assert.deepStrictEqual(extensionFileSet(dir, manifest.entry, manifest.styles).map((f) => f.rel).sort(),
        ['styles/table.css', 'ui/index.js'],
        'the file set covers what the manifest declares, the entry and the styles both');
      assert.deepStrictEqual(deriveFacts(dir, manifest).files, ['styles/table.css', 'ui/index.js'],
        'the trust step\'s file list shows the stylesheet it is consenting to');
      const record = installExtension(ws, dir, planExtensionInstall(ws, dir, SOURCE));
      assert.deepStrictEqual(record.styles, ['styles/table.css'],
        'the record takes a copy of the styles claim, as it does of the entry and the match');
      assert.strictEqual(
        fs.readFileSync(path.join(ws, ...EXTENSIONS_ROOT.split('/'), 'styled-ext', 'styles', 'table.css'), 'utf8'),
        'th{color:var(--accent)}\n',
        'the stylesheet the manifest declares is on disk where the payload will read it');
    });
  });

  test('declares is read from the manifest as the marker claim, and its absence is stated as null', () => {
    const dir = extensionSnapshot();
    assert.strictEqual(readExtensionManifest(dir).declares, null,
      'no declaration means the whole match rule, stated rather than undefined');
    const declaring = JSON.parse(fs.readFileSync(path.join(dir, 'rundock.json'), 'utf8'));
    declaring.extension.match = '*.md';
    declaring.extension.declares = 'standup-plugin';
    fs.writeFileSync(path.join(dir, 'rundock.json'), JSON.stringify(declaring));
    assert.strictEqual(readExtensionManifest(dir).declares, 'standup-plugin',
      'a declared marker is a claim the manifest carries, read like the match rule');
    assert.strictEqual(deriveFacts(dir, readExtensionManifest(dir)).declares, 'standup-plugin',
      'and the fact rides to the trust step from the same read, so the screen cannot state a wider claim');
  });

  // The break that would have stopped every diagram: a region extension has
  // no renderer to name, and the payload path required one. Found by building
  // a real workspace and asking the server for the entry, not by the suite,
  // which passed over it because nothing drove a region extension this far.
  test('a region extension is served its entry without naming a renderer it does not have', () => {
    const dir = extensionSnapshot();
    const manifestPath = path.join(dir, 'rundock.json');
    const region = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    delete region.extension.match;
    region.extension.draws = 'mermaid';
    fs.writeFileSync(manifestPath, JSON.stringify(region));
    const manifest = readExtensionManifest(dir);
    assert.strictEqual(manifest.draws, 'mermaid');
    assert.strictEqual(manifest.match, null,
      'it claims no file, which is exactly why it can name no renderer');
  });

  // A region extension names the fenced language it draws. It claims
  // no file and registers no renderer: the document stays the editor's, and
  // only the block inside the fence is delegated. So this is a separate claim
  // from `match` and `declares`, and an extension may carry it alone.
  test('a drawn language is declared, defaults to absent, and is refused when it is not a language slug', () => {
    const dir = extensionSnapshot();
    const manifestPath = path.join(dir, 'rundock.json');
    assert.strictEqual(readExtensionManifest(dir).draws, null,
      'an extension that draws nothing says so as null, not as a missing key somebody has to interpret');
    assert.strictEqual(deriveFacts(dir, readExtensionManifest(dir)).draws, null,
      'and the trust step is told the same');

    const drawing = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    drawing.extension.draws = 'mermaid';
    fs.writeFileSync(manifestPath, JSON.stringify(drawing));
    assert.strictEqual(readExtensionManifest(dir).draws, 'mermaid');
    assert.strictEqual(deriveFacts(dir, readExtensionManifest(dir)).draws, 'mermaid',
      'the fact rides to the trust step from the same read, as every other claim does');

    for (const [why, value] of [['not a string', 5], ['spaces', 'not a lang'], ['capitals', 'Mermaid'],
      ['empty', ''], ['a dot', 'mer.maid']]) {
      const bad = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      bad.extension.draws = value;
      fs.writeFileSync(manifestPath, JSON.stringify(bad));
      assert.throws(() => readExtensionManifest(dir), /extension\.draws/,
        `${why} is refused by name rather than normalised into something`);
    }
  });

  test('an extension must claim something, and a fenced language is a claim', () => {
    const dir = extensionSnapshot();
    const manifestPath = path.join(dir, 'rundock.json');

    // A pure region extension: it draws mermaid and owns no file type. This
    // is what mermaid itself is, and requiring a match rule would force it to
    // name files it cannot render.
    const region = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    delete region.extension.match;
    region.extension.draws = 'mermaid';
    fs.writeFileSync(manifestPath, JSON.stringify(region));
    const read = readExtensionManifest(dir);
    assert.strictEqual(read.draws, 'mermaid');
    assert.strictEqual(read.match, null,
      'and it claims no file, stated as null rather than as a rule that matches nothing');

    // Neither claim is not a modest extension, it is one nobody can explain.
    const nothing = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    delete nothing.extension.match;
    delete nothing.extension.draws;
    fs.writeFileSync(manifestPath, JSON.stringify(nothing));
    assert.throws(() => readExtensionManifest(dir), /extension\.match|extension\.draws/,
      'an extension that claims nothing is refused by name');

    // A match rule that is present and empty is still wrong, draws or not:
    // the permission to omit it is not permission to write it badly.
    const empty = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    empty.extension.match = '   ';
    empty.extension.draws = 'mermaid';
    fs.writeFileSync(manifestPath, JSON.stringify(empty));
    assert.throws(() => readExtensionManifest(dir), /extension\.match/);
  });

  // Read-only is the default and writing is the declared exception,
  // so the manifest has to say it and the fact has to ride to the trust step
  // from the same read. A screen that states a narrower claim than the host
  // enforces is the absent-contract failure this surface exists to avoid, and
  // so is one that states a wider one.
  test('writing is declared, defaults to absent, and is refused when it is not a plain yes or no', () => {
    const dir = extensionSnapshot();
    const manifestPath = path.join(dir, 'rundock.json');
    assert.strictEqual(readExtensionManifest(dir).writes, false,
      'an extension that says nothing about writing cannot write; absence is an answer, not a gap');
    assert.strictEqual(deriveFacts(dir, readExtensionManifest(dir)).writes, false,
      'and the trust step is told that from the same read');

    const declaring = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    declaring.extension.writes = true;
    fs.writeFileSync(manifestPath, JSON.stringify(declaring));
    assert.strictEqual(readExtensionManifest(dir).writes, true,
      'a declared write is a claim the manifest carries, read like the match rule');
    assert.strictEqual(deriveFacts(dir, readExtensionManifest(dir)).writes, true,
      'and the fact rides to the trust step, so the card cannot understate what the host will allow');

    for (const [why, value] of [['a string', 'true'], ['a number', 1], ['null', null], ['an object', {}]]) {
      const bad = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      bad.extension.writes = value;
      fs.writeFileSync(manifestPath, JSON.stringify(bad));
      assert.throws(() => readExtensionManifest(dir), /extension\.writes/,
        `${why} is refused by name rather than coerced into a yes`);
    }
  });

  test('a declares that is not a frontmatter key is refused by name, never patched into one', () => {
    const cases = [
      ['a declares that is not a string', 5],
      ['a marker with spaces', 'not a key'],
      ['a marker with capitals', 'Standup-Plugin'],
      ['a marker leading with a dash', '-standup'],
      ['an empty marker', ''],
    ];
    for (const [label, declares] of cases) {
      const dir = extensionSnapshot();
      const manifestPath = path.join(dir, 'rundock.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest.extension.declares = declares;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      assert.throws(() => readExtensionManifest(dir), /declares must be a frontmatter marker key/, label);
    }
  });

  test('the record copies the declares claim as it copies entry and match, and no claim writes no field', () => {
    withWorkspace((ws) => {
      const snap = extensionSnapshot();
      const manifestPath = path.join(snap, 'rundock.json');
      const declaring = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      declaring.extension.match = '*.md';
      declaring.extension.declares = 'standup-plugin';
      fs.writeFileSync(manifestPath, JSON.stringify(declaring));
      const record = installExtension(ws, snap, planExtensionInstall(ws, snap, SOURCE));
      assert.strictEqual(record.declares, 'standup-plugin',
        'the record takes a copy, so the roster can read the claim when no manifest is materialized');
    });
    withWorkspace((ws) => {
      const snap = extensionSnapshot();
      const record = installExtension(ws, snap, planExtensionInstall(ws, snap, SOURCE));
      assert.ok(!('declares' in record),
        'no claim, no field: existing records and new marker-less ones stay one shape');
    });
  });

  test('an extension declaring no styles writes the record shape it always did', () => {
    withWorkspace((ws) => {
      const snap = extensionSnapshot();
      const record = installExtension(ws, snap, planExtensionInstall(ws, snap, SOURCE));
      assert.ok(!('styles' in record),
        'no claim, no field: existing records and new style-less ones stay one shape');
    });
  });
});

describe('the trust step shows derived facts, before anything is installed', () => {
  test('counts, files and the match rule come from the package bytes', () => {
    const snap = extensionSnapshot({ agents: 2, skills: 1 });
    const facts = deriveFacts(snap, readExtensionManifest(snap));
    assert.strictEqual(facts.agents, 2);
    assert.strictEqual(facts.skills, 1);
    assert.deepStrictEqual(facts.files, ['view/index.html', 'view/style.css'],
      'the file list is read from the tree, not from any declaration');
    assert.strictEqual(facts.match, '*.dataview.md');
  });

  test('planning writes nothing into the workspace', () => {
    const ws = workspace();
    const snap = extensionSnapshot();
    const before = fs.readdirSync(ws);
    planExtensionInstall(ws, snap, SOURCE);
    assert.deepStrictEqual(fs.readdirSync(ws), before, 'an offer is not an action');
    assert.strictEqual(unitCalls.length, 0, 'no transaction ran for a plan');
  });

  test('the trust copy says the honest halves: the view inside the host boundary, the agents and skills outside it, no review', () => {
    const state = {
      phase: 'trust', link: SOURCE.url, reference: SOURCE.reference, token: 't',
      manifest: { name: 'test-ext', version: '1.0.0' },
      facts: { agents: 2, skills: 1, files: ['view/index.html'], match: '*.dataview.md' },
      replaces: null,
    };
    const copy = model.trustCopy(state);
    assert.match(copy.halves.content, /not sandboxed.*same access your own agents have/,
      'the agents half is stated, because it is the larger part of the blast radius');
    assert.match(copy.reviewLine, /Rundock does not review extensions/,
      'the no-review fact is on the screen, not only in a document');
    assert.match(copy.factsLead, /Read from the package itself, not from its author/,
      'derived beats declared, and the reader is told which kind these are');
  });

  // A routine in a bundled agent's frontmatter starts running through
  // ordinary agent discovery once that agent lands, so the trust step must
  // carry it before the person answers. Per the recorded decision, the
  // sentence folds into "what you will keep" rather than standing as a
  // third block: the card's split is by reversibility, and a routine rides
  // with the agents the person keeps.
  test('facts carry each routine a bundled agent declares, and the trust card folds the sentence into what you will keep', () => {
    const snap = extensionSnapshot();
    fs.mkdirSync(path.join(snap, '.claude', 'agents'), { recursive: true });
    fs.mkdirSync(path.join(snap, '.claude', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(snap, '.claude', 'agents', 'assistant.md'),
      '---\nname: assistant\nroutines:\n  - name: Morning tidy\n    schedule: every day at 08:00\n    prompt: Tidy.\n    enabled: true\n---\nAn agent.\n');
    const facts = deriveFacts(snap, readExtensionManifest(snap));
    assert.deepStrictEqual(facts.routines, [
      { agent: 'assistant', name: 'Morning tidy', schedule: 'every day at 08:00', enabled: true },
    ], 'the routine is a derived fact, read from the agent bytes that would land');
    const copy = model.trustCopy({
      phase: 'trust', link: SOURCE.url, reference: SOURCE.reference, token: 't',
      manifest: { name: 'test-ext', version: '1.0.0' }, facts, replaces: null,
    });
    assert.match(copy.halves.content, /assistant carries the routine "Morning tidy"/);
    assert.match(copy.halves.content, /it will run itself every day at 08:00/);
    assert.match(copy.halves.content, /beginning at the first 08:00 after it is added/);
    assert.strictEqual(copy.keepsHeading, 'What you will keep',
      'the sentence lives inside the keep half; the card grows no third part');
  });

  test('an agent with no routine adds no automation sentence to the trust card', () => {
    const snap = extensionSnapshot({ agents: 1 });
    const facts = deriveFacts(snap, readExtensionManifest(snap));
    assert.deepStrictEqual(facts.routines, [], 'no routine is a stated absence, not a missing field');
    const copy = model.trustCopy({
      phase: 'trust', link: SOURCE.url, reference: SOURCE.reference, token: 't',
      manifest: { name: 'test-ext', version: '1.0.0' }, facts, replaces: null,
    });
    assert.doesNotMatch(copy.halves.content, /routine/i);
  });

  test('the trust step states the marked subset when one is declared, derived from the facts and never from prose', () => {
    const base = {
      phase: 'trust', link: SOURCE.url, reference: SOURCE.reference, token: 't',
      manifest: { name: 'test-ext', version: '1.0.0' },
      replaces: null,
    };
    const marked = model.trustCopy({ ...base,
      facts: { agents: 0, skills: 0, files: ['view/index.html'], match: '*.md', declares: 'standup-plugin' } });
    assert.match(marked.matchLine, /\*\.md/, 'the match rule is still stated');
    assert.match(marked.matchLine, /only those marked "standup-plugin"/,
      'and the marker narrows it in words: the person is not consenting to every markdown file');
    const bare = model.trustCopy({ ...base,
      facts: { agents: 0, skills: 0, files: ['view/index.html'], match: '*.csv' } });
    assert.strictEqual(bare.matchLine, 'It asks to render files matching: *.csv',
      'no marker keeps the sentence extensions have always shown');
    const snap = extensionSnapshot();
    assert.strictEqual(deriveFacts(snap, readExtensionManifest(snap)).declares, null,
      'the facts carry the marker slot, so the copy above is derived rather than invented');
  });

  test('the model sends nothing except on an explicit ask, and every message it can send is link-driven', () => {
    // Every transition of the model that can send is driven here: submit,
    // the trust step's confirm and decline, the plain offer's
    // confirm and decline, the review's own projection ask (a colliding
    // plan, through offerFrom) and a decision change on it (setDecision),
    // and retry. Cancel and the replies are driven to show they send
    // nothing. The set collected is held equal to the set the model
    // declares AND to the set its source spells in `send:` literals, so a
    // transition that grows a message, or a message that grows a path, fails
    // here by name.
    const sends = [];
    const record = (out) => { if (out.send) sends.push(out.send); return out; };
    let state = model.initial();
    assert.strictEqual(record(model.reply(state, { type: 'anything' })).send, undefined);
    const submitted = record(model.submit(state, 'someone/test-ext@v1'));
    assert.strictEqual(submitted.send.type, 'plan_package_install');
    const trusting = record(model.reply(submitted.state, {
      type: 'extension_install_plan', operation: 'plan', token: 'tok',
      manifest: { name: 'x', version: '1' }, facts: { agents: 0, skills: 0, files: [], match: 'm' },
    }));
    assert.strictEqual(trusting.send, undefined, 'arriving at the trust step asks for nothing');
    assert.strictEqual(record(model.confirm(trusting.state)).send.type, 'confirm_extension_install');
    assert.strictEqual(record(model.decline(trusting.state)).send.type, 'decline_package_install');
    const { plan, colliding } = withWorkspace((ws) => {
      const clean = buildPlan(ws, extensionSnapshot({ skills: 1, manifest: false }), { id: 'x', reference: null });
      fs.mkdirSync(path.join(ws, '.claude', 'skills', 'craft-0'), { recursive: true });
      fs.writeFileSync(path.join(ws, '.claude', 'skills', 'craft-0', 'SKILL.md'), 'already here\n');
      return { plan: clean, colliding: buildPlan(ws, extensionSnapshot({ skills: 1, manifest: false }), { id: 'x', reference: null }) };
    });
    const offered = record(model.reply(submitted.state, { type: 'package_import_plan', operation: 'plan', token: 'tok2', plan }));
    assert.strictEqual(offered.send, undefined, 'a collision-free offer asks for no projection');
    assert.strictEqual(record(model.confirm(offered.state)).send.type, 'confirm_package_install');
    assert.strictEqual(record(model.decline(offered.state)).send.type, 'decline_package_install');
    assert.ok(colliding.items.some((i) => i.collision), 'sanity: the second plan collides');
    const review = record(model.reply(submitted.state, { type: 'package_import_plan', operation: 'plan', token: 'tok3', plan: colliding }));
    assert.strictEqual(review.send.type, 'evaluate_package_decisions', 'a colliding plan asks the server to project the review');
    const decided = record(model.setDecision(review.state, colliding.items.find((i) => i.collision).id, 'overwrite'));
    assert.strictEqual(decided.send.type, 'evaluate_package_decisions', 'a decision change asks again');
    assert.strictEqual(record(model.confirm(decided.state)).send.type, 'confirm_package_install');
    assert.strictEqual(record(model.retry({ phase: 'failed', link: 'someone/test-ext', reference: '' })).send.type, 'plan_package_install');
    assert.strictEqual(record(model.cancel(offered.state)).send, undefined, 'cancel sends nothing');

    const walked = [...new Set(sends.map((m) => m.type))].sort();
    assert.deepStrictEqual(walked, [...model.OUTGOING].sort(), 'the whole outgoing set, from every sending transition, equals the set the model declares');
    const MODEL_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'packages-install-model.js'), 'utf8');
    const spelled = [...new Set([...MODEL_SRC.matchAll(/send: \{[\s\S]*?type: '([a-z_]+)'/g)].map((m) => m[1]))].sort();
    assert.deepStrictEqual(spelled, walked, 'every send literal in the model source was reached by this walk');
    for (const m of sends) {
      for (const key of Object.keys(m)) {
        assert.ok(!/path|dir|root|file/i.test(key), `${m.type} carries "${key}", which names a filesystem location; the client only ever sends the link`);
      }
      if (m.type === 'plan_package_install') assert.deepStrictEqual(Object.keys(m).sort(), ['type', 'url'], 'the link is the whole request; the server resolves the reference');
      if (/^(evaluate|confirm|decline)/.test(m.type)) assert.ok('token' in m, `${m.type} names the held snapshot by token`);
    }
    assert.deepStrictEqual(sends.filter((m) => m.type === 'plan_package_install').map((m) => m.url),
      ['someone/test-ext@v1', 'someone/test-ext'], 'the link alone travels, carrying its reference inside it or not at all');
    // Every packages action the view exposes reaches the socket through the
    // model: no onclick of the flow bypasses it (the trust card's back is
    // decline, through the model, like every other exit).
    for (const name of ['packagesSubmit', 'packagesCancel', 'packagesDecline', 'packagesConfirm', 'packagesRetry', 'packagesSetDecision']) {
      assert.match(SETTINGS_SRC, new RegExp(`function ${name}\\([^)]*\\) \\{[^}]*packagesApplyTransition\\(RundockPackagesInstallModel\\.`),
        `${name} passes through the model`);
    }
  });
});

describe('the dispatch table binds every install-flow message to the handler of that name', () => {
  test('each registered key is the very function packages.js exports for it, so a mis-pointed or undefined registration fails', () => {
    const table = buildDispatch();
    const bound = {
      plan_package_install: 'handlePlanPackageInstall',
      confirm_extension_install: 'handleConfirmExtensionInstall', confirm_package_install: 'handleConfirmPackageInstall',
      decline_package_install: 'handleDeclinePackageInstall',
      plan_package_uninstall: 'handlePlanPackageUninstall', confirm_package_uninstall: 'handleConfirmPackageUninstall',
      evaluate_package_decisions: 'handleEvaluatePackageDecisions',
    };
    for (const [type, name] of Object.entries(bound)) {
      assert.strictEqual(typeof handlers[name], 'function', `${name} is exported`);
      assert.strictEqual(table[type], handlers[name], `${type} is bound to ${name} by identity`);
    }
  });
});

describe('an offer of one kind answered through the other flow is refused by name, and nothing survives it', () => {
  function treeOf(root) {
    const out = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) walk(abs); else out.push(`${path.relative(root, abs)}:${fs.readFileSync(abs).toString('base64')}`);
      }
    };
    walk(root);
    return out;
  }

  test('a content offer confirmed as an extension, an extension offer confirmed as content, and an evaluate against an extension offer', () => {
    withWorkspace((ws) => {
      const content = extensionSnapshot({ skills: 1, manifest: false });
      const extension = extensionSnapshot();
      let next = content;
      const previousDeps = handlers.wireExtensionDeps({ acquire: () => next });
      try {
        // 1. Agents and skills, answered at the trust step that never opened.
        let sock = captureWs();
        handlers.handlePlanPackageInstall(ctx(), sock, { type: 'plan_package_install', url: 'someone/pack', reference: 'v1.0.0' });
        assert.strictEqual(sock.sent[0].type, 'package_import_plan');
        let before = treeOf(ws);
        handlers.handleConfirmExtensionInstall(ctx(), sock, { type: 'confirm_extension_install', token: sock.sent[0].token });
        assert.strictEqual(sock.sent[1].type, 'package_install_error');
        assert.match(sock.sent[1].message, /holds agents and skills, not an extension/);
        assert.deepStrictEqual(treeOf(ws), before, 'the workspace is byte-unchanged');
        assert.strictEqual(fs.existsSync(content), false, 'the acquired snapshot is discarded');
        handlers.handleConfirmPackageInstall(ctx(), sock, { type: 'confirm_package_install', token: sock.sent[0].token, approval: {} });
        assert.match(sock.sent[2].message, /nothing is awaiting this confirmation/, 'the token died with the refusal');

        // 2. An extension, answered as if it were agents and skills.
        next = extension;
        sock = captureWs();
        handlers.handlePlanPackageInstall(ctx(), sock, { type: 'plan_package_install', url: 'someone/test-ext', reference: 'v1.0.0' });
        assert.strictEqual(sock.sent[0].type, 'extension_install_plan');
        before = treeOf(ws);
        handlers.handleConfirmPackageInstall(ctx(), sock, { type: 'confirm_package_install', token: sock.sent[0].token, approval: {} });
        assert.strictEqual(sock.sent[1].type, 'package_install_error');
        assert.match(sock.sent[1].message, /holds an extension; answer it at its trust step/);
        assert.deepStrictEqual(treeOf(ws), before);
        assert.strictEqual(fs.existsSync(extension), false, 'the acquired snapshot is discarded');
        handlers.handleConfirmExtensionInstall(ctx(), sock, { type: 'confirm_extension_install', token: sock.sent[0].token });
        assert.match(sock.sent[2].message, /nothing is awaiting this confirmation/, 'the token died with the refusal');

        // 3. A projection asked of an extension offer: refused, and since a
        // projection consumes nothing, the offer still answers its decline.
        next = extensionSnapshot();
        sock = captureWs();
        handlers.handlePlanPackageInstall(ctx(), sock, { type: 'plan_package_install', url: 'someone/test-ext', reference: 'v1.0.0' });
        const token = sock.sent[0].token;
        before = treeOf(ws);
        handlers.handleEvaluatePackageDecisions(ctx(), sock, { type: 'evaluate_package_decisions', token, requestId: 'r', approval: {} });
        assert.deepStrictEqual([sock.sent[1].type, sock.sent[1].operation, sock.sent[1].token, sock.sent[1].requestId],
          ['package_import_error', 'evaluate', token, 'r']);
        assert.match(sock.sent[1].message, /holds an extension; answer it at its trust step/);
        assert.deepStrictEqual(treeOf(ws), before);
        assert.strictEqual(fs.existsSync(next), true, 'a projection consumes nothing: the snapshot is still held');
        handlers.handleDeclinePackageInstall(ctx(), sock, { type: 'decline_package_install', token });
        assert.strictEqual(sock.sent[2].type, 'package_install_declined', 'the offer still answers');
        assert.strictEqual(fs.existsSync(next), false, 'and the decline discards it');
      } finally {
        handlers.wireExtensionDeps(previousDeps);
      }
    });
  });
});

describe('the roster reads nothing from a manifest beyond what it declares', () => {
  test('a manifest carrying fields the contract does not name yields the same roster entry as one without them', () => {
    const entryFor = (extras) => withWorkspace((ws) => {
      const snap = extensionSnapshot();
      const manifest = JSON.parse(fs.readFileSync(path.join(snap, 'rundock.json'), 'utf8'));
      fs.writeFileSync(path.join(snap, 'rundock.json'), JSON.stringify({ ...manifest, ...extras }, null, 2));
      const previousDeps = handlers.wireExtensionDeps({ acquire: () => snap });
      try {
        const sock = captureWs();
        handlers.handlePlanPackageInstall(ctx(), sock, { type: 'plan_package_install', url: 'someone/test-ext', reference: 'v1.0.0' });
        handlers.handleConfirmExtensionInstall(ctx(), sock, { type: 'confirm_extension_install', token: sock.sent[0].token });
        assert.strictEqual(sock.sent[1].type, 'extension_install_result');
        const [entry] = listExtensions(ws);
        return { ...entry, installedAt: 'normalised' };
      } finally {
        handlers.wireExtensionDeps(previousDeps);
      }
    });
    const extras = { description: 'words', author: 'someone', homepage: 'https://example.com', permissions: ['network'], icon: 'x.svg' };
    const plain = entryFor({});
    const loaded = entryFor(extras);
    assert.deepStrictEqual(loaded, plain, 'unread manifest fields reach nothing the roster carries');
    const text = JSON.stringify(loaded);
    for (const key of Object.keys(extras)) assert.ok(!text.includes(key), `${key} leaks into the roster`);
  });
});


// A capture socket in the shape every handler test in this repository uses.
function captureWs() {
  return { readyState: 1, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); } };
}

// The handler context in the shape server.js builds it, carrying the two
// root-owned capabilities these handlers reach for: the file tree's cache is
// told when the extension records change, and the roster cache cascade is
// told when a content apply lands agent or skill files. Both inert here;
// the notification suite below hands in a counting tree cache, and the
// protocol suites pin the cascade.
function ctx() {
  return {
    workspace: { noteExtensionRecordsChanged() {} },
    agents: { invalidateAgentCache() {}, flagRosterRefresh() {} },
  };
}

// The same capture socket, plus the one real-socket method the pending-offer
// release touches: `.once('close', fn)`. Kept separate from captureWs()
// because every other test's socket has to stay exactly as bare as a fake
// needs to be, so a socket that quietly grew this method everywhere would
// stop proving the release only fires for a socket that actually offers it.
function closableWs() {
  const sock = captureWs();
  const closeHandlers = [];
  sock.once = (event, fn) => { if (event === 'close') closeHandlers.push(fn); };
  sock.dropConnection = () => { for (const fn of closeHandlers.splice(0)) fn(); };
  return sock;
}

function withWorkspace(fn) {
  const previous = config.getWorkspace();
  const ws = workspace();
  config.setWorkspace(ws);
  try { return fn(ws); } finally { config.setWorkspace(previous); }
}

describe('the module wires its real dependencies by default, not only the fakes the suite injects', () => {
  test('extensionDeps.acquire and .listRefs are acquireWithGit and listRefsWithGit by identity, before any override', () => {
    // wireExtensionDeps({}) merges nothing in and returns what extensionDeps
    // was before this call, so read here, before any other test in this file
    // has overridden it, this is the module's own default wiring rather than
    // a fake shaped like it. Restored immediately so no later test sees a
    // different object than the one it already expects.
    const defaults = handlers.wireExtensionDeps({});
    try {
      assert.strictEqual(REAL_DEPS.pinKindOf, acquiredPinKind,
        'what a reference was on the remote is read from the real acquirer\'s own record by default');
      assert.strictEqual(defaults.acquire, acquireWithGit,
        'the default acquirer must be the real acquireWithGit, checked by identity so a rename or '
        + 're-point of the default would fail this even if the shape still looked right');
      assert.strictEqual(defaults.listRefs, listRefsWithGit,
        'the default ref-lister must be the real listRefsWithGit, checked by identity for the same reason');
    } finally {
      handlers.wireExtensionDeps(defaults);
    }
  });
});

describe('consent order at the wire: plan, then one answer', () => {
  test('decline discards the acquired snapshot and the workspace is untouched', () => {
    withWorkspace((ws) => {
      const snap = extensionSnapshot();
      const previousDeps = handlers.wireExtensionDeps({ acquire: () => snap });
      try {
        const sock = captureWs();
        handlers.handlePlanPackageInstall(ctx(), sock, { type: 'plan_package_install', url: 'someone/test-ext', reference: 'v1.0.0' });
        const plan = sock.sent[0];
        assert.strictEqual(plan.type, 'extension_install_plan');
        assert.ok(fs.existsSync(snap), 'the snapshot waits between offer and answer');

        handlers.handleDeclinePackageInstall(ctx(), sock, { type: 'decline_package_install', token: plan.token });
        assert.strictEqual(sock.sent[1].type, 'package_install_declined');
        assert.strictEqual(fs.existsSync(snap), false, 'no is nothing left behind, the temporary snapshot included');
        assert.deepStrictEqual(fs.readdirSync(ws), [], 'and the workspace never changed');
      } finally {
        handlers.wireExtensionDeps(previousDeps);
      }
    });
  });

  test('an unpinned request is refused at the wire and acquires nothing', () => {
    withWorkspace(() => {
      let acquired = 0;
      const previousDeps = handlers.wireExtensionDeps({ acquire: () => { acquired += 1; return extensionSnapshot(); } });
      try {
        const sock = captureWs();
        handlers.handlePlanPackageInstall(ctx(), sock, { type: 'plan_package_install', url: 'someone/test-ext', reference: 'main' });
        assert.strictEqual(sock.sent[0].type, 'package_install_error');
        assert.strictEqual(sock.sent[0].code, 'unpinned-reference');
        assert.strictEqual(acquired, 0, 'refusal comes before any fetch');
      } finally {
        handlers.wireExtensionDeps(previousDeps);
      }
    });
  });

  test('an argv-shaped reference is refused at the wire and acquires nothing', () => {
    withWorkspace(() => {
      let acquired = 0;
      const previousDeps = handlers.wireExtensionDeps({ acquire: () => { acquired += 1; return extensionSnapshot(); } });
      try {
        const sock = captureWs();
        handlers.handlePlanPackageInstall(ctx(), sock, { type: 'plan_package_install', url: 'someone/test-ext', reference: '--upload-pack=evil' });
        assert.strictEqual(sock.sent[0].type, 'package_install_error');
        assert.strictEqual(sock.sent[0].code, 'unpinned-reference');
        assert.strictEqual(acquired, 0, 'refusal comes before any fetch, so nothing ever reaches a git argv');
      } finally {
        handlers.wireExtensionDeps(previousDeps);
      }
    });
  });
});

describe('an extension is never installed from a branch', () => {
  // A repository with a tag, a branch, and a tag and a branch that share one
  // name and point at different commits, so which of the two arrived is
  // visible in the bytes.
  function branchyRepo({ extension = true } = {}) {
    const repo = tempDir('ext-branchy-repo-');
    const git = (args) => String(execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })).trim();
    git(['init', '--quiet']);
    if (extension) {
      fs.mkdirSync(path.join(repo, 'view'));
      fs.writeFileSync(path.join(repo, 'view', 'index.html'), '<main>view</main>\n');
      fs.writeFileSync(path.join(repo, 'rundock.json'), JSON.stringify({ name: 'test-ext', version: '1.0.0', extension: { entry: 'view/index.html', match: '*.dataview.md' } }));
    }
    fs.writeFileSync(path.join(repo, 'marker.txt'), 'one\n');
    git(['add', '.']);
    git(['commit', '--quiet', '-m', 'one']);
    const one = git(['rev-parse', 'HEAD']);
    git(['tag', 'v1.0.0']);
    git(['tag', 'same']);
    fs.writeFileSync(path.join(repo, 'marker.txt'), 'two\n');
    git(['commit', '--quiet', '-am', 'two']);
    const two = git(['rev-parse', 'HEAD']);
    git(['branch', 'dev']);
    git(['branch', 'release']);
    git(['branch', 'same']);
    return { repo, one, two };
  }
  const marker = (dir) => fs.readFileSync(path.join(dir, 'marker.txt'), 'utf8').trim();

  test('the fetch records what a reference is on the remote: a tag, an exact commit, or neither', () => {
    const { repo, one, two } = branchyRepo();
    const cases = [
      ['v1.0.0', 'tag', 'one', one],
      ['refs/tags/v1.0.0', 'tag', 'one', one],
      [one, 'commit', 'one', one],
      ['dev', 'other', 'two', two],
      [null, 'other', 'two', two],
      // A tag and a branch spelled alike: the tag's bytes arrive, never the branch's.
      ['same', 'tag', 'one', one],
    ];
    for (const [reference, kind, bytes, commit] of cases) {
      const dir = acquireWithGit({ url: repo, reference });
      try {
        assert.strictEqual(acquiredPinKind(dir), kind, `${reference} fetched as ${kind}`);
        assert.strictEqual(marker(dir), bytes, `${reference} fetched the ${bytes} bytes`);
        assert.strictEqual(acquiredCommit(dir), commit);
      } finally {
        discardAcquisition(dir);
      }
      assert.strictEqual(acquiredPinKind(dir), null, 'discarding forgets the record with the bytes');
    }
  });

  test('only a tag or an exact commit passes, and everything else is refused with the plain reason', () => {
    const source = { url: SOURCE.url, reference: 'dev' };
    assert.strictEqual(requireFixedPin(source, 'tag'), source);
    assert.strictEqual(requireFixedPin(source, 'commit'), source);
    for (const kind of ['other', null, undefined, 'branch', 'TAG']) {
      assert.throws(() => requireFixedPin(source, kind),
        (e) => e.code === 'unpinned-reference'
          && /"dev" is not a tag or a commit/.test(e.message)
          && /never installed from a branch; use a tag or an exact commit/.test(e.message),
        String(kind));
    }
  });

  test('a well-known branch name says the same thing before anything is fetched', () => {
    assert.throws(() => parseGitHubSource('someone/test-ext@main', ''),
      (e) => e.code === 'unpinned-reference' && /"main" is a branch, and an extension is never installed from a branch; use a tag or an exact commit/.test(e.message));
  });

  test('through the real fetch, a branch link is refused and leaves nothing behind; a tag and a commit reach the trust step', () => {
    withWorkspace((ws) => {
      const { repo, one } = branchyRepo();
      const previousDeps = handlers.wireExtensionDeps({
        acquire: (source) => acquireWithGit({ ...source, url: repo }),
        commitOf: acquiredCommit,
        pinKindOf: acquiredPinKind,
      });
      const fetched = () => new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('rundock-ext-')));
      try {
        const before = fetched();
        for (const reference of ['dev', 'release']) {
          const sock = captureWs();
          handlers.handlePlanPackageInstall(ctx(), sock, { type: 'plan_package_install', url: `someone/test-ext@${reference}` });
          assert.strictEqual(sock.sent.length, 1, reference);
          assert.strictEqual(sock.sent[0].type, 'package_install_error', reference);
          assert.strictEqual(sock.sent[0].code, 'unpinned-reference', reference);
          assert.match(sock.sent[0].message, /use a tag or an exact commit/);
        }
        assert.deepStrictEqual([...fetched()].filter((n) => !before.has(n)), [], 'the branch bytes were discarded');
        assert.deepStrictEqual(fs.readdirSync(ws), [], 'and the workspace is untouched');

        const tagged = captureWs();
        handlers.handlePlanPackageInstall(ctx(), tagged, { type: 'plan_package_install', url: 'someone/test-ext@v1.0.0' });
        assert.strictEqual(tagged.sent[0].type, 'extension_install_plan');
        assert.strictEqual(tagged.sent[0].source.reference, 'v1.0.0');
        assert.strictEqual(tagged.sent[0].source.commit, one, 'the tag carries the commit it resolved to');

        const exact = captureWs();
        handlers.handlePlanPackageInstall(ctx(), exact, { type: 'plan_package_install', url: `someone/test-ext@${one}` });
        assert.strictEqual(exact.sent[0].type, 'extension_install_plan');
        assert.strictEqual(exact.sent[0].source.reference, one);
      } finally {
        handlers.wireExtensionDeps(previousDeps);
      }
    });
  });


  test('agents and skills are files, not code, so a content package is still read at a branch', () => {
    withWorkspace(() => {
      const previousDeps = handlers.wireExtensionDeps({ acquire: () => extensionSnapshot({ manifest: false, agents: 1 }), pinKindOf: () => 'other' });
      try {
        const sock = captureWs();
        handlers.handlePlanPackageInstall(ctx(), sock, { type: 'plan_package_install', url: 'someone/test-ext@dev' });
        assert.strictEqual(sock.sent[0].type, 'package_import_plan');
      } finally {
        handlers.wireExtensionDeps(previousDeps);
      }
    });
  });
});

describe('the pin is derived from the link, never typed: each outcome at the wire', () => {
  // The "latest" rule itself, held to its own claims before the wire drives
  // it: version order over the tags the ordering can read, a stated
  // tie-break, and a named refusal wherever a claim about order cannot be
  // made.
  test('latestTag picks by version order, not first-listed and not lexicographic, and ignores what it cannot order', () => {
    assert.strictEqual(latestTag(['v2.0.0', 'v10.0.0', 'nightly', 'v9.0.0']), 'v10.0.0',
      'v2.0.0 is first in the listing and v9.0.0 is the lexicographic maximum; neither is latest');
    assert.strictEqual(latestTag(['1.2.3', 'v1.2.3']), 'v1.2.3', 'equal versions tie-break bytewise');
    assert.strictEqual(latestTag(['v1.2.3', '1.2.3']), 'v1.2.3', 'in either listing order');
    assert.throws(() => latestTag([]), (e) => e.code === 'no-tags' && /publishes no tags/.test(e.message));
    assert.throws(() => latestTag(['nightly', 'release-2020']),
      (e) => e.code === 'unorderable-tags' && /no latest to pin to/.test(e.message),
      'tags that exist but cannot be ordered are their own refusal, never a guess at latest');
    assert.throws(() => latestTag('v1.0.0'), /must return an array/);
  });

  test('a link that names its reference is acquired at exactly that reference, with the ref lister never asked', () => {
    withWorkspace(() => {
      const acquiredAt = [];
      let listed = 0;
      const previousDeps = handlers.wireExtensionDeps({
        acquire: (source) => { acquiredAt.push(source.reference); return extensionSnapshot(); },
        listRefs: () => { listed += 1; return ['v9.9.9']; },
      });
      try {
        const sock = captureWs();
        handlers.handlePlanPackageInstall(ctx(), sock, {
          type: 'plan_package_install', url: 'https://github.com/someone/test-ext/releases/tag/v1.0.1',
        });
        assert.strictEqual(sock.sent[0].type, 'extension_install_plan');
        assert.strictEqual(sock.sent[0].source.reference, 'v1.0.1', 'the plan is pinned to what the link named');
        assert.deepStrictEqual(acquiredAt, ['v1.0.1'], 'one fetch, at the named reference');
        assert.strictEqual(listed, 0, 'a link that supplies its reference asks the remote nothing else');
      } finally {
        handlers.wireExtensionDeps(previousDeps);
      }
    });
  });

  test('a link naming no reference is resolved to the latest tag: classified at the head, then acquired again at the resolved pin', () => {
    withWorkspace(() => {
      const acquiredAt = [];
      const snaps = [];
      const listedFor = [];
      const previousDeps = handlers.wireExtensionDeps({
        acquire: (source) => { acquiredAt.push(source.reference); const snap = extensionSnapshot(); snaps.push(snap); return snap; },
        listRefs: (url) => { listedFor.push(url); return ['v2.0.0', 'v10.0.0', 'nightly', 'v9.0.0']; },
      });
      try {
        const sock = captureWs();
        handlers.handlePlanPackageInstall(ctx(), sock, { type: 'plan_package_install', url: 'someone/test-ext' });
        assert.strictEqual(sock.sent[0].type, 'extension_install_plan');
        assert.strictEqual(sock.sent[0].source.reference, 'v10.0.0',
          'the derived pin is the newest tag by version order, not the first listed or the lexicographic maximum');
        assert.deepStrictEqual(acquiredAt, [null, 'v10.0.0'],
          'the head was read only to classify; the bytes offered are the resolved tag\'s own');
        assert.strictEqual(fs.existsSync(snaps[0]), false, 'the classification read is discarded once the pin is resolved');
        assert.strictEqual(fs.existsSync(snaps[1]), true, 'the resolved tag\'s snapshot waits for the answer');
        assert.deepStrictEqual(listedFor, ['https://github.com/someone/test-ext'],
          'the lister is asked about the canonical url, once');
      } finally {
        handlers.wireExtensionDeps(previousDeps);
      }
    });
  });

  test('a repository with no version tags installs the exact commit fetched: one fetch, pinned to it, recorded, and never offered an update', () => {
    const { checkPackageUpdate } = require('../../lib/packages/package-check.js');
    const FETCHED = 'e'.repeat(40);
    // No tags at all, and tags that exist but are not versions, are the same
    // case: neither has a release an update could come after.
    for (const listing of [[], ['nightly', 'release-2020']]) {
      withWorkspace((ws) => {
        const acquiredAt = [];
        const snaps = [];
        const previousDeps = handlers.wireExtensionDeps({
          acquire: (source) => { acquiredAt.push(source.reference); const snap = extensionSnapshot(); snaps.push(snap); return snap; },
          listRefs: () => listing,
          commitOf: () => FETCHED,
          pinKindOf: () => 'other',
        });
        try {
          const sock = captureWs();
          handlers.handlePlanPackageInstall(ctx(), sock, { type: 'plan_package_install', url: 'someone/test-ext' });
          assert.strictEqual(sock.sent.length, 1, String(listing));
          assert.strictEqual(sock.sent[0].type, 'extension_install_plan', `offered, not refused, for tags ${JSON.stringify(listing)}`);
          assert.strictEqual(sock.sent[0].source.reference, FETCHED, 'pinned to the commit that was fetched');
          assert.strictEqual(sock.sent[0].source.commit, FETCHED);
          assert.deepStrictEqual(acquiredAt, [null], 'the head read is the snapshot offered: nothing is fetched twice');
          assert.strictEqual(fs.existsSync(snaps[0]), true, 'and it waits for the answer');

          handlers.handleConfirmExtensionInstall(ctx(), sock, { type: 'confirm_extension_install', token: sock.sent[0].token });
          assert.strictEqual(sock.sent[1].type, 'extension_install_result');
          const [record] = readExtensionRecords(ws);
          assert.strictEqual(record.source.reference, FETCHED, 'the record names the commit');
          assert.strictEqual(record.source.commit, FETCHED);
          const check = checkPackageUpdate(
            { id: record.source.url, updatable: true, reference: record.source.reference, commit: record.source.commit },
            [{ name: 'v9.0.0', commit: 'f'.repeat(40) }],
          );
          assert.strictEqual(check.outcome, 'no-release', 'a commit-pinned install is never offered an update, whatever tags appear later');
        } finally {
          handlers.wireExtensionDeps(previousDeps);
        }
      });
    }
  });

  test('a tagless extension whose fetched commit cannot be read is refused by name, and the read is discarded', () => {
    withWorkspace((ws) => {
      let snap = null;
      const previousDeps = handlers.wireExtensionDeps({
        acquire: () => { snap = extensionSnapshot(); return snap; },
        listRefs: () => [],
        commitOf: () => null,
      });
      try {
        const sock = captureWs();
        handlers.handlePlanPackageInstall(ctx(), sock, { type: 'plan_package_install', url: 'someone/test-ext' });
        assert.strictEqual(sock.sent.length, 1, 'one refusal answers the plan');
        assert.strictEqual(sock.sent[0].type, 'package_install_error');
        assert.strictEqual(sock.sent[0].code, 'no-tags');
        assert.match(sock.sent[0].message, /no version tags/);
        assert.strictEqual(fs.existsSync(snap), false, 'the read is discarded, not installed');
        assert.deepStrictEqual(fs.readdirSync(ws), [], 'and the workspace is untouched');
      } finally {
        handlers.wireExtensionDeps(previousDeps);
      }
    });
  });

  test('through the real fetch, an extension repository with no tags is offered at its head commit', () => {
    withWorkspace(() => {
      const repo = tempDir('ext-tagless-repo-');
      const git = (args) => String(execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })).trim();
      git(['init', '--quiet']);
      fs.mkdirSync(path.join(repo, 'view'));
      fs.writeFileSync(path.join(repo, 'view', 'index.html'), '<main>view</main>\n');
      fs.writeFileSync(path.join(repo, 'rundock.json'), JSON.stringify({ name: 'test-ext', version: '1.0.0', extension: { entry: 'view/index.html', match: '*.dataview.md' } }));
      git(['add', '.']);
      git(['commit', '--quiet', '-m', 'one']);
      const head = git(['rev-parse', 'HEAD']);
      const previousDeps = handlers.wireExtensionDeps({
        acquire: (source) => acquireWithGit({ ...source, url: repo }),
        listRefs: () => listRefsWithGit(repo),
        commitOf: acquiredCommit,
        pinKindOf: acquiredPinKind,
      });
      try {
        const sock = captureWs();
        handlers.handlePlanPackageInstall(ctx(), sock, { type: 'plan_package_install', url: 'someone/test-ext' });
        assert.strictEqual(sock.sent[0].type, 'extension_install_plan');
        assert.strictEqual(sock.sent[0].source.reference, head);
        assert.strictEqual(sock.sent[0].source.commit, head);
        handlers.handleDeclinePackageInstall(ctx(), sock, { type: 'decline_package_install', token: sock.sent[0].token });
      } finally {
        handlers.wireExtensionDeps(previousDeps);
      }
    });
  });

  test('a moving branch name in the link is refused before anything is fetched, exactly as the typed spelling always was', () => {
    withWorkspace(() => {
      let acquired = 0;
      const previousDeps = handlers.wireExtensionDeps({ acquire: () => { acquired += 1; return extensionSnapshot(); } });
      try {
        for (const url of ['someone/test-ext@main', 'https://github.com/someone/test-ext/tree/main']) {
          const sock = captureWs();
          handlers.handlePlanPackageInstall(ctx(), sock, { type: 'plan_package_install', url });
          assert.strictEqual(sock.sent[0].type, 'package_install_error', url);
          assert.strictEqual(sock.sent[0].code, 'unpinned-reference', url);
        }
        assert.strictEqual(acquired, 0, 'refusal comes before any fetch');
      } finally {
        handlers.wireExtensionDeps(previousDeps);
      }
    });
  });
});

describe('a failure between acquire and offer discards the snapshot and issues no token', () => {
  test('a real acquire-failed from the acquirer is answered as one error, and nothing it created survives', () => {
    withWorkspace(() => {
      // A real repository, reached with no network, pinned at a reference
      // that does not exist: acquireWithGit itself refuses with code
      // 'acquire-failed', exactly the failure beginPackagePlan's try block
      // has never been driven through before.
      const repo = tempDir('ext-acquire-fail-repo-');
      const git = (args) => execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
      git(['init', '--quiet']);
      git(['config', 'user.email', 'test@example.com']);
      git(['config', 'user.name', 'Test']);
      fs.writeFileSync(path.join(repo, 'marker.txt'), 'x\n');
      git(['add', '.']);
      git(['commit', '--quiet', '-m', 'first']);
      git(['tag', 'v1.0.0']);

      const before = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('rundock-ext-')));
      const previousDeps = handlers.wireExtensionDeps({
        acquire: () => acquireWithGit({ url: repo, reference: 'v9.9.9-does-not-exist' }),
      });
      try {
        const sock = captureWs();
        handlers.handlePlanPackageInstall(ctx(), sock, { type: 'plan_package_install', url: 'someone/test-ext', reference: 'v1.0.0' });
        assert.strictEqual(sock.sent.length, 1, 'exactly one reply answers the failed plan');
        assert.strictEqual(sock.sent[0].type, 'package_install_error');
        assert.strictEqual(sock.sent[0].code, 'acquire-failed');

        const after = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('rundock-ext-')));
        assert.deepStrictEqual([...after].filter((n) => !before.has(n)), [],
          'nothing the failed acquisition created survives it');

        handlers.handleConfirmExtensionInstall(ctx(), sock, { type: 'confirm_extension_install', token: 'ext-never-issued' });
        assert.strictEqual(sock.sent[1].type, 'package_install_error',
          'a plan that never reached the offer issued no token; any confirm answers a refusal');
        assert.match(sock.sent[1].message, /nothing is awaiting this confirmation/);
      } finally {
        handlers.wireExtensionDeps(previousDeps);
      }
    });
  });

  test('a fetched snapshot with neither a manifest nor content is answered as one empty-package error, and the snapshot is deleted', () => {
    withWorkspace(() => {
      const snap = tempDir('ext-no-manifest-');
      const previousDeps = handlers.wireExtensionDeps({ acquire: () => snap });
      try {
        const sock = captureWs();
        handlers.handlePlanPackageInstall(ctx(), sock, { type: 'plan_package_install', url: 'someone/test-ext', reference: 'v1.0.0' });
        assert.strictEqual(sock.sent.length, 1, 'exactly one reply answers the failed plan');
        assert.strictEqual(sock.sent[0].type, 'package_install_error');
        assert.strictEqual(sock.sent[0].code, 'empty-package');
        assert.strictEqual(fs.existsSync(snap), false,
          'the acquired snapshot is discarded when planning it fails, exactly as a decline discards it');

        handlers.handleConfirmExtensionInstall(ctx(), sock, { type: 'confirm_extension_install', token: 'pkg-never-issued' });
        assert.strictEqual(sock.sent[1].type, 'package_install_error',
          'a plan that never reached the offer issued no token; any confirm answers a refusal');
        assert.match(sock.sent[1].message, /nothing is awaiting this confirmation/);
      } finally {
        handlers.wireExtensionDeps(previousDeps);
      }
    });
  });
});

describe('the token dies with its use, and an unanswered offer does not live forever', () => {
  test('a confirm carrying a token that was never issued installs nothing and answers an error', () => {
    withWorkspace((ws) => {
      const sock = captureWs();
      handlers.handleConfirmExtensionInstall(ctx(), sock, { type: 'confirm_extension_install', token: 'ext-never-issued' });
      assert.strictEqual(sock.sent[0].type, 'package_install_error');
      assert.match(sock.sent[0].message, /nothing is awaiting this confirmation/);
      assert.strictEqual(fs.existsSync(path.join(ws, ...RECORDS_PATH.split('/'))), false,
        'no records file was written for a confirmation nothing was awaiting');
      assert.strictEqual(fs.existsSync(path.join(ws, ...EXTENSIONS_ROOT.split('/'))), false,
        'no extensions root was created either');
    });
  });

  test('confirming the same token twice installs exactly once; the second confirm answers an error and writes nothing further', () => {
    withWorkspace((ws) => {
      const snap = extensionSnapshot();
      const previousDeps = handlers.wireExtensionDeps({ acquire: () => snap });
      try {
        const sock = captureWs();
        handlers.handlePlanPackageInstall(ctx(), sock, { type: 'plan_package_install', url: 'someone/test-ext', reference: 'v1.0.0' });
        const token = sock.sent[0].token;
        handlers.handleConfirmExtensionInstall(ctx(), sock, { type: 'confirm_extension_install', token });
        assert.strictEqual(sock.sent[1].type, 'extension_install_result');
        const afterFirst = fs.statSync(path.join(ws, ...EXTENSIONS_ROOT.split('/'), 'test-ext', 'view', 'index.html')).mtimeMs;

        handlers.handleConfirmExtensionInstall(ctx(), sock, { type: 'confirm_extension_install', token });
        assert.strictEqual(sock.sent[2].type, 'package_install_error',
          'the same token answered twice must not install a second time');
        assert.match(sock.sent[2].message, /nothing is awaiting this confirmation/);

        assert.strictEqual(readExtensionRecords(ws).length, 1, 'still exactly one record, not two');
        const afterSecond = fs.statSync(path.join(ws, ...EXTENSIONS_ROOT.split('/'), 'test-ext', 'view', 'index.html')).mtimeMs;
        assert.strictEqual(afterSecond, afterFirst,
          'the installed directory was not re-materialised by the second, refused confirm');
      } finally {
        handlers.wireExtensionDeps(previousDeps);
      }
    });
  });

  test('a dropped connection releases the pending offer: its snapshot is discarded and its token stops working', () => {
    withWorkspace(() => {
      const snap = extensionSnapshot();
      const previousDeps = handlers.wireExtensionDeps({ acquire: () => snap });
      try {
        const sock = closableWs();
        handlers.handlePlanPackageInstall(ctx(), sock, { type: 'plan_package_install', url: 'someone/test-ext', reference: 'v1.0.0' });
        const token = sock.sent[0].token;
        assert.ok(fs.existsSync(snap), 'sanity: the snapshot is waiting between offer and answer');

        sock.dropConnection();
        assert.strictEqual(fs.existsSync(snap), false, 'the connection dropped and the fetched snapshot was left behind');

        handlers.handleConfirmExtensionInstall(ctx(), sock, { type: 'confirm_extension_install', token });
        assert.strictEqual(sock.sent[1].type, 'package_install_error',
          'the token a dropped connection was holding must not still be answerable');
      } finally {
        handlers.wireExtensionDeps(previousDeps);
      }
    });
  });

  test('a second unanswered plan from the same connection supersedes the first', () => {
    withWorkspace(() => {
      const first = extensionSnapshot({ name: 'first-ext' });
      const second = extensionSnapshot({ name: 'second-ext' });
      let calls = 0;
      const previousDeps = handlers.wireExtensionDeps({ acquire: () => (calls++ === 0 ? first : second) });
      try {
        const sock = captureWs();
        handlers.handlePlanPackageInstall(ctx(), sock, { type: 'plan_package_install', url: 'someone/first-ext', reference: 'v1.0.0' });
        const firstToken = sock.sent[0].token;
        assert.ok(fs.existsSync(first), 'sanity: the first offer is waiting');

        handlers.handlePlanPackageInstall(ctx(), sock, { type: 'plan_package_install', url: 'someone/second-ext', reference: 'v1.0.0' });
        assert.strictEqual(fs.existsSync(first), false,
          'reading a second package on the same connection abandoned the first, unanswered offer');
        assert.ok(fs.existsSync(second), 'the second offer is the one now waiting');

        handlers.handleConfirmExtensionInstall(ctx(), sock, { type: 'confirm_extension_install', token: firstToken });
        assert.strictEqual(sock.sent[2].type, 'package_install_error',
          'the superseded token must not still confirm');
      } finally {
        handlers.wireExtensionDeps(previousDeps);
      }
    });
  });
});

describe('install, the record, and the update check that reads it', () => {
  test('confirm installs the files and the record as one transaction', () => {
    withWorkspace((ws) => {
      const snap = extensionSnapshot();
      const previousDeps = handlers.wireExtensionDeps({ acquire: () => snap });
      try {
        const sock = captureWs();
        handlers.handlePlanPackageInstall(ctx(), sock, { type: 'plan_package_install', url: 'someone/test-ext', reference: 'v1.0.0' });
        handlers.handleConfirmExtensionInstall(ctx(), sock, { type: 'confirm_extension_install', token: sock.sent[0].token });
        const result = sock.sent[1];
        assert.strictEqual(result.type, 'extension_install_result');

        const records = readExtensionRecords(ws);
        assert.strictEqual(records.length, 1);
        assert.strictEqual(records[0].source.url, 'https://github.com/someone/test-ext',
          'the record carries the source URL, so no update ever asks for it again');
        assert.strictEqual(records[0].source.reference, 'v1.0.0', 'and the exact pin');
        assert.ok(fs.existsSync(path.join(ws, '.rundock', 'extensions', 'test-ext', 'view', 'index.html')),
          'the extension files landed under the Rundock-owned root');

        const installCalls = unitCalls.filter((c) => c.dirs.length > 0);
        assert.strictEqual(installCalls.length, 1, 'one transaction carried the install');
        assert.deepStrictEqual(installCalls[0], {
          files: [RECORDS_PATH],
          dirs: ['.rundock/extensions/test-ext'],
        }, 'and it carried the record and the files together, so neither can exist without the other');

        assert.strictEqual(fs.existsSync(snap), false, 'the snapshot is discarded once its bytes have landed');
      } finally {
        handlers.wireExtensionDeps(previousDeps);
      }
    });
  });







});



describe('a roster read that fails while the reply is built neither lies about the install nor leaves a token behind', () => {
  test('a throw from the roster read after a successful install reports the install as done, names the roster error, and leaves no token pointing at a discarded snapshot', () => {
    withWorkspace((ws) => {
      const snap = extensionSnapshot({ skills: 1 });
      const previousDeps = handlers.wireExtensionDeps({ acquire: () => snap });
      const recordsPath = path.join(ws, ...RECORDS_PATH.split('/'));
      try {
        const sock = captureWs();
        handlers.handlePlanPackageInstall(ctx(), sock, { type: 'plan_package_install', url: 'someone/test-ext', reference: 'v1.0.0' });
        const plan = sock.sent[0];
        assert.strictEqual(plan.type, 'extension_install_plan');
        // The seam: the confirm handler notifies the file tree between the
        // install transaction and the roster read its reply carries. A
        // context that corrupts the records file there makes the roster
        // read throw after the install itself has fully succeeded.
        const sabotage = { workspace: { noteExtensionRecordsChanged() { fs.writeFileSync(recordsPath, 'not json'); } } };
        handlers.handleConfirmExtensionInstall(sabotage, sock, { type: 'confirm_extension_install', token: plan.token });
        const result = sock.sent[1];
        assert.strictEqual(result.type, 'extension_install_result',
          'the record is on disk, so the reply says done; a failure report would invite re-running an install that already happened');
        assert.strictEqual(result.record.name, 'test-ext');
        assert.match(String(result.rosterError), /records unreadable/, 'the reply names the roster error');
        assert.strictEqual(result.content, null,
          'no content offer opens: its token would outlive the snapshot this path discards');
        assert.strictEqual(result.extensions, null,
          'no roster rides the reply; the client reads a missing roster as nothing to reconcile, never a roster of none');
        assert.strictEqual(fs.existsSync(snap), false, 'the snapshot is discarded');
        assert.ok(fs.existsSync(path.join(ws, ...EXTENSIONS_ROOT.split('/'), 'test-ext', 'view', 'index.html')),
          'sanity: the extension files landed before the roster read failed');

        // No token survives pointing at the discarded snapshot. The token
        // the content offer would have taken is the next one the counter
        // issues; a confirm against it must answer "nothing is awaiting",
        // never reach an apply over bytes that are gone.
        const n = Number(/^pkg-(\d+)$/.exec(plan.token)[1]);
        const probe = captureWs();
        handlers.handleConfirmPackageInstall(ctx(), probe, { type: 'confirm_package_install', token: `pkg-${n + 1}`, approval: {}, requestId: 'probe' });
        assert.strictEqual(probe.sent[0].type, 'package_install_error');
        assert.match(probe.sent[0].message, /nothing is awaiting this confirmation/,
          'no pending entry survives under the token the content offer would have taken');
      } finally {
        handlers.wireExtensionDeps(previousDeps);
      }
    });
  });
});

describe('consent binds to the workspace it was shown against', () => {
  test('a confirm answered after the server workspace changed installs nothing and refuses by name', () => {
    const workspaceA = workspace();
    const workspaceB = workspace();
    const previousWorkspace = config.getWorkspace();
    config.setWorkspace(workspaceA);
    const snap = extensionSnapshot();
    const previousDeps = handlers.wireExtensionDeps({ acquire: () => snap });
    try {
      const sock = captureWs();
      handlers.handlePlanPackageInstall(ctx(), sock, { type: 'plan_package_install', url: 'someone/test-ext', reference: 'v1.0.0' });
      const token = sock.sent[0].token;
      assert.ok(fs.existsSync(snap), 'sanity: the offer is waiting between offer and answer');

      // Another window moves the server's served workspace before this
      // window answers. The facts this window read, including whether the
      // install replaces anything, were true of workspace A alone.
      config.setWorkspace(workspaceB);
      handlers.handleConfirmExtensionInstall(ctx(), sock, { type: 'confirm_extension_install', token });

      assert.strictEqual(sock.sent[1].type, 'package_install_error');
      assert.strictEqual(sock.sent[1].code, 'workspace-changed');
      assert.match(sock.sent[1].message, /the workspace changed/);
      assert.strictEqual(fs.existsSync(snap), false, 'the abandoned snapshot is discarded, not installed');
      assert.deepStrictEqual(readExtensionRecords(workspaceA), [],
        'workspace A, where the trust step was shown, was never written to');
      assert.deepStrictEqual(readExtensionRecords(workspaceB), [],
        'workspace B, current at confirm time, was never written to either');

      handlers.handleConfirmExtensionInstall(ctx(), sock, { type: 'confirm_extension_install', token });
      assert.strictEqual(sock.sent[2].type, 'package_install_error',
        'the token died with its refused use, the same as any other confirm');
    } finally {
      handlers.wireExtensionDeps(previousDeps);
      config.setWorkspace(previousWorkspace);
    }
  });
});

// The receipt records the approval's source, and the update check reads the
// receipt, so an approval that comes back naming another reference or commit
// than the offer did would be written down as what was installed. The
// confirm holds it to the offer the server made.
describe('consent binds to the source it was offered', () => {
  const OFFERED_COMMIT = 'c'.repeat(40);
  const { decide } = require('../../lib/packages/import-plan.js');
  const treeOf = (root) => {
    const out = {};
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else out[path.relative(root, full)] = fs.readFileSync(full, 'utf8');
      }
    };
    walk(root);
    return out;
  };
  // Plan a content package at v1.0.0, answer it with the approval the
  // offer's own plan decides to, altered as each case says.
  function answer(alter) {
    return withWorkspace((ws) => {
      const snap = extensionSnapshot({ agents: 1, skills: 1, manifest: false });
      const previousDeps = handlers.wireExtensionDeps({ acquire: () => snap, listRefs: () => [], commitOf: () => OFFERED_COMMIT });
      try {
        const sock = captureWs();
        handlers.handlePlanPackageInstall(ctx(), sock, { type: 'plan_package_install', url: 'someone/test-ext', reference: 'v1.0.0' });
        assert.strictEqual(sock.sent[0].type, 'package_import_plan');
        const { plan, token } = sock.sent[0];
        const approval = decide(plan, Object.fromEntries(plan.items.map((i) => [i.id, 'add'])));
        approval.source = alter({ ...approval.source });
        const before = treeOf(ws);
        handlers.handleConfirmPackageInstall(ctx(), sock, { type: 'confirm_package_install', token, approval });
        return { ws, reply: sock.sent[1], before, after: treeOf(ws), snap };
      } finally {
        handlers.wireExtensionDeps(previousDeps);
      }
    });
  }

  for (const [label, alter] of [
    ['an altered reference', (s) => ({ ...s, reference: 'v0.0.1' })],
    ['an altered commit', (s) => ({ ...s, commit: 'e'.repeat(40) })],
    ['an altered id', (s) => ({ ...s, id: 'https://github.com/someone/other-ext' })],
    ['an added field', (s) => ({ ...s, note: 'x' })],
  ]) {
    test(`${label} is refused and nothing is written`, () => {
      const { reply, before, after, snap } = answer(alter);
      assert.strictEqual(reply.type, 'package_install_error');
      assert.strictEqual(reply.code, 'stale');
      assert.match(reply.message, /a different source than this offer/);
      assert.deepStrictEqual(after, before, 'the workspace is byte-for-byte as it was');
      assert.strictEqual(fs.existsSync(snap), false, 'the snapshot is discarded');
    });
  }

  test('an unaltered approval applies, and the receipt names the offered source', () => {
    const { ws, reply } = answer((s) => s);
    assert.strictEqual(reply.type, 'package_import_result');
    assert.strictEqual(reply.status, 'ready');
    const receipt = JSON.parse(fs.readFileSync(path.join(ws, reply.receipt), 'utf8'));
    assert.deepStrictEqual(receipt.source, { id: 'https://github.com/someone/test-ext', reference: 'v1.0.0', commit: OFFERED_COMMIT });
  });
});

describe('repositories never built for Rundock keep the inference path', () => {
  test('a package with an extension offers only its agents and skills through inference', () => {
    withWorkspace((ws) => {
      const snap = extensionSnapshot({ agents: 1, skills: 1 });
      const plan = buildPlan(ws, snap, { id: 'test', reference: null });
      assert.deepStrictEqual(plan.items.map((i) => i.kind).sort(), ['agent', 'skill'],
        'the extension is never inferred: an entry point and a match rule are claims, not facts');
      assert.ok(plan.items.every((i) => !i.destination.includes('rundock/extensions')),
        'no inferred item lands where extensions live');
    });
  });
});

describe('the records reader refuses a malformed record by name', () => {
  // A records file can arrive with a shared or copied workspace carrying
  // anything; a record missing a field is refused whole, never half-read.
  test('a record with no root is refused, and every read after it is refused too', () => {
    withWorkspace((ws) => {
      const snap = extensionSnapshot();
      installExtension(ws, snap, planExtensionInstall(ws, snap, SOURCE));
      const records = readExtensionRecords(ws);
      delete records[0].root;
      fs.writeFileSync(path.join(ws, ...RECORDS_PATH.split('/')), serialiseRecords(records));
      assert.throws(() => readExtensionRecords(ws), (e) => e.code === 'invalid-record' && /has no root/.test(e.message));
    });
  });
});

describe('an update reopens the flow and replaces through the same transaction', () => {
  // A package update lands its extension through this same install over the
  // existing record, so turning an extension off must survive it: an update
  // that re-enabled it would widen the original consent after the fact.
  test('installing a newer version over a disabled extension leaves it disabled, on the record and on the roster', () => {
    withWorkspace((ws) => {
      const v1 = extensionSnapshot();
      installExtension(ws, v1, planExtensionInstall(ws, v1, SOURCE));
      require('../../lib/packages/extension-manage.js').setExtensionEnabled(ws, 'test-ext', false);
      const v2 = extensionSnapshot({ version: '2.0.0' });
      const record = installExtension(ws, v2, planExtensionInstall(ws, v2, { ...SOURCE, reference: 'v2.0.0' }));
      assert.strictEqual(readExtensionRecords(ws)[0].version, '2.0.0', 'sanity: the update landed');
      assert.strictEqual(record.enabled, false);
      assert.strictEqual(readExtensionRecords(ws)[0].enabled, false);
      assert.strictEqual(listExtensions(ws)[0].enabled, false, 'the roster still reports it disabled');
    });
  });

  test('installing a newer pin over an install replaces the files and the record', () => {
    withWorkspace((ws) => {
      const v1 = extensionSnapshot();
      installExtension(ws, v1, planExtensionInstall(ws, v1, SOURCE));

      const v2 = extensionSnapshot({ version: '2.0.0' });
      fs.writeFileSync(path.join(v2, 'view', 'extra.js'), 'export {};\n');
      const plan = planExtensionInstall(ws, v2, { url: SOURCE.url, reference: 'v2.0.0' });
      assert.deepStrictEqual(plan.replaces, { version: '1.0.0', reference: 'v1.0.0', url: SOURCE.url, sameSource: true },
        'the trust step can say what this replaces');
      installExtension(ws, v2, plan);

      const records = readExtensionRecords(ws);
      assert.strictEqual(records.length, 1, 'an update is a replacement, never a second entry');
      assert.strictEqual(records[0].version, '2.0.0');
      assert.strictEqual(records[0].source.reference, 'v2.0.0');
      assert.ok(fs.existsSync(path.join(ws, '.rundock', 'extensions', 'test-ext', 'view', 'extra.js')));
    });
  });
});

describe('the model transitions are driven by real replies, not by literals that merely copy their shape', () => {
  const acquiring = () => model.submit(model.initial(), 'someone/test-ext@v1.0.0').state;

  test('reply from classifying on a real error reply reaches failed, in the producer\'s words', () => {
    withWorkspace(() => {
      const sock = captureWs();
      handlers.handlePlanPackageInstall(ctx(), sock, { type: 'plan_package_install', url: 'not a link at all', reference: 'v1.0.0' });
      const errorMsg = sock.sent[0];
      assert.strictEqual(errorMsg.type, 'package_install_error');
      const failed = model.reply(acquiring(), errorMsg).state;
      assert.strictEqual(failed.phase, 'failed');
      assert.strictEqual(failed.message, errorMsg.message,
        'the failure copy is the producer\'s own words, not a literal restated in this file');
    });
  });

  test('reply from classifying on a real plan reaches trust carrying the real manifest and facts', () => {
    withWorkspace(() => {
      const snap = extensionSnapshot({ agents: 1, skills: 1 });
      const previousDeps = handlers.wireExtensionDeps({ acquire: () => snap });
      try {
        const sock = captureWs();
        handlers.handlePlanPackageInstall(ctx(), sock, { type: 'plan_package_install', url: 'someone/test-ext', reference: 'v1.0.0' });
        const planMsg = sock.sent[0];
        const trusting = model.reply(acquiring(), planMsg).state;
        assert.strictEqual(trusting.phase, 'trust');
        assert.strictEqual(trusting.token, planMsg.token);
        assert.deepStrictEqual(trusting.facts, planMsg.facts,
          'a renamed or dropped field on the wire would drift from what this asserts if it were restated by hand');
        assert.deepStrictEqual(trusting.manifest, planMsg.manifest);
      } finally {
        handlers.wireExtensionDeps(previousDeps);
      }
    });
  });

  test('reply from installing on a real install result reaches done carrying the real record; on a real error, failed', () => {
    withWorkspace(() => {
      const snap = extensionSnapshot();
      const previousDeps = handlers.wireExtensionDeps({ acquire: () => snap });
      try {
        const sock = captureWs();
        handlers.handlePlanPackageInstall(ctx(), sock, { type: 'plan_package_install', url: 'someone/test-ext', reference: 'v1.0.0' });
        const installing = model.confirm(model.reply(acquiring(), sock.sent[0]).state).state;
        handlers.handleConfirmExtensionInstall(ctx(), sock, { type: 'confirm_extension_install', token: sock.sent[0].token });
        const resultMsg = sock.sent[1];
        assert.strictEqual(resultMsg.type, 'extension_install_result');
        const done = model.reply(installing, resultMsg).state;
        assert.strictEqual(done.phase, 'done');
        assert.deepStrictEqual(done.installed, resultMsg.record);
        assert.match(model.doneCopy(done).note, /Pinned at v1\.0\.0/, 'the done card renders the field the record carries');

        handlers.handleConfirmExtensionInstall(ctx(), sock, { type: 'confirm_extension_install', token: sock.sent[0].token });
        const errorMsg = sock.sent[2];
        assert.strictEqual(errorMsg.type, 'package_install_error');
        const failed = model.reply(installing, errorMsg).state;
        assert.strictEqual(failed.phase, 'failed');
        assert.strictEqual(failed.message, errorMsg.message);
      } finally {
        handlers.wireExtensionDeps(previousDeps);
      }
    });
  });

  test('submit refuses with a field error, and sends nothing, when the link is blank', () => {
    for (const link of ['', '   ']) {
      const out = model.submit(model.initial(), link);
      assert.strictEqual(out.send, undefined, `a blank link must not send for link=${JSON.stringify(link)}`);
      assert.match(out.state.fieldError, /Paste the GitHub link/);
    }
    assert.ok(!('reference' in model.submit(model.initial(), 'someone/pack').send),
      'no reference field rides on the request; the server derives the pin');
  });

  test('every connectionLost branch fails honestly, and none of them sends', () => {
    const waiting = { link: 'u', reference: 'r', token: 't' };
    for (const phase of ['classifying', 'trust', 'offer', 'applying', 'installing']) {
      const out = model.connectionLost({ phase, ...waiting });
      assert.strictEqual(out.send, undefined);
      assert.strictEqual(out.state.phase, 'failed', `${phase} is a wait the dropped connection ends`);
      assert.match(out.state.message, /connection dropped/);
      assert.strictEqual(out.state.canReplan, true);
    }
    const idleState = model.initial();
    assert.strictEqual(model.connectionLost(idleState).state, idleState,
      'idle is not a wait, so a dropped connection changes nothing');
  });

  test('trustCopy states no agents and no skills honestly, and carries the replaces line only when there is one', () => {
    const bare = model.trustCopy({
      manifest: { name: 'test-ext', version: '1.0.0' }, link: SOURCE.url, reference: SOURCE.reference,
      facts: { agents: 0, skills: 0, files: [], match: '*.md' }, replaces: null,
    });
    assert.strictEqual(bare.halves.content, 'It adds no agents and no skills.');
    assert.strictEqual(bare.replacesLine, null);

    const replacing = model.trustCopy({
      manifest: { name: 'test-ext', version: '2.0.0' }, link: SOURCE.url, reference: 'v2.0.0',
      facts: { agents: 0, skills: 0, files: [], match: '*.md' },
      replaces: { version: '1.0.0', reference: 'v1.0.0' },
    });
    assert.strictEqual(replacing.replacesLine, 'This replaces the installed 1.0.0 (pinned at v1.0.0).');
  });
});

const SETTINGS_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'views', 'settings.js'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.js'), 'utf8');

// The app.js dispatch case for this flow, cut out of the shell and RUN, so a
// reply type the case does not route never reaches the view in these tests
// either. The extraction asserts the case exists, so a renamed or deleted
// one fails here rather than yielding a function that routes nothing.
function appDispatch(view) {
  const found = /(case 'package_import_plan':[\s\S]*?packagesReplyArrived\(d\); packagesImportLanded\(d\); break;)/.exec(APP_SRC);
  assert.ok(found, 'app.js no longer carries the packages reply dispatch case');
  // THIS FLOW IS ROUTED BY TWO CASE GROUPS, NOT ONE. extension_install_result
  // moved to the roster group, because a completed install carries a fresh
  // roster and has to reach the host's reconcile entry point. It still calls
  // packagesReplyArrived, so the view is still told in the product; cutting
  // only the first group here meant the type reached nothing in the tests and
  // the flow appeared to stop at `installing`. Both groups are cut and run, so
  // this harness keeps matching how the client actually routes.
  const roster = /(case 'packages_page':[\s\S]*?extensionRosterArrived\(d\.extensions\); packagesReplyArrived\(d\); break;)/.exec(APP_SRC);
  assert.ok(roster, 'app.js no longer carries the packages roster dispatch case');
  const route = new Function('d', 'packagesReplyArrived', 'extensionRosterArrived', 'packagesImportLanded',
    `switch (d.type) { ${found[1]} ${roster[1]} }`);
  return (d) => route(d, view.packagesReplyArrived, () => {}, () => {});
}

// The same dispatch case with the real packagesImportLanded beside it, both
// lifted from app.js, over a socket the test owns: what an import result
// asks the server for afterwards is read from the messages sent.
function importLandedDispatch() {
  const found = /(case 'package_import_plan':[\s\S]*?packagesReplyArrived\(d\); packagesImportLanded\(d\); break;)/.exec(APP_SRC);
  const fn = /(function packagesImportLanded\(d\) \{[\s\S]*?\n\})/.exec(APP_SRC);
  assert.ok(found && fn, 'app.js no longer carries the dispatch case and packagesImportLanded the way this test expects');
  const sent = [];
  const run = new Function('d', 'packagesReplyArrived', 'ws', 'WebSocket',
    `let skillsLoaded = true; ${fn[1]} switch (d.type) { ${found[1]} } return skillsLoaded;`);
  const socket = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) };
  return { sent, dispatch: (d) => run(d, () => {}, socket, { OPEN: 1 }) };
}

describe('an import that lands changes refreshes what it changed, without a reload', () => {
  test('an agent landing re-requests the roster and the skills exactly once each and forgets skills were loaded', () => {
    const landed = importLandedDispatch();
    const skillsStillLoaded = landed.dispatch({
      type: 'package_import_result', operation: 'apply', token: 't', requestId: 'r', status: 'ready',
      writes: [
        { id: 'agent:scribe', kind: 'agent', destination: '.claude/agents/scribe.md' },
        { id: 'skill:writer', kind: 'skill', destination: '.claude/skills/writer' },
      ],
      unchanged: [], skipped: [], blocked: [], stale: [],
    });
    assert.deepStrictEqual(landed.sent, [{ type: 'get_agents' }, { type: 'get_skills' }], 'both asked, each exactly once');
    assert.strictEqual(skillsStillLoaded, false, 'the Skills rail re-requests on its next open too');
  });

  test('a skill-only landing re-requests the skills alone: no agent file moved, so the roster is not re-asked', () => {
    const landed = importLandedDispatch();
    landed.dispatch({
      type: 'package_import_result', operation: 'apply', token: 't', requestId: 'r', status: 'ready',
      writes: [{ id: 'skill:writer', kind: 'skill', destination: '.claude/skills/writer' }],
      unchanged: [], skipped: [], blocked: [], stale: [],
    });
    assert.deepStrictEqual(landed.sent, [{ type: 'get_skills' }], 'the skills are re-asked and nothing else is');
  });

  test('a zero-write result and a projection ask for nothing', () => {
    const zero = importLandedDispatch();
    const untouched = zero.dispatch({
      type: 'package_import_result', operation: 'apply', token: 't', requestId: 'r', status: 'ready',
      writes: [], unchanged: [], skipped: [{ id: 'agent:scribe', kind: 'agent' }], blocked: [], stale: [],
    });
    assert.deepStrictEqual(zero.sent, [], 'nothing landed, so nothing is asked');
    assert.strictEqual(untouched, true);

    // A projection shares the envelope and writes nothing by definition.
    const projection = importLandedDispatch();
    projection.dispatch({
      type: 'package_import_result', operation: 'evaluate', requestId: 'r', status: 'ready',
      writes: [{ id: 'agent:scribe', kind: 'agent' }],
    });
    assert.deepStrictEqual(projection.sent, [], 'an evaluate result is not a landing');
  });

  test('the replies those re-requests produce redraw Team, Skills and Routines', () => {
    // A routine arrives inside its agent's frontmatter, so the schedule a
    // trust card just disclosed reaches the Routines page through the
    // roster reply. Asserted over the arms as written, so rewiring either
    // reply away from a redraw the refresh relies on turns this red.
    const agentsArm = /case 'agents':([\s\S]*?)break;/.exec(APP_SRC);
    const skillsArm = /case 'skills':([\s\S]*?)break;/.exec(APP_SRC);
    assert.ok(agentsArm && skillsArm, 'app.js no longer carries the agents and skills dispatch arms');
    for (const redraw of ['renderAgentList(', 'renderOrgChart(', 'renderRoutinesPanel(', 'renderRoutines(']) {
      assert.ok(agentsArm[1].includes(redraw), `the agents reply redraws via ${redraw})`);
    }
    for (const redraw of ['renderSkills(', 'renderRoutines(']) {
      assert.ok(skillsArm[1].includes(redraw), `the skills reply redraws via ${redraw})`);
    }
  });
});

describe('the settings view exports every function its own packages markup and app.js call by name', () => {
  test('every onclick name inside packagesSectionHtml, and packagesReplyArrived on the app.js dispatch case, are on the module surface', () => {
    // Derived from the file, not hand-listed, so a handler added to the
    // markup later fails here without anyone updating a list in this test.
    const sectionMatch = /function packagesSectionHtml\(\) \{([\s\S]*?)\n\}\n/.exec(SETTINGS_SRC);
    assert.ok(sectionMatch, 'settings.js no longer defines packagesSectionHtml the way this test expects');
    const onclickNames = new Set();
    for (const m of sectionMatch[1].matchAll(/onclick="([a-zA-Z_$][\w$]*)\(/g)) onclickNames.add(m[1]);
    assert.ok(onclickNames.has('packagesSubmit'), 'sanity: the packages section markup was found at all');

    assert.match(APP_SRC, /case 'extension_install_plan':[\s\S]*?packagesReplyArrived\(d\);/,
      'sanity: app.js no longer routes extension replies to packagesReplyArrived');

    const settingsView = require('../../public/views/settings.js');
    const exported = new Set(Object.keys(settingsView));
    for (const name of [...onclickNames, 'packagesReplyArrived', 'packagesServingWorkspaceChanged']) {
      assert.ok(exported.has(name),
        `"${name}" is called by name from the packages markup or app.js, but is not on `
        + 'the object public/views/settings.js returns, so it resolves against window in a browser and throws');
    }
  });
});

// The real settings view under jsdom, with the globals the module reads at
// call time, its flow returned to idle, and the section drawn. Every test
// that renders goes through here so the markup on screen is the product's.
function settingsShell() {
  const dom = new JSDOM('<div id="settings-content"></div><div class="settings-nav-item active" data-settings="packages"></div>');
  global.document = dom.window.document;
  global.window = dom.window;
  global.currentView = 'settings';
  global.currentWorkspacePath = config.getWorkspace();
  const sent = [];
  global.ws = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) };
  global.WebSocket = { OPEN: 1 };
  global.esc = (t) => String(t == null ? '' : t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  global.escAttr = (t) => String(t == null ? '' : t)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const view = require('../../public/views/settings.js');
  view.packagesWorkspaceChanged();
  const content = () => dom.window.document.getElementById('settings-content');
  return {
    view, sent, content, dispatch: appDispatch(view),
    // Pressed as the controls they are, so a renamed exported name fails
    // here rather than in a browser only. One field: a reference travels
    // inside the link (owner/repo@ref, a release or tree URL) or not at all.
    submit(link) {
      content().querySelector('#packages-source-link').value = link;
      view.packagesSubmit();
    },
    release() {
      for (const g of ['document', 'window', 'currentView', 'currentWorkspacePath', 'ws', 'WebSocket', 'esc', 'escAttr']) delete global[g];
    },
  };
}

describe('one link field for both kinds, rendered through the real settings view', () => {
  test('the section renders exactly one input and one submit, and no reference input is present', () => {
    withWorkspace(() => {
      const shell = settingsShell();
      try {
        const inputs = [...shell.content().querySelectorAll('input')];
        assert.deepStrictEqual(inputs.map((el) => el.id), ['packages-source-link'],
          'exactly the link: the server resolves the reference, and a typed folder path is not in the interface');
        assert.strictEqual(shell.content().querySelector('#packages-source-ref'), null,
          'no reference input is present, so restoring the second field turns this suite red');
        assert.ok(inputs[0].classList.contains('settings-input'), 'the field is the shared settings input');
        assert.strictEqual(inputs[0].getAttribute('placeholder'), 'Paste a GitHub link…');
        const submits = [...shell.content().querySelectorAll('button')].filter((b) => /packagesSubmit/.test(b.getAttribute('onclick')));
        assert.strictEqual(submits.length, 1, 'one submit serves both kinds');
        assert.ok(submits[0].classList.contains('settings-btn-primary'), 'the submit is the accent primary button');
        assert.strictEqual(submits[0].textContent, 'Add');
        const card = inputs[0].closest('.settings-card');
        assert.ok(card.classList.contains('flow'), 'the add card is the padded flow card');
        assert.strictEqual(card.querySelector('.settings-section-label').textContent, 'Add a package');
        assert.ok(inputs[0].closest('.pkg-field-row'), 'the field and its submit share the one row');
        assert.strictEqual(card.querySelector('.pkg-teach').textContent.replace(/\s+/g, ' ').trim(),
          'Add agents, skills and routines to your workspace, or an extension that changes how a file opens.');
        shell.submit('someone/test-ext@v1.0.0');
        assert.deepStrictEqual(shell.sent, [{ type: 'plan_package_install', url: 'someone/test-ext@v1.0.0' }],
          'the client sends only the link; the server acquires the snapshot and resolves the reference itself');
      } finally {
        shell.release();
      }
    });
  });
});

describe('the link is classified from the acquired bytes, and each outcome reaches the real view', () => {
  const DRIVEN_COMMIT = 'd'.repeat(40);
  // Submit through the real view, answer through the real handler, route the
  // reply through the real dispatch case into the real model and view.
  // A link naming no reference, to a repository with no version tags, is
  // pinned to the commit fetched; that commit is DRIVEN_COMMIT here.
  function drive(shell, snapshot, link) {
    const previousDeps = handlers.wireExtensionDeps({ acquire: () => snapshot, listRefs: () => [], commitOf: () => DRIVEN_COMMIT });
    try {
      shell.submit(link);
      const sock = captureWs();
      handlers.handlePlanPackageInstall(ctx(), sock, shell.sent[shell.sent.length - 1]);
      shell.dispatch(sock.sent[0]);
      return sock;
    } finally {
      handlers.wireExtensionDeps(previousDeps);
    }
  }

  test('a manifest with an extension block reaches the trust step', () => {
    withWorkspace(() => {
      const shell = settingsShell();
      try {
        const sock = drive(shell, extensionSnapshot({ agents: 1, skills: 1 }), 'someone/test-ext@v1.0.0');
        assert.strictEqual(sock.sent[0].type, 'extension_install_plan');
        const card = shell.content().querySelector('.extension-trust-card');
        assert.ok(card, 'the trust card is on screen');
        for (const file of sock.sent[0].facts.files) {
          assert.ok(card.innerHTML.includes(file), `the rendered trust card does not carry "${file}", one of the facts the plan derived`);
        }
      } finally {
        shell.release();
      }
    });
  });

  test('a snapshot without an extension block reaches the offer, and its receipt carries the link with the reference given', () => {
    withWorkspace((ws) => {
      for (const [link, expected] of [['someone/test-ext@v1.0.0', 'v1.0.0'], ['someone/test-ext', DRIVEN_COMMIT]]) {
        const shell = settingsShell();
        try {
          const sock = drive(shell, extensionSnapshot({ agents: 2, skills: 1, manifest: false }), link);
          assert.strictEqual(sock.sent[0].type, 'package_import_plan');
          const card = shell.content().querySelector('.packages-confirm-card');
          assert.ok(card && !card.classList.contains('extension-trust-card'), 'the plain offer, never the amber trust card');
          assert.match(card.querySelector('.packages-headline').textContent, /Ready to add/);
          assert.match(card.querySelector('.packages-body').textContent, /found 2 agents and 1 skill/);

          shell.view.packagesConfirm();
          const confirmMsg = shell.sent[shell.sent.length - 1];
          assert.strictEqual(confirmMsg.type, 'confirm_package_install');
          handlers.handleConfirmPackageInstall(ctx(), sock, confirmMsg);
          shell.dispatch(sock.sent[1]);
          assert.strictEqual(sock.sent[1].type, 'package_import_result');
          const receipt = JSON.parse(fs.readFileSync(path.join(ws, sock.sent[1].receipt), 'utf8'));
          assert.deepStrictEqual(receipt.source, { id: 'https://github.com/someone/test-ext', reference: expected, commit: DRIVEN_COMMIT },
            'the receipt names the link and the reference given, or the commit fetched when none was');
          assert.match(shell.content().querySelector('.packages-success-card .packages-headline').textContent, /Added to your team/);
          fs.rmSync(path.join(ws, '.claude'), { recursive: true, force: true });
        } finally {
          shell.release();
        }
      }
    });
  });

  test('an extension link naming no reference is acquired at the resolved latest tag, and the trust card says so', () => {
    withWorkspace(() => {
      const shell = settingsShell();
      const acquiredAt = [];
      const previousDeps = handlers.wireExtensionDeps({
        acquire: (source) => { acquiredAt.push(source.reference); return extensionSnapshot(); },
        listRefs: () => ['v0.9.0', 'v1.2.0', 'v1.10.0'],
      });
      try {
        shell.submit('someone/test-ext');
        const sock = captureWs();
        handlers.handlePlanPackageInstall(ctx(), sock, shell.sent[0]);
        shell.dispatch(sock.sent[0]);
        assert.strictEqual(sock.sent[0].type, 'extension_install_plan');
        assert.strictEqual(sock.sent[0].source.reference, 'v1.10.0', 'the latest tag by version order, not lexicographic');
        assert.deepStrictEqual(acquiredAt, [null, 'v1.10.0'], 'classified at the head, then acquired again at the resolved pin');
        const card = shell.content().querySelector('.extension-trust-card');
        assert.ok(card, 'the trust card is on screen');
        assert.match(card.textContent, /pinned to v1\.10\.0/, 'the derived pin is reported back on the card');
      } finally {
        handlers.wireExtensionDeps(previousDeps);
        shell.release();
      }
    });
  });

  test('an extension whose repository publishes no version tag reaches the trust card pinned to the commit fetched', () => {
    withWorkspace((ws) => {
      const shell = settingsShell();
      const FETCHED = 'e'.repeat(40);
      const acquiredAt = [];
      const previousDeps = handlers.wireExtensionDeps({
        acquire: (source) => { acquiredAt.push(source.reference); return extensionSnapshot(); },
        listRefs: () => [],
        commitOf: () => FETCHED,
      });
      try {
        shell.submit('someone/test-ext');
        const sock = captureWs();
        handlers.handlePlanPackageInstall(ctx(), sock, shell.sent[0]);
        shell.dispatch(sock.sent[0]);
        assert.strictEqual(sock.sent[0].type, 'extension_install_plan', 'offered, not refused');
        assert.strictEqual(sock.sent[0].source.reference, FETCHED);
        assert.deepStrictEqual(acquiredAt, [null], 'one fetch: the head read is what is offered');
        assert.deepStrictEqual(fs.readdirSync(ws), [], 'nothing is written before the person answers');
        const card = shell.content().querySelector('.extension-trust-card');
        assert.ok(card, 'the trust card is on screen');
        assert.match(card.textContent, /pinned to commit eeeeeee/, 'the card says it is pinned to the commit');
      } finally {
        handlers.wireExtensionDeps(previousDeps);
        shell.release();
      }
    });
  });
});

describe('a snapshot carrying both an extension and content: the card says what confirm does with each half, and the filesystem agrees', () => {
  test('confirm installs the extension only; the agents and skills are offered as the second step the card promised', () => {
    withWorkspace((ws) => {
      const shell = settingsShell();
      const snap = extensionSnapshot({ agents: 2, skills: 1 });
      const previousDeps = handlers.wireExtensionDeps({ acquire: () => snap });
      try {
        shell.submit('someone/test-ext@v1.0.0');
        const sock = captureWs();
        handlers.handlePlanPackageInstall(ctx(), sock, shell.sent[0]);
        shell.dispatch(sock.sent[0]);
        const card = shell.content().querySelector('.extension-trust-card');
        const extensionHalf = card.querySelector('.extension-half-extension').textContent;
        const contentHalf = card.querySelector('.extension-half-content').textContent;
        assert.match(extensionHalf, /Install puts the view above under \.rundock\/extensions\/test-ext/);
        assert.match(contentHalf, /2 agents and 1 skill in this repository are not added by this step/);
        assert.match(contentHalf, /offered them separately/);

        shell.view.packagesConfirm();
        handlers.handleConfirmExtensionInstall(ctx(), sock, shell.sent[1]);
        assert.strictEqual(sock.sent[1].type, 'extension_install_result');
        // Each half of the statement, held against the disk.
        assert.ok(fs.existsSync(path.join(ws, '.rundock', 'extensions', 'test-ext', 'view', 'index.html')),
          'the extension half: the view is where the card said install puts it');
        assert.strictEqual(fs.existsSync(path.join(ws, '.claude', 'agents')), false,
          'the content half: no agent was added by this step, exactly as the card said');
        assert.strictEqual(fs.existsSync(path.join(ws, '.claude', 'skills')), false, 'and no skill');

        shell.dispatch(sock.sent[1]);
        const offer = shell.content().querySelector('.packages-confirm-card');
        assert.ok(offer && !offer.classList.contains('extension-trust-card'), 'the second step is the plain offer');
        assert.match(offer.querySelector('.packages-headline').textContent, /Test Ext 1\.0\.0 is installed\. Add its agents and skills too\?/);
        shell.view.packagesConfirm();
        const confirmMsg = shell.sent[2];
        assert.strictEqual(confirmMsg.type, 'confirm_package_install');
        assert.strictEqual(confirmMsg.token, sock.sent[1].content.token, 'the offer answers under the token the result issued for it');
        handlers.handleConfirmPackageInstall(ctx(), sock, confirmMsg);
        assert.strictEqual(sock.sent[2].type, 'package_import_result');
        assert.strictEqual(sock.sent[2].status, 'ready');
        assert.strictEqual(fs.readdirSync(path.join(ws, '.claude', 'agents')).length, 2, 'now the agents landed');
        assert.strictEqual(fs.readdirSync(path.join(ws, '.claude', 'skills')).length, 1, 'and the skill');
        assert.strictEqual(fs.existsSync(snap), false, 'the snapshot leaves with the last answer');
        shell.dispatch(sock.sent[2]);
        const done = shell.content().querySelector('.packages-success-card');
        assert.match(done.querySelector('.packages-headline').textContent, /Installed Test Ext 1\.0\.0/);
        assert.strictEqual(done.querySelectorAll('.packages-part').length, 4, 'the extension and the three items, each with where it went');
      } finally {
        handlers.wireExtensionDeps(previousDeps);
        shell.release();
      }
    });
  });

  test('declining the second step keeps the extension and discards the snapshot', () => {
    withWorkspace((ws) => {
      const snap = extensionSnapshot({ agents: 1 });
      const previousDeps = handlers.wireExtensionDeps({ acquire: () => snap });
      try {
        const sock = captureWs();
        handlers.handlePlanPackageInstall(ctx(), sock, { type: 'plan_package_install', url: 'someone/test-ext', reference: 'v1.0.0' });
        handlers.handleConfirmExtensionInstall(ctx(), sock, { type: 'confirm_extension_install', token: sock.sent[0].token });
        const contentToken = sock.sent[1].content.token;
        assert.ok(fs.existsSync(snap), 'the snapshot waits for the second answer');
        handlers.handleDeclinePackageInstall(ctx(), sock, { type: 'decline_package_install', token: contentToken });
        assert.strictEqual(fs.existsSync(snap), false);
        assert.strictEqual(readExtensionRecords(ws).length, 1, 'the extension stays installed');
        assert.strictEqual(fs.existsSync(path.join(ws, '.claude', 'agents')), false, 'and nothing else landed');
      } finally {
        handlers.wireExtensionDeps(previousDeps);
      }
    });
  });
});

// The card says an extension can change the file it opens, and says
// it only for one that asked. Consent to a privilege nobody mentioned is not
// consent, and a sentence on every card about a power most extensions do not
// have teaches people to skim the cards of the ones that do.
describe('the trust card states writing, and only where it was declared', () => {
  const base = {
    manifest: { name: 'test-ext', version: '1.0.0' }, link: SOURCE.url, reference: SOURCE.reference,
    replaces: null,
  };
  test('a declaring extension has the sentence, derived from the manifest fact', () => {
    const copy = model.trustCopy({ ...base,
      facts: { agents: 0, skills: 0, files: [], match: '*.csv', writes: true } });
    const said = copy.runsLines.join(' ');
    assert.match(said, /change the file it opens/,
      'the person is told, before confirm, that this one can write');
    assert.match(said, /and nothing else/,
      'and told the bound, because an unbounded write is a different question');
  });

  test('a read-only extension carries no sentence about writing at all', () => {
    for (const writes of [undefined, false, null, 'true']) {
      const copy = model.trustCopy({ ...base,
        facts: { agents: 0, skills: 0, files: [], match: '*.csv', writes } });
      assert.doesNotMatch(copy.runsLines.join(' '), /change the file it opens/,
        `writes: ${JSON.stringify(writes)} is not a declaration, so the card stays quiet about writing`);
    }
  });

  test('the sentence is the only difference between the two cards', () => {
    const read = model.trustCopy({ ...base, facts: { agents: 0, skills: 0, files: [], match: '*.csv' } });
    const write = model.trustCopy({ ...base,
      facts: { agents: 0, skills: 0, files: [], match: '*.csv', writes: true } });
    assert.deepStrictEqual(write.runsLines.slice(0, read.runsLines.length), read.runsLines,
      'the four unconditional facts are word for word the same on both');
    assert.strictEqual(write.runsLines.length, read.runsLines.length + 1,
      'and the declaring card adds exactly one line, not a reworded block');
  });
});

describe('every safety claim on the trust card is computed from a host fact the code enforces', () => {
  // The expected claim table is read from the host module (the sandbox
  // attribute and frame policy off a real mount, the closed message table
  // off its export) and from the contract document's tables, never from
  // either document's prose. The init fields are the document's init row,
  // read from its table, so the card can claim neither more nor less than
  // the frame is told.
  test('the claim table equals the host and document tables, and each rendered sentence names the fact behind it', async () => {
    const host = await import('../../public/extension-host.js');
    const dom = new JSDOM('<!doctype html><html><body><div id="pane"></div></body></html>', { runScripts: 'outside-only' });
    const handle = host.mountExtension({ paneElement: dom.window.document.getElementById('pane'), payload: { entry: '' }, onDegrade: () => {} });
    const frame = handle.frame();
    const policy = /Content-Security-Policy" content="([^"]*)"/.exec(frame.srcdoc);
    assert.ok(policy, 'the frame document carries a policy this can read');
    const doc = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'EXTENSION-HOST.md'), 'utf-8');
    // [A-Za-z]: a lowercase-only pattern cannot see a camelCase message such
    // as openExternal, and a check that cannot see a row cannot hold it.
    const rows = [...doc.matchAll(/^\| `([A-Za-z]+)` \| `(\{ type[^`]*)`/gm)].map((m) => ({ type: m[1], fields: [...m[2].matchAll(/,\s*([A-Za-z]+)/g)].map((f) => f[1]) }));
    assert.ok(rows.length >= 4, 'the document\'s message table was found at all');
    const initRow = rows.find((r) => r.type === 'init');
    assert.ok(initRow && initRow.fields.length >= 2, 'the document carries an init row with its fields');
    handle.teardown();
    // WHICH MESSAGES NEED A CLICK, FOUND BY BEHAVIOUR. Each message is sent
    // to a live mount with no click recorded, with a well-formed body, and
    // the ones the host refuses for want of a click are the gated set. A
    // list compared with a list would pass while the gate itself was gone.
    const bodies = { ready: {}, resize: { height: 100 }, error: { message: 'x' }, open: { target: 'a.md' },
      save: { content: 'x' }, change: { content: 'x' }, openExternal: { url: 'https://example.org/' },
      saveSource: { source: 'a.csv', content: 'x' }, changeSource: { source: 'a.csv', content: 'x' }, ask: { agent: 'wren', message: 'x' } };
    const clickGated = [];
    for (const type of Object.keys(host.EXTENSION_MESSAGES)) {
      const d = new JSDOM('<!doctype html><html><body><div id="pane"></div></body></html>', { runScripts: 'outside-only' });
      Object.defineProperty(d.window.navigator, 'userActivation', { configurable: true, get: () => ({ isActive: false }) });
      const sent = [];
      const h = host.mountExtension({ paneElement: d.window.document.getElementById('pane'), payload: { entry: '', writes: true },
        onDegrade: () => {}, onOpen: () => {}, onSave: () => {}, onOpenExternal: () => {} });
      h.frame().contentWindow.postMessage = (m) => sent.push(m);
      h.dispatch({ source: h.frame().contentWindow, data: { type, ...bodies[type] } });
      if (sent.some((m) => m.type === 'refused' && /click/.test(m.reason))) clickGated.push(type);
      h.teardown();
    }
    const computed = {
      sandbox: frame.getAttribute('sandbox'),
      network: policy[1].split(';')[0].trim(),
      messages: Object.keys(host.EXTENSION_MESSAGES),
      clickGated,
      init: initRow.fields,
      viewStateBytes: host.VIEW_STATE_MAX_BYTES,
    };
    assert.deepStrictEqual(model.HOST_FACTS, computed, 'a claim appears only where a host fact stands behind it');
    assert.deepStrictEqual(rows.filter((r) => !host.HOST_MESSAGES.includes(r.type)).map((r) => r.type).sort(), [...computed.messages].sort(),
      'the document\'s table names the same closed set');

    const copy = model.trustCopy({
      manifest: { name: 'test-ext', version: '1.0.0' }, link: SOURCE.url, reference: SOURCE.reference,
      facts: { agents: 0, skills: 0, files: [], match: '*.md' }, replaces: null,
    });
    assert.deepStrictEqual(copy.runsLines, model.hostClaims(computed));
    const [sandboxLine, networkLine, messagesLine, initLine, stateLine] = copy.runsLines;
    assert.ok(sandboxLine.includes(computed.sandbox), 'the sandbox sentence names the exact grant');
    assert.ok(networkLine.includes(computed.network), 'the network sentence names the exact policy');
    // Browser mode may not promise what only the desktop app enforces.
    assert.match(networkLine, /only blocked in the desktop app/,
      'the browser-mode card says peer-to-peer connections are not blocked there');
    const desktop = model.trustCopy({
      manifest: { name: 'test-ext', version: '1.0.0' }, link: SOURCE.url, reference: SOURCE.reference,
      facts: { agents: 0, skills: 0, files: [], match: '*.md' }, replaces: null,
    }, { desktop: true });
    assert.match(desktop.runsLines[1], /peer-to-peer/, 'the desktop card claims peer connections are blocked');
    assert.doesNotMatch(desktop.runsLines[1], /only blocked in the desktop app/);
    assert.strictEqual(/only these messages: ([A-Za-z, ]+)\./.exec(messagesLine)[1], computed.messages.join(', '),
      'the messages sentence lists exactly the closed table, so it can claim neither more nor less');
    for (const type of computed.clickGated) {
      assert.ok(messagesLine.includes(type), `the card says "${type}" needs a click, because the host refuses it without one`);
    }
    assert.match(initLine, /hidden folders/, 'the card says hidden files are never handed to a view');
    assert.match(initLine, /read-only/, 'the frame receives the opened file read-only');
    for (const field of computed.init.filter((f) => f !== 'sources' && f !== 'state')) assert.ok(initLine.includes(field), `the init sentence names "${field}"`);
    // `state` is said by its own sentence, from the cap the host enforces.
    assert.ok(computed.messages.includes('setState') && computed.init.includes('state'), 'the host carries view state both ways');
    assert.ok(stateLine.startsWith(`It can keep up to ${computed.viewStateBytes / 1024} KB of its own settings for each note it opens`), 'the view state sentence names the host\'s cap');
    assert.strictEqual(copy.runsLines.length, 5, 'five facts, five sentences: no claim without a fact');
  });
});

// EVERY SENTENCE ON THE CARD NAMES THE RUN THAT OBSERVED IT. The test
// above binds the words to the host's facts; this binds each claim to the
// real-engine check that watched it hold, so a sentence cannot outlive the
// proof of it. The real-engine runs are what the confinement criteria require, because
// jsdom enforces neither sandbox flags nor policy. Renaming or deleting one
// of those checks fails here, which is the point.
describe('each trust card claim is observed by a real-engine run', () => {
  const spec = fs.readFileSync(path.join(__dirname, '..', 'e2e', 'extension-confinement.spec.js'), 'utf8');
  const desktop = fs.readFileSync(path.join(__dirname, '..', 'electron', 'confinement.cjs'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'e2e', 'extension-host-wiring.spec.js'), 'utf8');
  const trust = fs.readFileSync(path.join(__dirname, '..', 'e2e', 'trust-boundary.spec.js'), 'utf8');
  const trustApp = fs.readFileSync(path.join(__dirname, '..', 'e2e', 'trust-boundary-app.spec.js'), 'utf8');
  const viewState = fs.readFileSync(path.join(__dirname, '..', 'e2e', 'extension-view-state.spec.js'), 'utf8');
  const EVIDENCE = {
    'cannot load pages or make requests': [spec, 'frame policy, a view that leaves with the file reaches nothing'],
    'Rundock ends the view if it tries to leave': [spec, 'and the view ends'],
    'Peer-to-peer connections are only blocked in the desktop app': [spec, 'a peer connection is not blocked in browser mode'],
    'open peer-to-peer connections': [desktop, 'a peer connection sends nothing on desktop'],
    'cannot load pages, make requests': [desktop, 'a view leaving with the file reaches nothing on desktop'],
    'honoured only after you click inside the view': [spec, 'a view mounted by a click in the tree cannot use that click'],
    'one per click': [spec, 'a burst of opens and web addresses on one click honours exactly one'],
    'it asks you first, above the view': [trust, 'B cannot use the click spent in A'],
    'linked files': [app, 'a linked or hard-linked file opened from the tree is not mounted'],
    // Each sentence a sources extension's card carries.
    'lists under sources:, while that note is open in it': [trust, 'the view is handed exactly the named files that resolve'],
    'It cannot name, list or find any other file': [trust, 'no message reads, lists or finds a file'],
    'hidden files, linked files and anything outside your workspace are never given to it': [trust, 'nothing else is learned or written'],
    'it can never change the list': [trust, 'a view cannot widen its note'],
    // Each claim is bound to the runs that observed it.
    'When you click inside it, it can start a new conversation': [trust, 'no click is refused'],
    'Nothing is sent until you send it': [trustApp, 'a click drafts to a NEW conversation'],
    'it never sees the conversation or the reply': [trust, 'nothing comes back'],
    "in Rundock's folder, never in your notes": [viewState, "get answers on the entry\\'s first line, and a write lands in the mounted pair\\'s file, never in the note"],
  };
  const card = (desktopMode) => model.trustCopy({
    manifest: { name: 'x', version: '1.0.0' }, link: SOURCE.url, reference: SOURCE.reference,
    // Every privilege an extension can ask for, so every sentence the card
    // can carry is on it and bound below.
    facts: { agents: 0, skills: 0, files: [], match: '*.md', declares: 'portfolio-dashboard', sources: true, writes: true, asks: ['wren'] }, replaces: null,
  }, { desktop: desktopMode }).runsLines.join(' ');

  test('every claim the evidence map names is still on the card it belongs to', () => {
    const both = card(true) + ' ' + card(false);
    for (const claim of Object.keys(EVIDENCE)) assert.ok(both.includes(claim), `the card no longer says "${claim}"`);
  });

  test('every claim is observed by a check that still exists', () => {
    for (const [claim, [source, title]] of Object.entries(EVIDENCE)) {
      assert.ok(source.includes(title), `"${claim}" has no observing run: "${title}" is gone`);
    }
  });
});

describe('every record write tells the file tree', () => {
  // The tree lists the extensions an enabled record claims, from a cache the
  // root owns (server.js), so a record written here without that cache being
  // told would leave a client reading a tree that predates the install. The
  // handler context is the seam: each flow that writes the record is driven
  // at the wire with a counting context, and the count moves once per write.
  function counting() {
    const context = { workspace: { noteExtensionRecordsChanged() { context.calls += 1; } }, calls: 0 };
    return context;
  }

  test('an install tells the tree once, after the record is written and before the reply', () => {
    withWorkspace((ws) => {
      const previousDeps = handlers.wireExtensionDeps({ acquire: () => extensionSnapshot() });
      try {
        const sock = captureWs();
        const context = counting();
        handlers.handlePlanPackageInstall(context, sock, { type: 'plan_package_install', url: 'someone/test-ext', reference: 'v1.0.0' });
        assert.strictEqual(context.calls, 0, 'reading a package writes no record, so nothing is told');
        context.workspace.noteExtensionRecordsChanged = () => {
          context.calls += 1;
          assert.strictEqual(readExtensionRecords(ws).length, 1, 'told after the record is on disk');
          assert.strictEqual(sock.sent.length, 1, 'told before the reply goes out');
        };
        handlers.handleConfirmExtensionInstall(context, sock, { type: 'confirm_extension_install', token: sock.sent[0].token });
        assert.strictEqual(sock.sent[1].type, 'extension_install_result');
        assert.strictEqual(context.calls, 1);
      } finally {
        handlers.wireExtensionDeps(previousDeps);
      }
    });
  });


});

describe('a reply is matched to the request that produced it, by operation and token', () => {
  test('a package uninstall refusal and a package update-check error arriving mid-install leave the install state deep-equal to before, at the wire', () => {
    withWorkspace(() => {
      const snap = extensionSnapshot();
      const previousDeps = handlers.wireExtensionDeps({ acquire: () => snap, listRefs: () => { throw new Error('no remote in this test'); } });
      try {
        const sock = captureWs();
        handlers.handlePlanPackageInstall(ctx(), sock, { type: 'plan_package_install', url: 'someone/test-ext', reference: 'v1.0.0' });
        const token = sock.sent[0].token;
        const installing = model.confirm(model.reply(model.submit(model.initial(), 'someone/test-ext@v1.0.0').state, sock.sent[0]).state).state;
        const before = JSON.parse(JSON.stringify(installing));

        handlers.handlePlanPackageUninstall(ctx(), sock, { type: 'plan_package_uninstall', source: 'https://github.com/nobody/ghost' });
        const uninstallError = sock.sent[1];
        assert.strictEqual(uninstallError.type, 'package_install_error');
        assert.strictEqual(uninstallError.operation, 'package-uninstall-plan');
        assert.strictEqual(model.reply(installing, uninstallError).state, installing, 'not this flow\'s answer: identity, nothing redrawn');
        // Refused before any await, so the reply is on the socket already.
        handlers.handleCheckPackageUpdate(ctx(), sock, { type: 'check_package_update', source: 'https://github.com/nobody/here' });
        assert.strictEqual(sock.sent[2].operation, 'package-update-check');
        assert.strictEqual(model.reply(installing, sock.sent[2]).state, installing);
        assert.strictEqual(model.reply(installing, sock.sent[3]).state, installing, 'nor is the end of that check');
        assert.strictEqual(model.reply(installing, { type: 'package_install_error', operation: 'install', token: 'pkg-someone-else', message: 'x' }).state, installing,
          'the right operation under another token is another request\'s answer');
        assert.deepStrictEqual(installing, before, 'and the state was never mutated in place');

        handlers.handleConfirmExtensionInstall(ctx(), sock, { type: 'confirm_extension_install', token });
        assert.strictEqual(model.reply(installing, sock.sent[4]).state.phase, 'done', 'the install\'s own answer still lands');
      } finally {
        handlers.wireExtensionDeps(previousDeps);
      }
    });
  });
});

describe('consent binds to the workspace it was shown against, on the client too', () => {
  test('the shell\'s serving-workspace writer returns the flow to its start when another window moved the server', () => {
    withWorkspace(() => {
      const shell = settingsShell();
      const previousDeps = handlers.wireExtensionDeps({ acquire: () => extensionSnapshot() });
      try {
        shell.submit('someone/test-ext@v1.0.0');
        const sock = captureWs();
        handlers.handlePlanPackageInstall(ctx(), sock, shell.sent[0]);
        shell.dispatch(sock.sent[0]);
        assert.ok(shell.content().querySelector('.extension-trust-card'), 'sanity: the trust step is on screen');
        // The shell's own writer, cut out of app.js and run with the view's
        // reset in scope, exactly as the dispatch case calls it.
        const found = /(function setServingWorkspace\(path\) \{[\s\S]*?\n\})/.exec(APP_SRC);
        assert.ok(found, 'app.js no longer carries the serving-workspace writer');
        const writer = new Function('packagesServingWorkspaceChanged', `let servingWorkspacePath = null; ${found[1]}; return setServingWorkspace;`)(shell.view.packagesServingWorkspaceChanged);
        writer(global.currentWorkspacePath);
        assert.ok(shell.content().querySelector('.extension-trust-card'), 'the server still serving this window\'s workspace changes nothing');
        writer(global.currentWorkspacePath + '-elsewhere');
        assert.strictEqual(shell.content().querySelector('.extension-trust-card'), null, 'the trust step left the screen');
        assert.strictEqual(shell.content().querySelector('#packages-source-link').disabled, false, 'and the flow is at its start');
        assert.strictEqual(shell.content().querySelector('#packages-source-link').value, '');
      } finally {
        handlers.wireExtensionDeps(previousDeps);
        shell.release();
      }
    });
  });
});


describe('the per-request close listener leaves with the request', () => {
  test('confirm, decline, supersede and a closed socket each leave the close listener count where it began', () => {
    withWorkspace(() => {
      const previousDeps = handlers.wireExtensionDeps({ acquire: () => extensionSnapshot() });
      try {
        const sock = Object.assign(new EventEmitter(), { readyState: 1, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); } });
        const plan = () => { handlers.handlePlanPackageInstall(ctx(), sock, { type: 'plan_package_install', url: 'someone/test-ext', reference: 'v1.0.0' }); return sock.sent[sock.sent.length - 1].token; };
        const before = sock.listenerCount('close');
        let token = plan();
        assert.strictEqual(sock.listenerCount('close'), before + 1, 'sanity: an open offer holds one listener');
        handlers.handleConfirmExtensionInstall(ctx(), sock, { type: 'confirm_extension_install', token });
        assert.strictEqual(sock.listenerCount('close'), before, 'confirm');
        token = plan();
        handlers.handleDeclinePackageInstall(ctx(), sock, { type: 'decline_package_install', token });
        assert.strictEqual(sock.listenerCount('close'), before, 'decline');
        plan();
        plan();
        assert.strictEqual(sock.listenerCount('close'), before + 1, 'supersede: the first offer\'s listener left with it');
        sock.emit('close');
        assert.strictEqual(sock.listenerCount('close'), before, 'close');
      } finally {
        handlers.wireExtensionDeps(previousDeps);
      }
    });
  });
});

describe('every strict refusal is named, and each guard is the only thing standing between its input and a wrong answer', () => {
  // One manifest variant per refusal branch of readExtensionManifest, each
  // asserted on its own message so a removed guard cannot be covered by the
  // next guard's refusal.
  test('each manifest refusal names its reason', () => {
    const cases = [
      ['not valid JSON', { raw: '{ nope' }, /is not valid JSON/],
      ['not an object', { raw: 'null' }, /must be an object/],
      ['a name that is not a slug', (m) => { m.name = 'Not A Slug'; }, /name must be a lowercase slug/],
      ['a blank version', (m) => { m.version = ' '; }, /version must be a non-empty string/],
      ['no extension block', (m) => { delete m.extension; }, /declares no extension/],
      ['an entry that is not a path', (m) => { m.extension.entry = 5; }, /entry must be a relative path/],
      ['an absolute entry', (m) => { m.extension.entry = '/etc/hosts'; }, /entry must not be absolute/],
      ['an entry escaping the package', (m) => { m.extension.entry = '../outside.html'; }, /must stay inside the package/],
      ['an entry that is a directory', (m) => { m.extension.entry = 'view'; }, /is not a regular file/],
      ['a blank match rule', (m) => { m.extension.match = ''; }, /match must be a non-empty match rule/],
    ];
    for (const [label, change, expected] of cases) {
      const dir = extensionSnapshot();
      const manifestPath = path.join(dir, 'rundock.json');
      if (typeof change === 'function') {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        change(manifest);
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      } else fs.writeFileSync(manifestPath, change.raw);
      assert.throws(() => readExtensionManifest(dir), (e) => typeof e.code === 'string' && expected.test(e.message), `${label}: ${expected}`);
    }
  });

  test('each records-file refusal names its reason, and a listing that is not an array is refused', () => {
    const cases = [
      ['not valid JSON', '{ nope', /extension records unreadable/],
      ['an unrecognised schema', JSON.stringify({ schema: 'something-else/v9', extensions: [] }), /not a recognised records file/],
      ['an entry that is not an object', JSON.stringify({ schema: 'rundock.extensions/v1', extensions: [null] }), /an entry is not an object/],
      ['a record without a version', JSON.stringify({ schema: 'rundock.extensions/v1', extensions: [{ name: 'x', source: { url: 'u', reference: 'v1' }, root: 'r' }] }), /"x" has no version/],
      ['a record without a pinned reference', JSON.stringify({ schema: 'rundock.extensions/v1', extensions: [{ name: 'x', version: '1', source: { url: 'u', reference: null }, root: 'r' }] }), /"x" carries no pinned reference/],
      ['a record without its source', JSON.stringify({ schema: 'rundock.extensions/v1', extensions: [{ name: 'x', version: '1', root: 'r' }] }), /"x" carries no source url/],
    ];
    for (const [label, raw, expected] of cases) {
      const ws = workspace();
      const recordsPath = path.join(ws, ...RECORDS_PATH.split('/'));
      fs.mkdirSync(path.dirname(recordsPath), { recursive: true });
      fs.writeFileSync(recordsPath, raw);
      assert.throws(() => readExtensionRecords(ws), expected, label);
    }
    assert.throws(() => latestTag('v2.0.0'), /must return an array/);
  });

  test('a manifest whose entry sits at the package root installs that one file', () => {
    withWorkspace((ws) => {
      const dir = tempDir('ext-root-entry-');
      fs.writeFileSync(path.join(dir, 'index.html'), '<main>root entry</main>\n');
      fs.writeFileSync(path.join(dir, 'README.md'), 'not part of the extension\n');
      fs.writeFileSync(path.join(dir, 'rundock.json'), JSON.stringify({ name: 'root-ext', version: '1.0.0', extension: { entry: 'index.html', match: '*.csv' } }));
      const manifest = readExtensionManifest(dir);
      assert.deepStrictEqual(extensionFileSet(dir, manifest.entry).map((f) => f.rel), ['index.html']);
      assert.deepStrictEqual(deriveFacts(dir, manifest).files, ['index.html']);
      installExtension(ws, dir, planExtensionInstall(ws, dir, SOURCE));
      assert.deepStrictEqual(fs.readdirSync(path.join(ws, ...EXTENSIONS_ROOT.split('/'), 'root-ext')), ['index.html'],
        'the entry file alone, never the whole repository');
    });
  });
});

describe('every install-flow view state is rendered through the real settings view', () => {
  test('idle, classifying, trust, installing, failed, done, offer, applying, nothing usable and not connected each draw their own state', () => {
    withWorkspace(() => {
      const shell = settingsShell();
      const previousDeps = handlers.wireExtensionDeps({ acquire: () => extensionSnapshot() });
      try {
        const text = () => shell.content().textContent.replace(/\s+/g, ' ');
        const sock = captureWs();
        assert.ok(!shell.content().querySelector('.settings-card + .settings-card'), 'idle: the field alone');
        shell.submit('someone/test-ext@v1.0.0');
        assert.ok(shell.content().querySelector('.packages-spinner') && /Reading the repository/.test(text()), 'classifying');
        assert.ok(shell.content().querySelector('.packages-still-reading'), 'classifying: the reassurance line is in the markup for the stylesheet to reveal');
        handlers.handlePlanPackageInstall(ctx(), sock, shell.sent[0]);
        shell.dispatch(sock.sent[0]);
        assert.ok(shell.content().querySelector('.extension-trust-card'), 'trust');
        shell.view.packagesConfirm();
        assert.match(text(), /Installing…/, 'installing');
        handlers.handleConfirmExtensionInstall(ctx(), sock, { type: 'confirm_extension_install', token: 'pkg-never-issued' });
        shell.dispatch({ ...sock.sent[1], token: shell.sent[1].token });
        assert.ok(shell.content().querySelector('.packages-failed') && /That didn't work/.test(text()), 'failed');
        shell.view.packagesCancel();
        shell.submit('someone/test-ext@v1.0.0');
        handlers.handlePlanPackageInstall(ctx(), sock, shell.sent[2]);
        shell.dispatch(sock.sent[2]);
        shell.view.packagesConfirm();
        handlers.handleConfirmExtensionInstall(ctx(), sock, shell.sent[3]);
        shell.dispatch(sock.sent[3]);
        assert.ok(shell.content().querySelector('.packages-success-card') && /Installed Test Ext 1\.0\.0/.test(text()), 'done');
        shell.view.packagesCancel();

        handlers.wireExtensionDeps({ acquire: () => extensionSnapshot({ agents: 1, manifest: false }), listRefs: () => [], commitOf: () => 'c'.repeat(40) });
        shell.submit('someone/pack');
        handlers.handlePlanPackageInstall(ctx(), sock, shell.sent[4]);
        shell.dispatch(sock.sent[4]);
        assert.ok(shell.content().querySelector('.packages-confirm-card:not(.extension-trust-card)'), 'offer');
        shell.view.packagesConfirm();
        assert.match(text(), /Adding to your team…/, 'applying');
        shell.view.packagesCancel();
        handlers.wireExtensionDeps({ acquire: () => tempDir('ext-empty-') });
        shell.submit('someone/empty');
        handlers.handlePlanPackageInstall(ctx(), sock, shell.sent[6]);
        shell.dispatch(sock.sent[5]);
        assert.match(text(), /Nothing to add/, 'nothing usable');
        assert.strictEqual(shell.content().querySelector('.packages-failed'), null, 'nothing usable is neutral, never the failure card');
        shell.view.packagesCancel();

        global.ws.readyState = 0;
        shell.submit('someone/test-ext@v1.0.0');
        assert.match(shell.content().querySelector('.packages-field-error').textContent, /Not connected: nothing was sent/, 'not connected');
        assert.strictEqual(shell.content().querySelector('#packages-source-link').disabled, false, 'and the field stays usable');
      } finally {
        handlers.wireExtensionDeps(previousDeps);
        shell.release();
      }
    });
  });
});

describe('the link field and every packages input carry the focus convention', () => {
  test('a focus-visible rule with the accent outline exists for each rendered input, and the token resolves under both themes', () => {
    withWorkspace(() => {
      const shell = settingsShell();
      const settingsCss = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'styles', 'views', 'settings.css'), 'utf8');
      const tokensCss = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'styles', 'tokens.css'), 'utf8');
      try {
        const inputs = [...shell.content().querySelectorAll('input')];
        assert.ok(inputs.length >= 1, 'sanity: the field rendered');
        for (const input of inputs) {
          const classes = [...input.classList];
          const ruled = classes.filter((c) => new RegExp(`\\.${c}:focus-visible\\s*\\{[^}]*outline:\\s*2px solid var\\(--accent\\)`).test(settingsCss));
          assert.ok(ruled.length > 0, `#${input.id} (${classes.join(' ')}) has no focus-visible rule with the accent outline`);
        }
        const block = (selector) => {
          const start = tokensCss.indexOf(`${selector} {`);
          assert.ok(start >= 0, `tokens.css has no ${selector} block`);
          return tokensCss.slice(start, tokensCss.indexOf('\n}', start));
        };
        // Every token the focus-visible rules and the packages rules consume,
        // read from the stylesheet's own rules rather than listed by hand.
        const consumed = new Set();
        for (const rule of settingsCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
          if (!/packages|extension|:focus-visible/.test(rule[1])) continue;
          // A use that names its own fallback (var(--mono, monospace)) owes
          // no declaration; every other use does.
          for (const v of rule[2].matchAll(/var\((--[\w-]+)(,)?/g)) if (!v[2]) consumed.add(v[1]);
        }
        assert.ok(consumed.has('--accent') && consumed.size >= 6, `sanity: the rules consume tokens (${[...consumed].join(', ')})`);
        // A token declared in a block must carry a value of the kind the
        // dark set gives it; the light set may leave a token alone (it then
        // resolves from :root, as the browser resolves it), but a light
        // redeclaration that is empty or of another kind fails here.
        const declared = (selector, token) => {
          const m = new RegExp(`${token}:\\s*([^;]*);`).exec(block(selector));
          return m ? m[1].trim() : null;
        };
        const kind = (value) => (/^(#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\()/.test(value) ? 'colour' : /^var\(/.test(value) ? 'reference' : 'other');
        for (const token of consumed) {
          const dark = declared(':root', token);
          assert.ok(dark, `${token} is declared on :root`);
          const light = declared('body.light', token);
          if (light === null) continue;
          assert.ok(light.length > 0, `${token} is redeclared empty under body.light`);
          assert.strictEqual(kind(light), kind(dark), `${token} changes kind under body.light (${dark} vs ${light})`);
        }
        assert.strictEqual(kind(declared(':root', '--accent')), 'colour', 'the accent outline is a colour');
      } finally {
        shell.release();
      }
    });
  });
});

// ===== THE 0.15.0 REVIEW: WHAT IS INSTALLED, WHO IT IS, AND WHAT ACTS UNASKED =====
describe('the trust card names the bytes, the claim, and who is being replaced', () => {
  const trust = (extra) => ({
    phase: 'trust', link: SOURCE.url, reference: SOURCE.reference, token: 't',
    manifest: { name: 'test-ext', version: '1.0.0' },
    facts: { agents: 0, skills: 0, files: ['view/index.js'], match: '*.csv' },
    replaces: null, ...extra,
  });

  test('a tag reads as pinned, with the commit it resolved to', () => {
    const copy = model.trustCopy(trust({ commit: 'a'.repeat(40) }));
    assert.strictEqual(copy.sourceLine, `From ${SOURCE.url}, pinned to v1.0.0 (commit aaaaaaa).`);
  });

  test('a tag that is not a version number still reads as pinned, with its commit', () => {
    const copy = model.trustCopy(trust({ reference: 'release-2026', commit: 'b'.repeat(40) }));
    assert.strictEqual(copy.sourceLine, `From ${SOURCE.url}, pinned to release-2026 (commit bbbbbbb).`);
  });

  test('an exact commit is named once, short', () => {
    const commit = 'c'.repeat(40);
    assert.strictEqual(model.trustCopy(trust({ reference: commit, commit })).sourceLine, `From ${SOURCE.url}, pinned to commit ccccccc.`);
    assert.strictEqual(model.trustCopy(trust({ reference: commit, commit: null })).sourceLine, `From ${SOURCE.url}, pinned to commit ccccccc.`);
  });

  test('an extension that draws a fenced language states what it draws, never "matching: null"', () => {
    const copy = model.trustCopy(trust({ facts: { agents: 0, skills: 0, files: ['index.js'], match: null, draws: 'mermaid' } }));
    assert.doesNotMatch(copy.matchLine, /null/);
    assert.strictEqual(copy.matchLine, 'It draws ```mermaid blocks where they sit in a note, and claims no file type.');
  });

  test('the same name from a different repository is said plainly, not framed as an update', () => {
    const same = model.trustCopy(trust({ replaces: { version: '0.9.0', reference: 'v0.9.0', url: SOURCE.url, sameSource: true } }));
    assert.strictEqual(same.replacesLine, 'This replaces the installed 0.9.0 (pinned at v0.9.0).');
    assert.strictEqual(same.replacesWarn, false);
    const other = model.trustCopy(trust({ replaces: { version: '0.9.0', reference: 'v0.9.0', url: 'https://github.com/elsewhere/test-ext', sameSource: false } }));
    assert.match(other.replacesLine, /already installed from a different repository \(https:\/\/github\.com\/elsewhere\/test-ext\)/);
    assert.match(other.replacesLine, /replaces it with code from https:\/\/github\.com\/someone\/test-ext/);
    assert.strictEqual(other.replacesWarn, true);
  });

  test('the plan compares the incoming repository with the installed one', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-same-'));
    try {
      fs.mkdirSync(path.join(ws, '.rundock'), { recursive: true });
      fs.writeFileSync(path.join(ws, '.rundock', 'extensions.json'), serialiseRecords([{
        name: 'test-ext', version: '0.9.0', entry: 'view/index.js', match: '*.csv',
        source: { url: 'https://github.com/elsewhere/test-ext', reference: 'v0.9.0' }, installedAt: '2026-09-01T00:00:00.000Z', root: '.rundock/extensions/test-ext',
      }]));
      const snap = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-snap-'));
      fs.writeFileSync(path.join(snap, 'rundock.json'), JSON.stringify({ name: 'test-ext', version: '1.0.0', extension: { entry: 'view/index.js', match: '*.csv' } }));
      fs.mkdirSync(path.join(snap, 'view'));
      fs.writeFileSync(path.join(snap, 'view', 'index.js'), 'export {};\n');
      const plan = planExtensionInstall(ws, snap, { ...SOURCE, commit: 'c'.repeat(40) });
      assert.deepStrictEqual(plan.replaces, { version: '0.9.0', reference: 'v0.9.0', url: 'https://github.com/elsewhere/test-ext', sameSource: false });
      assert.strictEqual(plan.source.commit, 'c'.repeat(40), 'the resolved commit travels to the card');
      const record = installExtension(ws, snap, plan);
      assert.strictEqual(record.source.commit, 'c'.repeat(40), 'and is kept on the record');
      fs.rmSync(snap, { recursive: true, force: true });
    } finally { fs.rmSync(ws, { recursive: true, force: true }); }
  });

  test('the real acquirer records the commit it fetched, and forgets it when the snapshot is discarded', () => {
    const { acquiredCommit } = require('../../lib/packages/extension-source.js');
    const { execFileSync } = require('node:child_process');
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-repo-'));
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
    try {
      git('init', '--quiet', '-b', 'main');
      fs.writeFileSync(path.join(repo, 'rundock.json'), '{}');
      git('add', '.');
      git('commit', '--quiet', '-m', 'one');
      const head = git('rev-parse', 'HEAD').trim();
      const dir = acquireWithGit({ url: repo, reference: 'main' });
      assert.strictEqual(acquiredCommit(dir), head, 'the snapshot is the commit the name resolved to');
      discardAcquisition(dir);
      assert.strictEqual(acquiredCommit(dir), null);
    } finally { fs.rmSync(repo, { recursive: true, force: true }); }
  });

});

describe('an agent or skill that acts without asking is named before it is added', () => {
  const { actsWithoutAsking } = require('../../lib/packages/import-plan.js');

  test('the keys that act unasked are read from the leading frontmatter, and a narrowing tools list is not one of them', () => {
    assert.deepStrictEqual(actsWithoutAsking('---\nname: a\nhooks:\n  Stop: []\npermissionMode: bypassPermissions\ntools: Read\n---\nbody hooks: here'), ['hooks', 'permissionMode']);
    assert.deepStrictEqual(actsWithoutAsking('---\nname: s\nallowed-tools: Bash\nmcpServers: {}\n---\n'), ['allowed-tools', 'mcpServers']);
    assert.deepStrictEqual(actsWithoutAsking('---\nname: plain\ntools: Read, Grep\n---\nhooks: not frontmatter'), []);
    assert.deepStrictEqual(actsWithoutAsking('no frontmatter at all'), []);
  });

  test('the offer and the review both say it, in words rather than key names', () => {
    const plan = { items: [], unasked: [{ kind: 'agent', slug: 'helper', keys: ['hooks'] }, { kind: 'skill', slug: 'deploy', keys: ['allowed-tools'] }] };
    const offer = model.offerCopy({ agents: 1, skills: 1, routines: [], plan });
    assert.match(offer.body, /Not everything here asks first: helper runs shell commands of its own, with no permission card; deploy pre-approves tools/);
    const quiet = model.offerCopy({ agents: 1, skills: 0, routines: [], plan: { items: [] } });
    assert.doesNotMatch(quiet.body, /asks first/, 'a package carrying none says nothing extra');
  });
});

describe('the commit a link install fetched rides on its receipt, so a later update knows what is installed', () => {
  const { decide } = require('../../lib/packages/import-plan.js');
  const COMMIT = 'c'.repeat(40);
  const addAll = (plan) => decide(plan, Object.fromEntries(plan.items.map((i) => [i.id, i.collision ? 'skip' : 'add'])));
  const receiptSource = (ws, reply) => JSON.parse(fs.readFileSync(path.join(ws, reply.receipt), 'utf8')).source;

  test('agents and skills from a link', () => {
    withWorkspace((ws) => {
      const previous = handlers.wireExtensionDeps({ acquire: () => extensionSnapshot({ agents: 1, manifest: false }), commitOf: () => COMMIT, listRefs: () => [] });
      try {
        const sock = captureWs();
        handlers.handlePlanPackageInstall(ctx(), sock, { type: 'plan_package_install', url: 'someone/pack' });
        const { token, plan } = sock.sent[0];
        handlers.handleConfirmPackageInstall(ctx(), sock, { type: 'confirm_package_install', token, approval: addAll(plan), requestId: 'r1' });
        assert.strictEqual(sock.sent[1].status, 'ready');
        assert.deepStrictEqual(receiptSource(ws, sock.sent[1]), { id: 'https://github.com/someone/pack', reference: COMMIT, commit: COMMIT },
          'a plain link to a repository with no version tags is pinned to the commit fetched');
      } finally {
        handlers.wireExtensionDeps(previous);
      }
    });
  });

  test('a package that names itself: the offer says so, and so does its receipt', () => {
    withWorkspace((ws) => {
      const snap = extensionSnapshot({ agents: 1, manifest: false });
      fs.writeFileSync(path.join(snap, 'rundock.json'), JSON.stringify({ name: 'pack', version: '1.0.0', displayName: 'Lean Agent Team' }));
      const previous = handlers.wireExtensionDeps({ acquire: () => snap, commitOf: () => COMMIT, listRefs: () => [] });
      try {
        const sock = captureWs();
        handlers.handlePlanPackageInstall(ctx(), sock, { type: 'plan_package_install', url: 'someone/pack' });
        assert.strictEqual(sock.sent[0].displayName, 'Lean Agent Team');
        const { token, plan } = sock.sent[0];
        handlers.handleConfirmPackageInstall(ctx(), sock, { type: 'confirm_package_install', token, approval: addAll(plan), requestId: 'dn' });
        assert.strictEqual(JSON.parse(fs.readFileSync(path.join(ws, sock.sent[1].receipt), 'utf8')).displayName, 'Lean Agent Team');
      } finally {
        handlers.wireExtensionDeps(previous);
      }
    });
  });

  test('the agents and skills beside an extension, offered after its trust step', () => {
    withWorkspace((ws) => {
      const previous = handlers.wireExtensionDeps({
        acquire: () => extensionSnapshot({ agents: 1 }), commitOf: () => COMMIT, pinKindOf: () => 'tag',
      });
      try {
        const sock = captureWs();
        handlers.handlePlanPackageInstall(ctx(), sock, { type: 'plan_package_install', url: 'someone/test-ext', reference: 'v1.0.0' });
        handlers.handleConfirmExtensionInstall(ctx(), sock, { type: 'confirm_extension_install', token: sock.sent[0].token });
        const { content } = sock.sent[1];
        handlers.handleConfirmPackageInstall(ctx(), sock, { type: 'confirm_package_install', token: content.token, approval: addAll(content.plan), requestId: 'r2' });
        const reply = sock.sent.find((m) => m.type === 'package_import_result');
        assert.deepStrictEqual(receiptSource(ws, reply), { id: 'https://github.com/someone/test-ext', reference: 'v1.0.0', commit: COMMIT });
      } finally {
        handlers.wireExtensionDeps(previous);
      }
    });
  });
});

describe('a plain link to agents and skills installs the newest release, and the head only when there is none', () => {
  const { decide } = require('../../lib/packages/import-plan.js');
  const addEvery = (plan) => decide(plan, Object.fromEntries(plan.items.map((i) => [i.id, 'add'])));
  test('with version tags, the head is read to classify and the newest tag is what is offered and recorded', () => {
    withWorkspace((ws) => {
      const acquiredAt = [];
      const previous = handlers.wireExtensionDeps({
        acquire: (source) => { acquiredAt.push(source.reference); return extensionSnapshot({ agents: 1, manifest: false }); },
        listRefs: () => ['v1.10.0', 'nightly', 'v1.2.0'],
      });
      try {
        const sock = captureWs();
        handlers.handlePlanPackageInstall(ctx(), sock, { type: 'plan_package_install', url: 'someone/pack' });
        assert.deepStrictEqual(acquiredAt, [null, 'v1.10.0']);
        assert.strictEqual(sock.sent[0].type, 'package_import_plan');
        assert.deepStrictEqual(sock.sent[0].plan.source, { id: 'https://github.com/someone/pack', reference: 'v1.10.0' });
      } finally {
        handlers.wireExtensionDeps(previous);
      }
    });
  });

  test('without version tags, the exact commit fetched is offered, planned and recorded in the receipt', () => {
    const FETCHED = 'c'.repeat(40);
    for (const listing of [[], ['nightly', 'release-2020']]) {
      withWorkspace((ws) => {
        const acquiredAt = [];
        const previous = handlers.wireExtensionDeps({
          acquire: (source) => { acquiredAt.push(source.reference); return extensionSnapshot({ agents: 1, manifest: false }); },
          listRefs: () => listing,
          commitOf: () => FETCHED,
        });
        try {
          const sock = captureWs();
          handlers.handlePlanPackageInstall(ctx(), sock, { type: 'plan_package_install', url: 'someone/pack' });
          assert.strictEqual(sock.sent[0].type, 'package_import_plan', String(listing));
          assert.deepStrictEqual(sock.sent[0].plan.source, { id: 'https://github.com/someone/pack', reference: FETCHED },
            'pinned to the commit fetched before planning');
          assert.deepStrictEqual(acquiredAt, [null], 'the head read is what is offered: nothing is fetched twice');
          handlers.handleConfirmPackageInstall(ctx(), sock, { type: 'confirm_package_install', token: sock.sent[0].token, approval: addEvery(sock.sent[0].plan) });
          assert.strictEqual(sock.sent[1].type, 'package_import_result');
          const receipt = JSON.parse(fs.readFileSync(path.join(ws, sock.sent[1].receipt), 'utf8'));
          assert.deepStrictEqual(receipt.source, { id: 'https://github.com/someone/pack', reference: FETCHED, commit: FETCHED }, 'the receipt names the commit');
        } finally {
          handlers.wireExtensionDeps(previous);
        }
      });
    }
  });

  test('without version tags, a fetched commit that cannot be read is refused by name, and the read is discarded', () => {
    withWorkspace((ws) => {
      let snap = null;
      const previous = handlers.wireExtensionDeps({
        acquire: () => { snap = extensionSnapshot({ agents: 1, manifest: false }); return snap; },
        listRefs: () => [],
        commitOf: () => null,
      });
      try {
        const sock = captureWs();
        handlers.handlePlanPackageInstall(ctx(), sock, { type: 'plan_package_install', url: 'someone/pack' });
        assert.strictEqual(sock.sent.length, 1, 'one refusal answers the plan');
        assert.strictEqual(sock.sent[0].type, 'package_install_error');
        assert.strictEqual(sock.sent[0].code, 'no-tags');
        assert.match(sock.sent[0].message, /no version tags/);
        assert.strictEqual(fs.existsSync(snap), false, 'the read is discarded, not planned');
        assert.deepStrictEqual(fs.readdirSync(ws), [], 'and the workspace is untouched');
      } finally {
        handlers.wireExtensionDeps(previous);
      }
    });
  });

  test('through the real fetch, a content repository with no tags is installed at its head commit, and the receipt records it', () => {
    withWorkspace((ws) => {
      const repo = tempDir('content-tagless-repo-');
      const git = (args) => String(execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })).trim();
      git(['init', '--quiet']);
      fs.mkdirSync(path.join(repo, '.claude', 'agents'), { recursive: true });
      fs.writeFileSync(path.join(repo, '.claude', 'agents', 'helper.md'), '---\nname: helper\n---\nAn agent.\n');
      git(['add', '.']);
      git(['commit', '--quiet', '-m', 'one']);
      const head = git(['rev-parse', 'HEAD']);
      assert.deepStrictEqual(listRefsWithGit(repo), [], 'the repository really has no tags');
      const previous = handlers.wireExtensionDeps({
        acquire: (source) => acquireWithGit({ ...source, url: repo }),
        listRefs: () => listRefsWithGit(repo),
        commitOf: acquiredCommit,
        pinKindOf: acquiredPinKind,
      });
      try {
        const sock = captureWs();
        handlers.handlePlanPackageInstall(ctx(), sock, { type: 'plan_package_install', url: 'someone/pack' });
        assert.strictEqual(sock.sent[0].type, 'package_import_plan');
        assert.strictEqual(sock.sent[0].plan.source.reference, head, 'planned at the head commit');
        handlers.handleConfirmPackageInstall(ctx(), sock, { type: 'confirm_package_install', token: sock.sent[0].token, approval: addEvery(sock.sent[0].plan) });
        assert.strictEqual(sock.sent[1].type, 'package_import_result');
        const receipt = JSON.parse(fs.readFileSync(path.join(ws, sock.sent[1].receipt), 'utf8'));
        assert.strictEqual(receipt.source.reference, head, 'the receipt records the exact commit');
        assert.strictEqual(receipt.source.commit, head);
      } finally {
        handlers.wireExtensionDeps(previous);
      }
    });
  });

  test('a listing that fails is a refusal, never a quiet install of the head', () => {
    withWorkspace((ws) => {
      let snap = null;
      const previous = handlers.wireExtensionDeps({
        acquire: () => { snap = extensionSnapshot({ agents: 1, manifest: false }); return snap; },
        listRefs: () => { throw Object.assign(new Error('network down'), { code: 'acquire-failed' }); },
      });
      try {
        const sock = captureWs();
        handlers.handlePlanPackageInstall(ctx(), sock, { type: 'plan_package_install', url: 'someone/pack' });
        assert.strictEqual(sock.sent[0].type, 'package_install_error');
        assert.match(sock.sent[0].message, /network down/);
        assert.strictEqual(fs.existsSync(snap), false, 'the read is discarded');
        assert.deepStrictEqual(fs.readdirSync(ws), []);
      } finally {
        handlers.wireExtensionDeps(previous);
      }
    });
  });

  test('a listing that cannot be read is a refusal too', () => {
    withWorkspace(() => {
      const previous = handlers.wireExtensionDeps({ acquire: () => extensionSnapshot({ agents: 1, manifest: false }), listRefs: () => 'not a listing' });
      try {
        const sock = captureWs();
        handlers.handlePlanPackageInstall(ctx(), sock, { type: 'plan_package_install', url: 'someone/pack' });
        assert.strictEqual(sock.sent[0].type, 'package_install_error');
      } finally {
        handlers.wireExtensionDeps(previous);
      }
    });
  });

  test('a link that names its reference is never second-guessed', () => {
    withWorkspace(() => {
      let listed = 0;
      const previous = handlers.wireExtensionDeps({ acquire: () => extensionSnapshot({ agents: 1, manifest: false }), listRefs: () => { listed += 1; return ['v9.0.0']; } });
      try {
        const sock = captureWs();
        handlers.handlePlanPackageInstall(ctx(), sock, { type: 'plan_package_install', url: 'someone/pack', reference: 'v1.0.0' });
        assert.strictEqual(sock.sent[0].plan.source.reference, 'v1.0.0');
        assert.strictEqual(listed, 0);
      } finally {
        handlers.wireExtensionDeps(previous);
      }
    });
  });
});

// Opening Packages asks every installed package for updates, and each answer
// redraws the section. A redraw must never take back what the person is
// typing: a link half pasted when an update answer lands stays in the field,
// so pressing Add reads the link, not an empty field. A change of workspace
// is the one redraw that clears it, because the link was typed for the
// workspace that is gone.
describe('a redraw while the person types keeps the typed link', () => {
  test('an update answer arriving mid-typing leaves the field as typed, and Add reads it', () => {
    withWorkspace(() => {
      const shell = settingsShell();
      try {
        shell.content().querySelector('#packages-source-link').value = 'someone/typed';
        shell.view.packagesReplyArrived({ type: 'package_update_checked' });
        assert.strictEqual(shell.content().querySelector('#packages-source-link').value, 'someone/typed',
          'the redraw kept what was typed');
        shell.view.packagesSubmit();
        assert.deepStrictEqual(shell.sent.map((m) => [m.type, m.url]), [['plan_package_install', 'someone/typed']],
          'Add read the typed link');
      } finally {
        shell.release();
      }
    });
  });

  test('a change of workspace clears the typed link', () => {
    withWorkspace(() => {
      const shell = settingsShell();
      try {
        shell.content().querySelector('#packages-source-link').value = 'someone/typed';
        shell.view.packagesWorkspaceChanged();
        assert.strictEqual(shell.content().querySelector('#packages-source-link').value, '');
      } finally {
        shell.release();
      }
    });
  });
});
