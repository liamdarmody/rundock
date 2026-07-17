'use strict';
// E2E workspace fixture. Builds a disposable workspace + fake Claude Code
// session transcripts under os.tmpdir(), mirroring the layout the server
// reads in production (workspace dir + $HOME/.claude/projects jsonl). The
// E2E flows never send a chat message, so no model (and no stub binary) is
// required: everything exercised is server + client behaviour over seeded
// state.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function jsonlUser(text, ts) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text }, timestamp: ts }) + '\n';
}
function jsonlAssistant(text, ts) {
  return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, timestamp: ts }) + '\n';
}

// A real, decodable 8x8 solid-colour PNG built with proper CRCs, so the
// image-viewer test can assert naturalWidth > 0 (proving the binary endpoint
// served unmangled bytes that Chromium actually decoded).
function buildPng() {
  const zlib = require('node:zlib');
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(8, 0); // width
  ihdr.writeUInt32BE(8, 4); // height
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit depth, truecolour
  const raw = Buffer.concat(Array.from({ length: 8 }, () =>
    Buffer.concat([Buffer.from([0]), Buffer.alloc(24, 0x4a)]))); // filter 0 + 8px RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function buildFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-e2e-'));
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'home');

  // Agents: an orchestrator (becomes id 'default') and one specialist.
  fs.mkdirSync(path.join(workspace, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.claude', 'agents', 'chief-of-staff.md'),
    '---\nname: chief-of-staff\ndisplayName: Cos\nrole: Chief of Staff\ntype: orchestrator\norder: 0\n---\nYou are Cos.\n');
  fs.writeFileSync(path.join(workspace, '.claude', 'agents', 'penn.md'),
    '---\nname: penn\ndisplayName: Penn\nrole: Content Lead\ntype: specialist\norder: 1\nreportsTo: chief-of-staff\n---\nYou are Penn.\n');
  fs.writeFileSync(path.join(workspace, 'CLAUDE.md'), '# E2E Workspace\n');

  // Files, including frontmatter tags for the files corpus.
  fs.mkdirSync(path.join(workspace, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'notes', 'pricing-strategy.md'),
    '---\ntags: [strategy, pricing]\n---\n# Pricing Strategy\n\nThe enterprise pricing ladder was agreed in June.\n');
  fs.writeFileSync(path.join(workspace, 'Roadmap-2026.md'),
    '# Roadmap 2026\n\nQuarterly targets and the mobile milestone.\n');

  // A briefing-style note: foldable + nested callouts and frontmatter
  // wikilinks (the FV2 phase-3 story's acceptance surface).
  fs.writeFileSync(path.join(workspace, 'briefing.md'), [
    '---',
    'title: "Morning Briefing"',
    'related:',
    '  - "[[Roadmap-2026]]"',
    '  - "[[Missing Note]]"',
    '---',
    '',
    '> [!abstract]+ Today at a glance',
    '> Two meetings, one deadline.',
    '',
    '> [!warning]- Blocked items',
    '> The vendor reply is overdue.',
    '> > [!note]- Context',
    '> > Chased twice this week.',
    '',
    'Plain paragraph after the callouts.',
    '',
  ].join('\n'));

  // FV2 viewer files: a styled HTML artifact whose script/external-image
  // must NOT run (sandbox + CSP proof), a real decodable 1x1 PNG (proves the
  // binary endpoint serves unmangled bytes), and a minimal PDF.
  fs.writeFileSync(path.join(workspace, 'proposal.html'), [
    '<!doctype html><html><head><title>Artifact</title>',
    '<style>body{background:#12355b;color:#fff;font-family:sans-serif;padding:40px}h1{font-size:32px}.stat{color:#8fd3ff;font-size:44px;font-weight:700}</style>',
    '</head><body>',
    '<h1 id="headline">Quarterly Proposal</h1>',
    '<div class="stat">Three workstreams</div>',
    '<script>document.getElementById("headline").textContent="SCRIPT RAN";</script>',
    '</body></html>',
  ].join('\n'));
  fs.writeFileSync(path.join(workspace, 'chart.png'), buildPng());
  fs.writeFileSync(path.join(workspace, 'report.pdf'), Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\nxref\n0 4\ntrailer<</Size 4/Root 1 0 R>>\n%%EOF\n'));

  // Session jsonl (canonical conversation content). s1 is long so the anchor
  // test proves scroll-to-match on a conversation far taller than the
  // viewport, with the matched message at the very top.
  const hash = workspace.replace(/\//g, '-');
  const sessions = path.join(home, '.claude', 'projects', hash);
  fs.mkdirSync(sessions, { recursive: true });
  let s1 = jsonlUser('Can we revisit the enterprise discount structure before the board meeting?', '2026-07-01T10:00:00.000Z')
    + jsonlAssistant('Yes. The discount structure should follow seat bands, not usage tiers.', '2026-07-01T10:00:30.000Z');
  for (let i = 3; i < 40; i++) {
    s1 += jsonlUser(`Routine follow-up number ${i} on the board pack.`, `2026-07-01T10:${String(i).padStart(2, '0')}:00.000Z`);
    s1 += jsonlAssistant(`Handled item ${i}; pack updated accordingly.`, `2026-07-01T10:${String(i).padStart(2, '0')}:30.000Z`);
  }
  fs.writeFileSync(path.join(sessions, 's1.jsonl'), s1);
  fs.writeFileSync(path.join(sessions, 's2.jsonl'),
    jsonlUser('What should the July content calendar prioritise?', '2026-07-02T09:00:00.000Z')
    + jsonlAssistant('Three hooks shortlisted for the agent-team essay.', '2026-07-02T09:00:30.000Z'));

  // Conversation metadata: one pinned + one unpinned, deliberately ordered so
  // pinned-first grouping is observable (the pinned one is LESS recent).
  fs.mkdirSync(path.join(workspace, '.rundock'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.rundock', 'conversations.json'), JSON.stringify([
    { id: 'c2', agentId: 'penn', sessionId: 's2', sessionIds: [], title: 'July content calendar', status: 'active', createdAt: '2026-07-02T08:59:00.000Z', lastActiveAt: '2026-07-10T10:00:00.000Z' },
    { id: 'c1', agentId: 'default', sessionId: 's1', sessionIds: [], title: 'Board prep planning', status: 'active', pinned: true, pinnedAt: '2026-07-05T09:00:00.000Z', createdAt: '2026-07-01T09:59:00.000Z', lastActiveAt: '2026-07-08T10:00:00.000Z' },
  ], null, 2));

  return { root, workspace, home };
}

module.exports = { buildFixture };
