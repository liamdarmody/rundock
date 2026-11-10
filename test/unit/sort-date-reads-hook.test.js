'use strict';
// THROUGH THE REAL HOOK: `sort` and `date` under the runtime's own home are
// freed exactly when the shared definition reads them as reads.
//
// The hook lets an agent read the runtime's own hook scripts and settings with
// no card, and it learns what a read is from public/read-only-shell.js. That
// module now reads `sort` and `date` in the forms that read, so a reading one
// frees what `cat` and `stat` free, and a writing one keeps asking.
//
// Each case runs the hook as its own process, the way the runtime does, against
// a stand-in for Rundock that records what the hook asked and answers no.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { UNATTENDED_NEXT } = require('../../scripts/refusal-notice.js');

const HOOK = path.join(__dirname, '..', '..', 'scripts', 'permission-hook.js');
const SHARED = path.join(__dirname, '..', '..', 'public', 'read-only-shell.js');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sort-date-hook-')));
const home = path.join(root, 'home');
const ws = path.join(root, 'ws');
const hooks = path.join(home, '.claude', 'hooks');
const script = path.join(hooks, 'pretool.sh');
const settings = path.join(home, '.claude', 'settings.json');
const credentials = path.join(home, '.claude', '.credentials.json');
fs.mkdirSync(hooks, { recursive: true });
fs.mkdirSync(path.join(ws, '.claude'), { recursive: true });
fs.mkdirSync(path.join(ws, 'notes'), { recursive: true });
fs.writeFileSync(script, '');
fs.writeFileSync(settings, '{}');
fs.writeFileSync(credentials, '{}');
fs.writeFileSync(path.join(ws, 'notes', 'yesterday.md'), '- one\n- two\n');

// A FAILURE FORCED INSIDE THE SHARED DEFINITION, loaded ahead of the hook with
// `--require`. The hook has no switch for it, so nothing in a tool call can set
// it off: the test seam it uses can only make the reading fail.
const readingFails = path.join(root, 'reading-fails.js');
fs.writeFileSync(readingFails,
  `require(${JSON.stringify(SHARED)}).optionReadingSeam.beforeReading = () => { throw new Error('forced failure'); };\n`);

const asked = new Map();
let server;
before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url.startsWith('/api/permission-request')) {
        try { const d = JSON.parse(body); asked.set(d.session_id, d); } catch (e) { /* asserted by the callers */ }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ allow: false }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
});
after(async () => {
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  fs.rmSync(root, { recursive: true, force: true });
});

// A conversation's agent is started with its conversation's id, and a
// routine's with none. An undefined value is left out of the child's
// environment.
const CONVERSATION = { RUNDOCK_CONVO_ID: 'c1' };
const ROUTINE = { RUNDOCK_CONVO_ID: undefined };

let seq = 0;
function runHook(toolName, toolInput, { env = {}, preload } = {}) {
  const sid = `sort-date-hook-${process.pid}-${++seq}`;
  return new Promise((resolve) => {
    const args = [...(preload ? ['--require', preload] : []), HOOK];
    const proc = spawn(process.execPath, args, {
      env: {
        ...process.env, NODE_V8_COVERAGE: '', RUNDOCK: '1', RUNDOCK_PORT: String(server.address().port),
        RUNDOCK_WORKSPACE: ws, RUNDOCK_CODE_MODE: '', HOME: home, USERPROFILE: home, ...env,
      },
    });
    const ending = setTimeout(() => proc.kill('SIGKILL'), 30000);
    let out = '';
    let err = '';
    proc.stdout.on('data', (c) => { out += c; });
    proc.stderr.on('data', (c) => { err += c; });
    proc.on('close', (status) => {
      clearTimeout(ending);
      let answer = null;
      try { answer = JSON.parse(out).hookSpecificOutput; } catch (e) { /* asserted below */ }
      resolve({ status, err, decision: answer && answer.permissionDecision, reason: (answer && answer.permissionDecisionReason) || '', card: asked.get(sid) || null });
    });
    proc.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', cwd: ws, session_id: sid, tool_name: toolName, tool_input: toolInput }));
  });
}
const bash = (command, opts) => runHook('Bash', { command }, opts);

const under = (p, file) => p === file || p.startsWith(path.dirname(file) + path.sep);
function assertAsksAbout(r, target, command) {
  assert.strictEqual(r.status, 0, r.err);
  assert.ok(r.card, `the hook asked nobody: ${command}`);
  assert.strictEqual(r.card.boundary, true, `the crossing into the runtime's home was freed: ${command}`);
  assert.ok(r.card.crossings.some((c) => c.persistenceSurface && c.write && under(c.path, fs.realpathSync(target))),
    `the card names the file as changed: ${JSON.stringify(r.card.crossings)}`);
  assert.strictEqual(r.decision, 'deny', 'and the answer it was given, no, is the answer');
}
function assertFreed(r, command) {
  assert.strictEqual(r.status, 0, r.err);
  assert.ok(r.card, `the hook still asks the browser to grade it: ${command}`);
  assert.notStrictEqual(r.card.boundary, true, `a read of the runtime's home raised a crossing: ${command}`);
}
function assertWords(r, unattended) {
  assert.strictEqual(r.reason.endsWith(` ${UNATTENDED_NEXT}`), unattended,
    `${unattended ? 'a routine is' : 'a conversation is not'} told what to do next unattended: ${r.reason}`);
}

