'use strict';
// The road from a record on disk to the screen, driven against real files in a
// real workspace.
//
// WHAT THIS FILE IS GUARDING. The record store went to trouble to keep an
// unknown file list (`files: null` and a named reason) apart from an empty one
// (`files: []` and a claim of 'known'). Everything between the disk and the
// reader has to carry that through untouched, and a transport is the easiest
// place in the whole path to lose it: a handler that rebuilds the record field
// by field, or normalises it "for the client", writes `files: record.files ||
// []` on the way past and nothing anywhere goes red.
//
// So this drives records of both kinds through the handler and asserts the
// wire carries the two shapes apart, then asserts the record reaches the wire
// whole rather than rebuilt.
//
// THE WORKSPACE IS CONSTRUCTED, never inherited. Every record below is written
// into a temp workspace this file makes and the config is restored afterwards,
// so nothing here depends on which workspace happens to be open.
process.env.TZ = 'Europe/London';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const config = require('../../lib/config.js');
const runs = require('../../lib/protocol/handlers/runs.js');
const scheduler = require('../../lib/scheduler.js');
const { buildDispatch } = require('../../lib/protocol/handlers/index.js');
const { makeTempDir } = require('../helpers/workspace.js');

/** A socket that keeps what was sent to it, parsed. */
function socket() {
  const sent = [];
  return { sent, send: (raw) => sent.push(JSON.parse(raw)) };
}

const KNOWN = {
  id: 'run-known', agent: 'default', routine: 'Hello World', sessionId: 's1',
  status: 'succeeded', startedAt: '2026-08-24T00:30:32.036Z', endedAt: '2026-08-24T00:30:45.199Z',
  durationMs: 13163, error: null,
  files: [{ path: '/w/a.md', tool: 'Write', change: 'created', at: '2026-08-24T00:30:43.206Z', source: 'transcript' }],
  filesStatus: 'known', filesReason: null,
};

const CHANGED_NOTHING = { ...KNOWN, id: 'run-empty', files: [], filesStatus: 'known', filesReason: null };

const UNKNOWN = { ...KNOWN, id: 'run-unknown', files: null, filesStatus: 'unknown', filesReason: 'no-transcript' };

/**
 * Drive the handler against an enumeration THIS TEST states, in a stated order.
 *
 * WHY THE ORDER IS STUBBED RATHER THAN WRITTEN TO DISK. Directory enumeration
 * is a function of the FILENAMES, so writing the same two files in a different
 * order enumerates identically both times. A test that varied only the write
 * order would therefore pass against a resolver that returned whichever record
 * came first, which is the whole property it claims to check.
 */
function withReader(records, body) {
  const real = scheduler.readRunRecords;
  scheduler.readRunRecords = () => records;
  try { return body(); } finally { scheduler.readRunRecords = real; }
}

/** A workspace holding exactly these records. Restores the config afterwards. */
function withRecords(records, body) {
  const dir = makeTempDir('rundock-runs-');
  const runsDir = path.join(dir, '.rundock', 'runs');
  fs.mkdirSync(runsDir, { recursive: true });
  for (const record of records) {
    fs.writeFileSync(path.join(runsDir, `${record.id}.json`), JSON.stringify(record, null, 2));
  }
  const previous = config.getWorkspace();
  config.setWorkspace(dir);
  try { return body(dir); } finally { config.setWorkspace(previous); }
}

