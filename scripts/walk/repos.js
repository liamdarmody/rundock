'use strict';
// The two example repositories the walk installs, and what the walk expects
// of each at its tag. The expectations are stated here as constants so the
// walk report and the repositories can be read against one text: a tag
// that drifts from these fails the walk before the product is touched.
//
// Cloned with real git into the walk's scratch directory, the way the
// server's own acquirer clones, so the check reads the tagged bytes and not
// a listing.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const LEAN_TEAM = {
  repo: 'liamdarmody/lean-agent-team',
  url: 'https://github.com/liamdarmody/lean-agent-team',
  tag: 'v1.0.0',
  agents: ['chief-of-staff', 'content-lead', 'executive-assistant'],
  skills: ['clean-a-note', 'draft-a-post'],
  // The README says what the team is and that it installs by pasting the
  // repository link into Settings. Bound to the two facts, not to sentences.
  readmeSays: [/three agents/i, /two skills/i, /paste .*link.*settings/is],
  absent: ['rundock.json', '.claude/.cc-writes'],
};

const CSV_EXTENSION = {
  repo: 'liamdarmody/rundock-csv-extension',
  url: 'https://github.com/liamdarmody/rundock-csv-extension',
  tag: 'v1.0.1',
  name: 'csv-table',
  match: '*.csv',
  license: 'LICENSE',
  // Tokens that would give the entry a way to reach the network or load
  // code the host never inlined. Asserted here against the clone and again
  // in the walk against the bytes the server serves to the frame.
  networkTokens: ['fetch', 'XMLHttpRequest', 'WebSocket', 'import(', '<script src', '<link'],
};

function cloneAt(url, tag, into) {
  fs.mkdirSync(path.dirname(into), { recursive: true });
  execFileSync('git', ['clone', '--quiet', '--depth', '1', '--branch', tag, url, into], { stdio: ['ignore', 'pipe', 'pipe'] });
  return into;
}

const exists = (dir, rel) => fs.existsSync(path.join(dir, ...rel.split('/')));
const read = (dir, rel) => fs.readFileSync(path.join(dir, ...rel.split('/')), 'utf8');

// Which of the network tokens a script's bytes carry. Empty means clean.
function networkTokensIn(text) {
  return CSV_EXTENSION.networkTokens.filter((token) => text.includes(token));
}

// Each check answers a list of findings, one per expectation, so the walk
// can name exactly which expectation a tag missed.
function checkLeanTeam(dir) {
  const findings = [];
  const note = (ok, what) => findings.push({ ok, what });
  for (const agent of LEAN_TEAM.agents) note(exists(dir, `.claude/agents/${agent}.md`), `agent file .claude/agents/${agent}.md`);
  const agentFiles = fs.existsSync(path.join(dir, '.claude', 'agents')) ? fs.readdirSync(path.join(dir, '.claude', 'agents')).filter((f) => f.endsWith('.md')) : [];
  note(agentFiles.length === LEAN_TEAM.agents.length, `exactly ${LEAN_TEAM.agents.length} agent files (found ${agentFiles.length})`);
  for (const skill of LEAN_TEAM.skills) note(exists(dir, `.claude/skills/${skill}/SKILL.md`), `skill directory .claude/skills/${skill} with SKILL.md`);
  const skillDirs = fs.existsSync(path.join(dir, '.claude', 'skills')) ? fs.readdirSync(path.join(dir, '.claude', 'skills')) : [];
  note(skillDirs.length === LEAN_TEAM.skills.length, `exactly ${LEAN_TEAM.skills.length} skill directories (found ${skillDirs.length})`);
  const readme = exists(dir, 'README.md') ? read(dir, 'README.md') : '';
  note(readme.length > 0, 'README.md present');
  for (const re of LEAN_TEAM.readmeSays) note(re.test(readme), `README matches ${re}`);
  for (const rel of LEAN_TEAM.absent) note(!exists(dir, rel), `${rel} absent`);
  return findings;
}

function checkCsvExtension(dir) {
  const findings = [];
  const note = (ok, what) => findings.push({ ok, what });
  let manifest = null;
  try { manifest = JSON.parse(read(dir, 'rundock.json')); } catch (e) { /* noted below */ }
  note(!!manifest, 'rundock.json present and parseable');
  const ext = (manifest && manifest.extension) || {};
  note(manifest && manifest.name === CSV_EXTENSION.name, `rundock.json name is ${CSV_EXTENSION.name}`);
  note(manifest && manifest.version === CSV_EXTENSION.tag.replace(/^v/, ''), `rundock.json version matches the tag ${CSV_EXTENSION.tag}`);
  note(typeof ext.entry === 'string' && exists(dir, ext.entry), `extension.entry names a file in the package (${ext.entry})`);
  note(ext.match === CSV_EXTENSION.match, `extension.match covers .csv (${ext.match})`);
  const entry = typeof ext.entry === 'string' && exists(dir, ext.entry) ? read(dir, ext.entry) : '';
  const tokens = networkTokensIn(entry);
  note(entry.length > 0 && tokens.length === 0, `entry bytes free of network tokens${tokens.length ? ` (found ${tokens.join(', ')})` : ''}`);
  note(/<thead>|thead/.test(entry) && /init/.test(entry), 'entry renders the init text as a table with a header row');
  const readme = exists(dir, 'README.md') ? read(dir, 'README.md') : '';
  note(readme.includes(CSV_EXTENSION.url), 'README carries the repository link');
  note(readme.includes(CSV_EXTENSION.tag), `README names the reference ${CSV_EXTENSION.tag}`);
  note(exists(dir, CSV_EXTENSION.license), `license file ${CSV_EXTENSION.license} present`);
  return findings;
}

module.exports = { LEAN_TEAM, CSV_EXTENSION, cloneAt, checkLeanTeam, checkCsvExtension, networkTokensIn };
