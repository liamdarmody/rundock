// Demo-workspace generator v2 for the marketing screenshot pipeline.
//
// Builds a self-contained, fully sanitized demo workspace plus a fake $HOME of
// Claude Code session transcripts, so the capture harness can boot the real
// server.js against a realistic-but-invented team, skill set, conversation
// history, routines, and file tree. Every date and value is fixed, so runs do
// not shimmer.
//
// It follows two proven patterns already in the repo:
//   - test/e2e/fixture.js  (fake $HOME + agent files + conversation jsonl)
//   - scripts/build-demo-workspace.js  (rich file tree, real PNG/PDF bytes)
// It reads, but does not fork, public/kanban.js to canonicalise boards.
//
// Sanitization is a hard gate: the roster keeps only the generic role-names
// Cos, Dev and Des; everything else is invented and free of real people,
// clients, or business specifics. checkSanitization() greps the built tree for
// banned tokens and throws before any capture runs.
//
// UK spelling in comments and prose; US spelling only where a code identifier
// or an on-disk field name (colour is British by the app's own convention) is
// fixed by the platform.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Locked roster (from the spec's "Demo workspace roster and skills"). Names,
// roles, order and reportsTo are verbatim; colour and icon are fixed here for
// deterministic, pleasant avatars rather than relying on the server's rotating
// defaults (which depend on directory read order). Ana and Cody carry hues that
// are deliberately distinct from their leads (Cleo, Dev), so the two most
// closely related pairs never read as the same colour on the org chart.
// ---------------------------------------------------------------------------
export const ROSTER = [
  { id: 'cos',   displayName: 'Cos',   role: 'Chief of Staff',      type: 'orchestrator', order: 0, reportsTo: null,   colour: '#E87A5A', icon: '◆',
    description: 'Cos routes work to the right specialist, runs the daily brief, and keeps priorities visible across the team.' },
  { id: 'cleo',  displayName: 'Cleo',  role: 'Content Lead',        type: 'specialist',   order: 1, reportsTo: 'cos',  colour: '#6B9EF0', icon: '✎',
    description: 'Cleo owns the content pipeline from idea to publish-ready draft.' },
  { id: 'dev',   displayName: 'Dev',   role: 'Engineering Lead',    type: 'specialist',   order: 2, reportsTo: 'cos',  colour: '#6BC67E', icon: '◎',
    description: 'Dev owns delivery: specs, implementation, and shipping working software in small, reviewed slices.' },
  { id: 'des',   displayName: 'Des',   role: 'Design Lead',         type: 'specialist',   order: 3, reportsTo: 'cos',  colour: '#E8A84C', icon: '◇',
    description: 'Des owns visual execution across the product surface, from layouts to finished assets.' },
  { id: 'reese', displayName: 'Reese', role: 'Research Lead',       type: 'specialist',   order: 4, reportsTo: 'cos',  colour: '#A07AE8', icon: '✦',
    description: 'Reese tracks the market and the competitive landscape and turns signal into briefs.' },
  { id: 'glen',  displayName: 'Glen',  role: 'Growth Lead',         type: 'specialist',   order: 5, reportsTo: 'cos',  colour: '#E87AAC', icon: '⬡',
    description: 'Glen owns acquisition experiments and the growth funnel end to end.' },
  { id: 'rea',   displayName: 'Rea',   role: 'Executive Assistant', type: 'specialist',   order: 6, reportsTo: 'cos',  colour: '#5BCFC4', icon: '△',
    description: 'Rea keeps the calendar, meeting notes, and daily communications in order.' },
  { id: 'ana',   displayName: 'Ana',   role: 'Content Analyst',     type: 'specialist',   order: 7, reportsTo: 'cleo', colour: '#6C74C4', icon: '▦',
    description: 'Ana measures what content works and pre-checks ideas against past performance.' },
  { id: 'cody',  displayName: 'Cody',  role: 'Code Reviewer',       type: 'specialist',   order: 8, reportsTo: 'dev',  colour: '#B07E4E', icon: '⬢',
    description: 'Cody reviews changes for correctness, clarity, and safety before they merge.' },
];

