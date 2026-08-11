#!/usr/bin/env node
'use strict';
// Synthetic user personas: scripted journeys with disk-verified evals.
//
// Why: component tests sample; users traverse. One evening of acting like a
// user found five real issues that 1,300 green tests missed, and four of the
// last release's post-cut discoveries sat on the new-user onboarding journey,
// which was effectively untested because development happens in mature
// workspaces. These journeys make user-shaped testing a standing release
// stage instead of a heroic evening.
//
// Personas:
//   NEW USER       empty folder -> scaffold -> Doc onboarding (Beat 0,
//                  proposal, team creation) -> first delegation -> first
//                  skill. Every step verified from DISK (agent files, state
//                  flips, skill files), never from UI optimism.
//   VAULT IMPORTER structured folder WITHOUT CLAUDE.md -> must be analysed,
//                  never scaffolded over (the PARA-pollution incident, twice
//                  re-raised, stays fixed).
//
// The Daily Driver journey (delegation chains, handbacks, permissions,
// boundary) lives in run.mjs as the S-step suite; together the two scripts
// are the persona stage. Both gate every candidate via the release gate.
//
// Usage:
//   node scripts/smoke/personas.mjs           # stub runtime: deterministic, free
//   node scripts/smoke/personas.mjs --live    # New User onboarding with a REAL
//                                             # model, spend measured and bounded
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIVE = process.argv.includes('--live');
const BASE_PORT = Number(process.env.SMOKE_PORT || 3651);

// Live-spend bounds: the journey is budgeted, not open-ended. Turn count and
// wall clock are HARD limits; the run fails rather than exceeding them, and
// actual spend is printed at the end.
const LIVE_MAX_TURNS = 8;
const LIVE_BUDGET_MS = 15 * 60 * 1000;
let liveTurnsUsed = 0;
let liveStartedAt = 0;

const results = [];
function record(step, ok, detail) {
  results.push({ step, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? `  (${detail})` : ''}`);
}

async function waitFor(pred, timeout = 30000, interval = 200) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() >= deadline) return null;
    await new Promise(r => setTimeout(r, interval));
  }
}

function readState(workspace) {
  try { return JSON.parse(fs.readFileSync(path.join(workspace, '.rundock', 'state.json'), 'utf8')); }
  catch { return {}; }
}

// ── App lifecycle: one server + one Chromium page per persona ───────────
let portCounter = 0;
async function withApp(workspace, scenario, fn) {
  const port = BASE_PORT + (portCounter++);
  if (!LIVE && scenario) {
    fs.writeFileSync(path.join(workspace, 'stub-scenario.json'), JSON.stringify(scenario, null, 2));
  }
  const stubPath = LIVE ? '' : `${path.join(ROOT, 'test', 'helpers', 'stub-claude')}${path.delimiter}${path.join(ROOT, 'test', 'helpers', 'stub-codex')}${path.delimiter}`;
  const env = { ...process.env, WORKSPACE: workspace, PORT: String(port), PATH: `${stubPath}${process.env.PATH}` };
  if (!LIVE) env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'personas-home-'));
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  server.stdout.on('data', d => { serverLog += d; });
  server.stderr.on('data', d => { serverLog += d; });

  const up = await waitFor(async () => {
    try { const r = await fetch(`http://127.0.0.1:${port}/`); return r.ok; } catch { return false; }
  }, 15000);
  if (!up) {
    record(`${path.basename(workspace)} server boots`, false);
    console.log(serverLog.slice(-2000));
    server.kill();
    return;
  }

  const { chromium } = require('@playwright/test');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForTimeout(1500);
  try {
    await fn({ page, port, serverLogTail: () => serverLog.slice(-1500) });
  } catch (err) {
    record('persona journey aborted', false, err.message);
  } finally {
    await browser.close();
    server.kill();
  }
}

function readEvents(workspace) {
  const dir = path.join(workspace, '.rundock', 'state');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!/^events-.*\.jsonl$/.test(f)) continue;
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (line.trim()) { try { out.push(JSON.parse(line)); } catch { /* skip */ } }
    }
  }
  return out;
}
const turnCount = (workspace) => readEvents(workspace).filter(e => e.e === 'turn').length;

