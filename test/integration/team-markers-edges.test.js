'use strict';
// The routes around Doc's markers: the other runtime, routines, turns that
// end without a result, the decision failing, two windows, and the sequences
// a person actually runs.
//
// Only a turn the server recorded as Doc's (rundock-guide), ending with a
// result, saves or deletes agents and skills (lib/agents/team-markers.js).
// team-markers.test.js holds the main cases; this file holds the rest. Doc
// here is a workspace file of its own, so the built-in Doc and a file-backed
// one are both covered between the two files.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');
const fx = require('../fixtures/stream-json.js');
const { agentFile, standardTeam } = require('../helpers/workspace.js');
const teamMarkers = require('../../lib/agents/team-markers.js');
const teamHandlers = require('../../lib/protocol/handlers/team.js');

let client;

before(async () => {
  await h.boot({
    agents: {
      ...standardTeam(),
      'rundock-guide': agentFile({
        name: 'rundock-guide', displayName: 'Doc', role: 'Rundock Guide', description: 'Sets up the workspace',
        type: 'platform', order: 90, body: 'You are Doc.',
      }),
      // A second agent whose file says it is a platform agent. Identity is
      // the id, so this is any other agent.
      'second-guide': agentFile({
        name: 'second-guide', displayName: 'Gil', role: 'Another Guide', description: 'Says it is a guide',
        type: 'platform', order: 91, body: 'You are Gil.',
      }),
      'researcher': agentFile({
        name: 'researcher', displayName: 'Ida', role: 'Researcher', description: 'Researches suppliers',
        type: 'specialist', order: 5, reportsTo: 'chief-of-staff', runtime: 'codex', body: 'You are Ida.',
      }),
    },
  });
  client = await h.connect();
});
after(async () => h.shutdown());

const agentPath = (name) => path.join(h.workspaceDir, '.claude', 'agents', `${name}.md`);
const readOrNull = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null);
function teamFile(name, label) {
  return agentFile({
    name, displayName: label, role: 'Example Role', description: 'An example agent',
    type: 'specialist', order: 30, reportsTo: 'chief-of-staff', body: `You are ${label}.`,
  }).trim();
}
const saveMarker = (name, label) => `<!-- RUNDOCK:SAVE_AGENT name=${name} -->\n${teamFile(name, label)}\n<!-- /RUNDOCK:SAVE_AGENT -->`;
const deleteMarker = (name) => `<!-- RUNDOCK:DELETE_AGENT name=${name} -->`;
function seed(name, label) {
  fs.writeFileSync(agentPath(name), teamFile(name, label));
  h.internal.invalidateAgentCache();
}
function unseed(...names) {
  for (const name of names) fs.rmSync(agentPath(name), { force: true });
  h.internal.invalidateAgentCache();
}

const TEAM_LINES = ['agent_saved', 'agent_deleted', 'skill_saved', 'skill_deleted', 'agent_error', 'skill_error'];
const linesFor = (messages, convoId) => messages.filter((m) => TEAM_LINES.includes(m.type) && m.conversationId === convoId);

// One turn of a direct chat, run to its done.
async function chat(convoId, agent, content, from = client) {
  const since = from.messages.length;
  from.send({ type: 'chat', conversationId: convoId, agent, content });
  await from.waitFor((m) => m.type === 'system' && m.subtype === 'done' && m._conversationId === convoId, { since, label: `${agent} done` });
  return since;
}

async function refusal(convoId, who, verbed, since = 0, from = client) {
  const { msg } = await from.waitFor((m) => (m.type === 'agent_error' || m.type === 'skill_error') && m.conversationId === convoId
    && m.refused === true && m.message.startsWith(`${who} asked to ${verbed}`) && m.message.includes('only Doc can change the team'),
  { since, timeout: 4000, label: `${who}'s refusal to ${verbed}` });
  return msg;
}

