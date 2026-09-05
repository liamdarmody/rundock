'use strict';
// The boundary stops flooding, proven at its three layers: the block the
// runtime is started with names the runtime's own measured plumbing, every
// comparison canonicalises so one directory under two names is one identity,
// the block is driven by workspace mode alone (Knowledge mode carries it,
// Code mode withdraws it, and nothing else can reach it), and a crossing
// into the runtime's home carries its stakes and a narrower grant. Fixtures
// are real directories, real symlinks and the machine's own /private alias,
// because every false card in the field came from a spelling a hand-built
// fixture would not have thought to write.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const hook = require('../../scripts/permission-hook.js');
const scaffold = require('../../lib/workspace/scaffold.js');
const boundary = require('../../lib/workspace/boundary.js');
const permissions = require('../../public/permissions.js');
const config = require('../../lib/config.js');

const made = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
}

describe('the block names the runtime\'s measured plumbing, and the doc names the measurement', () => {
  test('every root beyond the workspace appears in the boundary statement', () => {
    // The doc is the diagnosis's home, so the list the code enforces and the
    // list the reader is told are bound: a root added to one without the
    // other fails here, in whichever direction the drift ran.
    const doc = fs.readFileSync(path.join(ROOT, 'ARCHITECTURE.md'), 'utf8');
    const block = scaffold.sandboxSettings('/w/ws', 'darwin', '/Users/someone', ['/var/folders/zz/T', '/private/var/folders/zz/T']);
    const roots = block.filesystem.allowWrite.slice(1); // beyond the workspace
    for (const root of roots) {
      const name = root.startsWith('/Users/someone') ? root.slice('/Users/someone/'.length) : root;
      // The cache has always been described in prose; the rest are named
      // literally, because a reader chasing a denial searches for the path.
      const mention = name === '.npm' ? 'npm cache' : name.includes('var/folders') ? '/var/folders' : name;
      assert.ok(doc.includes(mention), `the boundary statement names ${mention}, which the block enforces`);
    }
    assert.match(doc, /Claude Code 2\.1\.259/, 'the measured runtime version is named');
    assert.match(doc, /2026-09-03/, 'and the date the measurement was taken');
  });

  test('the writable set carries the workspace, the cache, the runtime roots, then this machine\'s temp roots', () => {
    const block = scaffold.sandboxSettings('/w/ws', 'darwin', '/Users/someone');
    const roots = block.filesystem.allowWrite;
    assert.strictEqual(roots[0], '/w/ws');
    assert.strictEqual(roots[1], '/Users/someone/.npm');
    assert.strictEqual(roots[2], '/Users/someone/.claude', 'the runtime\'s home state, fourteen subsystems measured writing in a day');
    assert.strictEqual(roots[3], '/Users/someone/.claude.json', 'the configuration the runtime writes continuously');
    assert.strictEqual(roots[4], '/tmp/claude');
    assert.strictEqual(roots[5], '/private/tmp/claude');
    const tail = roots.slice(6);
    assert.ok(tail.length >= 1 && tail.includes(os.tmpdir()), 'the tail is this machine\'s own temp directory');
  });

  test('a block the two-root release wrote is still recognised as ours, so it upgrades instead of rotting', () => {
    const legacy = {
      enabled: true,
      autoAllowBashIfSandboxed: true,
      filesystem: { allowWrite: ['/w/old-ws', '/Users/them/.npm'] },
      network: { allowedDomains: ['*'] },
    };
    assert.strictEqual(scaffold.isRundockSandbox(legacy), true,
      'read as a person\'s edit instead, the old block would deny the runtime its plumbing forever');
  });

  test('a block from another machine is ours with a stale tail, which is what lets the reconcile rewrite it', () => {
    const other = scaffold.sandboxSettings('/w/ws', 'darwin', '/Users/me', ['/var/folders/other-machine/T']);
    assert.strictEqual(scaffold.isRundockSandbox(other), true, 'recognised');
    const desired = scaffold.sandboxSettings('/w/ws', 'darwin', '/Users/me');
    assert.notDeepStrictEqual(other, desired, 'and not current, so the reconcile has something to do');
  });

  test('a block a person edited is not ours, in either shape', () => {
    const reordered = scaffold.sandboxSettings('/w/ws', 'darwin', '/Users/me');
    const w = reordered.filesystem.allowWrite;
    [w[2], w[3]] = [w[3], w[2]];
    assert.strictEqual(scaffold.isRundockSandbox(reordered), false, 'the order is contract');
  });

  // Pinned against EXPLICIT tail values via sandboxSettings' own tmpRoots
  // parameter, not against whatever os.tmpdir() happens to realpath to on
  // the machine running the suite. The old version of this test pushed an
  // extra root onto a block built from THIS host's tempRoots(): on a host
  // with a two-entry tail (macOS, with its /var -> /private/var alias) that
  // pushes the block past the permitted head+2 length and the extra root is
  // rejected for the wrong reason; on a host whose tmpdir has no distinct
  // real path (most Linux runners) the tail is one entry, the push lands
  // inside the still-permitted one-or-two-entry window, and the assertion
  // fails outright, meaning 'anything else is somebody's edit' went
  // unenforced there entirely.
  test('a user-added extra root is never recognised as ours, for a one-entry or a two-entry tail', () => {
    const oneEntryTail = ['/var/folders/zz/one-entry-host/T'];
    const legitOne = scaffold.sandboxSettings('/w/ws', 'darwin', '/Users/me', oneEntryTail);
    assert.strictEqual(scaffold.isRundockSandbox(legitOne), true, 'a lone temp root, on its own, is ours');
    const oneEntryPlusExtra = scaffold.sandboxSettings('/w/ws', 'darwin', '/Users/me', oneEntryTail);
    oneEntryPlusExtra.filesystem.allowWrite.push('/Users/me/their-own-root');
    assert.strictEqual(scaffold.isRundockSandbox(oneEntryPlusExtra), false,
      'still within the permitted one-or-two-entry tail length, so the length check alone cannot catch this: '
      + 'the appended root is not a temp-directory spelling, and that is what has to reject it');

    // The two-entry tail is the raw temp-dir name and its own /private real
    // path (the only shape tempRoots() ever produces): recognised as a
    // matched pair, an appended THIRD entry is not.
    const twoEntryTail = ['/var/folders/zz/two-entry-host/T', '/private/var/folders/zz/two-entry-host/T'];
    const legitTwo = scaffold.sandboxSettings('/w/ws', 'darwin', '/Users/me', twoEntryTail);
    assert.strictEqual(scaffold.isRundockSandbox(legitTwo), true, 'the raw spelling and its /private pairing are ours');
    const twoEntryPlusExtra = scaffold.sandboxSettings('/w/ws', 'darwin', '/Users/me', twoEntryTail);
    twoEntryPlusExtra.filesystem.allowWrite.push('/Users/me/their-own-root');
    assert.strictEqual(scaffold.isRundockSandbox(twoEntryPlusExtra), false,
      'a third tail entry pushes length past the permitted window, and it is rejected either way');
  });

  test('a second tail entry that is not the first entry\'s /private pairing is not recognised as ours', () => {
    // Same length as a legitimate two-entry tail, so only the pairing check
    // (not the length check) can catch this: a person's folder happens to
    // land in the second tail slot instead of being visibly appended.
    const impersonating = scaffold.sandboxSettings('/w/ws', 'darwin', '/Users/me', ['/var/folders/zz/mixed-host/T']);
    impersonating.filesystem.allowWrite.push('/Users/me/their-own-root');
    assert.strictEqual(scaffold.isRundockSandbox(impersonating), false,
      'a root of their own, sitting where the /private pairing would be, is not a temp-directory spelling');
  });

  test('PM-1: a second tail entry that is a real-path spelling of the first, but not the /private one, is still recognised as ours', () => {
    // A developer-set TMPDIR, or a relocated temp volume, resolves through a
    // symlink that shares no /private prefix at all: the second entry is a
    // real-path spelling of the first (it ends with it, the shape every
    // realpath resolution produces), but is not the macOS-specific pairing.
    // Before this fix, `ours` read false for a block like this forever, and
    // reconcileSandboxForMode could neither update nor withdraw it.
    const relocatedTail = ['/Users/dev/tmp-mount/T', '/Volumes/ExternalDrive/Users/dev/tmp-mount/T'];
    const block = scaffold.sandboxSettings('/w/ws', 'darwin', '/Users/dev', relocatedTail);
    assert.strictEqual(scaffold.isRundockSandbox(block), true,
      'a non-/private real-path pairing is still ours, because it is still a real-path spelling of the raw name');

    const ws = tmp('wb-relocated-tmp-');
    fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.claude', 'settings.local.json'), JSON.stringify({
      sandbox: scaffold.sandboxSettings(ws, 'darwin', '/Users/dev', relocatedTail),
    }));
    scaffold.reconcileSandboxForMode(ws, 'code', 'darwin');
    const settings = JSON.parse(fs.readFileSync(path.join(ws, '.claude', 'settings.local.json'), 'utf8'));
    assert.strictEqual('sandbox' in settings, false,
      'moving to Code mode withdraws a block carrying this tail, exactly as it does for the /private pairing');
  });
});

