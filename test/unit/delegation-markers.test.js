'use strict';
// The single marker resolver. Every scan site in server.js delegates to this,
// so the precedence rule lives (and is tested) exactly once.
const { test, describe } = require('node:test');
const assert = require('node:assert');

const { resolveMarkers } = require('../../lib/delegation/markers.js');

describe('resolveMarkers', () => {
  test('RETURN alone resolves to return mode', () => {
    const r = resolveMarkers('Handing back. <!-- RUNDOCK:RETURN -->');
    assert.strictEqual(r.mode, 'return');
    assert.strictEqual(r.hasReturn, true);
    assert.strictEqual(r.hasComplete, false);
  });

  test('COMPLETE alone resolves to complete mode', () => {
    const r = resolveMarkers('All done. <!-- RUNDOCK:COMPLETE -->');
    assert.strictEqual(r.mode, 'complete');
    assert.strictEqual(r.hasComplete, true);
  });

  test('COMPLETE beats RETURN when both are present', () => {
    // The precedence rule that was once hand-copied six times and inverted
    // on one of them: a specialist that finished the pipeline and mentioned
    // scope is done, not lost.
    const r = resolveMarkers('Done. <!-- RUNDOCK:RETURN --> <!-- RUNDOCK:COMPLETE -->');
    assert.strictEqual(r.mode, 'complete');
    assert.strictEqual(r.hasReturn, true);
    assert.strictEqual(r.hasComplete, true);
  });

  test('no markers resolves to null mode', () => {
    const r = resolveMarkers('Just a normal turn.');
    assert.strictEqual(r.mode, null);
    assert.strictEqual(r.hasReturn, false);
    assert.strictEqual(r.hasComplete, false);
    assert.strictEqual(r.hasCrudMarker, false);
  });

  test('empty and missing text resolve safely', () => {
    assert.strictEqual(resolveMarkers('').mode, null);
    assert.strictEqual(resolveMarkers(null).mode, null);
    assert.strictEqual(resolveMarkers(undefined).mode, null);
  });

  test('platform CRUD markers are detected, including the legacy CREATE alias', () => {
    assert.strictEqual(resolveMarkers('<!-- RUNDOCK:SAVE_AGENT name=x -->').hasCrudMarker, true);
    assert.strictEqual(resolveMarkers('<!-- RUNDOCK:CREATE_AGENT name=x -->').hasCrudMarker, true);
    assert.strictEqual(resolveMarkers('<!-- RUNDOCK:DELETE_AGENT name=x -->').hasCrudMarker, true);
    assert.strictEqual(resolveMarkers('<!-- RUNDOCK:SAVE_SKILL name=x -->').hasCrudMarker, true);
    assert.strictEqual(resolveMarkers('<!-- RUNDOCK:DELETE_SKILL name=x -->').hasCrudMarker, true);
    assert.strictEqual(resolveMarkers('<!-- RUNDOCK:SAVE_AGENT name=x -->').mode, null, 'CRUD alone is not a handoff');
  });
});
