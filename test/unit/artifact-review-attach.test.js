'use strict';
// A REVIEW ATTACHES TO THE ARTIFACT'S OWN DOCUMENT, NEVER TO THE EMPTY ONE
// BEFORE IT.
//
// The HTML preview is a frame given a srcdoc. Until that document commits,
// the frame holds the browser's initial empty document, which Chromium
// reports as complete, with a body. Attaching the review waits for the
// comments file to be fetched first, and when that answer came back before
// the srcdoc committed, the readiness check took the empty document for the
// artifact: the review attached to a document about to be replaced, the
// comments were listed beside the preview, and no mark was ever drawn in it.
// A browser test of a comment re-anchoring after a live change timed out on
// that missing mark (docs/FLAKES.md).
//
// The function that ships is cut out of public/views/files.js and run with a
// stand-in frame whose document is replaced the way a browser replaces it,
// and with the review module and the fetch stubbed, so each order of events
// is chosen here rather than left to timing.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const FILES_SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'views', 'files.js'), 'utf8');
const IMPORT = "import('/viewers/artifact-review.js')";

// The shipped function, with its module import routed to a stub. Refuses when
// the function or its import is missing, so a rename fails here by name.
function attachFunction(env) {
  const found = FILES_SRC.match(/async function attachArtifactReviewForCurrentFile\(paneEl\) \{[\s\S]*?\n\}/);
  assert.ok(found, 'public/views/files.js no longer carries attachArtifactReviewForCurrentFile');
  assert.ok(found[0].includes(IMPORT), 'the attach no longer imports the review module the way this test stubs it');
  const body = found[0].replace(IMPORT, "loadReview('/viewers/artifact-review.js')");
  return new Function('env', `
    let { currentFilePath, activeFileViewer, activeArtifactReview, workspaceAnalysis, agents } = env;
    const { loadReview, fetch, document, destroyActiveArtifactReview, openWikilink, openWorkspaceFilePath } = env;
    ${body}
    return attachArtifactReviewForCurrentFile;`)(env);
}

// A frame as the browser presents one given a srcdoc: first the initial empty
// document, complete and with a body, then the artifact's own, which commits
// later and fires load once it has finished.
function frame({ artifactState = 'complete' } = {}) {
  const empty = { URL: 'about:blank', readyState: 'complete', body: {} };
  const artifact = { URL: 'about:srcdoc', readyState: artifactState, body: {} };
  const waiting = [];
  const iframe = {
    isConnected: true,
    contentDocument: empty,
    addEventListener(type, fn) { if (type === 'load') waiting.push(fn); },
  };
  return {
    iframe, empty, artifact,
    commit() { iframe.contentDocument = artifact; },
    finish() { artifact.readyState = 'complete'; for (const fn of waiting.splice(0)) fn(); },
  };
}

// Every document the review was attached to, in order.
function attachWith(f) {
  const attachedTo = [];
  const review = {
    sidecarPathFor: (p) => `.rundock/reviews/${p}.json`,
    attachArtifactReview: (opts) => { attachedTo.push(opts.iframe.contentDocument); return { detach() {} }; },
  };
  const attach = attachFunction({
    currentFilePath: 'notes/live.html',
    activeFileViewer: { iframe: f.iframe },
    activeArtifactReview: null,
    workspaceAnalysis: null,
    agents: [],
    loadReview: async () => review,
    fetch: async () => ({ ok: true, status: 200, text: async () => '{"version":1,"comments":{}}' }),
    document: { getElementById: () => null },
    destroyActiveArtifactReview() {},
    openWikilink() {},
    openWorkspaceFilePath() {},
  });
  return { attachedTo, run: () => attach({}) };
}

test('comments fetched before the artifact commits wait for it, then attach to it once', async () => {
  const f = frame();
  const { attachedTo, run } = attachWith(f);
  await run();
  assert.deepStrictEqual(attachedTo.map((d) => d.URL), [], 'nothing is attached to the empty document the frame starts with');
  f.commit();
  f.finish();
  assert.strictEqual(attachedTo.length, 1, 'attached once, when the artifact has loaded');
  assert.strictEqual(attachedTo[0], f.artifact, 'to the artifact\'s own document');
});

test('an artifact that has already loaded is attached to at once', async () => {
  const f = frame();
  f.commit();
  const { attachedTo, run } = attachWith(f);
  await run();
  assert.strictEqual(attachedTo.length, 1);
  assert.strictEqual(attachedTo[0], f.artifact);
});

test('an artifact still loading is attached to when it has loaded, not before', async () => {
  const f = frame({ artifactState: 'loading' });
  f.commit();
  const { attachedTo, run } = attachWith(f);
  await run();
  assert.strictEqual(attachedTo.length, 0, 'nothing attached while the artifact is still loading');
  f.finish();
  assert.strictEqual(attachedTo.length, 1);
  assert.strictEqual(attachedTo[0], f.artifact);
});
