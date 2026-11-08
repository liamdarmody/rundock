'use strict';
// What a test reads back from the logs the stub runtimes append to.
//
// Each stub writes one JSON record per line with appendFileSync, from its own
// process, while the test polls the same file. A poll can therefore land after
// part of a line is on disk and before the rest, and a reader that parses every
// line throws on that last one. That is what failed the single-flight test on a
// loaded CI runner: "Unterminated string in JSON at position 422", one record
// cut part way through and passed straight to JSON.parse.
//
// The contention is driven here, by writing half a record and reading it,
// rather than staged inside the test that flaked: a race arranged there would
// still need timing to land, which is the fault being removed. Every reader of
// these logs goes through one function, and the inventory at the end holds the
// rest of test/ to that.
//
// Booted, because the harness readers read the workspace the server was booted
// on and nothing else sets it.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../helpers/harness.js');

before(async () => { await h.boot(); });
after(async () => { await h.shutdown(); });

// Each log a stub appends to, and the harness function a test reads it with.
const LOGS = [
  ['stub-invocations.jsonl', () => h.readInvocations()],
  ['stub-prompts.jsonl', () => h.readPrompts()],
  ['stub-output.jsonl', () => h.readStubOutputs()],
  ['stub-grandchildren.jsonl', () => h.readGrandchildren()],
  ['stub-hook-answers.jsonl', () => h.readHookAnswers()],
];

// A record shaped like the stub's invocation line, with a prompt long enough
// that a cut at 422 characters lands inside a string, as the CI one did.
function record(n) {
  return {
    pid: 40000 + n, ts: 1790000000000 + n, agent: 'slow', model: null, resume: null, print: true,
    argv: ['--print', '--output-format', 'stream-json', '--verbose', '--agent', 'slow',
      `slow body ${'and the routine goes on describing its work '.repeat(12)}${n}`],
    env: { RUNDOCK: '1', RUNDOCK_CONVO_ID: null, RUNDOCK_CODE_MODE: null, RUNDOCK_PORT: '4100', RUNDOCK_HOOK_TOKEN: null },
  };
}
const line = (value) => JSON.stringify(value) + '\n';
const CUT = 422;

function fresh(name) {
  const file = path.join(h.workspaceDir, name);
  fs.rmSync(file, { force: true });
  return file;
}

test('a record still being appended is left out, and read once it is whole', () => {
  for (const [name, read] of LOGS) {
    const file = fresh(name);
    const second = line(record(2));
    assert.ok(second.length > CUT + 100, 'sanity: the cut falls inside the record');
    fs.writeFileSync(file, line(record(1)));
    fs.appendFileSync(file, second.slice(0, CUT));

    let seen;
    assert.doesNotThrow(() => { seen = read(); }, `${name}: the reader threw on a record still being appended`);
    assert.deepStrictEqual(seen, [record(1)], `${name}: the half record was returned, or the whole one before it lost`);

    // The rest of the append lands, and the next poll reads it.
    fs.appendFileSync(file, second.slice(CUT));
    assert.deepStrictEqual(read(), [record(1), record(2)], `${name}: the record was not read once whole`);
    fs.rmSync(file, { force: true });
  }
});

test('a complete line that does not parse makes the reader throw, naming the file and the line', () => {
  for (const [name, read] of LOGS) {
    const file = fresh(name);
    fs.writeFileSync(file, line(record(1)) + '{"pid": 2,, "agent": "slow"}\n' + line(record(3)));
    assert.throws(read, (err) => {
      assert.ok(String(err.message).includes(file), `${name}: the error does not name the file: ${err.message}`);
      assert.match(String(err.message), /\bline 2\b/, `${name}: the error does not name the line: ${err.message}`);
      return true;
    });
    fs.rmSync(file, { force: true });
  }
});

// THE INVENTORY. Every file under test/ that names one of these logs, read for
// a split on newlines followed by a JSON.parse: a reader of its own, which
// would throw on a record still being appended. This file is left out because
// it names the logs and the pattern to say what it looks for.
const LOG_NAMES = LOGS.map(([name]) => name);
const NEWLINE_SPLIT = /\.split\(\s*(?:(['"`])(?:\\r)?\\n\1|\/(?:\\r\??)?\\n\/[a-z]*)\s*\)/g;

function filesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') out.push(...filesUnder(full)); continue; }
    if (entry.isFile()) out.push(full);
  }
  return out;
}

test('every reader of a stub log goes through the harness function', () => {
  // The pattern finds each shape a line by line reader has taken in this tree.
  for (const specimen of [
    "fs.readFileSync(file, 'utf-8').split('\\n').filter(Boolean).map(l => JSON.parse(l))",
    'raw.trim().split("\\n").map(JSON.parse)',
    'for (const l of text.split(/\\r?\\n/)) out.push(JSON.parse(l))',
  ]) {
    assert.strictEqual([...specimen.matchAll(NEWLINE_SPLIT)].length, 1, `the pattern misses a reader: ${specimen}`);
  }
  const testDir = path.join(__dirname, '..');
  const own = [];
  let naming = 0;
  for (const file of filesUnder(testDir)) {
    if (file === __filename) continue;
    const src = fs.readFileSync(file);
    if (src.includes(0)) continue; // a binary fixture
    const text = src.toString('utf8');
    if (!LOG_NAMES.some((name) => text.includes(name))) continue;
    naming++;
    for (const m of text.matchAll(NEWLINE_SPLIT)) {
      if (text.slice(m.index, m.index + 300).includes('JSON.parse')) {
        const at = text.slice(0, m.index).split('\n').length;
        own.push(`${path.relative(testDir, file)}:${at}`);
      }
    }
  }
  assert.ok(naming >= 4, `sanity: the logs are named in ${naming} files`);
  assert.deepStrictEqual(own, [], 'these files parse a stub log line by line themselves, so a record still being appended throws');
});
