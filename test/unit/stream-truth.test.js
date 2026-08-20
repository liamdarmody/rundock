'use strict';
// Stream-truth: the stub is verified against the real runtime, continuously.
//
// 0.11.6 shipped a draft with delegation interception dead on real streams
// while 1,333 stub-shaped tests stayed green: the stub emitted the
// consolidated assistant envelope end-of-message; the real CLI emits it per
// block, mid-message, and closes every message with message_delta +
// message_stop. Nothing checked the model against reality, so the suite
// certified the drift.
//
// These tests close that class:
//   - the grammar reduction and invariants are pinned on fixture streams,
//   - the REAL STUB BINARY is spawned against the committed capture
//     (scripts/stream-truth/captured-grammar.json, taken from the real CLI
//     with `npm run stream:truth -- --capture`), and any divergence outside
//     the NAMED known gaps fails with a side-by-side diff,
//   - the pre-0.11.6 stub shape (trailing assistant envelope, no
//     message_delta/message_stop) is reconstructed and PROVEN to fail the
//     diff, so reverting the stub fix can never again pass silently.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const fx = require('../fixtures/stream-json.js');
const {
  reduceToGrammar, normalize, stableGrammar, checkStreamInvariants, diffGrammars, KNOWN_GAPS,
} = require('../../scripts/stream-truth/grammar.js');
const { SCENARIOS } = require('../../scripts/stream-truth/scenarios.js');

const CAPTURE_FILE = path.join(__dirname, '..', '..', 'scripts', 'stream-truth', 'captured-grammar.json');
const STUB = path.join(__dirname, '..', 'helpers', 'stub-claude', 'claude');

// ---------------------------------------------------------------------------
// Reduction and invariants (fixture-level)
// ---------------------------------------------------------------------------

describe('grammar reduction', () => {
  test('envelopes reduce to typed tokens with delta runs collapsed', () => {
    const stream = [
      fx.init('s1'),
      fx.contentBlockStartText(),
      fx.textDelta('he'), fx.textDelta('ll'), fx.textDelta('o'),
      fx.contentBlockStop(),
      fx.messageDelta(), fx.messageStop(),
      fx.result({ text: 'hello' }),
    ];
    assert.deepStrictEqual(reduceToGrammar(stream), [
      'system:init',
      'stream_event:content_block_start(text)',
      'stream_event:content_block_delta(text_delta)',
      'stream_event:content_block_stop',
      'stream_event:message_delta',
      'stream_event:message_stop',
      'result:success',
    ]);
  });

  test('normalisation drops only the NAMED gaps: noise, message_start, thinking spans, per-block assistant envelopes', () => {
    const real = [
      'rate_limit_event', 'system:init', 'system:status',
      'stream_event:message_start',
      'stream_event:content_block_start(thinking)',
      'system:thinking_tokens',
      'stream_event:content_block_delta(thinking_delta)',
      'stream_event:content_block_delta(signature_delta)',
      'assistant[thinking]',
      'stream_event:content_block_stop',
      'stream_event:content_block_start(text)',
      'stream_event:content_block_delta(text_delta)',
      'assistant[text]',
      'stream_event:content_block_stop',
      'stream_event:message_delta', 'stream_event:message_stop',
      'result:success',
    ];
    assert.deepStrictEqual(normalize(real), [
      'system:init',
      'stream_event:content_block_start(text)',
      'stream_event:content_block_delta(text_delta)',
      'stream_event:content_block_stop',
      'stream_event:message_delta',
      'stream_event:message_stop',
      'result:success',
    ]);
  });

  test('tool_result position floats in reality; both observed orderings reduce to one canonical grammar', () => {
    // Observed live on 2.1.227, same probe, two runs: the tool_result user
    // envelope arrived after message close in one and BEFORE it in the other.
    const resultAfterClose = [
      'stream_event:content_block_stop',
      'stream_event:message_delta', 'stream_event:message_stop',
      'user[tool_result]',
      'stream_event:content_block_start(text)',
    ];
    const resultBeforeClose = [
      'stream_event:content_block_stop',
      'user[tool_result]',
      'stream_event:message_delta', 'stream_event:message_stop',
      'stream_event:content_block_start(text)',
    ];
    assert.deepStrictEqual(normalize(resultBeforeClose), normalize(resultAfterClose));
    assert.deepStrictEqual(normalize(resultBeforeClose), [
      'stream_event:content_block_stop',
      'stream_event:message_delta', 'stream_event:message_stop',
      'user[tool_result]',
      'stream_event:content_block_start(text)',
    ]);
  });

  test('every known gap is named with a reason: no silent widening', () => {
    for (const gap of KNOWN_GAPS) {
      assert.ok(gap.name && gap.name.length > 3, 'gap has a name');
      assert.ok(gap.reason && gap.reason.length > 20, `gap "${gap.name}" carries its justification`);
    }
  });
});

