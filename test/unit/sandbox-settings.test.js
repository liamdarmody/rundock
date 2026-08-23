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

const { sandboxSettings } = require('../../lib/workspace/scaffold.js');

const WS = '/tmp/sandbox-ws';
const HOME = '/Users/someone';

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
