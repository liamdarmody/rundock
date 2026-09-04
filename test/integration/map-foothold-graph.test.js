'use strict';
// The graph endpoint against the real server, because every unit test of it
// injects its own dependencies: nothing there exercises the URL reaching the
// real router, or the search engine being wired at boot. Delete the one
// wiring line in server.js and the unit suite stays green while the endpoint
// answers 500 forever and the client renders its polite empty state. This
// file is what goes red instead: a real boot, a real index over a real
// workspace, and one HTTP request.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');
const { makeTempDir } = require('../helpers/workspace.js');
const { probeSqlite } = require('../../search.js');

const sqlite = probeSqlite();

before(async () => { await h.boot(); });
after(async () => h.shutdown());

test('the booted server serves the graph for a workspace it indexed itself',
  { skip: !sqlite.available && 'no node:sqlite on this runtime' }, async () => {
    const dir = makeTempDir('map-graph-ws-');
    fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'notes', 'Target.md'), 'The destination.');
    fs.writeFileSync(path.join(dir, 'Source.md'), 'Points at [[Target]].');

    const client = await h.connect();
    const since = client.messages.length;
    client.send({ type: 'set_workspace', path: dir });
    await client.waitFor(
      (m) => m.type === 'system' && m.subtype === 'search_index' && m.state === 'ready' && m.path === dir,
      { since, label: 'the new workspace\'s index reporting ready' });

    // The tree cache the endpoint resolves against fills on the same open;
    // poll briefly rather than assuming ordering between the two messages.
    let body = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const res = await fetch(`http://127.0.0.1:${h.port}/api/graph`);
      assert.ok(res.status === 200 || res.status === 500, `unexpected status ${res.status}`);
      if (res.status === 200) {
        body = await res.json();
        if (body.indexed && body.links.some((l) => l.src === 'Source.md')) break;
      }
      await h.delay(250);
    }

    assert.ok(body, 'the endpoint answered');
    assert.strictEqual(body.indexed, true,
      'the engine the server booted with is the engine the endpoint reads: this is the wiring line');
    assert.ok(body.nodes.some((n) => n.path === 'Source.md'), 'the workspace\'s files are nodes');
    const link = body.links.find((l) => l.src === 'Source.md');
    assert.ok(link, 'the link the real indexer extracted is served');
    assert.strictEqual(link.resolved, 'notes/Target.md',
      'and it resolves through the same resolver a click goes through, on the server\'s own tree');
  });