describe('stream invariants: the contract the interception engine rests on', () => {
  const GOOD = [
    'system:init',
    'stream_event:content_block_start(text)',
    'stream_event:content_block_delta(text_delta)',
    'assistant[text]',
    'stream_event:content_block_stop',
    'stream_event:message_delta',
    'stream_event:message_stop',
    'result:success',
  ];

  test('the real 2.1.227 shape passes', () => {
    assert.deepStrictEqual(checkStreamInvariants(GOOD), []);
  });

  test('a consolidated assistant envelope AFTER message_stop is a contract break', () => {
    const broken = [...GOOD.slice(0, -1), 'assistant[text]', 'result:success'];
    const errors = checkStreamInvariants(broken);
    assert.ok(errors.some(e => /AFTER the final message_stop/.test(e)), errors.join('; '));
  });

  test('a message that never closes with message_stop is a contract break', () => {
    const broken = GOOD.filter(t => t !== 'stream_event:message_stop' && t !== 'stream_event:message_delta');
    const errors = checkStreamInvariants(broken);
    assert.ok(errors.some(e => /message_stop/.test(e)), errors.join('; '));
  });

  test('result must be the final envelope', () => {
    const broken = [...GOOD, 'system:status'];
    const errors = checkStreamInvariants(broken);
    assert.ok(errors.some(e => /final envelope/.test(e)), errors.join('; '));
  });
});

// ---------------------------------------------------------------------------
// The committed capture
// ---------------------------------------------------------------------------

