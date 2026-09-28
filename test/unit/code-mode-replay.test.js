'use strict';
// THE ACCEPTANCE REPLAY: a real development session, 85 calls, through the
// real hook, the server relay rules and the browser card rules, for Claude
// Code; and the same session through the real Codex grading, for Codex.
//
// On 0.15.0 this session raised 38 cards on first sight, 35 of them with no
// way to be remembered, and 33 even when the person always took the most
// lasting answer offered. The fix is judged here call by call, not by a total
// alone: every call that should raise no card raises none, and each of the
// nine that should ask asks in the class it should.
//
// The fixture is built with Rundock's own scaffold and protocol handlers, in
// Code mode with the sandbox switch off, and the working folder is stored in
// several spellings (a full path, ~ forms, through a symlink, in another
// letter case). Every spelling must give identical decisions, row for row.
//
// The fixture sits outside every temp folder and git working tree, because
// both are part of what is judged (see test/helpers/code-mode-fixture.js).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const fx = require('../helpers/code-mode-fixture.js');
const session = require('../fixtures/code-mode/session.js');
const RP = require('../../public/permissions.js');

const root = fx.outsideTempRoot();
const SKIP = root.skip || false;

// ── Expected, per call (1-based, as the session numbers them) ───────────────
const CLAUDE_EXPECTED = {
  14: 'asks-once',   // git push origin main
  29: 'asks-once',   // git push origin --delete old-spike
  30: 'always-asks', // git push --force origin feat/signup
  40: 'always-asks', // find . -name '*.orig' -delete, at the top of the repository
  62: 'always-asks', // rm -rf of the folder with no repository
  79: 'always-asks', // cat ~/.ssh/config
  80: 'always-asks', // ls ~/.ssh
  81: 'always-asks', // Read ~/.ssh/config
  84: 'refused',     // Edit ~/.claude/settings.json, unchanged
  85: 'always-asks-or-refused', // Write ~/.claude/CLAUDE.md
};
const CODEX_EXPECTED = { 14: 'asks-once', 29: 'asks-once', 30: 'always-asks', 40: 'always-asks', 62: 'always-asks', 84: 'always-asks', 85: 'always-asks' };
// Reads Codex's sandbox never escalates, so Rundock never sees them: a known
// gap, recorded as one rather than asserted as the right answer.
const CODEX_READ_GAP = [79, 80, 81];

let W; // the world
before(() => { if (!SKIP) W = buildReplayWorld(root.dir); });

