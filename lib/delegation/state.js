'use strict';
// The delegation record: single owner of a delegation's durable state.
//
// Process entries die and respawn constantly by design (kill-and-respawn is
// how agent handoffs work), so state that must outlive a turn was smeared
// across entries as ad-hoc fields and hand-threaded over every spawn
// boundary. That absence of an owner is the root cause the handback spec
// documents: per-turn payload loss, duplicated marker scans, a staleness
// flag nobody cleared. The record now owns those fields.
//
// Entries remain the view the rest of server.js reads and writes:
// attachDelegationRecord exposes the record's fields as entry properties, so
// every existing call site keeps working while the record is the one place
// the data lives. New code should take the record directly
// (entry.delegationRecord). NOTE the naming split that already existed:
// entry.delegation is the parent LINKAGE (who to restore on close);
// entry.delegationRecord is this delegation's durable state.

// Fields the record owns. One list, shared by create and attach, so the two
// can never drift. The const assertion makes this list the checker-enforced
// source of the DelegationRecord field set: types.d.ts derives its
// DelegationRecordField type from it and asserts set-equality with the
// DelegationRecord interface keys, so adding, removing, or misspelling a
// field on either side fails tsc.
const RECORD_FIELDS = /** @type {const} */ ([
  'deliveredTurns',      // every turn's text, accumulated for the handback
  'delegationStartedAt', // ISO timestamp bounding the transcript fallback
  'deferredTargets',     // Agent calls from the delegating turn that were not run
  'returnMarkerSeen',    // 'complete' | 'return' | null, set by the marker scan
  'finalResponseText',   // last turn's text, retained for marker detection
  'scopeReturnSource',   // agent whose out-of-scope return produced this entry
]);

/**
 * Create a delegation record.
 * @param {Partial<DelegationRecord>} [seed] - Initial values; unspecified fields get defaults.
 * @returns {DelegationRecord}
 */
function createDelegationRecord(seed = {}) {
  return {
    deliveredTurns: seed.deliveredTurns || [],
    delegationStartedAt: seed.delegationStartedAt || new Date().toISOString(),
    deferredTargets: seed.deferredTargets || null,
    returnMarkerSeen: seed.returnMarkerSeen || null,
    finalResponseText: seed.finalResponseText !== undefined ? seed.finalResponseText : undefined,
    scopeReturnSource: seed.scopeReturnSource || null,
  };
}

/**
 * Attach a record to a process entry, exposing the record's fields as entry
 * properties (reads and writes pass through). Returns the entry.
 *
 * The pass-through views are explicit typed defineProperty accessors rather
 * than inferred: the entry parameter deliberately admits partially-built
 * entries (spawn sites attach the record before the entry is complete).
 *
 * @template {Partial<ProcessEntry> & object} T
 * @param {T} entry
 * @param {DelegationRecord} record
 * @returns {T}
 */
function attachDelegationRecord(entry, record) {
  entry.delegationRecord = record;
  for (const field of RECORD_FIELDS) {
    Object.defineProperty(entry, field, {
      get() { return record[field]; },
      set(v) { record[field] = v; },
      enumerable: true,
      configurable: true,
    });
  }
  return entry;
}

module.exports = { createDelegationRecord, attachDelegationRecord, RECORD_FIELDS };
