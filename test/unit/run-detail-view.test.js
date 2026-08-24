'use strict';
// The run detail screen, drawn into the real page, from records of the shape
// the writer actually produces.
//
// EVERY RECORD HERE IS DRIVEN THROUGH THE REAL RENDER into markup cut out of
// public/index.html, rather than through the model alone. The model is
// asserted line by line in its own file; what this file is for is the part
// only a rendered page can answer: whether a reader looking at two different
// runs sees two different things.
//
// THE ASSERTION THAT MATTERS. A run that changed nothing and a run whose
// changes are unknown are driven through the same render and the markup is
// compared. If a default of `[]` is ever written anywhere between the record
// and the page, those two pages become the same page and this goes red.
//
// THE CLOCK AND THE ZONE ARE CONSTRUCTED. The zone is set before the first
// require because continuous integration runs in UTC.
process.env.TZ = 'Europe/London';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf-8');
const INDEX_SRC = read('public', 'index.html');
const MODEL_SRC = read('public', 'run-detail-model.js');
const VIEW_SRC = read('public', 'views', 'run-detail.js');
const CSS_SRC = read('public', 'styles', 'views', 'run-detail.css');

// Every status a record can carry. `interrupted` is here deliberately: it is
// written in exactly one place, by the startup close, and it is the token a
// screen is most likely to leak because nothing else in the product renders it.
const STATUSES = ['running', 'succeeded', 'failed', 'interrupted'];

const NOW = new Date(2026, 7, 24, 9, 0);

/** The shape the first live run left on disk, 2026-08-24 01:30. */
function record(over = {}) {
  return {
    id: '874c46c4-4f2d-4653-8802-92cad4b3df0b',
    agent: 'default',
    routine: 'Hello World',
    sessionId: '3872034a-fe64-47c6-98bb-2beb40a3e4f8',
    status: 'succeeded',
    startedAt: '2026-08-24T00:30:32.036Z',
    endedAt: '2026-08-24T00:30:45.199Z',
    durationMs: 13163,
    error: null,
    files: [{
      path: '/w/Hello World/hello-world-2026-08-24.md',
      tool: 'Write', change: 'created', at: '2026-08-24T00:30:43.206Z', source: 'transcript',
    }],
    filesStatus: 'known',
    filesReason: null,
    ...over,
  };
}

const CHANGED_NOTHING = record({ files: [], filesStatus: 'known', filesReason: null });
const CHANGES_UNKNOWN = record({ files: null, filesStatus: 'unknown', filesReason: 'no-transcript' });

/**
 * The real page's run-detail panel, cut out of index.html.
 *
 * CUT RATHER THAN WRITTEN HERE. A view that renders into an element the page
 * does not have is a silent no-op, and a copy of the markup in this file would
 * keep passing after the page stopped carrying it.
 */
function shellMarkup() {
  const panel = /<div id="view-run-detail"[\s\S]*?<\/div>\s*<\/div>/.exec(INDEX_SRC);
  assert.ok(panel, 'index.html no longer carries the run detail view panel');
  return '<!doctype html><html><head><style>' + CSS_SRC + '</style></head><body>'
    + '<div id="view-routines"></div>' + panel[0] + '</body></html>';
}

function shell() {
  const dom = new JSDOM(shellMarkup(), { runScripts: 'dangerously' });
  const w = dom.window;
  w.eval(MODEL_SRC);
  w.eval(VIEW_SRC);
  w.agents = [{ id: 'default', displayName: 'Piper', colour: '#E87A5A', icon: 'P' }];
  w.esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  w.sent = [];
  w.ws = { send: (m) => w.sent.push(JSON.parse(m)) };
  w.navigatedTo = null;
  w.switchNav = (nav) => { w.navigatedTo = nav; };
  w.showView = () => {};
  w.setNavState = () => {};
  w.runDetailNow = () => NOW;
  return { w, doc: w.document, dom };
}

/** Open the screen for a routine and hand it a record, as the server would. */
function draw(run, { agentId = 'default', routine = 'Hello World' } = {}) {
  const { w, doc, dom } = shell();
  w.openRunDetail(agentId, routine);
  w.runArrived({ type: 'run', runId: null, agentId, routine, run });
  return { w, doc, dom, html: doc.getElementById('run-detail-content').innerHTML };
}

/** The text a reader actually sees, with markup and entities out of the way. */
function pageText(doc) {
  return doc.getElementById('run-detail-content').textContent.replace(/\s+/g, ' ').trim();
}