describe('the committed capture', () => {
  test('exists, names its runtime version, and covers every scenario', () => {
    assert.ok(fs.existsSync(CAPTURE_FILE), 'captured-grammar.json is committed');
    const captured = JSON.parse(fs.readFileSync(CAPTURE_FILE, 'utf8'));
    assert.match(captured.runtimeVersion, /^\d+\.\d+\.\d+$/);
    for (const scenario of SCENARIOS) {
      assert.ok(captured.scenarios[scenario.name], `capture covers "${scenario.name}"`);
    }
  });

  test('the capture itself satisfies the stream invariants', () => {
    const captured = JSON.parse(fs.readFileSync(CAPTURE_FILE, 'utf8'));
    for (const [name, { invariants }] of Object.entries(captured.scenarios)) {
      assert.deepStrictEqual(checkStreamInvariants(invariants), [], `invariants hold for "${name}"`);
    }
  });

  test('keeps what the invariants read, and drops what they do not', () => {
    const captured = JSON.parse(fs.readFileSync(CAPTURE_FILE, 'utf8'));
    for (const [name, { invariants }] of Object.entries(captured.scenarios)) {
      // The tokens every invariant is written against.
      assert.ok(invariants.includes('stream_event:message_stop'), `${name} keeps message_stop`);
      assert.ok(invariants.includes('stream_event:message_delta'), `${name} keeps message_delta`);
      assert.ok(invariants.some(t => t.startsWith('result:')), `${name} keeps the result envelope`);
      // The two non-deterministic sources, which no invariant reads.
      assert.ok(!invariants.includes('rate_limit_event'), `${name} drops transport noise`);
      assert.ok(!invariants.some(t => t.includes('thinking')), `${name} drops thinking spans`);
    }
    // The consolidated assistant envelope is the 0.11.6 shape and the reason
    // this section cannot simply be the normalised grammar, which drops it.
    const tool = captured.scenarios['tool-turn'];
    assert.ok(tool.invariants.some(t => t.startsWith('assistant[')),
      'the tool turn keeps consolidated assistant envelopes');
  });

  test('records the runtime version and capture time, which is what makes the version check fire', () => {
    const captured = JSON.parse(fs.readFileSync(CAPTURE_FILE, 'utf8'));
    assert.match(captured.runtimeVersion, /^\d+\.\d+\.\d+$/);
    assert.match(captured.capturedAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});

// ---------------------------------------------------------------------------
// The churn this section exists to stop
// ---------------------------------------------------------------------------

describe('the stored grammar does not churn on a re-capture', () => {
  // Two runs of the same turn, differing ONLY in the ways a non-deterministic
  // model differs from itself: a different number of thinking deltas, and
  // transport noise arriving somewhere else. Nothing the server reads has
  // moved, so the stored grammar must not move either. Before this, every
  // re-capture produced a diff and the reader learned to skim it.
  // Token shapes are taken from the committed capture, not invented. The
  // reduction keys on the exact strings the reducer emits, so a fixture in a
  // made-up shape would exercise nothing and pass for the wrong reason.
  const runA = [
    'system:init',
    'stream_event:message_start',
    'system:status',
    'stream_event:content_block_start(thinking)',
    'stream_event:content_block_delta(thinking_delta)',
    'stream_event:content_block_delta(thinking_delta)',
    'stream_event:content_block_stop',
    'stream_event:content_block_start(text)',
    'stream_event:content_block_delta(text_delta)',
    'assistant[text]',
    'rate_limit_event',
    'stream_event:content_block_stop',
    'stream_event:message_delta',
    'stream_event:message_stop',
    'result:success',
  ];
  const runB = [
    'system:init',
    'stream_event:message_start',
    'stream_event:content_block_start(thinking)',
    'stream_event:content_block_delta(thinking_delta)',
    'stream_event:content_block_delta(thinking_delta)',
    'stream_event:content_block_delta(thinking_delta)',
    'stream_event:content_block_delta(thinking_delta)',
    'stream_event:content_block_stop',
    'rate_limit_event',
    'stream_event:content_block_start(text)',
    'stream_event:content_block_delta(text_delta)',
    'assistant[text]',
    'system:thinking_tokens',
    'stream_event:content_block_stop',
    'stream_event:message_delta',
    'stream_event:message_stop',
    'result:success',
  ];

  test('two runs differing only in noise reduce to the same grammar', () => {
    assert.deepStrictEqual(stableGrammar(runA), stableGrammar(runB));
  });

  test('and that grammar still satisfies the invariants', () => {
    assert.deepStrictEqual(checkStreamInvariants(stableGrammar(runA)), []);
  });

  test('the reduction is idempotent, so re-applying it changes nothing', () => {
    const once = stableGrammar(runA);
    assert.deepStrictEqual(stableGrammar(once), once);
  });

  test('the guard survives the reduction: a stray assistant envelope after message_stop still fails', () => {
    // The 0.11.6 shape. If reducing the stored grammar had removed the
    // consolidated envelopes, this violation would vanish and the section
    // would be decorative.
    const broken = [...runA, 'assistant[text]'];
    const errors = checkStreamInvariants(stableGrammar(broken));
    assert.ok(errors.some(e => e.includes('AFTER the final message_stop')),
      `expected a stray-envelope violation, got ${JSON.stringify(errors)}`);
  });
});

// ---------------------------------------------------------------------------
// The stub binary vs the capture (the drift alarm)
// ---------------------------------------------------------------------------

// Spawn the real stub binary exactly as the harness does and reduce its output.
function runStub(scenario) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-truth-test-'));
    fs.writeFileSync(path.join(dir, 'stub-scenario.json'), JSON.stringify({ rules: [scenario.stubRule] }));
    const proc = spawn(STUB, [
      '--print', '--model', 'haiku',
      '--output-format', 'stream-json', '--input-format', 'stream-json',
      '--verbose', '--include-partial-messages',
    ], { cwd: dir, stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    proc.stdout.on('data', d => { out += d; });
    proc.on('error', reject);
    proc.on('close', () => {
      fs.rmSync(dir, { recursive: true, force: true });
      resolve(out);
    });
    proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: scenario.prompt } }) + '\n');
    proc.stdin.end();
  });
}

describe('the stub binary matches the captured runtime', () => {
  const captured = fs.existsSync(CAPTURE_FILE) ? JSON.parse(fs.readFileSync(CAPTURE_FILE, 'utf8')) : null;

  for (const scenario of SCENARIOS) {
    test(`"${scenario.name}": stub grammar equals the capture (known gaps applied)`, async () => {
      assert.ok(captured, 'captured-grammar.json missing');
      const actual = normalize(reduceToGrammar(await runStub(scenario)));
      const diff = diffGrammars(captured.scenarios[scenario.name].normalized, actual);
      assert.strictEqual(diff, null, diff ? `stub diverges from runtime ${captured.runtimeVersion}:\n${diff}` : undefined);
    });
  }

  test('the pre-0.11.6 stub shape FAILS the diff: reverting the fix cannot pass silently', () => {
    assert.ok(captured, 'captured-grammar.json missing');
    // fx.textTurn is the legacy shape: trailing consolidated assistant
    // envelope, NO message_delta, NO message_stop. Exactly what the stub
    // emitted before the 0.11.6 fix.
    const legacy = normalize(reduceToGrammar([fx.init('s1'), ...fx.textTurn('OK')]));
    const diff = diffGrammars(captured.scenarios['text-turn'].normalized, legacy);
    assert.ok(diff, 'the legacy end-of-message shape must diverge from the captured runtime');
    assert.match(diff, /DIVERGES/);
  });
});
