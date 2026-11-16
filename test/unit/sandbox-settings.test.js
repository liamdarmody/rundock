'use strict';
// The runtime command sandbox: what the workspace tells the spawned runtime
// about which roots a shell command may write to.
//
// This is the half of the boundary the hook cannot provide. The hook decides
// on the tool call; the sandbox decides at syscall time, so it covers the
// commands nothing could have parsed. Every value below was measured against
// the CLI on 2026-08-22, not read from documentation:
//
//   - Filesystem: the allowlist is ADDITIVE to the runtime's own defaults, and
//     a write outside it fails with "Operation not permitted".
//   - Network: enabling the sandbox also isolates the network, and with no
//     allowedDomains EVERY outbound host is refused. `npm install`, `git push`
//     and `curl` all break. "*" restores them while leaving the filesystem
//     boundary intact, which is why it is here and why removing it is not a
//     tightening but a breakage.
//   - The npm cache: without the cache root, `npm install` fails on its own
//     cache directory (npm reports it as an ownership error, which it is not).
//   - Platform: the sandbox is macOS and Linux. Native Windows has none, and
//     Windows is one of the two platforms this product builds for. Linux is
//     left off because it was not measured here.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const SCAFFOLD = path.join(__dirname, '..', '..', 'lib', 'workspace', 'scaffold.js');

const { sandboxSettings, isRundockSandbox, WRITTEN_DENY_LENGTHS } = require('../../lib/workspace/scaffold.js');

const WS = '/tmp/sandbox-ws';
const HOME = '/Users/someone';
// The shell startup files the block denies are this process's own, so the
// lists below are read with no ZDOTDIR or XDG_CONFIG_HOME, run from source.
for (const name of ['ZDOTDIR', 'XDG_CONFIG_HOME', 'RUNDOCK_ELECTRON']) delete process.env[name];
const RECORD = path.join(__dirname, '..', '..', '.startup-file-exposure.json');
const STARTUP_DENY = [
  ...['.zshenv', '.zprofile', '.zshrc', '.zlogin', '.zlogout', '.bash_profile', '.bash_login', '.profile', '.bashrc', '.bash_logout'].map(f => `${HOME}/${f}`),
  `${HOME}/.config/fish/config.fish`, `${HOME}/.config/fish/conf.d`, RECORD,
];

describe('sandboxSettings', () => {
  test('on macOS the workspace is writable and the rest of the machine is not', () => {
    const s = sandboxSettings(WS, 'darwin', HOME);
    assert.strictEqual(s.enabled, true);
    assert.ok(s.filesystem.allowWrite.includes(WS), 'the workspace itself is writable');
    assert.ok(!s.filesystem.allowWrite.includes(HOME),
      'the home directory is NOT: that is the crossing this exists to stop');
  });

  test('the npm cache is writable, because npm install fails on its cache otherwise', () => {
    const s = sandboxSettings(WS, 'darwin', HOME);
    assert.ok(s.filesystem.allowWrite.includes(path.join(HOME, '.npm')),
      'measured: without this npm install fails, reported by npm as an ownership error');
  });

  test('the network stays open, because enabling the sandbox otherwise closes it', () => {
    const s = sandboxSettings(WS, 'darwin', HOME);
    assert.deepStrictEqual(s.network.allowedDomains, ['*'],
      'with no allowedDomains every outbound host is refused for shell commands');
  });

  test('called the way production calls it, with no platform or home passed', () => {
    // Every other test here supplies both, and all of them passed while the
    // module had no `os` import at all: the default that reads the home
    // directory would have thrown on the first real call. A decision function
    // exercised only through arguments its caller never passes is not covered.
    //
    // Stated as an equivalence rather than a branch, so the same property is
    // checked on every machine. Branching on process.platform here would put
    // the interesting half behind a macOS runner and leave continuous
    // integration, which runs Linux, asserting only that null is null.
    assert.deepStrictEqual(
      sandboxSettings(WS),
      sandboxSettings(WS, process.platform, os.homedir()),
      'omitting both arguments resolves to this platform and this home',
    );
  });

  test('a block written on macOS is still recognised as ours by a WINDOWS host', () => {
    // The block is a macOS artefact: sandboxSettings only ever produces one
    // for darwin, so every path in it is POSIX by construction. Recognition
    // has to read it back with POSIX rules whatever host is doing the
    // reading. Judged with the host's separator instead, a Windows machine
    // opening a workspace scaffolded on a Mac saw `/Users/me/.npm`, did not
    // match `\\.npm`, called the block somebody's edit, and then neither
    // reconciled nor withdrew it: the runtime kept being handed a macOS
    // absolute root on the one platform where nothing has been measured.
    //
    // Run in a child process, because a Windows host is not something this
    // one can be asked about directly. Two details make the simulation
    // faithful, and the first version of this test got both wrong:
    //
    //   - `path` is REPLACED for the module under test rather than mutated in
    //     place. On a POSIX host `require('path') === require('path').posix`,
    //     so mutating the default turns `path.posix` into win32 as well, and
    //     the code being tested then has no correct implementation to reach
    //     for. The stand-in behaves as win32 while `path.posix` stays real,
    //     which is exactly what a Windows host looks like.
    //   - The assertion checks the separator the child actually used, so a
    //     simulation that quietly failed to take effect reports as a failure
    //     rather than as a pass.
    const script = `
      const Module = require('module');
      const real = require('path');
      const fake = Object.create(real.win32);
      fake.posix = real.posix;
      fake.win32 = real.win32;
      const load = Module._load;
      let handed = 0;
      Module._load = function (request, ...rest) {
        if (request === 'path' || request === 'node:path') { handed++; return fake; }
        return load.call(this, request, ...rest);
      };
      const s = require(${JSON.stringify('SCAFFOLD_PATH')});
      Module._load = load;
      const block = ${JSON.stringify({
        enabled: true,
        autoAllowBashIfSandboxed: true,
        filesystem: { allowWrite: ['/Users/me/ws', '/Users/me/.npm'] },
        network: { allowedDomains: ['*'] },
      })};
      const stranger = JSON.parse(JSON.stringify(block));
      stranger.filesystem.allowWrite[1] = '/somewhere/else';
      process.stdout.write(JSON.stringify({
        sep: fake.sep,
        handed,
        cacheRoot: s.sandboxSettings('/Users/me/ws', 'darwin', '/Users/me').filesystem.allowWrite[1],
        ours: s.isRundockSandbox(block, 'darwin'),
        stranger: s.isRundockSandbox(stranger, 'darwin'),
      }));
    `.replace('SCAFFOLD_PATH', SCAFFOLD);
    const r = JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf-8' }));
    assert.strictEqual(r.sep, '\\', 'the stand-in is a Windows one');
    // Counted rather than inferred. Asserting on the stand-in's separator
    // only proves the stand-in was BUILT: it says nothing about whether the
    // module under test ever received it, so a simulation that quietly
    // failed to take effect reported a pass.
    assert.ok(r.handed > 0, 'and the module under test was actually handed it');
    assert.strictEqual(r.cacheRoot, '/Users/me/.npm', 'and still WRITES the cache root with POSIX separators');
    assert.strictEqual(r.ours, true, 'so our own block is recognised there');
    assert.strictEqual(r.stranger, false, 'while a block we did not write is still refused');
  });

  test('on Windows there is no sandbox to configure, so nothing is written', () => {
    // Stated rather than silently omitted: this is the platform where the
    // boundary rests on the hook alone, and half the shipped surface.
    assert.strictEqual(sandboxSettings(WS, 'win32', HOME), null);
  });

  test('on Linux nothing is written either, because nothing was measured there', () => {
    // The runtime documents Linux support and it would very likely work. It
    // was not RUN here, and every other value in this file was. Linux stays
    // off until someone measures it rather than reads about it.
    assert.strictEqual(sandboxSettings(WS, 'linux', HOME), null);
  });
});

