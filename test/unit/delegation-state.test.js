'use strict';
// The delegation record: the single owner of a delegation's durable state.
// Entries are views over it (attachDelegationRecord), so existing call sites
// keep reading and writing entry fields while the record holds the data.
const { test, describe } = require('node:test');
const assert = require('node:assert');

const { createDelegationRecord, attachDelegationRecord, RECORD_FIELDS } = require('../../lib/delegation/state.js');

describe('createDelegationRecord', () => {
  test('defaults: empty turn log, fresh timestamp, no markers or deferred targets', () => {
    const r = createDelegationRecord();
    assert.deepStrictEqual(r.deliveredTurns, []);
    assert.ok(typeof r.delegationStartedAt === 'string' && r.delegationStartedAt.includes('T'), 'ISO timestamp');
    assert.strictEqual(r.deferredTargets, null);
    assert.strictEqual(r.returnMarkerSeen, null);
    assert.strictEqual(r.scopeReturnSource, null);
  });

  test('seed values are taken over defaults', () => {
    const r = createDelegationRecord({ deferredTargets: ['lead-designer'], scopeReturnSource: 'content-analyst' });
    assert.deepStrictEqual(r.deferredTargets, ['lead-designer']);
    assert.strictEqual(r.scopeReturnSource, 'content-analyst');
  });
});

describe('attachDelegationRecord', () => {
  test('entry reads and writes pass through to the record', () => {
    const record = createDelegationRecord();
    const entry = attachDelegationRecord({ agentId: 'content-analyst' }, record);

    entry.deliveredTurns.push('turn one');
    entry.finalResponseText = 'turn one';
    entry.returnMarkerSeen = 'complete';

    assert.deepStrictEqual(record.deliveredTurns, ['turn one'], 'writes land on the record');
    assert.strictEqual(record.finalResponseText, 'turn one');
    assert.strictEqual(record.returnMarkerSeen, 'complete');
    assert.strictEqual(entry.returnMarkerSeen, 'complete', 'reads come from the record');
    assert.strictEqual(entry.delegationRecord, record, 'record reachable directly for new code');
  });

  test('every owned field is proxied, so the field list cannot drift from the accessors', () => {
    const record = createDelegationRecord();
    const entry = attachDelegationRecord({}, record);
    for (const field of RECORD_FIELDS) {
      const sentinel = `sentinel-${field}`;
      entry[field] = sentinel;
      assert.strictEqual(record[field], sentinel, `${field} write passes through`);
      assert.strictEqual(entry[field], sentinel, `${field} read passes through`);
    }
  });

  test('a plain entry without a record still accepts the same fields (compatibility path)', () => {
    // wireProcessHandlers guards its pushes with `if (e.deliveredTurns)`, and
    // handler-level tests build bare entries. Nothing may require the record.
    const bare = { agentId: 'x' };
    bare.finalResponseText = 'text';
    assert.strictEqual(bare.finalResponseText, 'text');
    assert.strictEqual(bare.deliveredTurns, undefined);
  });
});
