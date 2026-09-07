'use strict';
// The walk's scratch workspace and scratch HOME, built fresh for every run.
// Small on purpose: one agent that owns one skill (so a routine can be made
// through the editor and run against the stub runtime), two notes that link
// to each other (so the map has an edge and a keyword that matches one
// file), and one csv (so the extension has something to render). Nothing
// here comes from a real workspace and nothing the walk writes leaves it.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SEED = {
  agent: 'roo',
  skill: 'walk-check',
  skillName: 'Walk Check',
  noteA: 'walk-alpha.md',
  target: 'walk-target.md',
  targetKeyword: 'walk-target',
  targetSentinel: 'WALK-TARGET-BODY: the map opened this file.',
  csv: 'walk-sales.csv',
  csvHeader: ['region', 'revenue'],
  csvText: 'region,revenue\nnorth,120\nsouth,98\n',
};

function write(root, rel, content) {
  const absolute = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

function buildWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-walk-'));
  const workspace = path.join(root, 'workspace');
  const home = path.join(root, 'home');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  write(workspace, 'CLAUDE.md', '# Walk Workspace\n\nA disposable workspace the release walk drives.\n');
  write(workspace, `.claude/agents/${SEED.agent}.md`,
    `---\nname: ${SEED.agent}\ndisplayName: Roo\nrole: Chief of Staff\ntype: orchestrator\norder: 0\nmodel: sonnet\nskills: [${SEED.skill}]\n---\nYou are Roo. Route work to the team.\n`);
  write(workspace, `.claude/skills/${SEED.skill}/SKILL.md`,
    `---\nname: ${SEED.skillName}\ndescription: Checks the workspace and reports one line.\n---\nSay that the walk check ran.\n`);
  write(workspace, SEED.noteA, `# Alpha\n\nLinks onward to [[${SEED.targetKeyword}]] for the map step.\n`);
  write(workspace, SEED.target, `# Walk Target\n\n${SEED.targetSentinel}\n\nBack to [[walk-alpha]].\n`);
  write(workspace, SEED.csv, SEED.csvText);
  // The stub runtime answers whatever the routine asks with one line, and
  // stays silent on anything system-shaped.
  write(workspace, 'stub-scenario.json', JSON.stringify({ rules: [
    { match: { promptIncludes: '[SYSTEM' }, turn: [{ text: '<silent>' }] },
    { match: {}, turn: [{ text: 'WALK-ROUTINE-REPLY: the walk check ran.' }] },
  ] }, null, 2));
  return { root, workspace, home };
}

module.exports = { SEED, buildWorkspace };
