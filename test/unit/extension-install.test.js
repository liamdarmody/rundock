'use strict';
// Installing an extension from a GitHub link, driven at every seam the flow
// has: the source rules, the acquisition, the trust step's derived facts,
// the consent order, the installed record and the update check that reads
// it, and the uninstall that removes exactly what the install created.
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
  parseGitHubSource, acquireWithGit, discardAcquisition, listRefsWithGit, MOVING_NAMES,
} = require('../../lib/packages/extension-source.js');
const { readExtensionManifest, deriveFacts, extensionFileSet } = require('../../lib/packages/extension-manifest.js');
const {
  RECORDS_PATH, EXTENSIONS_ROOT, readExtensionRecords, serialiseRecords, checkForUpdate,
} = require('../../lib/packages/extension-record.js');
const {
  planExtensionInstall, installExtension, uninstallExtension,
} = require('../../lib/packages/extension-install.js');
const handlers = require('../../lib/protocol/handlers/packages.js');
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
function extensionSnapshot({ name = 'test-ext', version = '1.0.0', agents = 0, skills = 0 } = {}) {
  const dir = tempDir('ext-snap-');
  fs.mkdirSync(path.join(dir, 'view'));
  fs.writeFileSync(path.join(dir, 'view', 'index.html'), '<main>rendered by the extension</main>\n');
  fs.writeFileSync(path.join(dir, 'view', 'style.css'), 'main { display: block; }\n');
  fs.writeFileSync(path.join(dir, 'rundock.json'), JSON.stringify({
    name, version, extension: { entry: 'view/index.html', match: '*.dataview.md' },
  }, null, 2));
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

  test('a missing reference is refused with the reason, never defaulted', () => {
    assert.throws(() => parseGitHubSource('someone/test-ext', ''),
      (e) => e.code === 'unpinned-reference' && /required/.test(e.message)
        && /moving branch/.test(e.message),
      'the refusal names why a pin is required rather than silently choosing a branch');
  });

  test('every well-known moving name is refused as not a pin', () => {
    for (const name of MOVING_NAMES) {
      assert.throws(() => parseGitHubSource('someone/test-ext', name),
        (e) => e.code === 'unpinned-reference',
        `${name} must not pass as a pin`);
    }
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

  test('the trust copy says the honest halves: sandboxed view, unsandboxed agents, no review', () => {
    const state = {
      phase: 'ext-trust', url: SOURCE.url, reference: SOURCE.reference, token: 't',
      manifest: { name: 'test-ext', version: '1.0.0' },
      facts: { agents: 2, skills: 1, files: ['view/index.html'], match: '*.dataview.md' },
      replaces: null,
    };
    const copy = model.extTrustCopy(state);
    assert.match(copy.body, /runs sandboxed/, 'the view half of the boundary is stated');
    assert.match(copy.body, /not sandboxed.*same access your own agents have/,
      'the agents half is stated, because it is the larger part of the blast radius');
    assert.match(copy.body, /larger part of what you are trusting/);
    assert.match(copy.body, /Rundock does not review extensions/,
      'the no-review fact is on the screen, not only in a document');
    assert.match(copy.factsLead, /Read from the package itself, not from its author/,
      'derived beats declared, and the reader is told which kind these are');
  });

  test('the model sends nothing except on an explicit ask', () => {
    let state = model.extInitial();
    assert.strictEqual(model.extReply(state, { type: 'anything' }).send, undefined);
    const submitted = model.extSubmit(state, 'someone/test-ext', 'v1');
    assert.strictEqual(submitted.send.type, 'plan_extension_install');
    const trusting = model.extReply(submitted.state, {
      type: 'extension_install_plan', token: 'tok',
      manifest: { name: 'x', version: '1' }, facts: { agents: 0, skills: 0, files: [], match: 'm' },
    });
    assert.strictEqual(trusting.send, undefined, 'arriving at the trust step asks for nothing');
    assert.strictEqual(model.extConfirm(trusting.state).send.type, 'confirm_extension_install');
    assert.strictEqual(model.extDecline(trusting.state).send.type, 'decline_extension_install');
  });
});

// A capture socket in the shape every handler test in this repository uses.
function captureWs() {
  return { readyState: 1, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); } };
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

