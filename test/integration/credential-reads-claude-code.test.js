'use strict';
// THE NOTES-MODE BLOCK, THROUGH THE INSTALLED CLAUDE CODE, OVER READS OF THE
// CREDENTIAL FILES.
//
// credential-reads-real-sandbox.test.js hands the block's lists to the
// standalone sandbox runtime. This hands the block to the installed Claude Code
// itself, the way Rundock does, so what is measured is what Claude Code's own
// Bash tool is refused under it.
//
// A made-up home under the temp folder holds a dummy file at every path
// `credentialDenyFor` names, an unnamed file beside each, and a workspace. The
// block `sandboxSettings` builds for Notes mode is written, unchanged, where
// Rundock writes it: the workspace's `.claude/settings.local.json`. The other
// project layer, `.claude/settings.json`, names one more dummy file in a read
// deny of its own, so the run shows the lists from both layers apply. The
// probes go in `probe.sh` in the workspace, one line each: a plain, a quoted
// and a symbolic-link read of each credential file, each unnamed neighbour,
// the file named only in the other layer, and the hard-link steps the other
// test measures. Then the real `claude` runs once, non-interactively, with
// project and local settings only, the Bash tool only, and a prompt to run
// `sh probe.sh` once. Its stream must hold exactly that one call, inside the
// sandbox, and its result is read back as a table.
//
// The run signs in as the account running it, so Claude Code keeps that
// account's home. No probe names it: every path a probe reads is under the
// made-up home, and this process reads no credential file of its own.
//
// RUN BY HAND, NEVER IN CI: macOS only, and skipped unless
// RUNDOCK_LIVE_CLAUDE_CODE=1. Claude Code starts its own sandbox, so this must
// run with no other sandbox around it. It makes one model call.
const ownEnv = { ...process.env };
const { home } = require('../helpers/made-up-home.js');
const { test, describe, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { quote, probe, parseReport, dummy, beside, plant, reads, hardLink, linkMade, refused, row, HEADER } = require('../helpers/credential-read-probes.js');

const skip = process.platform !== 'darwin' ? 'the sandbox block is written for macOS only'
  : process.env.RUNDOCK_LIVE_CLAUDE_CODE !== '1' ? 'set RUNDOCK_LIVE_CLAUDE_CODE=1 to run it through the installed Claude Code'
    : false;

const STUB_DIR = path.join(__dirname, '..', 'helpers', 'stub-claude');
const COMMAND = 'sh probe.sh';
const PROMPT = `Use the Bash tool exactly once, to run this command exactly as written, in the current folder: ${COMMAND}\n`
  + 'Run nothing else and use no other tool. Do not ask to run it outside the sandbox. When it has finished, reply with the one word: done.';

describe('the Notes-mode block, through the installed Claude Code, over reads of the credential files', { skip }, () => {
  const ws = path.join(home, 'workspace');
  const other = path.join(home, 'elsewhere', 'named-in-the-other-layer.txt');
  let secrets, probes, report, calls, run, resultText, version;
  const seen = (label) => report.get(label) || { status: NaN, out: 'no line for this probe' };

  before(() => {
    const { sandboxSettings, credentialDenyFor } = require('../../lib/workspace/scaffold.js');
    secrets = credentialDenyFor(home);
    assert.ok(!/\s/.test(home), 'the made-up home has no space, so the plain spelling needs no quotes');
    plant(secrets, ws);
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.writeFileSync(other, dummy(other));

    const block = sandboxSettings(ws, 'darwin', home, undefined, [], 'knowledge');
    assert.ok(block && block.enabled === true, 'the block turns the sandbox on');
    assert.deepStrictEqual(block.filesystem.denyRead, secrets, 'the block names every credential file for reads');
    fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.claude', 'settings.local.json'), `${JSON.stringify({ sandbox: block }, null, 2)}\n`);
    fs.writeFileSync(path.join(ws, '.claude', 'settings.json'), `${JSON.stringify({ sandbox: { filesystem: { denyRead: [other] } } }, null, 2)}\n`);

    probes = [
      ...secrets.flatMap((file, i) => reads(file, i, ws)),
      ...secrets.map((file, i) => ({ label: `beside ${i}`, file: beside(file), command: `cat ${quote(beside(file))}` })),
      { label: 'other layer', file: other, command: `cat ${quote(other)}` },
      ...secrets.flatMap((file, i) => hardLink(file, i, path.join(ws, `hard-${i}`))),
    ];
    fs.writeFileSync(path.join(ws, 'probe.sh'), `${probes.map((p) => probe(p.label, p.command)).join('\n')}\n`);

    // The installed Claude Code, never the test stub. A session that launched
    // this marks its environment, and a nested launch is refused, so the mark
    // is dropped.
    const env = { ...ownEnv };
    delete env.CLAUDECODE;
    const bin = String(spawnSync('which', ['claude'], { encoding: 'utf8', env }).stdout || '').trim();
    assert.ok(bin, 'a claude binary is on the PATH');
    assert.ok(!fs.realpathSync(bin).startsWith(fs.realpathSync(STUB_DIR)), 'the claude on the PATH is Claude Code, not the test stub');
    version = String(spawnSync(bin, ['--version'], { encoding: 'utf8', env }).stdout || '').trim();

    run = spawnSync(bin, [
      '-p', PROMPT,
      '--output-format', 'stream-json', '--verbose',
      '--setting-sources', 'project,local',
      '--tools', 'Bash',
      '--strict-mcp-config', '--no-session-persistence',
      '--permission-prompts', 'none',
      '--max-budget-usd', '1',
    ], { cwd: ws, encoding: 'utf8', env, timeout: 600000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

    const events = String(run.stdout).split('\n').filter((line) => line.startsWith('{'))
      .flatMap((line) => { try { return [JSON.parse(line)]; } catch (e) { return []; } });
    const content = (type) => events.filter((e) => e.type === type && e.message && Array.isArray(e.message.content))
      .flatMap((e) => e.message.content);
    calls = content('assistant').filter((b) => b.type === 'tool_use');
    const result = calls.length ? content('user').find((b) => b.type === 'tool_result' && b.tool_use_id === calls[0].id) : null;
    resultText = !result ? '' : typeof result.content === 'string' ? result.content
      : (result.content || []).map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n');
    report = parseReport(resultText, probes.map((p) => p.label));
  });

  test('Claude Code ran the probes in exactly one Bash call, and never asked to leave the sandbox', () => {
    const outside = calls.filter((c) => c.input && c.input.dangerouslyDisableSandbox === true);
    assert.deepStrictEqual(outside.map((c) => c.input.command), [], 'no call asked to run outside the sandbox');
    assert.deepStrictEqual(calls.map((c) => [c.name, String(c.input && c.input.command).trim()]), [['Bash', COMMAND]],
      `exactly one call, the Bash tool running the probes (exit ${run.status}, signal ${run.signal}, stderr: ${String(run.stderr).slice(0, 2000)})`);
    assert.strictEqual(report.size, probes.length, `its result has a line for every probe: ${resultText.split(home).join('<home>').slice(0, 2000)}`);
  });

  test('each credential file is refused for reads, by its plain path, a quoted one, and a link in the workspace', () => {
    const through = secrets.flatMap((file, i) => ['plain', 'quoted', 'link'].map((way) => `${way} ${i}`)
      .filter((label) => !refused(seen(label), file))
      .map((label) => `${label.split(' ')[0]} ${path.relative(home, file)} (exit ${seen(label).status}: ${seen(label).out.split(home).join('<home>').slice(0, 200)})`));
    assert.deepStrictEqual(through, [], 'every read is refused with the operating system\'s refusal, and prints none of the file');
  });

  test('a file beside each, which no list names, reads', () => {
    secrets.forEach((file, i) => {
      const o = seen(`beside ${i}`);
      assert.strictEqual(o.status, 0, `${path.relative(home, beside(file))}: read (${o.out.split(home).join('<home>').slice(0, 200)})`);
      assert.strictEqual(o.out, dummy(beside(file)).trim(), 'and its contents came back');
    });
  });

  test('a file named only in the other project layer\'s read deny is refused too, so the lists from both layers apply', () => {
    assert.ok(refused(seen('other layer'), other), `the read is refused (exit ${seen('other layer').status}: ${seen('other layer').out.split(home).join('<home>').slice(0, 200)})`);
  });

  test('a hard link made by the sandboxed ln: whether it is made is recorded, and a read through one that is made is refused', () => {
    const through = secrets.flatMap((file, i) => {
      const read = seen(`read through hard link ${i}`);
      const made = report.has(`ln ${i}`) && report.has(`link count ${i}`) && linkMade(report, i);
      return (made ? !refused(read, file) : read.out.includes(dummy(file).trim()))
        ? [`${path.relative(home, file)}: ${made ? 'made' : 'not made'}, read exit ${read.status}`] : [];
    });
    assert.deepStrictEqual(through, [], 'no read through a hard link prints a credential file');
  });

  test('the Claude Code version and every probe line, as one table', (t) => {
    t.diagnostic(`claude --version: ${version}`);
    t.diagnostic(HEADER);
    for (const p of probes) t.diagnostic(row('Claude Code', p, report.get(p.label), home));
  });
});
