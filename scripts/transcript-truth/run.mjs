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
const { checkTranscriptInvariants, checkCaptureAnswers, withoutDelegation, EXPECTED_EXTRACTION, EXPECTED_ABSENT } = require('./truth.js');
// THE READER'S OWN LOOKUP, not a copy of it. This harness used to scan for the
// session id itself, with a comment saying it was doing what the reader does,
// which is a rule stated twice and true only while both copies are edited
// together: a change to the search would leave the harness pinning a file the
// product never reads.
//
// AND THERE IS NO THIRD COPY, which was worth checking because the product
// does locate transcripts elsewhere. lib/store/transcripts.js is a different
// artefact entirely: it reads a conversation's own transcript out of the
// workspace's .rundock/transcripts directory, keyed by conversation id, and it
// never goes near the agent tool's session files. So the search rule for a
// session transcript is stated once, in the reader, and used here.
const { readSessionTranscript, findTranscript, sidechainTranscripts } =
  require(path.join(ROOT, 'lib', 'runtime', 'session-transcript.js'));

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
// file edited, a file overwritten, a notebook cell edited, a write that is
// refused, and two writes issued in parallel from one message.
//
// Every tool the reader claims and this capture is meant to witness has a
// step here. scripts/transcript-truth/truth.js fails if a witnessed tool is
// missing from the capture, so a tool added to the reader cannot narrow what
// this prompt covers without saying so.
//
// THE LAST TWO STEPS SETTLE QUESTIONS RATHER THAN WITNESSING A TOOL, and both
// were raised as things the packet could not answer either way.
//
// The web search asks whether a run that uses a web tool produces content
// blocks the reader does not know, which would turn every research routine
// into an unknown. It does not: on this runtime the search is an ordinary
// tool_use like any other, and the block-type check below runs over these
// lines, so the answer is pinned rather than remembered.
//
// The delegation asks where a subagent's work is recorded. It is recorded in a
// transcript of the subagent's OWN, and that transcript answers a write with an
// English sentence instead of the outcome object the session's transcript
// carries. That is why the reader refuses to list a delegated run's files, and
// this capture is the evidence for it.
const PROMPT = `Do exactly these steps in this order, using no Bash at all.
1. Use the Write tool to create new.md containing the word one.
2. Use the Edit tool on existing.md to change the word alpha to gamma.
3. Use the Write tool to overwrite overwrite.md with the word two.
4. Use the NotebookEdit tool on book.ipynb to replace the source of cell 0 with print('two').
5. Use the Write tool once on the absolute path /System/capture-blocked.txt with the word three. This will fail; do not retry it and do not work around it.
6. In a SINGLE message, issue two parallel Write tool calls at the same time: par-a.md containing four, and par-b.md containing five.
7. Use the WebSearch tool exactly once to search the web for: Node.js long term support release schedule. One sentence about what you found is enough.
8. Use the Agent tool exactly once, with subagent_type general-purpose, to delegate this exact instruction to a subagent: "Use the Write tool to create sub.md in the current working directory containing the word six, then stop."
Then stop and say done.`;

// The file the DELEGATED subagent writes, which the parent's transcript never
// mentions. Named here because two checks turn on it: it must be absent from
// the session's own transcript, and present in the subagent's.
const DELEGATED_FILE = 'sub.md';

const NOTEBOOK = {
  cells: [{ cell_type: 'code', source: ["print('one')\n"], metadata: {}, outputs: [], execution_count: null }],
  metadata: {}, nbformat: 4, nbformat_minor: 5,
};

// THE PERMISSION HOOK, CONFIGURED AS THE PRODUCT CONFIGURES IT, so this run
// answers a second question at the same time: does a PreToolUse hook fire at
// all when a routine spawns with permissions skipped?
//
// It is not a question about this reader. It is the question the revert work
// depends on, because bytes can only be saved before a write by something
// that runs before the write, and nothing else does. It rides along here
// because the run this harness makes is already the exact spawn shape that
// question is about, and because an answer nobody can re-run is an answer
// people end up arguing about.
//
// The hook is fail-open, matching the product's posture for an in-workspace
// write: it records what it was asked about and exits 0.
const HOOK_MATCHERS = ['Bash', 'Read|Write|Edit|MultiEdit|NotebookEdit|Glob|Grep'];
const HOOK_LOG = 'hook-fired.jsonl';

