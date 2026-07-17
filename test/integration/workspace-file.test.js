'use strict';
// Integration: the /workspace-file binary endpoint (the http-binary transport
// for the file-type registry's image and PDF viewers). Text files keep riding
// the WS read_file path; this endpoint exists because binary bytes cannot
// survive the utf-8 normalisation there. Guards mirror /api/file: workspace
// boundary, no traversal, no sibling-prefix escape. Additionally the endpoint
// is allowlist-only (image + PDF types): it must never become a generic file
// server for the workspace.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');

// Minimal valid 1x1 PNG (includes a 0x00 byte and a 0x89 high byte: proves
// the response is served as raw bytes, not utf-8-mangled text).
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), // PNG signature
  Buffer.from([0x00, 0x00, 0x00, 0x0d]),                          // IHDR length
  Buffer.from('IHDR'),
  Buffer.from([0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00]),
  Buffer.from([0x1f, 0x15, 0xc4, 0x89]),                          // IHDR crc
  Buffer.from([0x00, 0x00, 0x00, 0x00]),
  Buffer.from('IEND'),
  Buffer.from([0xae, 0x42, 0x60, 0x82]),
]);
const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');

before(async () => {
  await h.boot({
    workspaceOpts: { files: { 'notes.md': 'plain note' } },
  });
  fs.writeFileSync(path.join(h.workspaceDir, 'chart.png'), PNG_BYTES);
  fs.mkdirSync(path.join(h.workspaceDir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(h.workspaceDir, 'docs', 'report.pdf'), PDF_BYTES);
  fs.writeFileSync(path.join(h.workspaceDir, 'photo.JPG'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]));
});
after(async () => h.shutdown());

function getRaw(urlPath) {
  return fetch(`http://127.0.0.1:${h.port}${urlPath}`).then(async res => ({
    status: res.status,
    bytes: Buffer.from(await res.arrayBuffer()),
    headers: res.headers,
  }));
}

describe('/workspace-file binary endpoint', () => {
  test('serves a PNG byte-identical with image/png and nosniff', async () => {
    const res = await getRaw('/workspace-file?path=chart.png');
    assert.strictEqual(res.status, 200);
    assert.ok(res.bytes.equals(PNG_BYTES), 'bytes must be identical (no utf-8 mangling)');
    assert.strictEqual(res.headers.get('content-type'), 'image/png');
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  });

  test('serves a nested PDF as application/pdf', async () => {
    const res = await getRaw('/workspace-file?path=' + encodeURIComponent('docs/report.pdf'));
    assert.strictEqual(res.status, 200);
    assert.ok(res.bytes.equals(PDF_BYTES));
    assert.strictEqual(res.headers.get('content-type'), 'application/pdf');
  });

  test('extension matching is case-insensitive', async () => {
    const res = await getRaw('/workspace-file?path=photo.JPG');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'image/jpeg');
  });

  test('non-allowlisted extensions are refused, even for real files', async () => {
    // notes.md exists in the workspace, but this endpoint is not a generic
    // file server: text rides the WS path, html rides srcdoc. 404, no body leak.
    const res = await getRaw('/workspace-file?path=notes.md');
    assert.strictEqual(res.status, 404);
    assert.ok(!res.bytes.toString().includes('plain note'));
    // server.js itself must never be reachable whatever the extension story
    const srv = await getRaw('/workspace-file?path=' + encodeURIComponent('../server.js'));
    assert.strictEqual(srv.status, 404);
  });

  test('blocks ../ traversal and absolute paths out of the workspace', async () => {
    const outside = path.join(h.workspaceDir, '..', `outside-${Date.now()}.png`);
    fs.writeFileSync(outside, PNG_BYTES);
    try {
      const rel = await getRaw('/workspace-file?path=' + encodeURIComponent('../' + path.basename(outside)));
      assert.strictEqual(rel.status, 404, 'relative traversal must be rejected');
      const abs = await getRaw('/workspace-file?path=' + encodeURIComponent(outside));
      assert.strictEqual(abs.status, 404, 'absolute path must be rejected');
    } finally {
      fs.unlinkSync(outside);
    }
  });

  test('blocks the sibling-prefix escape', async () => {
    const sibling = h.workspaceDir + '-evil';
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, 'leak.png'), PNG_BYTES);
    try {
      const res = await getRaw('/workspace-file?path=' + encodeURIComponent(`../${path.basename(sibling)}/leak.png`));
      assert.strictEqual(res.status, 404, 'sibling-prefix path must be rejected');
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });

  test('missing file and directory paths are 404', async () => {
    assert.strictEqual((await getRaw('/workspace-file?path=nope.png')).status, 404);
    // a directory named like an image must not be readFile'd
    fs.mkdirSync(path.join(h.workspaceDir, 'weird.png'), { recursive: true });
    assert.strictEqual((await getRaw('/workspace-file?path=weird.png')).status, 404);
  });

  test('malformed percent-encoding returns 400, does not crash the server', async () => {
    // Adversarial regression: decodeURIComponent throws URIError on a lone
    // '%'; unguarded that killed the process. 400 + a live sentinel proves
    // the server survived.
    assert.strictEqual((await getRaw('/workspace-file?path=%')).status, 400);
    assert.strictEqual((await getRaw('/workspace-file?path=%zz')).status, 400);
    assert.strictEqual((await getRaw('/workspace-file?path=chart.png')).status, 200, 'server still serving');
  });
});