describe('the record on screen', () => {
  test('a finished run shows what it did, from its own record', () => {
    const { doc, dom } = draw(record());
    const text = pageText(doc);
    assert.match(text, /Hello World/);
    assert.match(text, /hello-world-2026-08-24\.md/);
    assert.match(text, /13 seconds/);
    dom.window.close();
  });

  test('a run that changed nothing and a run whose changes are unknown do not render alike', () => {
    const nothing = draw(CHANGED_NOTHING);
    const unknown = draw(CHANGES_UNKNOWN);
    assert.notStrictEqual(nothing.html, unknown.html,
      'the two records render identically, which means a default has collapsed them');
    assert.notStrictEqual(pageText(nothing.doc), pageText(unknown.doc),
      'the two records differ only in markup a reader cannot see');
    nothing.dom.window.close();
    unknown.dom.window.close();
  });

  test('a run whose changes are unknown never tells the reader it changed nothing', () => {
    const { doc, dom } = draw(CHANGES_UNKNOWN);
    const text = pageText(doc);
    assert.ok(!/changed no files|changed nothing/i.test(text),
      `the page says "${text}", which is the sentence for a run that changed nothing`);
    assert.match(text, /cannot tell what this run changed/i);
    dom.window.close();
  });

  test('a run that changed nothing says so, rather than showing an empty space', () => {
    const { doc, dom } = draw(CHANGED_NOTHING);
    assert.match(pageText(doc), /changed no files/i);
    dom.window.close();
  });

  test('the reason the changes are unknown is on the page in plain words', () => {
    for (const [reason, fragment] of [
      ['no-transcript', /not on disk/i],
      ['unreadable', /could not be opened/i],
      ['delegated', /handed work to another agent/i],
      ['unresolved', /never got an answer back/i],
      ['no-session', /opened no session/i],
      ['unrecognised', /does not understand/i],
      ['running', /still going/i],
    ]) {
      const { doc, dom } = draw(record({ files: null, filesStatus: 'unknown', filesReason: reason }));
      const text = pageText(doc);
      assert.match(text, fragment, `the ${reason} reason did not reach the page`);
      assert.ok(!new RegExp(`\\b${reason}\\b`).test(text) || reason === 'running',
        `the ${reason} code itself is printed at the reader`);
      dom.window.close();
    }
  });

  test('no record at all is a state of its own, not a run that changed nothing', () => {
    const { doc, dom } = draw(null);
    const text = pageText(doc);
    assert.match(text, /no record of this run/i);
    assert.ok(!/changed no files|changed nothing/i.test(text));
    dom.window.close();
  });

  test('waiting for the record is not a run that changed nothing either', () => {
    const { w, doc, dom } = shell();
    w.openRunDetail('default', 'Hello World');
    const text = pageText(doc);
    assert.ok(!/changed no files|changed nothing|no record of this run/i.test(text),
      `the screen said "${text}" before the record had arrived`);
    dom.window.close();
  });
});