function buildReplayWorld(base) {
  const WS = path.join(base, 'workspace');
  const PROJ = path.join(base, 'projects');
  const REMOTES = path.join(base, 'remotes');
  const HOME_B = path.join(base, 'home');
  const HOME_B2 = path.join(base, 'home-real');
  const LINKS = path.join(base, 'links');
  const UPPER = path.join(base, 'PROJECTS');
  const git = fx.git;
  const write = fx.write;

  // The workspace, through Rundock's own scaffold and handlers.
  fs.mkdirSync(path.join(WS, '.claude'), { recursive: true });
  const config = require('../../lib/config.js');
  config.setWorkspace(WS);
  const sc = require('../../lib/workspace/scaffold.js');
  sc.wireScaffoldDeps({ invalidateAgentCache() {}, rebaselineAgentsWatcher() {} });
  sc.recordFirstOpen(WS);
  const d = sc.scaffoldDefaults(WS);
  if (!d.success) throw new Error('scaffoldDefaults failed: ' + d.error);
  sc.scaffoldWorkspace(WS);
  const wsh = require('../../lib/protocol/handlers/workspace.js');
  const sink = () => ({ out: [], send(s) { this.out.push(JSON.parse(s)); } });
  wsh.handleSetWorkspaceMode({}, sink(), { mode: 'code' });
  wsh.handleSetWorkspaceSandbox({}, sink(), { on: false });

  // The projects folder.
  fs.mkdirSync(REMOTES, { recursive: true });
  const BARE = path.join(REMOTES, 'app.git');
  git(REMOTES, 'init', '-q', '--bare', '-b', 'main', BARE);
  const APP = path.join(PROJ, 'app');
  fs.mkdirSync(APP, { recursive: true });
  git(APP, 'init', '-q', '-b', 'main');
  write(path.join(APP, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0' }, null, 2) + '\n');
  write(path.join(APP, 'README.md'), '# app\n');
  write(path.join(APP, 'notes.txt'), 'scratch notes\n');
  write(path.join(APP, 'src/index.js'), "console.log('hello');\n");
  write(path.join(APP, 'src/old.js'), 'module.exports = 1;\n');
  write(path.join(APP, 'scripts/dev.sh'), '#!/bin/sh\nnpm run dev\n');
  write(path.join(APP, '.env.example'), 'API_KEY=\n');
  write(path.join(APP, '.gitignore'), 'node_modules/\ndist/\n.env\n');
  git(APP, 'add', '-A');
  git(APP, 'commit', '-q', '-m', 'Initial commit');
  git(APP, 'remote', 'add', 'origin', BARE);
  git(APP, 'push', '-q', '-u', 'origin', 'main');
  git(APP, 'remote', 'set-head', 'origin', 'main');
  git(APP, 'branch', 'old-spike');
  git(APP, 'switch', '-q', '-c', 'feat/login');
  write(path.join(APP, 'src/login.js'), 'module.exports = () => true;\n');
  git(APP, 'add', '-A');
  git(APP, 'commit', '-q', '-m', 'Start login');
  git(APP, 'push', '-q', '-u', 'origin', 'feat/login');
  write(path.join(APP, 'node_modules/left-pad/index.js'), 'module.exports = s => s;\n');
  write(path.join(APP, 'dist/bundle.js'), '// built\n');
  write(path.join(APP, '.env'), 'API_KEY=not-a-real-key\n');
  const OTHER = path.join(PROJ, 'other');
  fs.mkdirSync(OTHER, { recursive: true });
  git(OTHER, 'init', '-q', '-b', 'main');
  write(path.join(OTHER, 'README.md'), '# other\n');
  git(OTHER, 'add', '-A');
  git(OTHER, 'commit', '-q', '-m', 'Initial commit');
  write(path.join(PROJ, 'sketch/idea.md'), 'not in git\n');

  // Homes and spellings.
  for (const H of [HOME_B, HOME_B2]) {
    write(path.join(H, '.npm/_cacache/index-v5/aa/entry'), 'cache\n');
    write(path.join(H, '.ssh/config'), 'Host example\n  User git\n');
    write(path.join(H, '.ssh/known_hosts'), '# empty\n');
    write(path.join(H, '.gitconfig'), '[user]\n\tname = Test User\n');
    write(path.join(H, '.claude/CLAUDE.md'), '# global instructions\n');
    write(path.join(H, '.claude/settings.json'), '{}\n');
  }
  fs.symlinkSync(PROJ, path.join(HOME_B, 'Projects'));
  fs.mkdirSync(path.join(HOME_B2, 'Projects'), { recursive: true });
  git(path.join(HOME_B2, 'Projects'), 'clone', '-q', BARE, 'app');
  git(path.join(HOME_B2, 'Projects', 'app'), 'switch', '-q', 'feat/login');
  write(path.join(HOME_B2, 'Projects/app/node_modules/left-pad/index.js'), 'module.exports = s => s;\n');
  write(path.join(HOME_B2, 'Projects/app/dist/bundle.js'), '// built\n');
  write(path.join(HOME_B2, 'Projects/app/.env'), 'API_KEY=not-a-real-key\n');
  write(path.join(HOME_B2, 'Projects/app/notes.txt'), 'scratch notes\n');
  fs.mkdirSync(path.join(HOME_B2, 'Projects/other'), { recursive: true });
  git(path.join(HOME_B2, 'Projects/other'), 'init', '-q', '-b', 'main');
  write(path.join(HOME_B2, 'Projects/other/README.md'), '# other\n');
  git(path.join(HOME_B2, 'Projects/other'), 'add', '-A');
  git(path.join(HOME_B2, 'Projects/other'), 'commit', '-q', '-m', 'Initial commit');
  write(path.join(HOME_B2, 'Projects/sketch/idea.md'), 'not in git\n');
  fs.mkdirSync(LINKS, { recursive: true });
  fs.symlinkSync(PROJ, path.join(LINKS, 'Projects'));
  const foldsCase = fs.existsSync(UPPER);

  const VARIANTS = {
    a: { home: HOME_B, stored: PROJ, P: PROJ, PA: PROJ },
    b: { home: base, stored: '~/projects', P: '~/projects', PA: PROJ },
    b1: { home: HOME_B, stored: '~/Projects', P: '~/Projects', PA: path.join(HOME_B, 'Projects') },
    b2: { home: HOME_B2, stored: '~/Projects', P: '~/Projects', PA: path.join(HOME_B2, 'Projects') },
    c1: { home: HOME_B, stored: path.join(LINKS, 'Projects'), P: PROJ, PA: PROJ },
    c2: { home: HOME_B, stored: PROJ, P: path.join(LINKS, 'Projects'), PA: path.join(LINKS, 'Projects') },
  };
  // Letter case differs only where the filesystem folds it.
  if (foldsCase) {
    VARIANTS.d1 = { home: HOME_B, stored: UPPER, P: PROJ, PA: PROJ };
    VARIANTS.d2 = { home: HOME_B, stored: PROJ, P: UPPER, PA: UPPER };
  }
  return { base, WS, PROJ, HOME_B, VARIANTS, foldsCase };
}

// ── The server relay and the browser card, from the real modules ─────────────
function cardFor(payload, allowed) {
  const boundary = require('../../lib/workspace/boundary.js');
  const crossings = Array.isArray(payload.crossings) ? payload.crossings.filter(c => c && c.path) : [];
  const grantable = payload.grantable !== false;
  const uncovered = grantable ? crossings.filter(c => !boundary.crossingCovered(c)) : crossings;
  if (payload.boundary && grantable && crossings.length && uncovered.length === 0) return { card: false };
  const chosen = uncovered[0] || null;
  const grantDir = payload.boundary ? ((chosen && chosen.grantDir) || payload.grant_dir || null) : null;
  const input = payload.tool_input || payload.input || {};
  const tool = payload.tool_name;
  const verdict = payload.code_mode_verdict || null;
  const answerFile = payload.answer_file === true || uncovered.some(c => c && c.answerFile);
  const risk = RP.classifyRisk(tool, input);
  const key = verdict && verdict.verdict === 'asks-once' ? RP.verdictAllowKey(verdict) : RP.toolAllowKey(tool, input);
  const decision = (payload.boundary || answerFile) ? { action: 'card' } : RP.decidePermission(risk, key, allowed, verdict || undefined);
  if (decision.action === 'allow') return { card: false };
  const folder = payload.boundary && grantDir && !answerFile && !uncovered.some(c => c.secret) ? grantDir : null;
  const always = !payload.boundary && !answerFile && RP.offersAlwaysAllow(risk, verdict || undefined) ? key : null;
  return { card: true, verdict, folder, always };
}

describe('the session, replayed for Claude Code', { skip: SKIP }, () => {
  let capture, deadPort, results;

  before(async () => {
    capture = await fx.startCaptureServer();
    deadPort = await fx.closedPort();
    results = {};
    const claudeRt = require('../../lib/runtime/claude.js');
    const boundary = require('../../lib/workspace/boundary.js');
    const wf = require('../../lib/workspace/working-folders.js');
    const wsh = require('../../lib/protocol/handlers/workspace.js');
    const { readState, writeState } = require('../../lib/store/persistence.js');
    const savedHome = process.env.HOME;
    try {
      for (const [name, v] of Object.entries(W.VARIANTS)) {
        for (const pass of ['first-sight', 'most-lasting']) {
          process.env.HOME = v.home;
          const st = readState(); st.workingFolders = []; writeState(st);
          try { fs.rmSync(boundary.boundaryPermissionsPath()); } catch (e) { /* none yet */ }
          wsh.handleSetWorkingFolders({}, { send() {} }, { folders: [v.stored] });
          claudeRt.wireClaudeRuntimeDeps({ getActualPort: () => capture.port });
          const env = { ...claudeRt.getSpawnEnv('convo-replay'), HOME: v.home };
          const envDead = { ...env, RUNDOCK_PORT: String(deadPort) };
          const calls = session({ R: `${v.P}/app`, RA: `${v.PA}/app`, P: v.P, PA: v.PA, H: v.home });
          const allowed = new Set();
          const rows = [];
          let n = 0;
          for (const call of calls) {
            n++;
            const sid = `replay-${name}-${pass}-${n}`;
            const input = {
              session_id: sid, transcript_path: '', permission_mode: 'acceptEdits', hook_event_name: 'PreToolUse',
              cwd: call.cwd === 'repo' ? fx.real(`${v.PA}/app`) : W.WS,
              tool_name: call.tool, tool_input: JSON.parse(JSON.stringify(call.input)),
            };
            const live = await fx.runHook(env, input);
            const payload = capture.posted.get(sid) || null;
            let kind = 'none';
            let card = null;
            if (!payload) {
              kind = live.decision === 'deny' ? 'refused' : 'none';
            } else {
              card = cardFor(payload, allowed);
              if (card.card) {
                // A verdict that says the command itself runs does not decide a
                // boundary card: what happens unanswered does.
                if (card.verdict && card.verdict.verdict !== 'runs') kind = card.verdict.verdict;
                else {
                  const dead = await fx.runHook(envDead, { ...input, session_id: sid + '-dead' });
                  kind = dead.decision === 'deny' ? 'always-asks' : 'boundary';
                }
                if (pass === 'most-lasting') {
                  if (card.folder) {
                    boundary.addBoundaryGrant(card.folder);
                    const norm = wf.normalizeOne(card.folder);
                    const existing = wf.readWorkingFolders();
                    if (norm && !existing.includes(norm)) wf.writeWorkingFolders([...existing, norm]);
                  } else if (card.always) {
                    boundary.addToolAllow(card.always); allowed.add(card.always);
                  }
                }
              }
            }
            rows.push({ n, kind, card: !!(card && card.card), remembered: !!(card && card.card && (card.folder || card.always)) });
          }
          results[`${name}/${pass}`] = { rows, allowed };
        }
      }
    } finally { process.env.HOME = savedHome; }
  });
  after(async () => { if (capture) await capture.close(); });

  test('every path spelling gives identical decisions, row for row', () => {
    const names = Object.keys(W.VARIANTS);
    for (const pass of ['first-sight', 'most-lasting']) {
      const ref = results[`a/${pass}`].rows.map(r => r.kind);
      for (const name of names) {
        assert.deepStrictEqual(results[`${name}/${pass}`].rows.map(r => r.kind), ref, `${name} matches a (${pass})`);
      }
    }
  });

  test('each call raises exactly the card it should, on first sight', () => {
    const rows = results['a/first-sight'].rows;
    const wrong = [];
    for (const r of rows) {
      const want = CLAUDE_EXPECTED[r.n] || 'none';
      const ok = want === 'always-asks-or-refused' ? (r.kind === 'always-asks' || r.kind === 'refused') : r.kind === want;
      if (!ok) wrong.push(`call ${r.n}: expected ${want}, got ${r.kind}`);
    }
    assert.deepStrictEqual(wrong, [], wrong.join('\n'));
  });

  test('9 cards on first sight, 7 of them without Always allow (8 and 6 if call 85 is a measured refusal)', () => {
    const rows = results['a/first-sight'].rows;
    const cards = rows.filter(r => r.card);
    const refused85 = rows[84].kind === 'refused';
    assert.strictEqual(cards.length, refused85 ? 8 : 9);
    assert.strictEqual(cards.filter(r => !r.remembered).length, refused85 ? 6 : 7);
  });

  test('9 cards when the most lasting answer is always taken: each asking call occurs once', () => {
    const rows = results['a/most-lasting'].rows;
    const refused85 = rows[84].kind === 'refused';
    assert.strictEqual(rows.filter(r => r.card).length, refused85 ? 8 : 9);
  });

  test('a repeat of call 14 after "Always allow pushes to main" raises no card', async () => {
    const { allowed } = results['a/most-lasting'];
    assert.ok(allowed.has('Bash:git-push:default-branch'), 'the rule key was the one remembered');
    const v = W.VARIANTS.a;
    const sid = `replay-repeat-14-${process.pid}`;
    const claudeRt = require('../../lib/runtime/claude.js');
    const env = { ...claudeRt.getSpawnEnv('convo-replay'), HOME: v.home };
    await fx.runHook(env, { session_id: sid, hook_event_name: 'PreToolUse', cwd: fx.real(`${v.PA}/app`), tool_name: 'Bash', tool_input: { command: 'git push origin main' } });
    const payload = capture.posted.get(sid);
    assert.ok(payload, 'the hook still asks the server');
    assert.strictEqual(cardFor(payload, allowed).card, false, 'and the standing rule answers it');
  });
});

describe('the session, replayed for Codex', { skip: SKIP }, () => {
  function codexRows() {
    const { gradeCodexApproval } = require('../../lib/runtime/codex-approval.js');
    const v = W.VARIANTS.a;
    const APP = `${v.PA}/app`;
    const calls = session({ R: APP, RA: APP, P: v.PA, PA: v.PA, H: v.home });
    const wf = require('../../lib/workspace/working-folders.js');
    const extraDirs = wf.effectiveWorkingFolders([W.PROJ]);
    const allowed = new Set();
    const rows = [];
    let n = 0;
    for (const c of calls) {
      n++;
      let g = null;
      const cwd = c.cwd === 'repo' ? fx.real(APP) : W.WS;
      // The model: a command escalates when it writes outside the workspace or
      // needs the network; a file edit escalates when it writes outside.
      if ((c.tool === 'Bash') && (c.codex.write || c.codex.net)) {
        g = gradeCodexApproval({ kind: 'command', params: { command: c.input.command, cwd }, workspaceRoot: W.WS, extraDirs, codeMode: true, home: v.home });
      } else if ((c.tool === 'Edit' || c.tool === 'Write') && c.codex.write) {
        g = gradeCodexApproval({ kind: 'fileChange', params: { grantRoot: path.dirname(c.input.file_path), reason: 'edit' }, workspaceRoot: W.WS, extraDirs, codeMode: true, home: v.home });
      }
      if (!g || g.decision === 'accept') { rows.push({ n, kind: 'none', escalated: !!g }); continue; }
      const card = cardFor(g.request, allowed);
      if (!card.card) { rows.push({ n, kind: 'none', escalated: true }); continue; }
      const kind = (card.verdict && card.verdict.verdict !== 'runs') ? card.verdict.verdict : (card.folder ? 'boundary' : 'always-asks');
      rows.push({ n, kind, escalated: true, remembered: !!(card.folder || card.always) });
      if (card.always) allowed.add(card.always);
    }
    return rows;
  }

  test('each escalation raises exactly the card it should', () => {
    const rows = codexRows();
    const wrong = [];
    for (const r of rows) {
      const want = CODEX_EXPECTED[r.n] || 'none';
      if (r.kind !== want) wrong.push(`call ${r.n}: expected ${want}, got ${r.kind}`);
    }
    assert.deepStrictEqual(wrong, [], wrong.join('\n'));
  });

  test('7 cards, 5 without Always allow; no card for any file change inside the working folder', () => {
    const rows = codexRows();
    const cards = rows.filter(r => r.kind !== 'none');
    assert.strictEqual(cards.length, 7);
    assert.strictEqual(cards.filter(r => !r.remembered).length, 5);
    for (const n of [8, 9, 10, 64]) assert.strictEqual(rows[n - 1].kind, 'none', `call ${n}, a file change in the working folder`);
  });

  test('known gap, not the right answer: reads of ~/.ssh never escalate under Codex, so they raise no card', () => {
    const rows = codexRows();
    for (const n of CODEX_READ_GAP) {
      assert.strictEqual(rows[n - 1].escalated, false, `call ${n} does not reach Rundock at all: a known gap in what Codex escalates`);
    }
  });
});

after(() => { if (root.dir) fs.rmSync(root.dir, { recursive: true, force: true }); });
