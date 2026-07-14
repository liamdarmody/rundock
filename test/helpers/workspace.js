'use strict';
// Temp-workspace fixture builder for the test suite.
// Creates disposable workspace directories under os.tmpdir() and registers
// them for cleanup. Never touches the repo or the user's real workspaces.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const created = [];

function makeTempDir(prefix = 'rundock-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/**
 * Build a workspace directory.
 * @param {object} opts
 * @param {Object<string,string>} [opts.agents] - slug -> agent .md content
 * @param {Object<string,string>} [opts.skills] - slug -> SKILL.md content
 * @param {string|null} [opts.claudeMd] - CLAUDE.md content (null = none)
 * @param {Object<string,string>} [opts.files] - relative path -> content
 */
function makeWorkspace(opts = {}) {
  const dir = makeTempDir();
  if (opts.agents) {
    const agentsDir = path.join(dir, '.claude', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    for (const [slug, content] of Object.entries(opts.agents)) {
      fs.writeFileSync(path.join(agentsDir, `${slug}.md`), content);
    }
  }
  if (opts.skills) {
    for (const [slug, content] of Object.entries(opts.skills)) {
      const skillDir = path.join(dir, '.claude', 'skills', slug);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content);
    }
  }
  if (opts.claudeMd) {
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), opts.claudeMd);
  }
  if (opts.files) {
    for (const [rel, content] of Object.entries(opts.files)) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  }
  return dir;
}

// Standard team used across suites: one orchestrator, one lead with a direct
// report, two plain specialists. Mirrors the shape of a real Rundock workspace.
function agentFile({ name, displayName, role, type, order, reportsTo, model, runtime, description, prompts, routines, skills, capabilities, body }) {
  const lines = ['---', `name: ${name}`];
  if (displayName) lines.push(`displayName: ${displayName}`);
  if (role) lines.push(`role: ${role}`);
  if (description) lines.push(`description: ${description}`);
  if (type) lines.push(`type: ${type}`);
  if (order !== undefined) lines.push(`order: ${order}`);
  if (reportsTo) lines.push(`reportsTo: ${reportsTo}`);
  if (model) lines.push(`model: ${model}`);
  if (runtime) lines.push(`runtime: ${runtime}`);
  if (capabilities) {
    lines.push('capabilities:');
    for (const [k, v] of Object.entries(capabilities)) lines.push(`  ${k}: ${v}`);
  }
  if (prompts) {
    lines.push('prompts:');
    for (const p of prompts) lines.push(`  - "${p}"`);
  }
  if (skills) {
    lines.push('skills:');
    for (const s of skills) lines.push(`  - ${s}`);
  }
  if (routines) {
    lines.push('routines:');
    for (const r of routines) {
      lines.push(`  - name: ${r.name}`);
      if (r.schedule) lines.push(`    schedule: ${r.schedule}`);
      if (r.prompt) lines.push(`    prompt: ${r.prompt}`);
    }
  }
  lines.push('---', '');
  lines.push(body || `You are ${displayName || name}. ${role || ''}`);
  lines.push('');
  return lines.join('\n');
}

function standardTeam() {
  return {
    'chief-of-staff': agentFile({
      name: 'chief-of-staff', displayName: 'Cos', role: 'Chief of Staff',
      description: 'Chief orchestrator', type: 'orchestrator', order: 1,
      body: 'You are Cos, the orchestrator.\n\nRoute work to specialists.',
    }),
    'content-lead': agentFile({
      name: 'content-lead', displayName: 'Penn', role: 'Content Lead',
      description: 'Owns the content pipeline', type: 'specialist', order: 2,
      reportsTo: 'chief-of-staff',
      body: 'You are Penn, the content lead.\n\nYou own hooks, drafts and audits.',
    }),
    'content-analyst': agentFile({
      name: 'content-analyst', displayName: 'Ana', role: 'Content Analyst',
      description: 'Analyses content performance', type: 'specialist', order: 3,
      reportsTo: 'content-lead',
      body: 'You are Ana, the content analyst.\n\nYou analyse performance data.',
    }),
    'lead-designer': agentFile({
      name: 'lead-designer', displayName: 'Des', role: 'Lead Designer',
      description: 'Visual design', type: 'specialist', order: 4,
      reportsTo: 'chief-of-staff',
      body: 'You are Des, the lead designer.\n\nYou make visuals.',
    }),
  };
}

function cleanup() {
  for (const dir of created.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  }
}

module.exports = { makeTempDir, makeWorkspace, agentFile, standardTeam, cleanup };
