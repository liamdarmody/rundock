'use strict';
// Single resolver for the delegation handoff markers.
//
// Six sites in server.js used to re-implement this scan by hand: the delegate
// onResult, the respawned-agent onResult, the restored-parent onResult, the
// direct-start onResult, the delegate close tail-scan, and the Codex delegate
// done handler. Each re-stated the precedence rule independently, which is
// how a precedence inversion shipped on one of them (the direct-start path
// treated both-markers as RETURN until 0.11.x). One implementation makes the
// rule impossible to copy wrong.
//
// The markers are HTML comments so they never render in a chat bubble:
//   <!-- RUNDOCK:RETURN -->    the agent is handing back out-of-scope work
//   <!-- RUNDOCK:COMPLETE -->  the delegated pipeline finished end-to-end
//
// COMPLETE beats RETURN when both are present: a specialist that finished the
// pipeline AND mentioned scope is done, not lost, and routing it as a scope
// return would re-delegate finished work.

const RETURN_RE = /<!-- RUNDOCK:RETURN -->/;
const COMPLETE_RE = /<!-- RUNDOCK:COMPLETE -->/;
// Platform-delegate CRUD markers (agent/skill save and delete). A platform
// delegate that emitted one did real work, so its turn auto-returns even
// without a handoff marker.
const CRUD_RE = /<!-- RUNDOCK:(?:SAVE|CREATE)_AGENT|<!-- RUNDOCK:DELETE_AGENT|<!-- RUNDOCK:SAVE_SKILL|<!-- RUNDOCK:DELETE_SKILL/;

/**
 * Scan a turn's text for delegation handoff markers.
 * @param {string} text - The turn's accumulated response text.
 * @returns {{ hasReturn: boolean, hasComplete: boolean, hasCrudMarker: boolean,
 *             mode: 'complete'|'return'|null }}
 *   mode applies the precedence rule; null when no handoff marker is present.
 */
function resolveMarkers(text) {
  const t = text || '';
  const hasReturn = RETURN_RE.test(t);
  const hasComplete = COMPLETE_RE.test(t);
  return {
    hasReturn,
    hasComplete,
    hasCrudMarker: CRUD_RE.test(t),
    mode: hasComplete ? 'complete' : (hasReturn ? 'return' : null),
  };
}

module.exports = { resolveMarkers };