// The named working folders, and the layer Rundock does not own.
//
// MEASURED against Claude Code 2.1.266 on 2026-09-12, by reading the shipped
// binary rather than the documentation:
//
//   - `sandbox.enabled` resolves as `enabled ?? false`. No block is no sandbox.
//   - The enable is an OR across EVERY settings layer (managed, flags, user,
//     project, local): `[...].some((e) => e?.sandbox?.enabled === true)`.
//     Rundock writes the local layer alone, so a user who enabled the sandbox
//     in their own ~/.claude/settings.json has enabled it for every workspace
//     on the machine and nothing Rundock writes can disable it.
//   - Write allowlists UNION across layers, verified in a live session
//     carrying a user-level entry and a workspace-level one, both honoured.
//
// Together those are why Code mode contributes paths with no enable: deleting
// the block removed Rundock's enable and left the user's, and the workspace
// then met an operating system that had never been told which folders the user
// named. That is the reported defect, and no amount of naming folders in
// Rundock fixed it, because the folders never reached this file.
describe('sandboxSettings: named working folders', () => {
  const FOLDERS = ['/Users/someone/Projects', '/Users/someone/Tools'];

  test('a named folder is writable, which is the whole of the reported defect', () => {
    const s = sandboxSettings(WS, 'darwin', HOME, ['/tmp/t'], FOLDERS);
    for (const f of FOLDERS) assert.ok(s.filesystem.allowWrite.includes(f), `${f} is writable`);
  });

  // WHAT THE BLOCK LOOKED LIKE BEFORE THIS CHANGE, written out rather than
  // computed. The first version of the test below compared sandboxSettings to
  // ITSELF with an empty folder list, which passes however much the block
  // changes: it proved the folders argument defaults to empty and nothing
  // whatever about matching what shipped. A reference the code cannot rebuild
  // is the only thing that can catch a key appearing or a value moving.
  const SHIPPED_KNOWLEDGE_BLOCK = {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    filesystem: {
      allowWrite: [
        WS,
        `${HOME}/.npm`,
        `${HOME}/.claude`,
        `${HOME}/.claude.json`,
        '/tmp/claude',
        '/private/tmp/claude',
        '/tmp/t',
      ],
    },
    network: { allowedDomains: ['*'] },
  };

  // THE DENY LISTS RELEASES ACTUALLY WROTE, written out rather than cut from
  // today's list, so the recogniser is checked against what is on people's
  // disks and not against itself. Read from each tagged release's
  // sandboxSettings output: no denyWrite for 0.13.0 to 0.13.2, three entries
  // for 0.13.3 to 0.15.5, eight for 0.15.6. One and two entries were written by
  // the development line between 0.13.2 and 0.13.3, and by no release; the
  // first nineteen, then twenty-one, then all twenty-two, by the development
  // line after 0.15.6.
  const RELEASED_DENY = [
    `${WS}/.rundock/state.json`, `${WS}/.rundock/permissions.json`, `${WS}/.claude/settings.local.json`,
    `${HOME}/.claude/.credentials.json`, `${HOME}/.claude/.config.json`, `${HOME}/.codex/auth.json`,
    `${HOME}/.claude.json`, `${HOME}/.claude.json.backup`,
    `${HOME}/.claude/settings.json`, `${HOME}/.claude/plugins`, `${HOME}/.claude/hooks`, `${HOME}/.claude/skills`,
    `${HOME}/.claude/agents`, `${HOME}/.claude/commands`, `${HOME}/.claude/backups`,
    `${HOME}/.claude-staging-oauth.json`, `${HOME}/.claude-local-oauth.json`, `${HOME}/.claude-custom-oauth.json`,
    `${WS}/.claude/settings.json`,
    `${WS}/.mcp.json`, `${WS}/.rundock/permission-hook.sh`, `${WS}/.rundock/mcp-secrets.json`,
    `${HOME}/.rundock-console`,
  ];
  const WRITTEN_LENGTHS = [0, 1, 2, 3, 8, 19, 21, 22, 23];
  function released(n, shape) {
    const allowWrite = [...SHIPPED_KNOWLEDGE_BLOCK.filesystem.allowWrite, ...FOLDERS];
    const filesystem = n ? { allowWrite, denyWrite: RELEASED_DENY.slice(0, n) } : { allowWrite };
    if (shape === 'on') return { ...SHIPPED_KNOWLEDGE_BLOCK, filesystem };
    if (shape === 'off') return { enabled: false, filesystem };
    return { filesystem }; // Code mode before it stated `enabled: false`
  }

  test('a workspace with no folders writes what it wrote before, and the deny is the one intended difference', () => {
    const s = sandboxSettings(WS, 'darwin', HOME, ['/tmp/t']);
    // The deny list is a deliberate addition made after the criteria were
    // frozen, approved on the ledger rather than slipped in: it protects the
    // file this very block is built from. It is the ONLY difference, and
    // subtracting it must leave the shipped block exactly. When this list grows,
    // add the length it had to WRITTEN_DENY_LENGTHS in scaffold.js, or blocks
    // the last release wrote stop being recognised and never upgrade.
    assert.deepStrictEqual(s.filesystem.denyWrite,
      [`${WS}/.rundock/state.json`, `${WS}/.rundock/permissions.json`, `${WS}/.claude/settings.local.json`,
        `${HOME}/.claude/.credentials.json`, `${HOME}/.claude/.config.json`, `${HOME}/.codex/auth.json`, `${HOME}/.claude.json`, `${HOME}/.claude.json.backup`,
        `${HOME}/.claude/settings.json`, `${HOME}/.claude/plugins`, `${HOME}/.claude/hooks`, `${HOME}/.claude/skills`,
        `${HOME}/.claude/agents`, `${HOME}/.claude/commands`, `${HOME}/.claude/backups`,
        `${HOME}/.claude-staging-oauth.json`, `${HOME}/.claude-local-oauth.json`, `${HOME}/.claude-custom-oauth.json`,
        `${WS}/.claude/settings.json`, `${WS}/.mcp.json`, `${WS}/.rundock/permission-hook.sh`, `${WS}/.rundock/mcp-secrets.json`,
        `${HOME}/.rundock-console`, ...STARTUP_DENY],
      'the intended difference, named: every file that holds answers to permission questions, the workspace\'s own permission configuration included, then the runtimes\' credential files, then what the runtime acts on outside the sandbox, then the workspace\'s connector file, the launcher the permission hook is started through, the per-user connector file, Rundock\'s console folder, and the shell startup files with Rundock\'s record of them');
    const { denyWrite, ...filesystem } = s.filesystem;
    assert.deepStrictEqual({ ...s, filesystem }, SHIPPED_KNOWLEDGE_BLOCK,
      'and with it removed, key for key and value for value, the block that shipped');
  });

  test('naming folders appends to the write list and changes nothing else', () => {
    const s = sandboxSettings(WS, 'darwin', HOME, ['/tmp/t'], FOLDERS);
    const { denyWrite, ...filesystem } = s.filesystem;
    const base = SHIPPED_KNOWLEDGE_BLOCK.filesystem.allowWrite;
    assert.deepStrictEqual(filesystem.allowWrite, [...base, ...FOLDERS],
      'the folders go on the end, and the head keeps the positions the recogniser reads');
    assert.deepStrictEqual(
      { ...s, filesystem: { allowWrite: base } },
      SHIPPED_KNOWLEDGE_BLOCK,
      'every other key is untouched: the enable, the prompting flag and the network stay as they were');
  });

  test('Code mode turns the sandbox off, rather than declining to turn it on', () => {
    const s = sandboxSettings(WS, 'darwin', HOME, ['/tmp/t'], FOLDERS, 'code');
    // Saying false, not saying nothing. Absence loses to any layer that enables:
    // the user's own ~/.claude/settings.json, or the runtime's default once any
    // sandbox key exists. Code mode is documented as having the write block off,
    // and a headless browser cannot launch under Seatbelt whatever the allowWrite
    // list says, so silence here meant an unsilenceable card on every render.
    assert.strictEqual(s.enabled, false, 'off, stated, so no other layer can enable it back');
    assert.ok(!('autoAllowBashIfSandboxed' in s), 'and no prompting claim to go with it');
    assert.ok(!('network' in s),
      'and no network key: "*" unioned into a layer would widen a policy the user set deliberately');
    for (const f of FOLDERS) assert.ok(s.filesystem.allowWrite.includes(f),
      'but the folders are here, for the case where another layer did the enabling');
  });

  test('Knowledge mode is unchanged except for the folders', () => {
    const s = sandboxSettings(WS, 'darwin', HOME, ['/tmp/t'], FOLDERS);
    assert.strictEqual(s.enabled, true);
    assert.strictEqual(s.autoAllowBashIfSandboxed, true);
    assert.deepStrictEqual(s.network, { allowedDomains: ['*'] });
  });

  test('the file this block is built from cannot be written by what the block contains', () => {
    // .rundock/state.json holds the mode and the named folders, and both decide
    // what this block says. It also sits inside the workspace, so the
    // permission hook classifies a write to it as inside and never cards it.
    // Without a deny, an agent could widen the boundary it is standing inside
    // by editing that file and waiting for the next reconcile.
    for (const mode of ['knowledge', 'code']) {
      const s = sandboxSettings(WS, 'darwin', HOME, ['/tmp/t'], FOLDERS, mode);
      assert.deepStrictEqual(s.filesystem.denyWrite.slice(0, 3),
        [`${WS}/.rundock/state.json`, `${WS}/.rundock/permissions.json`, `${WS}/.claude/settings.local.json`],
        `${mode} mode denies writes to the files that answer permission questions`);
    }
  });

  test('the deny names that file alone, so agent scratch under .rundock still works', () => {
    const s = sandboxSettings(WS, 'darwin', HOME, ['/tmp/t'], FOLDERS);
    assert.ok(!s.filesystem.denyWrite.includes(`${WS}/.rundock`),
      'denying the folder would take away the scratch location agents are told to use');
  });

  test('a block written before the deny existed is still ours, so it upgrades rather than stranding', () => {
    // A block its own recogniser refuses is one Rundock can never rewrite OR
    // withdraw, which would leave every existing workspace stuck with the
    // shape it already has and no way to move off it.
    const current = sandboxSettings(WS, 'darwin', HOME, ['/tmp/t'], FOLDERS);
    const before = JSON.parse(JSON.stringify(current));
    delete before.filesystem.denyWrite;
    assert.strictEqual(isRundockSandbox(before, 'darwin'), true);
  });

  test('the Code mode block written before `enabled` was set is still ours, so it upgrades', () => {
    // The other axis that has moved. Every workspace opened in Code mode before
    // this change carries `{ filesystem }` with no `enabled` key. The recogniser
    // rebuilds the CURRENT shape and compares text, so without this that block
    // reads as a person's hand edit: never reconciled, never withdrawn, and it
    // keeps the very sandbox Code mode was changed to switch off.
    const current = sandboxSettings(WS, 'darwin', HOME, ['/tmp/t'], FOLDERS, 'code');
    assert.strictEqual(current.enabled, false, 'sanity: the current block states it');
    const older = JSON.parse(JSON.stringify(current));
    delete older.enabled;
    assert.strictEqual(isRundockSandbox(older, 'darwin'), true,
      'the key-less Code mode block is one we wrote, and must be rewritten rather than preserved');

    // And both axes at once, because a workspace can be behind on both: opened
    // in Code mode before the key was written, it has neither the key nor the
    // full deny list.
    for (const n of WRITTEN_LENGTHS) {
      assert.strictEqual(isRundockSandbox(released(n, 'keyless'), 'darwin'), true,
        `no key and the ${n} deny entries an earlier build wrote is a shape we wrote, and must upgrade`);
    }
  });

  test('a person\'s own enabled:true is still theirs, and Code mode does not seize it', () => {
    // The limit of the above. Recognising the key-less shape must not slide into
    // recognising any block with the right paths: a user who deliberately turned
    // the sandbox ON in a Code mode workspace has authored something Rundock
    // never wrote, and it stays theirs.
    const current = sandboxSettings(WS, 'darwin', HOME, ['/tmp/t'], FOLDERS, 'code');
    const theirs = { ...current, enabled: true };
    assert.strictEqual(isRundockSandbox(theirs, 'darwin'), false,
      'enabled:true in Code mode is a person\'s edit, not a shape Rundock ever wrote');
  });

  test('every deny list Rundock has ever written is recognised, so no release strands a workspace', () => {
    // Refused means never rewritten and never withdrawn, so a list a release
    // wrote that the recogniser does not know strands every workspace carrying
    // it. Checked against the lists written out above, not against cuts of the
    // current one: a cut of the current list is only ever what a release wrote
    // if the code is right, which is the thing under test.
    for (const shape of ['on', 'off']) {
      for (const n of WRITTEN_LENGTHS) {
        assert.strictEqual(isRundockSandbox(released(n, shape), 'darwin'), true,
          `the ${shape} block with the ${n} deny entries an earlier build wrote is ours, and must upgrade`);
      }
    }
  });

  test('the current deny list\'s length is recorded as written, so the list that replaces it still recognises this one', () => {
    // Recorded now, while it is current, it changes nothing: only shorter
    // lists are accepted. It matters the day a longer list ships, when blocks
    // this build wrote must still upgrade, and this fails until the change that
    // makes the list longer records the new length as well.
    for (const mode of ['knowledge', 'code']) {
      const n = sandboxSettings(WS, 'darwin', HOME, ['/tmp/t'], FOLDERS, mode).filesystem.denyWrite.length;
      assert.ok(WRITTEN_DENY_LENGTHS.includes(n), `the ${n}-entry list this build writes is in WRITTEN_DENY_LENGTHS`);
    }
    for (const n of WRITTEN_LENGTHS.filter((len) => len > 0)) {
      assert.ok(WRITTEN_DENY_LENGTHS.includes(n), `and so is the ${n}-entry list an earlier build wrote`);
    }
  });

  test('a deny list cut short where no release stopped is a person\'s edit, and stays theirs', () => {
    // Recognising every shorter list let a person remove an entry and have it
    // put back on the next open. Only the lengths a release wrote are ours.
    for (const mode of ['knowledge', 'code']) {
      const current = sandboxSettings(WS, 'darwin', HOME, ['/tmp/t'], FOLDERS, mode);
      const deny = current.filesystem.denyWrite;
      for (const removed of [3, 5, 10]) {
        const edited = JSON.parse(JSON.stringify(current));
        edited.filesystem.denyWrite = deny.slice(0, deny.length - removed);
        assert.strictEqual(isRundockSandbox(edited, 'darwin'), false,
          `a ${mode} block with its last ${removed} deny entries removed is a person's edit`);
      }
      // Removing the startup files and all fifteen entries added after 0.15.6
      // leaves exactly the list 0.15.6 wrote, and removing them and the last
      // four, two, one or none leaves a list a build after it wrote; none can
      // be told apart from that build's own block, and each upgrades like it.
      const n = STARTUP_DENY.length;
      assert.deepStrictEqual(deny.slice(0, deny.length - n - 15), RELEASED_DENY.slice(0, 8), 'sanity: what is left is the 0.15.6 list');
      assert.deepStrictEqual(deny.slice(0, deny.length - n - 4), RELEASED_DENY.slice(0, 19), 'sanity: and the nineteen-entry list');
      assert.deepStrictEqual(deny.slice(0, deny.length - n - 2), RELEASED_DENY.slice(0, 21), 'sanity: and the twenty-one-entry list');
      assert.deepStrictEqual(deny.slice(0, deny.length - n - 1), RELEASED_DENY.slice(0, 22), 'sanity: and the twenty-two-entry list');
      assert.deepStrictEqual(deny.slice(0, deny.length - n), RELEASED_DENY, 'sanity: and the list the last build wrote');
    }
  });

  test('a deny list that is not a prefix of ours is somebody else\'s edit', () => {
    // The other direction, so the walk above cannot be satisfied by accepting
    // anything at all: a person who added their own path to the deny list has
    // authored the block, and Rundock must leave it alone rather than
    // overwrite the entry they added.
    const current = sandboxSettings(WS, 'darwin', HOME, ['/tmp/t'], FOLDERS);
    const edited = JSON.parse(JSON.stringify(current));
    edited.filesystem.denyWrite = [...current.filesystem.denyWrite, `${WS}/notes.md`];
    assert.strictEqual(isRundockSandbox(edited, 'darwin'), false,
      'an entry we never write means the block is not ours to rewrite');
  });

  test('both shapes are recognised as ours, with folders present', () => {
    for (const mode of ['knowledge', 'code']) {
      const block = sandboxSettings(WS, 'darwin', HOME, ['/tmp/t'], FOLDERS, mode);
      assert.strictEqual(isRundockSandbox(block, 'darwin'), true, `${mode} block is ours`);
    }
  });

  test('a block whose folder list has since changed is still ours, and so still reconciles', () => {
    // The user added a folder after this block was written. Recognised from the
    // head, never from a comparison against the current list: a block we cannot
    // recognise is one we can never rewrite or withdraw, which is how a
    // workspace gets stranded with an operating system nobody can talk to.
    const stale = sandboxSettings(WS, 'darwin', HOME, ['/tmp/t'], ['/Users/someone/Old']);
    assert.strictEqual(isRundockSandbox(stale, 'darwin'), true);
  });

  test('a stranger who happens to list folders is still refused', () => {
    const stranger = {
      enabled: true,
      filesystem: { allowWrite: [WS, path.join(HOME, '.npm'), ...FOLDERS] },
      network: { allowedDomains: ['*'] },
    };
    assert.strictEqual(isRundockSandbox(stranger, 'darwin'), false,
      'the runtime roots are missing from the head, so it was not written here');
  });

  test('the Code-mode shape is not mistaken for a Knowledge-mode one, or the reverse', () => {
    const code = sandboxSettings(WS, 'darwin', HOME, ['/tmp/t'], FOLDERS, 'code');
    const knowledge = sandboxSettings(WS, 'darwin', HOME, ['/tmp/t'], FOLDERS);
    assert.notDeepStrictEqual(code, knowledge, 'the two shapes are actually different');
    // Each is recognised on its own terms, which is what lets a workspace that
    // changed mode recognise what it wrote before and converge on the new shape.
    assert.strictEqual(isRundockSandbox({ ...code, enabled: true }, 'darwin'), false,
      'a Code-mode block with an enable bolted on is not a shape we ever wrote');
  });
});