describe('Doc is the id rundock-guide, not a type, and never another runtime', () => {
  test('another agent whose file declares type: platform is refused', async () => {
    const convoId = h.freshConvoId('typed');
    h.writeScenario([{ match: { agent: 'second-guide', promptIncludes: 'TYPED-PLATFORM' }, turn: [{ text: `Saving.\n${saveMarker('typed-made', 'Typed')}` }] }]);
    try {
      const since = await chat(convoId, 'second-guide', 'TYPED-PLATFORM make one');
      await refusal(convoId, 'Gil', 'save the agent "typed-made"', since);
      assert.strictEqual(fs.existsSync(agentPath('typed-made')), false, 'nothing was written');
    } finally {
      h.reapConvo(convoId);
      unseed('typed-made');
    }
  });

  test('a Codex agent\'s marker in a direct chat is refused', async () => {
    const convoId = h.freshConvoId('codex');
    seed('codex-target', 'Before');
    h.writeCodexScenario([{ match: { promptIncludes: 'CODEX-DIRECT' }, text: `Done.\n${deleteMarker('codex-target')}` }]);
    try {
      const since = client.messages.length;
      client.send({ type: 'chat', conversationId: convoId, agent: 'researcher', content: 'CODEX-DIRECT remove it' });
      await refusal(convoId, 'Ida', 'delete the agent "codex-target"', since);
      assert.strictEqual(readOrNull(agentPath('codex-target')), teamFile('codex-target', 'Before'), 'the agent is still there, unchanged');
    } finally {
      h.reapConvo(convoId);
      unseed('codex-target');
    }
  });

  test('a Codex agent\'s marker as a delegate is refused', async () => {
    const convoId = h.freshConvoId('codexdel');
    seed('codex-del-target', 'Before');
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'CODEX-DELEGATED' },
        turn: [{ agentTool: { subagent_type: 'researcher', prompt: 'CODEX-BRIEF remove it' } }] },
      { match: { agent: 'chief-of-staff', promptIncludes: '[SYSTEM: pipeline-complete]' }, turn: [{ text: '<silent>' }] },
    ]);
    h.writeCodexScenario([{ match: { promptIncludes: 'CODEX-BRIEF' }, text: `Removed.\n${deleteMarker('codex-del-target')}\n<!-- RUNDOCK:COMPLETE -->` }]);
    try {
      const since = client.messages.length;
      client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'CODEX-DELEGATED please' });
      await refusal(convoId, 'Ida', 'delete the agent "codex-del-target"', since);
      assert.strictEqual(readOrNull(agentPath('codex-del-target')), teamFile('codex-del-target', 'Before'), 'the agent is still there, unchanged');
    } finally {
      h.reapConvo(convoId);
      unseed('codex-del-target');
    }
  });
});

describe('an agent file that already declares type: platform keeps it, whatever Doc\'s marker says', () => {
  // second-guide.md declares type: platform. Doc's own marker may not replace
  // it, even with content that declares another type, and may not delete it.
  // The first window line for the conversation is read, so a write shows as
  // the wrong line rather than as a wait for one that never comes.
  async function firstLine(convoId, since) {
    const { msg } = await client.waitFor((m) => TEAM_LINES.includes(m.type) && m.conversationId === convoId, { since, timeout: 4000, label: 'the line about the team' });
    return msg;
  }

  test('Doc\'s SAVE_AGENT replacing it with specialist content is refused, and the file is unchanged', async () => {
    const convoId = h.freshConvoId('keepsave');
    const before = fs.readFileSync(agentPath('second-guide'));
    h.writeScenario([{ match: { agent: 'rundock-guide', promptIncludes: 'KEEP-PLATFORM-SAVE' }, turn: [{ text: `Saving.\n${saveMarker('second-guide', 'Gil Again')}` }] }]);
    try {
      const since = await chat(convoId, 'rundock-guide', 'KEEP-PLATFORM-SAVE make Gil a specialist');
      const msg = await firstLine(convoId, since);
      assert.deepStrictEqual([msg.type, msg.refused, msg.message], ['agent_error', true,
        'Doc asked to save the agent "second-guide", but Doc\'s own file and platform agents cannot be changed from a reply, so nothing was saved.']);
      await h.delay(300);
      assert.ok(fs.readFileSync(agentPath('second-guide')).equals(before), 'the platform agent is unchanged, byte for byte');
      assert.deepStrictEqual(linesFor(client.messages.slice(since), convoId).map((m) => m.type), ['agent_error'], 'one line, the refusal, and no save');
    } finally {
      h.reapConvo(convoId);
      // Put back however it ends, so a failure here cannot change the agent
      // the other cases in this file talk to.
      fs.writeFileSync(agentPath('second-guide'), before);
      h.internal.invalidateAgentCache();
    }
  });

  test('Doc\'s DELETE_AGENT of it is refused, and the file is unchanged', async () => {
    const convoId = h.freshConvoId('keepdelete');
    const before = fs.readFileSync(agentPath('second-guide'));
    h.writeScenario([{ match: { agent: 'rundock-guide', promptIncludes: 'KEEP-PLATFORM-DELETE' }, turn: [{ text: `Removing.\n${deleteMarker('second-guide')}` }] }]);
    try {
      const since = await chat(convoId, 'rundock-guide', 'KEEP-PLATFORM-DELETE remove Gil');
      const msg = await firstLine(convoId, since);
      assert.strictEqual(msg.type, 'agent_error', 'refused, not deleted');
      assert.match(msg.message, /platform agents/, 'and the line says why');
      await h.delay(300);
      assert.ok(fs.readFileSync(agentPath('second-guide')).equals(before), 'the platform agent is still there, byte for byte');
      assert.deepStrictEqual(linesFor(client.messages.slice(since), convoId).map((m) => m.type), ['agent_error'], 'one line, the refusal, and no delete');
    } finally {
      h.reapConvo(convoId);
      fs.writeFileSync(agentPath('second-guide'), before);
      h.internal.invalidateAgentCache();
    }
  });
});