describe('one directory under two names is one identity', () => {
  test('a workspace reached through a symlink contains its own files', () => {
    const real = tmp('wb-real-');
    fs.mkdirSync(path.join(real, 'notes'));
    fs.writeFileSync(path.join(real, 'notes', 'a.md'), 'x');
    const linkHome = tmp('wb-links-');
    const link = path.join(linkHome, 'vault');
    fs.symlinkSync(real, link);
    const viaLink = hook.classifyFileAccess('Read', { file_path: path.join(link, 'notes', 'a.md') }, real, []);
    assert.strictEqual(viaLink.where, 'inside',
      'the file is in the workspace however the road to it is spelled');
    const linkRoot = hook.classifyFileAccess('Read', { file_path: path.join(real, 'notes', 'a.md') }, link, []);
    assert.strictEqual(linkRoot.where, 'inside',
      'and a workspace OPENED through the symlink still contains its real files, which is the Dropbox-vault shape');
  });

  test('the /private alias never cards an inside path', () => {
    const ws = tmp('wb-alias-');
    fs.writeFileSync(path.join(ws, 'f.txt'), 'x');
    const real = fs.realpathSync(ws);
    // On macOS these are two spellings; where they coincide the assertions
    // still hold, they just stop being interesting.
    assert.strictEqual(hook.classifyFileAccess('Read', { file_path: path.join(real, 'f.txt') }, ws, []).where, 'inside');
    assert.strictEqual(hook.classifyFileAccess('Read', { file_path: path.join(ws, 'f.txt') }, real, []).where, 'inside');
  });

  test('a case variant of an inside path never cards, and canonicalises to the real spelling', () => {
    // The old version of this test built the target by joining the variant
    // onto `ws` itself, so the target already started with the root spelled
    // byte for byte. An unresolved startsWith comparison passes on that
    // prefix alone and never even looks at the differing segment, so it read
    // 'inside' with or without canonicalisation and proved nothing about
    // case. Checking resolvedPath rather than only `where` is what makes the
    // case spelling decide the outcome: canonicalisation is the only thing
    // that can turn the handed-in variant into the file's real casing.
    const ws = tmp('wb-case-');
    fs.mkdirSync(path.join(ws, 'Docs'));
    fs.writeFileSync(path.join(ws, 'Docs', 'a.md'), 'x');
    const real = path.join(ws, 'Docs', 'a.md');
    const variant = path.join(ws, 'dOCS', 'a.md');
    // True only on a filesystem that folds case (macOS default, Windows):
    // there `variant` names the SAME on-disk file as `real`. On a
    // case-sensitive filesystem (most Linux runners) `dOCS` is simply a
    // directory that does not exist.
    const caseFolds = fs.existsSync(variant);
    const result = hook.classifyFileAccess('Read', { file_path: variant }, ws, []);
    assert.strictEqual(result.where, 'inside');
    if (caseFolds) {
      assert.strictEqual(result.resolvedPath, hook.canonicalize(real),
        'the classifier reports the file\'s real on-disk spelling, not the variant case it was handed');
    } else {
      // Nothing exists at the variant spelling, so it is judged as an unborn
      // target under the workspace: the nearest existing ancestor (ws)
      // canonicalises, and the missing tail rides on unresolved. Correctly
      // 'inside', but this branch cannot exercise case folding at all, which
      // is why the assertion above is the one that matters.
      assert.strictEqual(result.resolvedPath, path.join(hook.canonicalize(ws), 'dOCS', 'a.md'));
    }
  });

  test('a target that does not exist yet is judged by its nearest existing ancestor', () => {
    const real = tmp('wb-unborn-');
    const linkHome = tmp('wb-unborn-link-');
    const link = path.join(linkHome, 'ws');
    fs.symlinkSync(real, link);
    const unborn = path.join(link, 'new-folder', 'new-file.md');
    assert.strictEqual(hook.classifyFileAccess('Write', { file_path: unborn }, real, []).where, 'inside',
      'the unborn tail rides on the canonicalised ancestor');
  });

  test('a genuinely outside path still cards, canonicalised', () => {
    const ws = tmp('wb-out-ws-');
    const elsewhere = tmp('wb-out-else-');
    const r = hook.classifyFileAccess('Write', { file_path: path.join(elsewhere, 'x.md') }, ws, []);
    assert.strictEqual(r.where, 'outside');
    assert.strictEqual(r.resolvedPath, hook.canonicalize(path.join(elsewhere, 'x.md')),
      'and the card names the real path, not a spelling');
  });

  test('a standing grant covers its folder under any spelling', () => {
    const ws = tmp('wb-grant-ws-');
    const target = tmp('wb-grant-target-');
    const linkHome = tmp('wb-grant-link-');
    const link = path.join(linkHome, 'shared');
    fs.symlinkSync(target, link);
    const original = config.getWorkspace();
    config.setWorkspace(ws);
    try {
      boundary.addBoundaryGrant(link);
      assert.strictEqual(boundary.boundaryGrantCovers(path.join(target, 'file.md')), true,
        'granted through the symlink, asked about through the real path: one folder, one decision');
      assert.strictEqual(boundary.boundaryGrantCovers(path.join(linkHome, 'other', 'f.md')), false,
        'and the grant covers only what its author meant');
    } finally {
      config.setWorkspace(original);
    }
  });

  test('a grant stored under an older, non-canonical spelling still covers what its author meant, on the read side alone', () => {
    // The test above writes through addBoundaryGrant, so its write-side
    // canonicalize already stores the real path: that assertion would hold
    // even with read-side canonicalisation deleted, and proves nothing about
    // it on its own. Here the grants file is written directly, the way an
    // older release (before write-side canonicalisation existed) would have
    // left it on disk: the symlink spelling itself, never resolved. Only
    // canonicalising the stored grant AT READ TIME can make this cover the
    // folder its author meant.
    const target = tmp('wb-readgrant-target-');
    const linkHome = tmp('wb-readgrant-link-');
    const link = path.join(linkHome, 'shared');
    fs.symlinkSync(target, link);
    const ws = tmp('wb-readgrant-ws-');
    const original = config.getWorkspace();
    config.setWorkspace(ws);
    try {
      const grantsFile = boundary.boundaryPermissionsPath();
      fs.mkdirSync(path.dirname(grantsFile), { recursive: true });
      fs.writeFileSync(grantsFile, JSON.stringify({ allowedDirs: [link] }));
      assert.strictEqual(boundary.boundaryGrantCovers(path.join(fs.realpathSync(target), 'file.md')), true,
        'a file under the granted folder\'s real path is covered, even though the grant on disk is still spelled through the symlink');
      assert.strictEqual(boundary.boundaryGrantCovers(path.join(linkHome, 'other', 'f.md')), false,
        'and a sibling outside the granted folder is not, so this is not merely "everything covers everything"');
    } finally {
      config.setWorkspace(original);
    }
  });
});

