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
  // Penn's body carries the exact characters the profile-clipping bug feared
  // (square brackets, HTML, a wikilink, a code fence) so the regression test can
  // prove the instructions render in full past every one of them.
  fs.writeFileSync(path.join(workspace, '.claude', 'agents', 'penn.md'),
    '---\nname: penn\ndisplayName: Penn\nrole: Content Lead\ntype: specialist\norder: 1\nreportsTo: chief-of-staff\n---\n'
    + 'You are Penn.\n\nCore Ideas [Key]: SENTINEL_AFTER_BRACKET comes right after the bracket. Also <tag>, [[Roadmap-2026]], and a code fence below.\n\n```\nconst x = 1;\n```\n\nFINAL_SENTINEL_END.\n');
  fs.writeFileSync(path.join(workspace, 'CLAUDE.md'), '# E2E Workspace\n');

  // Files, including frontmatter tags for the files corpus.
  fs.mkdirSync(path.join(workspace, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'notes', 'pricing-strategy.md'),
    '---\ntags: [strategy, pricing]\n---\n# Pricing Strategy\n\nThe enterprise pricing ladder was agreed in June.\n');
  fs.writeFileSync(path.join(workspace, 'Roadmap-2026.md'),
    '# Roadmap 2026\n\nQuarterly targets and the mobile milestone.\n');

  // A tall note that overflows the editor viewport, so the floating toolbar's
  // dropdown can be exercised near the foot of the visible area (where the menu
  // must flip to open upward rather than spilling past the bottom).
  fs.writeFileSync(path.join(workspace, 'long-note.md'),
    '# Long Note\n\n' + Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1} of the long note body.`).join('\n\n') + '\n\nFinal line at the very bottom of the file.\n');

  // A note whose body paragraph carries two inline wikilinks. Pressing Enter
  // at the end of this line must split the block cleanly and keep every
  // wikilink and its surrounding text (a contenteditable + inline-atom
  // corruption that only reproduces in a real browser, never in jsdom).
  fs.writeFileSync(path.join(workspace, 'wikilink-line.md'),
    '# Links\n\nSee also: [[Roadmap-2026]] and [[Missing Note]].\n');

  // A briefing-style note: foldable + nested callouts and frontmatter
  // wikilinks.
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

  // Viewer files: a styled HTML artifact whose script/external-image
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
  // In-view find fixture: 'needle' appears three times in the rendered body
  // (for next/prev navigation) and never in markup, so an artifact-frame or
  // source-edit find must report exactly 3.
  fs.writeFileSync(path.join(workspace, 'findable.html'), [
    '<!doctype html><html><head><title>Findable</title>',
    '<style>body{padding:40px;font-family:sans-serif}</style></head><body>',
    '<h1>Alpha heading</h1>',
    '<p>The needle appears here, and the needle appears again.</p>',
    '<div style="height:1200px"></div>',
    '<p>A third needle sits far below for the scroll.</p>',
    '</body></html>',
  ].join('\n'));
  // An SVG artifact with a text label: commenting on SVG text must keep it
  // visible (it is wrapped in a <tspan>, not a <mark> that SVG cannot render).
  fs.writeFileSync(path.join(workspace, 'diagram.svg'), [
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120" viewBox="0 0 320 120">',
    '  <rect width="320" height="120" fill="#0f172a"/>',
    '  <text id="label" x="20" y="64" fill="#ffffff" font-size="18">Architecture diagram label</text>',
    '</svg>',
  ].join('\n'));
  // A canonical Kanban board (frontmatter carries the kanban-plugin key), used
  // to prove the board registry view renders columns and round-trips bytes.
  fs.writeFileSync(path.join(workspace, 'board.md'),
    "---\n\nkanban-plugin: board\n\n---\n\n## To do\n\n- [ ] Draft the outline\n- [ ] **Review** the brief\n\n\n## Doing\n\n- [ ] Wire the [[Board]] view\n\n\n## Done\n\n- [ ] Ship it\n\n\n\n\n%% kanban:settings\n```\n{\"kanban-plugin\":\"board\",\"list-collapse\":[false,false,false]}\n```\n%%");
  // A frontmatter-only board (zero columns): opens as a board, and must offer
  // the "Add your first list" affordance so an empty board is never a dead end.
  fs.writeFileSync(path.join(workspace, 'empty-board.md'),
    "---\n\nkanban-plugin: board\n\n---\n\n");
  // A board with block-style frontmatter (a multi-line tag list): a save must
  // preserve it verbatim rather than flattening it away.
  fs.writeFileSync(path.join(workspace, 'tagged-board.md'),
    "---\n\nkanban-plugin: board\ntitle: Tagged board\ntags:\n  - project\n  - kanban\n\n---\n\n## To do\n\n- [ ] first card\n- [ ] second card\n\n\n## Done\n\n- [ ] shipped\n\n\n\n\n%% kanban:settings\n```\n{\"kanban-plugin\":\"board\",\"list-collapse\":[false,false]}\n```\n%%");
  // A dedicated board for the column-reorder test (isolated so other board
  // tests cannot shift its lane order).
  fs.writeFileSync(path.join(workspace, 'reorder-board.md'),
    "---\n\nkanban-plugin: board\n\n---\n\n## Alpha\n\n- [ ] a1\n\n\n## Beta\n\n- [ ] b1\n\n\n## Gamma\n\n- [ ] g1\n\n\n\n\n%% kanban:settings\n```\n{\"kanban-plugin\":\"board\",\"list-collapse\":[false,false,false]}\n```\n%%");
  // A board with a card carrying a wikilink, a date, and a tag (for the card
  // rendering + wikilink-navigation tests).
  fs.writeFileSync(path.join(workspace, 'rich-board.md'),
    "---\n\nkanban-plugin: board\n\n---\n\n## Todo\n\n- [ ] Review [[Roadmap-2026]] by 2026-08-01 #launch\n\n\n\n\n%% kanban:settings\n```\n{\"kanban-plugin\":\"board\",\"list-collapse\":[false]}\n```\n%%");
  // A dedicated board for the live-refresh conflict test (isolated so its own
  // save/watcher echo cannot race another board test sharing the file).
  fs.writeFileSync(path.join(workspace, 'watch-board.md'),
    "---\n\nkanban-plugin: board\n\n---\n\n## To do\n\n- [ ] Watch me\n\n\n## Done\n\n- [ ] Already done\n\n\n\n\n%% kanban:settings\n```\n{\"kanban-plugin\":\"board\",\"list-collapse\":[false,false]}\n```\n%%");
  // A single-lane board for the in-column drag-reorder test.
  fs.writeFileSync(path.join(workspace, 'dnd-board.md'),
    "---\n\nkanban-plugin: board\n\n---\n\n## Queue\n\n- [ ] Card A\n- [ ] Card B\n- [ ] Card C\n\n\n\n\n%% kanban:settings\n```\n{\"kanban-plugin\":\"board\",\"list-collapse\":[false]}\n```\n%%");
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
  // s3: an agent referencing binary outputs by wikilink (those links
  // must open the real viewers, not dead-end on a phantom .md).
  fs.writeFileSync(path.join(sessions, 's3.jsonl'),
    jsonlUser('Where did the export land?', '2026-06-20T09:00:00.000Z')
    + jsonlAssistant('Saved the render to [[chart.png]] and the summary to [[report.pdf]].', '2026-06-20T09:00:30.000Z'));

  // Conversation metadata: one pinned + one unpinned, deliberately ordered so
  // pinned-first grouping is observable (the pinned one is LESS recent).
  fs.mkdirSync(path.join(workspace, '.rundock'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.rundock', 'conversations.json'), JSON.stringify([
    { id: 'c3', agentId: 'penn', sessionId: 's3', sessionIds: [], title: 'Export handoff', status: 'active', createdAt: '2026-06-20T08:59:00.000Z', lastActiveAt: '2026-06-20T10:00:00.000Z' },
    { id: 'c2', agentId: 'penn', sessionId: 's2', sessionIds: [], title: 'July content calendar', status: 'active', createdAt: '2026-07-02T08:59:00.000Z', lastActiveAt: '2026-07-10T10:00:00.000Z' },
    { id: 'c1', agentId: 'default', sessionId: 's1', sessionIds: [], title: 'Board prep planning', status: 'active', pinned: true, pinnedAt: '2026-07-05T09:00:00.000Z', createdAt: '2026-07-01T09:59:00.000Z', lastActiveAt: '2026-07-08T10:00:00.000Z' },
  ], null, 2));

  return { root, workspace, home };
}

module.exports = { buildFixture };
