'use strict';
// A REPLY THAT ENDS AFTER A WORKSPACE SWITCH STAYS IN THE WORKSPACE IT BELONGS TO.
//
// A switch stops the running agent and moves the workspace root in one step,
// but the stopped process's last output is still read afterwards. Its row was
// saved to whichever workspace was open by then, so the whole conversation, the
// person's earlier messages included, was written into the workspace just
// opened, where the next agent there could be handed it.
//
// Each case starts a conversation in the suite's own workspace with the reply
// held after its text and a second message behind it, so the switch's own
// SIGTERM is what makes the runtime finish the reply, every time. The page's
// messages say when that reply has been handled: its result is sent in the
// same step that stores its row.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');
const { makeWorkspace, standardTeam } = require('../helpers/workspace.js');

let client;

before(async () => {
  await h.boot();
  client = await h.connect();
});
after(h.shutdown);

const transcriptFile = (dir, id) => path.join(dir, '.rundock', 'transcripts', `${id}.json`);
function rowsIn(dir, id) {
  assert.ok(fs.existsSync(transcriptFile(dir, id)), 'the conversation has a transcript in the workspace it happened in');
  return JSON.parse(fs.readFileSync(transcriptFile(dir, id), 'utf-8'));
}

// Every file under a workspace's .rundock folder, searched all the way down,
// whose name or contents hold any of the markers.
function holding(dir, markers) {
  const root = path.join(dir, '.rundock');
  const found = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.isFile()) continue;
      const text = e.name + '\n' + fs.readFileSync(p, 'utf-8');
      for (const m of markers) if (text.includes(m)) found.push(`${path.relative(root, p)} holds ${m}`);
    }
  };
  walk(root);
  return found;
}

async function switchTo(request, label) {
  const since = client.messages.length;
  client.send(request);
  const { msg } = await client.waitFor((m) => m.type === 'workspace_set' || m.type === 'workspace_error', { since, label });
  assert.strictEqual(msg.type, 'workspace_set', `${label} failed: ${msg.message}`);
  return msg.path;
}
// Back to the suite's own workspace, as the window chooses one.
const back = () => switchTo({ type: 'set_workspace', path: h.workspaceDir }, 'the switch back');
const anotherWorkspace = (name) => makeWorkspace({ claudeMd: `# ${name} fixture\n`, agents: standardTeam() });

// A conversation in the suite's own workspace: the first message's reply has
// streamed its text and holds the rest, and a second message has been written
// to the same running agent behind it, never to be answered. Returns the three
// markers: one in each message and one in the reply.
async function heldReply(id) {
  const tag = crypto.randomBytes(4).toString('hex');
  const marks = { first: `ASK-ONE-${tag}`, second: `ASK-TWO-${tag}`, reply: `REPLY-${tag}` };
  const never = path.join(h.workspaceDir, `never-${id}`);
  const reply = `${marks.reply} The plan is in the shared folder, under this quarter.`;
  h.writeScenario([
    { match: { agent: 'chief-of-staff', promptIncludes: marks.first }, holdAfterText: never, finishOnSigterm: true, turn: [{ text: reply }] },
    { match: { agent: 'chief-of-staff', promptIncludes: marks.second }, untilFile: never, turn: [{ text: 'NEVER-ANSWERED' }] },
  ]);
  const first = `${marks.first} where is the plan?`;
  const second = `${marks.second} and the budget?`;
  const since = client.messages.length;
  client.send({ type: 'chat', conversationId: id, agent: 'chief-of-staff', content: first });
  // The text block's end is the last thing written before the hold, so the
  // whole text has been read by the time it arrives.
  await client.waitFor((m) => m.type === 'stream_event' && m._conversationId === id && m.event && m.event.type === 'content_block_stop',
    { since, label: 'the reply text streamed' });
  const asked = client.messages.length;
  client.send({ type: 'chat', conversationId: id, agent: 'chief-of-staff', content: second });
  await client.waitFor((m) => m.type === 'system' && m.subtype === 'process_started' && m._conversationId === id,
    { since: asked, label: 'the second message written to the running agent' });
  return { marks, first, second, reply, since };
}

