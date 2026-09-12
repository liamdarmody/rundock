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
  // A DELIBERATE NARROWING, RECORDED RATHER THAN DELETED.
  //
  // Two tests here used to assert that a root appended to Rundock's own block
  // proved a person had edited it, so the block was left alone forever. They
  // were right about the old shape, where the tail was one or two temp roots
  // and the entry COUNT was itself the evidence.
  //
  // The block now also carries the folders the user named in Working Folders.
  // That list is arbitrary in length and content, so an appended root and a
  // named folder are the same bytes in the same position, and no rule can
  // separate them. Keeping the old guarantee would need a record, kept outside
  // the block, of what Rundock last wrote; a record that can be lost or go
  // stale, and every way of losing it strands the workspace with a block
  // Rundock can no longer rewrite or withdraw, which is precisely the failure
  // this whole change exists to end.
  //
  // What is given up: a write root added by hand to settings.local.json is
  // regenerated away on the next open. It NARROWS rather than widens, since
  // their extra root is dropped rather than kept, and the supported place to
  // name a folder now actually reaches the sandbox, which it did not before.
  //
  // What still holds is asserted below, and in the two neighbouring tests: the
  // head's order is contract, and a block with no temp tail at all is still
  // refused and still left untouched.
  test('an appended root now reads as a named folder, the cost of the folder list being any length', () => {
    const oneEntryTail = ['/var/folders/zz/one-entry-host/T'];
    const legitOne = scaffold.sandboxSettings('/w/ws', 'darwin', '/Users/me', oneEntryTail);
    assert.strictEqual(scaffold.isRundockSandbox(legitOne), true, 'a lone temp root, on its own, is ours');

    const oneEntryPlusExtra = scaffold.sandboxSettings('/w/ws', 'darwin', '/Users/me', oneEntryTail);
    oneEntryPlusExtra.filesystem.allowWrite.push('/Users/me/their-own-root');
    assert.strictEqual(scaffold.isRundockSandbox(oneEntryPlusExtra), true,
      'indistinguishable from a block written for a workspace naming that folder, so it is ours and gets regenerated');

    const twoEntryTail = ['/var/folders/zz/two-entry-host/T', '/private/var/folders/zz/two-entry-host/T'];
    const legitTwo = scaffold.sandboxSettings('/w/ws', 'darwin', '/Users/me', twoEntryTail);
    assert.strictEqual(scaffold.isRundockSandbox(legitTwo), true, 'the raw spelling and its /private pairing are ours');
  });

  test('the head is still what proves authorship, so a stranger\'s block is still refused', () => {
    // The guarantee that replaces the length check. Six entries in fixed
    // positions, every one rebuilt from the block's own claimed workspace and
    // home: a block that does not open with them was not written here,
    // however its tail looks.
    const notOurs = scaffold.sandboxSettings('/w/ws', 'darwin', '/Users/me', ['/var/folders/zz/h/T']);
    notOurs.filesystem.allowWrite[3] = '/Users/me/not-a-runtime-root';
    assert.strictEqual(scaffold.isRundockSandbox(notOurs), false,
      'a runtime root replaced in the head, so the head no longer rebuilds and the block is left alone');

    const wrongHome = scaffold.sandboxSettings('/w/ws', 'darwin', '/Users/me', ['/var/folders/zz/h/T']);
    wrongHome.filesystem.allowWrite[1] = '/Users/someone-else/.npm';
    assert.strictEqual(scaffold.isRundockSandbox(wrongHome), false,
      'a cache root under a different home than the runtime roots claim: not a shape Rundock ever writes');
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
    assert.strictEqual('enabled' in settings.sandbox, false,
      'moving to Code mode drops the enable from a block carrying this tail, exactly as it does for the /private pairing');
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
      // The mirror of the line above, and the only assertion here that drives
      // canonicalisation of the ASKED-ABOUT path. addBoundaryGrant already
      // canonicalises on write, so the stored grant is the real spelling: the
      // question arriving under the symlink spelling is the sole thing left
      // that has to be resolved. Asking through `link`, a symlink this test
      // makes itself, is what carries that on every platform. Asking through
      // a path from os.tmpdir() does it only on hosts where the temp dir
      // itself sits behind an alias (macOS /var -> /private/var), which left
      // the guard proving nothing on Linux and so nothing in CI.
      assert.strictEqual(boundary.boundaryGrantCovers(path.join(link, 'file.md')), true,
        'and granted under the real path, asked about through the symlink: still one folder, one decision');
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
    const knowledgeRoots = settings.sandbox.filesystem.allowWrite;
    scaffold.reconcileSandboxForMode(ws, 'code', 'darwin');
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.strictEqual('enabled' in settings.sandbox, false, 'code mode: the enable is dropped');
    assert.deepStrictEqual(settings.sandbox.filesystem.allowWrite, knowledgeRoots,
      'and the paths are kept, because another settings layer may have enabled the sandbox '
      + 'and this is the only place that names the folders the user chose');
    scaffold.reconcileSandboxForMode(ws, 'knowledge', 'darwin');
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.strictEqual(settings.sandbox.enabled, true, 'moving back to knowledge mode restores the enable');
  });

  test('a block carrying a stale folder list is rewritten to the current one, not merely recognised', () => {
    // Recognition is only half of reconciliation: a block can be correctly
    // identified as ours and still be left on disk naming a folder the person
    // removed weeks ago. This drives the whole path and reads the file back.
    const ws = tmp('wb-stale-folders-');
    fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(ws, '.rundock'), { recursive: true });
    const current = tmp('wb-stale-current-');
    const stale = '/Users/someone/NamedLongAgo';
    // What the workspace names TODAY.
    fs.writeFileSync(path.join(ws, '.rundock', 'state.json'),
      JSON.stringify({ workspaceMode: 'knowledge', workingFolders: [current] }));
    // What the block on disk still names, written by an earlier run.
    const old = scaffold.sandboxSettings(ws, 'darwin', os.homedir(), ['/tmp/t'], [stale]);
    fs.writeFileSync(path.join(ws, '.claude', 'settings.local.json'), JSON.stringify({ sandbox: old }));
    assert.strictEqual(scaffold.isRundockSandbox(old), true, 'fixture sanity: the stale block is recognised as ours');

    scaffold.reconcileSandboxForMode(ws, 'knowledge', 'darwin');

    const roots = JSON.parse(fs.readFileSync(path.join(ws, '.claude', 'settings.local.json'), 'utf8'))
      .sandbox.filesystem.allowWrite;
    assert.ok(roots.includes(current), 'the folder the workspace names now is writable');
    assert.ok(!roots.includes(stale),
      'and the one it no longer names is gone, rather than being left in place because the block was ours');
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
      // CHANGED CONTRACT, PINNED RATHER THAN RELAXED. This used to assert the
      // block was gone. Withdrawing it was never what it appeared to be:
      // `sandbox.enabled` is an OR across every settings layer and Rundock
      // writes one of them, so deleting ours disabled nothing for a user who
      // had enabled the sandbox in their own ~/.claude/settings.json. It only
      // stopped telling that sandbox which folders they had named, which is
      // the reported defect. Code mode now contributes paths and claims no
      // enable, so the assertion is stricter than the one it replaces: the
      // block must be present AND must enable nothing.
      assert.ok(afterNextOpen.sandbox, 'a block is written for a code-mode workspace');
      assert.strictEqual('enabled' in afterNextOpen.sandbox, false,
        'and it claims no enable, so it switches the sandbox on for nobody');
      assert.strictEqual('network' in afterNextOpen.sandbox, false,
        'and names no domains, so it widens no network policy the user set');
      assert.ok(Array.isArray(afterNextOpen.sandbox.filesystem.allowWrite),
        'what it does carry is the write list, for the case another layer enabled the sandbox');

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
  // folder ADDED to the refusal without one. A NAME-LIST comparison (every
  // REFUSED_CLAUDE_EDIT_DIRS entry also appears in PERSISTENCE_SURFACE_DIRS)
  // proves the two registries agree on names; it proves nothing about what
  // either matcher actually DECIDES for a real path, since each could read a
  // different literal internally and still pass a name-list check. Compared
  // here instead are the two matchers' VERDICTS, over a corpus wide enough
  // that a future divergence between them has to turn this red: the exact
  // spelling, the same folder reached through a symlinked home, a target
  // whose folder has not been created yet, and a case variant (checked both
  // ways the case-folding seam can answer, since a real host's own behaviour
  // must not decide which assertion runs).
  test('the outright refusal and the persistence tier agree on verdicts over a shared corpus of spellings, not just a shared name list', () => {
    for (const name of hook.REFUSED_CLAUDE_EDIT_DIRS) {
      assert.ok(hook.PERSISTENCE_SURFACE_DIRS.includes(name), `${name}/ must also be a registry entry`);

      const home = tmp('af-verdict-home-');
      fs.mkdirSync(path.join(home, '.claude', name), { recursive: true });
      const exact = path.join(home, '.claude', name, 'x.md');

      const linkHome = tmp('af-verdict-link-');
      const link = path.join(linkHome, 'dot');
      fs.symlinkSync(path.join(home, '.claude'), link);
      const symlinked = path.join(link, name, 'x.md');

      const unbornHome = tmp('af-verdict-unborn-');
      fs.mkdirSync(path.join(unbornHome, '.claude'), { recursive: true }); // the name/ folder itself is NOT created
      const unborn = path.join(unbornHome, '.claude', name, 'never-created', 'deep.md');

      const caseHome = tmp('af-verdict-case-');
      fs.mkdirSync(path.join(caseHome, '.claude'), { recursive: true }); // the case variant is unborn too
      const caseVariant = path.join(caseHome, '.claude', name.toUpperCase(), 'x.md');

      const corpus = [
        ['exact', exact, home, undefined, true],
        ['symlinked', symlinked, home, undefined, true],
        ['unborn folder', unborn, unbornHome, undefined, true],
        ['case variant, folding host', caseVariant, caseHome, true, true],
        ['case variant, non-folding host', caseVariant, caseHome, false, false],
      ];
      for (const [label, target, targetHome, foldsCase, mustBeTrue] of corpus) {
        const refused = hook.isProtectedClaudeEdit('Write', { file_path: target }, targetHome, foldsCase);
        const tiered = hook.isPersistenceSurface(target, targetHome, foldsCase);
        assert.strictEqual(refused, tiered,
          `${name}/ (${label}): the refusal and the tier must agree (refused=${refused}, tiered=${tiered})`);
        assert.strictEqual(refused, mustBeTrue, `${name}/ (${label}): expected refused=${mustBeTrue}`);
      }
    }

    const home = os.homedir();
    const write = p => hook.isProtectedClaudeEdit('Write', { file_path: p });
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

  // A shell command cannot declare which act it performs, so a persistence
  // surface it touches is graded as a write by default (see the test above).
  // That default is wrong for a command built ENTIRELY from commands this
  // registry knows only read: `ls`, `cat` and their neighbours. Re-grading
  // covers only a crossing under the runtime's OWN home; a command reaching
  // some other outside folder is unaffected by any of this.
  test('a shell command built entirely from read-only commands is free against a persistence surface, exactly as Read/Glob/Grep already are', () => {
    const home = tmp('af-readonly-home-');
    fs.mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true });
    fs.mkdirSync(path.join(home, '.claude', 'skills', 'x'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'skills', 'x', 'SKILL.md'), 'x');
    const ws = tmp('af-readonly-ws-');

    assert.strictEqual(hook.classifyShellAccess('Bash', { command: `ls ${path.join(home, '.claude', 'agents')}` }, ws, [], home), null,
      'a bare read-only command against a persistence surface raises no crossing');
    assert.strictEqual(hook.classifyShellAccess('Bash', { command: `cat ${path.join(home, '.claude', 'skills', 'x', 'SKILL.md')}` }, ws, [], home), null);

    // FAIL SAFE, three ways: a write command alone, a redirection appended to
    // an otherwise read-only leading command, and a compound where only ONE
    // segment qualifies must all still card.
    const rm = hook.classifyShellAccess('Bash', { command: `rm -rf ${path.join(home, '.claude', 'agents', 'x')}` }, ws, [], home);
    assert.strictEqual(rm.crossings[0].persistenceSurface, true, 'a write command against a persistence surface still cards');

    const redirected = hook.classifyShellAccess('Bash', { command: `echo x > ${path.join(home, '.claude', 'hooks', 'y')}` }, ws, [], home);
    assert.strictEqual(redirected.crossings[0].persistenceSurface, true,
      'echo alone is read-only, but a write-shaped redirection still writes, so this still cards');

    const compound = hook.classifyShellAccess('Bash',
      { command: `ls ${path.join(home, '.claude', 'agents')} && rm -rf ${path.join(home, '.claude', 'agents', 'x')}` }, ws, [], home);
    assert.ok(compound && compound.crossings.some(c => c.persistenceSurface),
      'one non-read-only segment fails the whole command, so a compound that mixes ls with rm still cards');

    // The secrets tier is never re-graded by this: it cards on any access,
    // read or write, whatever the command is built from.
    const secretRead = hook.classifyShellAccess('Bash', { command: `cat ${path.join(home, '.claude', '.credentials.json')}` }, ws, [], home);
    assert.strictEqual(secretRead.crossings[0].secret, true, 'a read-only command touching the credential file still cards');
  });

  test('a PowerShell read is a read: the registry is not Unix-only', () => {
    // MEASURED ON WINDOWS. Asked to list the global agents and skills, the
    // agent ran Get-ChildItem and was shown "this reaches more than one place
    // outside your workspace ... writing here persists", naming both folders.
    // The registry that frees a read under the runtime home listed only Unix
    // commands, so every PowerShell read graded as a write, and the storm this
    // release exists to end was untouched on Windows while fixed on macOS.
    //
    // The risk grader had known PowerShell's verbs all along. Two lists of
    // what counts as a read, one of them never taught about the platform.
    const home = tmp('af-ps-home-');
    fs.mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true });
    fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
    const ws = tmp('af-ps-ws-');
    const agents = path.join(home, '.claude', 'agents');
    const skills = path.join(home, '.claude', 'skills');

    for (const command of [
      `Get-ChildItem ${agents}, ${skills}`,
      `Get-ChildItem ${agents} -Force`,
      `gci ${agents}`,
      `dir ${agents}`,
      `Get-Content ${path.join(agents, 'x.md')}`,
      `gc ${path.join(agents, 'x.md')}`,
      `Test-Path ${agents}`,
      // PowerShell is case-insensitive, and agents write it every which way.
      `get-childitem ${agents}`,
      `GET-CHILDITEM ${agents}`,
    ]) {
      assert.strictEqual(hook.classifyShellAccess('PowerShell', { command }, ws, [], home), null,
        `a PowerShell read raises no crossing: ${command}`);
    }

    // FAIL SAFE. A PowerShell write or removal against the same folder still
    // cards, and one destructive segment still fails the whole line.
    for (const command of [
      `Remove-Item ${path.join(agents, 'x.md')}`,
      `Set-Content ${path.join(agents, 'x.md')} -Value hi`,
      `Get-ChildItem ${agents}; Remove-Item ${path.join(agents, 'x.md')}`,
      `New-Item ${path.join(agents, 'x.md')}`,
    ]) {
      const verdict = hook.classifyShellAccess('PowerShell', { command }, ws, [], home);
      assert.ok(verdict && verdict.crossings.some(c => c.persistenceSurface),
        `a PowerShell write still cards: ${command}`);
    }

    // And the secrets tier is not re-graded by any of this.
    const secret = hook.classifyShellAccess('PowerShell',
      { command: `Get-Content ${path.join(home, '.claude', '.credentials.json')}` }, ws, [], home);
    assert.strictEqual(secret.crossings[0].secret, true, 'a PowerShell read of the credential file still cards');
  });

  test('a bare & joins two commands, so the second is graded on its own and cannot ride the first', () => {
    // A single `&` backgrounds what precedes it and runs what follows, so it
    // joins two commands exactly as `&&` does. The segmenter split on `&&`,
    // `||`, `;` and `|` and passed a lone `&` through as ordinary text, so the
    // whole command was judged by its leading word: `ls x & rm -rf x` read as
    // read-only on the strength of the `ls`, and the removal against a
    // persistence surface was freed without a card.
    const home = tmp('af-amp-home-');
    fs.mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true });
    const ws = tmp('af-amp-ws-');
    const agents = path.join(home, '.claude', 'agents');

    for (const command of [
      `ls -1 ${agents} & rm -rf ${path.join(agents, 'dev.md')}`,
      `ls -1 ${agents} 2>/dev/null & rm -rf ${path.join(agents, 'dev.md')}`,
      // Backgrounding the destructive half instead must fail the same way.
      `rm -rf ${path.join(agents, 'dev.md')} & ls -1 ${agents}`,
      // And the existing separators keep failing, so the fix adds one rather
      // than replacing the set.
      `ls -1 ${agents} && rm -rf ${path.join(agents, 'dev.md')}`,
    ]) {
      const verdict = hook.classifyShellAccess('Bash', { command }, ws, [], home);
      assert.ok(verdict && verdict.crossings.some(c => c.persistenceSurface),
        `one unregistered command disqualifies the whole line, however it is joined: ${command}`);
    }

    // A command that is merely backgrounded, with nothing after it, is still
    // only that command: the separator must not turn a read into a write.
    assert.strictEqual(hook.classifyShellAccess('Bash', { command: `ls -1 ${agents} &` }, ws, [], home), null,
      'backgrounding a read is still a read');
  });

  test('a redirection that discards output is not a write, so it cannot turn a read-only command into a persistence-surface card', () => {
    // MEASURED FROM A REAL SESSION. Asked to list the global agents and
    // skills, an agent reached for
    //   ls -1 ~/.claude/agents/ 2>/dev/null; echo ...; ls -1 ~/.claude/skills/
    // and the user was shown "this reaches more than one place outside your
    // workspace ... writing here persists". Nothing in that command writes.
    // The whole-string test for `>` could not tell a discard from a write, so
    // one `2>/dev/null` dropped the command out of the read-only registry and
    // it was graded as a WRITE to two persistence surfaces.
    //
    // A redirect to /dev/null throws output away and a redirect to a file
    // descriptor duplicates a handle. Neither can create or modify a file, so
    // neither is evidence of a write. Every other redirect target still is.
    const home = tmp('af-discard-home-');
    fs.mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true });
    fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
    const ws = tmp('af-discard-ws-');
    const agents = path.join(home, '.claude', 'agents');
    const skills = path.join(home, '.claude', 'skills');

    for (const command of [
      `ls -1 ${agents} 2>/dev/null`,
      `ls -1 ${agents} >/dev/null`,
      `ls -1 ${agents} &>/dev/null`,
      `ls -1 ${agents} 2>&1`,
      `ls -1 ${agents} 2>/dev/null | head`,
      // The exact command from the session above.
      `ls -1 ${agents} 2>/dev/null; echo "=== SKILLS ==="; ls -1 ${skills} 2>/dev/null`,
    ]) {
      assert.strictEqual(hook.classifyShellAccess('Bash', { command }, ws, [], home), null,
        `discarding output writes nothing, so this raises no crossing: ${command}`);
    }

    // FAIL SAFE IS UNCHANGED. Only /dev/null and descriptor duplication are
    // exempt; a redirect to any real path is still a write, including one
    // that lands inside the surface itself, and `tee` still writes.
    for (const command of [
      `echo x > ${path.join(agents, 'y.md')}`,
      `ls -1 ${agents} > ${path.join(agents, 'listing.txt')}`,
      `ls -1 ${agents} 2>/dev/null > ${path.join(agents, 'listing.txt')}`,
      `ls -1 ${agents} >> ${path.join(home, '.claude', 'log.txt')}`,
      `ls -1 ${agents} | tee ${path.join(agents, 'listing.txt')}`,
    ]) {
      const verdict = hook.classifyShellAccess('Bash', { command }, ws, [], home);
      assert.ok(verdict && verdict.crossings.some(c => c.persistenceSurface),
        `a redirect to a real path is still a write, so this must still card: ${command}`);
    }
  });

  test('the runtime home root is never offered as a folder to remember: settings.json is the one persistence-surface FILE, and its parent IS the root', () => {
    // Every other persistence surface is a folder, so the grant offered
    // beside its card is scoped to that folder alone. settings.json sits
    // directly at the runtime home root, so path.dirname of it is not a
    // sub-folder at all: it is `~/.claude` itself. Offering that as a
    // "whole folder" grant would silence agents/, skills/, plugins/,
    // commands/ and hooks/ too, which is the wide-grant shape this release
    // removed, returning through the one crossing shaped like a file.
    const home = tmp('af-grantdir-home-');
    fs.mkdirSync(path.join(home, '.claude', 'hooks'), { recursive: true });
    const ws = tmp('af-grantdir-ws-');

    const settingsWrite = hook.classifyFileAccess('Write', { file_path: path.join(home, '.claude', 'settings.json') }, ws, [], home);
    assert.strictEqual(settingsWrite.grantDir, null, 'no folder grant is offered for the runtime home root');

    const hooksWrite = hook.classifyFileAccess('Write', { file_path: path.join(home, '.claude', 'hooks', 'pretool.sh') }, ws, [], home);
    assert.strictEqual(hooksWrite.grantDir, hook.canonicalize(path.join(home, '.claude', 'hooks')),
      'a folder-shaped persistence surface still offers a grant, scoped no wider than its own folder');
  });
});

