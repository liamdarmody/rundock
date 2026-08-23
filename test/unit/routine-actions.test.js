'use strict';
// The two things a routine row does to a routine: pause it, and delete it.
//
// THE RISK HERE IS NOT THE ROUTINE THAT CHANGES, IT IS EVERYTHING ELSE. A
// routine lives in hand rolled frontmatter that also carries keys this code
// has never heard of, alongside routines somebody wrote by hand and a body
// nobody told the writer about. So both paths edit LINES and carry every other
// byte through, and the fixture below is built to catch a path that does not:
// a key outside the section, a key inside the routine being touched, a second
// routine, a key after the section, and a body.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { removeRoutineBlock, topLevelKeyCounts } = require('../../lib/agents/routines.js');
const { extractFrontmatterText, parseRoutines } = require('../../lib/agents/discovery.js');
const { handleDeleteRoutine, handleSetRoutinePaused } = require('../../lib/protocol/handlers/team.js');
const { invalidateAgentCache, discoverAgents } = require('../../lib/agents/discovery.js');
const config = require('../../lib/config.js');
const { makeWorkspace, cleanup } = require('../helpers/workspace.js');

after(cleanup);

const TWO_ROUTINES = [
  '---',
  'name: piper',
  'displayName: Piper',
  'aKeyThisCardNeverHeardOf: keep me exactly',
  'routines:',
  '  - name: morning-digest',
  '    schedule: every day at 08:00',
  '    prompt: Run the digest',
  '    aRoutineKeyTheWriterDoesNotKnow: keep me too',
  '  - name: ops-summary',
  '    schedule: every day at 07:00',
  '    prompt: Run the ops summary',
  'trailingKey: still here',
  '---',
  '',
  '# Piper',
  '',
  'Body text nobody told the writer about.',
  '',
].join('\n');

const ONE_ROUTINE = [
  '---',
  'name: doc',
  'displayName: Doc',
  'routines:',
  '  - name: reading-digest',
  '    schedule: every day at 06:30',
  '    prompt: Refresh the digest',
  'trailingKey: still here',
  '---',
  '',
  '# Doc',
  '',
].join('\n');

const namesIn = (content, owner) =>
  parseRoutines(extractFrontmatterText(content), { owner }).map(r => r.name);

describe('removing a routine block', () => {
  test('the named routine goes and its sibling stays', () => {
    const next = removeRoutineBlock(TWO_ROUTINES, 'morning-digest');
    assert.deepStrictEqual(namesIn(next, 'piper'), ['ops-summary']);
  });

  test('everything that is not that routine survives, byte for byte', () => {
    const next = removeRoutineBlock(TWO_ROUTINES, 'morning-digest');
    for (const line of [
      'aKeyThisCardNeverHeardOf: keep me exactly',
      '  - name: ops-summary',
      '    schedule: every day at 07:00',
      'trailingKey: still here',
      'Body text nobody told the writer about.',
    ]) {
      assert.ok(next.includes(line), `lost: ${line}`);
    }
    assert.ok(!next.includes('aRoutineKeyTheWriterDoesNotKnow'),
      'the removed routine took its own keys with it');
  });

  test('the last routine takes the routines key with it', () => {
    const next = removeRoutineBlock(ONE_ROUTINE, 'reading-digest');
    // A `routines:` line with nothing under it reads back as a key with no
    // value, which is not the same thing as an agent that has no routines.
    assert.strictEqual((topLevelKeyCounts(next) || new Map()).get('routines') || 0, 0);
    assert.deepStrictEqual(namesIn(next, 'doc'), []);
    assert.ok(next.includes('trailingKey: still here'));
    assert.ok(next.includes('displayName: Doc'));
  });

  test('a name that is not in the file changes nothing at all', () => {
    assert.strictEqual(removeRoutineBlock(TWO_ROUTINES, 'not-here'), TWO_ROUTINES);
  });

  test('a file with no frontmatter and a file with no routines both come back untouched', () => {
    assert.strictEqual(removeRoutineBlock('# Just a body\n', 'anything'), '# Just a body\n');
    const noRoutines = '---\nname: doc\n---\n\n# Doc\n';
    assert.strictEqual(removeRoutineBlock(noRoutines, 'anything'), noRoutines);
  });

  // Nothing makes a routine name unique within a file, and a copy-pasted block
  // is an ordinary thing to find in one.
  test('a duplicated name removes the one that was asked for', () => {
    const twins = TWO_ROUTINES.replace('  - name: ops-summary', '  - name: morning-digest');
    const next = removeRoutineBlock(twins, 'morning-digest', 1);
    assert.deepStrictEqual(namesIn(next, 'piper'), ['morning-digest']);
    assert.ok(next.includes('aRoutineKeyTheWriterDoesNotKnow'), 'the first block is the one that stayed');
  });
});