// The reply's result, which is sent in the step that stores its row.
async function replyHandled(id, { marks, since }) {
  await client.waitFor((m) => m.type === 'result' && m._conversationId === id && String(m.result || '').includes(marks.reply),
    { since, label: 'the reply finished after the switch', timeout: 15000 });
}

// The first workspace holds the person's two messages and the reply once,
// read from its own disk; opened again from there, the reply is shown once.
async function keptInFirst(id, held) {
  assert.deepStrictEqual(rowsIn(h.workspaceDir, id).map((r) => `${r.role}: ${r.text}`),
    [`user: ${held.first}`, `user: ${held.second}`, `agent: ${held.reply}`],
    'the person\'s two messages, then the reply once');
  await back();
  const since = client.messages.length;
  client.send({ type: 'get_session_history', conversationId: id, sessionId: null, sessionIds: [], limit: 200 });
  const { msg } = await client.waitFor((m) => m.type === 'session_history' && m.conversationId === id, { since, label: 'the conversation opened again' });
  const shown = msg.messages.map((m) => String(m.content || ''));
  assert.strictEqual(shown.filter((t) => t.includes(held.marks.reply)).length, 1, 'opened again, it shows the reply once');
  assert.strictEqual(shown.filter((t) => t.includes(held.marks.first)).length, 1, 'and the first message once');
  assert.strictEqual(shown.filter((t) => t.includes(held.marks.second)).length, 1, 'and the second message once');
}

function nothingIn(dir, id, { marks }) {
  assert.strictEqual(fs.existsSync(transcriptFile(dir, id)), false, 'the workspace opened has no transcript for the conversation');
  assert.deepStrictEqual(holding(dir, [marks.first, marks.second, marks.reply]), [],
    'and nothing under its .rundock folder holds a word of it');
}

describe('a reply that ends after the person switches workspace', () => {
  test('a reply that ends after set_workspace writes nothing into the workspace opened, and is kept in the first', async () => {
    const id = h.freshConvoId('late-set');
    const second = anotherWorkspace('Second');
    let held;
    try {
      held = await heldReply(id);
      await switchTo({ type: 'set_workspace', path: second }, 'the switch');
      await replyHandled(id, held);
      nothingIn(second, id, held);
      await keptInFirst(id, held);
    } finally {
      if (h.internal.getWorkspace() !== h.workspaceDir) await back();
      h.reapConvo(id);
    }
  });

  test('a reply that ends after create_workspace writes nothing into the workspace created, and is kept in the first', async () => {
    const id = h.freshConvoId('late-create');
    let held;
    try {
      held = await heldReply(id);
      const created = await switchTo({ type: 'create_workspace', name: `example ${id}` }, 'the new workspace');
      await replyHandled(id, held);
      nothingIn(created, id, held);
      await keptInFirst(id, held);
    } finally {
      if (h.internal.getWorkspace() !== h.workspaceDir) await back();
      h.reapConvo(id);
    }
  });

  test('a reply that ends after two switches writes nothing into either workspace opened, and is kept in the first', async () => {
    const id = h.freshConvoId('late-twice');
    const second = anotherWorkspace('Second');
    const third = anotherWorkspace('Third');
    let held;
    try {
      held = await heldReply(id);
      // The first switch's SIGTERM makes the runtime finish the reply; nothing
      // it writes is read until both switches are done, so the reply ends
      // after the second one every time.
      const output = h.internal.chatProcesses.get(id).process.stdout;
      output.pause();
      try {
        await switchTo({ type: 'set_workspace', path: second }, 'the first switch');
        await switchTo({ type: 'set_workspace', path: third }, 'the second switch');
      } finally {
        output.resume();
      }
      await replyHandled(id, held);
      nothingIn(second, id, held);
      nothingIn(third, id, held);
      await keptInFirst(id, held);
    } finally {
      if (h.internal.getWorkspace() !== h.workspaceDir) await back();
      h.reapConvo(id);
    }
  });
});

