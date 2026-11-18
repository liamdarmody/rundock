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
// must still read.
//
// A hard link is a second name for the same file, so it is measured in three
// separate steps: a sandboxed `ln`, the destination's link count, and a read
// of the destination. The same probes also run under two variants of the
// block, one without its read deny and one without its read deny or the
// credential files in its write deny, so the run shows which rule stops a
// link. Whether a link is made is recorded, never assumed; if one is made
// under the block as written, a read through it must be refused. Every probe
// under every block is printed as one table row.
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
const { quote, probe, parseReport, dummy, beside, plant, reads, hardLink, linkMade, refused, row, HEADER } = require('../helpers/credential-read-probes.js');

const RUNTIME = process.env.RUNDOCK_SANDBOX_RUNTIME;
const skip = process.platform !== 'darwin' ? 'the sandbox block is written for macOS only'
  : !RUNTIME ? 'set RUNDOCK_SANDBOX_RUNTIME to the sandbox runtime\'s dist/cli.js to run it'
    : false;

function sandboxed(filesystem, probes, cwd) {
  // The runtime's own settings shape: the block's three lists as written (an
  // empty read deny where a variant has none), and no network, which nothing
  // here needs.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-srt-settings-'));
  const settings = path.join(dir, 'settings.json');
  const { allowWrite, denyWrite, denyRead = [] } = filesystem;
  fs.writeFileSync(settings, JSON.stringify({
    network: { allowedDomains: [], deniedDomains: [] },
    filesystem: { denyRead, allowWrite, denyWrite },
  }));
  try {
    // The script travels in the environment, so the command line names no file.
    const r = spawnSync(process.execPath, [RUNTIME, '--settings', settings, '-c', 'sh -c "$PROBE"'], {
      cwd, encoding: 'utf8', timeout: 60000,
      env: { ...process.env, HOME: home, PROBE: probes.map((p) => probe(p.label, p.command)).join('\n') },
    });
    const report = parseReport(r.stdout, probes.map((p) => p.label));
    assert.strictEqual(report.size, probes.length, `the sandboxed shell ran every probe and reported (exit ${r.status}, signal ${r.signal}). If this ran inside another sandbox, run it outside one. stderr: ${String(r.stderr).slice(0, 2000)}`);
    return report;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('the sandbox block, run for real, over reads of the credential files', { skip }, () => {
  const ws = path.join(home, 'workspace');
  const WAYS = ['plain', 'quoted', 'variable', 'link'];
  let secrets;
  // One entry per block run: its name, its probes, and what each printed. The
  // first is the block as written, which every assertion reads.
  const runs = [];
  const seen = (label) => runs[0].report.get(label);

  before(() => {
    const { secretsRegistry } = require('../../scripts/permission-hook.js');
    const { sandboxSettings } = require('../../lib/workspace/scaffold.js');
    secrets = secretsRegistry(home);
    assert.ok(!/\s/.test(home), 'the made-up home has no space, so the plain spelling needs no quotes');
    plant(secrets, ws);

    // The block Rundock writes for this workspace, in Notes mode, with the
    // sandbox on: the temp roots are this machine's, as shipped.
    const block = sandboxSettings(ws, 'darwin', home, undefined, [], 'knowledge');
    assert.ok(block && block.enabled === true, 'the block turns the sandbox on');
    assert.deepStrictEqual(block.filesystem.denyRead, secrets, 'the block names every credential file for reads');
    const { denyRead, ...noReadDeny } = block.filesystem;
    const blocks = [
      ['as written', block.filesystem],
      ['no read deny', noReadDeny],
      ['no credential deny', { ...noReadDeny, denyWrite: noReadDeny.denyWrite.filter((entry) => !secrets.includes(entry)) }],
    ];

    // The control: a file outside every writable root is refused, which proves
    // the sandbox is on. It is beside this checkout, which no root names.
    const outsideDir = path.join(__dirname, '..', '..', '.rundock', 'scratch');
    fs.mkdirSync(outsideDir, { recursive: true });
    const outside = path.join(outsideDir, `sandbox-control-${process.pid}.txt`);
    try {
      blocks.forEach(([name, filesystem], b) => {
        const probes = [
          ...secrets.flatMap((file, i) => [
            ...reads(file, i, ws),
            { label: `variable ${i}`, file, command: `p="$HOME"; cat "$p"/${quote(path.relative(home, file))}` },
          ]),
          // Appends run under the block as written only: without the
          // credential write deny one would land, and change the dummy
          // contents every later probe reads. Grouped, so the shell's own
          // refusal of the redirection is captured: it opens the target
          // before a trailing 2>&1 takes effect.
          ...(b === 0 ? secrets.map((file, i) => ({ label: `write ${i}`, file, command: `{ printf planted >> ${quote(file)}; } 2>&1` })) : []),
          ...secrets.map((file, i) => ({ label: `beside ${i}`, file: beside(file), command: `cat ${quote(beside(file))}` })),
          ...secrets.flatMap((file, i) => hardLink(file, i, path.join(ws, `hard-${b}-${i}`))),
          { label: 'outside', command: `printf x > ${quote(outside)}` },
        ];
        const report = sandboxed(filesystem, probes, ws);
        assert.notStrictEqual(report.get('outside').status, 0, `control, ${name}: a write outside every writable root is refused, so the sandbox is on`);
        runs.push({ name, probes, report });
      });
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  test('each credential file is refused for reads, by its plain path, a quoted one, one built from a variable, and a link in the workspace', () => {
    const through = secrets.flatMap((file, i) => WAYS.map((way) => `${way} ${i}`)
      .filter((label) => !refused(seen(label), file))
      .map((label) => `${label.split(' ')[0]} ${path.relative(home, file)} (exit ${seen(label).status}: ${seen(label).out.slice(0, 200)})`));
    assert.deepStrictEqual(through, [], 'every read is refused by the sandbox');
  });

  test('a write to each is refused as before, and its bytes are unchanged', () => {
    secrets.forEach((file, i) => {
      assert.ok(refused(seen(`write ${i}`), file), `${path.relative(home, file)}: the write is refused`);
      assert.strictEqual(fs.readFileSync(file, 'utf8'), dummy(file), `${path.relative(home, file)}: its bytes are unchanged`);
    });
  });

  test('a file beside each, which the block does not name, reads as before', () => {
    secrets.forEach((file, i) => {
      const o = seen(`beside ${i}`);
      assert.strictEqual(o.status, 0, `${path.relative(home, beside(file))}: read (${o.out.slice(0, 200)})`);
      assert.strictEqual(o.out, dummy(beside(file)).trim(), 'and its contents came back');
    });
  });

  test('a hard link made by a sandboxed ln: whether it is made is recorded, and a read through one that is made is refused', () => {
    const through = secrets.flatMap((file, i) => {
      const read = seen(`read through hard link ${i}`);
      const made = linkMade(runs[0].report, i);
      return (made ? !refused(read, file) : read.out.includes(dummy(file).trim()))
        ? [`${path.relative(home, file)}: ${made ? 'made' : 'not made'}, read exit ${read.status}: ${read.out.slice(0, 200)}`] : [];
    });
    assert.deepStrictEqual(through, [], 'no read through a hard link prints a credential file');
  });

  test('every probe under each block, as one table', (t) => {
    t.diagnostic(HEADER);
    for (const { name, probes, report } of runs) {
      for (const p of probes) t.diagnostic(row(name, p, report.get(p.label), home));
    }
  });
});