function seedWorkspace(dir) {
  fs.writeFileSync(path.join(dir, 'existing.md'), 'alpha\nbeta\n');
  fs.writeFileSync(path.join(dir, 'overwrite.md'), 'old\n');
  fs.writeFileSync(path.join(dir, 'book.ipynb'), JSON.stringify(NOTEBOOK, null, 1));

  const hook = path.join(dir, 'hook.sh');
  fs.writeFileSync(hook, `#!/bin/sh\ncat >> "${path.join(dir, HOOK_LOG)}"\nprintf '\\n' >> "${path.join(dir, HOOK_LOG)}"\nexit 0\n`);
  fs.chmodSync(hook, 0o755);
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), JSON.stringify({
    hooks: {
      PreToolUse: HOOK_MATCHERS.map(matcher => ({
        matcher, hooks: [{ type: 'command', command: `sh "${hook}"`, timeout: 300 }],
      })),
    },
  }, null, 2));
}

// What the hook recorded, reduced to the answer and enough of the evidence to
// argue with: which tools it was consulted about, and one payload's keys.
function readHookEvidence(dir) {
  const file = path.join(dir, HOOK_LOG);
  if (!fs.existsSync(file)) return { fired: false, calls: 0, tools: [], payloadKeys: [] };
  const payloads = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
  return {
    fired: payloads.length > 0,
    calls: payloads.length,
    tools: [...new Set(payloads.map(p => p.tool_name).filter(Boolean))].sort(),
    payloadKeys: payloads.length ? Object.keys(payloads[0]).sort() : [],
  };
}