describe('the handlers behind the row', () => {
  function fixture() {
    const dir = makeWorkspace({ agents: { piper: TWO_ROUTINES, doc: ONE_ROUTINE } });
    const original = config.getWorkspace();
    config.setWorkspace(dir);
    invalidateAgentCache();
    // Discovery migrates a routine's representation lazily, on read, and
    // writes the file when it does. Letting that happen here means a later
    // snapshot changes only if the code under test changed it.
    discoverAgents();
    const sent = [];
    const calls = [];
    const ctx = {
      agents: {
        invalidateAgentCache: () => { calls.push('invalidate'); invalidateAgentCache(); },
        discoverSkills: () => [],
        flagRosterRefresh: () => {},
      },
      workspace: { isInsideWorkspace: (p) => p.startsWith(dir) },
    };
    const ws = {
      send: (m) => { const parsed = JSON.parse(m); calls.push(parsed.type); sent.push(parsed); },
      readyState: 1,
    };
    const fileFor = (slug) => path.join(dir, '.claude', 'agents', `${slug}.md`);
    return {
      dir, ctx, ws, sent, calls, fileFor,
      read: (slug) => fs.readFileSync(fileFor(slug), 'utf-8'),
      restore: () => { config.setWorkspace(original); invalidateAgentCache(); },
    };
  }

  test('deleting a routine takes it out of the file it was declared in', () => {
    const f = fixture();
    try {
      handleDeleteRoutine(f.ctx, f.ws, { type: 'delete_routine', agentId: 'piper', name: 'morning-digest' });
      assert.deepStrictEqual(namesIn(f.read('piper'), 'piper'), ['ops-summary']);
      // Invalidated BEFORE the roster went out, so the broadcast describes the
      // file as it now is rather than a warm cache that still has the routine.
      assert.deepStrictEqual(f.calls, ['routine_deleted', 'invalidate', 'agents']);
      assert.strictEqual(f.sent[f.sent.length - 1].type, 'agents');
      const piper = f.sent[f.sent.length - 1].agents.find(a => a.id === 'piper');
      assert.deepStrictEqual(piper.routines.map(r => r.name), ['ops-summary']);
    } finally { f.restore(); }
  });

  test('deleting the last routine leaves an agent with none rather than a broken key', () => {
    const f = fixture();
    try {
      handleDeleteRoutine(f.ctx, f.ws, { type: 'delete_routine', agentId: 'doc', name: 'reading-digest' });
      assert.deepStrictEqual(namesIn(f.read('doc'), 'doc'), []);
      assert.ok(f.read('doc').includes('trailingKey: still here'));
    } finally { f.restore(); }
  });

  test('a routine that is not there is refused rather than reported deleted', () => {
    const f = fixture();
    try {
      const before = f.read('piper');
      handleDeleteRoutine(f.ctx, f.ws, { type: 'delete_routine', agentId: 'piper', name: 'never-existed' });
      assert.strictEqual(f.read('piper'), before, 'the file was written to anyway');
      assert.strictEqual(f.sent[0].type, 'routine_error');
      assert.ok(!f.calls.includes('routine_deleted'));
    } finally { f.restore(); }
  });

  test('an agent that is not there is refused', () => {
    const f = fixture();
    try {
      handleDeleteRoutine(f.ctx, f.ws, { type: 'delete_routine', agentId: 'nobody', name: 'morning-digest' });
      assert.strictEqual(f.sent[0].type, 'routine_error');
      assert.match(f.sent[0].message, /nobody/);
    } finally { f.restore(); }
  });

  test('a delete with no name is refused', () => {
    const f = fixture();
    try {
      handleDeleteRoutine(f.ctx, f.ws, { type: 'delete_routine', agentId: 'piper' });
      assert.strictEqual(f.sent[0].type, 'routine_error');
    } finally { f.restore(); }
  });

  test('an agent file outside the workspace is refused', () => {
    const f = fixture();
    try {
      f.ctx.workspace.isInsideWorkspace = () => false;
      handleDeleteRoutine(f.ctx, f.ws, { type: 'delete_routine', agentId: 'piper', name: 'morning-digest' });
      assert.strictEqual(f.sent[0].type, 'routine_error');
      assert.deepStrictEqual(namesIn(f.read('piper'), 'piper'), ['morning-digest', 'ops-summary']);
    } finally { f.restore(); }
  });

  test('pausing a routine stops it without touching its schedule or its siblings', () => {
    const f = fixture();
    try {
      handleSetRoutinePaused(f.ctx, f.ws, {
        type: 'set_routine_paused', agentId: 'piper', name: 'morning-digest', paused: true,
      });
      const routines = parseRoutines(extractFrontmatterText(f.read('piper')), { owner: 'piper' });
      const paused = routines.find(r => r.name === 'morning-digest');
      assert.strictEqual(paused.paused, true);
      assert.strictEqual(paused.schedule, 'every day at 08:00', 'pausing is not rescheduling');
      assert.strictEqual(routines.find(r => r.name === 'ops-summary').paused, false);
      assert.ok(f.read('piper').includes('aRoutineKeyTheWriterDoesNotKnow: keep me too'));
      assert.deepStrictEqual(f.calls, ['routine_paused', 'invalidate', 'agents']);
    } finally { f.restore(); }
  });

  test('resuming puts it back', () => {
    const f = fixture();
    try {
      const msg = { type: 'set_routine_paused', agentId: 'piper', name: 'morning-digest', paused: true };
      handleSetRoutinePaused(f.ctx, f.ws, msg);
      handleSetRoutinePaused(f.ctx, f.ws, { ...msg, paused: false });
      const routines = parseRoutines(extractFrontmatterText(f.read('piper')), { owner: 'piper' });
      assert.strictEqual(routines.find(r => r.name === 'morning-digest').paused, false);
    } finally { f.restore(); }
  });

  test('pausing a routine that is not there is refused', () => {
    const f = fixture();
    try {
      const before = f.read('piper');
      handleSetRoutinePaused(f.ctx, f.ws, {
        type: 'set_routine_paused', agentId: 'piper', name: 'never-existed', paused: true,
      });
      assert.strictEqual(f.read('piper'), before);
      assert.strictEqual(f.sent[0].type, 'routine_error');
    } finally { f.restore(); }
  });

  test('pausing on an agent that is not there is refused', () => {
    const f = fixture();
    try {
      handleSetRoutinePaused(f.ctx, f.ws, {
        type: 'set_routine_paused', agentId: 'nobody', name: 'morning-digest', paused: true,
      });
      assert.strictEqual(f.sent[0].type, 'routine_error');
    } finally { f.restore(); }
  });

  test('pausing outside the workspace is refused', () => {
    const f = fixture();
    try {
      f.ctx.workspace.isInsideWorkspace = () => false;
      handleSetRoutinePaused(f.ctx, f.ws, {
        type: 'set_routine_paused', agentId: 'piper', name: 'morning-digest', paused: true,
      });
      assert.strictEqual(f.sent[0].type, 'routine_error');
    } finally { f.restore(); }
  });

  // Both controls are reachable from the client's dispatch table, which is the
  // half a handler test on its own says nothing about.
  test('both actions are wired into the dispatch', () => {
    const { buildDispatch } = require('../../lib/protocol/handlers/index.js');
    const dispatch = buildDispatch();
    assert.strictEqual(dispatch.delete_routine, handleDeleteRoutine);
    assert.strictEqual(dispatch.set_routine_paused, handleSetRoutinePaused);
  });
});
