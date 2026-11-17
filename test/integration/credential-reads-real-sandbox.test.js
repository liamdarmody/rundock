'use strict';
// THE SANDBOX BLOCK, RUN FOR REAL, OVER READS OF THE CREDENTIAL FILES.
//
// test/unit/sandbox-read-deny.test.js proves the block NAMES each credential
// file in its read-deny list. It cannot prove the operating system then refuses
// the read, whatever the command calls the file. So this runs real sandboxed
// commands, under the block `sandboxSettings` writes for a workspace at a
// made-up home, through the sandbox runtime Claude Code's own command sandbox
// is built on (the `@anthropic-ai/sandbox-runtime` package), the same way as
// startup-files-real-sandbox.test.js.
//
// Each credential file is read with `cat` by its plain path, a quoted path, a
// path built from a variable as the command runs, and a link in the workspace
// that leads to it. A file beside each one, which the block does not name,
// must still read. A hard link made by a sandboxed `ln` is reported only: it
// is a second name for the same file, and what the runtime does with it is
// recorded by running this, not claimed.
//
// macOS only, as the block is. The runtime is not a dependency of this
// repository, so the test runs when RUNDOCK_SANDBOX_RUNTIME names the
// package's `dist/cli.js`, and is skipped otherwise. If the runtime cannot
// start its sandbox, inside another sandbox for instance, the test fails
// saying so rather than passing on nothing.
//
// Every file here is under a made-up home in the temp folder, holding dummy
// contents: the account's own credential files are never read.
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

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// One line per probe: its label, the command's exit status, and what it
// printed, on one line.
const probe = (label, command) =>
  `out=$(${command} 2>&1); s=$?; printf '%s\\t%s\\t%s\\n' ${quote(label)} "$s" "$(printf %s "$out" | tr '\\n\\t' '  ')"`;