// ---------------------------------------------------------------------------
// Skills (~14, generic). Each becomes a .claude/skills/<slug>/SKILL.md with
// name + description frontmatter and a short generic body. Assignment to agents
// is via AGENT_SKILLS below (an agent's frontmatter skills list), so a skill can
// belong to more than one agent, exactly as real skills are shared across a
// team.
// ---------------------------------------------------------------------------
export const SKILLS = [
  { slug: 'post-drafter',    name: 'Post Drafter',      description: 'Turns an approved angle into a publish-ready first draft.' },
  { slug: 'hook-generator',  name: 'Hook Generator',    description: 'Generates and ranks opening lines for a piece of content.' },
  { slug: 'content-planner', name: 'Content Planner',   description: 'Plans a week of content against goals and gaps.' },
  { slug: 'post-auditor',    name: 'Post Auditor',      description: 'Scores a draft for clarity and strength before it ships.' },
  { slug: 'spec-writer',     name: 'Spec Writer',       description: 'Writes a short spec before any non-trivial change.' },
  { slug: 'code-reviewer',   name: 'Code Reviewer',     description: 'Reviews a change across correctness, clarity, and safety.' },
  { slug: 'test-generator',  name: 'Test Generator',    description: 'Proposes tests that pin the behaviour a change relies on.' },
  { slug: 'design-brief',    name: 'Design Brief',      description: 'Translates a request into an execution-ready design brief.' },
  { slug: 'slide-builder',   name: 'Slide Builder',     description: 'Builds a clean slide deck from an outline.' },
  { slug: 'weekly-digest',   name: 'Weekly Digest',     description: 'Summarises the week in the market into a short brief.' },
  { slug: 'competitor-scan', name: 'Competitor Scan',   description: 'Tracks what comparable products are shipping and saying.' },
  { slug: 'meeting-notes',   name: 'Meeting Notes',     description: 'Captures decisions and actions from a meeting.' },
  { slug: 'message-drafter', name: 'Message Drafter',   description: 'Drafts a reply in the right tone for the channel.' },
  { slug: 'workspace-lint',  name: 'Workspace Lint',    description: 'Checks the workspace for stale links and missing metadata.' },
];

// Which skills each agent carries. Every lead owns two or three; a report never
// carries more than its lead (Dev owns three, Cody two). Sharing is realistic:
// content-planner sits with both Cleo and Ana, competitor-scan with Reese and
// Glen, the engineering skills with both Dev and Cody.
const AGENT_SKILLS = {
  cos:   ['workspace-lint'],
  cleo:  ['post-drafter', 'hook-generator', 'content-planner'],
  dev:   ['spec-writer', 'code-reviewer', 'test-generator'],
  des:   ['design-brief', 'slide-builder'],
  reese: ['weekly-digest', 'competitor-scan'],
  glen:  ['hook-generator', 'competitor-scan'],
  rea:   ['meeting-notes', 'message-drafter'],
  ana:   ['post-auditor', 'content-planner'],
  cody:  ['code-reviewer', 'test-generator'],
};

// Routines seeded onto a few agents (parsed from agent frontmatter by the
// server). Schedules use the "every <weekday> at HH:MM" grammar the scheduler
// recognises, so the routines panel reads as real scheduled work.
const ROUTINES = {
  cos:   [{ name: 'Daily brief',    schedule: 'every day at 08:00',    prompt: 'Summarise what needs attention today and flag anything overdue.' }],
  reese: [{ name: 'Weekly digest',  schedule: 'every monday at 09:00', prompt: 'Run the weekly market scan and save a short brief.' }],
  ana:   [{ name: 'Publish check',  schedule: 'every friday at 16:00', prompt: 'Reconcile what published this week against the plan.' }],
};