// ARCHITECTURE.md's boundary passage names two guarantees about the same
// credential file that hold at DIFFERENT layers: the OS-level sandbox block
// (lib/workspace/scaffold.js's runtimeRoots) permits writing anywhere under
// `~/.claude`, because the runtime's own bookkeeping lives there, while the
// permission card (the secrets registry) always refuses the credential file
// regardless, in both modes. That distinction only holds while the
// credential file actually sits inside the root the OS-level block names as
// writable: a future secrets-registry entry that landed outside it, or a
// writable-roots change that stopped naming `~/.claude`, would silently
// change which layer is doing the refusing without either document noticing.
describe('the secrets registry sits inside the OS-permitted root, which is what makes it a different layer\'s guarantee', () => {
  test('every secrets-registry path resolves under the same runtime-home root the sandbox block names as writable', () => {
    const home = '/Users/someone';
    const block = scaffold.sandboxSettings('/w/ws', 'darwin', home);
    const claudeRoot = path.posix.join(home, '.claude');
    assert.ok(block.filesystem.allowWrite.includes(claudeRoot),
      'the OS-level block names the runtime home as a writable root');
    for (const relative of hook.SECRET_RELATIVE_PATHS) {
      const secretPath = path.posix.join(claudeRoot, relative);
      assert.ok(secretPath === claudeRoot || secretPath.startsWith(claudeRoot + '/'),
        `${secretPath} must sit inside the root the OS-level block permits, or the card is no longer the only thing refusing it`);
    }
  });
});