// A real model takes minutes per onboarding turn; fixed DOM timeouts guess.
// The disk is the truth: a `turn` event lands when any agent turn completes,
// so each send waits for the turn count to advance before the journey moves.
const TURN_TIMEOUT = LIVE ? 300000 : 45000;
async function sendAndWaitTurn(page, workspace, text, { timeout = TURN_TIMEOUT, approveCards = false } = {}) {
  if (LIVE) {
    liveTurnsUsed++;
    if (liveTurnsUsed > LIVE_MAX_TURNS) throw new Error(`live turn budget exceeded (${LIVE_MAX_TURNS})`);
    if (Date.now() - liveStartedAt > LIVE_BUDGET_MS) throw new Error(`live wall-clock budget exceeded (${LIVE_BUDGET_MS / 1000}s)`);
  }
  const before = turnCount(workspace);
  await page.fill('#msg-input', text);
  await page.click('#send-btn');
  const done = await waitFor(async () => {
    // A real user answers permission cards that appear mid-turn; a turn
    // stalled on an unanswered card would otherwise read as "slow model".
    if (approveCards) {
      const allow = page.locator('.permission-card .btn-allow').first();
      if (await allow.isVisible().catch(() => false)) {
        console.log('      (approved a permission card mid-turn)');
        await allow.click().catch(() => {});
      }
    }
    return turnCount(workspace) > before;
  }, timeout, 500);
  return !!done;
}

// On a live failure, the conversation tail is the diagnosis: print it.
async function dumpTail(page, label) {
  try {
    const bubbles = await page.locator('.msg-bubble').allTextContents();
    console.log(`--- ${label}: last bubbles ---`);
    for (const b of bubbles.slice(-3)) console.log(`  | ${b.slice(0, 400).replace(/\n/g, ' ')}`);
  } catch { /* diagnosis is best-effort */ }
}

