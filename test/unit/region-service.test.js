'use strict';
// One render service per extension,
// held for the session, answering tagged requests.
//
// The happy path here is one test. Everything else is about answers arriving
// when they should not: for a request that already timed out, for a request
// that was never made, from a window that is not the frame, twice for the
// same request, or not at all. A render service that gets those wrong draws
// one document's diagram into another document's page, and it does it rarely
// enough that nobody reproduces it.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { JSDOM } = require('jsdom');

const service = require('../../public/region-service.js');

// A service over a real DOM, with the frame's own window replaced by a
// capture so a test can answer as the frame would, on the real listener.
function started(opts = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
  const win = dom.window;
  const unusable = [];
  const sent = [];
  const handle = service.startRegionService({
    doc: win.document,
    win,
    srcdoc: '<!doctype html><html><body></body></html>',
    onUnusable: (reason) => unusable.push(reason),
    timeoutMs: opts.timeoutMs || 5000,
  });
  const frame = handle.frame();
  Object.defineProperty(frame, 'contentWindow', {
    configurable: true,
    value: { postMessage: (m) => sent.push(m) },
  });
  // Answer the way the frame would: a real message event on the real
  // listener, sourced from the frame's window.
  const answer = (payload, source) => {
    const event = new win.MessageEvent('message', { data: payload });
    Object.defineProperty(event, 'source', { value: source === undefined ? frame.contentWindow : source });
    win.dispatchEvent(event);
  };
  // A real frame says `ready` once its library is loaded and its listener is
  // attached. Every case except the queueing ones below wants a service that
  // has got past that, so it is the default here.
  if (!opts.silentFrame) answer({ type: 'ready' });
  return { dom, win, handle, frame, sent, unusable, answer };
}

describe('a render service is one frame, asked and answered by request', () => {
  test('the frame it builds is headless and carries the same posture a mounted view gets', () => {
    const { frame } = started();
    assert.strictEqual(frame.getAttribute('sandbox'), 'allow-scripts',
      'the one grant, and no allow-same-origin: this frame is opaque like every other');
    assert.strictEqual(frame.getAttribute('aria-hidden'), 'true');
    assert.match(frame.style.cssText, /visibility:\s*hidden/,
      'never seen: it computes, and the host draws');
    assert.match(frame.style.cssText, /width:\s*0/, 'and occupies no space, so it cannot be a viewport');
  });

  test('a request is tagged, and its answer comes back to it', async () => {
    const { handle, sent, answer } = started();
    const pending = handle.render('graph TD; A-->B');
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].type, 'render');
    assert.strictEqual(sent[0].source, 'graph TD; A-->B');
    assert.strictEqual(typeof sent[0].requestId, 'string');
    answer({ type: 'rendered', requestId: sent[0].requestId, svg: '<svg/>' });
    assert.deepStrictEqual(await pending, { ok: true, svg: '<svg/>' });
  });

  test('three requests in flight are answered out of order and each finds its own asker', async () => {
    // The case a document with three diagrams produces, and the one a naive
    // service gets wrong by assuming answers come back in the order asked.
    const { handle, sent, answer } = started();
    const first = handle.render('one');
    const second = handle.render('two');
    const third = handle.render('three');
    answer({ type: 'rendered', requestId: sent[2].requestId, svg: '<svg id="third"/>' });
    answer({ type: 'rendered', requestId: sent[0].requestId, svg: '<svg id="first"/>' });
    answer({ type: 'rendered', requestId: sent[1].requestId, svg: '<svg id="second"/>' });
    assert.deepStrictEqual(await first, { ok: true, svg: '<svg id="first"/>' });
    assert.deepStrictEqual(await second, { ok: true, svg: '<svg id="second"/>' });
    assert.deepStrictEqual(await third, { ok: true, svg: '<svg id="third"/>' });
  });
});

