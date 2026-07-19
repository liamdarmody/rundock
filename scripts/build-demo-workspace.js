#!/usr/bin/env node
// Builds a self-contained demo workspace that exercises every file type the
// Rundock file viewer supports: markdown notes, a kanban board, an HTML
// artifact, an SVG, a PNG, a JPEG, and a PDF, arranged in folders so the tree
// and per-type icons are on display. Re-runnable: it overwrites the target.
//
//   node scripts/build-demo-workspace.js [targetDir]
//
// Default target is a durable path (not /tmp, which is wiped on reboot) so the
// workspace persists once selected in Rundock.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const TARGET = process.argv[2]
  || path.join(require('node:os').homedir(), 'Documents', 'Projects', 'Rundock Demo Workspace');

function write(rel, contents) {
  const full = path.join(TARGET, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
}

// --- A real, decodable PNG (truecolour, per-scanline filter 0) ------------
function buildPng(width, height, pixel) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit depth, truecolour
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3); // filter byte + RGB
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y, width, height);
      row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b;
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// A warm diagonal gradient with a darker band, so the image reads as a real
// picture rather than a flat swatch.
function coverPixel(x, y, w, h) {
  const r = Math.round(40 + (x / w) * 200);
  const g = Math.round(60 + (y / h) * 120);
  const b = Math.round(150 - (x / w) * 90);
  const band = (y > h * 0.62 && y < h * 0.78) ? -40 : 0;
  const clamp = (n) => Math.max(0, Math.min(255, n + band));
  return [clamp(r), clamp(g), clamp(b)];
}

// --- A minimal but readable multi-line PDF -------------------------------
function buildPdf(lines) {
  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; };
  const catalog = add('<< /Type /Catalog /Pages 2 0 R >>');
  add('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'); // obj 2
  add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
    + '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'); // obj 3
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'); // obj 4
  let text = 'BT /F1 18 Tf 72 720 Td 22 TL';
  lines.forEach((ln, i) => {
    const esc = ln.replace(/([\\()])/g, '\\$1');
    text += (i === 0 ? ` (${esc}) Tj` : ` T* (${esc}) Tj`);
    if (i === 0) text += ' /F1 12 Tf'; // drop to body size after the title
  });
  text += ' ET';
  add(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`); // obj 5

  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((off) => { out += `${String(off).padStart(10, '0')} 00000 n \n`; });
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\n`;
  out += `startxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// ------------------------------------------------------------------------
fs.rmSync(TARGET, { recursive: true, force: true });
fs.mkdirSync(TARGET, { recursive: true });

// No agents are scaffolded here: Rundock adds Doc (the platform guide) on
// open, and the demo is a good place to have Doc build a team from scratch.

write('CLAUDE.md', [
  '# Demo Workspace',
  '',
  'A sample workspace for exploring the Rundock file viewer. It contains one of',
  'every file type the viewer can render, arranged in folders.',
  '',
].join('\n'));

write('Welcome.md', [
  '---',
  'title: Welcome',
  'status: active',
  'tags: [demo, getting-started]',
  'related: "[[Product Board]]"',
  'updated: 2026-07-18',
  '---',
  '',
  '# Welcome to the demo workspace',
  '',
  'This note shows how the viewer renders markdown: frontmatter appears in the',
  'properties panel above, with tags as chips and `related` as a live link.',
  '',
  '> [!note] Callout',
  '> Callouts render inline. Open the [[Product Board]] to see the kanban view,',
  '> or browse the `Assets` folder for images and a PDF.',
  '',
  '## What to try',
  '',
  '- Open **Product Board.md** for the kanban columns',
  '- Open **Artifacts/Landing Page.html** for a sandboxed HTML preview',
  '- Open **Assets/Cover.png**, **Photo.jpg**, and **Spec.pdf**',
  '',
  'See also: [[Roadmap]] and [[Notes/Meeting Notes]].',
  '',
].join('\n'));

write('Roadmap.md', [
  '---',
  'title: Roadmap',
  'tags: [planning]',
  '---',
  '',
  '# Roadmap',
  '',
  '1. Ship the file viewer',
  '2. Polish the kanban board',
  '3. Gather feedback',
  '',
].join('\n'));

write('Product Board.md', [
  '---',
  '',
  'kanban-plugin: board',
  '',
  '---',
  '',
  '## Backlog',
  '',
  '- [ ] Draft the **launch note** #content 2026-08-05',
  '- [ ] Review [[Roadmap]] with the team',
  '- [ ] Collect screenshots for the `Assets` folder',
  '',
  '## In Progress',
  '',
  '- [ ] Build the image viewer #design',
  '- [ ] Wire up the [[Welcome]] walkthrough 2026-07-28',
  '',
  '## In Review',
  '',
  '- [ ] PDF rendering pass #bug',
  '',
  '## Done',
  '',
  '- [x] Set up the demo workspace',
  '- [x] Add the kanban board',
  '',
  '%% kanban:settings',
  '```',
  '{"kanban-plugin":"board"}',
  '```',
  '%%',
  '',
].join('\n'));