// Fixed run history for the routines panel (a populated .rundock/routine-state.json).
const ROUTINE_STATE = {
  'default:Daily brief': { lastRun: '2026-07-18T08:00:12.000Z', status: 'completed', duration: 42 },
  'reese:Weekly digest': { lastRun: '2026-07-13T09:00:20.000Z', status: 'completed', duration: 118 },
  'ana:Publish check':   { lastRun: '2026-07-17T16:00:08.000Z', status: 'completed', duration: 27 },
};

// Tokens that must never appear in the built workspace. The gate greps for
// these (whole-word, case-insensitive) and throws if any are found. The
// generic role-names Cos, Dev, Des are deliberately allowed.
//
// The committed default lists only already-public owner identifiers and
// generic vault-structure markers, so this public repo never hardcodes private
// agent names or a personal tool stack. Project-specific tokens (private team
// names, connected tools) are supplied out of band via the
// RUNDOCK_BANNED_TOKENS env (comma-separated) or a gitignored
// scripts/screenshots/.banned-tokens.json, and are merged in at run time.
export const DEFAULT_BANNED_TOKENS = [
  'liamdarmody', 'darmody', 'obsidian vault', 'agent-workspace',
];

export function loadBannedTokens() {
  const tokens = [...DEFAULT_BANNED_TOKENS];
  if (process.env.RUNDOCK_BANNED_TOKENS) {
    tokens.push(...process.env.RUNDOCK_BANNED_TOKENS.split(',').map((s) => s.trim()).filter(Boolean));
  }
  const localFile = path.join(__dirname, '.banned-tokens.json');
  try {
    if (fs.existsSync(localFile)) {
      const extra = JSON.parse(fs.readFileSync(localFile, 'utf8'));
      if (Array.isArray(extra)) tokens.push(...extra.filter((t) => typeof t === 'string'));
    }
  } catch { /* ignore a malformed local override */ }
  return tokens;
}

// ===========================================================================
// Binary builders (real, decodable bytes) ported from build-demo-workspace.js
// ===========================================================================
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
    const row = Buffer.alloc(1 + width * 3);
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

function coverPixel(x, y, w, h) {
  const r = Math.round(40 + (x / w) * 200);
  const g = Math.round(60 + (y / h) * 120);
  const b = Math.round(150 - (x / w) * 90);
  const band = (y > h * 0.62 && y < h * 0.78) ? -40 : 0;
  const clamp = (n) => Math.max(0, Math.min(255, n + band));
  return [clamp(r), clamp(g), clamp(b)];
}

function buildPdf(lines) {
  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; };
  const catalog = add('<< /Type /Catalog /Pages 2 0 R >>');
  add('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
    + '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let text = 'BT /F1 18 Tf 72 720 Td 22 TL';
  lines.forEach((ln, i) => {
    const esc = ln.replace(/([\\()])/g, '\\$1');
    text += (i === 0 ? ` (${esc}) Tj` : ` T* (${esc}) Tj`);
    if (i === 0) text += ' /F1 12 Tf';
  });
  text += ' ET';
  add(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);

  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xrefStart = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((off) => { out += `${String(off).padStart(10, '0')} 00000 n \n`; });
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\n`;
  out += `startxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// FNV-1a sidecar filename, ported byte-for-byte from
// public/viewers/sidecar-controller.js so a hand-authored review sidecar lands
// at the exact path the client loads on open.
function sidecarNameFor(p) {
  let h = 0x811c9dc5;
  for (let i = 0; i < p.length; i++) {
    h ^= p.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const slug = p.replace(/[\\/]/g, '__').replace(/[^\w.-]/g, '_').slice(0, 60);
  return `${slug}-${h.toString(16).padStart(8, '0')}.json`;
}

// ===========================================================================
// jsonl helpers (fixed timestamps)
// ===========================================================================
function jsonlUser(text, ts) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text }, timestamp: ts }) + '\n';
}
function jsonlAssistant(text, ts) {
  return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, timestamp: ts }) + '\n';
}

