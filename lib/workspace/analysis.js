'use strict';
// Workspace analysis (the Seven Signals), extracted verbatim from server.js
// as part of the server decomposition. parseSkillFile stays in the root
// (skill discovery has not moved) and arrives through wireAnalysisDeps BY
// IDENTITY; the unwired default throws so a missed wiring fails loudly at
// first use instead of silently reporting a skill-less workspace.
const fs = require('fs');
const path = require('path');
const { readNormalisedFile, discoverAgents } = require('../agents/discovery.js');

const unwired = (name) => () => {
  throw new Error(`lib/workspace/analysis: ${name} not wired (call wireAnalysisDeps at boot)`);
};
const deps = { parseSkillFile: unwired('parseSkillFile') };
function wireAnalysisDeps(next) {
  const prev = { ...deps };
  Object.assign(deps, next);
  return prev;
}

// Reads MCP server names from a workspace's .mcp.json. Returns [] on any problem
// (no dir, missing file, parse error, no mcpServers block). Used by workspace analysis.
function readMcpServerNames(dir) {
  if (!dir) return [];
  try {
    const mcpJsonPath = path.join(dir, '.mcp.json');
    if (!fs.existsSync(mcpJsonPath)) return [];
    const mcpConfig = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
    if (mcpConfig && mcpConfig.mcpServers) return Object.keys(mcpConfig.mcpServers);
  } catch (e) { /* fall through to [] */ }
  return [];
}

// ===== WORKSPACE ANALYSIS (Seven Signals) =====

const SKILL_CLUSTERS = [
  { label: 'Meetings & People', pattern: /meeting|prep|process|granola|attendee|agenda|people|person|contact/i },
  { label: 'Career & Growth', pattern: /career|coach|resume|identity|evidence|promotion|mentor|feedback/i },
  { label: 'Content & Writing', pattern: /content|write|draft|publish|post|blog|newsletter|hook|audit|voice/i },
  { label: 'Research & Analysis', pattern: /research|search|scrape|fetch|crawl|analy|competitor|trend|digest/i },
  { label: 'Code Review', pattern: /code.?review|pr-review|pull.?request|diff|merge|refactor/i },
  { label: 'Build & Deploy', pattern: /lint|ci[-\s]|deploy|compile|bundle|release|docker|\.test|unit.?test|e2e/i },
  { label: 'Project Management', pattern: /project|health|brief|product|roadmap|sprint|backlog|kanban/i },
  { label: 'Planning & Review', pattern: /daily|weekly|quarter|plan|review|goal|priority|standup|retro/i },
  { label: 'System & Setup', pattern: /setup|install|config(?!ure)|dex-update|system-update|reset|health-check|getting-started|migrate/i },
];

