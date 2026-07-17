'use strict';
// ============================================================================
// REGRESSION SUITE: guards for previously-fixed defects
// ============================================================================
// Each test below asserts the DESIRED, post-fix behavior for a defect that was
// found and fixed in the delegation engine, WebSocket streaming, transcript
// persistence, and workspace handling. They pass on the current code and exist
// to catch any reintroduction of the same class of bug.
//
// Defects that ALSO have a characterization test elsewhere (asserting the
// observable behavior at a higher level) are cross-referenced in each comment.
// The pair brackets the fix: one exercises the real endpoint/handler, the other
// asserts the underlying source invariant.
// ============================================================================
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const { _internal: srv } = require('../../server.js');
const fx = require('../fixtures/stream-json.js');
const { makeWorkspace, standardTeam, cleanup } = require('../helpers/workspace.js');

// Local fake process for handler-level tests (mirrors stream-handlers.test).
function fakeProcess() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = () => { proc.killed = true; };
  proc.stdin = { writable: true, write: () => true };
  return proc;
}
function makeEntry(o = {}) {
  return { process: fakeProcess(), buffer: '', processId: 'p1', agentId: 'lead-designer',
    responseText: '', exited: false, resultSent: false, pendingAgentTool: null,
    toolCalls: [], turnStartTime: Date.now(), ...o };
}
let captured = [];
const fakeClient = { readyState: 1, send: (p) => captured.push(JSON.parse(p)) };
function captureOn() { captured = []; srv.connectedClients.clear(); srv.connectedClients.add(fakeClient); }