describe('a marker in a turn that does not end with a result is not acted on', () => {
  test('a routine run by Doc changes nothing, read once the run has ended', async () => {
    const key = 'team-markers-routine';
    const reply = `${deleteMarker('routine-target')}\n${saveMarker('routine-made', 'Made')}`;
    seed('routine-target', 'Before');
    const before = fs.readFileSync(agentPath('routine-target'));
    h.clearInvocations();
    // Slower than a fixed wait would allow for, so only the run's own ending
    // can say the marker has been written.
    h.writeScenario([{ match: { promptIncludes: 'ROUTINE-MARKERS' }, delayMs: 800, turn: [{ text: reply }] }]);
    const since = client.messages.length;
    try {
      const doc = h.internal.discoverAgents().find((a) => a.id === 'rundock-guide');
      h.internal.executeRoutine(doc, { name: 'team-check', schedule: 'daily 09:00', prompt: 'ROUTINE-MARKERS tidy the team' }, key);
      // The run's ending, as the scheduler records it: the process wrote its
      // reply, markers and all, exited, and the outcome was recorded.
      assert.ok(await h.waitUntil(() => { const s = h.internal.routineState[key]; return !!s && s.status !== 'running'; }, { timeout: 15000 }), 'the run ended');
      assert.strictEqual(h.internal.routineState[key].status, 'completed', 'and completed');
      const given = h.readPrompts().filter((p) => p.prompt.includes('ROUTINE-MARKERS'));
      assert.deepStrictEqual(given.map((p) => [p.agent, p.matched]), [['rundock-guide', true]], 'the run was Doc\'s, and was given the reply with the markers');
      assert.ok(h.readStubOutputs().some((o) => o.agent === 'rundock-guide' && o.stdoutBytes > reply.length), 'and the reply left the process before it exited');
      // Everything the server sent before the outcome reaches this window
      // before the answer to a message sent after it.
      const asked = client.messages.length;
      client.send({ type: 'get_runtime_status' });
      await client.waitFor((m) => m.type === 'runtime_status', { since: asked, label: 'the answer sent after the outcome' });
      assert.ok(fs.existsSync(agentPath('routine-target')) && fs.readFileSync(agentPath('routine-target')).equals(before), 'nothing was deleted or changed, byte for byte');
      assert.strictEqual(fs.existsSync(agentPath('routine-made')), false, 'nothing was made');
      assert.deepStrictEqual(client.messages.slice(since).filter((m) => TEAM_LINES.includes(m.type)), [], 'and no line about the team');
    } finally {
      unseed('routine-target', 'routine-made');
    }
  });

  test('an orchestrator\'s turn intercepted by its own Agent call changes nothing', async () => {
    const convoId = h.freshConvoId('intercept');
    seed('intercept-target', 'Before');
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'INTERCEPTED' },
        turn: [{ text: `Removing it first.\n${deleteMarker('intercept-target')}` }, { agentTool: { subagent_type: 'content-lead', prompt: 'INTERCEPT-BRIEF' } }] },
      { match: { agent: 'content-lead', promptIncludes: 'INTERCEPT-BRIEF' }, turn: [{ text: 'Done. <!-- RUNDOCK:COMPLETE -->' }] },
      { match: { agent: 'chief-of-staff', promptIncludes: '[SYSTEM: pipeline-complete]' }, turn: [{ text: '<silent>' }] },
    ]);
    try {
      const since = client.messages.length;
      client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'INTERCEPTED go' });
      await client.waitFor((m) => m.type === 'result' && m._conversationId === convoId && m._agent === 'content-lead', { since, label: 'the delegate\'s result' });
      await client.waitFor((m) => m.type === 'system' && m.subtype === 'done' && m._conversationId === convoId && m._agent === 'chief-of-staff', { since, timeout: 5000, label: 'the orchestrator restored' });
      await h.delay(300);
      assert.strictEqual(readOrNull(agentPath('intercept-target')), teamFile('intercept-target', 'Before'), 'nothing was deleted');
      assert.deepStrictEqual(linesFor(client.messages.slice(since), convoId), [], 'the intercepted turn was not acted on, not even to refuse it');
    } finally {
      h.reapConvo(convoId);
      unseed('intercept-target');
    }
  });

  test('Doc\'s turn blocked for an off-roster Agent call changes nothing', async () => {
    const convoId = h.freshConvoId('offroster');
    seed('offroster-target', 'Before');
    h.writeScenario([
      { match: { agent: 'rundock-guide', promptIncludes: 'OFF-ROSTER' },
        turn: [{ text: `Removing it.\n${deleteMarker('offroster-target')}` }, { agentTool: { subagent_type: 'content-analyst', prompt: 'not yours' } }] },
      { match: { agent: 'rundock-guide', promptIncludes: 'delegation-blocked' }, turn: [{ text: 'Understood, carrying on.' }] },
    ]);
    try {
      const since = client.messages.length;
      client.send({ type: 'chat', conversationId: convoId, agent: 'rundock-guide', content: 'OFF-ROSTER go' });
      await client.waitFor((m) => m.type === 'result' && m._conversationId === convoId && m.result === 'Understood, carrying on.', { since, label: 'the resumed turn' });
      await h.delay(300);
      assert.strictEqual(readOrNull(agentPath('offroster-target')), teamFile('offroster-target', 'Before'), 'nothing was deleted');
      assert.deepStrictEqual(linesFor(client.messages.slice(since), convoId), [], 'the blocked turn was not acted on');
    } finally {
      h.reapConvo(convoId);
      unseed('offroster-target');
    }
  });

  test('Doc\'s turn that dies before its result changes nothing', async () => {
    const convoId = h.freshConvoId('crash');
    seed('crash-target', 'Before');
    // The marker reaches the server as streamed text, then the process dies
    // with no result.
    const streamed = [fx.contentBlockStartText(), fx.textDelta(`Removing it.\n${deleteMarker('crash-target')}`)].map((e) => JSON.stringify(e)).join('\n');
    h.writeScenario([{ match: { agent: 'rundock-guide', promptIncludes: 'CRASH-TURN' }, crash: 1, crashTail: `${streamed}\n{"type":"stream_event"` }]);
    try {
      const since = client.messages.length;
      client.send({ type: 'chat', conversationId: convoId, agent: 'rundock-guide', content: 'CRASH-TURN go' });
      await client.waitFor((m) => m.type === 'stream_event' && m._conversationId === convoId && JSON.stringify(m).includes('crash-target'), { since, label: 'the marker streamed' });
      await client.waitFor((m) => m.type === 'system' && m.subtype === 'done' && m._conversationId === convoId, { since, label: 'the turn ended' });
      await h.delay(300);
      assert.strictEqual(readOrNull(agentPath('crash-target')), teamFile('crash-target', 'Before'), 'nothing was deleted');
      assert.deepStrictEqual(linesFor(client.messages.slice(since), convoId), [], 'and no line about the team');
    } finally {
      h.reapConvo(convoId);
      unseed('crash-target');
    }
  });

  test('Doc\'s turn the person cancels changes nothing, even when the runtime finishes it after the cancel', async () => {
    const convoId = h.freshConvoId('cancel');
    seed('cancel-target', 'Before');
    const before = fs.readFileSync(agentPath('cancel-target'));
    // Long, so the reply's three copies in a whole turn (streamed, in the
    // assistant message, in the result) outweigh everything else it writes.
    const reply = `Removing it.\n${deleteMarker('cancel-target')}\n${'Still finishing. '.repeat(200)}`;
    // The marker streams, then the turn waits for a file never written. The
    // cancel's SIGTERM is what makes the runtime finish it.
    h.writeScenario([{ match: { agent: 'rundock-guide', promptIncludes: 'CANCEL-TURN' },
      holdAfterText: path.join(h.workspaceDir, `never-${convoId}`), finishOnSigterm: true, turn: [{ text: reply }] }]);
    try {
      const since = client.messages.length;
      client.send({ type: 'chat', conversationId: convoId, agent: 'rundock-guide', content: 'CANCEL-TURN remove it' });
      await client.waitFor((m) => m.type === 'stream_event' && m._conversationId === convoId && JSON.stringify(m).includes('cancel-target'), { since, label: 'the marker streamed' });
      const child = h.internal.chatProcesses.get(convoId).process;
      // The server's own child, closed once every byte it wrote has been read
      // and handled.
      const closed = new Promise((resolve) => child.once('close', resolve));
      client.send({ type: 'cancel', conversationId: convoId });
      await client.waitFor((m) => m.type === 'system' && m.subtype === 'cancelled' && m._conversationId === convoId, { since, label: 'the cancel' });
      await closed;
      const out = h.readStubOutputs().find((o) => o.pid === child.pid);
      assert.ok(out, 'the runtime finished its turn and exited on its own');
      assert.ok(out.stdoutBytes > 3 * reply.length, 'having written the whole turn, its result included');
      // Everything the server sent before the child closed reaches this
      // window before the answer to a message sent after it.
      const asked = client.messages.length;
      client.send({ type: 'get_runtime_status' });
      await client.waitFor((m) => m.type === 'runtime_status', { since: asked, label: 'the answer sent after the close' });
      assert.ok(fs.existsSync(agentPath('cancel-target')) && fs.readFileSync(agentPath('cancel-target')).equals(before), 'nothing was deleted or changed, byte for byte');
      assert.deepStrictEqual(linesFor(client.messages.slice(since), convoId), [], 'no confirmation, and no line about the team at all');
    } finally {
      h.reapConvo(convoId);
      unseed('cancel-target');
    }
  });
});

