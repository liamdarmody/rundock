'use strict';
// Seam pins for lib/delegation/engine.js (slice 10). The engine module is a
// single-composition factory: the server's composition root calls
// createDelegationEngine(deps) once and re-exports the returned singletons
// through _internal by identity. These tests pin the frozen deps surface,
// the module's export shape, the root's shim-and-compose structure, and the
// factory's behaviour on a FRESH module copy (require-cache swap) so they
// can never clobber the composition the rest of the suite runs against.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const ENGINE_PATH = path.join(ROOT, 'lib', 'delegation', 'engine.js');
const engineLib = require(ENGINE_PATH);
const { _internal: srv } = require(path.join(ROOT, 'server.js'));

// The deps surface is FROZEN: root-owned capabilities only. Growing this
// list is a deliberate act (new root capability crossing the seam); anything
// lib-reachable must be required directly by the engine instead.
const EXPECTED_DEPS = [
  'MAX_CONSECUTIVE_AGENT_RESUMES', 'RESTORE_DELAY_MS', 'appendTranscript',
  'beginConvoTransition', 'bufferedFollowUpTakesOver', 'buildHandbackPayload',
  'endConvoTransition', 'formatTranscript', 'getAllowedToolsInteractive',
  'getDisallowedTools', 'getPermissionMode', 'handleChatSpawnError',
  'incrementAutoResume', 'isAuthError', 'isModelError', 'isSilentParkResponse',
  'noteClaudeAuthEvidence', 'processes', 'resetAutoResume', 'safeSend',
  'scheduleScopeReturnKill', 'sendAuthError', 'sendModelError',
  'stopEntryProcess',
];

// Load a FRESH copy of the engine module so composing it with stubs cannot
// rebind the singleton composition the live server (and the whole suite)
// uses. The cached entry is restored afterwards.
function freshEngine() {
  const resolved = require.resolve(ENGINE_PATH);
  const cached = require.cache[resolved];
  delete require.cache[resolved];
  const fresh = require(ENGINE_PATH);
  require.cache[resolved] = cached;
  return fresh;
}

function stubDeps() {
  const deps = {};
  for (const name of EXPECTED_DEPS) deps[name] = () => {};
  deps.processes = new Map();
  deps.MAX_CONSECUTIVE_AGENT_RESUMES = 3;
  deps.RESTORE_DELAY_MS = 0;
  return deps;
}

describe('engine module shape', () => {
  test('exports exactly the factory and its frozen deps list', () => {
    assert.deepStrictEqual(Object.keys(engineLib).sort(), ['DEP_NAMES', 'createDelegationEngine']);
    assert.deepStrictEqual([...engineLib.DEP_NAMES].sort(), [...EXPECTED_DEPS].sort(),
      'the deps surface is frozen; growing it is a deliberate seam change');
    assert.deepStrictEqual(engineLib.DEP_NAMES, EXPECTED_DEPS,
      'DEP_NAMES stays sorted so diffs to the seam read cleanly');
  });

  test('the factory returns the four engine functions and rejects missing deps', () => {
    const fresh = freshEngine();
    const engine = fresh.createDelegationEngine(stubDeps());
    assert.deepStrictEqual(Object.keys(engine).sort(),
      ['handleDelegation', 'handleEndDelegation', 'handleScopeReturn', 'wireProcessHandlers']);
    const incomplete = stubDeps();
    delete incomplete.safeSend;
    assert.throws(() => fresh.createDelegationEngine(incomplete), /missing deps: safeSend/,
      'a hole in the composition fails loudly at compose time, not at first use');
  });

  test('the returned functions are module singletons: recomposition preserves identity', () => {
    const fresh = freshEngine();
    const first = fresh.createDelegationEngine(stubDeps());
    const second = fresh.createDelegationEngine(stubDeps());
    assert.strictEqual(first.wireProcessHandlers, second.wireProcessHandlers);
    assert.strictEqual(first.handleDelegation, second.handleDelegation);
    assert.strictEqual(first.handleScopeReturn, second.handleScopeReturn);
    assert.strictEqual(first.handleEndDelegation, second.handleEndDelegation);
  });

  test('handleEndDelegation with no live entry is a quiet no-op', () => {
    const fresh = freshEngine();
    const engine = fresh.createDelegationEngine(stubDeps());
    assert.doesNotThrow(() => engine.handleEndDelegation({ conversationId: 'nope' }, new Map()));
  });
});

describe('root composition', () => {
  test('_internal re-exports the engine functions by name', () => {
    for (const name of ['wireProcessHandlers', 'handleScopeReturn', 'handleDelegation']) {
      assert.strictEqual(typeof srv[name], 'function', name);
      assert.strictEqual(srv[name].name, name, `${name} is the engine function, not a wrapper`);
    }
  });

  test('the engine bodies left the root; the shims and the machine stayed', () => {
    const rootSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf-8');
    assert.ok(!/^function wireProcessHandlers\(/m.test(rootSrc), 'wireProcessHandlers moved');
    assert.ok(!/^function handleScopeReturn\(/m.test(rootSrc), 'handleScopeReturn moved');
    assert.ok(!/^function handleDelegation\(/m.test(rootSrc), 'handleDelegation moved');
    assert.ok(!/^function spawnResumedProcess\(/m.test(rootSrc), 'spawnResumedProcess moved with the engine');
    // The four root shims stay: chat, delegate, end_delegation, flush_buffer.
    assert.match(rootSrc, /handleDelegation\(msg, processes\);/, 'delegate shim calls the engine');
    assert.match(rootSrc, /handleEndDelegation\(msg, processes\);/, 'end_delegation shim calls the engine');
    // The kill-window machine is root-owned: definition AND failsafe.
    assert.match(rootSrc, /function scheduleScopeReturnKill\(e, convoId\)/, 'kill scheduler stays in the root');
    assert.match(rootSrc, /function beginConvoTransition\(/, 'transition machine stays in the root');
    // The engine never requires the root.
    const engineSrc = fs.readFileSync(ENGINE_PATH, 'utf-8');
    assert.ok(!/require\((['"])\.\.\/\.\.\/server(\.js)?\1\)/.test(engineSrc), 'the engine never requires the root');
    assert.ok(!/\bWORKSPACE\b/.test(engineSrc), 'workspace root is read at use time via config.getWorkspace()');
  });
});