// A NOTES-MODE WRITE OF A NOTE IN THE WORKSPACE, as the hook has always
// judged one, and as it judges one on main: allowed as in-workspace file
// access, with nothing asked of Rundock.
function assertNoteWriteAllowed(r) {
  assert.strictEqual(r.status, 0, r.err);
  assert.strictEqual(r.decision, 'allow', 'the Write of a note in the workspace is allowed');
  assert.strictEqual(r.reason, 'In-workspace file access', 'as in-workspace file access');
  assert.strictEqual(r.card, null, 'and Rundock is not asked');
}

// The writing forms, each beside the reading twin that differs from it only
// by the option that writes, runs a program or sets the clock.
const PAIRS = [
  [`sort -o ${script} ${script}`, `sort ${script}`, script],
  [`sort -uo ${script} x`, `sort -u ${script}`, script],
  [`sort --output=${settings} ${settings}`, `sort --unique ${settings}`, settings],
  [`sort -T ${hooks} ${script}`, `sort -t, ${script}`, script],
  [`sort --compress-program=sh ${script}`, `sort --debug ${script}`, script],
  [`date -s 2026-01-01 -r ${script}`, `date -u -r ${script}`, script],
  [`date -r ${script} 010112002026`, `date -r ${script} +%Y-%m-%d`, script],
  [`date -f %Y%m%d -r ${script}`, `date -j -f %Y%m%d -r ${script}`, script],
];

describe('through the real hook, sort and date under the runtime home are freed only when they read', () => {
  test('a reading sort or date of a hook script or the settings is freed exactly as cat and stat of it are', async () => {
    for (const target of [script, settings]) {
      for (const command of [`cat ${target}`, `stat ${target}`]) assertFreed(await bash(command), `the comparison: ${command}`);
      for (const command of [`sort ${target}`, `sort -rn ${target}`, `sort -t, -k2,2n ${target}`, `ls ${hooks} | sort`,
        `date -r ${target}`, `date -r ${target} +%s`, `cat ${target} | sort && date`]) {
        assertFreed(await bash(command), command);
      }
    }
  });

  test('a writing sort of a file under the runtime home asks', async () => {
    const command = `sort -o ${script} x`;
    assertAsksAbout(await bash(command), script, command);
  });

  test("a descriptor number glued to an option is the option's, so the writing form keeps its crossing", async () => {
    // `-t2>&1` is `-t2`, then `>&1`: the `-o` after it is still sort's.
    for (const command of [`sort -t2>&1 -o ${script} x`, `sort -k1>/dev/null -o ${script} x`, `date -r1>/dev/null ${script}`]) {
      assertAsksAbout(await bash(command), script, command);
    }
  });

  test('a reading sort of the credential file asks, as cat of it does', async () => {
    for (const command of [`cat ${credentials}`, `sort ${credentials}`, `date -r ${credentials}`]) {
      const r = await bash(command);
      assert.strictEqual(r.status, 0, r.err);
      assert.ok(r.card && r.card.crossings.some((c) => c.secret), `the credential file is asked about: ${command}`);
      assert.strictEqual(r.decision, 'deny', command);
    }
  });

  for (const [who, env, unattended] of [['a conversation', CONVERSATION, false], ['a routine', ROUTINE, true]]) {
    test(`${who}: each writing form asks, and its reading twin beside it is freed`, async () => {
      for (const [writes, reads, target] of PAIRS) {
        const w = await bash(writes, { env });
        assertAsksAbout(w, target, writes);
        assertWords(w, unattended);
        assertFreed(await bash(reads, { env }), reads);
      }
    });

    test(`${who}: after a writing sort is refused, the next listing piped to sort is freed`, async () => {
      const writes = `sort -o ${script} ${script}`;
      assertAsksAbout(await bash(writes, { env }), script, writes);
      assertFreed(await bash(`ls ${hooks} | sort`, { env }), 'the listing after the refusal');
    });

    test(`${who}: the same writing form sent again asks again, in the same words`, async () => {
      const writes = `sort -o ${script} ${script}`;
      const first = await bash(writes, { env });
      const again = await bash(writes, { env });
      assertAsksAbout(again, script, writes);
      assert.strictEqual(again.reason, first.reason, 'the retry is answered in the words of the first asking');
      assert.deepStrictEqual(again.card.crossings, first.card.crossings, 'and asks about the same place');
    });

    test(`${who}: the routine's listing, then cat of the note it found, then a Write of the cleaned note`, async () => {
      const listing = "ls -la && echo \"---\" && find . -type f -not -path './.git/*' | sort && echo \"---\" && date";
      const note = path.join(ws, 'notes', 'yesterday.md');
      assertFreed(await bash(listing, { env }), listing);
      assertFreed(await bash(`cat ${note}`, { env }), 'the cat of the note');
      // The Write is judged as any Notes-mode write of a note is.
      assertNoteWriteAllowed(await runHook('Write', { file_path: note, content: '- one\n- two\n- three\n' }, { env }));
    });

    test(`${who}: a Write of a note on its own gets that verdict`, async () => {
      const note = path.join(ws, 'notes', 'yesterday.md');
      assertNoteWriteAllowed(await runHook('Write', { file_path: note, content: '- one\n- two\n- three\n' }, { env }));
    });

    test(`${who}: a failure forced inside the shared definition asks, and never frees`, async () => {
      const command = `sort ${script}`;
      assertFreed(await bash(command, { env }), `sanity, with nothing forced: ${command}`);
      const r = await bash(command, { env, preload: readingFails });
      assertAsksAbout(r, script, command);
      assertWords(r, unattended);
    });
  }
});
