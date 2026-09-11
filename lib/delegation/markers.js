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
//   <!-- RUNDOCK:CONTINUE -->  this agent's part is done, the request is not
//
// WHY THERE IS A THIRD. COMPLETE used to carry two meanings: "the work is
// finished, do not parrot it back" and "my part is finished, something still
// needs to happen". The first wants the orchestrator silent, the second wants
// it to act, and one marker cannot ask for both. Observed: a specialist
// finished her research, wrote "passing this back to you to route to Vox for
// the redraft", and emitted COMPLETE. The orchestrator was handed a prompt
// ordering it to say exactly <silent> and stop. It obeyed. The user's request
// was never carried out and the conversation stopped with no error.
//
// PRECEDENCE: CONTINUE, then COMPLETE, then RETURN.
//
// CONTINUE wins because the two failure directions are not symmetric. Treating
// a genuine CONTINUE as COMPLETE strands the request in silence, which is what
// this marker exists to stop. Treating a stray COMPLETE as CONTINUE costs one
// orchestrator turn that decides there is nothing left to do. A wasted turn is
// recoverable; a dead conversation is not, because nothing tells the user it
// happened.
//
// COMPLETE still beats RETURN: a specialist that finished the pipeline AND
// mentioned scope is done, not lost, and routing it as a scope return would
// re-delegate finished work.

const RETURN_RE = /<!-- RUNDOCK:RETURN -->/;
const COMPLETE_RE = /<!-- RUNDOCK:COMPLETE -->/;
const CONTINUE_RE = /<!-- RUNDOCK:CONTINUE -->/;
// Platform-delegate CRUD markers (agent/skill save and delete). A platform
// delegate that emitted one did real work, so its turn auto-returns even
// without a handoff marker.
const CRUD_RE = /<!-- RUNDOCK:(?:SAVE|CREATE)_AGENT|<!-- RUNDOCK:DELETE_AGENT|<!-- RUNDOCK:SAVE_SKILL|<!-- RUNDOCK:DELETE_SKILL/;

/**
 * Scan a turn's text for delegation handoff markers.
 * @param {string} text - The turn's accumulated response text.
 * @returns {{ hasReturn: boolean, hasComplete: boolean, hasContinue: boolean,
 *             hasCrudMarker: boolean,
 *             mode: 'continue'|'complete'|'return'|null }}
 *   mode applies the precedence rule; null when no handoff marker is present.
 */
function resolveMarkers(text) {
  const t = text || '';
  const hasReturn = RETURN_RE.test(t);
  const hasComplete = COMPLETE_RE.test(t);
  const hasContinue = CONTINUE_RE.test(t);
  return {
    hasReturn,
    hasComplete,
    hasContinue,
    hasCrudMarker: CRUD_RE.test(t),
    mode: hasContinue ? 'continue'
      : (hasComplete ? 'complete' : (hasReturn ? 'return' : null)),
  };
}

/**
 * Record a handoff marker on a process entry, if its turn carried one.
 *
 * ONE PLACE, BECAUSE THREE PLACES DRIFTED. Four sites consumed markers and
 * three of them wrote this same block by hand. Two read the raw booleans and
 * rebuilt precedence themselves, so when CONTINUE was added they kept working
 * and silently ignored it: a specialist declaring "my part is done, something
 * must happen next" produced no action at all, which is the very defect the
 * marker was introduced to fix. The resolver already computes `mode` with
 * precedence applied; every consumer now takes that rather than deriving it.
 *
 * A caller passes `onMarked` to log and schedule its own kill, because those
 * differ by site. What must not differ is which markers count and what wins.
 *
 * @param {{delegation?: any, scopeReturn?: boolean, scopeReturnMode?: string}|null} entry
 *   the process entry whose turn just ended.
 * @param {string} text the turn's accumulated response text.
 * @param {(mode: 'continue'|'complete'|'return') => void} [onMarked] runs only
 *   when a marker was recorded, for the logging and kill scheduling that differ
 *   by site.
 * @returns {'continue'|'complete'|'return'|null} the mode recorded, or null.
 */
function noteHandoffMarker(entry, text, onMarked) {
  const { mode } = resolveMarkers(text);
  // A turn that is itself a delegation is not a handback.
  if (!mode || !entry || entry.delegation) return null;
  entry.scopeReturn = true;
  entry.scopeReturnMode = mode;
  if (typeof onMarked === 'function') onMarked(mode);
  return mode;
}

/** Every mode the resolver can return, so a lister cannot omit one by hand. */
const HANDOFF_MODES = ['continue', 'complete', 'return'];

/** The marker text a specialist writes for each mode, so nothing hand-copies it. */
const MARKER_TEXT = {
  return: '<!-- RUNDOCK:RETURN -->',
  complete: '<!-- RUNDOCK:COMPLETE -->',
  continue: '<!-- RUNDOCK:CONTINUE -->'
};

module.exports = { resolveMarkers, MARKER_TEXT, HANDOFF_MODES, noteHandoffMarker };