describe('a run record reaches the client', () => {
  test('a run asked for by id comes back', () => {
    withRecords([KNOWN, UNKNOWN], () => {
      const ws = socket();
      runs.handleGetRun({}, ws, { type: 'get_run', runId: 'run-known' });
      assert.strictEqual(ws.sent.length, 1);
      assert.strictEqual(ws.sent[0].type, 'run');
      assert.strictEqual(ws.sent[0].run.id, 'run-known');
    });
  });

  test('the newest run of a routine comes back, in whichever order the reader hands them over', () => {
    const older = { ...KNOWN, id: 'run-older', startedAt: '2026-08-20T00:00:00.000Z' };
    const newer = { ...KNOWN, id: 'run-newer', startedAt: '2026-08-24T00:00:00.000Z' };
    // BOTH ORDERS ARE ACTUALLY DIFFERENT, which is the point. An earlier
    // version of this test wrote the two files in two orders and asserted the
    // same thing twice: the names were identical in both arrangements, so both
    // enumerated the same way and neither arrangement ever put the older
    // record first. It could not have failed.
    for (const order of [[older, newer], [newer, older]]) {
      withReader(order, () => {
        const ws = socket();
        runs.handleGetRun({}, ws, { type: 'get_run', agentId: 'default', routine: 'Hello World' });
        assert.strictEqual(ws.sent[0].run.id, 'run-newer',
          `the first record the reader handed over was taken rather than the newest, `
          + `with the reader ordered ${order.map(r => r.id).join(' then ')}`);
      });
    }
  });

  test('a record the reader would refuse never reaches the resolver', () => {
    // THE REASON THE RESOLVER MAY DEREFERENCE A RECORD WITHOUT GUARDING, driven
    // as real files rather than asserted in prose. readRunRecords admits a
    // parsed file only when it is an object carrying a string id. Each file
    // below would, if it got through, be dereferenced by the filter and throw
    // before anything was sent, and a handler that throws before replying
    // leaves the screen waiting forever.
    withRecords([KNOWN], (dir) => {
      const runsDir = path.join(dir, '.rundock', 'runs');
      fs.writeFileSync(path.join(runsDir, 'a-null.json'), 'null');
      fs.writeFileSync(path.join(runsDir, 'b-half-written.json'), '{"id": "trunc"');
      // A later start than the real record, so a resolver that saw it would
      // return it and the id below would be undefined.
      fs.writeFileSync(path.join(runsDir, 'c-no-id.json'), JSON.stringify(
        { agent: 'default', routine: 'Hello World', startedAt: '2027-01-01T00:00:00.000Z' }));
      const ws = socket();
      runs.handleGetRun({}, ws, { type: 'get_run', agentId: 'default', routine: 'Hello World' });
      assert.strictEqual(ws.sent.length, 1,
        'the handler threw before replying, so the screen would wait forever');
      assert.strictEqual(ws.sent[0].run.id, 'run-known');
    });
  });

  test('a routine with no runs answers with no record, not with an invented one', () => {
    withRecords([KNOWN], () => {
      const ws = socket();
      runs.handleGetRun({}, ws, { type: 'get_run', agentId: 'default', routine: 'Never Run' });
      assert.strictEqual(ws.sent[0].type, 'run');
      assert.strictEqual(ws.sent[0].run, null);
    });
  });

  test('the run belongs to the routine that was asked about', () => {
    const other = { ...KNOWN, id: 'run-other', agent: 'piper', routine: 'Something Else' };
    withRecords([other], () => {
      const ws = socket();
      runs.handleGetRun({}, ws, { type: 'get_run', agentId: 'default', routine: 'Hello World' });
      assert.strictEqual(ws.sent[0].run, null,
        'a routine with no runs was answered with another routine\'s run');
    });
  });
});

describe('the transport keeps unknown and empty apart', () => {
  test('a null file list crosses the wire as null', () => {
    withRecords([UNKNOWN], () => {
      const ws = socket();
      runs.handleGetRun({}, ws, { type: 'get_run', runId: 'run-unknown' });
      const run = ws.sent[0].run;
      assert.strictEqual(run.files, null,
        'the transport turned an unknown file list into an empty one, which is permanent');
      assert.strictEqual(run.filesStatus, 'unknown');
      assert.strictEqual(run.filesReason, 'no-transcript');
    });
  });

  test('an empty file list crosses the wire as empty, and the two arrive different', () => {
    withRecords([CHANGED_NOTHING, UNKNOWN], () => {
      const empty = socket();
      const unknown = socket();
      runs.handleGetRun({}, empty, { type: 'get_run', runId: 'run-empty' });
      runs.handleGetRun({}, unknown, { type: 'get_run', runId: 'run-unknown' });
      assert.deepStrictEqual(empty.sent[0].run.files, []);
      assert.strictEqual(unknown.sent[0].run.files, null);
      assert.notDeepStrictEqual(empty.sent[0].run.files, unknown.sent[0].run.files);
    });
  });

  test('the record reaches the wire whole rather than rebuilt from named fields', () => {
    // A handler that names the fields it forwards silently drops anything a
    // later writer adds, and this store's whole reason for existing is that
    // the write and the read can happen in different versions.
    const withExtra = { ...KNOWN, id: 'run-extra', somethingAddedLater: 'kept' };
    withRecords([withExtra], () => {
      const ws = socket();
      runs.handleGetRun({}, ws, { type: 'get_run', runId: 'run-extra' });
      assert.deepStrictEqual(ws.sent[0].run, withExtra);
    });
  });
});

describe('the request is answered even when it cannot be met', () => {
  test('a request naming nothing is answered rather than dropped', () => {
    withRecords([KNOWN], () => {
      const ws = socket();
      runs.handleGetRun({}, ws, { type: 'get_run' });
      assert.strictEqual(ws.sent.length, 1, 'a malformed request left the screen waiting forever');
      assert.strictEqual(ws.sent[0].run, null);
    });
  });

  test('a workspace with no runs directory is answered rather than thrown at', () => {
    const dir = makeTempDir('rundock-runs-none-');
    const previous = config.getWorkspace();
    config.setWorkspace(dir);
    try {
      const ws = socket();
      runs.handleGetRun({}, ws, { type: 'get_run', runId: 'run-known' });
      assert.strictEqual(ws.sent[0].run, null);
    } finally { config.setWorkspace(previous); }
  });

  test('the reply names what was asked for, so a late answer cannot land on another routine', () => {
    withRecords([KNOWN], () => {
      const ws = socket();
      runs.handleGetRun({}, ws, { type: 'get_run', agentId: 'default', routine: 'Hello World' });
      assert.strictEqual(ws.sent[0].agentId, 'default');
      assert.strictEqual(ws.sent[0].routine, 'Hello World');
    });
  });
});

describe('the handler is wired into the protocol', () => {
  test('get_run is a message the server answers', () => {
    assert.strictEqual(buildDispatch().get_run, runs.handleGetRun,
      'the handler exists and nothing routes to it, so the screen would never receive a reply');
  });
});
