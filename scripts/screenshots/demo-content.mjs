// The demo workspace's linked notes, board, pins and file ages: the content the
// Pins, Map and connections shots need on top of generate-workspace.mjs's base
// tree. Everything is invented and fixed.
//
// THE LINK SET IS SHAPED, NOT RANDOM. Three clusters of linked notes (Launch,
// the largest; Clients; Research), and a ring of files nothing links to. One
// note is held to an exact shape because two shots read it: Notes/Launch Plan
// links to exactly two notes and is linked from exactly three, so its
// connections list shows two and three, and hovering it on the Map reads five
// connections. Nothing else may link to it, so a new note here must not name
// it.
//
// FILE AGES ARE SET, so the Map's recency shading is the same on every run and
// reads relative to the harness's frozen clock: the centre of the Launch
// cluster is the newest work, the unlinked ring the oldest.

import fs from 'node:fs';
import path from 'node:path';
import { FIXED_EPOCH } from './harness.mjs';

export const LAUNCH_PLAN_REL = 'Notes/Launch Plan.md';

// The pins, in the order they were pinned. Roadmap first, so arriving at Pins
// opens the board.
export const PINS = ['Roadmap.md', 'Notes/Weekly Plan.md', 'Notes/Launch Copy.md', 'Briefing.md'];

// The packages workspace's pins (IMG-18): the Investment Partner dashboard
// first, so arriving at Pins opens its extension view, then three notes.
export const DASHBOARD_REL = 'Investments/Investment Dashboard.md';
export const PACKAGES_PINS = [DASHBOARD_REL, 'Roadmap.md', 'Notes/Weekly Plan.md', 'Briefing.md'];

const DAY = 86400000;

// The folders whose notes form the Map's three clusters (see CLUSTER_FOLDERS
// below, which shapes their links).
const CLUSTER_FOLDERS_FOR_MAP = ['Launch', 'Clients', 'Research'];