// PM-1: the OS write block is driven by workspace mode and by nothing else.
// There is no separate opt-out any more; lib/protocol/handlers/workspace.js's
// handleSetWorkspaceMode drives lib/workspace/scaffold.js's
// reconcileSandboxForMode directly, and these tests exercise that function
// (and scaffoldWorkspace's own reconcile, which reads the persisted mode on
// every ordinary open) at the scaffold layer. The protocol-level proof that
// no OTHER message can reach the block lives alongside the rest of the
// dispatch table in test/unit/protocol-handlers-lib.test.js.
describe('the block is driven by mode, and only by mode', () => {
  function workspaceWithBlock() {
    const ws = tmp('wb-mode-');
    fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
    return ws;
  }

  test('reconcileSandboxForMode writes the block for knowledge mode and withdraws it for code mode; switching back restores it', () => {
    const ws = workspaceWithBlock();
    // 'darwin' explicitly: sandboxSettings returns null on any other
    // platform, so a call defaulted to process.platform writes no block at
    // all on a non-darwin host and the read-back below throws ENOENT there,
    // the same reason scaffoldWorkspace is given { platform: 'darwin' } in
    // the sibling tests below.
    scaffold.reconcileSandboxForMode(ws, 'knowledge', 'darwin');
    const settingsPath = path.join(ws, '.claude', 'settings.local.json');
    let settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.ok(settings.sandbox, 'knowledge mode: the block is written');
    scaffold.reconcileSandboxForMode(ws, 'code', 'darwin');
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.strictEqual('sandbox' in settings, false, 'code mode: the block is withdrawn');
    scaffold.reconcileSandboxForMode(ws, 'knowledge', 'darwin');
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.ok(settings.sandbox, 'moving back to knowledge mode restores the block');
  });

  test('an unreadable settings file is never overwritten: only a genuinely absent file starts from empty', () => {
    // The bug this guards: {} stood in for EVERY read failure, absent or
    // not, so a corrupt settings.local.json (a hand-added comment, a torn
    // read while Claude Code itself was mid-write) got silently replaced
    // with a lone { sandbox: ... } key, discarding every permission-hook
    // entry the file carried, while the caller still reported success.
    const ws = workspaceWithBlock();
    const settingsPath = path.join(ws, '.claude', 'settings.local.json');
    const corrupt = '{ "hooks": { "PreToolUse": [ // a hand-added comment breaks this\n';
    fs.writeFileSync(settingsPath, corrupt);
    assert.throws(() => scaffold.reconcileSandboxForMode(ws, 'knowledge', 'darwin'),
      /could not read/, 'the read/parse failure is surfaced rather than swallowed');
    assert.strictEqual(fs.readFileSync(settingsPath, 'utf8'), corrupt,
      'and the file\'s bytes are exactly as they were: nothing started from {} and overwrote it');
  });

  test('the next open honours the persisted mode, not only the switch\'s immediate write: withdrawn for a code-mode workspace, present for a knowledge-mode one', () => {
    // reconcileSandboxForMode proves the switch's own immediate write above.
    // This is the separate branch in scaffoldWorkspace itself
    // (workspaceModeFor(dir) gating `desired`), reached on every ordinary
    // workspace open, not only through the switch. Nothing exercised it: the
    // only prior assertion about it read back the state flag rather than
    // running scaffoldWorkspace against a code-mode workspace and checking
    // what landed in settings.local.json.
    const prevDeps = scaffold.wireScaffoldDeps({ invalidateAgentCache: () => {}, rebaselineAgentsWatcher: () => {} });
    try {
      const codeModeWs = tmp('wb-scaffold-codemode-');
      // A Rundock-written block already present, as it would be from an
      // earlier, knowledge-mode open.
      scaffold.scaffoldWorkspace(codeModeWs, { platform: 'darwin' });
      const settingsPath = path.join(codeModeWs, '.claude', 'settings.local.json');
      assert.ok(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).sandbox,
        'fixture sanity: a block is present before the mode changes');

      // Persist code mode directly in state.json, the way the mode-change
      // handler does, WITHOUT going through reconcileSandboxForMode's own
      // immediate write: the next open, not the switch, is what is under
      // test.
      fs.writeFileSync(path.join(codeModeWs, '.rundock', 'state.json'), JSON.stringify({ workspaceMode: 'code' }));
      scaffold.scaffoldWorkspace(codeModeWs, { platform: 'darwin' });
      const afterNextOpen = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      assert.strictEqual('sandbox' in afterNextOpen, false,
        'withdrawn on the next open, not left in place as a refresh would leave it');

      const knowledgeModeWs = tmp('wb-scaffold-knowledgemode-');
      scaffold.scaffoldWorkspace(knowledgeModeWs, { platform: 'darwin' });
      const inSettings = JSON.parse(fs.readFileSync(path.join(knowledgeModeWs, '.claude', 'settings.local.json'), 'utf8'));
      assert.ok(inSettings.sandbox, 'and a workspace with no persisted mode (default knowledge) still gets the block from the same call');
    } finally {
      scaffold.wireScaffoldDeps(prevDeps);
    }
  });

  test('a person\'s own block is never touched by a mode change, in either direction', () => {
    const ws = workspaceWithBlock();
    const theirs = { enabled: false, note: 'mine' };
    fs.writeFileSync(path.join(ws, '.claude', 'settings.local.json'), JSON.stringify({ sandbox: theirs }));
    scaffold.reconcileSandboxForMode(ws, 'code', 'darwin');
    scaffold.reconcileSandboxForMode(ws, 'knowledge', 'darwin');
    const settings = JSON.parse(fs.readFileSync(path.join(ws, '.claude', 'settings.local.json'), 'utf8'));
    assert.deepStrictEqual(settings.sandbox, theirs, 'whoever wrote it decided something');
  });

  test('the legacy block upgrades to the measured shape through the mode reconcile', () => {
    const ws = workspaceWithBlock();
    const home = os.homedir();
    const legacy = {
      enabled: true, autoAllowBashIfSandboxed: true,
      filesystem: { allowWrite: [ws, path.posix.join(home, '.npm')] },
      network: { allowedDomains: ['*'] },
    };
    fs.writeFileSync(path.join(ws, '.claude', 'settings.local.json'), JSON.stringify({ sandbox: legacy }));
    // 'darwin' explicitly, for the same reason as the reconcile test above:
    // the legacy block is recognised as ours regardless of host platform
    // (its authorship check is always against the darwin shape), but on a
    // non-darwin host a defaulted `desired` computes null, so `ours && !desired`
    // DELETES the legacy block instead of upgrading it, and the read below
    // throws TypeError on the now-absent settings.sandbox.filesystem.
    scaffold.reconcileSandboxForMode(ws, 'knowledge', 'darwin');
    const settings = JSON.parse(fs.readFileSync(path.join(ws, '.claude', 'settings.local.json'), 'utf8'));
    assert.ok(settings.sandbox.filesystem.allowWrite.includes(path.posix.join(home, '.claude')),
      'the two-root block became the measured block on the next reconcile');
  });
});