describe('when the decision fails, nothing is written and the next turn still works', () => {
  // Each failure is forced through a module attribute, the only seams there
  // are, and put back before the next turn, which must then write.
  const FAILURES = [
    ['the scan throws', () => { const was = teamMarkers.seams.scan; teamMarkers.seams.scan = () => { throw new Error('scan broke'); }; return () => { teamMarkers.seams.scan = was; }; },
      /could not read the changes to the team/],
    ['the author lookup finds nobody', () => { const was = teamMarkers.seams.authorOf; teamMarkers.seams.authorOf = () => null; return () => { teamMarkers.seams.authorOf = was; }; },
      /^An agent asked to save the agent "fail-made", but only Doc can change the team/],
    ['the author lookup throws', () => { const was = teamMarkers.seams.authorOf; teamMarkers.seams.authorOf = () => { throw new Error('lookup broke'); }; return () => { teamMarkers.seams.authorOf = was; }; },
      /^An agent asked to save the agent "fail-made", but only Doc can change the team/],
    ['the write throws', () => { const was = teamHandlers.handleSaveAgent; teamHandlers.handleSaveAgent = () => { throw new Error('disk full'); }; return () => { teamHandlers.handleSaveAgent = was; }; },
      /^Doc asked to save the agent "fail-made", but it could not be done \(disk full\)/],
  ];
  for (const [label, breakIt, line] of FAILURES) {
    test(label, async () => {
      const convoId = h.freshConvoId('fail');
      h.writeScenario([{ match: { agent: 'rundock-guide', promptIncludes: 'FAIL-CLOSED' }, turn: [{ text: `Making it.\n${saveMarker('fail-made', 'Made')}` }] }]);
      // Cleaned up however it ends, so a failure here cannot leave a file
      // behind for the next case to trip over.
      try {
        const restore = breakIt();
        try {
          const since = await chat(convoId, 'rundock-guide', 'FAIL-CLOSED make it');
          const { msg } = await client.waitFor((m) => m.type === 'agent_error' && m.conversationId === convoId, { since, timeout: 4000, label: 'the line' });
          assert.match(msg.message, line);
          assert.strictEqual(fs.existsSync(agentPath('fail-made')), false, 'nothing was written');
        } finally {
          restore();
        }
        const since = await chat(convoId, 'rundock-guide', 'FAIL-CLOSED again');
        await client.waitFor((m) => m.type === 'agent_saved' && m.agentId === 'fail-made' && m.conversationId === convoId, { since, timeout: 4000, label: 'the next turn\'s save' });
        assert.strictEqual(readOrNull(agentPath('fail-made')), teamFile('fail-made', 'Made'), 'the next turn wrote it');
      } finally {
        h.reapConvo(convoId);
        unseed('fail-made');
      }
    });
  }
});