describe('an answer that should not be believed is not', () => {
  test('a message from a window that is not the frame is ignored entirely', async () => {
    const { handle, sent, answer } = started({ timeoutMs: 40 });
    const pending = handle.render('x');
    answer({ type: 'rendered', requestId: sent[0].requestId, svg: '<svg id="forged"/>' }, {});
    const out = await pending;
    assert.strictEqual(out.ok, false, 'the forged answer was not taken');
    assert.match(out.reason, /did not answer/, 'and the request timed out as though nothing arrived');
  });

  test('an answer for a request nobody is waiting on is dropped in silence', async () => {
    const { handle, sent, answer } = started();
    const pending = handle.render('x');
    answer({ type: 'rendered', requestId: 'not-a-real-id', svg: '<svg id="stray"/>' });
    answer({ type: 'rendered', requestId: sent[0].requestId, svg: '<svg id="mine"/>' });
    assert.deepStrictEqual(await pending, { ok: true, svg: '<svg id="mine"/>' },
      'the stray answer changed nothing for the request that was real');
  });

  test('a second answer for a request already settled is dropped', async () => {
    const { handle, sent, answer } = started();
    const pending = handle.render('x');
    answer({ type: 'rendered', requestId: sent[0].requestId, svg: '<svg id="first"/>' });
    answer({ type: 'rendered', requestId: sent[0].requestId, svg: '<svg id="second"/>' });
    assert.deepStrictEqual(await pending, { ok: true, svg: '<svg id="first"/>' });
    assert.strictEqual(handle.pending(), 0, 'and nothing is left waiting');
  });

  test('an answer arriving after the timeout does not resurrect the request', async () => {
    const { handle, sent, answer } = started({ timeoutMs: 20 });
    const pending = handle.render('x');
    const out = await pending;
    assert.strictEqual(out.ok, false);
    answer({ type: 'rendered', requestId: sent[0].requestId, svg: '<svg id="late"/>' });
    assert.deepStrictEqual(await pending, out, 'the settled answer is the answer, late arrivals notwithstanding');
  });

  test('an answer of a shape this host does not know is a failure, not a silence', async () => {
    const { handle, sent, answer } = started();
    const pending = handle.render('x');
    answer({ type: 'rendered', requestId: sent[0].requestId, svg: 42 });
    const out = await pending;
    assert.strictEqual(out.ok, false);
    assert.match(out.reason, /does not understand/);
  });
});

describe('the two tiers of failure keep their own blast radius', () => {
  test('one block failing fails that request and leaves the others in flight', async () => {
    const { handle, sent, answer } = started();
    const bad = handle.render('not a diagram');
    const good = handle.render('graph TD; A-->B');
    answer({ type: 'renderFailed', requestId: sent[0].requestId, message: 'parse error on line 1' });
    const out = await bad;
    assert.deepStrictEqual(out, { ok: false, reason: 'parse error on line 1' });
    assert.strictEqual(handle.pending(), 1, 'the other request is untouched: a syntax error is not an outage');
    answer({ type: 'rendered', requestId: sent[1].requestId, svg: '<svg/>' });
    assert.deepStrictEqual(await good, { ok: true, svg: '<svg/>' });
  });

  test('the service failing fails everyone waiting, and says so once', async () => {
    const { handle, answer, unusable } = started();
    const first = handle.render('one');
    const second = handle.render('two');
    answer({ type: 'error', message: 'the library did not load' });
    for (const out of [await first, await second]) {
      assert.strictEqual(out.ok, false);
      assert.match(out.reason, /the library did not load/,
        'nobody is left waiting on a frame that has announced it is broken');
    }
    assert.strictEqual(unusable.length, 1, 'and the owning view is told once, not once per pending request');
  });

  test('restart clears the frame and fails what was in flight, which is the recovery the design owes', async () => {
    const { handle, frame } = started();
    const pending = handle.render('x');
    const before = frame;
    handle.restart();
    const out = await pending;
    assert.strictEqual(out.ok, false);
    assert.match(out.reason, /restarted/);
    assert.notStrictEqual(handle.frame(), before, 'a genuinely new frame, not the wedged one reused');
    assert.strictEqual(handle.pending(), 0);
  });

  test('stop leaves no listener, no frame, and nobody waiting', async () => {
    const { handle, win } = started();
    const pending = handle.render('x');
    handle.stop();
    assert.strictEqual((await pending).ok, false);
    assert.strictEqual(handle.frame(), null);
    assert.strictEqual(win.document.querySelectorAll('iframe').length, 0, 'the frame is gone from the document');
    const after = await handle.render('y');
    assert.strictEqual(after.ok, false, 'and a stopped service answers rather than hanging');
  });
});