// The routine spawn's own shape: print mode, stream-json, verbose, permissions
// skipped, output discarded, and the session named by the caller. Captured
// under the conditions the reader is used in, because a transcript from an
// interactive session is a different artefact.
function runRoutineShaped(dir, sessionId) {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', [
      '--add-dir', dir,
      '--settings', path.join(dir, '.claude', 'settings.local.json'),
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
  // The transcripts the delegated subagent left, read through the reader's own
  // discovery so the harness cannot pin a file the product would not find.
  const subagents = sidechainTranscripts(file, sessionId).map(f => ({
    name: path.basename(f),
    lines: fs.readFileSync(f, 'utf8').split('\n').filter(Boolean),
  }));
  const hook = readHookEvidence(dir);
  const problems = [...checkTranscriptInvariants(lines), ...checkCaptureAnswers({ lines, subagents })];
  if (problems.length) {
    // The run happened and cost what it cost, so the artefact is kept where
    // somebody can look at it rather than thrown away with the process. It is
    // written outside the repository on purpose: a capture that failed its own
    // checks is evidence to read, never a capture to commit.
    const rejected = path.join(os.tmpdir(), `transcript-truth-rejected-${sessionId}.json`);
    fs.writeFileSync(rejected, JSON.stringify({ runtimeVersion: version, sessionId, prompt: PROMPT, problems, lines, subagents }, null, 2) + '\n');
    fail(`real CLI ${version} no longer matches what the reader assumes:\n  - ${problems.join('\n  - ')}\n` +
      `The transcript format has CHANGED. Fix the reader before committing this capture.\nThe run that failed is at ${rejected}`);
  }
  fs.writeFileSync(CAPTURE_FILE, JSON.stringify({
    runtimeVersion: version,
    capturedAt: new Date().toISOString(),
    sessionId,
    workspace: dir,
    prompt: PROMPT,
    // The second question this run answers, recorded with what it was asked
    // and what came back. Whether the pre-tool hook fires when permissions
    // are skipped is a fact about the product, established by running the
    // product, and it decides whether write-time capture is available to the
    // work that needs it.
    permissionHook: {
      question: 'does a PreToolUse hook fire when a routine spawns with --dangerously-skip-permissions?',
      matchers: HOOK_MATCHERS,
      spawn: 'the routine shape: --print --output-format stream-json --verbose --dangerously-skip-permissions --session-id <uuid>, output discarded',
      ...hook,
    },
    lines,
    // The subagent's own transcript, kept beside the session's because the
    // whole point is that they are different files with different shapes.
    subagents,
  }, null, 2) + '\n');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`[transcript-truth] permission hook under skipped permissions: ${hook.fired ? `FIRED (${hook.calls} calls, tools: ${hook.tools.join(', ')})` : 'DID NOT FIRE'}`);
  console.log(`[transcript-truth] delegation: ${subagents.length} subagent transcript(s), filed under the session's own directory`);
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

  const problems = [...checkTranscriptInvariants(captured.lines), ...checkCaptureAnswers(captured)];
  if (problems.length) fail(`the committed capture does not satisfy what the reader assumes:\n  - ${problems.join('\n  - ')}`);
  if (!captured.permissionHook || typeof captured.permissionHook.fired !== 'boolean') {
    fail('the capture carries no answer on whether the permission hook fires with permissions skipped; re-capture');
  }
  console.log(`[transcript-truth] recorded answer: the permission hook ${captured.permissionHook.fired ? 'FIRES' : 'DOES NOT FIRE'} when permissions are skipped (${captured.runtimeVersion})`);

  // The reader, over the captured artefact, through its real lookup: the
  // capture is laid down where a transcript lives and asked for by session id.
  //
  // TWO READINGS OF ONE ARTEFACT, because one capture cannot witness both
  // halves at once: the delegation is precisely what stops the reader
  // publishing a list. Laid down without it, the capture is a run that did not
  // delegate and its file list must come out exactly; laid down whole, with the
  // subagent's transcript where the runtime files it, the same run must report
  // that it cannot say. Both are readings of a real transcript.
  const readAs = (lines, subagents) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-truth-home-'));
    const realHome = process.env.HOME;
    try {
      const dir = path.join(home, '.claude', 'projects', 'captured');
      fs.mkdirSync(path.join(dir, captured.sessionId, 'subagents'), { recursive: true });
      fs.writeFileSync(path.join(dir, `${captured.sessionId}.jsonl`), lines.join('\n') + '\n');
      for (const sub of subagents) {
        fs.writeFileSync(path.join(dir, captured.sessionId, 'subagents', sub.name), sub.lines.join('\n') + '\n');
      }
      process.env.HOME = home;
      return readSessionTranscript(captured.sessionId);
    } finally {
      process.env.HOME = realHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  };

  const plain = readAs(withoutDelegation(captured.lines), []);
  if (plain.status !== 'known') fail(`the reader could not read the captured transcript: ${plain.reason}`);
  const got = plain.files.map(f => [path.basename(f.path), f.change]);
  if (JSON.stringify(got) !== JSON.stringify(EXPECTED_EXTRACTION)) {
    fail(`the reader extracts ${JSON.stringify(got)} from the capture, expected ${JSON.stringify(EXPECTED_EXTRACTION)}`);
  }
  if (got.some(([name]) => name === EXPECTED_ABSENT)) fail(`${EXPECTED_ABSENT} was attempted and refused; it must never be listed as changed`);

  const delegated = readAs(captured.lines, captured.subagents || []);
  if (delegated.status !== 'unknown' || delegated.reason !== 'delegated') {
    fail(`the run that delegated reports ${delegated.status}/${delegated.reason}: a subagent's writes are recorded where this reader cannot read their outcome, so the only honest answer is that the list is not known`);
  }
  console.log(`[transcript-truth] PASS: the reader matches the ${captured.runtimeVersion} capture`);
}

if (CAPTURE) await capture();
check();