function sandboxed(block, probes, cwd) {
  // The runtime's own settings shape: the block's three lists as written, and
  // no network, which nothing here needs.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-srt-settings-'));
  const settings = path.join(dir, 'settings.json');
  const { allowWrite, denyWrite, denyRead } = block.filesystem;
  fs.writeFileSync(settings, JSON.stringify({
    network: { allowedDomains: [], deniedDomains: [] },
    filesystem: { denyRead, allowWrite, denyWrite },
  }));
  try {
    // The script travels in the environment, so the command line names no file.
    const r = spawnSync(process.execPath, [RUNTIME, '--settings', settings, '-c', 'sh -c "$PROBE"'], {
      cwd, encoding: 'utf8', timeout: 60000,
      env: { ...process.env, HOME: home, PROBE: probes.join('\n') },
    });
    const report = new Map(String(r.stdout).split('\n').filter(Boolean).map((line) => {
      const [label, status, out = ''] = line.split('\t');
      return [label, { status: Number(status), out }];
    }));
    assert.strictEqual(report.size, probes.length, `the sandboxed shell ran every probe and reported (exit ${r.status}, signal ${r.signal}). If this ran inside another sandbox, run it outside one. stderr: ${String(r.stderr).slice(0, 2000)}`);
    return report;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('the sandbox block, run for real, over reads of the credential files', { skip }, () => {
  const ws = path.join(home, 'workspace');
  const dummy = (file) => `dummy contents of ${path.basename(file)}\n`;
  let secrets, seen;
  const ways = (file, i) => [
    [`plain ${i}`, `cat ${file}`],
    [`quoted ${i}`, `cat ${quote(file)}`],
    [`variable ${i}`, `p="$HOME"; cat "$p"/${quote(path.relative(home, file))}`],
    [`link ${i}`, `cat ${quote(path.join(ws, `link-${i}`))}`],
  ];
  const beside = (file) => path.join(path.dirname(file), 'beside-it.txt');

  before(() => {
    const { secretsRegistry } = require('../../scripts/permission-hook.js');
    const { sandboxSettings } = require('../../lib/workspace/scaffold.js');
    secrets = secretsRegistry(home);
    assert.ok(!/\s/.test(home), 'the made-up home has no space, so the plain spelling needs no quotes');
    fs.mkdirSync(ws, { recursive: true });
    secrets.forEach((file, i) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, dummy(file));
      fs.writeFileSync(beside(file), dummy(beside(file)));
      fs.symlinkSync(file, path.join(ws, `link-${i}`));
    });

    // The block Rundock writes for this workspace, in Notes mode, with the
    // sandbox on: the temp roots are this machine's, as shipped.
    const block = sandboxSettings(ws, 'darwin', home, undefined, [], 'knowledge');
    assert.ok(block && block.enabled === true, 'the block turns the sandbox on');
    assert.deepStrictEqual(block.filesystem.denyRead, secrets, 'the block names every credential file for reads');

    // The control: a file outside every writable root is refused, which proves
    // the sandbox is on. It is beside this checkout, which no root names.
    const outsideDir = path.join(__dirname, '..', '..', '.rundock', 'scratch');
    fs.mkdirSync(outsideDir, { recursive: true });
    const outside = path.join(outsideDir, `sandbox-control-${process.pid}.txt`);
    try {
      seen = sandboxed(block, [
        ...secrets.flatMap((file, i) => ways(file, i).map(([label, command]) => probe(label, command))),
        // Grouped, so the shell's own refusal of the redirection is captured:
        // it opens the target before a trailing 2>&1 takes effect.
        ...secrets.map((file, i) => probe(`write ${i}`, `{ printf planted >> ${quote(file)}; } 2>&1`)),
        ...secrets.map((file, i) => probe(`beside ${i}`, `cat ${quote(beside(file))}`)),
        ...secrets.map((file, i) => probe(`hard link ${i}`, `ln ${quote(file)} ${quote(path.join(ws, `hard-${i}`))} && cat ${quote(path.join(ws, `hard-${i}`))}`)),
        probe('outside', `printf x > ${quote(outside)}`),
      ], ws);
      assert.notStrictEqual(seen.get('outside').status, 0, 'control: a write outside every writable root is refused, so the sandbox is on');
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  const refused = (o, file) => o.status !== 0 && /Operation not permitted/.test(o.out) && !o.out.includes(dummy(file).trim());

  test('each credential file is refused for reads, by its plain path, a quoted one, one built from a variable, and a link in the workspace', () => {
    const through = secrets.flatMap((file, i) => ways(file, i)
      .filter(([label]) => !refused(seen.get(label), file))
      .map(([label]) => `${label.split(' ')[0]} ${path.relative(home, file)} (exit ${seen.get(label).status}: ${seen.get(label).out.slice(0, 200)})`));
    assert.deepStrictEqual(through, [], 'every read is refused by the sandbox');
  });

  test('a write to each is refused as before, and its bytes are unchanged', () => {
    secrets.forEach((file, i) => {
      assert.ok(refused(seen.get(`write ${i}`), file), `${path.relative(home, file)}: the write is refused`);
      assert.strictEqual(fs.readFileSync(file, 'utf8'), dummy(file), `${path.relative(home, file)}: its bytes are unchanged`);
    });
  });

  test('a file beside each, which the block does not name, reads as before', () => {
    secrets.forEach((file, i) => {
      const o = seen.get(`beside ${i}`);
      assert.strictEqual(o.status, 0, `${path.relative(home, beside(file))}: read (${o.out.slice(0, 200)})`);
      assert.strictEqual(o.out, dummy(beside(file)).trim(), 'and its contents came back');
    });
  });

  test('a hard link made by a sandboxed ln: reported, not asserted', (t) => {
    secrets.forEach((file, i) => {
      const o = seen.get(`hard link ${i}`);
      const outcome = o.status === 0 && o.out.includes(dummy(file).trim()) ? 'linked and read' : `not read (exit ${o.status}: ${o.out.slice(0, 200)})`;
      t.diagnostic(`hard link to ${path.relative(home, file)}: ${outcome}`);
    });
  });
});