// The first diagram of every session, which is the one that would have
// failed. The frame has to load its library before it can listen, and for
// mermaid that is 2.83 MB: a render posted into a frame that is not
// listening yet goes nowhere and times out, so every session's first diagram
// would have shown a timeout while every diagram after it drew fine. Found
// by building a real extension rather than by reading this file.
describe('a render asked for before the frame is listening is not lost', () => {
  test('it is held, and posted the moment the frame says ready', async () => {
    const { handle, sent, answer } = started({ silentFrame: true });
    const pending = handle.render('graph TD; A-->B');
    assert.strictEqual(sent.length, 0, 'nothing is posted into a frame that cannot hear it');
    answer({ type: 'ready' });
    assert.strictEqual(sent.length, 1, 'and the moment it can, the request goes');
    answer({ type: 'rendered', requestId: sent[0].requestId, svg: '<svg/>' });
    assert.deepStrictEqual(await pending, { ok: true, svg: '<svg/>' });
  });

  test('several held requests keep the order they were asked in', async () => {
    // A document draws top to bottom. A queue that flushed in any other
    // order would fill the page in a way that reads as random.
    const { handle, sent, answer } = started({ silentFrame: true });
    handle.render('one'); handle.render('two'); handle.render('three');
    assert.strictEqual(sent.length, 0);
    answer({ type: 'ready' });
    assert.deepStrictEqual(sent.map((m) => m.source), ['one', 'two', 'three']);
  });

  test('a frame that never says ready still times out rather than waiting forever', async () => {
    // The timeout starts when the request is made, not when it is posted: a
    // frame that never loads is a frame that never answers, and a request
    // queued forever is the same failure as one lost, only quieter.
    const { handle } = started({ silentFrame: true, timeoutMs: 30 });
    const out = await handle.render('x');
    assert.strictEqual(out.ok, false);
    assert.match(out.reason, /did not answer/);
  });

  test('a restart puts the service back to not-listening, so the retry does not repeat the bug', async () => {
    const { handle, sent, win } = started();
    handle.restart();
    // restart builds a NEW frame, so the old one's window can no longer speak
    // for it: the source check means a message from the frame that was torn
    // down is ignored, which is the behaviour, not the test being awkward.
    const fresh = handle.frame();
    Object.defineProperty(fresh, 'contentWindow', {
      configurable: true, value: { postMessage: (m) => sent.push(m) },
    });
    const answer = (payload) => {
      const event = new win.MessageEvent('message', { data: payload });
      Object.defineProperty(event, 'source', { value: fresh.contentWindow });
      win.dispatchEvent(event);
    };
    const pending = handle.render('after restart');
    assert.strictEqual(sent.length, 0,
      'the new frame has not loaded, and posting into it would fail exactly as the thing being recovered from did');
    answer({ type: 'ready' });
    assert.strictEqual(sent.length, 1);
    answer({ type: 'rendered', requestId: sent[0].requestId, svg: '<svg/>' });
    assert.deepStrictEqual(await pending, { ok: true, svg: '<svg/>' });
  });
});

// Where this design is faster than the counterpart rather than level with it.
// Obsidian redraws every diagram on every open; a diagram whose text has not
// changed does not need drawing again, and reopening a note is the commonest
// thing anyone does with one.
describe('a diagram already drawn is not drawn again', () => {
  test('the same source is answered from what was drawn, without troubling the frame', async () => {
    const { handle, sent, answer } = started();
    const first = handle.render('graph TD; A-->B');
    answer({ type: 'rendered', requestId: sent[0].requestId, svg: '<svg id="once"/>' });
    assert.deepStrictEqual(await first, { ok: true, svg: '<svg id="once"/>' });

    const again = await handle.render('graph TD; A-->B');
    assert.deepStrictEqual(again, { ok: true, svg: '<svg id="once"/>' });
    assert.strictEqual(sent.length, 1, 'the frame was asked once, for two identical blocks');
  });

  test('a source that differs by one character is a different diagram', async () => {
    const { handle, sent, answer } = started();
    const first = handle.render('graph TD; A-->B');
    answer({ type: 'rendered', requestId: sent[0].requestId, svg: '<svg id="first"/>' });
    await first;
    handle.render('graph TD; A-->C');
    assert.strictEqual(sent.length, 2,
      'an edited diagram is redrawn: a cache that answered this would show the old picture');
  });

  test('a failure is never remembered, because the usual reason for one is that it is still being written', async () => {
    const { handle, sent, answer } = started();
    const bad = handle.render('half a diagram');
    answer({ type: 'renderFailed', requestId: sent[0].requestId, message: 'parse error' });
    assert.strictEqual((await bad).ok, false);
    handle.render('half a diagram');
    assert.strictEqual(sent.length, 2,
      'asked again: caching the failure would mean fixing the diagram changed nothing until a reload');
  });

  test('what was drawn survives a restart, so recovery is not slower than the failure', async () => {
    const { handle, sent, answer } = started();
    const first = handle.render('graph TD; A-->B');
    answer({ type: 'rendered', requestId: sent[0].requestId, svg: '<svg id="kept"/>' });
    await first;
    handle.restart();
    const after = await handle.render('graph TD; A-->B');
    assert.deepStrictEqual(after, { ok: true, svg: '<svg id="kept"/>' },
      'drawings are answers, not state inside the frame that was rebuilt');
  });
});