// AS BEFORE WHEN NO REPLY IS RUNNING ACROSS A SWITCH.
//
// These pass without the fix as well, by design: they pin what a conversation
// with nothing in flight across a switch already did. Each names the test
// above that shares its setup and fails without the fix.
describe('a conversation with no reply running across a switch', () => {
  const asked = (tag, n) => `ASK-${n}-${tag} where is the plan?`;
  const answer = (tag, n) => `ANSWER-${n}-${tag}`;
  const rules = (tag, ...ns) => ns.map((n) => ({ match: { agent: 'chief-of-staff', promptIncludes: `ASK-${n}-${tag}` }, turn: [{ text: answer(tag, n) }] }));
  const said = (dir, id) => rowsIn(dir, id).map((r) => `${r.role}: ${r.text}`);
  async function answered(id, content) {
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: id, agent: 'chief-of-staff', content });
    await client.waitFor((m) => m.type === 'result' && m._conversationId === id, { since, label: 'the reply', timeout: 15000 });
  }

  // Shares its start with 'a reply that ends after set_workspace writes
  // nothing into the workspace opened, and is kept in the first', which fails
  // without the fix.
  test('a conversation started in a workspace saves there', async () => {
    const id = h.freshConvoId('stays');
    const tag = crypto.randomBytes(4).toString('hex');
    h.writeScenario(rules(tag, 1));
    try {
      await answered(id, asked(tag, 1));
      assert.deepStrictEqual(said(h.workspaceDir, id), [`user: ${asked(tag, 1)}`, `agent: ${answer(tag, 1)}`]);
    } finally {
      h.reapConvo(id);
    }
  });

  // Shares its switch with 'a reply that ends after set_workspace writes
  // nothing into the workspace opened, and is kept in the first', which fails
  // without the fix.
  test('after a switch with no reply running, a new conversation in the workspace opened saves there, and nothing in the first', async () => {
    const id = h.freshConvoId('opened');
    const tag = crypto.randomBytes(4).toString('hex');
    const second = anotherWorkspace('Second');
    fs.writeFileSync(path.join(second, 'stub-scenario.json'), JSON.stringify({ rules: rules(tag, 1) }));
    try {
      await switchTo({ type: 'set_workspace', path: second }, 'the switch');
      await answered(id, asked(tag, 1));
      assert.deepStrictEqual(said(second, id), [`user: ${asked(tag, 1)}`, `agent: ${answer(tag, 1)}`]);
      assert.strictEqual(fs.existsSync(transcriptFile(h.workspaceDir, id)), false, 'nothing for it in the workspace left');
    } finally {
      if (h.internal.getWorkspace() !== h.workspaceDir) await back();
      h.reapConvo(id);
    }
  });

  // Shares its switch and its way back with 'a reply that ends after
  // set_workspace writes nothing into the workspace opened, and is kept in the
  // first', which fails without the fix.
  test('after a switch and back, a follow-up in the first workspace conversation appends to its transcript there', async () => {
    const id = h.freshConvoId('follow');
    const tag = crypto.randomBytes(4).toString('hex');
    const second = anotherWorkspace('Second');
    h.writeScenario(rules(tag, 1, 2));
    try {
      await answered(id, asked(tag, 1));
      await switchTo({ type: 'set_workspace', path: second }, 'the switch');
      await back();
      await answered(id, asked(tag, 2));
      assert.deepStrictEqual(said(h.workspaceDir, id), [
        `user: ${asked(tag, 1)}`, `agent: ${answer(tag, 1)}`, `user: ${asked(tag, 2)}`, `agent: ${answer(tag, 2)}`,
      ]);
      assert.strictEqual(fs.existsSync(transcriptFile(second, id)), false, 'nothing for it in the workspace visited');
    } finally {
      if (h.internal.getWorkspace() !== h.workspaceDir) await back();
      h.reapConvo(id);
    }
  });

  // Shares its held reply and its switch with 'a reply that ends after
  // set_workspace writes nothing into the workspace opened, and is kept in the
  // first', which fails without the fix.
  test('a transcript read after the switch back holds the late reply once', async () => {
    const id = h.freshConvoId('late-read');
    const second = anotherWorkspace('Second');
    try {
      const held = await heldReply(id);
      await switchTo({ type: 'set_workspace', path: second }, 'the switch');
      await replyHandled(id, held);
      await back();
      const rows = h.internal.loadTranscript(id);
      assert.strictEqual(rows.filter((r) => String(r.text || '').includes(held.marks.reply)).length, 1, 'the late reply, once');
    } finally {
      if (h.internal.getWorkspace() !== h.workspaceDir) await back();
      h.reapConvo(id);
    }
  });
});
