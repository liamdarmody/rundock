'use strict';
// NOTES MODE DOES NOT CHANGE. Every command in the Code-mode table is replayed
// in Notes mode and compared with what v0.15.0 did, recorded in
// test/fixtures/code-mode/notes-golden.json by
// test/tools/record-code-mode-notes-golden.js: the client grader's risk and
// Always-allow offer, and the real hook's decision, request and unanswered
// outcome.
//
// Three corrections are allowed to show here, because they fix wrong answers
// rather than change the policy, and each is named where it applies:
//   relative-base     a relative path is resolved where the command runs, so a
//                     `..` from inside a repository no longer lands beside the
//                     workspace (the grader's answers still must not move);
//   no-home-offer,
//   no-phantom-offer  no card offers the home directory, or a folder that does
//                     not exist; the rest of the request must not move;
//   instruction-file  the runtimes' global instruction files are protected in
//                     both modes, so writing one asks in Notes mode too.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const fx = require('../helpers/code-mode-fixture.js');
const { ROWS, spellingsOf } = require('../fixtures/code-mode/command-table.js');
const RP = require('../../public/permissions.js');
const GOLDEN = require('../fixtures/code-mode/notes-golden.json');

const root = fx.outsideTempRoot();
const SKIP = root.skip || false;
let world, capture, deadPort;
before(async () => {
  if (SKIP) return;
  world = fx.buildWorld(root.dir);
  capture = await fx.startCaptureServer();
  deadPort = await fx.closedPort();
});
after(async () => {
  if (capture) await capture.close();
  if (root.dir) fs.rmSync(root.dir, { recursive: true, force: true });
});

function placeholders(p) {
  if (!p) return p;
  const pairs = [[fx.real(world.app), '<APP>'], [fx.real(world.ws), '<WS>'], [fx.real(world.projects), '<PROJECTS>'], [fx.real(world.home), '<HOME>'], [fx.real(world.root), '<ROOT>']];
  for (const [real, name] of pairs) {
    if (p === real) return name;
    if (p.startsWith(real + path.sep)) return name + p.slice(real.length).split(path.sep).join('/');
  }
  return p;
}
function unplace(p) {
  return p.replace('<APP>', world.app).replace('<WS>', world.ws).replace('<PROJECTS>', world.projects).replace('<HOME>', world.home).replace('<ROOT>', world.root);
}
function keyOf(sp) {
  const what = sp.command !== undefined ? sp.command : `${sp.tool} ${JSON.stringify(sp.input)}`;
  return [sp.rowId, sp.tool, what, sp.at, sp.state].join(' | ');
}
function correctionFor(sp, recorded) {
  // The runtimes' global instruction files are protected in both modes, so a
  // write to one now asks (or is refused, for a file-edit tool) in Notes mode
  // too.
  if (sp.rowId === 'I2' || sp.rowId === 'I3') return 'instruction-file';
  const text = sp.command !== undefined ? sp.command : JSON.stringify(sp.input);
  if (/(^|[\s/\\"'])\.\.([\\/]|\s|$)/.test(text)) return 'relative-base';
  if (recorded.hook.grantDir === '<HOME>') return 'no-home-offer';
  if (recorded.hook.grantDir && !fs.existsSync(unplace(recorded.hook.grantDir))) return 'no-phantom-offer';
  return null;
}

describe('Notes mode equals v0.15.0, command for command', { skip: SKIP }, () => {
  const byKey = new Map(GOLDEN.rows.map(r => [r.key, r]));

  test('the golden was recorded from v0.15.0 and covers every spelling', () => {
    assert.strictEqual(GOLDEN.recordedFrom, 'v0.15.0');
    let n = 0;
    for (const row of ROWS) for (const sp of spellingsOf(row)) if (!sp.win) { n++; assert.ok(byKey.has(keyOf(sp)), keyOf(sp)); }
    assert.strictEqual(GOLDEN.rows.length, n);
  });

  for (const row of ROWS) {
    for (const sp of spellingsOf(row)) {
      if (sp.win) continue;
      const key = keyOf(sp);
      test(key, async () => {
        const recorded = byKey.get(key);
        const input = sp.command !== undefined ? { command: fx.expand(world, sp.command) }
          : Object.fromEntries(Object.entries(sp.input).map(([k, v]) => [k, typeof v === 'string' ? fx.expand(world, v) : v]));
        const risk = RP.classifyRisk(sp.tool, input);
        assert.strictEqual(risk, recorded.risk, 'the Notes-mode grader is unchanged');
        assert.strictEqual(RP.offersAlwaysAllow(risk), recorded.offersAlwaysAllow);
        const correction = correctionFor(sp, recorded);
        if (correction === 'relative-base') return;
        if (correction === 'instruction-file') {
          const r = await fx.judge(world, capture, deadPort, { tool: sp.tool, input, cwd: fx.cwdFor(world, sp.at), codeMode: false });
          assert.ok(r.payload || r.live.decision === 'deny', 'a write to a global instruction file asks, or is refused, in Notes mode too');
          return;
        }
        const r = await fx.withStateAsync(world, sp.state, () => fx.judge(world, capture, deadPort, { tool: sp.tool, input, cwd: fx.cwdFor(world, sp.at), codeMode: false }));
        const p = r.payload;
        assert.ok(!(p && 'code_mode_verdict' in p), 'no verdict outside Code mode');
        const now = {
          decision: r.live.decision, asked: !!p, boundary: !!(p && p.boundary), answerFile: !!(p && p.answer_file),
          grantDir: p ? placeholders(p.grant_dir || null) : null,
          crossings: p && Array.isArray(p.crossings) ? p.crossings.map(c => placeholders(c.path)) : [],
          unanswered: r.dead.decision,
        };
        if (correction) {
          assert.strictEqual(now.grantDir, null, `${correction}: the offer is withdrawn`);
          assert.deepStrictEqual({ ...now, grantDir: null }, { ...recorded.hook, grantDir: null }, 'and nothing else moved');
          return;
        }
        assert.deepStrictEqual(now, recorded.hook);
      });
    }
  }
});
