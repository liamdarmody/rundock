#!/usr/bin/env node
'use strict';
// Transcript-truth harness: pin the session transcript's shape to a real one.
//
// Modes:
//   npm run transcript:truth              # check: committed capture vs the reader
//   npm run transcript:truth -- --capture # re-capture from the REAL CLI (live spend)
//
// WHY THIS EXISTS. lib/runtime/session-transcript.js reads a file written by
// the agent tool, in a format nobody here owns and nothing here can hold
// still. Every claim it makes about that format (where the outcome sits, how
// a creation differs from an overwrite, what marks a refused write) is a
// claim about somebody else's software. Believed, those claims decay
// silently: the reader keeps returning a confident file list that is quietly
// wrong or quietly empty. Checked against a captured artefact, they fail
// loudly on the day the runtime moves.
//
// This is the same instrument as scripts/stream-truth, one format over.
//
// TWO THINGS TO KNOW ABOUT THE GATE ITSELF, both of which predate this
// harness and neither of which it fixes. Continuous integration does not run
// either truth harness: they live in the release gate, so a pull request can
// go green with a capture that reality has left behind. And the neighbouring
// stream-truth capture already names an older runtime than the binary
// installed here, so its version check would fail today if anybody ran it.
// The half of this harness that CI DOES run is
// test/unit/session-transcript-capture.test.js, which holds the reader to the
// committed artefact without needing a runtime; the version check below is
// what nobody is running.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const { checkTranscriptInvariants, EXPECTED_EXTRACTION, EXPECTED_ABSENT } = require('./truth.js');
const { readSessionTranscript } = require(path.join(ROOT, 'lib', 'runtime', 'session-transcript.js'));

const CAPTURE_FILE = path.join(HERE, 'captured-transcript.json');
const CAPTURE = process.argv.includes('--capture');

function fail(msg) {
  console.error(`[transcript-truth] FAIL: ${msg}`);
  process.exit(1);
}

function cliVersion(bin) {
  return execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim().split(/\s/)[0];
}

// One run that exercises every shape the reader depends on: a file created, a
// file edited, a file overwritten, a write that is refused, and two writes
// issued in parallel from one message.
const PROMPT = `Do exactly these steps in this order, using no Bash at all.
1. Use the Write tool to create new.md containing the word one.
2. Use the Edit tool on existing.md to change the word alpha to gamma.
3. Use the Write tool to overwrite overwrite.md with the word two.
4. Use the Write tool once on the absolute path /System/capture-blocked.txt with the word three. This will fail; do not retry it and do not work around it.
5. In a SINGLE message, issue two parallel Write tool calls at the same time: par-a.md containing four, and par-b.md containing five.
Then stop and say done.`;

function seedWorkspace(dir) {
  fs.writeFileSync(path.join(dir, 'existing.md'), 'alpha\nbeta\n');
  fs.writeFileSync(path.join(dir, 'overwrite.md'), 'old\n');
}

// The routine spawn's own shape: print mode, stream-json, verbose, permissions
// skipped, output discarded, and the session named by the caller. Captured
// under the conditions the reader is used in, because a transcript from an
// interactive session is a different artefact.
function runRoutineShaped(dir, sessionId) {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', [
      '--add-dir', dir,
      '--model', 'sonnet',
      '--print', '--output-format', 'stream-json', '--verbose',
      '--dangerously-skip-permissions',
      '--session-id', sessionId,
      PROMPT,
    ], { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'] });
    proc.on('error', reject);
    proc.on('close', code => (code === 0 ? resolve() : reject(new Error(`real CLI exited ${code}`))));
  });
}

// Found by scanning for the session id, which is what the reader does and for
// the same reason: the directory name is derived from the working directory by
// a rule this project does not own.
function findTranscript(sessionId) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  for (const dir of fs.readdirSync(root)) {
    const candidate = path.join(root, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

async function capture() {
  const version = cliVersion('claude');
  const sessionId = randomUUID();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-truth-'));
  console.log(`[transcript-truth] capturing from real CLI ${version} in ${dir} (live spend)...`);
  seedWorkspace(dir);
  await runRoutineShaped(dir, sessionId);

  const file = findTranscript(sessionId);
  if (!file) fail(`no transcript named for session ${sessionId}: the runtime no longer names it for the session it was given, which is the assumption the whole reader rests on`);

  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const problems = checkTranscriptInvariants(lines);
  if (problems.length) {
    fail(`real CLI ${version} no longer matches what the reader assumes:\n  - ${problems.join('\n  - ')}\n` +
      'The transcript format has CHANGED. Fix the reader before committing this capture.');
  }
  fs.writeFileSync(CAPTURE_FILE, JSON.stringify({
    runtimeVersion: version,
    capturedAt: new Date().toISOString(),
    sessionId,
    workspace: dir,
    prompt: PROMPT,
    lines,
  }, null, 2) + '\n');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`[transcript-truth] capture written: ${path.relative(ROOT, CAPTURE_FILE)} (${lines.length} lines; commit it)`);
}

function check() {
  if (!fs.existsSync(CAPTURE_FILE)) fail('no captured-transcript.json: run with --capture first (needs the real CLI)');
  const captured = JSON.parse(fs.readFileSync(CAPTURE_FILE, 'utf8'));

  let installed = null;
  try { installed = cliVersion('claude'); } catch { /* no real CLI on this machine (CI) */ }
  if (installed && installed !== captured.runtimeVersion) {
    fail(`installed CLI is ${installed} but the capture is from ${captured.runtimeVersion}. ` +
      'Re-capture against the new runtime: npm run transcript:truth -- --capture');
  }
  if (!installed) console.log(`[transcript-truth] no real CLI here; checking the reader against the capture from ${captured.runtimeVersion}`);

  const problems = checkTranscriptInvariants(captured.lines);
  if (problems.length) fail(`the committed capture does not satisfy what the reader assumes:\n  - ${problems.join('\n  - ')}`);

  // The reader, over the captured artefact, through its real lookup: the
  // capture is laid down where a transcript lives and asked for by session id.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-truth-home-'));
  const realHome = process.env.HOME;
  try {
    const dir = path.join(home, '.claude', 'projects', 'captured');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${captured.sessionId}.jsonl`), captured.lines.join('\n') + '\n');
    process.env.HOME = home;
    const result = readSessionTranscript(captured.sessionId);
    if (result.status !== 'known') fail(`the reader could not read the captured transcript: ${result.reason}`);
    const got = result.files.map(f => [path.basename(f.path), f.change]);
    const want = EXPECTED_EXTRACTION;
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      fail(`the reader extracts ${JSON.stringify(got)} from the capture, expected ${JSON.stringify(want)}`);
    }
    if (got.some(([name]) => name === EXPECTED_ABSENT)) fail(`${EXPECTED_ABSENT} was attempted and refused; it must never be listed as changed`);
  } finally {
    process.env.HOME = realHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
  console.log(`[transcript-truth] PASS: the reader matches the ${captured.runtimeVersion} capture`);
}

if (CAPTURE) await capture();
check();
