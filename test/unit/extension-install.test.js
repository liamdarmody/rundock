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

const { parseGitHubSource, discardAcquisition, MOVING_NAMES } = require('../../lib/packages/extension-source.js');
const { readExtensionManifest, deriveFacts } = require('../../lib/packages/extension-manifest.js');
const {
  RECORDS_PATH, readExtensionRecords, checkForUpdate,
} = require('../../lib/packages/extension-record.js');
const {
  planExtensionInstall, installExtension, uninstallExtension,
} = require('../../lib/packages/extension-install.js');
const handlers = require('../../lib/protocol/handlers/packages.js');
const { buildPlan } = require('../../lib/packages/import-plan.js');
const config = require('../../lib/config.js');
const model = require('../../public/packages-install-model.js');

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
      { name: 'x', source: { url: 'u', reference: 'v1' } },
      (url) => (url === 'u' ? ['v1', 'v2'] : []),
    );
    assert.deepStrictEqual(status.newer, ['v2']);
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
