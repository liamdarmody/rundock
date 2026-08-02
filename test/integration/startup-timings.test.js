'use strict';
// Integration: opening a workspace must record where its time went, somewhere
// a user can actually reach.
//
// Diagnosing one hang report took five rounds of asking for process lists,
// memory figures and directory sizes, produced seven hypotheses of which six
// were refuted by measurement, and still did not find the cause. Nothing the
// app recorded said where the time had gone.
//
// There is no log file: every console line goes to standard output, which in
// the packaged app goes nowhere a user can see. Asking someone to quit, open a
// terminal and reproduce the problem was tried three times and happened zero
// times, so the summary has to land in a file we can simply ask for.
//
// The file is safe to hand over unread by construction: phase names and
// numbers, nothing else. That property is asserted here, not assumed.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');
const { makeWorkspace, standardTeam } = require('../helpers/workspace.js');

let client;

before(async () => {
  await h.boot();
  client = await h.connect();
});
after(async () => h.shutdown());

function logPath(dir) { return path.join(dir, '.rundock', 'startup.log'); }
function readLog(dir) {
  try { return fs.readFileSync(logPath(dir), 'utf-8'); } catch (e) { return ''; }
}

async function openWorkspace(dir) {
  const since = client.messages.length;
  client.send({ type: 'set_workspace', path: dir });
  await client.waitFor(m => m.type === 'workspace_set', { since, label: 'workspace_set' });
  return since;
}

describe('startup timings', () => {
  test('opening a workspace records per-phase timings to a file', async () => {
    const dir = makeWorkspace({ agents: standardTeam(), claudeMd: '# Timed\n' });
    await openWorkspace(dir);
    await h.delay(300);

    const log = readLog(dir);
    assert.ok(log.length > 0,
      'a hang report is only diagnosable if the app wrote down where its time went. '
      + `Nothing was written to ${path.join('.rundock', 'startup.log')}.`);
    assert.match(log, /\bagents\b/, 'agent discovery should be timed');
    assert.match(log, /\btree\b/, 'the file tree walk should be timed');
    assert.match(log, /\d+ms/, 'phases should carry millisecond figures');
  });

  test('the search index reports its own duration, since it lands later', async () => {
    const dir = makeWorkspace({ agents: standardTeam(), claudeMd: '# Timed async\n' });
    for (let i = 0; i < 20; i++) {
      fs.writeFileSync(path.join(dir, `note-${i}.md`), `# Note ${i}\n\nSome body.\n`);
    }
    const since = client.messages.length;
    client.send({ type: 'set_workspace', path: dir });
    await client.waitFor(
      m => m.type === 'system' && m.subtype === 'search_index' && m.state === 'ready' && m.path === dir,
      { since, label: 'index ready' });
    await h.delay(150);

    assert.match(readLog(dir), /index/i,
      'the index warm-up is asynchronous, so it has to report its own duration rather '
      + 'than being folded into a summary written before it finished');
  });

  test('the client reports its render time alongside the server phases', async () => {
    const dir = makeWorkspace({ agents: standardTeam(), claudeMd: '# Timed client\n' });
    await openWorkspace(dir);

    // The renderer shares no measurement with the server today, and is the one
    // place never examined during the investigation this card came from.
    client.send({ type: 'client_render_time', ms: 1234 });
    await h.delay(200);

    assert.match(readLog(dir), /client/i,
      'a summary showing every server phase fast and the client slow would redirect an '
      + 'entire investigation in one line, so the client has to be in it');
  });

  test('the file cannot grow without bound across many opens', async () => {
    const dir = makeWorkspace({ agents: standardTeam(), claudeMd: '# Timed cap\n' });
    for (let i = 0; i < 40; i++) {
      await openWorkspace(dir);
    }
    await h.delay(300);

    const lines = readLog(dir).split('\n').filter(Boolean);
    assert.ok(lines.length < 400,
      `a support artifact must not become an audit trail: after 40 opens the log held `
      + `${lines.length} lines with no sign of a cap.`);
  });

  test('the file is safe to hand over unread: no paths, no content', async () => {
    const dir = makeWorkspace({ agents: standardTeam(), claudeMd: '# Timed privacy\n' });
    fs.writeFileSync(path.join(dir, 'Deeply Personal Notes.md'), '# Private\n\nSecretsauce.\n');
    await openWorkspace(dir);
    await h.delay(300);

    const log = readLog(dir);
    assert.ok(!log.includes(dir),
      'the workspace path must not appear: we ask users to send this file without reading it');
    assert.ok(!/\/Users\/|\/home\/|[A-Z]:\\/.test(log),
      `no absolute path of any shape may appear. Found one in:\n${log}`);
    assert.ok(!log.includes('Deeply Personal Notes'), 'no filenames');
    assert.ok(!log.includes('Secretsauce'), 'and certainly no file content');
  });
});