describe('the shell startup files join the deny list', () => {
  test('a block the last build wrote is ours, and the list that replaces it ends with the startup files and the record', () => {
    for (const mode of ['knowledge', 'code']) {
      const current = sandboxSettings(WS, 'darwin', HOME, ['/tmp/t'], [], mode);
      const deny = current.filesystem.denyWrite;
      assert.deepStrictEqual(deny.slice(-STARTUP_DENY.length), STARTUP_DENY, `${mode}: the startup files, then the record, at the end`);
      const lastBuild = JSON.parse(JSON.stringify(current));
      lastBuild.filesystem.denyWrite = deny.slice(0, 23);
      assert.strictEqual(lastBuild.filesystem.denyWrite[22], `${HOME}/.rundock-console`, 'sanity: the 23-entry list the last build wrote');
      assert.strictEqual(isRundockSandbox(lastBuild, 'darwin'), true, `${mode}: the last build's block is recognised as Rundock's`);
    }
  });

  test('the zsh files under ZDOTDIR come last, and that list is recognised too', () => {
    process.env.ZDOTDIR = '/Users/someone/zdot';
    try {
      const deny = sandboxSettings(WS, 'darwin', HOME, ['/tmp/t']).filesystem.denyWrite;
      assert.deepStrictEqual(deny.slice(-5), ['.zshenv', '.zprofile', '.zshrc', '.zlogin', '.zlogout'].map(f => `/Users/someone/zdot/${f}`));
      assert.ok(WRITTEN_DENY_LENGTHS.includes(deny.length), `the ${deny.length}-entry list is recorded as written`);
      process.env.ZDOTDIR = HOME;
      assert.strictEqual(sandboxSettings(WS, 'darwin', HOME, ['/tmp/t']).filesystem.denyWrite.length, deny.length - 5, 'a ZDOTDIR that is home adds nothing');
    } finally { delete process.env.ZDOTDIR; }
  });

  test('at the next open, a block the last build wrote gains them at the end of its deny list', () => {
    const fs = require('node:fs');
    const { _internal: srv } = require('../../server.js');
    const { makeWorkspace, cleanup } = require('../helpers/workspace.js');
    try {
      const dir = makeWorkspace({ claudeMd: '# x' });
      const settings = path.join(dir, '.claude', 'settings.local.json');
      srv.setWorkspace(dir);
      srv.scaffoldWorkspace(dir, { platform: 'darwin' });
      const written = JSON.parse(fs.readFileSync(settings, 'utf-8'));
      const want = written.sandbox.filesystem.denyWrite;
      assert.ok(want.length > 23, 'sanity: this build writes the longer list');
      written.sandbox.filesystem.denyWrite = want.slice(0, 23);
      fs.writeFileSync(settings, JSON.stringify(written, null, 2));
      srv.scaffoldWorkspace(dir, { platform: 'darwin' });
      const after = JSON.parse(fs.readFileSync(settings, 'utf-8')).sandbox.filesystem.denyWrite;
      assert.deepStrictEqual(after, want, 'upgraded to the current list');
      const home = require('node:os').homedir();
      assert.deepStrictEqual(after.slice(23, 26), ['.zshenv', '.zprofile', '.zshrc'].map(f => path.posix.join(home, f)), 'the startup files follow the old list');
      assert.ok(after.includes(require('../../scripts/permission-hook.js').exposureRecordPath()), 'and the record\'s path is among them');
    } finally { cleanup(); }
  });
});

