'use strict';
// Deterministic pins for root-remainder edges that only ever measured as
// covered through timing luck or block-coverage smearing: the kill-window
// failsafe, the no-client replay warning, the spawn-error dedupe and
// handler-fault paths, the skill read-error catch, and the search engine's
// no-workspace close and init-failure fallback. Each is driven directly so
// the file floor stops depending on the parallel-load schedule.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { _internal: srv } = require('../../server.js');
const { makeWorkspace, cleanup } = require('../helpers/workspace.js');

const transitions = srv.wsHandlerContext.transitions;

describe('kill-window transition edges', () => {
  test('the 10s failsafe force-flushes a transition nothing ended; with no client the replay warns and drops', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const owner = { processId: 'p-fs' };
    transitions.beginConvoTransition('convo-fs', 'killing', owner);
    assert.strictEqual(transitions.bufferChatIfTransitioning('convo-fs', { type: 'chat', content: 'buffered' }), true,
      'a message in the window buffers');
    assert.ok(srv.convoTransitions.has('convo-fs'), 'window open');
    // No connected clients in this process: the replay path must WARN and
    // drop rather than throw, and the window must still close.
    t.mock.timers.tick(10000);
    assert.ok(!srv.convoTransitions.has('convo-fs'), 'the failsafe closed the window');
    assert.strictEqual(transitions.bufferChatIfTransitioning('convo-fs', { type: 'chat' }), false,
      'after the flush, messages flow normally again');
  });

  test('an end from a flow that does not own the window is ignored', () => {
    const owner = { processId: 'p-own' };
    transitions.beginConvoTransition('convo-own', 'killing', owner);
    transitions.endConvoTransition('convo-own', { processId: 'p-other' });
    assert.ok(srv.convoTransitions.has('convo-own'), 'a stale close cannot flush a window it does not own');
    transitions.endConvoTransition('convo-own', owner);
    assert.ok(!srv.convoTransitions.has('convo-own'), 'the owning flow ends it');
  });
});

describe('spawn-error handler edges', () => {
  test('a repeat error for the same conversation within 30s is deduped to a log line', () => {
    srv.handleChatSpawnError({ code: 'ENOENT', message: 'not found' }, 'dedupe-convo');
    const before = srv.disconnectBuffer.length;
    srv.handleChatSpawnError({ code: 'ENOENT', message: 'not found' }, 'dedupe-convo');
    const after = srv.disconnectBuffer.filter(m => JSON.parse(m).subtype === 'info').length
      - srv.disconnectBuffer.slice(0, before).filter(m => JSON.parse(m).subtype === 'info').length;
    assert.strictEqual(after, 0, 'no second user-facing pill inside the dedupe window');
    const dones = srv.disconnectBuffer.filter(m => {
      const p = JSON.parse(m);
      return p.subtype === 'done' && p._conversationId === 'dedupe-convo';
    });
    assert.strictEqual(dones.length, 2, 'the done signal still fires on EVERY attempt so the client unblocks');
  });

  test('a fault inside the handler is contained, never thrown at the WebSocket', () => {
    assert.doesNotThrow(() => srv.handleChatSpawnError(null, 'fault-convo'),
      'reading .code of a null error must be caught by the handler itself');
  });
});

describe('skill discovery edges', () => {
  test('an unreadable SKILL.md is skipped with the other skills intact', () => {
    const dir = makeWorkspace({});
    srv.setWorkspace(dir);
    const good = path.join(dir, '.claude', 'skills', 'good-skill');
    fs.mkdirSync(good, { recursive: true });
    fs.writeFileSync(path.join(good, 'SKILL.md'), '---\nname: Good Skill\ndescription: Works.\n---\nBody.\n');
    // SKILL.md as a DIRECTORY makes the read throw for this entry only.
    fs.mkdirSync(path.join(dir, '.claude', 'skills', 'broken-skill', 'SKILL.md'), { recursive: true });
    const skills = srv.discoverSkills();
    assert.ok(skills.some(s => s.slug === 'good-skill'), 'the healthy skill survives');
    assert.ok(!skills.some(s => s.slug === 'broken-skill'), 'the unreadable one is skipped, not fatal');
    cleanup();
  });
});

describe('search engine lifecycle edges', () => {
  test('no workspace: the engine is closed and released, and search reports unavailable', () => {
    const dir = makeWorkspace({});
    srv.setWorkspace(dir);
    srv.ensureSearchEngine(); // may or may not open depending on sqlite; both fine
    srv.setWorkspace(null);
    assert.strictEqual(srv.ensureSearchEngine(), null, 'without a workspace there is no engine');
    assert.strictEqual(srv.getSearchEngine(), null, 'the previous engine was released');
    cleanup();
  });

  test('an engine open failure falls back to grep and backs off until a workspace switch', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-badsearch-'));
    fs.writeFileSync(path.join(dir, '.rundock'), 'not a directory'); // open cannot create its home
    srv.setWorkspace(dir);
    assert.strictEqual(srv.ensureSearchEngine(), null, 'open failure degrades to the grep fallback');
    assert.strictEqual(srv.ensureSearchEngine(), null, 'and backs off instead of retrying every call');
    srv.setWorkspace(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
