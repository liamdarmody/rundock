'use strict';
// A reply that shows an agent file without a save marker saves nothing.
//
// THE DEFECT. When the marker scan found no save or delete, the client fell
// back to looking for anything shaped like an agent file (frontmatter with a
// `name:` line and `type: orchestrator` or `type: specialist`, fenced or not)
// and asked the server to save it. So a reply that only SHOWED an agent file,
// for the person to read and approve, wrote it at the preview, before the yes.
// The server's save replaces any file of that name and keeps no copy, so an
// existing agent could be overwritten by its own preview.
//
// THE RULE NOW. The client asks the server to write or delete an agent or
// skill file only for an action the marker scan returned. Text that merely
// looks like an agent file is text.
//
// HOW IT IS TESTED. handleResult lives in app.js, the page's own script, which
// cannot be required. So it is cut out of the source and RUN, against a socket
// that records what is sent, the real marker scan, and stubs for the render
// half it hands over to. A copy of its logic would stay green if the real one
// changed; the real one cannot. The source pins below then cover what a run
// cannot: a second route that builds a save from reply text in some shape no
// input here happens to exercise.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const MARKERS_SRC = fs.readFileSync(path.join(ROOT, 'public', 'markers.js'), 'utf8');
const markers = require('../../public/markers.js');

// handleResult, cut out whole: from its declaration to the first closing
// brace at the start of a line. Refuses when either end is missing, so a
// rename fails here by name rather than evaluating nothing.
function handleResultSource() {
  const start = APP_SRC.indexOf('\nfunction handleResult(d, convoId) {');
  assert.ok(start > -1, 'app.js no longer declares handleResult(d, convoId)');
  const end = APP_SRC.indexOf('\n}\n', start + 1);
  assert.ok(end > start, 'handleResult has no closing brace at the start of a line');
  const src = APP_SRC.slice(start + 1, end + 2);
  assert.ok(src.includes('RundockMarkers.scanMarkers(textToScan)'),
    'the cut does not hold the marker scan, so it is not the function this file is about');
  return src;
}
const HANDLE_RESULT_SRC = handleResultSource();

// Run the real handleResult on one finished reply. Every global it reads is
// supplied here; a missing one throws inside its try and is logged through
// console.error, which this records so a broken harness fails loudly instead
// of reading as "nothing was sent".
function runReply(replyText) {
  const sent = [];
  const timers = [];
  const errors = [];
  let reduced = 0;
  const state = { streamingRawText: replyText, latestText: '' };
  const ctx = {
    ws: { send: (m) => sent.push(JSON.parse(m)), readyState: 1 },
    WebSocket: { OPEN: 1 },
    RundockMarkers: markers,
    RundockConversationState: { reduce: (s) => { reduced++; return { state: s, effects: [] }; } },
    getConvoState: () => state,
    activeConversation: { id: 'convo-A' },
    conversations: [{ id: 'convo-A' }],
    currentView: 'chat',
    convoState: {},
    executeEffects: () => {},
    finishProcessing: () => {},
    renderConvoList: () => {},
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); },
    console: { log() {}, warn() {}, error: (...args) => errors.push(args.map(String).join(' ')) },
  };
  // eslint-disable-next-line no-new-func
  const make = new Function('ctx', `with (ctx) { ${HANDLE_RESULT_SRC}; return handleResult; }`);
  make(ctx)({ type: 'result', result: replyText }, 'convo-A');
  assert.deepStrictEqual(errors, [], 'handleResult threw inside the harness, so its sends prove nothing');
  assert.strictEqual(reduced, 1, 'handleResult did not reach the render half, so the scan block did not finish');
  return { sent, timers };
}

// The kinds of message that make the server write or delete a file under
// .claude/agents/ or .claude/skills/. create_agent and update_agent are the
// legacy names the server still maps to the same save handler.
const FILE_WRITES = ['save_agent', 'create_agent', 'update_agent', 'save_skill', 'delete_agent', 'delete_skill'];
const fileWrites = (sent) => sent.filter((m) => FILE_WRITES.includes(m.type));

function agentFile(name, type) {
  return [
    '---',
    `name: ${name}`,
    'displayName: Example',
    'role: Example Specialist',
    `type: ${type}`,
    'order: 7',
    'tools: Read, Write, Edit, Bash',
    '---',
    '',
    `You are ${name}. You help with examples.`,
  ].join('\n');
}