// ── NEW USER: the journey four post-cut discoveries sat on ──────────────
async function newUserPersona() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-new-user-'));
  // The app boots from a PREVIOUS workspace and the user picks the new empty
  // folder through the picker path: selecting the current workspace again
  // takes the client's reconnect branch and skips first-run routing, which
  // is not the journey a new user walks.
  const previous = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-previous-'));
  fs.writeFileSync(path.join(previous, 'CLAUDE.md'), '# Previous workspace\n');
  for (const f of ['a.md', 'b.md', 'c.md']) fs.writeFileSync(path.join(previous, f), '# note\n');

  // The stub Doc plays the scripted onboarding beats; every claim it makes
  // is verified on disk, so a scripted Doc cannot fake a working product.
  const scenario = { rules: [
    { match: { agent: 'rundock-guide', promptIncludes: '[WORKSPACE_ANALYSIS]' },
      realStream: true,
      turn: [{ text: 'Welcome to your new workspace! I am Doc. What is your name, and what will you use this workspace for?' }] },
    { match: { agent: 'rundock-guide', promptIncludes: 'PERSONA-NU my name is Smokey' },
      realStream: true,
      turn: [{ text: 'Great to meet you, Smokey. Your workspace has numbered folders for notes, projects, resources and archive. Here is my team proposal: Cos: Chief of Staff, and Scout: Researcher. Shall I create them?' }] },
    { match: { agent: 'rundock-guide', promptIncludes: 'PERSONA-NU yes create the team' },
      realStream: true,
      turn: [{ text: 'Creating your team now. <!-- RUNDOCK:SAVE_AGENT name=chief-of-staff -->\n---\nname: chief-of-staff\ndisplayName: Cos\nrole: Chief of Staff\ntype: orchestrator\norder: 0\nmodel: sonnet\n---\nYou are Cos, Smokey\'s Chief of Staff.<!-- /RUNDOCK:SAVE_AGENT --> <!-- RUNDOCK:SAVE_AGENT name=scout -->\n---\nname: scout\ndisplayName: Scout\nrole: Researcher\ntype: specialist\norder: 2\nreportsTo: chief-of-staff\nmodel: sonnet\n---\nYou are Scout, the researcher.<!-- /RUNDOCK:SAVE_AGENT --> Your team is ready. Start a conversation with Cos.' }] },
    { match: { agent: 'rundock-guide', promptIncludes: 'PERSONA-NU create a skill' },
      realStream: true,
      turn: [{ text: 'Done. <!-- RUNDOCK:SAVE_SKILL name=daily-summary -->\n---\nname: Daily Summary\ndescription: Summarise the day\n---\n# Daily Summary\n\nSummarise the day in three bullets.<!-- /RUNDOCK:SAVE_SKILL --> The skill is saved.' }] },
    { match: { agent: 'chief-of-staff', promptIncludes: 'PERSONA-NU ask scout' },
      realStream: true,
      turn: [
        { text: 'Handing this to Scout.' },
        { agentTool: { subagent_type: 'scout', prompt: 'PERSONA-NU research brief for scout' } },
      ] },
    { match: { agent: 'scout', promptIncludes: 'PERSONA-NU research brief' },
      realStream: true,
      turn: [{ text: 'PERSONA-NU-SCOUT-REPLY: research done.' }] },
    { match: { promptIncludes: '[SYSTEM' }, turn: [{ text: '<silent>' }] },
  ] };

  if (!LIVE) {
    fs.writeFileSync(path.join(workspace, 'stub-scenario.json'), JSON.stringify(scenario, null, 2));
  }

  await withApp(previous, scenario, async ({ page }) => {
    // Choose the empty folder THROUGH the picker path (selectWorkspace is
    // exactly what the folder picker calls): scaffolding happens on
    // workspace selection, not on server boot, and the persona walks the
    // user's actual road.
    await page.evaluate((d) => window.selectWorkspace(d), workspace);
    const scaffolded = await waitFor(() => fs.existsSync(path.join(workspace, 'CLAUDE.md')), 15000);
    record('NEW-USER empty folder gets scaffolded (CLAUDE.md on disk)', !!scaffolded);
    record('NEW-USER scaffold marks setup pending', readState(workspace).setupComplete === false);
    record('NEW-USER platform guide agent installed', fs.existsSync(path.join(workspace, '.claude', 'agents', 'rundock-guide.md')));

    // Onboarding must be reachable the way a new user reaches it: either
    // Doc speaks first unprompted, or the product presents a single
    // "Set up your team" call to action. Anything else strands the user.
    const greeting = () => page.locator('.msg-bubble', { hasText: LIVE ? /./ : 'What is your name' }).count().then(c => c > 0);
    const cta = page.locator('button', { hasText: 'Set up your team' }).first();
    const entry = await waitFor(async () => (await greeting()) ? 'self-start' : ((await cta.isVisible().catch(() => false)) ? 'cta' : null), 30000);
    record('NEW-USER onboarding reachable (self-start or one visible CTA)', !!entry, entry || '');
    if (entry === 'cta') await cta.click();
    // Doc's opening turn is a real model turn in live mode: wait on the
    // events log, not a DOM guess.
    const opened = await waitFor(() => turnCount(workspace) >= 1, TURN_TIMEOUT, 500) && await waitFor(greeting, 15000);
    record('NEW-USER Doc opens the onboarding conversation', !!opened);
    if (!opened && LIVE) await dumpTail(page, 'opening');

    // The journey walks Doc's DESIGNED beats: Beat 0 (name/purpose), Beat 1
    // (folder orientation), Beat 2 (proposal), confirm. A script that tries
    // to skip a beat is testing a journey no user is offered. Assertions
    // look at AGENT bubbles only: the persona's own messages echo the words
    // it is waiting for.
    const agentBubble = (text) => page.locator('.msg-agent .msg-bubble', { hasText: text }).count().then(c => c > 0);

    const beat0Turn = await sendAndWaitTurn(page, workspace, LIVE
      ? 'PERSONA-NU my name is Smokey and this workspace is for testing Rundock. Keep every reply brief.'
      : 'PERSONA-NU my name is Smokey, testing my new workspace');
    record('NEW-USER Doc answers Beat 0', !!beat0Turn);

    if (LIVE) {
      // Beat 1 ack -> Beat 2 proposal.
      const proposalTurn = await sendAndWaitTurn(page, workspace,
        'PERSONA-NU the folders look good. Propose a minimal two-agent team now: an orchestrator called Cos and one researcher called Scout. Brief.');
      const proposal = proposalTurn && await waitFor(() => agentBubble(/Cos/i), 15000);
      record('NEW-USER Doc proposes the team (agent bubble names Cos)', !!proposal);
      if (!proposal) await dumpTail(page, 'proposal');
    } else {
      const proposal = await waitFor(() => agentBubble('Shall I create them'), 15000);
      record('NEW-USER Doc proposes the team (agent bubble names Cos)', !!proposal);
    }

    // Confirm -> agents must land ON DISK and setup must flip complete.
    // The creation turn does real work (files, roster) and gets the longest
    // ceiling; any permission card it raises is answered like a user would.
    const confirmTurn = await sendAndWaitTurn(page, workspace, LIVE
      ? 'PERSONA-NU yes create the team now, exactly as proposed, using your agent creation markers. Do not ask anything else.'
      : 'PERSONA-NU yes create the team',
      { timeout: LIVE ? 480000 : 45000, approveCards: true });
    if (!confirmTurn) record('NEW-USER creation turn completed within budget', false);
    const cosFile = await waitFor(() => fs.existsSync(path.join(workspace, '.claude', 'agents', 'chief-of-staff.md')), 30000);
    record('NEW-USER confirming creates the orchestrator file on disk', !!cosFile);
    if (!cosFile && LIVE) await dumpTail(page, 'creation');
    const scoutFile = await waitFor(() => {
      const dir = path.join(workspace, '.claude', 'agents');
      return fs.readdirSync(dir).filter(f => f.endsWith('.md') && !/^rundock-/.test(f)).length >= 2;
    }, LIVE ? 60000 : 45000);
    record('NEW-USER the specialist file lands too', !!scoutFile);
    const flipped = await waitFor(() => readState(workspace).setupComplete === true, 30000);
    record('NEW-USER setup flips complete when the team joins', !!flipped);

    // First delegation in the fresh workspace (stub mode only: the live
    // journey spends its budget on onboarding, and the daily-driver live
    // delegation already covers real-model delegation end to end).
    if (!LIVE) {
      await page.evaluate(() => window.startConversation('chief-of-staff'));
      await page.waitForTimeout(500);
      await sendAndWaitTurn(page, workspace, 'PERSONA-NU ask scout to research something');
      const delegated = await waitFor(() => page.locator('.msg-bubble', { hasText: 'PERSONA-NU-SCOUT-REPLY' }).count().then(c => c > 0), 45000);
      record('NEW-USER first delegation works in the fresh workspace', !!delegated);

      // First skill: Doc saves it, the file exists where skills live.
      await page.evaluate(() => window.startConversation('rundock-guide'));
      await page.waitForTimeout(500);
      await sendAndWaitTurn(page, workspace, 'PERSONA-NU create a skill for daily summaries');
      const skillFile = await waitFor(() => fs.existsSync(path.join(workspace, '.claude', 'skills', 'daily-summary', 'SKILL.md')), 45000);
      record('NEW-USER first skill lands on disk', !!skillFile);
    }
  });
}