describe('a write that fails partway leaves the agents and skills as they were', () => {
  // A FULL DISK, AT EVERY STEP. Each change is made again and again, with a
  // different step of its write failing each time: the nth step that writes
  // into .claude (a folder made, a file opened for writing, a write into one,
  // a flush, or a rename onto a name there) fails with ENOSPC, and a write
  // that fails lands half its bytes first, as a write cut short does. Every
  // step after that runs as it would, so what the writer does to clean up is
  // what the disk shows. The run that reaches no failing step is the change
  // going through. The fs functions are module attributes, patched only for
  // the length of one change, which runs in-process as Doc's marker does.
  const enospc = () => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
  function failingAt(n, fn) {
    const folder = path.join(h.workspaceDir, '.claude');
    const roots = [folder, fs.realpathSync(folder)];
    const inside = (p) => typeof p === 'string' && roots.some((root) => path.resolve(p).startsWith(root + path.sep));
    const real = {
      mkdirSync: fs.mkdirSync, openSync: fs.openSync, closeSync: fs.closeSync, writeSync: fs.writeSync,
      writeFileSync: fs.writeFileSync, fsyncSync: fs.fsyncSync, renameSync: fs.renameSync,
    };
    const opened = new Set();
    let steps = 0;
    let depth = 0;
    // One call is one step, whatever calls it makes inside itself.
    const run = (name, args) => { depth += 1; try { return real[name].apply(fs, args); } finally { depth -= 1; } };
    const fails = (target) => {
      if (depth > 0 || !(typeof target === 'number' ? opened.has(target) : inside(target))) return false;
      steps += 1;
      return steps === n;
    };
    const half = (data, offset = 0, length = null) => {
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
      const end = length === null ? bytes.length : offset + length;
      return bytes.subarray(offset, offset + Math.floor((end - offset) / 2));
    };
    fs.mkdirSync = function (p, ...rest) { if (fails(p)) throw enospc(); return run('mkdirSync', [p, ...rest]); };
    fs.openSync = function (p, flags, ...rest) {
      const writing = typeof flags === 'number'
        ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) !== 0
        : /[wa+]/.test(String(flags || 'r'));
      if (writing && fails(p)) throw enospc();
      const fd = run('openSync', [p, flags, ...rest]);
      if (writing && inside(p)) opened.add(fd);
      return fd;
    };
    fs.closeSync = function (fd, ...rest) { opened.delete(fd); return run('closeSync', [fd, ...rest]); };
    fs.writeSync = function (fd, data, ...rest) {
      if (!fails(fd)) return run('writeSync', [fd, data, ...rest]);
      run('writeSync', [fd, Buffer.isBuffer(data) && typeof rest[0] === 'number' ? half(data, rest[0], typeof rest[1] === 'number' ? rest[1] : null) : half(data)]);
      throw enospc();
    };
    fs.writeFileSync = function (target, data, ...rest) {
      if (!fails(target)) return run('writeFileSync', [target, data, ...rest]);
      run(typeof target === 'number' ? 'writeSync' : 'writeFileSync', [target, half(data)]);
      throw enospc();
    };
    fs.fsyncSync = function (fd, ...rest) { if (fails(fd)) throw enospc(); return run('fsyncSync', [fd, ...rest]); };
    fs.renameSync = function (from, to, ...rest) { if (fails(to)) throw enospc(); return run('renameSync', [from, to, ...rest]); };
    try { fn(); } finally { Object.assign(fs, real); }
    return steps;
  }

  // Every file and folder under .claude/agents and .claude/skills, each file
  // with its bytes, so a file left behind, a temporary one included, shows.
  function tree() {
    const found = {};
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir).sort()) {
        const p = path.join(dir, name);
        const key = path.relative(h.workspaceDir, p).split(path.sep).join('/');
        if (fs.statSync(p).isDirectory()) { found[`${key}/`] = ''; walk(p); } else found[key] = fs.readFileSync(p).toString('base64');
      }
    };
    for (const sub of ['agents', 'skills']) {
      const dir = path.join(h.workspaceDir, '.claude', sub);
      if (fs.existsSync(dir)) walk(dir);
    }
    return found;
  }

  // The change made with its first step failing, then its second, and so on,
  // until a run reaches no failing step. Returns what each failing step left
  // wrong (nothing, for a sound writer), how many steps could fail, and the
  // outcome of the run that went through.
  function everyStepFailing(prepare, change) {
    const wrong = [];
    for (let n = 1; n <= 40; n++) {
      prepare();
      const before = tree();
      let outcomes = [];
      if (failingAt(n, () => { outcomes = change(); }) < n) return { wrong, failingSteps: n - 1, outcome: outcomes[0] && outcomes[0].outcome };
      const outcome = outcomes[0] ? outcomes[0].outcome : 'nothing';
      if (outcome !== 'error') wrong.push(`step ${n}: answered ${outcome}`);
      const after = tree();
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (!(key in before)) wrong.push(`step ${n}: ${key} was left behind`);
        else if (!(key in after)) wrong.push(`step ${n}: ${key} is gone`);
        else if (before[key] !== after[key]) wrong.push(`step ${n}: ${key} changed`);
      }
    }
    throw new Error('the change never got past its failing steps');
  }

  const skillPath = (name) => path.join(h.workspaceDir, '.claude', 'skills', name, 'SKILL.md');
  const skillFile = (name, label) => `---\nname: ${name}\ndescription: An example skill.\n---\n\n${label}.`;
  // A new agent with neither type nor order, which the save gives both.
  const bareAgent = (name) => `---\nname: ${name}\ndescription: An example agent\n---\n\nYou are ${name}.`;
  function setSkill(name, content) {
    fs.rmSync(path.dirname(skillPath(name)), { recursive: true, force: true });
    if (content !== null) {
      fs.mkdirSync(path.dirname(skillPath(name)), { recursive: true });
      fs.writeFileSync(skillPath(name), content);
    }
    h.internal.invalidateAgentCache();
  }

  test('a new agent missing type and order: no failing step leaves a file, and the next turn writes it', async () => {
    const name = 'partway-made';
    const convoId = h.freshConvoId('partway');
    const save = () => h.asDoc({ type: 'save_agent', name, content: bareAgent(name), conversationId: convoId });
    try {
      const { wrong, failingSteps, outcome } = everyStepFailing(() => unseed(name), save);
      assert.deepStrictEqual(wrong, [], 'every failing step was answered as an error and left the agents and skills as they were');
      assert.ok(failingSteps >= 1, 'the write had a step to fail');
      assert.strictEqual(outcome, 'saved', 'the run with no failing step saved it');

      // The second step fails, after the first has been taken, and then a
      // turn of Doc's through the runtime makes the same change.
      unseed(name);
      const before = tree();
      const since = client.messages.length;
      failingAt(2, save);
      assert.deepStrictEqual(tree(), before, 'nothing was left by the failed write');
      await client.waitFor((m) => m.type === 'agent_error' && m.conversationId === convoId && /could not be done/.test(m.message), { since, label: 'the error line' });
      h.writeScenario([{ match: { agent: 'rundock-guide', promptIncludes: 'PARTWAY-NEXT' },
        turn: [{ text: `Making it.\n<!-- RUNDOCK:SAVE_AGENT name=${name} -->\n${bareAgent(name)}\n<!-- /RUNDOCK:SAVE_AGENT -->` }] }]);
      const next = await chat(convoId, 'rundock-guide', 'PARTWAY-NEXT make it');
      await client.waitFor((m) => m.type === 'agent_saved' && m.agentId === name && m.conversationId === convoId, { since: next, label: 'the next turn\'s save' });
      const saved = fs.readFileSync(agentPath(name), 'utf-8');
      assert.match(saved, /^type: specialist$/m, 'given a type');
      assert.match(saved, /^order: \d+$/m, 'and an order');
    } finally {
      h.reapConvo(convoId);
      unseed(name);
    }
  });

  const OTHERS = [
    ['an existing agent: no failing step changes its bytes', 'partway-saved',
      (name) => seed(name, 'Before'),
      (name) => h.asDoc({ type: 'save_agent', name, content: teamFile(name, 'After') }),
      'updated', (name) => assert.strictEqual(readOrNull(agentPath(name)), teamFile(name, 'After')),
      (name) => unseed(name)],
    ['a new skill: no failing step leaves a file or its folder', 'partway-skill',
      (name) => setSkill(name, null),
      (name) => h.asDoc({ type: 'save_skill', name, content: skillFile(name, 'After') }),
      'saved', (name) => assert.strictEqual(readOrNull(skillPath(name)), skillFile(name, 'After')),
      (name) => setSkill(name, null)],
    ['an existing skill: no failing step changes its bytes', 'partway-old-skill',
      (name) => setSkill(name, skillFile(name, 'Before')),
      (name) => h.asDoc({ type: 'save_skill', name, content: skillFile(name, 'After') }),
      'updated', (name) => assert.strictEqual(readOrNull(skillPath(name)), skillFile(name, 'After')),
      (name) => setSkill(name, null)],
  ];
  for (const [label, name, prepare, change, went, check, clear] of OTHERS) {
    test(label, () => {
      try {
        const { wrong, failingSteps, outcome } = everyStepFailing(() => prepare(name), () => change(name));
        assert.deepStrictEqual(wrong, [], 'every failing step was answered as an error and left the agents and skills as they were');
        assert.ok(failingSteps >= 1, 'the write had a step to fail');
        assert.strictEqual(outcome, went, 'the run with no failing step went through');
        check(name);
      } finally {
        clear(name);
      }
    });
  }
});