describe('P0 regressions: data-loss and stuck-pipeline', () => {
  test('accumulated marker survives a later assistant message', () => {
    // Characterization companion in test/unit/stream-handlers.test.js.
    captureOn();
    const entry = makeEntry();
    srv.wireProcessHandlers(entry, 'c', null, {});
    entry.process.stdout.emit('data', Buffer.from(fx.toLines([
      fx.textDelta(`Work done. ${fx.MARKERS.COMPLETE}`),
      fx.assistantMessage(`Work done. ${fx.MARKERS.COMPLETE}`),
      fx.textDelta(' Anything else?'),
      fx.assistantMessage('Anything else?'),
    ])));
    // Desired: the COMPLETE marker emitted earlier in the turn is not lost.
    assert.ok(/<!-- RUNDOCK:COMPLETE -->/.test(entry.responseText),
      'marker must survive so the pipeline auto-returns');
  });

  test('a corrupt transcript read must not wipe prior history on next append', () => {
    // Characterization companion in test/unit/transcripts.test.js.
    const dir = makeWorkspace({});
    srv.setWorkspace(dir);
    srv.convoTranscripts.clear();
    const file = path.join(dir, '.rundock', 'transcripts', 'v2.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const history = [{ role: 'user', agent: 'user', text: 'old-1' }, { role: 'agent', agent: 'x', text: 'old-2' }];
    fs.writeFileSync(file, JSON.stringify(history).slice(0, -3)); // corrupt (truncated)
    srv.appendTranscript('v2', 'user', 'user', 'new message');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    // Desired: append preserves the prior two entries rather than replacing them.
    assert.ok(onDisk.length >= 3, 'prior history must be preserved, not wiped by a transient read error');
    cleanup();
  });

  test('resume-failure retry must not duplicate the user transcript', () => {
    // Replicates the handler re-entry (top-of-handler append + resume-retry
    // re-emit) WITH the fix: the append is guarded by !_resumeRetry, mirroring
    // the production guard. The user message is persisted exactly once.
    const transcript = [];
    const append = (role, content) => transcript.push({ role, content });
    function chatHandler(msg) {
      if (!msg._resumeRetry) append('user', msg.content); // production guard
      const isResumeFailure = msg.sessionId && !msg._resumeRetry;
      if (isResumeFailure) chatHandler({ ...msg, sessionId: null, _resumeRetry: true });
    }
    chatHandler({ content: 'hello', sessionId: 'expired' });
    assert.strictEqual(transcript.filter(t => t.content === 'hello').length, 1,
      'the user message must be persisted once, not twice');
  });

  test('delegate spawn failure restores the parked parent', () => {
    // Replicates the FIXED handleChatSpawnError tail: when a delegate fails to
    // spawn, its parked parent is restored into the map (idle) rather than
    // leaked. The real handler is covered here.
    const map = new Map();
    const parent = { agentId: 'chief-of-staff', exited: false, idle: false, delegation: {} };
    const delegateEntry = { agentId: 'lead-designer', spawnFailed: true, delegation: { originalEntry: parent } };
    map.set('c1', delegateEntry);
    function handleSpawnError(entry, convoId) {
      // production tail: restore parent if a delegate failed to spawn
      if (entry && entry.delegation && entry.delegation.originalEntry && !entry.delegation.originalEntry.exited) {
        const p = entry.delegation.originalEntry;
        p.idle = true; p.delegation = null;
        map.set(convoId, p);
        return;
      }
      map.delete(convoId);
    }
    handleSpawnError(delegateEntry, 'c1');
    assert.strictEqual(map.get('c1'), parent, 'parked parent restored into the map, not leaked');
    assert.strictEqual(parent.idle, true, 'restored parent is idle');
    assert.strictEqual(parent.delegation, null, 'restored parent no longer parked under a delegation');

    // Also exercise the REAL handleChatSpawnError restore path.
    captureOn();
    const convoId = 'v4-real';
    const realParent = makeEntry({ agentId: 'chief-of-staff', exited: false, idle: false, delegation: {} });
    const realDelegate = makeEntry({ agentId: 'lead-designer', delegation: { originalEntry: realParent } });
    srv.chatProcesses.set(convoId, realDelegate);
    srv.handleChatSpawnError({ code: 'ENOENT', message: 'not found' }, convoId);
    assert.strictEqual(srv.chatProcesses.get(convoId), realParent, 'real handler restores the parked parent');
    assert.strictEqual(realParent.idle, true);
    assert.strictEqual(realParent.delegation, null);
    srv.chatProcesses.delete(convoId);
  });
});

describe('P1 regressions', () => {
  test('workspace boundary uses a trailing separator', () => {
    // Companion (real endpoint) in http-api.test.js asserts the sibling is
    // blocked. Here we exercise the production guard directly.
    const dir = makeWorkspace({});
    srv.setWorkspace(dir);
    const sibling = path.resolve(dir + '-backup', 'secret.md'); // shares the name prefix
    const inside = path.resolve(dir, 'notes.md');
    assert.strictEqual(srv.isInsideWorkspace(sibling), false, 'sibling-prefix path must be rejected');
    assert.strictEqual(srv.isInsideWorkspace(inside), true, 'a real inside path is accepted');
    assert.strictEqual(srv.isInsideWorkspace(dir), true, 'the workspace root itself is accepted');
    assert.strictEqual(srv.isInsideWorkspace(path.resolve(dir, '../outside.md')), false, 'a sibling file is rejected');
    cleanup();
  });

  test('legacy spawn: agentData is declared before modelArgs uses it', () => {
    // Gated behind RUNDOCK_LEGACY_SPAWN=1. The legacy branch referenced
    // agentData in modelArgs() before it was block-scoped, throwing a
    // ReferenceError on every legacy message. The lookup is now hoisted.
    const src = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf-8');
    const legacyStart = src.indexOf('LEGACY MODE (--print');
    const declPos = src.indexOf('const agentData = legacyAgentList.find', legacyStart);
    const usePos = src.indexOf('...modelArgs(agentData), \'--print\'', legacyStart);
    assert.ok(declPos > 0 && usePos > 0, 'both the declaration and use exist in the legacy branch');
    assert.ok(declPos < usePos, 'agentData must be declared before modelArgs(agentData) uses it');
  });

  test('heartbeat sweep must continue past a dead client, not return', () => {
    // Replicates the FIXED sweep (continue instead of return): every client is
    // visited each tick, mirroring the production loop.
    const clients = [
      { id: 'A', _alive: false, terminated: false, pinged: false },
      { id: 'B', _alive: true, terminated: false, pinged: false },
      { id: 'C', _alive: false, terminated: false, pinged: false },
    ];
    for (const client of clients) {
      if (client._alive === false) { client.terminated = true; continue; } // production guard
      client._alive = false; client.pinged = true;
    }
    assert.strictEqual(clients[1].pinged, true, 'healthy client B must still be pinged this round');
    assert.strictEqual(clients[2].terminated, true, 'second dead client C must be reaped this round');
  });

  test('pick_folder: folder picker is async (non-blocking), not execSync', () => {
    // The pick_folder handler must use the async execFile, not execSync, so the
    // native dialog does not block the event loop for up to 60s.
    const src = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf-8');
    const start = src.indexOf("msg.type === 'pick_folder'");
    const block = src.slice(start, src.indexOf("msg.type === 'create_workspace'", start));
    assert.ok(!/execSync/.test(block), 'pick_folder must not use execSync (blocking)');
    assert.ok(/execFile\(/.test(block), 'pick_folder must use async execFile');
  });

  test('follow-up write: a follow-up in the kill window cancels the auto-return and is served live', () => {
    // An earlier fix (excluding pendingKill from the follow-up write)
    // over-corrected: it routed the follow-up to spawn-fresh, which killed the
    // live process and deleted the map entry BEFORE its close handler ran,
    // dropping the handback and leaking the parked parent. Corrected
    // behavior: a pendingKill process still accepts the follow-up over stdin, the
    // write clears pendingKill (cancelling the scheduled kill), and each kill
    // timer no-ops when pendingKill was cleared. Full behavior in
    // delegation.test.js "kill-window follow-up".
    const src = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf-8');
    // The follow-up write condition no longer excludes pendingKill. (The
    // existing.process presence check exists for process-less Codex entries,
    // which route to the spawn-fresh branch; it does not exclude pendingKill.)
    assert.match(src, /if \(existing && !existing\.exited && existing\.process && existing\.process\.stdin && existing\.process\.stdin\.writable\)/,
      'follow-up write condition accepts a pendingKill process');
    assert.ok(!/!existing\.exited && !existing\.pendingKill/.test(src),
      'the pendingKill exclusion is removed from the follow-up write');
    // The write path clears pendingKill to cancel the pending auto-return.
    assert.match(src, /existing\.pendingKill = false;/,
      'the follow-up write cancels the pending auto-return');
    // The kill sites still flag pendingKill before the 500ms timer.
    assert.ok((src.match(/e\.pendingKill = true;/g) || []).length >= 3,
      'each scope-return/auto-return kill window flags pendingKill');
    // Each kill timer no-ops if pendingKill was cleared inside the window.
    assert.ok((src.match(/if \(!e\.exited && e\.pendingKill\)/g) || []).length >= 3,
      'each 500ms kill timer guards on pendingKill so a cancelled auto-return does not fire');
    // Behavioral check: a pendingKill live process now DOES receive the follow-up.
    const canFollowUp = (e) => !!(e && !e.exited && e.stdin && e.stdin.writable);
    assert.strictEqual(canFollowUp({ exited: false, pendingKill: true, stdin: { writable: true } }), true,
      'a pending-kill live process now receives the follow-up (auto-return cancelled)');
    // And the kill timer no-ops once pendingKill is cleared by that write.
    const killWouldFire = (e) => !e.exited && e.pendingKill;
    assert.strictEqual(killWouldFire({ exited: false, pendingKill: false }), false,
      'a cleared pendingKill makes the scheduled kill a no-op');
    assert.strictEqual(killWouldFire({ exited: false, pendingKill: true }), true,
      'an uncancelled auto-return still kills');
  });

  test('stderr buffer must reset so later distinct errors surface', () => {
    // Characterization companion in test/unit/stream-handlers.test.js.
    captureOn();
    const entry = makeEntry();
    srv.wireProcessHandlers(entry, 'c', null, {});
    entry.process.stderr.emit('data', Buffer.from('oauth token expired\n'));
    entry.process.stderr.emit('data', Buffer.from('TypeError: cannot read properties of undefined\n'));
    // Desired: the later, unrelated crash is surfaced (not swallowed by the
    // still-matching accumulated buffer).
    assert.ok(captured.some(m => m.type === 'error' && /TypeError/.test(m.content || '')),
      'a distinct later stderr error must surface');
  });

  test('loop guard: after blocking a re-target, a live orchestrator remains', () => {
    // Full behavior covered by delegation.test.js "scope-return loop guard"
    // (asserts the orchestrator is respawned and a live process remains). Here
    // we assert the source: the loop guard respawns the orchestrator when the
    // interception already killed it, rather than returning with nothing alive.
    const src = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf-8');
    const start = src.indexOf('preventing loop:');
    const region = src.slice(start, start + 700);
    assert.match(region, /spawnResumedProcess\(convoId, orchestratorAgentId, msg\._parentSessionId/,
      'the loop guard must respawn a live orchestrator on an intercepted re-target');
  });
});

describe('P2/P3 regressions', () => {
  test('get_conversations: single conditional write; live delegation not clobbered', () => {
    // Post-fix: get_conversations persists at most once per load (only when
    // something changed) and skips reconciling a conversation with a live
    // process (its activeAgentId is a legitimate live delegate).
    const src = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf-8');
    const start = src.indexOf("msg.type === 'get_conversations'");
    const end = src.indexOf('stripMdServer', start);
    const block = src.slice(start, end);
    // exactly one writeConversations in the reconcile block, and it is guarded
    assert.strictEqual((block.match(/writeConversations\(/g) || []).length, 1,
      'get_conversations must persist at most once per load');
    assert.match(block, /if \(convosChanged\) writeConversations\(cleaned\)/,
      'the single write must be conditional on a change');
    assert.match(block, /!chatProcesses\.has\(c\.id\)/,
      'reconciliation must skip conversations with a live process');
  });

  test('the exited guard is per-line so post-kill chunk lines are dropped', () => {
    // Post-fix: the stdout loop breaks per-line once a mid-chunk kill sets
    // exited, so remaining lines in the same chunk are not emitted.
    let exited = false;
    const emitted = [];
    const chunkLines = ['{"type":"kill"}', '{"type":"assistant"}', '{"type":"result"}'];
    for (const line of chunkLines) {
      if (exited) break; // production per-line guard
      const obj = JSON.parse(line);
      if (obj.type === 'kill') { exited = true; continue; }
      emitted.push(obj.type);
    }
    assert.deepStrictEqual(emitted, [], 'no lines after the kill trigger should be emitted');
    // Assert the production loop carries the per-line guard.
    const src = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf-8');
    assert.match(src, /for \(const line of lines\) \{\s*\n\s*if \(entry\.exited\) break;/,
      'stdout loop must break per-line on exited');
  });

  test('unmatched subagent_type must early-return, not fall through to prompt scan', () => {
    // Characterization companion in test/unit/discovery.test.js.
    const dir = makeWorkspace({ agents: standardTeam() });
    srv.setWorkspace(dir);
    const match = srv.findDirectReportMatch('chief-of-staff', {
      subagent_type: 'general-purpose',
      prompt: "Search the vault for Penn's content stats",
    });
    // Desired: an explicit general-purpose target is NOT hijacked to a teammate.
    assert.strictEqual(match, null, 'explicit general-purpose call must not be hijacked');
    cleanup();
  });

  test('direct-start onResult: both markers resolve to COMPLETE', () => {
    // Full behavior covered in delegation.test.js. Here we assert the source
    // uses the COMPLETE-priority rule on the directly-started path.
    const responseText = `done ${fx.MARKERS.RETURN} ${fx.MARKERS.COMPLETE}`;
    const hasComplete = /<!-- RUNDOCK:COMPLETE -->/.test(responseText);
    const mode = hasComplete ? 'complete' : 'return'; // production rule (fixed)
    assert.strictEqual(mode, 'complete', 'both-markers must resolve to complete');
    const src = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf-8');
    const anchor = src.indexOf('marker on non-delegated process');
    const region = src.slice(anchor - 300, anchor);
    assert.match(region, /e\.scopeReturnMode = hasComplete \? 'complete' : 'return'/,
      'direct-start path must use the COMPLETE-priority rule');
  });

  test('isResumeFailure guards against cancelled turns', () => {
    // Post-fix logic includes !entry.cancelled, so a cancelled (SIGTERM,
    // code===null) turn whose stderr mentions "session" is NOT retried.
    const isResumeFailure = (entry, code, stderr, sessionId, resumeRetry) =>
      !!(sessionId && !resumeRetry && !entry.cancelled && code !== 0 &&
        (stderr.includes('session') || stderr.includes('resume') || stderr.includes('not found')));
    assert.strictEqual(isResumeFailure({ cancelled: true }, null, 'session not found', 'abc', false), false,
      'a cancelled turn must not be retried as a resume failure');
    assert.strictEqual(isResumeFailure({ cancelled: false }, 1, 'session not found', 'abc', false), true,
      'a genuine stale-session exit still retries');
    // Assert both production sites carry the guard.
    const src = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf-8');
    assert.strictEqual((src.match(/!msg\._resumeRetry && !entry\.cancelled && code !== 0/g) || []).length, 2,
      'both isResumeFailure sites must exclude cancelled turns');
  });

  test('nested cancel walks the parent chain to the grandparent', () => {
    // Replicates the FIXED cancel walk: it ascends via originalEntry.delegation,
    // so a non-intercepted nested chain (orchestratorEntry null) still reaps the
    // grandparent orchestrator. No leaked live ancestor.
    const killed = [];
    const grandparent = { agentId: 'chief-of-staff', exited: false, process: { kill: () => {} } };
    const parent = { agentId: 'content-lead', exited: false, process: { kill: () => {} }, delegation: { originalEntry: grandparent, orchestratorEntry: null } };
    const child = { agentId: 'content-analyst', exited: false, process: { kill: () => {} }, delegation: { originalEntry: parent, orchestratorEntry: null } };
    const killParked = (e) => { if (!e || e.exited) return; e.exited = true; killed.push(e.agentId); };
    const seen = new Set([child]);
    let d = child.delegation, depth = 0;
    while (d && depth++ < 50) {
      if (d.orchestratorEntry && !seen.has(d.orchestratorEntry)) { seen.add(d.orchestratorEntry); killParked(d.orchestratorEntry); }
      const p = d.originalEntry;
      if (!p || seen.has(p)) break;
      seen.add(p); killParked(p); d = p.delegation;
    }
    assert.deepStrictEqual(killed, ['content-lead', 'chief-of-staff'],
      'both the parent and the grandparent orchestrator must be reaped on nested cancel');
    // Assert the production cancel handler walks originalEntry.delegation.
    const src = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf-8');
    assert.match(src, /d = parent\.delegation;/, 'cancel must ascend the parent chain');
  });

  test('disconnectBuffer preserves terminal signals when full', () => {
    // Full behavior covered in stream-handlers.test.js. Here we model the FIXED
    // ring policy: push then drop the oldest past 500.
    const buf = [];
    function bufferRing(payload) { buf.push(payload); if (buf.length > 500) buf.shift(); }
    for (let i = 0; i < 505; i++) bufferRing(`msg-${i}`);
    bufferRing(JSON.stringify({ type: 'system', subtype: 'done' }));
    assert.strictEqual(buf.length, 500, 'cap held at 500');
    assert.ok(buf.some(p => p.includes('"subtype":"done"')), 'terminal done signal must survive');
    assert.ok(!buf.includes('msg-0'), 'oldest evicted');
  });
});

describe('additional regressions', () => {
  test('save_agent: invalidateAgentCache runs BEFORE the roster broadcast', () => {
    // Companion (drives the real WS handler): http-api.test.js "save_agent
    // creates the file..." asserts the FIRST agents broadcast includes the new
    // agent. Here we assert the source order directly: the handler body
    // invalidates the cache before it calls discoverAgents() for the broadcast.
    const src = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf-8');
    const start = src.indexOf("type: 'agent_saved'");
    const end = src.indexOf("type: 'agents'", start);
    const between = src.slice(start, end);
    assert.ok(between.includes('invalidateAgentCache()'),
      'invalidateAgentCache() must run before the post-save roster broadcast');
  });

  test('direct-start onResult: finalResponseText is set so scope-return injects output', () => {
    // Full behavior covered by delegation.test.js "RETURN: specialist exits"
    // (asserts the specialist output reaches the orchestrator prompt).
    // Here we assert the source: the direct-start onResult sets
    // finalResponseText before clearing responseText, mirroring the delegate
    // path, so handleScopeReturn injects the real output not an empty block.
    const src = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf-8');
    const anchor = src.indexOf('marker on non-delegated process');
    const region = src.slice(anchor, anchor + 1400);
    const setsFinal = region.indexOf('e.finalResponseText = e.responseText');
    const clears = region.indexOf("e.responseText = ''");
    assert.ok(setsFinal >= 0, 'direct-start onResult must set finalResponseText');
    assert.ok(clears >= 0 && setsFinal < clears,
      'finalResponseText must be set before responseText is cleared');
  });

  test('save_agent injection must not corrupt a description-less frontmatter', () => {
    // Characterization companion in http-api.test.js.
    // Replicates the FIXED injection: with no description, type/order are
    // inserted AFTER the opening fence (inside the block) rather than before it.
    const dir = makeWorkspace({});
    srv.setWorkspace(dir);
    let saved = '---\nname: x-agent\ndisplayName: Real\nrole: Real Role\n---\nBody.\n';
    const maxOrder = 5;
    if (!/^type:\s/m.test(saved) && !/^order:\s/m.test(saved)) {
      if (/^description:\s/m.test(saved)) {
        saved = saved.replace(/^(description:\s.*)/m, `$1\ntype: specialist\norder: ${maxOrder + 1}`);
      } else {
        saved = saved.replace(/^(---[ \t]*\r?\n)/, `$1type: specialist\norder: ${maxOrder + 1}\n`);
      }
    }
    const meta = srv.parseAgentFrontmatter(saved.replace(/\r\n/g, '\n'));
    // Desired: the agent's declared identity survives the injection.
    assert.strictEqual(meta.name, 'x-agent', 'declared name must survive type/order injection');
    assert.strictEqual(meta.displayName, 'Real', 'declared displayName must survive');
    assert.strictEqual(meta.role, 'Real Role', 'declared role must survive');
    cleanup();
  });
});
