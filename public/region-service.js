'use strict';
/**
 * One render service per extension, for the life of the app.
 *
 * WHAT THIS IS. A region extension does not draw; it computes. This holds the
 * hidden frame that computing happens in, sends it a block's source, and
 * hands back what it returned. The host draws. The reasoning is recorded in
 * Decisions/What-Crosses-The-Extension-Frame-Boundary.md and
 * Decisions/How-A-Region-Renders-And-Fails.md.
 *
 * ONE FRAME PER EXTENSION, NOT PER DOCUMENT (Decide 22). The frame carries no
 * document identity: it receives {requestId, source} and answers
 * {requestId, svg} or {requestId, message}. So switching between three notes
 * that use the same extension, or reopening one note ten times in a day,
 * costs one frame load in total. Mermaid is 2.82 MB; per-document would pay
 * that on every open, and the reading pattern this is for is a file opened
 * and closed all day.
 *
 * THE COST OF THAT CHOICE, AND THE CONDITION IT WAS APPROVED UNDER. One
 * long-lived frame means a wedged frame takes every region of that extension
 * with it, everywhere, until something rebuilds it. So `restart` exists and
 * the error card offers it: the worst case is one click, not a restart of
 * Rundock. That is part of the decision, not a follow-up to it.
 *
 * A REQUEST IS ANSWERED OR IT IS NOT, AND EITHER WAY IT IS FORGOTTEN. Every
 * request is tagged, and an answer is routed back to whoever asked. An answer
 * for a region the person has since navigated away from is discarded on
 * arrival rather than drawn into a document that no longer has a place for
 * it: the caller decides that by resolving to a region that is gone, which is
 * why the waiter is dropped from the table before the callback runs.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else root.RundockRegionService = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  // Long enough that a big diagram on a loaded machine is not cut off,
  // short enough that a wedged frame is noticed while the person is still
  // looking at the page rather than after they have given up on it.
  const RENDER_TIMEOUT_MS = 10000;

  /**
   * @param {object} opts
   *   doc          the host document, for creating the frame
   *   win          the window to listen on
   *   srcdoc       the frame document, built by the extension host so the
   *                posture cannot drift between this path and a mount. A
   *                FUNCTION, called for every build, because the document it
   *                returns carries the host's design tokens and those change
   *                when the theme does. Held as a string it would be the
   *                palette that was true when the service started, and a
   *                re-theme would carefully throw away every drawing and
   *                redraw them all in exactly the colours it was trying to
   *                replace. A string is still accepted and is the right
   *                answer for a caller whose document cannot change.
   *   onUnusable   called with a reason when the whole service fails, which
   *                is the second tier of Decide 29: every region of this
   *                extension, not one of them
   */
  // Every live service's way to stop for leaving: see endForLeaving below,
  // and endViewsForLeaving in extension-host.js for why all of them.
  const liveServices = new Set();
  function endAllForLeaving() {
    for (const end of [...liveServices]) end();
  }

  function startRegionService(opts) {
    const { doc, win, srcdoc, onUnusable } = opts;
    const currentSrcdoc = typeof srcdoc === 'function' ? srcdoc : () => srcdoc;
    const timeoutMs = opts.timeoutMs || RENDER_TIMEOUT_MS;
    if (typeof onUnusable !== 'function') {
      throw new Error('startRegionService requires onUnusable: a service nobody is told about cannot be recovered');
    }

    const waiting = new Map();
    // What has already been drawn, by the exact source that produced it.
    //
    // A diagram whose text has not changed does not need drawing again, and
    // reopening a note is the commonest thing a person does with one. The
    // counterpart redraws on every open; this does not, which is the one
    // place this design is faster rather than merely level.
    //
    // Keyed by the source itself: it is the whole input, so two blocks with
    // the same text genuinely have the same drawing, and a block whose text
    // changed by one character is a different key rather than a stale hit.
    const drawings = new Map();
    // Which source each in-flight request asked for, so an answer can be
    // remembered under the text that produced it.
    const sources = new Map();
    // Renders asked for before the frame said `ready`. The frame has to load
    // its library first, and for mermaid that is 2.83 MB: a render posted
    // into a frame whose listener is not attached yet goes nowhere and times
    // out, which would make the FIRST diagram of every session fail while
    // every one after it worked. Held here and flushed on ready.
    let queued = [];
    let ready = false;
    // Per FRAME, reset by build(): a restart makes a new frame, which is
    // entitled to its own `ready` and its own first load.
    let readySeen = false;
    let loads = 0;
    let frame = null;
    let alive = true;
    let nextId = 0;

    function build() {
      frame = doc.createElement('iframe');
      // The same posture a mounted view gets, set before anything else so a
      // failure between here and the append can never leave a wider frame.
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.setAttribute('title', 'Extension render service');
      // Never seen. This frame has no viewport role at all: it is why
      // "headless" is the word for it, and why nothing here positions,
      // sizes or scrolls anything.
      frame.setAttribute('aria-hidden', 'true');
      frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden;';
      readySeen = false;
      loads = 0;
      // A SECOND LOAD IS THE FRAME LEAVING, the same rule the view host
      // follows and for the same measured reason: a sandboxed frame may
      // always navigate itself, and the page that replaces it is still
      // `frame.contentWindow`. Here the loss would be every diagram's source
      // text from then on, posted to whoever the frame became.
      const built = frame;
      built.addEventListener('load', () => {
        if (built !== frame) return;
        loads += 1;
        if (loads > 1) left();
      });
      // Asked for now rather than remembered: see the srcdoc note above.
      frame.srcdoc = currentSrcdoc();
      doc.body.appendChild(frame);
    }

    // Everyone still waiting is answered, because a request that is never
    // answered is a region that shows a skeleton forever. A caller that has
    // gone away ignores its answer; a caller still on screen gets to say so.
    // The frame stopped being the extension. Nothing more is posted to it:
    // it is removed, the queue is dropped, everyone waiting is told, and the
    // regions this extension draws show the failure with the restart the
    // session-long frame was approved on.
    function left() {
      const reason = 'the extension tried to leave its view and was stopped';
      ready = false;
      queued = [];
      if (frame && frame.parentNode) frame.parentNode.removeChild(frame);
      frame = null;
      failEveryone(reason);
      onUnusable(reason);
    }

    function failEveryone(reason) {
      const pending = [...waiting.values()];
      waiting.clear();
      for (const settle of pending) settle({ ok: false, reason });
    }

    function onMessage(event) {
      if (!alive || !frame || event.source !== frame.contentWindow) return;
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      // The whole-service failure: not tagged, because it is not about one
      // request. Tier two of Decide 29.
      if (data.type === 'error' && data.requestId === undefined) {
        const reason = `the extension reported a failure: ${data.message}`;
        failEveryone(reason);
        onUnusable(reason);
        return;
      }
      // The frame is listening. Anything held back goes now, in the order it
      // was asked for, because a document's diagrams should appear top to
      // bottom rather than in whatever order the queue happened to hold.
      if (data.type === 'ready') {
        // Once per frame. The page that replaced a departed frame announces
        // itself with `ready` before its load event fires (measured), and
        // flushing the queue to it would hand it the waiting diagrams.
        if (readySeen) { left(); return; }
        readySeen = true;
        ready = true;
        const held = queued;
        queued = [];
        for (const send of held) send();
        return;
      }
      const id = data.requestId;
      if (typeof id !== 'string') return;
      const settle = waiting.get(id);
      // An answer nobody is waiting for. Either it already timed out, or the
      // frame answered twice. Dropped in silence: replying would only teach a
      // misbehaving frame that the host is listening.
      if (!settle) return;
      waiting.delete(id);
      if (data.type === 'rendered' && typeof data.svg === 'string') {
        const asked = sources.get(id);
        // Only a SUCCESS is remembered. A failure is not cached, because the
        // commonest reason a diagram fails is that its author is still
        // writing it, and a cached failure would mean fixing it changed
        // nothing until the page was reloaded.
        if (typeof asked === 'string') drawings.set(asked, data.svg);
        settle({ ok: true, svg: data.svg });
        return;
      }
      if (data.type === 'renderFailed') {
        settle({ ok: false, reason: typeof data.message === 'string' ? data.message : 'the diagram could not be drawn' });
        return;
      }
      settle({ ok: false, reason: 'the extension answered with something this host does not understand' });
    }

    win.addEventListener('message', onMessage);
    build();
    const endForLeaving = () => { if (alive && frame) left(); };
    liveServices.add(endForLeaving);

    /**
     * Ask for one block to be drawn.
     * @returns {Promise<{ok: true, svg: string} | {ok: false, reason: string}>}
     * Never rejects: a region that cannot be drawn is a state to render, not
     * an exception for a caller to remember to catch.
     */
    function render(source) {
      if (!alive) return Promise.resolve({ ok: false, reason: 'the render service has been stopped' });
      const text = String(source == null ? '' : source);
      if (drawings.has(text)) return Promise.resolve({ ok: true, svg: drawings.get(text) });
      const id = `r${nextId += 1}`;
      return new Promise((resolve) => {
        let done = false;
        const settle = (answer) => { if (done) return; done = true; win.clearTimeout(timer); resolve(answer); };
        const timer = win.setTimeout(() => {
          waiting.delete(id);
          // serviceFailed, not just a reason: a timeout is the extension
          // failing, not this diagram being wrong, and only the caller knows
          // the extension's name and how to say so to a reader. A transport
          // that writes user-facing copy makes that copy unfixable from the
          // place that has the context for it.
          settle({ ok: false, serviceFailed: true, reason: `the extension did not answer within ${timeoutMs}ms` });
        }, timeoutMs);
        waiting.set(id, settle);
        sources.set(id, text);
        const post = () => {
          try {
            frame.contentWindow.postMessage({ type: 'render', requestId: id, source: String(source == null ? '' : source) }, '*');
          } catch (e) {
            waiting.delete(id);
            settle({ ok: false, reason: 'the render service could not be reached' });
          }
        };
        // The timeout above is already running, deliberately: a frame that
        // never says ready is a frame that never answers, and a request
        // queued forever is the same failure as one lost, only quieter.
        if (ready) post(); else queued.push(post);
      });
    }

    // The recovery the session-long frame was approved on. Everyone waiting
    // is failed first, because their frame is about to stop existing.
    function restart() {
      // The drawings survive a restart: they are answers, not state in the
      // frame, and throwing them away would make recovery slower than the
      // failure it recovers from.
      // The new frame has not loaded, so nothing may be posted into it until
      // it says so. Missing this would make the retry that recovery depends
      // on fail exactly as the thing it is recovering from did.
      ready = false;
      queued = [];
      failEveryone('the render service was restarted');
      if (frame && frame.parentNode) frame.parentNode.removeChild(frame);
      build();
    }

    /**
     * The palette changed, so everything drawn in the old one is wrong.
     *
     * Distinct from restart, and the difference is the cache. A restart
     * recovers from a wedged frame and KEEPS what was drawn, because those
     * are answers and rebuilding them would make recovery slower than the
     * failure. A re-theme throws them away on purpose: they are answers to
     * the same question asked in a different palette, and serving one now
     * would show a light diagram in a dark document, which is the exact
     * thing this exists to fix.
     */
    function retheme() {
      drawings.clear();
      // restart() rebuilds the frame, and build() asks for the document
      // again, so the new frame is the one carrying the new palette. That
      // dependency is the whole reason srcdoc is a function.
      restart();
    }

    function stop() {
      liveServices.delete(endForLeaving);
      alive = false;
      ready = false;
      queued = [];
      win.removeEventListener('message', onMessage);
      failEveryone('the render service has been stopped');
      if (frame && frame.parentNode) frame.parentNode.removeChild(frame);
      frame = null;
    }

    return { render, restart, retheme, stop, frame: () => frame, pending: () => waiting.size };
  }

  return { startRegionService, endAllForLeaving, RENDER_TIMEOUT_MS };
}));