describe('the sequences', () => {
  test('two windows: Doc\'s marker writes once, and each window is told once', async () => {
    const convoId = h.freshConvoId('twowin');
    const second = await h.connect();
    h.writeScenario([{ match: { agent: 'rundock-guide', promptIncludes: 'TWO-WINDOWS' }, turn: [{ text: `Made.\n${saveMarker('twowin-made', 'Made')}` }] }]);
    try {
      const sinceSecond = second.messages.length;
      const since = await chat(convoId, 'rundock-guide', 'TWO-WINDOWS make it');
      await second.waitFor((m) => m.type === 'agent_saved' && m.conversationId === convoId, { since: sinceSecond, label: 'the second window told' });
      await h.delay(300);
      for (const [label, window, from] of [['the window that sent it', client, since], ['the other window', second, sinceSecond]]) {
        const lines = linesFor(window.messages.slice(from), convoId);
        assert.deepStrictEqual(lines.map((m) => [m.type, m.agentId, m.updated]), [['agent_saved', 'twowin-made', false]], `${label}: one confirmation, saying created`);
      }
      assert.strictEqual(readOrNull(agentPath('twowin-made')), teamFile('twowin-made', 'Made'));
    } finally {
      second.close();
      h.reapConvo(convoId);
      unseed('twowin-made');
    }
  });

  test('the retry: a specialist\'s same marker in two turns is refused both times', async () => {
    const convoId = h.freshConvoId('retry');
    seed('retry-target', 'Before');
    h.writeScenario([{ match: { agent: 'content-lead', promptIncludes: 'RETRY-MARKER' }, turn: [{ text: saveMarker('retry-target', 'Retried') }] }]);
    try {
      for (const attempt of ['first', 'second']) {
        const since = await chat(convoId, 'content-lead', `RETRY-MARKER ${attempt}`);
        const msg = await refusal(convoId, 'Wren', 'save the agent "retry-target"', since);
        assert.strictEqual(msg.message, 'Wren asked to save the agent "retry-target", but only Doc can change the team, so nothing was saved. Ask Doc to make this change.',
          'the line the conversation shows, word for word, with the agent\'s display name');
        assert.strictEqual(readOrNull(agentPath('retry-target')), teamFile('retry-target', 'Before'), `${attempt} turn: unchanged`);
      }
    } finally {
      h.reapConvo(convoId);
      unseed('retry-target');
    }
  });

  test('the inverse: a specialist\'s DELETE_AGENT is refused, and Doc\'s removes the file', async () => {
    const convoId = h.freshConvoId('inverse');
    seed('inverse-target', 'Before');
    h.writeScenario([
      { match: { agent: 'content-lead', promptIncludes: 'INVERSE-DELETE' }, turn: [{ text: deleteMarker('inverse-target') }] },
      { match: { agent: 'rundock-guide', promptIncludes: 'INVERSE-DELETE' }, turn: [{ text: deleteMarker('inverse-target') }] },
    ]);
    try {
      let since = await chat(convoId, 'content-lead', 'INVERSE-DELETE remove it');
      await refusal(convoId, 'Wren', 'delete the agent "inverse-target"', since);
      assert.strictEqual(readOrNull(agentPath('inverse-target')), teamFile('inverse-target', 'Before'), 'the specialist removed nothing');
      h.reapConvo(convoId);
      since = await chat(convoId, 'rundock-guide', 'INVERSE-DELETE remove it');
      await client.waitFor((m) => m.type === 'agent_deleted' && m.agentId === 'inverse-target' && m.conversationId === convoId, { since, label: 'Doc\'s delete' });
      assert.strictEqual(fs.existsSync(agentPath('inverse-target')), false, 'Doc removed it');
    } finally {
      h.reapConvo(convoId);
      unseed('inverse-target');
    }
  });

  test('the undo: Doc saves then deletes an agent, and a specialist cannot put it back', async () => {
    const convoId = h.freshConvoId('undo');
    h.writeScenario([
      { match: { agent: 'rundock-guide', promptIncludes: 'UNDO-SAVE' }, turn: [{ text: saveMarker('undo-made', 'Made') }] },
      { match: { agent: 'rundock-guide', promptIncludes: 'UNDO-DELETE' }, turn: [{ text: deleteMarker('undo-made') }] },
      { match: { agent: 'content-lead', promptIncludes: 'UNDO-RESTORE' }, turn: [{ text: saveMarker('undo-made', 'Restored') }] },
    ]);
    try {
      let since = await chat(convoId, 'rundock-guide', 'UNDO-SAVE make it');
      await client.waitFor((m) => m.type === 'agent_saved' && m.agentId === 'undo-made' && m.conversationId === convoId, { since, label: 'saved' });
      assert.strictEqual(readOrNull(agentPath('undo-made')), teamFile('undo-made', 'Made'), 'saved on disk');
      since = await chat(convoId, 'rundock-guide', 'UNDO-DELETE remove it');
      await client.waitFor((m) => m.type === 'agent_deleted' && m.agentId === 'undo-made' && m.conversationId === convoId, { since, label: 'deleted' });
      assert.strictEqual(fs.existsSync(agentPath('undo-made')), false, 'deleted on disk');
      h.reapConvo(convoId);
      since = await chat(convoId, 'content-lead', 'UNDO-RESTORE put it back');
      await refusal(convoId, 'Wren', 'save the agent "undo-made"', since);
      assert.strictEqual(fs.existsSync(agentPath('undo-made')), false, 'still gone');
    } finally {
      h.reapConvo(convoId);
      unseed('undo-made');
    }
  });

  test('the next step: an orchestrator refused for its own marker hands the change to Doc, whose marker writes once', async () => {
    const convoId = h.freshConvoId('nextstep');
    h.writeScenario([
      { match: { agent: 'chief-of-staff', promptIncludes: 'NEXT-STEP-OWN' }, turn: [{ text: `Making it myself.\n${saveMarker('nextstep-made', 'Own')}` }] },
      { match: { agent: 'chief-of-staff', promptIncludes: 'NEXT-STEP-DOC' },
        turn: [{ agentTool: { subagent_type: 'rundock-guide', prompt: 'NEXT-STEP-BRIEF make it' } }] },
      { match: { agent: 'rundock-guide', promptIncludes: 'NEXT-STEP-BRIEF' }, turn: [{ text: `Made.\n${saveMarker('nextstep-made', 'By Doc')}` }] },
      { match: { agent: 'chief-of-staff', promptIncludes: '[SYSTEM: pipeline-complete]' }, turn: [{ text: '<silent>' }] },
    ]);
    try {
      let since = await chat(convoId, 'chief-of-staff', 'NEXT-STEP-OWN make it');
      await refusal(convoId, 'Cos', 'save the agent "nextstep-made"', since);
      assert.strictEqual(fs.existsSync(agentPath('nextstep-made')), false, 'the orchestrator wrote nothing');
      since = client.messages.length;
      client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'NEXT-STEP-DOC ask Doc' });
      // Doc, brought in by the orchestrator, has its change carded, and an
      // Allow on the card writes it (lib/agents/team-markers.js).
      const { msg: card } = await client.waitFor((m) => m.type === 'control_request' && m._conversationId === convoId && m.request.tool_name === 'SaveAgent', { since, label: 'the card' });
      client.send({ type: 'permission_response', requestId: card.request_id, conversationId: convoId, allow: true, card: true });
      await client.waitFor((m) => m.type === 'agent_saved' && m.agentId === 'nextstep-made' && m.conversationId === convoId, { since, timeout: 5000, label: 'Doc\'s save' });
      await client.waitFor((m) => m.type === 'system' && m.subtype === 'process_started' && m._conversationId === convoId && m._agent === 'chief-of-staff' && m.autoContinue, { since, label: 'the orchestrator restored' });
      await h.delay(300);
      assert.strictEqual(readOrNull(agentPath('nextstep-made')), teamFile('nextstep-made', 'By Doc'), 'Doc\'s file, on disk');
      assert.strictEqual(linesFor(client.messages.slice(since), convoId).length, 1, 'one line: the save, once');
    } finally {
      h.reapConvo(convoId);
      unseed('nextstep-made');
    }
  });
});