// THE RECORD OF THE STARTUP FILES, IN EITHER SPELLING.
//
// The deny list names Rundock's record of the shell startup files where the
// process that wrote the block keeps it: in the home folder for the desktop
// app (RUNDOCK_ELECTRON set), in the checkout for a source run. So a block one
// of them wrote differs from what the other would write in that entry alone,
// and read by the other it looked like a person's edit: the switch locked as
// set up outside Rundock, and the block was never reconciled again. The entry
// is accepted in either spelling, at its own position, and every other part of
// the block is still compared byte for byte.
//
// RUNDOCK_ELECTRON is the real input that tells the two apart, so a test sets
// it, calls, and removes it again before anything else runs.
const APP_RECORD = `${HOME}/.rundock-startup-file-exposure.json`;
const ELSEWHERE = '/Users/someone/clones/rundock/.startup-file-exposure.json';
const SHAPES = ['on', 'off'];
function asApp(fn) {
  process.env.RUNDOCK_ELECTRON = '1';
  try { return fn(); } finally { delete process.env.RUNDOCK_ELECTRON; }
}
const asSource = (fn) => fn();
const written = (shape) => sandboxSettings(WS, 'darwin', HOME, ['/tmp/t'], [], shape);
// Each way of reading a block, with the block the other way wrote.
const READERS = [
  { name: 'the app', read: asApp, other: (shape) => written(shape) },
  { name: 'a source run', read: asSource, other: (shape) => asApp(() => written(shape)) },
];
// A copy of the block, its deny list changed by `edit(deny, at)`, where `at` is
// the record entry's position.
function edited(block, edit) {
  const copy = JSON.parse(JSON.stringify(block));
  const deny = copy.filesystem.denyWrite;
  edit(deny, deny.findIndex((e) => e === RECORD || e === APP_RECORD));
  return copy;
}
// Each way of reading still recognises the block the other way wrote, and
// refuses every variant of it.
function refusedEitherWay(variants) {
  for (const { name, read, other } of READERS) {
    for (const shape of SHAPES) {
      const base = other(shape);
      assert.strictEqual(read(() => isRundockSandbox(base)), true, `sanity: ${name} recognises the other's ${shape} block as written`);
      for (const [why, edit] of variants) {
        const block = edited(base, edit);
        let ours;
        assert.doesNotThrow(() => { ours = read(() => isRundockSandbox(block)); }, `${name}, ${shape}: ${why}: nothing throws`);
        assert.strictEqual(ours, false, `${name}, ${shape}: ${why}: a person's edit`);
      }
    }
  }
}

