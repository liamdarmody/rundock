'use strict';
// THE SANDBOX BLOCK, RUN FOR REAL, OVER THE SHELL STARTUP FILES.
//
// test/unit/sandbox-settings.test.js proves the block NAMES each startup file
// in its write-deny list. It cannot prove the operating system then refuses
// the write, and a list that names a path the sandbox matches differently
// (a link, a folder, a file that does not exist yet) would pass it. So this
// runs a real sandboxed process, under the block `sandboxSettings` writes for
// a workspace at a made-up home, through the sandbox runtime Claude Code's own
// command sandbox is built on (the `@anthropic-ai/sandbox-runtime` package),
// and reads the bytes back.
//
// The sandboxed command is `node -e`, and it builds every path as it runs
// from HOME and an environment list, so its command line names no file.
//
// macOS only, as the block is: `sandboxSettings` writes none anywhere else.
// The runtime is not a dependency of this repository, so the test runs when
// RUNDOCK_SANDBOX_RUNTIME names the package's `dist/cli.js`, and is skipped
// otherwise. If the runtime cannot start its sandbox, inside another sandbox
// for instance, the test fails saying so rather than passing on nothing. The
// last run is recorded in docs/evidence/startup-files-real-sandbox-evidence.md.
//
// The block names each startup file at its own path. A startup file that is a
// link, into a dotfiles folder as dotfile managers leave it, is written
// through: the operating system judges the file a write reaches, and the block
// names the link. The second test pins that limit, which ARCHITECTURE.md
// states, so a runtime that starts refusing it shows up here.
//
// Every file here is under a made-up home in the temp folder: the account's
// own startup files are never read, written or put back.
const { home } = require('../helpers/made-up-home.js');
const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const RUNTIME = process.env.RUNDOCK_SANDBOX_RUNTIME;
const skip = process.platform !== 'darwin' ? 'the sandbox block is written for macOS only'
  : !RUNTIME ? 'set RUNDOCK_SANDBOX_RUNTIME to the sandbox runtime\'s dist/cli.js to run it'
    : false;

const ORIGINAL = (name) => `original ${name}\n`;

// What the sandboxed process runs. Each target is written the way an agent's
// code would: appended to, or created when it is not there yet. It reports,
// for each, whether the write went through and the error code if it did not.
const PROBE = [
  'const fs=require("fs");const out=[];',
  'for(const t of JSON.parse(process.env.PROBE_TARGETS)){',
  'try{if(t.create){fs.writeFileSync(t.path,"planted\\n",{flag:"wx"})}else{fs.appendFileSync(t.path,"planted\\n")}',
  'out.push({path:t.path,wrote:true})}catch(e){out.push({path:t.path,wrote:false,code:e.code})}}',
  'process.stdout.write(JSON.stringify(out))',
].join('');