describe('consent order at the wire: plan, then one answer', () => {
  test('decline discards the acquired snapshot and the workspace is untouched', () => {
    withWorkspace((ws) => {
      const snap = extensionSnapshot();
      const previousDeps = handlers.wireExtensionDeps({ acquire: () => snap });
      try {
        const sock = captureWs();
        handlers.handlePlanExtensionInstall({}, sock, { type: 'plan_extension_install', url: 'someone/test-ext', reference: 'v1.0.0' });
        const plan = sock.sent[0];
        assert.strictEqual(plan.type, 'extension_install_plan');
        assert.ok(fs.existsSync(snap), 'the snapshot waits between offer and answer');

        handlers.handleDeclineExtensionInstall({}, sock, { type: 'decline_extension_install', token: plan.token });
        assert.strictEqual(sock.sent[1].type, 'extension_install_declined');
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
        handlers.handlePlanExtensionInstall({}, sock, { type: 'plan_extension_install', url: 'someone/test-ext', reference: 'main' });
        assert.strictEqual(sock.sent[0].type, 'extension_install_error');
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
        handlers.handlePlanExtensionInstall({}, sock, { type: 'plan_extension_install', url: 'someone/test-ext', reference: '--upload-pack=evil' });
        assert.strictEqual(sock.sent[0].type, 'extension_install_error');
        assert.strictEqual(sock.sent[0].code, 'unpinned-reference');
        assert.strictEqual(acquired, 0, 'refusal comes before any fetch, so nothing ever reaches a git argv');
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
      handlers.handleConfirmExtensionInstall({}, sock, { type: 'confirm_extension_install', token: 'ext-never-issued' });
      assert.strictEqual(sock.sent[0].type, 'extension_install_error');
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
        handlers.handlePlanExtensionInstall({}, sock, { type: 'plan_extension_install', url: 'someone/test-ext', reference: 'v1.0.0' });
        const token = sock.sent[0].token;
        handlers.handleConfirmExtensionInstall({}, sock, { type: 'confirm_extension_install', token });
        assert.strictEqual(sock.sent[1].type, 'extension_install_result');
        const afterFirst = fs.statSync(path.join(ws, ...EXTENSIONS_ROOT.split('/'), 'test-ext', 'view', 'index.html')).mtimeMs;

        handlers.handleConfirmExtensionInstall({}, sock, { type: 'confirm_extension_install', token });
        assert.strictEqual(sock.sent[2].type, 'extension_install_error',
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
        handlers.handlePlanExtensionInstall({}, sock, { type: 'plan_extension_install', url: 'someone/test-ext', reference: 'v1.0.0' });
        const token = sock.sent[0].token;
        assert.ok(fs.existsSync(snap), 'sanity: the snapshot is waiting between offer and answer');

        sock.dropConnection();
        assert.strictEqual(fs.existsSync(snap), false, 'the connection dropped and the fetched snapshot was left behind');

        handlers.handleConfirmExtensionInstall({}, sock, { type: 'confirm_extension_install', token });
        assert.strictEqual(sock.sent[1].type, 'extension_install_error',
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
        handlers.handlePlanExtensionInstall({}, sock, { type: 'plan_extension_install', url: 'someone/first-ext', reference: 'v1.0.0' });
        const firstToken = sock.sent[0].token;
        assert.ok(fs.existsSync(first), 'sanity: the first offer is waiting');

        handlers.handlePlanExtensionInstall({}, sock, { type: 'plan_extension_install', url: 'someone/second-ext', reference: 'v1.0.0' });
        assert.strictEqual(fs.existsSync(first), false,
          'reading a second package on the same connection abandoned the first, unanswered offer');
        assert.ok(fs.existsSync(second), 'the second offer is the one now waiting');

        handlers.handleConfirmExtensionInstall({}, sock, { type: 'confirm_extension_install', token: firstToken });
        assert.strictEqual(sock.sent[2].type, 'extension_install_error',
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
        handlers.handlePlanExtensionInstall({}, sock, { type: 'plan_extension_install', url: 'someone/test-ext', reference: 'v1.0.0' });
        handlers.handleConfirmExtensionInstall({}, sock, { type: 'confirm_extension_install', token: sock.sent[0].token });
        const result = sock.sent[1];
        assert.strictEqual(result.type, 'extension_install_result');

        const records = readExtensionRecords(ws);
        assert.strictEqual(records.length, 1);
        assert.strictEqual(records[0].source.url, 'https://github.com/someone/test-ext',
          'the record carries the source URL, so no update ever asks for it again');
        assert.strictEqual(records[0].source.reference, 'v1.0.0', 'and the exact pin');
        assert.ok(fs.existsSync(path.join(ws, '.claude', 'rundock', 'extensions', 'test-ext', 'view', 'index.html')),
          'the extension files landed under the Rundock-owned root');

        const installCalls = unitCalls.filter((c) => c.dirs.length > 0);
        assert.strictEqual(installCalls.length, 1, 'one transaction carried the install');
        assert.deepStrictEqual(installCalls[0], {
          files: [RECORDS_PATH],
          dirs: ['.claude/rundock/extensions/test-ext'],
        }, 'and it carried the record and the files together, so neither can exist without the other');

        assert.strictEqual(fs.existsSync(snap), false, 'the snapshot is discarded once its bytes have landed');
      } finally {
        handlers.wireExtensionDeps(previousDeps);
      }
    });
  });

  test('the update check reads the record and reports the moved reference, end to end', () => {
    withWorkspace((ws) => {
      const snap = extensionSnapshot();
      const asked = [];
      const previousDeps = handlers.wireExtensionDeps({
        acquire: () => snap,
        listRefs: (url) => { asked.push(url); return ['v1.0.0', 'v1.1.0']; },
      });
      try {
        const sock = captureWs();
        handlers.handlePlanExtensionInstall({}, sock, { type: 'plan_extension_install', url: 'someone/test-ext', reference: 'v1.0.0' });
        handlers.handleConfirmExtensionInstall({}, sock, { type: 'confirm_extension_install', token: sock.sent[0].token });

        handlers.handleCheckExtensionUpdate({}, sock, { type: 'check_extension_update', name: 'test-ext' });
        const status = sock.sent[2];
        assert.strictEqual(status.type, 'extension_update_status');
        assert.strictEqual(status.current, 'v1.0.0');
        assert.deepStrictEqual(status.newer, ['v1.1.0'], 'the moved reference is reported');
        assert.deepStrictEqual(asked, ['https://github.com/someone/test-ext'],
          'the URL the remote was asked about came from the record, nowhere else');
      } finally {
        handlers.wireExtensionDeps(previousDeps);
      }
    });
  });

  test('checkForUpdate takes a record and a lister, and refuses a record without a source', () => {
    assert.throws(() => checkForUpdate({ name: 'x', source: { url: 'u' } }, () => []),
      /source\.url and source\.reference/);
    const status = checkForUpdate(
      { name: 'x', source: { url: 'u', reference: 'v1.0.0' } },
      (url) => (url === 'u' ? ['v1.0.0', 'v2.0.0'] : []),
    );
    assert.deepStrictEqual(status.newer, ['v2.0.0']);
  });

  test('a pin already the newest tag in the listing is offered nothing, never a downgrade', () => {
    // Every tag ls-remote could return is equal to or behind the pin: an
    // update check that reported anything here would be offering a
    // downgrade as an upgrade, which is the exact defect this proves absent.
    const status = checkForUpdate(
      { name: 'x', source: { url: 'u', reference: 'v2.0.0' } },
      () => ['v1.0.0', 'v1.1.0', 'v2.0.0'],
    );
    assert.deepStrictEqual(status.newer, [], 'the pin is already the newest tag in the listing');
  });

  test('older and equal tags are excluded, and the reported order is numeric rather than lexicographic', () => {
    // v10.0.0 sorts BEFORE v2.0.0 lexicographically, which is exactly what
    // `git ls-remote --tags` returns and exactly the order this must not
    // repeat: the update check establishes its own true numeric order
    // instead of forwarding whatever the listing happened to be in.
    const status = checkForUpdate(
      { name: 'x', source: { url: 'u', reference: 'v1.1.0' } },
      () => ['v1.0.0', 'v10.0.0', 'v1.1.0', 'v2.0.0'],
    );
    assert.deepStrictEqual(status.newer, ['v2.0.0', 'v10.0.0'],
      'v1.0.0 (older) and v1.1.0 (equal to the pin) are left out, and v2.0.0 sorts before v10.0.0');
  });

  test('a reference this file cannot parse as a version is never reported as newer', () => {
    // A moved branch tip, a release codename, anything not a plain vX.Y.Z tag
    // is left out rather than guessed at: reporting it as "newer" would be an
    // ordering claim this function has no way to back up.
    const status = checkForUpdate(
      { name: 'x', source: { url: 'u', reference: 'v1.0.0' } },
      () => ['v1.0.0', 'edge', 'release-42', 'v1.0.0-rc1'],
    );
    assert.deepStrictEqual(status.newer, [], 'nothing unparseable is offered as an update');
  });
});

describe('an update begins from the installed record, never from the caller', () => {
  test('install, check, and apply an update read the URL from the record end to end, with no URL given by this test', () => {
    withWorkspace((ws) => {
      const v1 = extensionSnapshot();
      const v2 = extensionSnapshot({ version: '2.0.0' });
      fs.writeFileSync(path.join(v2, 'view', 'extra.js'), 'export {};\n');
      let acquireCalls = 0;
      const asked = [];
      const previousDeps = handlers.wireExtensionDeps({
        acquire: () => (acquireCalls++ === 0 ? v1 : v2),
        listRefs: (url) => { asked.push(url); return ['v1.0.0', 'v2.0.0']; },
      });
      try {
        const sock = captureWs();
        // Install at the pinned reference.
        handlers.handlePlanExtensionInstall({}, sock, { type: 'plan_extension_install', url: 'someone/test-ext', reference: 'v1.0.0' });
        handlers.handleConfirmExtensionInstall({}, sock, { type: 'confirm_extension_install', token: sock.sent[0].token });
        assert.strictEqual(sock.sent[1].type, 'extension_install_result');

        // The remote reports a moved reference.
        handlers.handleCheckExtensionUpdate({}, sock, { type: 'check_extension_update', name: 'test-ext' });
        const status = sock.sent[2];
        assert.strictEqual(status.type, 'extension_update_status');
        assert.deepStrictEqual(status.newer, ['v2.0.0']);

        // The update is planned from the record: only a name and the chosen
        // reference are supplied here, and the source URL comes from nowhere
        // this test wrote.
        handlers.handlePlanExtensionUpdate({}, sock, { type: 'plan_extension_update', name: 'test-ext', reference: status.newer[0] });
        const updatePlan = sock.sent[3];
        assert.strictEqual(updatePlan.type, 'extension_install_plan');
        assert.strictEqual(updatePlan.source.url, 'https://github.com/someone/test-ext',
          'the source URL for the update came from the installed record');
        assert.deepStrictEqual(updatePlan.replaces, { version: '1.0.0', reference: 'v1.0.0' },
          'the trust step is reopened, naming what this replaces');

        handlers.handleConfirmExtensionInstall({}, sock, { type: 'confirm_extension_install', token: updatePlan.token });
        assert.strictEqual(sock.sent[4].type, 'extension_install_result');

        const records = readExtensionRecords(ws);
        assert.strictEqual(records.length, 1, 'an update is a replacement, never a second entry');
        assert.strictEqual(records[0].source.reference, 'v2.0.0');
        assert.strictEqual(records[0].source.url, 'https://github.com/someone/test-ext',
          'the same source URL survived the update');
        assert.ok(fs.existsSync(path.join(ws, ...EXTENSIONS_ROOT.split('/'), 'test-ext', 'view', 'extra.js')),
          'the newer files replaced the old ones under the same root');

        const installCalls = unitCalls.filter((c) => c.dirs.length > 0);
        assert.strictEqual(installCalls.length, 2,
          'one transaction carried the install and one carried the update, each with the record and the directory together');

        assert.deepStrictEqual(asked, ['https://github.com/someone/test-ext'],
          'the update check asked about the URL the record carried, never one the caller supplied');

        // The uninstall this record now supports is driven at the wire too,
        // so the reply shape a client would actually read is proven here,
        // not only the library call underneath it.
        handlers.handleUninstallExtension({}, sock, { type: 'uninstall_extension', name: 'test-ext' });
        const uninstalled = sock.sent[5];
        assert.strictEqual(uninstalled.type, 'extension_uninstalled');
        assert.match(uninstalled.untouched, /ordinary workspace files and remain/);
        assert.strictEqual(fs.existsSync(path.join(ws, ...EXTENSIONS_ROOT.split('/'), 'test-ext')), false);
        assert.deepStrictEqual(readExtensionRecords(ws), []);
      } finally {
        handlers.wireExtensionDeps(previousDeps);
      }
    });
  });

  test('planning an update for a name with no installed record is refused, and acquires nothing', () => {
    withWorkspace(() => {
      let acquired = 0;
      const previousDeps = handlers.wireExtensionDeps({ acquire: () => { acquired += 1; return extensionSnapshot(); } });
      try {
        const sock = captureWs();
        handlers.handlePlanExtensionUpdate({}, sock, { type: 'plan_extension_update', name: 'ghost', reference: 'v2.0.0' });
        assert.strictEqual(sock.sent[0].type, 'extension_install_error');
        assert.match(sock.sent[0].message, /no extension named "ghost" is installed/);
        assert.strictEqual(acquired, 0, 'nothing installed means nothing to acquire');
      } finally {
        handlers.wireExtensionDeps(previousDeps);
      }
    });
  });

  test('planning an update with a blank reference is refused, and acquires nothing', () => {
    withWorkspace(() => {
      const v1 = extensionSnapshot();
      let acquired = 0;
      const previousDeps = handlers.wireExtensionDeps({ acquire: () => { acquired += 1; return v1; } });
      try {
        const sock = captureWs();
        handlers.handlePlanExtensionInstall({}, sock, { type: 'plan_extension_install', url: 'someone/test-ext', reference: 'v1.0.0' });
        handlers.handleConfirmExtensionInstall({}, sock, { type: 'confirm_extension_install', token: sock.sent[0].token });
        acquired = 0;
        handlers.handlePlanExtensionUpdate({}, sock, { type: 'plan_extension_update', name: 'test-ext', reference: '   ' });
        assert.strictEqual(sock.sent[2].type, 'extension_install_error');
        // The blank reference goes through the same validation a fresh
        // install's pasted reference does, so it carries that refusal's
        // reason and code rather than a bespoke message.
        assert.match(sock.sent[2].message, /a pinned reference .* is required/);
        assert.strictEqual(sock.sent[2].code, 'unpinned-reference');
        assert.strictEqual(acquired, 0);
      } finally {
        handlers.wireExtensionDeps(previousDeps);
      }
    });
  });

  test('a url the update message carries is ignored; the record\'s own url is used regardless', () => {
    withWorkspace(() => {
      const v1 = extensionSnapshot();
      const v2 = extensionSnapshot({ version: '2.0.0' });
      const asked = [];
      let calls = 0;
      const previousDeps = handlers.wireExtensionDeps({
        acquire: (source) => { asked.push(source.url); return calls++ === 0 ? v1 : v2; },
      });
      try {
        const sock = captureWs();
        handlers.handlePlanExtensionInstall({}, sock, { type: 'plan_extension_install', url: 'someone/test-ext', reference: 'v1.0.0' });
        handlers.handleConfirmExtensionInstall({}, sock, { type: 'confirm_extension_install', token: sock.sent[0].token });

        handlers.handlePlanExtensionUpdate({}, sock, {
          type: 'plan_extension_update', name: 'test-ext', reference: 'v2.0.0',
          url: 'https://github.com/attacker/evil',
        });
        const updatePlan = sock.sent[2];
        assert.strictEqual(updatePlan.type, 'extension_install_plan');
        assert.strictEqual(updatePlan.source.url, 'https://github.com/someone/test-ext',
          'the message carried a different url; the record\'s url is the one that was used');
        assert.deepStrictEqual(asked, ['https://github.com/someone/test-ext', 'https://github.com/someone/test-ext'],
          'the acquirer was never handed the url the message tried to supply');
      } finally {
        handlers.wireExtensionDeps(previousDeps);
      }
    });
  });

  test('handlePlanExtensionUpdate answers rather than throws when the records file is unreadable', () => {
    withWorkspace((ws) => {
      const recordsPath = path.join(ws, ...RECORDS_PATH.split('/'));
      fs.mkdirSync(path.dirname(recordsPath), { recursive: true });
      fs.writeFileSync(recordsPath, '{ not valid json');
      let acquired = 0;
      const previousDeps = handlers.wireExtensionDeps({ acquire: () => { acquired += 1; return extensionSnapshot(); } });
      try {
        const sock = captureWs();
        assert.doesNotThrow(() => {
          handlers.handlePlanExtensionUpdate({}, sock, { type: 'plan_extension_update', name: 'test-ext', reference: 'v2.0.0' });
        }, 'a handler answers, it never throws out of the dispatch');
        assert.strictEqual(sock.sent[0].type, 'extension_install_error');
        assert.match(sock.sent[0].message, /extension records unreadable/);
        assert.strictEqual(acquired, 0, 'nothing was acquired for a request that could not even read the record');
      } finally {
        handlers.wireExtensionDeps(previousDeps);
      }
    });
  });

  test('handlePlanExtensionUpdate answers rather than throws when the installed record has no source', () => {
    withWorkspace((ws) => {
      const recordsPath = path.join(ws, ...RECORDS_PATH.split('/'));
      fs.mkdirSync(path.dirname(recordsPath), { recursive: true });
      fs.writeFileSync(recordsPath, JSON.stringify({
        schema: 'rundock.extensions/v1',
        extensions: [{
          name: 'test-ext', version: '1.0.0', entry: 'view/index.html', match: '*.md',
          installedAt: '2026-01-01T00:00:00.000Z', root: `${EXTENSIONS_ROOT}/test-ext`,
        }],
      }, null, 2));
      let acquired = 0;
      const previousDeps = handlers.wireExtensionDeps({ acquire: () => { acquired += 1; return extensionSnapshot(); } });
      try {
        const sock = captureWs();
        assert.doesNotThrow(() => {
          handlers.handlePlanExtensionUpdate({}, sock, { type: 'plan_extension_update', name: 'test-ext', reference: 'v2.0.0' });
        }, 'a handler answers, it never throws out of the dispatch');
        assert.strictEqual(sock.sent[0].type, 'extension_install_error');
        assert.match(sock.sent[0].message, /carries no source url/);
        assert.strictEqual(acquired, 0);
      } finally {
        handlers.wireExtensionDeps(previousDeps);
      }
    });
  });

  test('a stored url that is not a canonical GitHub url is refused, revalidated the same way a fresh install validates a pasted one', () => {
    withWorkspace((ws) => {
      const recordsPath = path.join(ws, ...RECORDS_PATH.split('/'));
      fs.mkdirSync(path.dirname(recordsPath), { recursive: true });
      fs.writeFileSync(recordsPath, JSON.stringify({
        schema: 'rundock.extensions/v1',
        extensions: [{
          name: 'test-ext', version: '1.0.0', entry: 'view/index.html', match: '*.md',
          source: { url: 'not a url at all', reference: 'v1.0.0' },
          installedAt: '2026-01-01T00:00:00.000Z', root: `${EXTENSIONS_ROOT}/test-ext`,
        }],
      }, null, 2));
      let acquired = 0;
      const previousDeps = handlers.wireExtensionDeps({ acquire: () => { acquired += 1; return extensionSnapshot(); } });
      try {
        const sock = captureWs();
        handlers.handlePlanExtensionUpdate({}, sock, { type: 'plan_extension_update', name: 'test-ext', reference: 'v2.0.0' });
        assert.strictEqual(sock.sent[0].type, 'extension_install_error');
        assert.match(sock.sent[0].message, /not a GitHub repository/);
        assert.strictEqual(acquired, 0, 'the stored url failed validation before any acquisition');
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
      handlers.handlePlanExtensionInstall({}, sock, { type: 'plan_extension_install', url: 'someone/test-ext', reference: 'v1.0.0' });
      const token = sock.sent[0].token;
      assert.ok(fs.existsSync(snap), 'sanity: the offer is waiting between offer and answer');

      // Another window moves the server's served workspace before this
      // window answers. The facts this window read, including whether the
      // install replaces anything, were true of workspace A alone.
      config.setWorkspace(workspaceB);
      handlers.handleConfirmExtensionInstall({}, sock, { type: 'confirm_extension_install', token });

      assert.strictEqual(sock.sent[1].type, 'extension_install_error');
      assert.strictEqual(sock.sent[1].code, 'workspace-changed');
      assert.match(sock.sent[1].message, /the workspace changed/);
      assert.strictEqual(fs.existsSync(snap), false, 'the abandoned snapshot is discarded, not installed');
      assert.deepStrictEqual(readExtensionRecords(workspaceA), [],
        'workspace A, where the trust step was shown, was never written to');
      assert.deepStrictEqual(readExtensionRecords(workspaceB), [],
        'workspace B, current at confirm time, was never written to either');

      handlers.handleConfirmExtensionInstall({}, sock, { type: 'confirm_extension_install', token });
      assert.strictEqual(sock.sent[2].type, 'extension_install_error',
        'the token died with its refused use, the same as any other confirm');
    } finally {
      handlers.wireExtensionDeps(previousDeps);
      config.setWorkspace(previousWorkspace);
    }
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

describe('uninstall removes what the install created, and names what stays', () => {
  test('the directory and the record leave together; imported content is not touched', () => {
    withWorkspace((ws) => {
      const snap = extensionSnapshot();
      const importedAgent = path.join(ws, '.claude', 'agents');
      fs.mkdirSync(importedAgent, { recursive: true });
      fs.writeFileSync(path.join(importedAgent, 'helper-0.md'), '---\nname: helper-0\n---\n');

      const record = installExtension(ws, snap, planExtensionInstall(ws, snap, SOURCE));
      assert.ok(fs.existsSync(path.join(ws, ...record.root.split('/'))));

      const outcome = uninstallExtension(ws, 'test-ext');
      assert.strictEqual(fs.existsSync(path.join(ws, ...record.root.split('/'))), false,
        'the files the install created are gone');
      assert.deepStrictEqual(readExtensionRecords(ws), [], 'and the record of having been installed left with them');
      assert.match(outcome.untouched, /ordinary workspace files and remain/,
        'what stays is named rather than implied');
      assert.ok(fs.existsSync(path.join(importedAgent, 'helper-0.md')),
        'imported agents are not this operation\'s to touch');
    });
  });

  test('uninstalling what is not installed is a named refusal', () => {
    withWorkspace((ws) => {
      assert.throws(() => uninstallExtension(ws, 'ghost'), (e) => e.code === 'not-installed');
    });
  });

  // The persisted `root` cannot be trusted: a records file that arrives with
  // a shared or copied workspace, exactly as the module header describes,
  // can carry anything there. These two prove uninstall does not follow it
  // off the workspace, or crash trying, when it does.
  test('a record whose root escapes the extensions directory is refused, and nothing outside it is removed', () => {
    withWorkspace((ws) => {
      const snap = extensionSnapshot();
      installExtension(ws, snap, planExtensionInstall(ws, snap, SOURCE));

      const outsideMarker = tempDir('ext-outside-');
      const markerFile = path.join(outsideMarker, 'must-survive.txt');
      fs.writeFileSync(markerFile, 'must survive\n');
      const escapingRoot = path.relative(ws, outsideMarker).split(path.sep).join('/');

      const records = readExtensionRecords(ws);
      records[0].root = escapingRoot;
      fs.writeFileSync(path.join(ws, ...RECORDS_PATH.split('/')), serialiseRecords(records));

      assert.throws(() => uninstallExtension(ws, 'test-ext'), (e) => e.code === 'invalid-record');
      assert.ok(fs.existsSync(markerFile), 'the escaping path was never touched');
      assert.ok(fs.existsSync(path.join(ws, ...EXTENSIONS_ROOT.split('/'), 'test-ext', 'view', 'index.html')),
        'the real install is untouched too, since the refusal came before any write');
      assert.strictEqual(readExtensionRecords(ws).length, 1, 'the record was not rewritten by a refused uninstall');
    });
  });

  test('a record with no root is refused, and nothing is removed', () => {
    withWorkspace((ws) => {
      const snap = extensionSnapshot();
      installExtension(ws, snap, planExtensionInstall(ws, snap, SOURCE));

      const records = readExtensionRecords(ws);
      delete records[0].root;
      fs.writeFileSync(path.join(ws, ...RECORDS_PATH.split('/')), serialiseRecords(records));

      assert.throws(() => uninstallExtension(ws, 'test-ext'), (e) => e.code === 'invalid-record');
      assert.ok(fs.existsSync(path.join(ws, ...EXTENSIONS_ROOT.split('/'), 'test-ext', 'view', 'index.html')),
        'nothing was removed by a refused uninstall');
      assert.strictEqual(readExtensionRecords(ws).length, 1, 'and the record is untouched too');
    });
  });

  // Uninstall removes exactly what THIS install created: never the
  // extensions root itself, and never another installed extension's
  // directory, however the persisted root is tampered with.
  test('a record whose root is exactly the extensions root is refused, and every installed extension survives', () => {
    withWorkspace((ws) => {
      const testExt = extensionSnapshot({ name: 'test-ext' });
      const otherExt = extensionSnapshot({ name: 'other-ext' });
      installExtension(ws, testExt, planExtensionInstall(ws, testExt, SOURCE));
      installExtension(ws, otherExt, planExtensionInstall(ws, otherExt, { url: 'https://github.com/someone/other-ext', reference: 'v1.0.0' }));

      const records = readExtensionRecords(ws);
      const target = records.find((r) => r.name === 'test-ext');
      target.root = EXTENSIONS_ROOT;
      fs.writeFileSync(path.join(ws, ...RECORDS_PATH.split('/')), serialiseRecords(records));

      assert.throws(() => uninstallExtension(ws, 'test-ext'), (e) => e.code === 'invalid-record',
        'the extensions root itself is never a legitimate target: it is never what one install created');
      assert.ok(fs.existsSync(path.join(ws, ...EXTENSIONS_ROOT.split('/'), 'test-ext')), 'test-ext survives');
      assert.ok(fs.existsSync(path.join(ws, ...EXTENSIONS_ROOT.split('/'), 'other-ext')), 'other-ext survives too');
      assert.strictEqual(readExtensionRecords(ws).length, 2, 'both records are untouched by the refused uninstall');
    });
  });

  test('a record whose root names another installed extension\'s directory is refused, and that extension survives', () => {
    withWorkspace((ws) => {
      const testExt = extensionSnapshot({ name: 'test-ext' });
      const otherExt = extensionSnapshot({ name: 'other-ext' });
      installExtension(ws, testExt, planExtensionInstall(ws, testExt, SOURCE));
      installExtension(ws, otherExt, planExtensionInstall(ws, otherExt, { url: 'https://github.com/someone/other-ext', reference: 'v1.0.0' }));

      const records = readExtensionRecords(ws);
      const target = records.find((r) => r.name === 'test-ext');
      target.root = `${EXTENSIONS_ROOT}/other-ext`;
      fs.writeFileSync(path.join(ws, ...RECORDS_PATH.split('/')), serialiseRecords(records));

      assert.throws(() => uninstallExtension(ws, 'test-ext'), (e) => e.code === 'invalid-record',
        'a root naming a different install-time location than this record\'s own name is refused');
      assert.ok(fs.existsSync(path.join(ws, ...EXTENSIONS_ROOT.split('/'), 'other-ext', 'view', 'index.html')),
        'the other extension named by the tampered root was never touched');
      assert.strictEqual(readExtensionRecords(ws).length, 2, 'both records are untouched by the refused uninstall');
    });
  });

  test('a record with an invalid name is refused, and nothing is removed', () => {
    withWorkspace((ws) => {
      const snap = extensionSnapshot();
      installExtension(ws, snap, planExtensionInstall(ws, snap, SOURCE));

      const records = readExtensionRecords(ws);
      records[0].name = '../../etc';
      // The root is tampered to resolve the SAME way EXTENSIONS_ROOT plus
      // this malicious name would, so the separate "root matches its
      // install-time location" check cannot be what refuses this: only the
      // name check itself stands between this record and a path built from
      // an unvalidated name.
      records[0].root = `${EXTENSIONS_ROOT}/../../etc`;
      fs.writeFileSync(path.join(ws, ...RECORDS_PATH.split('/')), JSON.stringify({
        schema: 'rundock.extensions/v1', extensions: records,
      }, null, 2));

      assert.throws(() => uninstallExtension(ws, '../../etc'), (e) => e.code === 'invalid-record');
      assert.ok(fs.existsSync(path.join(ws, ...EXTENSIONS_ROOT.split('/'), 'test-ext', 'view', 'index.html')),
        'the real install is untouched: an invalid name is refused before it is ever joined into a path');
      assert.strictEqual(fs.existsSync(path.join(ws, '.claude', 'etc')), false,
        'sanity: nothing was ever materialised at the escaping path this name would have joined into');
    });
  });
});

describe('an update reopens the flow and replaces through the same transaction', () => {
  test('installing a newer pin over an install replaces the files and the record', () => {
    withWorkspace((ws) => {
      const v1 = extensionSnapshot();
      installExtension(ws, v1, planExtensionInstall(ws, v1, SOURCE));

      const v2 = extensionSnapshot({ version: '2.0.0' });
      fs.writeFileSync(path.join(v2, 'view', 'extra.js'), 'export {};\n');
      const plan = planExtensionInstall(ws, v2, { url: SOURCE.url, reference: 'v2.0.0' });
      assert.deepStrictEqual(plan.replaces, { version: '1.0.0', reference: 'v1.0.0' },
        'the trust step can say what this replaces');
      installExtension(ws, v2, plan);

      const records = readExtensionRecords(ws);
      assert.strictEqual(records.length, 1, 'an update is a replacement, never a second entry');
      assert.strictEqual(records[0].version, '2.0.0');
      assert.strictEqual(records[0].source.reference, 'v2.0.0');
      assert.ok(fs.existsSync(path.join(ws, '.claude', 'rundock', 'extensions', 'test-ext', 'view', 'extra.js')));
    });
  });
});

describe('the model transitions are driven by real replies, not by literals that merely copy their shape', () => {
  test('extReply from ext-acquiring on a real error reply reaches ext-failed', () => {
    withWorkspace(() => {
      const sock = captureWs();
      handlers.handlePlanExtensionInstall({}, sock, { type: 'plan_extension_install', url: 'someone/test-ext', reference: 'main' });
      const errorMsg = sock.sent[0];
      assert.strictEqual(errorMsg.type, 'extension_install_error');
      const acquiring = model.extSubmit(model.extInitial(), 'someone/test-ext', 'main').state;
      const failed = model.extReply(acquiring, errorMsg).state;
      assert.strictEqual(failed.phase, 'ext-failed');
      assert.strictEqual(failed.message, errorMsg.message,
        'the failure copy is the producer\'s own words, not a literal restated in this file');
    });
  });

  test('extReply from ext-acquiring on a real plan reaches ext-trust carrying the real manifest and facts', () => {
    withWorkspace(() => {
      const snap = extensionSnapshot({ agents: 1, skills: 1 });
      const previousDeps = handlers.wireExtensionDeps({ acquire: () => snap });
      try {
        const sock = captureWs();
        handlers.handlePlanExtensionInstall({}, sock, { type: 'plan_extension_install', url: 'someone/test-ext', reference: 'v1.0.0' });
        const planMsg = sock.sent[0];
        const acquiring = model.extSubmit(model.extInitial(), 'someone/test-ext', 'v1.0.0').state;
        const trusting = model.extReply(acquiring, planMsg).state;
        assert.strictEqual(trusting.phase, 'ext-trust');
        assert.strictEqual(trusting.token, planMsg.token);
        assert.deepStrictEqual(trusting.facts, planMsg.facts,
          'a renamed or dropped field on the wire would drift from what this asserts if it were restated by hand');
        assert.deepStrictEqual(trusting.manifest, planMsg.manifest);
      } finally {
        handlers.wireExtensionDeps(previousDeps);
      }
    });
  });

  test('extReply from ext-installing on a real install result reaches ext-done carrying the real record', () => {
    withWorkspace(() => {
      const snap = extensionSnapshot();
      const previousDeps = handlers.wireExtensionDeps({ acquire: () => snap });
      try {
        const sock = captureWs();
        handlers.handlePlanExtensionInstall({}, sock, { type: 'plan_extension_install', url: 'someone/test-ext', reference: 'v1.0.0' });
        handlers.handleConfirmExtensionInstall({}, sock, { type: 'confirm_extension_install', token: sock.sent[0].token });
        const resultMsg = sock.sent[1];
        assert.strictEqual(resultMsg.type, 'extension_install_result');
        const installing = { phase: 'ext-installing', url: 'someone/test-ext', reference: 'v1.0.0' };
        const done = model.extReply(installing, resultMsg).state;
        assert.strictEqual(done.phase, 'ext-done');
        assert.deepStrictEqual(done.record, resultMsg.record);
        assert.strictEqual(done.record.source.reference, 'v1.0.0',
          'the done state carries the field the success card renders');
      } finally {
        handlers.wireExtensionDeps(previousDeps);
      }
    });
  });

  test('extReply from ext-installing on a real error reaches ext-failed', () => {
    withWorkspace(() => {
      const sock = captureWs();
      handlers.handleConfirmExtensionInstall({}, sock, { type: 'confirm_extension_install', token: 'never-issued' });
      const errorMsg = sock.sent[0];
      assert.strictEqual(errorMsg.type, 'extension_install_error');
      const installing = { phase: 'ext-installing', url: 'someone/test-ext', reference: 'v1.0.0' };
      const failed = model.extReply(installing, errorMsg).state;
      assert.strictEqual(failed.phase, 'ext-failed');
      assert.strictEqual(failed.message, errorMsg.message);
    });
  });

  test('extSubmit refuses with a field error, and sends nothing, when either field is blank', () => {
    for (const [url, ref] of [['', 'v1'], ['someone/test-ext', ''], ['', '']]) {
      const out = model.extSubmit(model.extInitial(), url, ref);
      assert.strictEqual(out.send, undefined, `blank field must not send for url=${JSON.stringify(url)} reference=${JSON.stringify(ref)}`);
      assert.match(out.state.fieldError, /repository URL and the exact tag/);
    }
  });

  test('every extConnectionLost branch fails honestly, and none of them sends', () => {
    for (const phase of ['ext-acquiring', 'ext-trust']) {
      const out = model.extConnectionLost({ phase, url: 'u', reference: 'r' });
      assert.strictEqual(out.send, undefined);
      assert.strictEqual(out.state.phase, 'ext-failed');
      assert.match(out.state.message, /connection dropped\. Nothing was installed/);
    }
    const installing = model.extConnectionLost({ phase: 'ext-installing', url: 'u', reference: 'r' });
    assert.strictEqual(installing.send, undefined);
    assert.strictEqual(installing.state.phase, 'ext-failed');
    assert.match(installing.state.message, /connection dropped while installing/);
    const idleState = model.extInitial();
    assert.strictEqual(model.extConnectionLost(idleState).state, idleState,
      'idle is not a wait, so a dropped connection changes nothing');
  });

  test('extTrustCopy states no agents and no skills honestly, and carries the replaces line only when there is one', () => {
    const bare = model.extTrustCopy({
      manifest: { name: 'test-ext', version: '1.0.0' }, url: SOURCE.url, reference: SOURCE.reference,
      facts: { agents: 0, skills: 0, files: [], match: '*.md' }, replaces: null,
    });
    assert.match(bare.body, /It adds no agents and no skills\./);
    assert.strictEqual(bare.replacesLine, null);

    const replacing = model.extTrustCopy({
      manifest: { name: 'test-ext', version: '2.0.0' }, url: SOURCE.url, reference: 'v2.0.0',
      facts: { agents: 0, skills: 0, files: [], match: '*.md' },
      replaces: { version: '1.0.0', reference: 'v1.0.0' },
    });
    assert.strictEqual(replacing.replacesLine, 'This replaces the installed 1.0.0 (pinned at v1.0.0).');
  });
});

describe('the settings view exports every function its own extension markup and app.js call by name', () => {
  const SETTINGS_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'views', 'settings.js'), 'utf8');
  const APP_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'app.js'), 'utf8');

  test('every onclick name inside extensionSectionHtml, and extensionReplyArrived on the app.js dispatch case, are on the module surface', () => {
    // Derived from the file, not hand-listed, so a sixth handler added to the
    // markup later fails here without anyone updating a list in this test.
    const sectionMatch = /function extensionSectionHtml\(\) \{([\s\S]*?)\n\}\n/.exec(SETTINGS_SRC);
    assert.ok(sectionMatch, 'settings.js no longer defines extensionSectionHtml the way this test expects');
    const onclickNames = new Set();
    for (const m of sectionMatch[1].matchAll(/onclick="([a-zA-Z_$][\w$]*)\(/g)) onclickNames.add(m[1]);
    assert.ok(onclickNames.has('extensionSubmit'), 'sanity: the extension section markup was found at all');

    assert.match(APP_SRC, /case 'extension_install_plan':[\s\S]*?extensionReplyArrived\(d\);/,
      'sanity: app.js no longer routes extension replies to extensionReplyArrived');

    const settingsView = require('../../public/views/settings.js');
    const exported = new Set(Object.keys(settingsView));
    for (const name of [...onclickNames, 'extensionReplyArrived']) {
      assert.ok(exported.has(name),
        `"${name}" is called by name from the extension markup or the app.js dispatch case, but is not on `
        + 'the object public/views/settings.js returns, so it resolves against window in a browser and throws');
    }
  });
});

describe('the trust card renders what the model derived, driven through the real settings view', () => {
  test('the rendered trust markup contains the file names the plan actually carried', () => {
    withWorkspace(() => {
      const snap = extensionSnapshot({ agents: 1, skills: 1 });
      const previousDeps = handlers.wireExtensionDeps({ acquire: () => snap });
      try {
        const dom = new JSDOM('<div id="settings-content"></div>'
          + '<div class="settings-nav-item active" data-settings="packages"></div>'
          + '<input id="extension-source-url"><input id="extension-source-ref">');
        global.document = dom.window.document;
        global.window = dom.window;
        global.currentView = 'settings';
        global.ws = { readyState: 1, send: () => {} };
        global.WebSocket = { OPEN: 1 };
        global.esc = (t) => String(t == null ? '' : t)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        global.escAttr = (t) => String(t == null ? '' : t)
          .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
          .replace(/</g, '&lt;').replace(/>/g, '&gt;');
        try {
          const settingsView = require('../../public/views/settings.js');
          global.document.getElementById('extension-source-url').value = 'someone/test-ext';
          global.document.getElementById('extension-source-ref').value = 'v1.0.0';
          // Pressed as the control it is, so a rename of the exported name
          // fails here rather than in a browser only.
          settingsView.extensionSubmit();

          const sock = captureWs();
          handlers.handlePlanExtensionInstall({}, sock, { type: 'plan_extension_install', url: 'someone/test-ext', reference: 'v1.0.0' });
          const planMsg = sock.sent[0];
          assert.strictEqual(planMsg.type, 'extension_install_plan');
          assert.ok(planMsg.facts.files.length > 0, 'sanity: the real plan carries a real file list');

          settingsView.extensionReplyArrived(planMsg);

          const rendered = global.document.getElementById('settings-content').innerHTML;
          for (const file of planMsg.facts.files) {
            assert.ok(rendered.includes(file),
              `the rendered trust card does not carry "${file}", one of the facts the plan derived from the package`);
          }
        } finally {
          delete global.document; delete global.window; delete global.currentView;
          delete global.ws; delete global.WebSocket; delete global.esc; delete global.escAttr;
        }
      } finally {
        handlers.wireExtensionDeps(previousDeps);
      }
    });
  });
});