describe('/api/review-sidecar', () => {
  function post(body) {
    return fetch(`http://127.0.0.1:${h.port}/api/review-sidecar`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  }

  test('creates .rundock/reviews/ on first use and writes the sidecar', async () => {
    const res = await post({ path: '.rundock/reviews/proposal.html-12345678.json', content: '{"path":"proposal.html"}' });
    assert.strictEqual(res.status, 200);
    const written = path.join(h.workspaceDir, '.rundock', 'reviews', 'proposal.html-12345678.json');
    assert.strictEqual(fs.readFileSync(written, 'utf-8'), '{"path":"proposal.html"}');
  });

  test('refuses paths outside .rundock/reviews/ (flat json filenames only)', async () => {
    for (const bad of [
      'notes.md',
      '.rundock/reviews/../../CLAUDE.md',
      '.rundock/reviews/nested/dir.json',
      '.rundock/reviews/evil.sh',
      '/etc/passwd',
    ]) {
      const res = await post({ path: bad, content: 'x' });
      assert.strictEqual(res.status, 400, `must refuse: ${bad}`);
    }
    assert.strictEqual(fs.existsSync(path.join(h.workspaceDir, '..', 'CLAUDE.md')), false);
  });

  test('malformed body is 400', async () => {
    const res = await fetch(`http://127.0.0.1:${h.port}/api/review-sidecar`, { method: 'POST', body: 'not json' });
    assert.strictEqual(res.status, 400);
    const noContent = await post({ path: '.rundock/reviews/a.json' });
    assert.strictEqual(noContent.status, 400);
  });

  test('an oversized body is rejected (413), not accumulated unboundedly', async () => {
    const huge = 'x'.repeat(5 * 1024 * 1024); // 5 MB > the 4 MB cap
    const res = await post({ path: '.rundock/reviews/big.json', content: huge });
    assert.strictEqual(res.status, 413);
    assert.strictEqual(fs.existsSync(path.join(h.workspaceDir, '.rundock', 'reviews', 'big.json')), false);
  });
});

describe('file tree includes viewable types', () => {
  test('images, PDFs and HTML appear in the tree; code files stay hidden', () => {
    const tree = h.internal.getFileTree(h.workspaceDir);
    const flat = [];
    (function walk(items) {
      for (const it of items) it.type === 'folder' ? walk(it.children) : flat.push(it.path);
    })(tree);
    assert.ok(flat.includes('chart.png'), 'png visible');
    assert.ok(flat.includes('docs/report.pdf'), 'pdf visible');
    assert.ok(flat.includes('photo.JPG'), 'uppercase extension visible');
    assert.ok(flat.includes('notes.md'), 'md still visible');
  });
});