describe('the record of the startup files, in either spelling', () => {
  test('the app recognises a block a source run wrote, on and off', () => {
    for (const shape of SHAPES) {
      const block = written(shape);
      assert.ok(block.filesystem.denyWrite.includes(RECORD), `sanity: the ${shape} block names the checkout's record`);
      assert.strictEqual(asApp(() => isRundockSandbox(block)), true, `the app reads the ${shape} block a source run wrote as Rundock's`);
    }
  });

  test('the inverse action: a source run recognises a block the app wrote, on and off', () => {
    for (const shape of SHAPES) {
      const block = asApp(() => written(shape));
      assert.ok(block.filesystem.denyWrite.includes(APP_RECORD), `sanity: the ${shape} block names the record in the home folder`);
      assert.strictEqual(isRundockSandbox(block), true, `a source run reads the ${shape} block the app wrote as Rundock's`);
    }
  });

  test('a block another checkout wrote is recognised, by a source run and by the app', () => {
    // A second clone, or this one moved: the same name in another folder.
    for (const { name, read } of READERS) {
      for (const shape of SHAPES) {
        for (const record of [ELSEWHERE, '/opt/rundock/.startup-file-exposure.json']) {
          const block = edited(written(shape), (deny, at) => { deny[at] = record; });
          assert.strictEqual(read(() => isRundockSandbox(block)), true, `${name}, ${shape}: ${record}`);
        }
      }
    }
  });

  test('another deny entry changed is still a person\'s edit', () => {
    refusedEitherWay([
      ['a startup file renamed', (deny) => { deny[deny.indexOf(`${HOME}/.bashrc`)] = `${HOME}/.bashrc.local`; }],
      ['an answer file swapped for another path', (deny) => { deny[0] = `${WS}/.rundock/other.json`; }],
      ['the entry before the record spelled as another checkout\'s record', (deny, at) => { deny[at - 1] = ELSEWHERE; }],
      ['a startup file spelled as the app\'s record', (deny) => { deny[deny.indexOf(`${HOME}/.zshrc`)] = APP_RECORD; }],
    ]);
  });

  test('the record entry moved to another position is a person\'s edit', () => {
    refusedEitherWay([
      ['swapped with the entry before it', (deny, at) => { [deny[at - 1], deny[at]] = [deny[at], deny[at - 1]]; }],
      ['moved to the start of the list', (deny, at) => { deny.unshift(deny.splice(at, 1)[0]); }],
      ['moved to the start of the startup files', (deny, at) => { deny.splice(23, 0, deny.splice(at, 1)[0]); }],
    ]);
  });

  test('a relative record entry is a person\'s edit', () => {
    refusedEitherWay(['.startup-file-exposure.json', 'rundock/.startup-file-exposure.json', '../rundock/.startup-file-exposure.json',
      '~/.rundock-startup-file-exposure.json', 'Users/someone/.rundock-startup-file-exposure.json', '.rundock-startup-file-exposure.json',
    ].map((record) => [record, (deny, at) => { deny[at] = record; }]));
  });

  test('the app\'s record name in a folder other than the block\'s home is a person\'s edit', () => {
    refusedEitherWay(['/Users/someone-else/.rundock-startup-file-exposure.json', `${HOME}/clones/.rundock-startup-file-exposure.json`,
      '/Users/.rundock-startup-file-exposure.json', '/.rundock-startup-file-exposure.json', `${WS}/.rundock-startup-file-exposure.json`,
    ].map((record) => [record, (deny, at) => { deny[at] = record; }]));
  });

  test('a record entry with any other file name is a person\'s edit', () => {
    refusedEitherWay([`${ELSEWHERE}.bak`, '/Users/someone/clones/rundock/startup-file-exposure.json',
      '/Users/someone/clones/rundock/.Startup-File-Exposure.json', '/Users/someone/clones/rundock/x.startup-file-exposure.json',
      `${HOME}/.rundock-startup-file-exposure.jsonx`, `${HOME}/.rundock-startup-file-exposure`, `${HOME}/.zshrc`, '/tmp',
    ].map((record) => [record, (deny, at) => { deny[at] = record; }]));
  });

  test('a record entry not spelled the way a path is joined is a person\'s edit', () => {
    // Rundock joins the record's path, so it never writes a trailing slash, a
    // doubled one, or a `.` or `..` part. A block that does was written by hand.
    refusedEitherWay([`${ELSEWHERE}/`, '/Users/someone/clones/../clones/rundock/.startup-file-exposure.json',
      '/Users/someone//clones/rundock/.startup-file-exposure.json', '/Users/someone/./.startup-file-exposure.json',
      `${HOME}/./.rundock-startup-file-exposure.json`, `${HOME}//.rundock-startup-file-exposure.json`, `${APP_RECORD}/`,
    ].map((record) => [record, (deny, at) => { deny[at] = record; }]));
  });

  test('a record entry that is not a string is a person\'s edit, and nothing throws', () => {
    refusedEitherWay([null, undefined, 42, true, {}, [], [APP_RECORD], { path: RECORD }]
      .map((record) => [JSON.stringify(record) || 'undefined', (deny, at) => { deny[at] = record; }]));
  });

  test('the earlier shapes are recognised exactly as before, by either way of running', () => {
    // None of them carries the record, so neither way of running reads them
    // differently, and the lengths no build wrote stay a person's edit.
    const legacy = { enabled: true, autoAllowBashIfSandboxed: true, filesystem: { allowWrite: [WS, `${HOME}/.npm`] }, network: { allowedDomains: ['*'] } };
    for (const { name, read } of READERS) {
      assert.strictEqual(read(() => isRundockSandbox(legacy)), true, `${name}: the 0.12.0 block`);
      for (const shape of SHAPES) {
        const current = written(shape);
        const without = JSON.parse(JSON.stringify(current));
        delete without.filesystem.denyWrite;
        assert.strictEqual(read(() => isRundockSandbox(without)), true, `${name}, ${shape}: no deny list`);
        for (const n of WRITTEN_DENY_LENGTHS.filter((len) => len < STARTUP_DENY.length + 23)) {
          assert.strictEqual(read(() => isRundockSandbox(edited(current, (deny) => { deny.splice(n); }))), true, `${name}, ${shape}: the ${n}-entry list`);
        }
        for (const n of [4, 20, 30, 35]) {
          assert.strictEqual(read(() => isRundockSandbox(edited(current, (deny) => { deny.splice(n); }))), false, `${name}, ${shape}: the ${n}-entry list no build wrote`);
        }
      }
    }
  });

  test('an earlier deny list that carries the record is recognised in either spelling too', () => {
    // With ZDOTDIR naming another folder this run writes 41 entries, and the
    // 36-entry list, record last, is one an earlier build wrote.
    const blocks = READERS.map((reader) => SHAPES.map((shape) => [shape, reader.other(shape)]));
    process.env.ZDOTDIR = '/Users/someone/zdot';
    try {
      READERS.forEach(({ name, read }, i) => {
        for (const [shape, block] of blocks[i]) {
          assert.strictEqual(read(() => written(shape)).filesystem.denyWrite.length, block.filesystem.denyWrite.length + 5, 'sanity: this run writes the longer list');
          assert.strictEqual(read(() => isRundockSandbox(block)), true, `${name}, ${shape}: the other's 36-entry list`);
        }
      });
    } finally { delete process.env.ZDOTDIR; }
  });
});

