'use strict';
// Records what Notes mode does today for every command in the Code-mode table,
// so the Code-mode work can be held to changing nothing there.
//
//   node test/tools/record-code-mode-notes-golden.js
//
// Run once, at the release the golden is named for, and committed. For every
// spelling that is not Windows-shaped: the client grader's risk and whether it
// offers Always allow, and the real hook's Notes-mode decision (did it ask,
// was it a crossing or an answer file, which folder would the card offer, and
// what happens when nobody can be asked). Fixture paths are written as
// placeholders so the file is the same on every machine.
//
// Needs a folder outside every temp folder and git working tree, as the tests
// do: set RUNDOCK_TEST_OUTSIDE_TEMP_ROOT if /var/tmp is not writable.
const fs = require('node:fs');
const path = require('node:path');

const fx = require('../helpers/code-mode-fixture.js');
const { ROWS, spellingsOf } = require('../fixtures/code-mode/command-table.js');
const RP = require('../../public/permissions.js');

const OUT = path.join(__dirname, '..', 'fixtures', 'code-mode', 'notes-golden.json');

function placeholders(world, p) {
  if (!p) return p;
  const pairs = [[fx.real(world.app), '<APP>'], [fx.real(world.ws), '<WS>'], [fx.real(world.projects), '<PROJECTS>'], [fx.real(world.home), '<HOME>'], [fx.real(world.root), '<ROOT>']];
  for (const [real, name] of pairs) {
    if (p === real) return name;
    if (p.startsWith(real + path.sep)) return name + p.slice(real.length).split(path.sep).join('/');
  }
  return p;
}

function keyOf(sp) {
  const what = sp.command !== undefined ? sp.command : `${sp.tool} ${JSON.stringify(sp.input)}`;
  return [sp.rowId, sp.tool, what, sp.at, sp.state].join(' | ');
}

async function main() {
  const root = fx.outsideTempRoot();
  if (root.skip) { console.error(root.skip); process.exit(2); }
  const world = fx.buildWorld(root.dir);
  const capture = await fx.startCaptureServer();
  const dead = await fx.closedPort();
  const rows = [];
  try {
    for (const row of ROWS) {
      for (const sp of spellingsOf(row)) {
        if (sp.win) continue;
        const input = sp.command !== undefined ? { command: fx.expand(world, sp.command) }
          : Object.fromEntries(Object.entries(sp.input).map(([k, v]) => [k, typeof v === 'string' ? fx.expand(world, v) : v]));
        const r = await fx.withStateAsync(world, sp.state, () => fx.judge(world, capture, dead, { tool: sp.tool, input, cwd: fx.cwdFor(world, sp.at), codeMode: false }));
        const risk = RP.classifyRisk(sp.tool, input);
        const p = r.payload;
        rows.push({
          key: keyOf(sp),
          risk,
          offersAlwaysAllow: RP.offersAlwaysAllow(risk),
          hook: {
            decision: r.live.decision,
            asked: !!p,
            boundary: !!(p && p.boundary),
            answerFile: !!(p && p.answer_file),
            grantDir: p ? placeholders(world, p.grant_dir || null) : null,
            crossings: p && Array.isArray(p.crossings) ? p.crossings.map(c => placeholders(world, c.path)) : [],
            unanswered: r.dead.decision,
          },
        });
      }
    }
  } finally {
    await capture.close();
    fs.rmSync(root.dir, { recursive: true, force: true });
  }
  const doc = { recordedFrom: 'v0.15.0', mode: 'notes', rows };
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n');
  console.log(`recorded ${rows.length} spellings to ${path.relative(process.cwd(), OUT)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