// [path, days before the frozen clock, title, links, one line of body]. Links
// are workspace paths without the .md, written as wikilinks.
const NOTES = [
  // Launch cluster: the centre is the newest work.
  [LAUNCH_PLAN_REL, 0.2, 'Launch Plan', ['Launch/Launch Day Runbook', 'Notes/Launch Copy'], 'One page for the launch: what ships, in what order, and who holds each part.'],
  ['Launch/Launch Checklist', 0.4, 'Launch Checklist', ['Notes/Launch Plan', 'Assets/Spec.pdf'], 'Everything that has to be true before launch day, checked off as it lands.'],
  ['Launch/Hero Headline Tests', 0.6, 'Hero Headline Tests', ['Launch/Launch Checklist', 'Notes/Launch Copy', 'Artifacts/Launch Page.html', 'Assets/Cover.png'], 'Two headline variants, the test plan, and the call we make on Wednesday.'],
  ['Launch/Landing Page Brief', 0.9, 'Landing Page Brief', ['Launch/Launch Checklist', 'Notes/Launch Copy', 'Artifacts/Launch Page.html', 'Assets/Cover.png'], 'What the page has to say above the fold, and what can wait for the scroll.'],
  ['Launch/Launch Day Runbook', 1.5, 'Launch Day Runbook', ['Launch/Launch Checklist', 'Briefing', 'Assets/Spec.pdf'], 'Hour by hour on the day, with a named owner for every step.'],
  ['Launch/Press Kit', 2.5, 'Press Kit', ['Launch/Launch Checklist', 'Notes/Launch Plan', 'Assets/Cover.png', 'Artifacts/Launch Page.html', 'Assets/Spec.pdf'], 'Logo, cover image, one-paragraph description and the founder quote.'],
  ['Launch/Pricing Page', 3, 'Pricing Page', ['Launch/Launch Checklist'], 'Three plans, one highlighted, and the questions people ask before choosing.'],
  ['Launch/Launch Email', 4, 'Launch Email', ['Launch/Launch Checklist'], 'The note that goes to the waitlist at nine on launch morning.'],
  ['Launch/Onboarding Flow', 5, 'Onboarding Flow', ['Launch/Launch Checklist'], 'The first ten minutes after sign-up, screen by screen.'],
  ['Launch/Waitlist', 6, 'Waitlist', ['Launch/Launch Checklist'], 'Who signed up, from where, and what they said they wanted.'],
  ['Launch/Beta Feedback', 7, 'Beta Feedback', ['Launch/Launch Checklist'], 'What the beta group struggled with, grouped by how often it came up.'],
  ['Launch/FAQ Draft', 8, 'FAQ Draft', ['Launch/Launch Checklist'], 'Twelve questions, answered in two sentences each.'],
  ['Launch/Demo Script', 9, 'Demo Script', ['Launch/Launch Checklist'], 'A four-minute walkthrough that ends on the moment people remember.'],
  ['Launch/Social Posts', 10, 'Social Posts', ['Launch/Launch Checklist'], 'Five posts for launch week, one per day, each with its image.'],
  ['Launch/Analytics Plan', 12, 'Analytics Plan', ['Launch/Launch Checklist'], 'The four numbers we watch in launch week and where each comes from.'],
  ['Launch/Support Macros', 14, 'Support Macros', ['Launch/Launch Checklist'], 'Saved replies for the questions we already know are coming.'],
  ['Launch/Release Notes', 16, 'Release Notes', ['Launch/Launch Checklist'], 'What is new, in plain words, for people who used the beta.'],
  ['Launch/Partner Outreach', 18, 'Partner Outreach', ['Launch/Launch Checklist'], 'Six partners to tell before launch, and what we are asking of each.'],
  ['Launch/Launch Retro Template', 20, 'Launch Retro Template', ['Launch/Launch Checklist'], 'The questions we answer the week after, whatever happened.'],
  // Clients cluster.
  ['Clients/Client Pipeline', 9, 'Client Pipeline', [], 'Every open conversation, its stage, and the next step.'],
  ['Clients/Northwind', 11, 'Northwind', ['Clients/Client Pipeline'], 'A retail group rebuilding its customer emails.'],
  ['Clients/Northwind Proposal', 13, 'Northwind Proposal', ['Clients/Client Pipeline'], 'Three options, priced, with the one we recommend.'],
  ['Clients/Northwind Kickoff', 15, 'Northwind Kickoff', ['Clients/Client Pipeline'], 'Agenda and notes from the first working session.'],
  ['Clients/Northwind Scope', 17, 'Northwind Scope', ['Clients/Client Pipeline'], 'What is in, what is out, and how we will know it is done.'],
  ['Clients/Harbour and Co', 22, 'Harbour and Co', ['Clients/Client Pipeline'], 'A design studio reviewing its brand before a new site.'],
  ['Clients/Harbour Brand Audit', 25, 'Harbour Brand Audit', ['Clients/Client Pipeline'], 'What the brand says today, page by page, and where it drifts.'],
  ['Clients/Harbour Meeting Notes', 28, 'Harbour Meeting Notes', ['Clients/Client Pipeline'], 'Decisions and actions from the fortnightly call.'],
  ['Clients/Fieldstone Labs', 31, 'Fieldstone Labs', ['Clients/Client Pipeline'], 'A small research lab trialling the content pipeline.'],
  ['Clients/Fieldstone Pilot Plan', 34, 'Fieldstone Pilot Plan', ['Clients/Client Pipeline'], 'A six-week pilot with three checkpoints.'],
  ['Clients/Fieldstone Weekly Sync', 37, 'Fieldstone Weekly Sync', ['Clients/Client Pipeline'], 'Running notes from the weekly sync.'],
  ['Clients/Rate Card', 40, 'Rate Card', ['Clients/Client Pipeline'], 'Day rates and project bands for the year.'],
  ['Clients/Contract Template', 44, 'Contract Template', ['Clients/Client Pipeline'], 'The standard agreement, with the clauses we change most often marked.'],
  ['Clients/Invoice Tracker', 48, 'Invoice Tracker', ['Clients/Client Pipeline'], 'What is invoiced, what is paid, and what is overdue.'],
  ['Clients/Client Onboarding', 52, 'Client Onboarding', ['Clients/Client Pipeline'], 'The checklist for the first week with a new client.'],
  // Research cluster.
  ['Research/Market Map', 30, 'Market Map', [], 'Who else serves small studios, drawn on two axes.'],
  ['Research/Competitor Notes', 38, 'Competitor Notes', ['Research/Market Map'], 'One paragraph per competitor: what they ship and what they claim.'],
  ['Research/Pricing Benchmarks', 46, 'Pricing Benchmarks', ['Research/Market Map'], 'What comparable tools charge, by plan.'],
  ['Research/Interview Synthesis', 55, 'Interview Synthesis', ['Research/Market Map'], 'Five themes from twelve interviews.'],
  ['Research/Customer Interviews', 62, 'Customer Interviews', ['Research/Market Map'], 'Raw notes from each interview, one heading per person.'],
  ['Research/Survey Results', 70, 'Survey Results', ['Research/Market Map'], 'Two hundred responses, summarised.'],
  ['Research/Trend Watch', 78, 'Trend Watch', ['Research/Market Map'], 'Signals worth watching this quarter.'],
  ['Research/Reading Notes', 86, 'Reading Notes', ['Research/Market Map'], 'Highlights from the books and essays the team is reading.'],
  // The unlinked ring: nothing links here, and these link nowhere.
  ['Inbox/Ideas', 95, 'Ideas', [], 'Half-formed ideas, kept until they earn a note of their own.'],
  ['Inbox/Quotes', 100, 'Quotes', [], 'Lines worth remembering.'],
  ['Templates/Meeting', 105, 'Meeting', [], 'Agenda, decisions, actions.'],
  ['Templates/Weekly Review', 110, 'Weekly Review', [], 'What moved, what stalled, what is next.'],
  ['Archive/2025 Plan', 118, '2025 Plan', [], 'Last year\'s plan, kept for the record.'],
];