function agentFile(a) {
  const lines = ['---', `name: ${a.id}`, `displayName: ${a.displayName}`, `role: ${a.role}`,
    `type: ${a.type}`, `order: ${a.order}`];
  if (a.reportsTo) lines.push(`reportsTo: ${a.reportsTo}`);
  lines.push(`colour: ${a.colour}`, `icon: ${a.icon}`, `description: ${a.description}`);
  const mySkills = AGENT_SKILLS[a.id] || [];
  if (mySkills.length) { lines.push('skills:'); mySkills.forEach((slug) => lines.push(`  - ${slug}`)); }
  const myRoutines = ROUTINES[a.id];
  if (myRoutines) {
    lines.push('routines:');
    myRoutines.forEach((r) => lines.push(`  - name: ${r.name}`, `    schedule: ${r.schedule}`, `    prompt: ${r.prompt}`));
  }
  lines.push('---', '', `You are ${a.displayName}, the ${a.role}. ${a.description}`, '');
  return lines.join('\n');
}

function skillFile(s) {
  return ['---', `name: ${s.name}`, `description: ${s.description}`, '---', '',
    `# ${s.name}`, '', s.description, '',
    '## When to use', '', `Use ${s.name} when the task matches its purpose above.`, '',
    '## Steps', '', '1. Confirm the goal and constraints.', '2. Do the work in one focused pass.',
    '3. Hand back a clear, checkable result.', ''].join('\n');
}

