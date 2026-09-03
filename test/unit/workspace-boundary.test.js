'use strict';
// The boundary stops flooding, proven at its three layers: the block the
// runtime is started with names the runtime's own measured plumbing, every
// comparison canonicalises so one directory under two names is one identity,
// the switch that withdraws the block is honest about what that withdraws,
// and a crossing into the runtime's home carries its stakes and a narrower
// grant. Fixtures are real directories, real symlinks and the machine's own
// /private alias, because every false card in the field came from a spelling
// a hand-built fixture would not have thought to write.
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
    const edited = scaffold.sandboxSettings('/w/ws', 'darwin', '/Users/me');
    edited.filesystem.allowWrite.push('/Users/me/their-own-root');
    assert.strictEqual(scaffold.isRundockSandbox(edited), false);
    const reordered = scaffold.sandboxSettings('/w/ws', 'darwin', '/Users/me');
    const w = reordered.filesystem.allowWrite;
    [w[2], w[3]] = [w[3], w[2]];
    assert.strictEqual(scaffold.isRundockSandbox(reordered), false, 'the order is contract');
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

  test('a case variant of an inside path never cards', () => {
    const ws = tmp('wb-case-');
    fs.mkdirSync(path.join(ws, 'Docs'));
    fs.writeFileSync(path.join(ws, 'Docs', 'a.md'), 'x');
    const variant = path.join(ws, 'dOCS', 'a.md');
    assert.strictEqual(hook.classifyFileAccess('Read', { file_path: variant }, ws, []).where, 'inside',
      'on the default case-insensitive filesystem this is the same file; on a case-sensitive one it is an unborn path under the workspace, and both are inside');
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
});

describe('the switch that withdraws the block is honest', () => {
  function workspaceWithBlock() {
    const ws = tmp('wb-switch-');
    fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
    return ws;
  }

  test('opting out removes our block and remembers the choice; opting in restores it', () => {
    const ws = workspaceWithBlock();
    scaffold.setSandboxOptOut(ws, false);
    const settingsPath = path.join(ws, '.claude', 'settings.local.json');
    let settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.ok(settings.sandbox, 'opted in: the block is written');
    scaffold.setSandboxOptOut(ws, true);
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.strictEqual('sandbox' in settings, false, 'opted out: the block is withdrawn');
    assert.strictEqual(scaffold.sandboxOptedOut(ws), true, 'and the choice survives to the next open');
    scaffold.setSandboxOptOut(ws, false);
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.ok(settings.sandbox, 'opting back in restores the block');
  });

  test('a person\'s own block is never touched by the switch, in either direction', () => {
    const ws = workspaceWithBlock();
    const theirs = { enabled: false, note: 'mine' };
    fs.writeFileSync(path.join(ws, '.claude', 'settings.local.json'), JSON.stringify({ sandbox: theirs }));
    scaffold.setSandboxOptOut(ws, true);
    scaffold.setSandboxOptOut(ws, false);
    const settings = JSON.parse(fs.readFileSync(path.join(ws, '.claude', 'settings.local.json'), 'utf8'));
    assert.deepStrictEqual(settings.sandbox, theirs, 'whoever wrote it decided something');
  });

  test('the legacy block upgrades to the measured shape through the switch\'s reconcile', () => {
    const ws = workspaceWithBlock();
    const home = os.homedir();
    const legacy = {
      enabled: true, autoAllowBashIfSandboxed: true,
      filesystem: { allowWrite: [ws, path.posix.join(home, '.npm')] },
      network: { allowedDomains: ['*'] },
    };
    fs.writeFileSync(path.join(ws, '.claude', 'settings.local.json'), JSON.stringify({ sandbox: legacy }));
    scaffold.setSandboxOptOut(ws, false);
    const settings = JSON.parse(fs.readFileSync(path.join(ws, '.claude', 'settings.local.json'), 'utf8'));
    assert.ok(settings.sandbox.filesystem.allowWrite.includes(path.posix.join(home, '.claude')),
      'the two-root block became the measured block on the next reconcile');
  });

  test('the switch\'s copy names what it withdraws and the class it can never help', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'views', 'settings.js'), 'utf8');
    assert.match(src, /operating-system level|operating-system write block/, 'what turning it off withdraws is named');
    assert.match(src, /headless browser/, 'the process-launch class no writable root can reach is named');
    assert.match(src, /Windows and Linux/, 'and where the card is already the whole boundary');
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

  test('the card copy names the stakes concretely and offers the narrow grant by name', () => {
    const copy = permissions.sensitiveBoundaryCopy('claude-home');
    assert.match(copy.context, /\.credentials\.json/, 'the account token is named');
    assert.match(copy.context, /transcripts/, 'and the transcripts');
    assert.match(copy.narrowLabel, /transcripts only/, 'the narrow affordance says what it grants');
    assert.strictEqual(permissions.sensitiveBoundaryCopy('anything-else'), null,
      'paths outside the table render the existing card unchanged');
  });
});