// ── VAULT IMPORTER: a structured vault must never be scaffolded over ────
async function vaultImporterPersona() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-vault-'));
  // A real-shaped Obsidian vault: structure, notes, no CLAUDE.md.
  for (const dir of ['Daily Notes', 'Projects/Alpha', 'Reference']) {
    fs.mkdirSync(path.join(workspace, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(workspace, 'Daily Notes', '2026-08-11.md'), '# Today\n\nNotes.\n');
  fs.writeFileSync(path.join(workspace, 'Projects', 'Alpha', 'plan.md'), '# Alpha plan\n');
  fs.writeFileSync(path.join(workspace, 'Reference', 'reading.md'), '# Reading list\n');

  const scenario = { rules: [
    { match: { promptIncludes: '[SYSTEM' }, turn: [{ text: '<silent>' }] },
  ] };

  await withApp(workspace, scenario, async ({ page }) => {
    await page.waitForTimeout(2500);
    const scaffoldFolders = fs.readdirSync(workspace).filter(f => /^[0-4] /.test(f));
    record('VAULT-IMPORTER no scaffold folders imposed on a structured vault', scaffoldFolders.length === 0,
      scaffoldFolders.length ? `imposed: ${scaffoldFolders.join(', ')}` : '');
    record('VAULT-IMPORTER no CLAUDE.md written uninvited', !fs.existsSync(path.join(workspace, 'CLAUDE.md')));
    record('VAULT-IMPORTER user files untouched', fs.existsSync(path.join(workspace, 'Projects', 'Alpha', 'plan.md')));
    // The app must still be usable: the file tree shows the vault's real
    // structure rather than an empty or scaffold-shaped one.
    const tree = await waitFor(() => page.locator('#file-tree, .file-tree').first().textContent().then(t => t && t.includes('Projects')).catch(() => false), 15000);
    record('VAULT-IMPORTER file tree shows the vault structure', !!tree);
  });
}

// ── Run ─────────────────────────────────────────────────────────────────
if (LIVE) liveStartedAt = Date.now();

await newUserPersona();
if (!LIVE) await vaultImporterPersona();

const failed = results.filter(r => !r.ok);
const spend = LIVE ? `  live spend: ${liveTurnsUsed} turns, ${Math.round((Date.now() - liveStartedAt) / 1000)}s wall clock (bounds: ${LIVE_MAX_TURNS} turns, ${LIVE_BUDGET_MS / 1000}s)` : '';
console.log(`\n${results.length - failed.length}/${results.length} persona checks passed${LIVE ? ' (live mode)' : ''}${spend}`);
process.exit(failed.length ? 1 : 0);
