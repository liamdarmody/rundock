// File-type registry: classification, transport URL, CSP injection, and the
// viewer mount contract (read-only handles, clean teardown). Mount tests run
// the real module under jsdom, mirroring the editor harness approach.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  classify, workspaceFileUrl, buildSrcdoc, ARTIFACT_CSP,
  mountArtifactPreview, mountImageViewer, mountPdfViewer, mountUnsupportedViewer, mountViewer,
} from '../../public/viewers/registry.js';

describe('classify', () => {
  test('routes each extension family to its kind, case-insensitive', () => {
    assert.equal(classify('notes/plan.md'), 'markdown');
    assert.equal(classify('draft.MDX'), 'markdown');
    assert.equal(classify('proposal.html'), 'artifact');
    assert.equal(classify('page.HTM'), 'artifact');
    assert.equal(classify('diagram.svg'), 'artifact');
    assert.equal(classify('chart.png'), 'image');
    assert.equal(classify('photo.JPEG'), 'image');
    assert.equal(classify('anim.gif'), 'image');
    assert.equal(classify('pic.webp'), 'image');
    assert.equal(classify('report.pdf'), 'pdf');
    assert.equal(classify('log.txt'), 'text');
    assert.equal(classify('data.json'), 'text');
    assert.equal(classify('archive.zip'), 'unsupported');
    assert.equal(classify('doc.docx'), 'unsupported');
    assert.equal(classify('no-extension'), 'unsupported');
  });

  test('degenerate inputs are unsupported, never a throw', () => {
    assert.equal(classify(''), 'unsupported');
    assert.equal(classify(null), 'unsupported');
    assert.equal(classify(undefined), 'unsupported');
    assert.equal(classify(42), 'unsupported');
  });

  test('the extension decides, not a substring: "x.md.zip" is not markdown', () => {
    assert.equal(classify('x.md.zip'), 'unsupported');
    assert.equal(classify('x.html.bak'), 'unsupported');
  });
});

describe('workspaceFileUrl', () => {
  test('encodes the path for the binary endpoint', () => {
    assert.equal(workspaceFileUrl('docs/report.pdf'), '/workspace-file?path=docs%2Freport.pdf');
    assert.equal(workspaceFileUrl('a b&c.png'), '/workspace-file?path=a%20b%26c.png');
  });
});