function analyzeWorkspace(dir, existingAgents) {
  const analysis = { identity: {}, skills: {}, integrations: {}, structure: {}, userProfile: {}, hooks: {}, agents: {} };

  // --- Signal 1: Identity ---
  const sources = [];
  try {
    const readmePath = path.join(dir, 'README.md');
    if (fs.existsSync(readmePath)) {
      const text = fs.readFileSync(readmePath, 'utf-8');
      const h1 = text.match(/^#\s+(.+)/m);
      const firstPara = text.match(/^#[^\n]+\n+([^\n#]+)/m);
      sources.push({ file: 'README.md', heading: h1 ? h1[1].trim() : null, summary: firstPara ? firstPara[1].trim() : null });
    }
  } catch (e) {}
  try {
    const claudePath = path.join(dir, 'CLAUDE.md');
    if (fs.existsSync(claudePath)) {
      const text = fs.readFileSync(claudePath, 'utf-8');
      const h1 = text.match(/^#\s+(.+)/m);
      const youAre = text.match(/You are (\w+)[,.]?\s*([^.]*)\./);
      sources.push({ file: 'CLAUDE.md', heading: h1 ? h1[1].trim() : null, identity: youAre ? `You are ${youAre[1]}, ${youAre[2]}.` : null });
    }
  } catch (e) {}
  try {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg.name || pkg.description) {
        sources.push({ file: 'package.json', name: pkg.name || null, description: pkg.description || null });
      }
    }
  } catch (e) {}

  // Resolve identity: README > CLAUDE.md > package.json
  let suggestedName = null, suggestedTagline = null, suggestedRole = null;
  const readme = sources.find(s => s.file === 'README.md');
  const claude = sources.find(s => s.file === 'CLAUDE.md');
  const pkg = sources.find(s => s.file === 'package.json');
  if (readme?.heading) {
    // Split a "Name <separator> Tagline" heading into name and tagline. The
    // char class keeps em and en dashes so a dash-separated heading splits too.
    const parts = readme.heading.split(/[—–:|]+/).map(s => s.trim()); // internal-refs-allow
    suggestedName = parts[0]?.split(/\s+/)[0]; // First word of first part
    suggestedTagline = parts[1] || readme.summary;
    suggestedRole = parts[1] || null;
  }
  if (!suggestedName && claude?.identity) {
    const nameMatch = claude.identity.match(/You are (\w+)/);
    if (nameMatch) suggestedName = nameMatch[1];
  }
  if (!suggestedName && pkg?.name) {
    suggestedName = pkg.name.split('-')[0];
    suggestedName = suggestedName.charAt(0).toUpperCase() + suggestedName.slice(1);
  }
  analysis.identity = { sources, suggestedName, suggestedTagline, suggestedRole };

  // --- Signal 2: Skills with Pre-Grouping ---
  const skillSources = [
    { dir: path.join(dir, 'System', 'Playbooks'), defFile: 'PLAYBOOK.md' },
    { dir: path.join(dir, '.claude', 'skills'), defFile: 'SKILL.md' },
  ];
  const allSkills = [];
  for (const src of skillSources) {
    if (!fs.existsSync(src.dir)) continue;
    try {
      // Skip _prefixed (inactive) and anthropic-* (Claude Code built-in document skills)
      const dirs = fs.readdirSync(src.dir, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('_') && !d.name.startsWith('anthropic-'));
      for (const d of dirs) {
        const defPath = path.join(src.dir, d.name, src.defFile);
        if (!fs.existsSync(defPath)) continue;
        try {
          const content = readNormalisedFile(defPath);
          const parsed = deps.parseSkillFile(content, d.name);
          allSkills.push({ id: d.name, name: parsed.displayName, description: parsed.description });
        } catch (e) {}
      }
    } catch (e) {}
  }

  // Group skills by keyword clusters
  const groups = [];
  const grouped = new Set();
  for (const cluster of SKILL_CLUSTERS) {
    const matching = allSkills.filter(s => {
      if (grouped.has(s.id)) return false;
      const text = `${s.id} ${s.name} ${s.description}`.toLowerCase();
      const matches = text.match(cluster.pattern);
      return matches;
    });
    if (matching.length > 0) {
      // Calculate confidence based on match quality
      const slugs = matching.map(s => s.id);
      const highConfidence = matching.filter(s => {
        const text = `${s.id} ${s.name} ${s.description}`.toLowerCase();
        const allMatches = text.match(new RegExp(cluster.pattern.source, 'gi'));
        return allMatches && allMatches.length >= 2;
      });
      groups.push({
        label: cluster.label,
        slugs,
        confidence: highConfidence.length >= matching.length / 2 ? 'high' : 'medium'
      });
      slugs.forEach(s => grouped.add(s));
    }
  }
  // Ungrouped skills
  const ungrouped = allSkills.filter(s => !grouped.has(s.id)).map(s => s.id);
  if (ungrouped.length > 0) {
    groups.push({ label: 'Uncategorised', slugs: ungrouped, confidence: 'low' });
  }
  analysis.skills = { total: allSkills.length, groups, ungrouped, list: allSkills };

  // --- Signal 3: Integrations and MCP Servers ---
  const mcpReferences = [];
  const mentionedTools = [];
  const knownTools = ['Granola', 'ScreenPipe', 'Notion', 'Todoist', 'Slack', 'Linear', 'Jira', 'GitHub', 'Obsidian', 'Raycast', 'AuthoredUp', 'Readwise'];
  try {
    const claudePath = path.join(dir, 'CLAUDE.md');
    if (fs.existsSync(claudePath)) {
      const text = fs.readFileSync(claudePath, 'utf-8');
      const lines = text.split('\n');
      // Extract named MCP servers: match "from X MCP" or "X MCP tools/server" patterns
      // These are the reliable indicators of actual named MCP servers
      const mcpNamePattern = /(?:from|via|using|call|check)\s+(?:the\s+)?(\w[\w\s]*?)\s+MCP\b/gi;
      let mcpMatch;
      while ((mcpMatch = mcpNamePattern.exec(text)) !== null) {
        const rawName = mcpMatch[1].trim();
        // Skip if the "name" is a common verb/article that leaked through
        if (rawName.length < 2 || /^(the|a|an|to|is|it|or|if|my)$/i.test(rawName)) continue;
        const name = rawName + ' MCP';
        if (!mcpReferences.find(m => m.name === name)) {
          mcpReferences.push({ name, context: mcpMatch[0].trim(), source: 'CLAUDE.md' });
        }
      }
      for (const tool of knownTools) {
        if (text.includes(tool) && !mentionedTools.includes(tool)) {
          mentionedTools.push(tool);
        }
      }
    }
  } catch (e) {}

  const configuredServers = readMcpServerNames(dir);
  analysis.integrations = { mcpReferences, configuredServers, mentionedTools };

  // --- Signal 4: Folder Structure with Pattern Detection ---
  let topLevelDirs = [];
  try {
    topLevelDirs = fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .map(d => d.name);
  } catch (e) {}

  let pattern = 'unknown';
  const hasNumbered = topLevelDirs.some(d => /^\d{2}[-_]/.test(d));
  // PARA requires all four core folders: Projects, Areas, Resources, Archive
  const paraCoreNames = ['project', 'area', 'resource', 'archive'];
  const hasPara = paraCoreNames.every(p => topLevelDirs.some(d => d.toLowerCase().includes(p)));
  const hasDev = ['src', 'lib', 'test', 'tests'].filter(d => topLevelDirs.includes(d)).length >= 2;
  const hasFunctional = ['clients', 'marketing', 'finance', 'sales', 'engineering', 'hr'].filter(d =>
    topLevelDirs.some(td => td.toLowerCase() === d)
  ).length >= 2;

  if (hasNumbered && hasPara) pattern = 'para-numbered';
  else if (hasPara) pattern = 'para';
  else if (hasDev) pattern = 'dev-project';
  else if (hasFunctional) pattern = 'functional';
  else if (topLevelDirs.length <= 3) pattern = 'minimal';

  // Key path detection
  const keyPaths = {};
  const allDirs = [...topLevelDirs];
  // Also scan second-level dirs for key paths
  for (const td of topLevelDirs) {
    try {
      const subs = fs.readdirSync(path.join(dir, td), { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => `${td}/${d.name}`);
      allDirs.push(...subs);
    } catch (e) {}
  }
  for (const d of allDirs) {
    const lower = d.toLowerCase();
    if (!keyPaths.inbox && (lower.includes('inbox') || lower.includes('capture'))) keyPaths.inbox = d + '/';
    if (!keyPaths.projects && lower.includes('project')) keyPaths.projects = d + '/';
    if (!keyPaths.tasks && lower.includes('task')) keyPaths.tasks = d + '/';
    if (!keyPaths.people && lower.includes('people')) keyPaths.people = d + '/';
    if (!keyPaths.areas && lower.match(/area/)) keyPaths.areas = d + '/';
    if (!keyPaths.archive && lower.includes('archive')) keyPaths.archive = d + '/';
    if (!keyPaths.system && (lower === 'system' || lower === 'config')) keyPaths.system = d + '/';
  }
  analysis.structure = {
    topLevelDirs,
    pattern,
    keyPaths,
    hasClaudeDir: fs.existsSync(path.join(dir, '.claude')),
    hasAgentsDir: fs.existsSync(path.join(dir, '.claude', 'agents')),
    hasSkillsDir: fs.existsSync(path.join(dir, '.claude', 'skills'))
  };

  // --- Signal 5: User Profile and Configuration ---
  const profilePaths = ['user-profile.yaml', 'profile.yaml', 'config.yaml', 'System/user-profile.yaml', 'System/config.yaml'];
  let userProfile = { exists: false, file: null, populated: false, fields: {} };
  for (const p of profilePaths) {
    try {
      const fullPath = path.join(dir, p);
      if (fs.existsSync(fullPath)) {
        const text = fs.readFileSync(fullPath, 'utf-8');
        const fields = {};
        for (const field of ['name', 'role', 'roleGroup', 'company', 'email']) {
          const match = text.match(new RegExp(`^${field}:\\s*(.+)`, 'm'));
          fields[field] = match ? match[1].trim().replace(/^['"]|['"]$/g, '') : '';
        }
        const populated = Object.values(fields).some(v => v && v.length > 0);
        userProfile = { exists: true, file: p, populated, fields };
        break;
      }
    } catch (e) {}
  }

  // Check for pillars/goals config
  let systemConfig = { pillars: { exists: false }, templates: [] };
  try {
    const pillarPaths = ['pillars.yaml', 'System/pillars.yaml'];
    for (const p of pillarPaths) {
      if (fs.existsSync(path.join(dir, p))) {
        const text = fs.readFileSync(path.join(dir, p), 'utf-8');
        const populated = text.split('\n').filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('---')).length > 3;
        systemConfig.pillars = { exists: true, populated, file: p };
        break;
      }
    }
    // Look for template files
    const sysDir = path.join(dir, 'System');
    if (fs.existsSync(sysDir)) {
      const sysFiles = fs.readdirSync(sysDir);
      systemConfig.templates = sysFiles.filter(f => /template|example/i.test(f));
    }
  } catch (e) {}
  analysis.userProfile = userProfile;
  analysis.systemConfig = systemConfig;

  // --- Signal 6: Hooks and Automation ---
  const hooksResult = { present: [], soundHooks: [], contextHooks: [], automationHooks: [] };
  try {
    const settingsPath = path.join(dir, '.claude', 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (settings.hooks) {
        for (const [event, entries] of Object.entries(settings.hooks)) {
          hooksResult.present.push(event);
          for (const entry of (Array.isArray(entries) ? entries : [])) {
            const hooks = entry.hooks || [entry];
            for (const hook of hooks) {
              if (!hook.command) continue;
              const cmd = hook.command;
              if (/afplay|aplay|paplay|powershell.*audio/i.test(cmd)) {
                const alreadyMuted = cmd.includes('$RUNDOCK');
                hooksResult.soundHooks.push({ event, command: cmd, muted: alreadyMuted });
              } else if (/inject|context/i.test(cmd)) {
                const nameMatch = cmd.match(/\/([\w-]+)\.\w+$/);
                hooksResult.contextHooks.push({ event, matcher: entry.matcher || null, name: nameMatch ? nameMatch[1] : cmd.substring(0, 60) });
              } else if (/session|\.sh|\.py|\.js/i.test(cmd)) {
                hooksResult.automationHooks.push({ event, command: cmd.substring(0, 80) });
              }
            }
          }
        }
      }
    }
  } catch (e) {}
  analysis.hooks = hooksResult;

  // --- Signal 7: Existing Agents ---
  const agentList = existingAgents || discoverAgents();
  const nonPlatform = agentList.filter(a => a.type !== 'platform');
  analysis.agents = {
    total: agentList.length,
    onTeam: nonPlatform.filter(a => a.status === 'onTeam').length,
    available: nonPlatform.filter(a => a.status === 'available').length,
    raw: nonPlatform.filter(a => a.status === 'raw').length,
    hasOrchestrator: agentList.some(a => a.type === 'orchestrator'),
    list: agentList.map(a => ({
      name: a.id, displayName: a.displayName, role: a.role, type: a.type,
      order: a.order, status: a.status
    }))
  };

  return analysis;
}

module.exports = {
  analyzeWorkspace, readMcpServerNames, wireAnalysisDeps,
};