describe('a reply that shows an agent file with no marker sends nothing', () => {
  const fenced = [
    ['a markdown fence, type specialist', '```markdown\n' + agentFile('example-agent', 'specialist') + '\n```'],
    ['a markdown fence, type orchestrator', '```markdown\n' + agentFile('example-lead', 'orchestrator') + '\n```'],
    ['a bare fence, type specialist', '```\n' + agentFile('example-agent', 'specialist') + '\n```'],
    ['a bare fence, type orchestrator', '```\n' + agentFile('example-lead', 'orchestrator') + '\n```'],
  ];
  for (const [label, block] of fenced) {
    test(`${label}`, () => {
      const reply = 'Here is the agent file for you to check before I save it:\n\n' + block + '\n\nShall I save it?';
      const { sent, timers } = runReply(reply);
      assert.deepStrictEqual(fileWrites(sent), [], 'a previewed agent file was sent to be saved');
      assert.deepStrictEqual(sent, [], 'a reply with no marker sends nothing at all');
      assert.deepStrictEqual(timers, [], 'no roster refresh is scheduled when nothing was saved');
    });
  }

  test('unfenced frontmatter, one block', () => {
    const reply = 'Here is the draft:\n\n' + agentFile('example-agent', 'specialist') + '\n\nShall I save it?';
    const { sent, timers } = runReply(reply);
    assert.deepStrictEqual(fileWrites(sent), [], 'an unfenced agent file was sent to be saved');
    assert.deepStrictEqual(sent, []);
    assert.deepStrictEqual(timers, []);
  });

  test('unfenced frontmatter, several blocks in one reply', () => {
    const reply = 'Two drafts.\n\n' + agentFile('example-agent', 'specialist')
      + '\n\nAnd the lead:\n\n' + agentFile('example-lead', 'orchestrator')
      + '\n\nA third, for comparison:\n' + agentFile('example-helper', 'specialist');
    const { sent, timers } = runReply(reply);
    assert.deepStrictEqual(fileWrites(sent), [], 'unfenced agent files were sent to be saved');
    assert.deepStrictEqual(sent, []);
    assert.deepStrictEqual(timers, []);
  });

  test('a fenced and an unfenced file in the same reply', () => {
    const reply = '```markdown\n' + agentFile('example-agent', 'specialist') + '\n```\n\n'
      + agentFile('example-lead', 'orchestrator');
    const { sent } = runReply(reply);
    assert.deepStrictEqual(sent, []);
  });
});

describe('a marked save still sends exactly one save, with the marker content', () => {
  const file = agentFile('example-agent', 'specialist');

  test('a SAVE_AGENT marker', () => {
    const reply = 'Saved.\n<!-- RUNDOCK:SAVE_AGENT name=example-agent -->\n' + file + '\n<!-- /RUNDOCK:SAVE_AGENT -->';
    const { sent, timers } = runReply(reply);
    assert.deepStrictEqual(sent, [
      { type: 'save_agent', name: 'example-agent', content: file, conversationId: 'convo-A' },
    ]);
    assert.deepStrictEqual(timers.map((t) => t.ms), [500], 'one roster refresh is scheduled after a save');
  });

  test('a SAVE_AGENT marker whose body is fenced saves the file without the fence', () => {
    const reply = 'Saved.\n<!-- RUNDOCK:SAVE_AGENT name=example-agent -->\n```markdown\n' + file + '\n```\n<!-- /RUNDOCK:SAVE_AGENT -->';
    const { sent } = runReply(reply);
    assert.deepStrictEqual(sent, [
      { type: 'save_agent', name: 'example-agent', content: file, conversationId: 'convo-A' },
    ]);
  });

  test('a CREATE_AGENT marker', () => {
    const reply = '<!-- RUNDOCK:CREATE_AGENT name=example-agent -->\n' + file + '\n<!-- /RUNDOCK:CREATE_AGENT -->';
    const { sent, timers } = runReply(reply);
    assert.deepStrictEqual(sent, [
      { type: 'save_agent', name: 'example-agent', content: file, conversationId: 'convo-A' },
    ]);
    assert.deepStrictEqual(timers.map((t) => t.ms), [500]);
  });

  test('a SAVE_SKILL marker', () => {
    const skill = '---\nname: example-skill\ndescription: An example skill.\n---\n\nDo the example.';
    const reply = '<!-- RUNDOCK:SAVE_SKILL name=example-skill -->\n' + skill + '\n<!-- /RUNDOCK:SAVE_SKILL -->';
    const { sent, timers } = runReply(reply);
    assert.deepStrictEqual(sent, [
      { type: 'save_skill', name: 'example-skill', content: skill, conversationId: 'convo-A' },
    ]);
    assert.deepStrictEqual(timers.map((t) => t.ms), [500]);
  });

  test('a marked save beside a previewed file saves only the marked one', () => {
    // A reply that previews one agent and saves another must not save the
    // preview as well. Before, it could not happen in this order (the
    // fallback ran only when the scan found nothing), and it must not start.
    const reply = 'Preview:\n```markdown\n' + agentFile('example-lead', 'orchestrator') + '\n```\n'
      + '<!-- RUNDOCK:SAVE_AGENT name=example-agent -->\n' + file + '\n<!-- /RUNDOCK:SAVE_AGENT -->';
    const { sent } = runReply(reply);
    assert.deepStrictEqual(sent.map((m) => `${m.type}:${m.name}`), ['save_agent:example-agent']);
  });
});