describe('a crossing into the runtime\'s home carries its stakes', () => {
  test('the sensitive table matches the runtime home under any spelling, and only it', () => {
    const home = tmp('wb-home-');
    fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
    const ws = tmp('wb-sens-ws-');
    const hit = hook.sensitiveEnrichment(path.join(home, '.claude', 'settings.json'), ws, home);
    assert.ok(hit && hit.sensitive === 'claude-home');
    const linkHome = tmp('wb-sens-link-');
    const link = path.join(linkHome, 'dot');
    fs.symlinkSync(path.join(home, '.claude'), link);
    const viaLink = hook.sensitiveEnrichment(path.join(link, 'x'), ws, home);
    assert.ok(viaLink && viaLink.sensitive === 'claude-home', 'a spelling through a symlink is the same folder');
    assert.strictEqual(hook.sensitiveEnrichment(path.join(home, 'Documents', 'x'), ws, home), null,
      'an ordinary home path is not sensitive');
  });

  test('the narrow grant is derived from the installed layout, never hardcoded', () => {
    const home = tmp('wb-derive-home-');
    const ws = tmp('wb-derive-ws-');
    const flattened = path.resolve(ws).replace(/[^A-Za-z0-9-]/g, '-');
    fs.mkdirSync(path.join(home, '.claude', 'projects', flattened), { recursive: true });
    const hit = hook.sensitiveEnrichment(path.join(home, '.claude', 'anything'), ws, home);
    assert.strictEqual(hit.narrowGrantDir, path.join(home, '.claude', 'projects', flattened),
      'this workspace\'s own transcripts folder, found in the layout the runtime actually keeps');
  });

  test('a layout the derivation does not recognise withdraws the narrow offer rather than granting the wrong folder', () => {
    const home = tmp('wb-drift-home-');
    fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
    const ws = tmp('wb-drift-ws-');
    const hit = hook.sensitiveEnrichment(path.join(home, '.claude', 'anything'), ws, home);
    assert.ok(hit && hit.sensitive === 'claude-home', 'the stakes are still stated');
    assert.strictEqual('narrowGrantDir' in hit, false,
      'but no folder is offered that the runtime might not mean');
  });

  test('answering the narrow grant persists exactly that folder: the transcripts are silenced, the parent runtime home still cards', () => {
    // What respondPermission sends for the allow-transcripts action is an
    // ordinary grantDir (chat.js's own comment: "it IS a folder grant"), so
    // this exercises addBoundaryGrant/boundaryGrantCovers, the same call an
    // "Always allow this folder" answer makes, with the narrow directory the
    // hook derived rather than a whole-folder one.
    const home = tmp('wb-narrow-home-');
    const ws = tmp('wb-narrow-ws-');
    const flattened = path.resolve(ws).replace(/[^A-Za-z0-9-]/g, '-');
    const narrowDir = path.join(home, '.claude', 'projects', flattened);
    fs.mkdirSync(narrowDir, { recursive: true });
    const enrichment = hook.sensitiveEnrichment(path.join(home, '.claude', 'settings.json'), ws, home);
    assert.strictEqual(enrichment.narrowGrantDir, narrowDir);

    const original = config.getWorkspace();
    config.setWorkspace(ws);
    try {
      boundary.addBoundaryGrant(enrichment.narrowGrantDir);
      const grants = JSON.parse(fs.readFileSync(boundary.boundaryPermissionsPath(), 'utf8'));
      assert.deepStrictEqual(grants.allowedDirs, [hook.canonicalize(narrowDir)],
        'exactly the narrow folder is persisted, nothing wider');

      // Silenced: a file inside the granted transcripts folder is now covered.
      const insideNarrow = path.join(narrowDir, 'session.jsonl');
      assert.strictEqual(hook.classifyFileAccess('Read', { file_path: insideNarrow }, ws, []).where, 'outside',
        'still outside the workspace (the grant answers this, not the boundary)');
      assert.strictEqual(boundary.boundaryGrantCovers(insideNarrow), true,
        'and the narrow grant covers it: no card on the next access');

      // Still carded: the credential file sits in the parent runtime home,
      // outside the narrow folder, and the narrow grant must not have become
      // a standing grant for the whole thing.
      const credentials = path.join(home, '.claude', '.credentials.json');
      assert.strictEqual(boundary.boundaryGrantCovers(credentials), false,
        'the narrow grant for the transcripts folder never widens to cover the runtime home it lives inside');
    } finally {
      config.setWorkspace(original);
    }
  });

  test('PM-5: a standing grant over the whole sensitive root does not silence a later crossing into it', () => {
    // The naive check (boundaryGrantCovers alone) WOULD silence this: a
    // grant over the runtime home is a prefix of everything inside it,
    // credentials included. crossingCovered is the actual decision
    // lib/http-router.js consults before answering a boundary request from a
    // stored grant, and for a sensitive crossing it must not fall through to
    // that naive check.
    const home = tmp('wb-wide-grant-home-');
    const ws = tmp('wb-wide-grant-ws-');
    const flattened = path.resolve(ws).replace(/[^A-Za-z0-9-]/g, '-');
    fs.mkdirSync(path.join(home, '.claude', 'projects', flattened), { recursive: true });
    const credentials = path.join(home, '.claude', '.credentials.json');

    const original = config.getWorkspace();
    config.setWorkspace(ws);
    try {
      // A grant over the whole runtime home, however it came to exist (an
      // older build, a hand-edited permissions.json): established directly,
      // not through the card, because the card no longer offers this button
      // for a sensitive crossing at all (see boundary-card.test.js).
      boundary.addBoundaryGrant(path.join(home, '.claude'));
      assert.strictEqual(boundary.boundaryGrantCovers(credentials), true,
        'fixture sanity: the naive per-path check does consider this covered');

      const enrichment = hook.sensitiveEnrichment(credentials, ws, home);
      assert.strictEqual(enrichment.sensitive, 'claude-home');
      assert.strictEqual(boundary.crossingCovered({ path: credentials, ...enrichment }), false,
        'the actual decision the server consults still cards it: no grant over the wider root silences a sensitive crossing');
    } finally {
      config.setWorkspace(original);
    }
  });

  test('PM-5: crossingCovered mirrors the narrow grant exactly, once it is recorded', () => {
    // The same fixture and grant as "answering the narrow grant..." above,
    // read this time through crossingCovered, the function the server
    // actually calls, rather than boundaryGrantCovers alone.
    const home = tmp('wb-covered-home-');
    const ws = tmp('wb-covered-ws-');
    const flattened = path.resolve(ws).replace(/[^A-Za-z0-9-]/g, '-');
    const narrowDir = path.join(home, '.claude', 'projects', flattened);
    fs.mkdirSync(narrowDir, { recursive: true });

    const original = config.getWorkspace();
    config.setWorkspace(ws);
    try {
      const insideNarrow = path.join(narrowDir, 'session.jsonl');
      const credentials = path.join(home, '.claude', '.credentials.json');
      const insideEnrichment = hook.sensitiveEnrichment(insideNarrow, ws, home);
      const credEnrichment = hook.sensitiveEnrichment(credentials, ws, home);

      assert.strictEqual(boundary.crossingCovered({ path: insideNarrow, ...insideEnrichment }), false,
        'before the grant exists, the transcripts file still cards');

      boundary.addBoundaryGrant(insideEnrichment.narrowGrantDir);

      assert.strictEqual(boundary.crossingCovered({ path: insideNarrow, ...insideEnrichment }), true,
        'after the narrow grant, a file inside the transcripts folder is silent');
      assert.strictEqual(boundary.crossingCovered({ path: credentials, ...credEnrichment }), false,
        'the runtime home\'s credential file, outside the narrow folder, still cards');
      assert.strictEqual(boundary.crossingCovered({ path: path.join(home, '.claude'), sensitive: 'claude-home', narrowGrantDir: insideEnrichment.narrowGrantDir }), false,
        'and so does the runtime home root itself');
    } finally {
      config.setWorkspace(original);
    }
  });

  test('the card copy names the stakes concretely and offers the narrow grant by name', () => {
    const copy = permissions.sensitiveBoundaryCopy('claude-home');
    assert.match(copy.context, /\.credentials\.json/, 'the account token is named');
    assert.match(copy.context, /transcripts/, 'and the transcripts');
    assert.match(copy.narrowLabel, /transcripts only/, 'the narrow affordance says what it grants');
    assert.strictEqual(permissions.sensitiveBoundaryCopy('anything-else'), null,
      'paths outside the table render the existing card unchanged');
  });
});
