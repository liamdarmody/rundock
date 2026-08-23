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
    const s = sandboxSettings(WS);
    if (process.platform === 'darwin') {
      assert.ok(s && s.filesystem.allowWrite.includes(path.join(os.homedir(), '.npm')),
        'the real home directory resolves');
    } else {
      assert.strictEqual(s, null);
    }
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