// The linked notes, as workspace paths: the three clusters and Launch Plan,
// without the unlinked ring. The Map shot centres the view on these, since
// the app's fit frames everything including the ring, whose few far-flung
// dots pull the clusters off centre.
export const LINKED_NOTE_RELS = NOTES
  .filter(([rel]) => CLUSTER_FOLDERS_FOR_MAP.some((f) => rel.startsWith(`${f}/`)) || rel === LAUNCH_PLAN_REL)
  .map(([rel]) => (rel.endsWith('.md') ? rel : `${rel}.md`));

// Ages for the base tree's own files, by the same rule: the notes the team is
// working in now are newest.
const BASE_AGES = {
  'Notes/Launch Copy.md': 0.3, 'Roadmap.md': 0.5, 'Notes/Weekly Plan.md': 0.7, 'Briefing.md': 0.8,
  'Backlog.md': 1, 'Welcome.md': 2, 'Artifacts/Launch Page.html': 1.2, 'CLAUDE.md': 90,
  'Artifacts/Architecture.svg': 84, 'Assets/Cover.png': 26, 'Assets/Photo.jpg': 112, 'Assets/Spec.pdf': 24,
  'Tracker.md': 115,
};

// The roadmap board the Pins shot opens: three columns, one card tagged, one
// ticked. Three because a lane is a fixed 300px and four do not fit beside
// the Pins sidebar at the locked 1440px geometry: the fourth was cut off at
// the frame edge. The card's wikilink carries an alias so it reads as a
// sentence rather than a path. It names no note the Launch Plan's shape
// depends on.
export const ROADMAP_BOARD = [
  '---', '', 'kanban-plugin: board', '', '---', '',
  '## Now', '',
  '- [ ] Ship the launch page #launch 2026-07-24',
  '- [ ] Lock the hero headline',
  '- [ ] Run the [[Launch/Launch Checklist|launch checklist]]', '',
  '## Next', '',
  '- [ ] Open the waitlist to the beta group',
  '- [ ] Publish the pricing page',
  '- [ ] Record the demo video',
  '- [ ] Tidy the onboarding flow', '',
  '## Done', '',
  '- [x] Agree the launch date',
  '- [x] Brief the press kit',
  '- [x] Set up the workspace', '',
  '%% kanban:settings', '```', '{"kanban-plugin":"board"}', '```', '%%', '',
].join('\n');

