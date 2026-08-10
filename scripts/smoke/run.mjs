#!/usr/bin/env node
'use strict';
// Release-candidate smoke: drive the REAL app (served client in a real
// Chromium) against the REAL server from source, and verify every step from
// disk artifacts (events log, created files), not from UI optimism.
//
// Why this exists: the stub harness can validate a bug. The 0.11.6 draft
// shipped with delegation interception dead on real streams while 1,300
// stub-shaped tests stayed green, because the stub modelled the stream
// wrong. This smoke closes that class two ways: the stub scenarios here run
// with realStream: true (the captured production end-of-message shape, so
// breaking the message_stop decision point fails S2), and --live replaces
// the stub with the real CLI and a real model for the delegation step.
//
// Usage:
//   npm run smoke            # deterministic: stub runtime, all steps, no spend
//   npm run smoke -- --live  # adds one real-model delegation turn (real CLI on PATH)
//
// Run it against a release candidate BEFORE tagging. Every step prints
// PASS/FAIL; exit code is non-zero on any failure.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIVE = process.argv.includes('--live');
const PORT = Number(process.env.SMOKE_PORT || 3641);

const results = [];
function record(step, ok, detail) {
  results.push({ step, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? `  (${detail})` : ''}`);
}

// ── Workspace: the common real shape. Roo is order 0 (so id `default`), Kit
// deliberately has NO reportsTo (the membership rule must make him delegable
// anyway), Vox reports explicitly.
function buildWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-smoke-'));
  const agents = path.join(dir, '.claude', 'agents');
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, 'roo.md'),
    '---\nname: roo\ndisplayName: Roo\nrole: Chief of Staff\ntype: orchestrator\norder: 0\nmodel: sonnet\n---\nYou are Roo, the orchestrator. Route work to the team.\n');
  fs.writeFileSync(path.join(agents, 'kit.md'),
    '---\nname: kit\ndisplayName: Kit\nrole: Customer Support\ntype: specialist\norder: 2\nmodel: sonnet\n---\nYou are Kit, customer support.\n');
  fs.writeFileSync(path.join(agents, 'vox.md'),
    '---\nname: vox\ndisplayName: Vox\nrole: Content Writer\ntype: specialist\norder: 3\nreportsTo: roo\nmodel: sonnet\n---\nYou are Vox, the content writer. LinkedIn posts only.\n');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Smoke Workspace\n\nA disposable release-candidate smoke workspace.\n');
  return dir;
}

function writeScenario(dir) {
  // realStream: true on every turn that must intercept: the production
  // end-of-message shape (message_delta + message_stop, no trailing
  // assistant envelope) is the whole point of this suite.
  fs.writeFileSync(path.join(dir, 'stub-scenario.json'), JSON.stringify({ rules: [
    { match: { agent: 'roo', promptIncludes: 'SMOKE-S1 direct turn' },
      turn: [{ text: 'SMOKE-S1-REPLY: direct turn works.' }] },
    { match: { agent: 'roo', promptIncludes: 'SMOKE-S2 delegate to kit' },
      realStream: true,
      turn: [
        { text: 'Handing to Kit.' },
        { agentTool: { subagent_type: 'kit', prompt: 'SMOKE-S2 brief for kit' } },
      ] },
    { match: { agent: 'kit', promptIncludes: 'SMOKE-S2 brief for kit' },
      turn: [{ text: 'SMOKE-S2-KIT-REPLY: Kit handled it.' }] },
    { match: { agent: 'roo', promptIncludes: 'SMOKE-S3 ask doc' },
      realStream: true,
      turn: [
        { text: 'Handing to Doc.' },
        { agentTool: { subagent_type: 'rundock-guide', prompt: 'SMOKE-S3 create smokey' } },
      ] },
    { match: { agent: 'rundock-guide', promptIncludes: 'SMOKE-S3 create smokey' },
      turn: [{ text: 'Created the agent. <!-- RUNDOCK:SAVE_AGENT name=smokey -->\n---\nname: smokey\ndisplayName: Smokey\nrole: Smoke Agent\ntype: specialist\norder: 9\nreportsTo: roo\n---\nYou are Smokey.<!-- /RUNDOCK:SAVE_AGENT --> <!-- RUNDOCK:COMPLETE -->' }] },
    { match: { agent: 'vox', promptIncludes: 'SMOKE-S4 refund question' },
      realStream: true,
      turn: [{ text: 'Outside my lane, handing back. <!-- RUNDOCK:RETURN -->' }] },
    { match: { promptIncludes: '[SYSTEM' },
      turn: [{ text: '<silent>' }] },
  ] }, null, 2));
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

async function waitFor(pred, timeout = 30000, interval = 200) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() >= deadline) return null;
    await new Promise(r => setTimeout(r, interval));
  }
}

// ── Boot ────────────────────────────────────────────────────────────────
const workspace = buildWorkspace();
if (!LIVE) writeScenario(workspace);
const stubPath = LIVE ? '' : `${path.join(ROOT, 'test', 'helpers', 'stub-claude')}${path.delimiter}${path.join(ROOT, 'test', 'helpers', 'stub-codex')}${path.delimiter}`;
const env = { ...process.env, WORKSPACE: workspace, PORT: String(PORT), PATH: `${stubPath}${process.env.PATH}` };
if (!LIVE) env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-smoke-home-'));
const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', d => { serverLog += d; });
server.stderr.on('data', d => { serverLog += d; });

const up = await waitFor(async () => {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/`); return r.ok; } catch { return false; }
}, 15000);
record('S0 server boots from source', !!up);
if (!up) { console.log(serverLog.slice(-2000)); process.exit(1); }

