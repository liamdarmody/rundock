'use strict';
// The boundary stops flooding, proven at its three layers: the block the
// runtime is started with names the runtime's own measured plumbing, every
// comparison canonicalises so one directory under two names is one identity,
// the block is driven by workspace mode alone (Knowledge mode carries it,
// Code mode withdraws it, and nothing else can reach it), and a crossing
// into the agent's own folder is graded by persistence, not location. Fixtures
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

  // With an empty tail the pairing check is skipped, so a person who
  // trimmed the temp roots out of Rundock's own block would have that edit
  // silently reconciled away by the whole-block comparison alone.
  test('a block whose allowWrite is exactly the head, with no temp-directory tail at all, is not recognised as ours, and a reconcile leaves it untouched', () => {
    const headOnly = scaffold.sandboxSettings('/w/ws', 'darwin', '/Users/me', []);
    assert.strictEqual(scaffold.isRundockSandbox(headOnly), false,
      'a real Rundock block always carries at least one temp root; a head with none is not recognised as ours');
    const ws = tmp('wb-head-only-');
    fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
    const trimmed = scaffold.sandboxSettings(ws, 'darwin', os.homedir(), []);
    fs.writeFileSync(path.join(ws, '.claude', 'settings.local.json'), JSON.stringify({ sandbox: trimmed }));
    scaffold.reconcileSandboxForMode(ws, 'knowledge', 'darwin');
    const settings = JSON.parse(fs.readFileSync(path.join(ws, '.claude', 'settings.local.json'), 'utf8'));
    assert.deepStrictEqual(settings.sandbox, trimmed, 'a block a person trimmed the temp roots out of is left exactly as they left it');
  });

  test('a second tail entry that is a real-path spelling of the first, but not the /private one, is still recognised as ours', () => {
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

  test('a case variant of an inside path never cards, and canonicalises to the real spelling, driven both ways', () => {
    // The old version of this test built the target by joining the variant
    // onto `ws` itself, so the target already started with the root spelled
    // byte for byte. An unresolved startsWith comparison passes on that
    // prefix alone and never even looks at the differing segment, so it read
    // 'inside' with or without canonicalisation and proved nothing about
    // case. Checking resolvedPath rather than only `where` is what makes the
    // case spelling decide the outcome: canonicalisation is the only thing
    // that can turn the handed-in variant into the file's real casing.
    // Both kinds driven explicitly through the injected seam, not by probing the real test host.
    const wsReal = hook.canonicalize(tmp('wb-case-'));
    fs.mkdirSync(path.join(wsReal, 'Docs'));
    fs.writeFileSync(path.join(wsReal, 'Docs', 'a.md'), 'x');
    const real = path.join(wsReal, 'Docs', 'a.md');
    const variant = path.join(wsReal, 'dOCS', 'a.md');
    const folded = hook.classifyFileAccess('Read', { file_path: variant }, wsReal, [], os.homedir(), true, true);
    assert.strictEqual(folded.where, 'inside');
    assert.strictEqual(folded.resolvedPath, real, 'folding, the real on-disk spelling is reported, not the variant case handed in');
    const notFolded = hook.classifyFileAccess('Read', { file_path: variant }, wsReal, [], os.homedir(), true, false);
    assert.strictEqual(notFolded.where, 'inside', 'still inside: judged by its nearest existing ancestor');
    assert.strictEqual(notFolded.resolvedPath, variant, 'not folding, nothing resolves the variant to the real spelling');
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

// The OS write block is driven by workspace mode and by nothing else.
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

describe('the agent\'s own folder: three tiers, one registry', () => {
  // Scoped to the boundary passage itself (marked off in ARCHITECTURE.md by
  // an HTML comment pair) rather than matched anywhere in the whole file: a
  // bare substring search would pass even with the paragraph deleted,
  // because several of these names ('agents', 'skills', 'commands',
  // 'hooks') already occur elsewhere in the document for unrelated reasons.
  // Bound in BOTH directions: every registry entry must appear in the
  // passage, and the passage must name no secret or persistence-surface
  // path the registry does not also enforce, so a name added to prose
  // without a matching registry entry is caught too.
  function boundaryPassage() {
    const doc = fs.readFileSync(path.join(ROOT, 'ARCHITECTURE.md'), 'utf8');
    const start = doc.indexOf('<!-- boundary-registry-start -->');
    const end = doc.indexOf('<!-- boundary-registry-end -->');
    assert.ok(start !== -1 && end !== -1 && end > start, 'the boundary passage markers are present in ARCHITECTURE.md');
    return doc.slice(start, end);
  }
  // Every backtick-quoted, path-shaped token the passage cites as a name
  // living under `~/.claude`: the registry side of the binding checks that
  // none of these are strays the registry does not also enforce.
  function passageNames(passage) {
    const names = [];
    const re = /`([a-zA-Z0-9_.-]+(?:\/|\.json))`/g;
    let m;
    while ((m = re.exec(passage)) !== null) names.push(m[1].replace(/\/$/, ''));
    return [...new Set(names)];
  }

  test('the registry and the boundary passage name each other, in both directions', () => {
    const passage = boundaryPassage();
    const registryNames = [...hook.SECRET_RELATIVE_PATHS, ...hook.PERSISTENCE_SURFACE_DIRS, ...hook.PERSISTENCE_SURFACE_FILES];
    for (const name of registryNames) {
      assert.ok(passage.includes(name), `the boundary passage names ${name}, which the registry enforces`);
    }
    // The reverse direction: a name the passage cites is not free to be a
    // stray. `.claude` and `.claude.json`-shaped scratch entries the passage
    // lists as FREE are not registry entries and are excluded on purpose;
    // everything else the passage cites as secret or persistence-tier must
    // be one the registry actually carries.
    const scratchNamedInPassage = ['projects', 'cache', 'paste-cache', 'downloads', 'tasks',
      'file-history', 'shell-snapshots', 'session-env', 'history.jsonl'];
    for (const name of passageNames(passage)) {
      if (scratchNamedInPassage.includes(name)) continue;
      assert.ok(registryNames.includes(name),
        `the boundary passage names ${name} as governed, but the registry does not enforce it`);
    }
  });

  test('isSecretPath and isPersistenceSurface match only their own registry entries, under a symlink spelling, and nowhere else', () => {
    const home = tmp('af-registry-home-');
    fs.mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
    const linkHome = tmp('af-registry-link-');
    const link = path.join(linkHome, 'dot');
    fs.symlinkSync(path.join(home, '.claude'), link);
    assert.strictEqual(hook.isSecretPath(path.join(link, '.credentials.json'), home), true,
      'a spelling through a symlink is the same file');
    assert.strictEqual(hook.isSecretPath(path.join(home, 'Documents', '.credentials.json'), home), false,
      'the same filename elsewhere in the home directory is not the registry\'s entry');
    assert.strictEqual(hook.isPersistenceSurface(path.join(home, '.claude', 'projects', 'p', 'settings.json'), home), false,
      'the named FILE matches only at the folder root, not a same-named file nested somewhere already free');
  });

  // A REGISTRY PATH IS RECOGNISED HOWEVER IT IS SPELLED, INCLUDING BEFORE IT
  // EXISTS. canonicalize only folds case for path components that already
  // exist: an unborn target realpaths its nearest existing ancestor and
  // reattaches the rest verbatim, spelling and all. A write to a case
  // variant of a registry folder that has not been created yet (`Hooks/`
  // before `hooks/` exists) would otherwise escape the registry comparison
  // entirely on a filesystem that folds case. The host's case behaviour is a
  // defaulted seam (`foldsCase`) so both filesystem kinds are exercised
  // explicitly here, on any machine running the suite, rather than one
  // behaviour being selected by whatever the test host's real filesystem
  // happens to do.
  test('a case variant of an unborn persistence-surface folder is recognised, or not, exactly as the host\'s case-folding behaviour says, driven both ways', () => {
    const home = tmp('af-case-home-');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true }); // 'hooks/' itself is NOT created
    const variant = path.join(home, '.claude', 'Hooks', 'pretool.sh');
    assert.strictEqual(hook.isPersistenceSurface(variant, home, true), true,
      'on a filesystem that folds case, the unborn folder\'s case variant is still the registry\'s hooks/ entry');
    assert.strictEqual(hook.isPersistenceSurface(variant, home, false), false,
      'on a filesystem that does not fold case, a differently-cased name is a genuinely different folder');

    const secretVariant = path.join(home, '.claude', '.CREDENTIALS.json');
    assert.strictEqual(hook.isSecretPath(secretVariant, home, true), true,
      'the secrets registry folds case the same way, even though the file does not exist yet either');
    assert.strictEqual(hook.isSecretPath(secretVariant, home, false), false);

    // Driven through classifyFileAccess, which is what actually decides
    // whether the write cards: the same unborn case variant reaches a card
    // on a case-folding host, and stays free (a genuinely different,
    // never-registered folder) on one that does not fold case.
    const ws = tmp('af-case-ws-');
    const folded = hook.classifyFileAccess('Write', { file_path: variant }, ws, [], home, true);
    assert.strictEqual(folded.where, 'outside', 'a card is raised on a case-folding host');
    assert.strictEqual(folded.persistenceSurface, true);
    const notFolded = hook.classifyFileAccess('Write', { file_path: variant }, ws, [], home, false);
    assert.strictEqual(notFolded.where, 'inside', 'and free on a host that does not fold case');
  });

  // THE REGISTRY IS FAIL-LOUD IN THE CODE DIRECTION TOO. The doc/registry
  // binding above catches a name added to prose without a registry entry;
  // this catches the opposite failure mode, a path CLASSIFIED as secret or
  // persistence-tier without the registry backing it, by exercising the two
  // functions that are the registry's only consumers (scripts/
  // permission-hook.js says as much of itself: "nowhere else may decide
  // either question with a literal of its own") against a corpus that
  // includes every registry-derived path alongside a wide spread of
  // neighbours chosen to defeat a sloppy literal: a name one character off,
  // the same name in the wrong folder, a nested file under a registered
  // directory's own name, and a path outside the runtime home entirely.
  test('nothing is classified as a secret or a persistence surface unless the registry says so', () => {
    const home = tmp('af-corpus-home-');
    const root = path.join(home, '.claude');
    fs.mkdirSync(root, { recursive: true });

    for (const p of hook.SECRET_RELATIVE_PATHS.map(p => path.join(root, p))) {
      assert.strictEqual(hook.isSecretPath(p, home), true, `${p} is the registry's own secret`);
    }
    for (const p of [
      ...hook.PERSISTENCE_SURFACE_DIRS.map(d => path.join(root, d, 'x')),
      ...hook.PERSISTENCE_SURFACE_FILES.map(f => path.join(root, f)),
    ]) {
      assert.strictEqual(hook.isPersistenceSurface(p, home), true, `${p} is the registry's own persistence surface`);
    }

    const neighbours = [
      path.join(root, 'projects', 'p', 'session.jsonl'),
      path.join(root, 'cache', 'x.html'),
      path.join(root, 'history.jsonl'),
      path.join(root, 'credentials.json'),                 // no leading dot: not the registry's entry
      path.join(root, '.credentials.json.bak'),             // a neighbour, not the entry itself
      path.join(root, 'Documents', '.credentials.json'),    // same name, wrong folder
      path.join(root, 'agent.md'),                          // 'agent', not the 'agents' folder
      path.join(root, 'skill'),                             // 'skill', not 'skills'
      path.join(root, 'commands.json'),                     // not the 'commands' folder
      path.join(root, 'settings.json.bak'),                 // not the registry's exact file
      path.join(home, 'Documents', 'hooks', 'x.sh'),        // 'hooks' exists, but outside the runtime home
    ];
    for (const p of neighbours) {
      assert.strictEqual(hook.isSecretPath(p, home), false, `${p} is not a registry secret`);
      assert.strictEqual(hook.isPersistenceSurface(p, home), false, `${p} is not a registry persistence surface`);
    }

  });

  // A hand-written literal would catch a registry entry deleted but not a
  // folder ADDED to the refusal without one; names come from the refusal's own source of truth.
  test('the deterministic refusal is bound to the registry mechanically, not restated as a literal', () => {
    const home = os.homedir();
    const write = p => hook.isProtectedClaudeEdit('Write', { file_path: p });
    for (const name of hook.REFUSED_CLAUDE_EDIT_DIRS) {
      assert.ok(hook.PERSISTENCE_SURFACE_DIRS.includes(name), `${name}/ must also be a registry entry`);
      assert.strictEqual(write(path.join(home, '.claude', name, 'x.md')), true, `a write under ${name}/ is refused`);
    }
    const notRefused = [
      ...hook.PERSISTENCE_SURFACE_DIRS.filter(d => !hook.REFUSED_CLAUDE_EDIT_DIRS.includes(d)).map(d => path.join(home, '.claude', d, 'x')),
      path.join(home, '.claude', 'agent.md'),         // near miss: a file, not the 'agents' folder
      path.join(home, '.claude', 'skill'),            // near miss: singular, not 'skills'
      path.join(home, 'Documents', 'agents', 'x.md'), // same name, outside the runtime home entirely
    ];
    for (const p of notRefused) assert.strictEqual(write(p), false, `${p} is not refused outright`);
  });

  // THE REFUSAL AND THE TIER MUST ANSWER THE SAME PATH THE SAME WAY, and a
  // comparison that reads raw text while its neighbour folds case is how
  // they came to disagree: on a case-folding filesystem `Agents/` missed the
  // refusal, fell through, and was offered as an approvable card, which
  // approved a write into the folder the app never reads. Both verdicts are
  // compared here over the same spellings, driven through the seam rather
  // than left to whichever filesystem the suite happens to run on.
  test('the refusal and the tier agree on every spelling, including one only a case-folding filesystem would unify', () => {
    // A home that exists nowhere, so no folder on this machine can resolve a
    // spelling before the comparison sees it. The real home would decide the
    // answer for whichever of these folders happens to exist locally, which
    // is the host-dependence this seam was added to remove.
    const home = path.join(os.tmpdir(), 'no-such-home-' + process.pid);
    const variants = [
      path.join(home, '.claude', 'Agents', 'new.md'),
      path.join(home, '.claude', 'SKILLS', 'x', 'SKILL.md'),
      path.join(home, '.claude', 'AgEnTs', 'never-created', 'deep.md'),
    ];
    for (const p of variants) {
      assert.strictEqual(hook.isProtectedClaudeEdit('Write', { file_path: p }, home, true), true,
        `${p} is refused where the filesystem folds case`);
      assert.strictEqual(hook.isPersistenceSurface(p, home, true), true,
        'and the tier classifier says the same, so neither can offer what the other refuses');
      assert.strictEqual(hook.isProtectedClaudeEdit('Write', { file_path: p }, home, false), false,
        `${p} is a genuinely different folder where case is significant, and is not refused`);
      assert.strictEqual(hook.isPersistenceSurface(p, home, false), false,
        'and again the two agree, in the other direction');
    }
  });

  test('a read anywhere under the folder is free, with the single exception of the secrets tier', () => {
    const home = tmp('af-read-home-');
    fs.mkdirSync(path.join(home, '.claude', 'projects', 'flattened'), { recursive: true });
    fs.mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true });
    fs.mkdirSync(path.join(home, '.claude', 'skills', 'my-skill'), { recursive: true });
    const ws = tmp('af-read-ws-');
    for (const target of [
      path.join(home, '.claude', 'projects', 'flattened', 'session.jsonl'), // scratch
      path.join(home, '.claude', 'agents', 'agent.md'),                     // persistence surface
      path.join(home, '.claude', 'skills', 'my-skill', 'SKILL.md'),         // persistence surface
      path.join(home, '.claude', 'settings.json'),                         // persistence surface
    ]) {
      for (const tool of ['Read', 'Grep']) {
        const field = tool === 'Read' ? 'file_path' : 'path';
        assert.strictEqual(hook.classifyFileAccess(tool, { [field]: target }, ws, [], home).where, 'inside',
          `${tool} of ${target} is free`);
      }
    }
    const credentials = path.join(home, '.claude', '.credentials.json');
    const secretRead = hook.classifyFileAccess('Read', { file_path: credentials }, ws, [], home);
    assert.strictEqual(secretRead.where, 'outside', 'the single exception: a read of the secrets tier still cards');
    assert.strictEqual(secretRead.secret, true);
    assert.strictEqual(secretRead.grantDir, null, 'and no grant is offered for it');
  });

  test('a write to a persistence surface cards; a write to scratch, at at least two locations (file and shell), does not', () => {
    const home = tmp('af-write-home-');
    fs.mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true });
    fs.mkdirSync(path.join(home, '.claude', 'cache'), { recursive: true });
    fs.mkdirSync(path.join(home, '.claude', 'paste-cache'), { recursive: true });
    const ws = tmp('af-write-ws-');

    const surfaceWrite = hook.classifyFileAccess('Write', { file_path: path.join(home, '.claude', 'agents', 'new.md') }, ws, [], home);
    assert.strictEqual(surfaceWrite.where, 'outside', 'a write to a persistence surface cards');
    assert.strictEqual(surfaceWrite.persistenceSurface, true);
    assert.strictEqual(surfaceWrite.secret, false);

    const settingsWrite = hook.classifyFileAccess('Write', { file_path: path.join(home, '.claude', 'settings.json') }, ws, [], home);
    assert.strictEqual(settingsWrite.where, 'outside');
    assert.strictEqual(settingsWrite.persistenceSurface, true);

    for (const scratch of [
      path.join(home, '.claude', 'cache', 'fetched-page.html'),
      path.join(home, '.claude', 'paste-cache', 'clip.txt'),
    ]) {
      assert.strictEqual(hook.classifyFileAccess('Write', { file_path: scratch }, ws, [], home).where, 'inside',
        `a routine stash at ${scratch} is free, not a card`);
    }

    // The same tiers hold for a shell command, which cannot declare read or
    // write: scratch is free, a persistence surface and a secret still card.
    const scratchOnly = hook.classifyShellAccess('Bash', { command: `cat ${path.join(home, '.claude', 'cache', 'x.html')}` }, ws, [], home);
    assert.strictEqual(scratchOnly, null, 'nothing outside the workspace is reported: tier three is free');
    const surfaceTouch = hook.classifyShellAccess('Bash', { command: `touch ${path.join(home, '.claude', 'agents', 'x.md')}` }, ws, [], home);
    assert.strictEqual(surfaceTouch.crossings[0].persistenceSurface, true);
    const secretTouch = hook.classifyShellAccess('Bash', { command: `cat ${path.join(home, '.claude', '.credentials.json')}` }, ws, [], home);
    assert.strictEqual(secretTouch.crossings[0].secret, true);
  });

  test('a standing grant over the whole runtime home does not silence a later crossing into the secrets tier', () => {
    // boundaryGrantCovers alone WOULD silence this (a grant over the home
    // is a prefix of everything inside it); crossingCovered must not.
    const home = tmp('af-wide-grant-home-');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const ws = tmp('af-wide-grant-ws-');
    const credentials = path.join(home, '.claude', '.credentials.json');

    const original = config.getWorkspace();
    config.setWorkspace(ws);
    try {
      boundary.addBoundaryGrant(path.join(home, '.claude'));
      assert.strictEqual(boundary.boundaryGrantCovers(credentials), true,
        'fixture sanity: the naive per-path check does consider this covered');
      assert.strictEqual(boundary.crossingCovered({ path: credentials }, home), false,
        'the actual decision the server consults still cards it: no grant over the wider root silences a secrets-tier crossing');
      assert.strictEqual(boundary.crossingCovered({ path: path.join(home, '.claude', 'notes.md') }, home), true,
        'an ordinary file in the same folder IS covered: the refusal is specific to the registry, not the whole root');
    } finally {
      config.setWorkspace(original);
    }
  });

  test('the card copy names the secret\'s stakes and the persistence surface\'s, and neither for an ordinary crossing', () => {
    assert.match(permissions.agentHomeBoundaryCopy({ secret: true }), /cannot be undone/);
    assert.match(permissions.agentHomeBoundaryCopy({ persistenceSurface: true }), /persists/);
    assert.strictEqual(permissions.agentHomeBoundaryCopy({ secret: true, persistenceSurface: true }),
      permissions.agentHomeBoundaryCopy({ secret: true }), 'the secret\'s stakes win when a crossing is both');
    assert.strictEqual(permissions.agentHomeBoundaryCopy({}), null, 'an ordinary crossing renders the existing card unchanged');
    assert.strictEqual(permissions.agentHomeBoundaryCopy(null), null);
  });
});