// ===========================================================================
// Main builder
// ===========================================================================
export function buildWorkspace(opts = {}) {
  const root = opts.root || path.join(os.tmpdir(), 'rundock-marketing');
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'home');

  // Fully re-runnable: wipe and rebuild so every run is byte-identical.
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(home, { recursive: true });

  const write = (rel, contents) => {
    const full = path.join(workspace, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  };

  // --- Agents ---------------------------------------------------------------
  for (const a of ROSTER) write(path.join('.claude', 'agents', `${a.id}.md`), agentFile(a));

  // --- Skills ---------------------------------------------------------------
  for (const s of SKILLS) write(path.join('.claude', 'skills', s.slug, 'SKILL.md'), skillFile(s));

  // --- CLAUDE.md (workspace charter, generic) -------------------------------
  write('CLAUDE.md', [
    '# Fernwick Studio', '',
    'A small studio running its whole operation through an AI team. Cos routes',
    'the work; the leads own content, engineering, design, research, growth, and',
    'operations. This workspace holds the notes, boards, and files the team works',
    'from.', '',
  ].join('\n'));

  // --- Notes (frontmatter, callouts, wikilinks) -----------------------------
  write('Welcome.md', [
    '---', 'title: Welcome', 'status: active', 'tags: [demo, getting-started]',
    'related: "[[Backlog]]"', 'updated: 2026-07-18', '---', '',
    '# Welcome to the studio workspace', '',
    'This note shows how a file renders: frontmatter appears in the properties',
    'panel above, with tags as chips and `related` as a live link.', '',
    '> [!note] Callout', '> Callouts render inline. Open the [[Backlog]] board to see the columns,',
    '> or browse the `Assets` folder for images and a document.', '',
    '## What to try', '',
    '- Open **Backlog.md** and **Roadmap.md** for the boards', '- Open **Artifacts/Launch Page.html** for a sandboxed preview',
    '- Open **Assets/Cover.png**, **Photo.jpg**, and **Spec.pdf**', '',
    'See also: [[Roadmap]] and [[Notes/Weekly Plan]].', '',
  ].join('\n'));

  // Roadmap is a second Kanban board (Now / Next / Later). It lives in the tree
  // for realism; the Backlog board is the one opened in captures.
  write('Roadmap.md', [
    '---', '', 'kanban-plugin: board', '', '---', '',
    '## Now', '',
    '- [ ] Ship the launch page #launch 2026-08-05', '- [ ] Tidy the onboarding flow #product', '',
    '## Next', '',
    '- [ ] Gather early feedback', '- [ ] Plan the follow-up release', '',
    '## Later', '',
    '- [ ] Explore a mobile companion', '',
    '%% kanban:settings', '```', '{"kanban-plugin":"board"}', '```', '%%', '',
  ].join('\n'));

  // A briefing-style note with foldable and nested callouts plus frontmatter
  // wikilinks (one live, one deliberately dead so the dead-link state shows).
  write('Briefing.md', [
    '---', 'title: "Morning Briefing"', 'related:', '  - "[[Roadmap]]"', '  - "[[Missing Note]]"', '---', '',
    '> [!abstract]+ Today at a glance', '> Two reviews, one launch date to hold.', '',
    '> [!warning]- Watch items', '> The launch page copy is still in review.',
    '> > [!note]- Context', '> > Cleo has a draft; Ana is auditing it now.', '',
    'Plain paragraph after the callouts.', '',
  ].join('\n'));

  write('Notes/Weekly Plan.md', [
    '---', 'title: Weekly Plan', 'tags: [planning]', 'date: 2026-07-18', '---', '',
    '# Weekly Plan', '', 'Focus for the week is the launch page. Actions live on the [[Backlog]].', '',
    '> [!todo] Follow-up', '> Confirm the launch date before Friday.', '',
  ].join('\n'));

  // --- Kanban board (varied columns and cards, wikilink + tag + date). This is
  // the board opened in the kanban still and the drag clip. -------------------
  // Three columns so all lanes fit the frame without clipping, each with a few
  // cards so the board reads as a full, busy surface.
  write('Backlog.md', [
    '---', '', 'kanban-plugin: board', '', '---', '',
    '## Backlog', '',
    '- [ ] Draft the **launch note** #content 2026-08-05',
    '- [ ] Review [[Roadmap]] with the team',
    '- [ ] Collect assets for the `Assets` folder',
    '- [ ] Draft the onboarding copy #content', '',
    '## In Progress', '',
    '- [ ] Build the launch page #design',
    '- [ ] Wire up the [[Welcome]] walkthrough 2026-07-28',
    '- [ ] Tighten the hero headline #content', '',
    '## Done', '',
    '- [x] Set up the workspace',
    '- [x] Add the board',
    '- [x] Agree the launch date', '',
    '%% kanban:settings', '```', '{"kanban-plugin":"board"}', '```', '%%', '',
  ].join('\n'));

  // --- HTML artifact (unique phrases used as review anchors) ----------------
  const launchHtml = [
    '<!doctype html>', '<html lang="en"><head><meta charset="utf-8"><title>Launch Page</title>',
    '<style>',
    '  body { margin: 0; font-family: -apple-system, system-ui, sans-serif; color: #1a1a1a; }',
    '  .hero { padding: 64px 48px; background: linear-gradient(135deg, #22314f, #3b6ea5); color: #fff; }',
    '  .hero h1 { font-size: 40px; margin: 0 0 12px; }',
    '  .hero p { font-size: 18px; opacity: 0.9; margin: 0; }',
    '  .body { padding: 40px 48px; max-width: 640px; }',
    '  .body .lead { font-size: 20px; font-weight: 600; margin: 0 0 16px; color: #22314f; }',
    '  .body p { font-size: 16px; line-height: 1.5; margin: 0 0 12px; }',
    '</style></head>', '<body>',
    '  <div class="hero"><h1 id="headline">Run your studio from one place</h1>',
    '  <p>Your team, your files, and your work in one place you own.</p></div>',
    '  <div class="body">',
    '    <p class="lead">Every draft, board, and review sits beside the agent that made it.</p>',
    '    <p>Open a note, a board, an image, or a page like this one in the same window, in a workspace that stays on your machine.</p>',
    '    <p>Review what an agent produces where it lives: select a line, leave a comment, and it acts on your feedback in place.</p>',
    '    <p>This page ships its own styles, and scripts never run in the preview.</p>',
    '  </div>', '</body></html>', '',
  ].join('\n');
  write('Artifacts/Launch Page.html', launchHtml);

  // --- SVG artifact ---------------------------------------------------------
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
    '  <text x="380" y="125" fill="#fff" font-family="sans-serif" font-size="15" text-anchor="middle">Files</text>',
    '</svg>', '',
  ].join('\n'));

  // --- Images + PDF ---------------------------------------------------------
  write('Assets/Cover.png', buildPng(600, 360, coverPixel));
  write('Assets/Spec.pdf', buildPdf([
    'Product Specification', 'A sample document rendered in the file viewer.',
    'It opens inline alongside notes, boards, and images.', '',
    'Section 1  Overview', 'Section 2  Requirements', 'Section 3  Rollout',
  ]));

  // JPEG from the PNG via the macOS image tool (real JPEG bytes).
  try {
    execFileSync('sips', ['-s', 'format', 'jpeg',
      path.join(workspace, 'Assets', 'Cover.png'), '--out', path.join(workspace, 'Assets', 'Photo.jpg')],
      { stdio: 'ignore' });
  } catch (e) { console.warn('  sips unavailable; skipped JPEG generation:', e.message); }

  // Canonicalise both boards so they are byte-stable from first open (no phantom
  // "modified" state), exactly as build-demo-workspace.js does.
  try {
    const kanban = require(path.join(REPO_ROOT, 'public', 'kanban.js'));
    for (const board of ['Backlog.md', 'Roadmap.md']) {
      const boardPath = path.join(workspace, board);
      fs.writeFileSync(boardPath, kanban.serialize(kanban.parse(fs.readFileSync(boardPath, 'utf8'))), 'utf8');
    }
  } catch (e) { console.warn('  Could not normalise the boards:', e.message); }

  // --- Review sidecar: anchored comments on the HTML artifact ---------------
  // Quotes are exact substrings of the artifact's RENDERED text (not markup),
  // so the anchoring engine locates them and draws the review marks on open.
  const artifactRel = 'Artifacts/Launch Page.html';
  const sidecar = {
    format: 'rundock-review-sidecar/1',
    path: artifactRel,
    comments: {
      c1: { by: 'Cos', at: '2026-07-18T10:04:00.000Z',
        quote: 'Run your studio from one place',
        prefix: '', suffix: 'A self-contained',
        body: 'Strong headline. Can we test a shorter variant next to it?' },
      c2: { by: 'Des', at: '2026-07-18T10:12:00.000Z', re: 'c1',
        body: 'On it. I will mock a two-line and a one-line version.' },
      c3: { by: 'Ana', at: '2026-07-18T10:20:00.000Z',
        quote: 'one place you own',
        prefix: 'in ', suffix: '.',
        body: 'The "you own" line is our strongest angle. Worth pulling into the headline?' },
    },
    suggestions: {},
    review: {},
  };
  write(path.join('.rundock', 'reviews', sidecarNameFor(artifactRel)),
    JSON.stringify(sidecar, null, 2));

  // --- Routine run state ----------------------------------------------------
  write(path.join('.rundock', 'routine-state.json'), JSON.stringify(ROUTINE_STATE, null, 2));

  // --- Conversations: metadata + fake $HOME transcripts ---------------------
  // The projects subfolder name is the absolute workspace path with every
  // slash replaced by a dash (server.js derivation).
  const projectHash = workspace.replace(/\//g, '-');
  const sessions = path.join(home, '.claude', 'projects', projectHash);
  fs.mkdirSync(sessions, { recursive: true });

  // s1: a real planning thread, pinned, on the leader. Varied, substantive
  // turns (priority, status, deadline, tradeoff, delegation, scheduling) that
  // fill the pane through content rather than a repeated line.
  const s1 = [
    jsonlUser('What should we focus on this week?', '2026-07-18T09:00:00.000Z'),
    jsonlAssistant('The launch page is the one thing that moves the needle. I would hold everything else behind it until it ships.', '2026-07-18T09:00:40.000Z'),
    jsonlUser('Agreed. What is the state of it right now?', '2026-07-18T09:02:00.000Z'),
    jsonlAssistant('Cleo has a draft of the copy and Ana is auditing it. Des is on the layout. The one open risk is the headline: we are testing a shorter variant against the current one.', '2026-07-18T09:02:45.000Z'),
    jsonlUser('Can we still hit Friday?', '2026-07-18T09:05:00.000Z'),
    jsonlAssistant('Yes, if we lock the headline by Wednesday. If the shorter variant tests better we take it; if it is a wash we keep the current one and stop debating it.', '2026-07-18T09:05:50.000Z'),
    jsonlUser('Good. Does the onboarding flow slip if we do that?', '2026-07-18T09:08:00.000Z'),
    jsonlAssistant('It slips a week, and that is the right call. Splitting Dev across both would put the launch date at risk for a flow no one sees until after they sign up.', '2026-07-18T09:08:40.000Z'),
    jsonlUser('Fine by me. Anything you need from me this week?', '2026-07-18T09:11:00.000Z'),
    jsonlAssistant('Just the headline decision on Wednesday. I will put both variants and Ana\'s read in front of you by Tuesday night.', '2026-07-18T09:11:35.000Z'),
    jsonlUser('One more thing: are we happy with the tone of the copy?', '2026-07-18T09:14:00.000Z'),
    jsonlAssistant('It reads calm and direct, which is right for us. Ana flagged one line as slightly salesy and Cleo has already softened it.', '2026-07-18T09:14:40.000Z'),
    jsonlUser('Great. Book the review for Wednesday morning.', '2026-07-18T09:16:00.000Z'),
    jsonlAssistant('Booked for 9am Wednesday with Cleo, Des and Ana. I have added the follow-up release to the roadmap under Next so it does not get lost.', '2026-07-18T09:16:40.000Z'),
  ].join('');
  fs.writeFileSync(path.join(sessions, 's1.jsonl'), s1);

  // s2: content thread (Cleo).
  fs.writeFileSync(path.join(sessions, 's2.jsonl'),
    jsonlUser('Draft the launch note for the studio page.', '2026-07-17T14:00:00.000Z')
    + jsonlAssistant('Here is a first pass. The hook leads with the one-place idea, then two proof points.', '2026-07-17T14:00:40.000Z')
    + jsonlUser('Tighten the opening line.', '2026-07-17T14:05:00.000Z')
    + jsonlAssistant('Tightened. It now opens on the reader, not the product.', '2026-07-17T14:05:30.000Z'));

  // s3: engineering thread (Dev), references binary outputs by wikilink.
  fs.writeFileSync(path.join(sessions, 's3.jsonl'),
    jsonlUser('Where did the export land?', '2026-07-16T11:00:00.000Z')
    + jsonlAssistant('Saved the render to [[Cover.png]] and the summary to [[Spec.pdf]].', '2026-07-16T11:00:30.000Z'));

  // s4: research thread (Reese).
  fs.writeFileSync(path.join(sessions, 's4.jsonl'),
    jsonlUser('What changed in the market this week?', '2026-07-13T09:05:00.000Z')
    + jsonlAssistant('Three things worth noting. I have saved the short version to the weekly digest.', '2026-07-13T09:05:45.000Z'));

  // s5: the streaming-look thread (Cleo). Prior turns here; the harness injects
  // a live streaming reply on top at capture time.
  fs.writeFileSync(path.join(sessions, 's5.jsonl'),
    jsonlUser('Rework the landing hook to be shorter.', '2026-07-18T11:00:00.000Z')
    + jsonlAssistant('Good idea. A shorter hook reads faster above the fold.', '2026-07-18T11:00:30.000Z'));

  // Conversation metadata. One pinned + others, ordered so pinned-first
  // grouping is visible. A couple carry a listId so the Lists pills populate.
  fs.mkdirSync(path.join(workspace, '.rundock'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.rundock', 'conversations.json'), JSON.stringify([
    { id: 'c1', agentId: 'default', sessionId: 's1', sessionIds: [], title: 'Plan the week', status: 'active', pinned: true, pinnedAt: '2026-07-18T09:05:00.000Z', listIds: ['launch'], createdAt: '2026-07-18T08:59:00.000Z', lastActiveAt: '2026-07-18T09:30:00.000Z' },
    { id: 'c5', agentId: 'cleo', sessionId: 's5', sessionIds: [], title: 'Rework the landing hook', status: 'active', listIds: ['launch'], createdAt: '2026-07-18T10:59:00.000Z', lastActiveAt: '2026-07-18T11:01:00.000Z' },
    { id: 'c2', agentId: 'cleo', sessionId: 's2', sessionIds: [], title: 'Draft the launch note', status: 'active', listIds: ['launch'], createdAt: '2026-07-17T13:59:00.000Z', lastActiveAt: '2026-07-17T14:06:00.000Z' },
    { id: 'c3', agentId: 'dev', sessionId: 's3', sessionIds: [], title: 'Export handoff', status: 'active', createdAt: '2026-07-16T10:59:00.000Z', lastActiveAt: '2026-07-16T11:01:00.000Z' },
    { id: 'c4', agentId: 'reese', sessionId: 's4', sessionIds: [], title: 'Weekly market scan', status: 'active', createdAt: '2026-07-13T09:04:00.000Z', lastActiveAt: '2026-07-13T09:06:00.000Z' },
  ], null, 2));

  // Named lists so the Lists pills render beside All and Unread.
  fs.writeFileSync(path.join(workspace, '.rundock', 'lists.json'), JSON.stringify([
    { id: 'launch', name: 'Launch', createdAt: '2026-07-17T09:00:00.000Z' },
  ], null, 2));

  return { root, workspace, home, projectHash };
}