// What a workspace does with a block the other way of running wrote: the next
// reconcile rewrites it as this run writes it, and the switch stays Rundock's
// throughout. The same real reconcile the open path and the switch use.
describe('the record of the startup files, through the reconcile', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const scaffold = require('../../lib/workspace/scaffold.js');
  const { exposureRecordPath } = require('../../scripts/permission-hook.js');
  const settingsOf = (dir) => path.join(dir, '.claude', 'settings.local.json');
  const read = (dir) => fs.readFileSync(settingsOf(dir), 'utf-8');
  const blockOf = (dir) => JSON.parse(read(dir)).sandbox;
  // What this run writes for the workspace, exactly as its reconcile computes it.
  const desired = (dir) => sandboxSettings(dir, 'darwin', os.homedir(), scaffold.tempRoots(), scaffold.workingFoldersFor(dir), scaffold.sandboxShapeFor(dir));
  // A workspace opened by a source run, with the switch at `on`.
  function opened(srv, state = { workspaceMode: 'notes', sandboxSwitch: 'on' }) {
    const { makeWorkspace } = require('../helpers/workspace.js');
    const dir = makeWorkspace({ claudeMd: '# x' });
    fs.mkdirSync(path.join(dir, '.rundock'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.rundock', 'state.json'), JSON.stringify(state, null, 2));
    srv.setWorkspace(dir);
    srv.scaffoldWorkspace(dir, { platform: 'darwin' });
    return dir;
  }
  function replaceBlock(dir, sandbox) {
    const settings = JSON.parse(read(dir));
    settings.sandbox = sandbox;
    fs.writeFileSync(settingsOf(dir), JSON.stringify(settings, null, 2));
  }

  test('the next write uses this run\'s record path, and this run then recognises the block byte for byte', () => {
    const { _internal: srv } = require('../../server.js');
    const { cleanup } = require('../helpers/workspace.js');
    try {
      // The app wrote it; a source run opens the workspace.
      let dir = opened(srv);
      const fresh = read(dir);
      assert.strictEqual(JSON.stringify(blockOf(dir)), JSON.stringify(desired(dir)), 'sanity: the open wrote this run\'s block');
      replaceBlock(dir, asApp(() => desired(dir)));
      assert.ok(blockOf(dir).filesystem.denyWrite.includes(asApp(() => exposureRecordPath())), 'sanity: the app\'s record path is in the block');
      srv.scaffoldWorkspace(dir, { platform: 'darwin' });
      assert.ok(blockOf(dir).filesystem.denyWrite.includes(exposureRecordPath()), 'the open wrote this run\'s record path');
      assert.strictEqual(read(dir), fresh, 'and the whole file is what this run wrote, byte for byte');
      assert.strictEqual(isRundockSandbox(blockOf(dir)), true, 'which this run recognises');

      // A source run wrote it; the app's reconcile meets it.
      dir = opened(srv);
      const fromSource = blockOf(dir);
      asApp(() => scaffold.reconcileSandboxForMode(dir, scaffold.sandboxShapeFor(dir), 'darwin'));
      const rewritten = blockOf(dir);
      assert.ok(rewritten.filesystem.denyWrite.includes(asApp(() => exposureRecordPath())), 'the app\'s reconcile wrote the app\'s record path');
      assert.ok(!rewritten.filesystem.denyWrite.includes(exposureRecordPath()), 'in place of the checkout\'s');
      assert.strictEqual(JSON.stringify(rewritten), JSON.stringify(asApp(() => desired(dir))), 'the block is the one the app writes, byte for byte');
      assert.notStrictEqual(JSON.stringify(rewritten), JSON.stringify(fromSource), 'sanity: it was rewritten');
      assert.strictEqual(asApp(() => isRundockSandbox(rewritten)), true, 'which the app recognises');
    } finally { cleanup(); }
  });

  test('the undo: a block a source run wrote, rewritten by the app, then read by a source run again, is recognised at each step', () => {
    const { _internal: srv } = require('../../server.js');
    const { cleanup } = require('../helpers/workspace.js');
    const { sandboxStatus } = require('../../lib/workspace/sandbox-status.js');
    try {
      const dir = opened(srv);
      const fromSource = read(dir);
      const managed = () => sandboxStatus(dir, 'darwin').managed;
      assert.strictEqual(isRundockSandbox(blockOf(dir)), true, 'written by source, read by source');
      assert.strictEqual(asApp(() => isRundockSandbox(blockOf(dir))), true, 'written by source, read by the app');
      assert.strictEqual(asApp(managed), true, 'and the app shows the switch as Rundock\'s');
      asApp(() => scaffold.reconcileSandboxForMode(dir, scaffold.sandboxShapeFor(dir), 'darwin'));
      assert.notStrictEqual(read(dir), fromSource, 'sanity: the app rewrote it');
      assert.strictEqual(asApp(() => isRundockSandbox(blockOf(dir))), true, 'rewritten by the app, read by the app');
      assert.strictEqual(isRundockSandbox(blockOf(dir)), true, 'rewritten by the app, read by source');
      assert.strictEqual(managed(), true, 'and a source run shows the switch as Rundock\'s');
      srv.scaffoldWorkspace(dir, { platform: 'darwin' });
      assert.strictEqual(read(dir), fromSource, 'opened from source again, it is back to what source wrote, byte for byte');
      assert.strictEqual(isRundockSandbox(blockOf(dir)), true, 'and read by source');
    } finally { cleanup(); }
  });

  test('the retry: recognising the same block twice gives the same answer and changes nothing', () => {
    for (const { name, read: as, other } of READERS) {
      for (const shape of SHAPES) {
        for (const [block, answer] of [[other(shape), true], [edited(other(shape), (deny, at) => { deny[at] = 'rundock/.startup-file-exposure.json'; }), false]]) {
          const before = JSON.stringify(block);
          assert.strictEqual(as(() => isRundockSandbox(block)), answer, `${name}, ${shape}: first`);
          assert.strictEqual(as(() => isRundockSandbox(block)), answer, `${name}, ${shape}: second, the same`);
          assert.strictEqual(JSON.stringify(block), before, `${name}, ${shape}: the block is unchanged`);
        }
      }
    }
    // And on disk: asking twice writes nothing.
    const { _internal: srv } = require('../../server.js');
    const { cleanup } = require('../helpers/workspace.js');
    const { sandboxStatus } = require('../../lib/workspace/sandbox-status.js');
    try {
      const dir = opened(srv);
      replaceBlock(dir, asApp(() => desired(dir)));
      const before = read(dir);
      assert.strictEqual(sandboxStatus(dir, 'darwin').managed, true, 'first');
      assert.strictEqual(sandboxStatus(dir, 'darwin').managed, true, 'second, the same');
      assert.strictEqual(read(dir), before, 'and the file is unchanged');
    } finally { cleanup(); }
  });

  test('the most common next step: switching Notes and Code after recognition writes the right shape and keeps the switch Rundock\'s', () => {
    const { _internal: srv } = require('../../server.js');
    const { cleanup } = require('../helpers/workspace.js');
    const { buildDispatch } = require('../../lib/protocol/handlers/index.js');
    const { sandboxStatus } = require('../../lib/workspace/sandbox-status.js');
    const sent = [];
    const ws = { send: (m) => sent.push(JSON.parse(m)), readyState: 1 };
    try {
      for (const [from, to, sandboxSwitch] of [['notes', 'code', 'on'], ['code', 'notes', 'off']]) {
        const dir = opened(srv, { workspaceMode: from, sandboxSwitch });
        replaceBlock(dir, asApp(() => desired(dir)));
        assert.strictEqual(sandboxStatus(dir, 'darwin').managed, true, `${from}: the app's block is recognised`);
        buildDispatch().set_workspace_mode({}, ws, { mode: to }, 'darwin');
        assert.deepStrictEqual(sent.pop(), { type: 'workspace_mode_changed', mode: to }, `${from} to ${to}: changed`);
        assert.strictEqual(sandboxStatus(dir, 'darwin').managed, true, `${from} to ${to}: the switch is still Rundock's`);
        srv.scaffoldWorkspace(dir, { platform: 'darwin' });
        assert.strictEqual(JSON.stringify(blockOf(dir)), JSON.stringify(desired(dir)), `${from} to ${to}: the next open writes this run's ${sandboxSwitch} shape`);
        assert.strictEqual(blockOf(dir).enabled, sandboxSwitch === 'on', `${from} to ${to}: the switch decides the shape, not the mode`);
        // And the switch itself still works.
        buildDispatch().set_workspace_sandbox({}, ws, { on: sandboxSwitch !== 'on' }, 'darwin');
        const reply = sent.pop();
        assert.strictEqual(reply.error, undefined, `${from} to ${to}: flipping the switch is not refused`);
        assert.strictEqual(reply.managed, true, `${from} to ${to}: and it stays Rundock's`);
        assert.strictEqual(JSON.stringify(blockOf(dir)), JSON.stringify(desired(dir)), `${from} to ${to}: the flip wrote this run's shape`);
      }
    } finally { cleanup(); }
  });

  test('the control failing: a deny list that is not an array, holds null, or holds a very long string is not recognised, and nothing throws', () => {
    const long = 'x'.repeat(1_000_000);
    for (const { name, read: as, other } of READERS) {
      for (const shape of SHAPES) {
        const base = other(shape);
        const at = base.filesystem.denyWrite.findIndex((e) => e === RECORD || e === APP_RECORD);
        const variants = [
          ['not an array: null', (b) => { b.filesystem.denyWrite = null; }],
          ['not an array: a string', (b) => { b.filesystem.denyWrite = long; }],
          ['not an array: an object', (b) => { b.filesystem.denyWrite = { ...b.filesystem.denyWrite }; }],
          ['not an array: a number', (b) => { b.filesystem.denyWrite = 36; }],
          ['null for the record', (b) => { b.filesystem.denyWrite[at] = null; }],
          ['null for another entry', (b) => { b.filesystem.denyWrite[0] = null; }],
          ['nothing but null', (b) => { b.filesystem.denyWrite = [null]; }],
          ['a very long string for the record', (b) => { b.filesystem.denyWrite[at] = long; }],
          ['a very long absolute path for the record', (b) => { b.filesystem.denyWrite[at] = `/${long}`; }],
          ['a very long string for another entry', (b) => { b.filesystem.denyWrite[3] = long; }],
        ];
        for (const [why, edit] of variants) {
          const block = JSON.parse(JSON.stringify(base));
          edit(block);
          let ours;
          assert.doesNotThrow(() => { ours = as(() => isRundockSandbox(block)); }, `${name}, ${shape}: ${why}: nothing throws`);
          assert.strictEqual(ours, false, `${name}, ${shape}: ${why}: not recognised`);
        }
      }
    }
  });
});