describe('the client asks for a file write only through the marker scan', () => {
  test('the fallback extractor is gone from the module and from every client file', () => {
    assert.ok(!('extractFrontmatterAgents' in markers), 'markers.js exports the frontmatter fallback again');
    for (const [file, src] of clientSources()) {
      assert.ok(!src.includes('extractFrontmatterAgents'), `${file} names the frontmatter fallback again`);
    }
  });

  test('the module header no longer describes a fallback', () => {
    const header = MARKERS_SRC.slice(0, MARKERS_SRC.indexOf('(/** @param'));
    assert.ok(header.includes('Behaviour contract'), 'the header contract was not found, so this check reads nothing');
    assert.doesNotMatch(header, /fallback/i, 'the header contract describes a fallback the client no longer has');
  });

  test('handleResult sends exactly these five messages, and the saves only from scanMarkers actions', () => {
    // Every send in handleResult, by its argument: each piece after a
    // `ws.send(` up to the first `);`. A sixth send is a second route, and a
    // second route that builds a save from reply text is the defect this file
    // closes. Whitespace is collapsed so a reformat is not a failure; a new
    // send, or a changed one, is.
    const body = HANDLE_RESULT_SRC;
    const sends = body.split('ws.send(').slice(1).map((piece) => {
      const end = piece.indexOf(');');
      assert.ok(end > -1, 'a send in handleResult has no closing `);`, so its argument cannot be read');
      return piece.slice(0, end).replace(/\s+/g, ' ').trim();
    });
    assert.deepStrictEqual(sends, [
      'JSON.stringify({ ...MARKER_SENDS[action.kind](action), conversationId: convoId })',
      "JSON.stringify({ type: 'delegate', conversationId: convoId, targetAgent, context })",
      "JSON.stringify({ type: 'end_delegation', conversationId: convoId })",
      "JSON.stringify({ type: 'get_agents' })",
      "JSON.stringify({ type: 'get_skills' })",
    ], 'handleResult sends exactly these five messages');
    // Any send at all, not only through the name ws, so an alias is counted.
    assert.strictEqual(body.split('.send(').length - 1, 5, 'a send was added to handleResult under another name');

    // The table is read in one place, and that place walks the scan's actions.
    assert.ok(body.includes('const scan = RundockMarkers.scanMarkers(textToScan);'), 'the scan is no longer taken from scanMarkers');
    const loopAt = body.indexOf('for (const action of scan.actions) {');
    assert.ok(loopAt > -1, 'the sends no longer walk scan.actions');
    const loop = body.slice(loopAt, body.indexOf('\n    }\n', loopAt));
    assert.ok(loop.includes('MARKER_SENDS[action.kind](action)'), 'the marker loop no longer builds its sends from the table');
    assert.strictEqual(body.split('MARKER_SENDS[').length - 1, 1, 'the send table is read outside the marker loop');
  });

  test('no client file builds a file-writing message outside the send table', () => {
    // Today the only client code that asks the server to write or delete an
    // agent or skill file is MARKER_SENDS in handleResult. A message of one
    // of these types built anywhere else is a second route and is reviewed
    // against the rule above: only a marker the person can see saves a file.
    // Whitespace is removed before counting, so `type:'save_agent'` and
    // `type : "save_agent"` count alike. WHAT THIS CANNOT SEE: a type
    // assembled at runtime from pieces.
    const tableAt = APP_SRC.indexOf('const MARKER_SENDS = {');
    assert.ok(tableAt > -1, 'the send table was not found, so this check reads nothing');
    const table = APP_SRC.slice(tableAt, APP_SRC.indexOf('};', tableAt));
    const found = [];
    for (const [file, src] of clientSources()) {
      const flat = src.replace(/\s+/g, '');
      for (const type of FILE_WRITES) {
        for (const q of ["'", '"', '`']) {
          const n = flat.split(`type:${q}${type}${q}`).length - 1;
          for (let i = 0; i < n; i++) found.push(`${file}:${type}`);
        }
      }
    }
    assert.deepStrictEqual(found.sort(), [
      'app.js:delete_agent', 'app.js:delete_skill', 'app.js:save_agent', 'app.js:save_skill',
    ], 'a file-writing message is built outside the send table');
    for (const type of ['save_agent', 'save_skill', 'delete_agent', 'delete_skill']) {
      assert.ok(table.includes(`type: '${type}'`), `${type} is no longer built in the send table`);
    }
  });
});

// Every hand-written client script, by its path under public/. The vendored
// bundles are third-party and excluded.
function clientSources() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'vendor') walk(p); continue; }
      if (e.name.endsWith('.js')) out.push([path.relative(path.join(ROOT, 'public'), p).split(path.sep).join('/'), fs.readFileSync(p, 'utf8')]);
    }
  };
  walk(path.join(ROOT, 'public'));
  assert.ok(out.length >= 20 && out.some(([f]) => f === 'app.js') && out.some(([f]) => f === 'markers.js'),
    `the client walk found ${out.length} files, so it has gone blind`);
  return out;
}