describe('buildSrcdoc: CSP injection', () => {
  test('injects the CSP meta right after a leading doctype (before every element)', () => {
    const out = buildSrcdoc('<!doctype html><html><head><title>T</title></head><body>x</body></html>');
    assert.match(out, new RegExp('^<!doctype html><meta http-equiv="Content-Security-Policy" content="' + ARTIFACT_CSP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"><html>'));
  });

  test('no doctype: the meta is prepended as the first token', () => {
    const out = buildSrcdoc('<html><head lang="en"><style>p{}</style></head><body></body></html>');
    assert.ok(out.startsWith('<meta http-equiv="Content-Security-Policy"'));
    assert.ok(out.indexOf('Content-Security-Policy') < out.indexOf('<html'));
  });

  test('a fragment gets the meta prepended', () => {
    const frag = buildSrcdoc('<p>fragment</p>');
    assert.ok(frag.startsWith('<meta http-equiv="Content-Security-Policy"'));
    assert.ok(frag.endsWith('<p>fragment</p>'));
  });

  test('artifact bytes are otherwise untouched (faithful render)', () => {
    const src = '<html><head></head><body class="x">  weird   spacing\n<div style="color:red">&amp;</div></body></html>';
    const out = buildSrcdoc(src);
    assert.equal(out.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, ''), src);
  });

  test('null/undefined content produces a valid empty document, not "null"', () => {
    assert.equal(buildSrcdoc(null).includes('null'), false);
    assert.ok(buildSrcdoc(undefined).startsWith('<meta'));
  });

  // Adversarial regression: the CSP meta must precede EVERY element so the
  // policy commits before any resource fetch. A leading <img> before the
  // artifact's own <head> previously escaped the policy entirely.
  test('the CSP meta precedes a resource element placed before the artifact head', () => {
    const evil = '<img src="https://evil.example/beacon">\n<html><head></head><body></body></html>';
    const out = buildSrcdoc(evil);
    assert.ok(out.indexOf('Content-Security-Policy') < out.indexOf('<img'), 'CSP comes before the img');
    assert.ok(out.startsWith('<meta http-equiv="Content-Security-Policy"'));
  });

  test('a leading doctype is preserved with the meta right after it (no quirks mode)', () => {
    const out = buildSrcdoc('<!doctype html><html><head></head><body><img src="https://x/y"></body></html>');
    assert.match(out, /^<!doctype html><meta http-equiv="Content-Security-Policy"/i);
    assert.ok(out.indexOf('Content-Security-Policy') < out.indexOf('<img'));
  });

  // Security: a meta refresh can navigate the sandboxed frame to an external
  // URL and phone home; CSP has no directive that governs navigation. Strip
  // any http-equiv=refresh meta before it reaches srcdoc.
  test('a meta refresh to an external URL is stripped', () => {
    const evil = '<!doctype html><html><head><meta http-equiv="refresh" content="0;url=https://evil.example/track"></head><body>x</body></html>';
    const out = buildSrcdoc(evil);
    assert.ok(!/http-equiv\s*=\s*["']?refresh/i.test(out), 'no refresh meta survives');
    assert.ok(!out.includes('evil.example'), 'the external URL is gone');
    // The CSP meta itself (http-equiv=Content-Security-Policy) must remain.
    assert.ok(out.includes('Content-Security-Policy'));
  });

  test('meta refresh is stripped regardless of case, quoting, and attribute order', () => {
    for (const meta of [
      '<META HTTP-EQUIV=REFRESH CONTENT="2">',
      "<meta content='5; url=https://x/y' http-equiv='refresh'>",
      '<meta   http-equiv = "refresh"   content="0">',
      '<meta content="0;url=https://x?a>b" http-equiv="refresh">',
    ]) {
      const out = buildSrcdoc(`<html><head>${meta}</head><body></body></html>`);
      assert.ok(!/http-equiv\s*=\s*["']?refresh/i.test(out), `stripped: ${meta}`);
    }
  });

  test('a non-refresh meta (e.g. charset, viewport) is preserved', () => {
    const src = '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head><body></body></html>';
    const out = buildSrcdoc(src);
    assert.ok(out.includes('charset="utf-8"'));
    assert.ok(out.includes('name="viewport"'));
  });
});

// ---------- mount contract under jsdom ----------

function pane() {
  const dom = new JSDOM('<!doctype html><html><body><div id="pane"></div></body></html>', { url: 'http://localhost/' });
  return dom.window.document.getElementById('pane');
}

describe('viewer mounts', () => {
  test('artifact preview: sandboxed iframe, srcdoc carries content + CSP, read-only handle', () => {
    const el = pane();
    const handle = mountArtifactPreview({ paneElement: el, content: '<p>Hello artifact</p>' });
    const iframe = el.querySelector('iframe.viewer-frame');
    assert.ok(iframe, 'iframe mounted');
    // allow-same-origin with NO allow-scripts: the document cannot execute
    // code, and the host can read it for the review loop. The dangerous
    // combination is allow-scripts + allow-same-origin: pin its absence.
    assert.equal(iframe.getAttribute('sandbox'), 'allow-same-origin');
    assert.ok(!iframe.getAttribute('sandbox').includes('allow-scripts'), 'scripts stay off, always');
    assert.ok(handle.iframe === iframe, 'handle exposes the frame for the review loop');
    assert.ok(iframe.getAttribute('srcdoc').includes('<p>Hello artifact</p>'));
    assert.ok(iframe.getAttribute('srcdoc').includes('Content-Security-Policy'));
    assert.equal(handle.getContentForSave, null, 'read-only: never participates in save');
    handle.destroy();
    assert.equal(el.querySelector('iframe'), null, 'destroy clears the pane');
    assert.equal(el.classList.contains('viewer-host'), false, 'host class removed');
  });

  test('artifact preview: an oversized artifact shows a notice instead of building a huge srcdoc', () => {
    const el = pane();
    const huge = '<p>' + 'x'.repeat(5 * 1024 * 1024) + '</p>';
    const handle = mountArtifactPreview({ paneElement: el, content: huge });
    assert.equal(el.querySelector('iframe'), null, 'no iframe for an oversized artifact');
    const notice = el.querySelector('.viewer-unsupported');
    assert.ok(notice, 'a notice is shown');
    assert.match(notice.textContent, /too large/i);
    assert.equal(handle.getContentForSave, null, 'still read-only');
    handle.destroy();
  });

  test('image viewer: <img> over the binary endpoint, encoded path', () => {
    const el = pane();
    const handle = mountImageViewer({ paneElement: el, path: 'shots/final render.png' });
    const img = el.querySelector('img');
    assert.equal(img.getAttribute('src'), '/workspace-file?path=shots%2Ffinal%20render.png');
    assert.equal(handle.getContentForSave, null);
    handle.destroy();
    assert.equal(el.querySelector('img'), null);
  });

  test('pdf viewer: iframe src over the binary endpoint, no srcdoc', () => {
    const el = pane();
    const handle = mountPdfViewer({ paneElement: el, path: 'docs/report.pdf' });
    const iframe = el.querySelector('iframe.viewer-frame');
    // Opens with the pages/thumbnails panel collapsed (navpanes=0).
    assert.equal(iframe.getAttribute('src'), '/workspace-file?path=docs%2Freport.pdf#navpanes=0');
    assert.equal(iframe.hasAttribute('srcdoc'), false);
    handle.destroy();
  });

  test('unsupported viewer: clear cannot-preview state, never raw bytes', () => {
    const el = pane();
    mountUnsupportedViewer({ paneElement: el, path: 'archive.zip' });
    assert.ok(el.textContent.includes('Cannot preview this file'));
    assert.ok(el.textContent.includes('.zip'));
  });

  test('mountViewer dispatches by kind and falls back to unsupported', () => {
    let el = pane();
    mountViewer('image', { paneElement: el, path: 'a.png' });
    assert.ok(el.querySelector('img'));
    el = pane();
    mountViewer('pdf', { paneElement: el, path: 'a.pdf' });
    assert.ok(el.querySelector('iframe'));
    el = pane();
    mountViewer('unsupported', { paneElement: el, path: 'a.zip' });
    assert.ok(el.textContent.includes('Cannot preview'));
  });

  test('remounting into the same pane replaces content; double destroy is safe', () => {
    const el = pane();
    const h1 = mountImageViewer({ paneElement: el, path: 'a.png' });
    const h2 = mountPdfViewer({ paneElement: el, path: 'b.pdf' });
    assert.equal(el.querySelectorAll('img').length, 0, 'previous viewer content replaced');
    assert.equal(el.querySelectorAll('iframe').length, 1);
    h1.destroy();
    h1.destroy();
    h2.destroy();
    assert.equal(el.innerHTML, '');
  });
});