// ── Named working folders ──────────────────────────────────────────────
// A workspace can name folders its agents also work in. The mechanism is the
// same containment comparison the workspace root already uses, so the tests
// that matter are not the ones proving a named folder works. They are the ones
// proving it does NOT reach where it must never reach.
//
// The comparison runs before the runtime-home tier tags at every site that
// consults it, so a named ancestor of `~/.claude` would otherwise classify
// `.credentials.json` as inside and allow it outright: no card, no grading,
// the secrets tier never consulted. Every assertion below drives a real named
// folder rather than asserting on the helper, because the helper being correct
// in isolation is exactly what the escape looked like.
describe('a named working folder covers what is beneath it, and stops at the runtime home', () => {
  test('a named parent covers a project beneath it, including one created later', () => {
    const ws = tmp('nf-ws-');
    const projects = tmp('nf-projects-');
    fs.mkdirSync(path.join(projects, 'alchemist', 'src'), { recursive: true });

    const inNamed = hook.classifyFileAccess('Read', { file_path: path.join(projects, 'alchemist', 'src', 'a.js') }, ws, [projects]);
    assert.strictEqual(inNamed.where, 'inside', 'a file beneath the named parent raises no card');

    // The point of naming a PARENT: a folder that does not exist yet is
    // covered by the same act, with nothing further to approve.
    const unborn = path.join(projects, 'a-project-started-next-month', 'index.js');
    assert.strictEqual(hook.classifyFileAccess('Write', { file_path: unborn }, ws, [projects]).where, 'inside',
      'a folder created later is covered without naming it');

    // And the reported case end to end: a build is almost all shell, and a
    // shell crossing offers no standing grant, so this is the one that decides
    // whether the storm actually stops.
    assert.strictEqual(
      hook.classifyShellAccess('Bash', { command: `npm run build --prefix ${path.join(projects, 'alchemist')}` }, ws, [projects]),
      null, 'a shell command reaching a project beneath the named parent reports no crossing at all');

    // A sibling that was NOT named is untouched by any of this.
    const elsewhere = tmp('nf-elsewhere-');
    assert.strictEqual(hook.classifyFileAccess('Read', { file_path: path.join(elsewhere, 'x.md') }, ws, [projects]).where, 'outside',
      'naming one folder says nothing about any other');

    // AND THE LOOKALIKE, which is how this comparison goes wrong when it goes
    // wrong: a bare string prefix puts `Projects-old` inside `Projects`,
    // because the separator stops being part of the comparison. Built as a
    // deliberate pair rather than two random temporary names, or the case is
    // never actually exercised.
    const base = tmp('nf-pair-');
    const named = path.join(base, 'Projects');
    const lookalike = path.join(base, 'Projects-old');
    fs.mkdirSync(named, { recursive: true });
    fs.mkdirSync(lookalike, { recursive: true });
    assert.strictEqual(hook.classifyFileAccess('Read', { file_path: path.join(named, 'a.md') }, ws, [named]).where,
      'inside', 'the named folder itself is covered');
    assert.strictEqual(hook.classifyFileAccess('Read', { file_path: path.join(lookalike, 'a.md') }, ws, [named]).where,
      'outside', 'Projects-old is not inside Projects, whatever their names share');
  });

  test('naming the home folder does not silence the secrets tier, by file tool or by shell', () => {
    const home = tmp('nf-secret-home-');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const ws = tmp('nf-secret-ws-');
    const credentials = path.join(home, '.claude', '.credentials.json');
    fs.writeFileSync(credentials, '{}');

    // `home` is named as a working folder, and it CONTAINS the runtime home.
    const read = hook.classifyFileAccess('Read', { file_path: credentials }, ws, [home], home);
    assert.strictEqual(read.where, 'outside', 'the secrets tier still cards, whatever is named');
    assert.strictEqual(read.secret, true);
    assert.strictEqual(read.grantDir, null, 'and still offers no standing grant');

    const shell = hook.classifyShellAccess('Bash', { command: `cat ${credentials}` }, ws, [home], home);
    assert.ok(shell && shell.crossings.length === 1, 'the shell half reports the crossing too');
    assert.strictEqual(shell.crossings[0].secret, true);
  });

  test('naming the home folder does not silence a persistence-surface write', () => {
    const home = tmp('nf-surface-home-');
    fs.mkdirSync(path.join(home, '.claude', 'agents'), { recursive: true });
    const ws = tmp('nf-surface-ws-');

    const write = hook.classifyFileAccess('Write', { file_path: path.join(home, '.claude', 'agents', 'new.md') }, ws, [home], home);
    assert.strictEqual(write.where, 'outside', 'a write to a persistence surface still cards');
    assert.strictEqual(write.persistenceSurface, true);

    const shell = hook.classifyShellAccess('Bash', { command: `touch ${path.join(home, '.claude', 'agents', 'x.md')}` }, ws, [home], home);
    assert.strictEqual(shell.crossings[0].persistenceSurface, true);

    // The freeing half of the tier is equally intact: naming a folder must not
    // change what was already free, or the setting would be silently altering
    // decisions nobody asked it to alter.
    fs.mkdirSync(path.join(home, '.claude', 'cache'), { recursive: true });
    assert.strictEqual(
      hook.classifyFileAccess('Write', { file_path: path.join(home, '.claude', 'cache', 'page.html') }, ws, [home], home).where,
      'inside', 'free scratch under the runtime home stays free');
  });

  test('a runtime home reached through a symlink is still the runtime home, whatever is named', () => {
    // BOTH SIDES OF THE STOP ARE CANONICALISED, and this is what proves it. A
    // home whose .claude is a link elsewhere resolves to a real directory that
    // a named ancestor could otherwise contain: name that ancestor and, if the
    // stop compared the unresolved spelling, the secrets tier would be reached
    // through the back door while the front door stayed shut.
    const home = tmp('nf-linkhome-');
    const realStore = tmp('nf-linkhome-real-');
    const claudeReal = path.join(realStore, 'claude-data');
    fs.mkdirSync(claudeReal, { recursive: true });
    try { fs.symlinkSync(claudeReal, path.join(home, '.claude'), 'dir'); } catch (e) { return; }
    assert.notStrictEqual(fs.realpathSync(path.join(home, '.claude')), path.join(home, '.claude'),
      'the link and its target must differ, or this passes vacuously');
    const credentials = path.join(home, '.claude', '.credentials.json');
    fs.writeFileSync(credentials, '{}');
    const ws = tmp('nf-linkhome-ws-');

    // realStore is named, and it CONTAINS the runtime home's real directory.
    const read = hook.classifyFileAccess('Read', { file_path: credentials }, ws, [realStore], home);
    assert.strictEqual(read.where, 'outside', 'the secrets tier is reached through the link and still cards');
    assert.strictEqual(read.secret, true);
    const shell = hook.classifyShellAccess('Bash', { command: `cat ${credentials}` }, ws, [realStore], home);
    assert.ok(shell && shell.crossings.length === 1 && shell.crossings[0].secret === true,
      'and the shell half agrees, rather than the two disagreeing about one path');
  });

  test('a named folder is canonicalised, so a folder reached through a symlink still covers its files', () => {
    // Dropbox and iCloud folders are routinely symlinked, and the storm this
    // setting ends is partly a symlink story already. A named folder compared
    // unresolved would cover nothing while looking configured.
    const real = tmp('nf-link-real-');
    fs.mkdirSync(path.join(real, 'proj'), { recursive: true });
    const linkParent = tmp('nf-link-parent-');
    const link = path.join(linkParent, 'named');
    try { fs.symlinkSync(real, link, 'dir'); } catch (e) { return; }
    // Precondition: the two spellings must actually differ, or this passes
    // vacuously on a host where they coincide.
    assert.notStrictEqual(fs.realpathSync(link), link, 'the link and its target must be different paths for this to prove anything');

    const ws = tmp('nf-link-ws-');
    assert.strictEqual(hook.classifyFileAccess('Read', { file_path: path.join(real, 'proj', 'a.md') }, ws, [link]).where, 'inside',
      'named through the link, reached through the real path');
    assert.strictEqual(hook.classifyFileAccess('Read', { file_path: path.join(link, 'proj', 'a.md') }, ws, [real]).where, 'inside',
      'named through the real path, reached through the link');
  });

  test('naming nothing changes nothing, which is what every other test in this file assumes', () => {
    const home = tmp('nf-empty-home-');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const ws = tmp('nf-empty-ws-');
    const outside = tmp('nf-empty-outside-');
    assert.strictEqual(hook.classifyFileAccess('Read', { file_path: path.join(outside, 'x.md') }, ws, [], home).where, 'outside');
    assert.strictEqual(hook.classifyFileAccess('Read', { file_path: path.join(ws, 'x.md') }, ws, [], home).where, 'inside');
  });
});