// ===========================================================================
// Sanitization gate
// ===========================================================================
export function checkSanitization(workspace) {
  const hits = [];
  // Whole-token matching (word boundaries), so a short three-letter token
  // cannot false-positive inside ordinary words such as "leads" or "release".
  // Multi-word tokens (e.g. "acme corp") match with a flexible internal space.
  const patterns = loadBannedTokens().map((token) => {
    const body = token.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return { token, re: new RegExp(`(?<![\\w-])${body}(?![\\w-])`, 'i') };
  });
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      // Only scan text; skip real binaries (png/jpg/pdf) which carry no prose.
      if (/\.(png|jpe?g|gif|webp|pdf)$/i.test(entry.name)) continue;
      let text;
      try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
      for (const { token, re } of patterns) {
        if (re.test(text)) hits.push({ file: path.relative(workspace, full), token });
      }
    }
  };
  walk(workspace);
  return { ok: hits.length === 0, hits };
}

// Allow standalone use: `node generate-workspace.mjs [root]` builds the tree
// and runs the gate, printing where it landed.
if (import.meta.url === `file://${process.argv[1]}`) {
  const built = buildWorkspace({ root: process.argv[2] });
  const gate = checkSanitization(built.workspace);
  console.log('Workspace built at:', built.workspace);
  console.log('Home built at:', built.home);
  if (!gate.ok) {
    console.error('SANITIZATION FAILED:');
    for (const h of gate.hits) console.error(`  ${h.file}: "${h.token}"`);
    process.exit(1);
  }
  console.log('Sanitization gate: PASS');
}
