#!/usr/bin/env node
'use strict';
// Stream-truth harness: verify the stub against the real runtime.
//
// Modes:
//   npm run stream:truth              # check: stub grammar vs the committed capture
//   npm run stream:truth -- --capture # re-capture from the REAL CLI (live spend),
//                                     # verify invariants, rewrite captured-grammar.json
//
// The check mode is deterministic and free: it drives the stub binary with
// the capture scenarios and diffs the reduced grammars against
// captured-grammar.json. It FAILS if the installed `claude` version differs
// from the captured one: a runtime change invalidates the capture, and the
// fix is to re-run with --capture (which is also how divergence in reality
// itself gets surfaced: capture verifies stream invariants before writing).
//
// The scenarios are the two shapes that matter to the server's decision
// points: a plain text turn, and a tool-use turn (the multi-message shape
// that killed the first 0.11.6 draft).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const { reduceToGrammar, normalize, checkStreamInvariants, diffGrammars } = require('./grammar.js');

const { SCENARIOS } = require('./scenarios.js');

const CAPTURE_FILE = path.join(HERE, 'captured-grammar.json');
const STUB = path.join(ROOT, 'test', 'helpers', 'stub-claude', 'claude');
const CAPTURE = process.argv.includes('--capture');

function fail(msg) {
  console.error(`[stream-truth] FAIL: ${msg}`);
  process.exit(1);
}

function cliVersion(bin) {
  return execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim().split(/\s/)[0];
}

// Run a claude-shaped binary with one stream-json user message, collect stdout.
function runTurn(bin, { prompt, cliArgs = [], cwd, env = {} }) {
  return new Promise((resolve, reject) => {
    const args = [
      '--print', '--model', 'haiku',
      '--output-format', 'stream-json', '--input-format', 'stream-json',
      '--verbose', '--include-partial-messages',
      ...cliArgs,
    ];
    const proc = spawn(bin, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    proc.stdout.on('data', d => { out += d; });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code !== 0) reject(new Error(`exit ${code}`));
      else resolve(out);
    });
    proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n');
    proc.stdin.end();
  });
}

async function stubGrammarViaBinary(scenario) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-truth-stub-'));
  try {
    fs.writeFileSync(path.join(dir, 'stub-scenario.json'), JSON.stringify({ rules: [scenario.stubRule] }));
    const raw = await runTurn(STUB, { prompt: scenario.prompt, cwd: dir });
    return normalize(reduceToGrammar(raw));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function capture() {
  const version = cliVersion('claude');
  console.log(`[stream-truth] capturing from real CLI ${version} (live spend)...`);
  const captured = { runtimeVersion: version, capturedAt: new Date().toISOString(), scenarios: {} };
  for (const scenario of SCENARIOS) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-truth-live-'));
    let raw;
    try {
      raw = await runTurn('claude', { prompt: scenario.prompt, cliArgs: scenario.cliArgs, cwd: dir });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const grammar = reduceToGrammar(raw);
    const invariantErrors = checkStreamInvariants(grammar);
    if (invariantErrors.length) {
      fail(`real CLI ${version} broke stream invariants on "${scenario.name}":\n  - ${invariantErrors.join('\n  - ')}\nThe runtime's stream contract has CHANGED; server decision points must be re-verified before this capture is committed.`);
    }
    captured.scenarios[scenario.name] = { raw: grammar, normalized: normalize(grammar) };
    console.log(`[stream-truth] ${scenario.name}: captured ${grammar.length} grammar tokens, invariants hold`);
  }
  fs.writeFileSync(CAPTURE_FILE, JSON.stringify(captured, null, 2) + '\n');
  console.log(`[stream-truth] capture written: ${path.relative(ROOT, CAPTURE_FILE)} (commit it)`);
  return captured;
}

async function check() {
  if (!fs.existsSync(CAPTURE_FILE)) {
    fail('no captured-grammar.json: run with --capture first (needs the real CLI)');
  }
  const captured = JSON.parse(fs.readFileSync(CAPTURE_FILE, 'utf8'));

  // A runtime version change invalidates the capture: reality may have moved.
  let installed = null;
  try { installed = cliVersion('claude'); } catch { /* no real CLI on this machine (CI) */ }
  if (installed && installed !== captured.runtimeVersion) {
    fail(`installed CLI is ${installed} but the capture is from ${captured.runtimeVersion}. ` +
      'Re-capture against the new runtime: npm run stream:truth -- --capture');
  }
  if (!installed) {
    console.log(`[stream-truth] no real CLI on this machine; checking stub against capture from ${captured.runtimeVersion}`);
  }

  let failed = false;
  for (const scenario of SCENARIOS) {
    const expected = captured.scenarios[scenario.name];
    if (!expected) { console.error(`[stream-truth] FAIL: no capture for "${scenario.name}"`); failed = true; continue; }

    const invariantErrors = checkStreamInvariants(expected.raw);
    if (invariantErrors.length) {
      console.error(`[stream-truth] FAIL: committed capture for "${scenario.name}" violates invariants: ${invariantErrors.join('; ')}`);
      failed = true;
      continue;
    }

    const actual = await stubGrammarViaBinary(scenario);
    const diff = diffGrammars(expected.normalized, actual);
    if (diff) {
      console.error(`[stream-truth] FAIL: stub diverges from the real runtime on "${scenario.name}":\n${diff}`);
      failed = true;
    } else {
      console.log(`[stream-truth] ${scenario.name}: stub matches the ${captured.runtimeVersion} capture`);
    }
  }
  if (failed) process.exit(1);
  console.log('[stream-truth] PASS: the stub is a faithful model of the captured runtime');
}

if (CAPTURE) await capture();
await check();