const { chromium } = require('@playwright/test');
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${PORT}/`);
await page.waitForTimeout(1500);

async function sendInNewConversation(text) {
  await page.evaluate(() => window.newConversation());
  await page.waitForTimeout(300);
  await page.fill('#msg-input', text);
  await page.click('#send-btn');
}

// ── S1: direct turn ─────────────────────────────────────────────────────
await sendInNewConversation('SMOKE-S1 direct turn please');
const s1 = await waitFor(() => page.locator('.msg-bubble', { hasText: 'SMOKE-S1-REPLY' }).count().then(c => c > 0));
record('S1 direct orchestrator turn renders a reply', !!s1);
const s1ev = await waitFor(() => readEvents(workspace).some(e => e.e === 'turn'));
record('S1 turn event recorded', !!s1ev);

// ── S2: intercepted delegation on the production stream shape ───────────
await sendInNewConversation('SMOKE-S2 delegate to kit please');
const s2 = await waitFor(() => page.locator('.msg-bubble', { hasText: 'SMOKE-S2-KIT-REPLY' }).count().then(c => c > 0), 45000);
record('S2 delegation intercepts on realStream shape and the delegate answers', !!s2);
const s2ev = readEvents(workspace).find(e => e.e === 'delegation_start' && e.d && e.d.to === 'kit' && e.d.intercepted === true);
record('S2 delegation_start event (to kit, intercepted)', !!s2ev);
const s2blocked = await page.locator('text=Blocked a handoff').count();
record('S2 no off-roster block for the reportsTo-less specialist', s2blocked === 0);

// ── S3: platform CRUD end to end (marker scan is CLIENT code) ───────────
await sendInNewConversation('SMOKE-S3 ask doc to create smokey');
const s3file = await waitFor(() => fs.existsSync(path.join(workspace, '.claude', 'agents', 'smokey.md')), 45000);
record('S3 Doc SAVE_AGENT marker creates the file on disk', !!s3file);
const s3pill = await waitFor(() => page.locator('text=Agent "smokey" created').count().then(c => c > 0), 10000);
record('S3 created pill renders', !!s3pill);
const s3leak = await page.locator('#messages >> text=displayName: Smokey').count();
record('S3 marker payload never renders as message text', s3leak === 0);

// ── S4: scope return restores the orchestrator ──────────────────────────
await page.evaluate(() => window.startConversation('vox'));
await page.waitForTimeout(300);
await page.fill('#msg-input', 'SMOKE-S4 refund question for you');
await page.click('#send-btn');
const s4 = await waitFor(() => readEvents(workspace).some(e => e.e === 'handback' && e.d && e.d.kind === 'return' && e.agent === 'vox'), 45000);
record('S4 specialist scope return hands back (handback event, kind return)', !!s4);

// ── S5: both permission paths, as designed ──────────────────────────────
// Low-risk read-only commands are AUTO-APPROVED by the client's risk policy
// (permissions.js): no card, silent allow. High-risk commands must card and
// wait for a click. Both behaviours are product contract; both are checked.
const lowP = fetch(`http://127.0.0.1:${PORT}/api/permission-request`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo smoke' }, conversation_id: '', session_id: '' }),
}).then(r => r.json()).catch(() => null);
const lowResult = await Promise.race([lowP, new Promise(r => setTimeout(() => r(null), 15000))]);
record('S5 low-risk command auto-approves without a card', !!(lowResult && lowResult.allow === true));

const highP = fetch(`http://127.0.0.1:${PORT}/api/permission-request`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf build && git push --force' }, conversation_id: '', session_id: '' }),
}).then(r => r.json()).catch(() => null);
const allowBtn = await waitFor(() => page.locator('.permission-card .btn-allow').first().isVisible().catch(() => false), 15000);
record('S5 high-risk command shows the permission card', !!allowBtn);
if (allowBtn) await page.locator('.permission-card .btn-allow').first().click();
const highResult = await Promise.race([highP, new Promise(r => setTimeout(() => r(null), 15000))]);
record('S5 clicking Allow resolves the hook request', !!(highResult && highResult.allow === true));
const s5ev = readEvents(workspace).some(e => e.e === 'permission' && e.d && e.d.decision === 'allow');
record('S5 permission event recorded', s5ev);

// ── S6: the events log is skinny ────────────────────────────────────────
const leak = readEvents(workspace).some(e => JSON.stringify(e).includes('SMOKE-S1 direct turn'));
record('S6 events log carries structure, never message content', !leak);

// ── LIVE (optional): one real-model delegation turn ─────────────────────
if (LIVE) {
  await sendInNewConversation('Ask Kit to draft a one-line reply to a customer asking about refunds. Delegate to Kit now.');
  const liveOk = await waitFor(() => readEvents(workspace).some(e => e.e === 'delegation_start' && e.d && e.d.intercepted === true), 180000, 1000);
  record('LIVE real-model delegation intercepts end to end', !!liveOk);
}

await browser.close();
server.kill();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${LIVE ? ' (live mode)' : ''}`);
if (failed.length) { console.log('Server log tail:\n' + serverLog.slice(-1500)); process.exit(1); }