describe('no raw status word reaches the page', () => {
  test('every status a record can carry renders without its own token', () => {
    for (const status of STATUSES) {
      const { doc, dom } = draw(record({ status, endedAt: null, durationMs: null }));
      const text = pageText(doc);
      for (const token of STATUSES) {
        assert.ok(!new RegExp(`\\b${token}\\b`, 'i').test(text),
          `a ${status} run puts "${token}" on the page, which is the record's own word rather than English`);
      }
      assert.ok(text.length > 40, `a ${status} run rendered almost nothing`);
      dom.window.close();
    }
  });

  test('a status this version has never seen is described rather than printed', () => {
    for (const odd of ['cancelled', 'queued']) {
      const { doc, dom } = draw(record({ status: odd }));
      assert.ok(!new RegExp(odd, 'i').test(pageText(doc)),
        `an unrecognised status reached the page as "${odd}"`);
      assert.match(pageText(doc), /does not recognise/i);
      dom.window.close();
    }
  });

  test('a run cut short by a restart reads differently from a run that went wrong', () => {
    const cut = draw(record({ status: 'interrupted', endedAt: null, durationMs: null }));
    const failed = draw(record({ status: 'failed', error: 'Permission denied' }));
    assert.notStrictEqual(pageText(cut.doc), pageText(failed.doc));
    assert.match(pageText(cut.doc), /never reached its ending/i);
    assert.ok(!/went wrong|did not get through/i.test(pageText(cut.doc)),
      'the interrupted page uses the words written for a run that failed');
    // Told apart at a glance as well as in the sentence: the two carry
    // different tones, so the read does not rest on the reader finishing the
    // paragraph.
    assert.notStrictEqual(
      cut.doc.querySelector('[data-run-detail="chip"]').className,
      failed.doc.querySelector('[data-run-detail="chip"]').className);
    cut.dom.window.close();
    failed.dom.window.close();
  });

  test('the three tones resolve to three different colours in the stylesheet', () => {
    // Asserted against what the page resolves rather than against a table in a
    // module, because a table nothing renders can agree with its tests forever
    // while the stylesheet says something else.
    const { doc, dom } = draw(record());
    const colourOf = (tone) => {
      const probe = doc.createElement('span');
      probe.className = `rd-chip ${tone}`;
      doc.body.appendChild(probe);
      return dom.window.getComputedStyle(probe).color;
    };
    const ok = colourOf('ok');
    const bad = colourOf('bad');
    const unwitnessed = colourOf('unwitnessed');
    assert.ok(ok && bad && unwitnessed, 'a tone resolves to no colour at all');
    assert.notStrictEqual(ok, bad);
    assert.notStrictEqual(bad, unwitnessed,
      'a run whose ending never ran is painted as a failure, which is a claim nobody witnessed');
    assert.notStrictEqual(ok, unwitnessed);
    dom.window.close();
  });

  test('a failed run carries the reason it gave', () => {
    const { doc, dom } = draw(record({ status: 'failed', error: 'Permission denied' }));
    assert.match(pageText(doc), /Permission denied/);
    dom.window.close();
  });
});

describe('what the run changed', () => {
  test('a file created is told apart from a file edited, on the page', () => {
    const { doc, dom } = draw(record({
      files: [
        { path: '/w/a.md', tool: 'Write', change: 'created', at: null, source: 'transcript' },
        { path: '/w/b.md', tool: 'Edit', change: 'edited', at: null, source: 'transcript' },
      ],
    }));
    const tags = [...doc.querySelectorAll('[data-run-detail="change"]')].map(e => e.textContent);
    assert.deepStrictEqual(tags, ['Created', 'Edited']);
    dom.window.close();
  });

  test('the list says whether the run got to the end', () => {
    const ok = draw(record());
    const bad = draw(record({ status: 'failed', error: 'x' }));
    assert.match(pageText(ok.doc), /Files changed(?! before)/);
    assert.match(pageText(bad.doc), /Files changed before it stopped/);
    ok.dom.window.close();
    bad.dom.window.close();
  });

  test('the screen says plainly that it cannot open a changed file, and why', () => {
    // The card allows either: files that open, or a plain statement that this
    // release cannot. This is the statement, and it has to be ON THE PAGE
    // rather than in a comment, so a reader who expects a link is told why
    // there is none instead of clicking a name that does nothing.
    const { doc, dom } = draw(record());
    assert.match(pageText(doc), /can't be opened from here yet/i);
    assert.match(pageText(doc), /records each file as a full path on the computer that ran/i);
    assert.strictEqual(doc.querySelectorAll('#run-detail-content a[href]').length, 0,
      'a file name is a link that goes nowhere, which is worse than no link');
    dom.window.close();
  });

  test('a file is named by the part a reader recognises, with its path underneath', () => {
    const { doc, dom } = draw(record());
    const name = doc.querySelector('[data-run-detail="file-name"]').textContent;
    assert.strictEqual(name, 'hello-world-2026-08-24.md');
    assert.match(pageText(doc), /\/w\/Hello World\/hello-world-2026-08-24\.md/);
    dom.window.close();
  });

  test('a routine name carrying markup is escaped rather than rendered', () => {
    const { doc, dom } = draw(record({ routine: '<img src=x onerror=alert(1)>' }));
    assert.strictEqual(doc.querySelectorAll('#run-detail-content img').length, 0);
    assert.match(pageText(doc), /<img src=x onerror=alert\(1\)>/);
    dom.window.close();
  });
});

describe('an answer that arrives late lands where it was asked for', () => {
  test('a record for another routine is ignored rather than drawn', () => {
    const { w, doc, dom } = shell();
    w.openRunDetail('default', 'Hello World');
    w.runArrived({ type: 'run', agentId: 'piper', routine: 'Something Else', run: record({ routine: 'Something Else' }) });
    assert.ok(!/Something Else/.test(pageText(doc)),
      'a reply for a routine the reader is not looking at was drawn on this screen');
    dom.window.close();
  });
});
