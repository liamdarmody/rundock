'use strict';
// The two privileges a manifest can ask for beside writes: named sources
// and asking an agent, from manifest to record to roster to the
// payload a view is mounted from.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { readExtensionManifest, deriveFacts } = require('../../lib/packages/extension-manifest.js');
const { listExtensions, uiPayload } = require('../../lib/packages/extension-registry.js');
const { makeTempDir } = require('../helpers/workspace.js');

function snapshot(extension, extra = {}) {
  const dir = makeTempDir('priv-snap-');
  fs.writeFileSync(path.join(dir, 'index.js'), 'parent.postMessage({type:"ready"},"*");');
  fs.writeFileSync(path.join(dir, 'rundock.json'), JSON.stringify({ name: 'dash', version: '1.0.0', extension: { entry: 'index.js', match: '*.md', ...extension } }));
  for (const [rel, text] of Object.entries(extra)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

function installed(record) {
  const ws = makeTempDir('priv-ws-');
  fs.mkdirSync(path.join(ws, '.rundock', 'extensions', 'dash'), { recursive: true });
  fs.writeFileSync(path.join(ws, '.rundock', 'extensions', 'dash', 'index.js'), 'x');
  fs.writeFileSync(path.join(ws, '.rundock', 'extensions.json'), JSON.stringify({ schema: 'rundock.extensions/v1', extensions: [{
    name: 'dash', version: '1.0.0', entry: 'index.js', match: '*.md', root: '.rundock/extensions/dash',
    source: { url: 'https://github.com/x/dash', reference: 'v1.0.0' }, installedAt: '2026-09-23T00:00:00.000Z', ...record,
  }] }));
  return ws;
}

describe('the manifest', () => {
  test('sources is a literal boolean, and only together with a marker', () => {
    assert.strictEqual(readExtensionManifest(snapshot({ declares: 'portfolio-dashboard', sources: true })).sources, true);
    assert.strictEqual(readExtensionManifest(snapshot({})).sources, false);
    assert.throws(() => readExtensionManifest(snapshot({ sources: true })), /sources requires extension\.declares/);
    assert.throws(() => readExtensionManifest(snapshot({ declares: 'd', sources: 'yes' })), /true or false/);
  });

  test('asks lists one to four distinct agent ids', () => {
    assert.deepStrictEqual(readExtensionManifest(snapshot({ asks: ['wren', 'content_lead'] })).asks, ['wren', 'content_lead']);
    assert.deepStrictEqual(readExtensionManifest(snapshot({})).asks, []);
    for (const bad of [[], ['a', 'b', 'c', 'd', 'e'], ['Wren'], ['a b'], [1], 'wren', ['wren', 'wren'], ['x'.repeat(65)]]) {
      assert.throws(() => readExtensionManifest(snapshot({ asks: bad })), /asks/, JSON.stringify(bad));
    }
  });

  test('the trust facts carry both, and a starter file is not counted as a skill', () => {
    const snap = snapshot({ declares: 'd', sources: true, asks: ['wren'] }, {
      '.claude/agents/helper.md': '---\nname: helper\n---\nA.\n', 'starter/Notes/a.md': 'x',
    });
    const facts = deriveFacts(snap, readExtensionManifest(snap));
    assert.strictEqual(facts.sources, true);
    assert.deepStrictEqual(facts.asks, ['wren']);
    assert.strictEqual(facts.agents, 1);
    assert.strictEqual(facts.skills, 0, 'starter files ride with agents and skills but are neither');
  });
});

describe('the record, the roster and the payload', () => {
  test('the payload carries sources and asks from the record', () => {
    const p = uiPayload(installed({ declares: 'portfolio-dashboard', sources: true, asks: ['wren'] }), 'dash', 'view');
    assert.strictEqual(p.sources, true);
    assert.deepStrictEqual(p.asks, ['wren']);
  });

  test('absent claims read as none', () => {
    const p = uiPayload(installed({}), 'dash', 'view');
    assert.strictEqual(p.sources, false);
    assert.deepStrictEqual(p.asks, []);
  });

  test('a record granting sources without a marker is refused on the roster, and the payload grants none', () => {
    const ws = installed({ sources: true });
    const [entry] = listExtensions(ws);
    assert.deepStrictEqual(entry.renderers, []);
    assert.match(entry.refusals[0].reason, /^The extension declares sources but no frontmatter marker/);
    assert.strictEqual(uiPayload(ws, 'dash', 'view').sources, false);
  });

  test('a hand-edited record cannot widen asks past the rule', () => {
    const p = uiPayload(installed({ asks: ['wren', 'Bad Name', '__proto__', 'a', 'b', 'c'] }), 'dash', 'view');
    assert.deepStrictEqual(p.asks, ['wren', '__proto__', 'a', 'b'], 'kept to valid ids, at most four; a name is only a name');
  });
});

describe('the trust card', () => {
  const model = require('../../public/packages-install-model.js');
  const card = (facts, env) => model.trustCopy({
    manifest: { name: 'dash', version: '1.0.0' }, link: 'https://github.com/x/dash', reference: 'v1.0.0',
    facts: { agents: 0, skills: 0, files: [], match: '*.md', ...facts }, replaces: null,
  }, env).runsLines;

  test('a sources extension is told what it can read, who chooses, and what it never gets; "nothing else" stays true', () => {
    const lines = card({ declares: 'portfolio-dashboard', sources: true });
    assert.ok(lines.some((l) => l.includes('It can read the files a note marked "portfolio-dashboard" lists under sources:, while that note is open in it. You choose those files by writing them in the note. It cannot name, list or find any other file, and hidden files, linked files and anything outside your workspace are never given to it.')));
    assert.ok(lines.some((l) => /read-only, and the named sources below, and nothing else about your workspace/.test(l)));
    assert.ok(!lines.some((l) => /change those listed files/.test(l)), 'no write sentence without writes');
  });

  test('with writes, it can change the listed files and never the list, and the file-only sentence drops "and nothing else"', () => {
    const lines = card({ declares: 'portfolio-dashboard', sources: true, writes: true });
    assert.ok(lines.includes('It can change those listed files through Rundock, which writes only files the note lists, and it can never change the list.'));
    assert.ok(!lines.some((l) => /and nothing else: it hands/.test(l)));
  });

  // Every extension can keep view state, with nothing to declare, so
  // every card says so once, in the same words, whatever else it declares.
  test('every card carries the view state line once, with no declarations and with all of them', () => {
    const line = "It can keep up to 64 KB of its own settings for each note it opens, in Rundock's folder, never in your notes. Uninstalling it removes them.";
    for (const facts of [{}, { declares: 'portfolio-dashboard', sources: true, writes: true, asks: ['helper'] }]) {
      for (const env of [{}, { desktop: true }]) {
        const lines = card(facts, env);
        assert.strictEqual(lines.filter((l) => l === line).length, 1, JSON.stringify(facts));
        assert.strictEqual(lines.indexOf(line), 4, 'in the same place on every card, after the four host facts');
      }
    }
  });

  test('an extension without sources says nothing about them', () => {
    const lines = card({});
    assert.ok(!lines.some((l) => /sources/.test(l)));
  });

  test('ask names each agent by display name on the team, and by id otherwise', () => {
    const agents = [{ id: 'wren', displayName: 'Wren', status: 'onTeam', type: 'specialist' }];
    const lines = card({ asks: ['wren', 'ghost'] }, { agents });
    assert.ok(lines.includes('When you click inside it, it can start a new conversation with Wren or ghost and put a message in the box for you. Nothing is sent until you send it, and it never sees the conversation or the reply.'));
    assert.ok(!card({}).some((l) => /conversation/.test(l)));
  });
});

describe('nothing about asking ever reaches a frame', () => {
  test('the host-to-frame table is closed at init, refused, sources and theme, and no field carries a conversation', async () => {
    const host = await import('../../public/extension-host.js');
    assert.deepStrictEqual(host.HOST_MESSAGES, ['init', 'refused', 'sources', 'theme']);
    const fields = Object.values(host.HOST_MESSAGE_FIELDS).flat();
    for (const word of ['conversation', 'reply', 'agent', 'ask', 'message', 'socket', 'chat']) {
      assert.ok(!fields.some((f) => f.toLowerCase().includes(word)), `no host message field about ${word}`);
    }
  });
});
