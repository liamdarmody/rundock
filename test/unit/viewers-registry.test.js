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
  test('injects the CSP meta inside an existing <head>', () => {
    const out = buildSrcdoc('<!doctype html><html><head><title>T</title></head><body>x</body></html>');
    assert.ok(out.includes(`<head><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}"><title>`));
  });

  test('head with attributes still gets the meta inside it', () => {
    const out = buildSrcdoc('<html><head lang="en"><style>p{}</style></head><body></body></html>');
    assert.match(out, /<head lang="en"><meta http-equiv="Content-Security-Policy"/);
  });

  test('no <head>: injects after <html>; fragment: prepends', () => {
    const html = buildSrcdoc('<html><body><p>x</p></body></html>');
    assert.match(html, /<html><meta http-equiv="Content-Security-Policy"/);
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
    assert.equal(iframe.getAttribute('sandbox'), '', 'sandbox is full lockdown: no tokens');
    assert.ok(iframe.getAttribute('srcdoc').includes('<p>Hello artifact</p>'));
    assert.ok(iframe.getAttribute('srcdoc').includes('Content-Security-Policy'));
    assert.equal(handle.getContentForSave, null, 'read-only: never participates in save');
    handle.destroy();
    assert.equal(el.querySelector('iframe'), null, 'destroy clears the pane');
    assert.equal(el.classList.contains('viewer-host'), false, 'host class removed');
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
    assert.equal(iframe.getAttribute('src'), '/workspace-file?path=docs%2Freport.pdf');
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