write('Notes/Meeting Notes.md', [
  '---',
  'title: Meeting Notes',
  'tags: [meeting]',
  'date: 2026-07-15',
  '---',
  '',
  '# Meeting Notes',
  '',
  'Discussed the viewer rollout. Actions captured on the [[Product Board]].',
  '',
  '> [!todo] Follow-up',
  '> Confirm the PDF export path before the demo.',
  '',
].join('\n'));

write('Notes/Ideas.md', [
  '---',
  'title: Ideas',
  'tags: [ideas]',
  '---',
  '',
  '# Ideas',
  '',
  '- A gallery view for the `Assets` folder',
  '- Inline previews on hover',
  '',
].join('\n'));

write('Artifacts/Landing Page.html', [
  '<!doctype html>',
  '<html lang="en"><head><meta charset="utf-8"><title>Landing Page</title>',
  '<style>',
  '  body { margin: 0; font-family: -apple-system, system-ui, sans-serif; color: #1a1a1a; }',
  '  .hero { padding: 64px 48px; background: linear-gradient(135deg, #12355b, #2b6cb0); color: #fff; }',
  '  .hero h1 { font-size: 40px; margin: 0 0 12px; }',
  '  .hero p { font-size: 18px; opacity: 0.9; margin: 0; }',
  '  .body { padding: 40px 48px; max-width: 640px; }',
  '  .stat { display: inline-block; margin-right: 32px; font-weight: 600; }',
  '  .stat span { display: block; font-size: 28px; color: #2b6cb0; }',
  '</style></head>',
  '<body>',
  '  <div class="hero"><h1 id="headline">Ship faster with Rundock</h1>',
  '  <p>A self-contained HTML artifact, rendered in a sandboxed frame.</p></div>',
  '  <div class="body">',
  '    <p class="stat"><span>3x</span> faster reviews</p>',
  '    <p class="stat"><span>100%</span> in your workspace</p>',
  '    <p>This page ships its own styles. Scripts do not run in the preview.</p>',
  '  </div>',
  '</body></html>',
  '',
].join('\n'));

write('Artifacts/Architecture.svg', [
  '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="240" viewBox="0 0 480 240">',
  '  <rect width="480" height="240" fill="#0f172a"/>',
  '  <rect x="40" y="90" width="120" height="60" rx="8" fill="#2b6cb0"/>',
  '  <rect x="180" y="90" width="120" height="60" rx="8" fill="#3b82f6"/>',
  '  <rect x="320" y="90" width="120" height="60" rx="8" fill="#60a5fa"/>',
  '  <line x1="160" y1="120" x2="180" y2="120" stroke="#94a3b8" stroke-width="3"/>',
  '  <line x1="300" y1="120" x2="320" y2="120" stroke="#94a3b8" stroke-width="3"/>',
  '  <text x="100" y="125" fill="#fff" font-family="sans-serif" font-size="15" text-anchor="middle">Client</text>',
  '  <text x="240" y="125" fill="#fff" font-family="sans-serif" font-size="15" text-anchor="middle">Server</text>',
  '  <text x="380" y="125" fill="#fff" font-family="sans-serif" font-size="15" text-anchor="middle">Vault</text>',
  '</svg>',
  '',
].join('\n'));

write('Assets/Cover.png', buildPng(600, 360, coverPixel));
write('Assets/Spec.pdf', buildPdf([
  'Product Specification',
  'This is a sample PDF rendered in the Rundock viewer.',
  'It demonstrates that PDF files open inline alongside',
  'notes, boards, and images.',
  '',
  'Section 1  Overview',
  'Section 2  Requirements',
  'Section 3  Rollout',
]));

// Normalise the board to the parser's canonical form so it is byte-stable
// from the first open (no phantom "modified" state on load).
try {
  const kanban = require(path.join(__dirname, '..', 'public', 'kanban.js'));
  const boardPath = path.join(TARGET, 'Product Board.md');
  const canonical = kanban.serialize(kanban.parse(fs.readFileSync(boardPath, 'utf8')));
  fs.writeFileSync(boardPath, canonical, 'utf8');
} catch (e) {
  console.warn('Could not normalise the board:', e.message);
}

// JPEG: convert the PNG with the macOS image tool (real JPEG bytes).
const pngPath = path.join(TARGET, 'Assets', 'Cover.png');
const jpgPath = path.join(TARGET, 'Assets', 'Photo.jpg');
try {
  execFileSync('sips', ['-s', 'format', 'jpeg', pngPath, '--out', jpgPath], { stdio: 'ignore' });
} catch (e) {
  console.warn('sips unavailable; skipped JPEG generation:', e.message);
}

console.log('Demo workspace built at:', TARGET);
