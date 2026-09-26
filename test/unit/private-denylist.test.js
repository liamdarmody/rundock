'use strict';
// The private denylist: terms that must never reach a public repository, kept
// outside it and read by the local checks (scripts/private-denylist.js). Every
// term here is invented, so this file names nobody.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseDenylist, resolveDenylistPath, loadDenylist, scanPrivate } = require('../../scripts/private-denylist.js');

const LIST = [
  '# a comment line',
  '',
  '[person]',
  'Zorblat Quenn   # trailing comment',
  'quenn',
  '[service]',
  're:mcp__frobnic\\w*',
  're:([unclosed',
].join('\n');

describe('parseDenylist', () => {
  const { entries, errors } = parseDenylist(LIST);
  test('reads terms and regexes under their class, skipping comments', () => {
    assert.deepStrictEqual(entries.map((e) => e.cls), ['person', 'person', 'service']);
  });
  test('reports an invalid regex by line without failing the rest', () => {
    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /line 8/);
  });
});

describe('scanPrivate', () => {
  const { entries } = parseDenylist(LIST);
  const scan = (text) => scanPrivate('f.md', text, entries);
  test('matches a whole word, case-insensitive', () => {
    assert.strictEqual(scan('met ZORBLAT QUENN today').length, 1);
    assert.strictEqual(scan('the quenn file').length, 1);
  });
  test('does not match inside a longer word', () => {
    assert.strictEqual(scan('quennsland and aquenn').length, 0);
  });
  test('matches a regex entry', () => {
    const hits = scan(`tool ${['mcp', 'frobnic_ai', 'list'].join('__')}`);
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].cls, 'service');
    assert.strictEqual(hits[0].line, 1);
  });
  test('never carries the term in full in a finding', () => {
    const hits = scan('line one\nZorblat Quenn wrote this');
    assert.strictEqual(hits[0].line, 2);
    const printed = JSON.stringify(hits);
    assert.ok(!/zorblat/i.test(printed), printed);
    assert.ok(!/quenn/i.test(printed), printed);
  });
});

describe('scoped exceptions', () => {
  const { entries } = parseDenylist('[person]\nZorblat Quenn  !^Some Site/(index\\.html|zorblat-quenn\\.jpe?g)$  # signed-off testimonial\n');
  test('an entry is not applied where its exception matches the repository and path', () => {
    assert.strictEqual(scanPrivate('index.html', 'by Zorblat Quenn', entries, { scope: 'Some Site/index.html' }).length, 0);
    assert.strictEqual(scanPrivate('zorblat-quenn.jpeg', 'zorblat-quenn.jpeg', entries, { scope: 'Some Site/zorblat-quenn.jpeg' }).length, 0);
  });
  test('it still applies everywhere else, and in messages', () => {
    assert.strictEqual(scanPrivate('index.html', 'by Zorblat Quenn', entries, { scope: 'Other/index.html' }).length, 1);
    assert.strictEqual(scanPrivate('about.html', 'by Zorblat Quenn', entries, { scope: 'Some Site/about.html' }).length, 1);
    assert.strictEqual(scanPrivate('commit message', 'Zorblat Quenn', entries).length, 1);
  });
});

describe('resolveDenylistPath and loadDenylist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'denylist-'));
  const file = path.join(dir, 'list.txt');
  fs.writeFileSync(file, 'quenn\n');

  test('the env var wins', () => {
    assert.strictEqual(resolveDenylistPath({ RUNDOCK_PRIVATE_DENYLIST: file }, () => 'other'), file);
  });
  test('git config is the fallback', () => {
    assert.strictEqual(resolveDenylistPath({}, () => file), file);
  });
  test('loads a present list', () => {
    const r = loadDenylist({ env: { RUNDOCK_PRIVATE_DENYLIST: file }, gitConfig: () => '' });
    assert.strictEqual(r.status, 'loaded');
    assert.strictEqual(r.entries.length, 1);
  });
  test('missing locally is reported as missing, with a loud warning', () => {
    const r = loadDenylist({ env: { RUNDOCK_PRIVATE_DENYLIST: path.join(dir, 'nope.txt') }, gitConfig: () => '' });
    assert.strictEqual(r.status, 'missing');
    assert.match(r.warning, /PRIVATE DENYLIST NOT FOUND/);
  });
  test('unconfigured locally is also missing', () => {
    assert.strictEqual(loadDenylist({ env: {}, gitConfig: () => '' }).status, 'missing');
  });
  test('skipped under CI', () => {
    const r = loadDenylist({ env: { CI: 'true' }, gitConfig: () => file });
    assert.strictEqual(r.status, 'skipped');
    assert.strictEqual(r.entries.length, 0);
  });
});