// The palette changed. A drawing made in the old one is not merely stale, it
// is wrong in a way a person sees instantly: a light diagram sitting in a
// dark document reads as broken rather than as somebody else's styling.
describe('a theme change throws away what was drawn in the old palette', () => {
  test('retheme forgets the drawings, where restart deliberately keeps them', async () => {
    const { handle, sent, answer, win } = started();
    const first = handle.render('graph TD; A-->B');
    answer({ type: 'rendered', requestId: sent[0].requestId, svg: '<svg id="light"/>' });
    await first;
    assert.deepStrictEqual(await handle.render('graph TD; A-->B'), { ok: true, svg: '<svg id="light"/>' },
      'cached, as it should be while the palette holds');

    handle.retheme();
    const fresh = handle.frame();
    Object.defineProperty(fresh, 'contentWindow', {
      configurable: true, value: { postMessage: (m) => sent.push(m) },
    });
    const speak = (payload) => {
      const event = new win.MessageEvent('message', { data: payload });
      Object.defineProperty(event, 'source', { value: fresh.contentWindow });
      win.dispatchEvent(event);
    };
    const before = sent.length;
    const redraw = handle.render('graph TD; A-->B');
    speak({ type: 'ready' });
    assert.strictEqual(sent.length, before + 1,
      'the same diagram is asked for again, because the answer it had was drawn in a palette that is gone');
    speak({ type: 'rendered', requestId: sent[sent.length - 1].requestId, svg: '<svg id="dark"/>' });
    assert.deepStrictEqual(await redraw, { ok: true, svg: '<svg id="dark"/>' });
  });

  test('the frame is rebuilt too, so the new one reads the new tokens', () => {
    const { handle } = started();
    const before = handle.frame();
    handle.retheme();
    assert.notStrictEqual(handle.frame(), before,
      'the tokens are injected when the frame document is built, so a new palette needs a new frame');
  });
});

// Confinement for the frame that draws regions. It receives every diagram's
// source text for the session, so a frame that has become some other page
// must be stopped before anything more is posted to it. Unit level: these
// fail fast when the rule is removed. The real-engine proof is the
// confinement e2e.
describe('a render frame that leaves is stopped, and nothing more is posted to it', () => {
  test('a second ready is the frame leaving: queue dropped, waiters failed, service unusable', async () => {
    const { answer, handle, sent, unusable } = started();
    const pending = handle.render('graph TD; A-->B');
    const before = sent.length;
    answer({ type: 'ready' });
    const outcome = await pending;
    assert.strictEqual(outcome.ok, false);
    assert.match(outcome.reason, /tried to leave its view/);
    assert.deepStrictEqual(unusable, ['the extension tried to leave its view and was stopped']);
    assert.strictEqual(sent.length, before, 'nothing is flushed to the page that said ready the second time');
    assert.strictEqual(handle.frame(), null, 'the departed frame is removed');
  });

  test('a second load on the frame is the frame leaving', () => {
    const { frame, unusable, win } = started();
    frame.dispatchEvent(new win.Event('load'));
    assert.deepStrictEqual(unusable, [], 'the first load is the frame arriving');
    frame.dispatchEvent(new win.Event('load'));
    assert.deepStrictEqual(unusable, ['the extension tried to leave its view and was stopped']);
  });

  test('a restart builds a new frame, entitled to its own ready', () => {
    const { handle, unusable, win } = started();
    handle.restart();
    const fresh = handle.frame();
    const posted = [];
    Object.defineProperty(fresh, 'contentWindow', { configurable: true, value: { postMessage: (m) => posted.push(m) } });
    const event = new win.MessageEvent('message', { data: { type: 'ready' } });
    Object.defineProperty(event, 'source', { value: fresh.contentWindow });
    win.dispatchEvent(event);
    assert.deepStrictEqual(unusable, [], 'the new frame saying ready once is not the frame leaving');
  });
});