function sandboxed(block, targets) {
  // The runtime's own settings shape: the block's write lists as written, and
  // no network, which nothing here needs.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-srt-settings-'));
  const settings = path.join(dir, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({
    network: { allowedDomains: [], deniedDomains: [] },
    filesystem: { denyRead: [], allowWrite: block.filesystem.allowWrite, denyWrite: block.filesystem.denyWrite },
  }));
  try {
    const r = spawnSync(process.execPath, [RUNTIME, '--settings', settings, '-c', `${JSON.stringify(process.execPath)} -e '${PROBE}'`], {
      cwd: home, encoding: 'utf8', timeout: 60000,
      env: { ...process.env, HOME: home, PROBE_TARGETS: JSON.stringify(targets) },
    });
    let report = null;
    try { report = JSON.parse(r.stdout); } catch (e) { /* no report */ }
    assert.ok(Array.isArray(report), `the sandboxed process ran and reported (exit ${r.status}, signal ${r.signal}). If this ran inside another sandbox, run it outside one. stderr: ${String(r.stderr).slice(0, 2000)}`);
    return new Map(report.map(o => [o.path, o]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('the sandbox block, run for real, over the shell startup files', { skip }, () => {
  const at = (rel) => path.join(home, rel);
  // The layout: every listed startup file in place, Rundock's record of them
  // included, except one that does not exist yet; `.bashrc` a link into a
  // dotfiles folder; fish's snippet folder, with one snippet.
  const absent = at('.bash_login');
  const linked = at('.bashrc');
  const target = at(path.join('dotfiles', 'bashrc'));
  const confD = at(path.join('.config', 'fish', 'conf.d'));
  const snippet = path.join(confD, 'paths.fish');
  const newSnippet = path.join(confD, 'zz-planted.fish');
  let listed, seen;

  before(() => {
    const { shellStartupEntries } = require('../../scripts/permission-hook.js');
    const { sandboxSettings } = require('../../lib/workspace/scaffold.js');
    const entries = shellStartupEntries(home);
    listed = entries.filter(e => !e.dir).map(e => e.path);
    assert.ok(entries.some(e => e.record && e.path.startsWith(home + path.sep)), 'the record is under the made-up home, as in the desktop app');
    assert.ok(listed.includes(absent) && listed.includes(linked), 'the registry lists the files this layout uses');
    for (const f of listed) {
      if (f === absent || f === linked) continue;
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, ORIGINAL(f));
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, ORIGINAL(target));
    fs.symlinkSync(target, linked);
    fs.mkdirSync(confD, { recursive: true });
    fs.writeFileSync(snippet, ORIGINAL(snippet));

    // The block Rundock writes for a workspace at this home, in Notes mode,
    // with the sandbox on: the temp roots are this machine's, as shipped.
    const block = sandboxSettings(home, 'darwin', home, undefined, [], 'knowledge');
    assert.ok(block && block.enabled === true, 'the block turns the sandbox on');

    // The controls: an ordinary file in the workspace is written, which
    // proves the probe can write at all; a file outside every writable root
    // is not, which proves the sandbox is on. The outside file is beside this
    // checkout, which no root names.
    const ordinary = at('notes.md');
    const outsideDir = path.join(__dirname, '..', '..', '.rundock', 'scratch');
    fs.mkdirSync(outsideDir, { recursive: true });
    const outside = path.join(outsideDir, `sandbox-control-${process.pid}.txt`);
    try {
      seen = sandboxed(block, [
        ...listed.filter(f => f !== absent).map(f => ({ path: f })),
        { path: absent, create: true },
        { path: target },
        { path: snippet },
        { path: newSnippet, create: true },
        { path: ordinary, create: true },
        { path: outside, create: true },
      ]);
      assert.strictEqual(seen.get(ordinary).wrote, true, 'control: an ordinary file in the workspace is written');
      assert.strictEqual(seen.get(outside).wrote, false, 'control: a file outside every writable root is refused, so the sandbox is on');
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  test('each listed file at its own path, one not there yet, the record, a fish snippet and a new one are refused, and nothing changes', () => {
    const refused = [...listed.filter(f => f !== linked), snippet, newSnippet];
    // Every write that went through, or failed for some other reason than
    // the sandbox, named at once.
    const through = refused.map(f => seen.get(f))
      .filter(o => o.wrote || !/^(EPERM|EACCES)$/.test(String(o.code)))
      .map(o => `${path.relative(home, o.path)} (${o.wrote ? 'written' : o.code})`);
    assert.deepStrictEqual(through, [], 'every write is refused by the sandbox');
    for (const f of listed.filter(f => f !== absent && f !== linked)) {
      assert.strictEqual(fs.readFileSync(f, 'utf8'), ORIGINAL(f), `${path.relative(home, f)}: its bytes are unchanged`);
    }
    assert.strictEqual(fs.readFileSync(snippet, 'utf8'), ORIGINAL(snippet), 'the fish snippet: its bytes are unchanged');
    assert.ok(!fs.existsSync(absent), 'the startup file that was not there still is not');
    assert.ok(!fs.existsSync(newSnippet), 'no new fish snippet');
  });

  test('the limit: a startup file that is a link is written through, at the link and at its target', () => {
    // Measured, and stated in ARCHITECTURE.md: the block names `.bashrc`, the
    // write reaches `dotfiles/bashrc`, and the operating system judges that.
    // The guard puts such a change back during a turn, by real path (see
    // test/unit/startup-file-guard.test.js, a write through a dotfiles link).
    // A runtime that starts refusing these turns this red, and the statement
    // can then be widened.
    assert.strictEqual(seen.get(linked).wrote, true, '.bashrc, the link: written through');
    assert.strictEqual(seen.get(target).wrote, true, 'dotfiles/bashrc, its target: written');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), `${ORIGINAL(target)}planted\nplanted\n`, 'both writes landed in the target');
    assert.strictEqual(fs.readlinkSync(linked), target, '.bashrc still leads where it did');
  });
});