function noteText([, , title, links, body]) {
  const lines = ['---', `title: ${title}`, 'updated: 2026-07-18', '---', '', `# ${title}`, '', body, ''];
  if (links.length) {
    lines.push('## Related', '');
    for (const target of links) lines.push(`- [[${target}]]`);
    lines.push('');
  }
  return lines.join('\n');
}

// THE MAP SHOWS ONLY ITS BETTER-LINKED NOTES AT REST, a share of them by
// degree, and reveals the rest on zoom. Where most notes share the lowest
// degree, that share is reached inside the tie and every one of them is drawn.
// So each cluster is a hub every member links to, plus a ring (each note to
// the next in its folder): every member has exactly three neighbours unless it
// is given more on purpose, and the few that are sit inside the share drawn at
// rest anyway. Launch Plan is in Notes/, outside every ring: its shape is fixed
// above.
const CLUSTER_FOLDERS = CLUSTER_FOLDERS_FOR_MAP;
// Each cluster's hub, which every other member links to and which stays out
// of the ring (a ring through the hub would give its neighbours one fewer).
const HUBS = ['Launch/Launch Checklist', 'Clients/Client Pipeline', 'Research/Market Map'];

function withRings(notes) {
  const byFolder = {};
  for (const note of notes) {
    const folder = note[0].split('/')[0];
    if (CLUSTER_FOLDERS.includes(folder) && !HUBS.includes(note[0])) (byFolder[folder] = byFolder[folder] || []).push(note);
  }
  const extra = new Map();
  for (const members of Object.values(byFolder)) {
    members.forEach((note, i) => extra.set(note, [members[(i + 1) % members.length][0]]));
  }
  return notes.map((note) => {
    const add = (extra.get(note) || []).filter((t) => !note[3].includes(t));
    return add.length ? [note[0], note[1], note[2], [...note[3], ...add], note[4]] : note;
  });
}

// Writes the linked notes and the pins. `write(rel, contents)` is the
// generator's own writer; `pins` defaults to the main workspace's.
export function writeDemoNotes(write, pins = PINS) {
  for (const note of withRings(NOTES)) {
    const rel = note[0].endsWith('.md') ? note[0] : `${note[0]}.md`;
    write(rel, noteText(note));
  }
  write(path.join('.rundock', 'pins.json'), JSON.stringify(pins, null, 2));
}

// Sets every visible file's modified time, newest first by the tables above,
// a few minutes apart so no two files tie. Files neither table names are
// given a middle age. Hidden folders (.claude, .rundock) are left alone.
export function applyFileAges(workspace) {
  const ages = { ...BASE_AGES };
  for (const note of NOTES) ages[note[0].endsWith('.md') ? note[0] : `${note[0]}.md`] = note[1];
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(path.relative(workspace, full).split(path.sep).join('/'));
    }
  };
  walk(workspace);
  files.sort();
  files.forEach((rel, i) => {
    const days = ages[rel] ?? 45;
    const at = new Date(FIXED_EPOCH - days * DAY - i * 60000);
    fs.utimesSync(path.join(workspace, rel), at, at);
  });
}
