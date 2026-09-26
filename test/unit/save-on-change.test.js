'use strict';
// A view that announces a change causes a guarded save, and the debounce that
// decides when lives in the caller, once, for every writable view.
//
// The mount contract carried getContentForSave and no way to say "I changed",
// so the board kept a timer of its own and the text and rich editors kept one
// each. Now a view is handed onChange at mount (an extension posts `change`),
// and public/save-scheduler.js is the one debounce. Pinned here: the scheduler
// itself; the board saving through onChange and not saving without it; an
// extension's `change` reaching the caller only where it declared writes; and
// app.js holding no save timer of its own any more.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const Scheduler = require('../../public/save-scheduler.js');
const Kanban = require('../../public/kanban.js');

const ROOT = path.join(__dirname, '..', '..');

function fakeClock() {
  let now = 0; let seq = 0; const timers = new Map();
  return {
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer: (id) => timers.delete(id),
    advance(ms) {
      now += ms;
      for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); }
    },
  };
}

describe('the one debounce', () => {
  test('the latest change wins, once the pause is over', () => {
    const clock = fakeClock();
    const saves = [];
    const s = Scheduler.create(clock);
    s.schedule('a.md', () => saves.push('first'), 500);
    clock.advance(300);
    s.schedule('a.md', () => saves.push('second'), 500);
    clock.advance(300);
    assert.deepStrictEqual(saves, [], 'still inside the pause');
    clock.advance(300);
    assert.deepStrictEqual(saves, ['second']);
  });

  test('flush writes now, to the path the change was made in; cancel writes nothing', () => {
    const clock = fakeClock();
    const saves = [];
    const s = Scheduler.create(clock);
    s.schedule('board.md', () => saves.push('board.md'), 500);
    assert.strictEqual(s.pendingPath(), 'board.md');
    s.flush();
    assert.deepStrictEqual(saves, ['board.md']);
    clock.advance(1000);
    assert.deepStrictEqual(saves, ['board.md'], 'a flushed save is not written twice');
    s.schedule('note.md', () => saves.push('note.md'), 500);
    s.cancel();
    clock.advance(1000);
    assert.deepStrictEqual(saves, ['board.md']);
  });

  test('a view that refuses to save writes nothing', () => {
    const saved = [];
    Scheduler.viewerSaveTask(() => null, (p, c) => saved.push([p, c]), 'x.md')();
    Scheduler.viewerSaveTask(() => 'bytes', (p, c) => saved.push([p, c]), 'x.md')();
    assert.deepStrictEqual(saved, [['x.md', 'bytes']]);
  });
});

describe('the board announces a change through onChange', () => {
  const BOARD = '---\n\nkanban-plugin: board\n\n---\n\n## To do\n\n- [ ] one\n\n## Done\n\n';

  async function mountBoard(withOnChange) {
    const dom = new JSDOM('<div id="pane"></div>');
    const { mountBoardView } = await import('../../public/viewers/board-view.js');
    const clock = fakeClock();
    const saved = [];
    const saves = Scheduler.create(clock);
    let viewer = null;
    viewer = mountBoardView({
      paneElement: dom.window.document.getElementById('pane'), path: 'b.md', content: BOARD,
      onWikilink: () => {},
      ...(withOnChange ? { onChange: () => saves.schedule('b.md', Scheduler.viewerSaveTask(viewer.getContentForSave, (p, c) => saved.push([p, c]), 'b.md'), 500) } : {}),
    }, Kanban);
    return { dom, viewer, clock, saved };
  }

  test('an edit on the board becomes one guarded save of the whole board, once the pause is over', async () => {
    const { dom, viewer, clock, saved } = await mountBoard(true);
    dom.window.document.querySelector('.board-lane-collapse').click();
    assert.deepStrictEqual(saved, [], 'not before the pause');
    clock.advance(600);
    assert.strictEqual(saved.length, 1, 'one save');
    assert.strictEqual(saved[0][0], 'b.md');
    assert.strictEqual(saved[0][1], viewer.getContentForSave(), 'the bytes the board hands back');
    viewer.destroy();
  });

  test('with the callback removed, the same edit saves nothing', async () => {
    const { dom, viewer, clock, saved } = await mountBoard(false);
    dom.window.document.querySelector('.board-lane-collapse').click();
    clock.advance(600);
    assert.deepStrictEqual(saved, []);
    assert.strictEqual(viewer.setOnChange, undefined, 'and there is no second way in');
    viewer.destroy();
  });
});

describe('no view keeps a save timer of its own', () => {
  test('app.js holds the shared scheduler and neither of the old timers', () => {
    const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
    const files = fs.readFileSync(path.join(ROOT, 'public', 'views', 'files.js'), 'utf8');
    assert.ok(app.includes('const fileSaves = RundockSaveScheduler.create();'), 'the one debounce is declared');
    for (const name of ['saveTimer', '_tiptapSaveTimer', 'boardSaveTimer', 'boardPendingSave']) {
      assert.ok(!app.includes(name), `app.js no longer names ${name}`);
      assert.ok(!files.includes(name), `files.js no longer names ${name}`);
    }
  });
});
