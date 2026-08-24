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

  test('the newest run of a routine comes back, whatever order the disk lists them in', () => {
    const older = { ...KNOWN, id: 'run-older', startedAt: '2026-08-20T00:00:00.000Z' };
    const newer = { ...KNOWN, id: 'run-newer', startedAt: '2026-08-24T00:00:00.000Z' };
    // Written oldest last, because a directory listing has an order that
    // belongs to the filesystem and the reader promises none.
    withRecords([newer, older], () => {
      const ws = socket();
      runs.handleGetRun({}, ws, { type: 'get_run', agentId: 'default', routine: 'Hello World' });
      assert.strictEqual(ws.sent[0].run.id, 'run-newer');
    });
    withRecords([older, newer], () => {
      const ws = socket();
      runs.handleGetRun({}, ws, { type: 'get_run', agentId: 'default', routine: 'Hello World' });
      assert.strictEqual(ws.sent[0].run.id, 'run-newer');
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
