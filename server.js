/**
 * Rundock Server
 *
 * 1. Discovers agents from .claude/agents/ (including default from CLAUDE.md)
 * 2. Parses capabilities and routines from agent frontmatter
 * 3. Bridges browser <-> Claude Code via WebSocket + stream-json
 * 4. Runs a lightweight scheduler for routines
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const readline = require('readline');

const PORT = process.env.PORT || 3000;
let WORKSPACE = process.env.WORKSPACE || null;

// Pending permission requests from PreToolUse hooks (keyed by requestId).
// Each entry holds the HTTP response object so we can resolve it when the user decides.
const pendingPermissionRequests = new Map();

// Recent workspaces (persisted to disk)
const RECENT_FILE = path.join(__dirname, '.recent-workspaces.json');
function loadRecentWorkspaces() {
  try { return JSON.parse(fs.readFileSync(RECENT_FILE, 'utf-8')); } catch (e) { return []; }
}
function saveRecentWorkspace(dir) {
  const recent = loadRecentWorkspaces().filter(r => r.path !== dir);
  recent.unshift({ path: dir, name: path.basename(dir), lastOpened: new Date().toISOString() });
  fs.writeFileSync(RECENT_FILE, JSON.stringify(recent.slice(0, 10), null, 2));
}

// Rundock session persistence (.rundock/ in workspace root)
function rundockDir() { return path.join(WORKSPACE, '.rundock'); }

function readConversations() {
  try {
    const file = path.join(rundockDir(), 'conversations.json');
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) { return []; }
}

function writeConversations(list) {
  const dir = rundockDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'conversations.json'), JSON.stringify(list, null, 2));
}

function readState() {
  try {
    const file = path.join(rundockDir(), 'state.json');
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) { return {}; }
}

function writeState(state) {
  const dir = rundockDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));
}

// Session history: read Claude Code JSONL transcripts from disk
function getSessionJsonlPath(sessionId) {
  if (!WORKSPACE || !sessionId) return null;
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const projectHash = WORKSPACE.replace(/\//g, '-');
  const jsonlPath = path.join(home, '.claude', 'projects', projectHash, sessionId + '.jsonl');
  if (fs.existsSync(jsonlPath)) return jsonlPath;
  // Fallback: scan project dirs for the session file
  const projectsDir = path.join(home, '.claude', 'projects');
  try {
    for (const dir of fs.readdirSync(projectsDir)) {
      const candidate = path.join(projectsDir, dir, sessionId + '.jsonl');
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch (e) { /* projects dir doesn't exist */ }
  return null;
}

async function parseSessionHistory(sessionId, limit = 20, offset = 0) {
  const filePath = getSessionJsonlPath(sessionId);
  if (!filePath) return { messages: [], totalCount: 0, hasMore: false };

  const displayable = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity
  });

  for await (const line of rl) {
    try {
      const obj = JSON.parse(line);
      // User text messages (not tool results)
      if (obj.type === 'user' && obj.message && typeof obj.message.content === 'string') {
        displayable.push({ role: 'user', content: obj.message.content });
        continue;
      }
      // Assistant messages with text content
      if (obj.message && obj.message.role === 'assistant' && Array.isArray(obj.message.content)) {
        const textParts = obj.message.content
          .filter(b => b.type === 'text' && b.text)
          .map(b => b.text);
        if (textParts.length > 0) {
          displayable.push({ role: 'assistant', content: textParts.join('\n\n') });
        }
      }
    } catch (e) { /* skip unparseable lines */ }
  }

  const totalCount = displayable.length;
  // Return the last `limit` messages, offset from the end
  const start = Math.max(0, totalCount - limit - offset);
  const end = Math.max(0, totalCount - offset);
  const messages = displayable.slice(start, end);
  const hasMore = start > 0;

  return { messages, totalCount, hasMore };
}

// Scan common locations for workspaces (directories with .claude/ or CLAUDE.md)
function discoverWorkspaces() {
  const candidates = [];
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const searchDirs = new Set([
    path.join(home, 'Documents'),
    path.join(home, 'Projects'),
    path.join(home, 'Desktop'),
    home
  ]);

  // Also scan subdirectories of Documents
  try {
    const docsDir = path.join(home, 'Documents');
    if (fs.existsSync(docsDir)) {
      for (const sub of fs.readdirSync(docsDir, { withFileTypes: true })) {
        if (sub.isDirectory() && !sub.name.startsWith('.')) {
          searchDirs.add(path.join(docsDir, sub.name));
        }
      }
    }
  } catch (e) {}

  for (const searchDir of [...searchDirs]) {
    try {
      if (!fs.existsSync(searchDir)) continue;
      const items = fs.readdirSync(searchDir, { withFileTypes: true });
      for (const item of items) {
        if (!item.isDirectory() || item.name.startsWith('.') || item.name === 'node_modules') continue;
        const fullPath = path.join(searchDir, item.name);
        const hasClaude = fs.existsSync(path.join(fullPath, '.claude')) || fs.existsSync(path.join(fullPath, 'CLAUDE.md'));
        if (hasClaude) {
          // Check if it has Rundock-ready agents
          const agentsDir = path.join(fullPath, '.claude', 'agents');
          let agentCount = 0;
          let hasRundockFrontmatter = false;
          try {
            const agentFiles = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'));
            agentCount = agentFiles.length;
            for (const af of agentFiles) {
              const content = fs.readFileSync(path.join(agentsDir, af), 'utf-8');
              if (content.includes('type:') && content.includes('order:')) { hasRundockFrontmatter = true; break; }
            }
          } catch (e) {}
          candidates.push({ path: fullPath, name: item.name, agentCount, hasRundockFrontmatter });
        }
      }
    } catch (e) {}
  }
  return candidates;
}

// ===== ROUTINE STATE (in-memory) =====

const routineState = {}; // { routineKey: { lastRun, status, duration } }

// ===== AGENT HELPERS =====

function validateAgentSlug(name) {
  return typeof name === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(name) && name.length <= 60 && !name.includes('..');
}

// ===== SYSTEM PROMPT BUILDER =====

// Flag all active orchestrator processes for roster refresh on next message.
// Called after agent/skill CRUD so the orchestrator respawns with an updated team roster.
// Uses chatProcesses (global Map declared later) via late binding.
function flagRosterRefresh() {
  if (typeof chatProcesses === 'undefined') return;
  const agentList = discoverAgents();
  for (const [convoId, entry] of chatProcesses) {
    if (entry.exited) continue;
    // Flag active delegate entries so server-side auto-return knows CRUD happened
    if (entry.delegation) {
      entry.crudHappened = true;
      // Flag the parked orchestrator for roster refresh on resume
      const orchEntry = entry.delegation.originalEntry;
      if (orchEntry) orchEntry.needsRosterRefresh = true;
      console.log(`[Roster] Flagged convo=${convoId} for roster refresh (delegate active)`);
    } else {
      // Non-delegate: check if this is an orchestrator that needs flagging
      const agentData = agentList.find(a => a.id === entry.agentId);
      if (agentData && agentData.type === 'orchestrator') {
        entry.needsRosterRefresh = true;
        console.log(`[Roster] Flagged convo=${convoId} for roster refresh`);
      }
    }
  }
}

function buildTeamRoster(orchestratorId) {
  const allAgents = discoverAgents();
  const allSkills = discoverSkills(allAgents);
  const teammates = allAgents.filter(a => a.status === 'onTeam' && a.id !== orchestratorId && a.id !== 'default');
  if (teammates.length === 0) return null;
  return teammates.map(a => {
    const agentSkills = allSkills.filter(s => s.assignedAgents.some(aa => aa.id === a.id));
    const skillList = agentSkills.length > 0 ? ' Skills: ' + agentSkills.map(s => s.slug).join(', ') : '';
    return `- ${a.displayName} (${a.name}): ${a.role}.${skillList}`;
  }).join('\n');
}

function buildSystemPrompt(agentData) {
  const baseRules = [
    'FORMATTING RULES (mandatory, apply to all output):',
    '- NEVER use em dashes (\u2014) or en dashes (\u2013) anywhere. This includes lists, headers, separators, and inline text. Wrong: "AI \u2014 your assistant". Right: "AI: your assistant". Use colons, full stops, commas, or restructure instead.',
    '- Use UK spelling throughout.',
    '',
    'PLATFORM RULES:',
    'Rundock is a knowledge management platform focused on knowledge work. You can create and edit markdown, YAML, JSON, and text files freely. Writing or editing executable code files (.js, .ts, .py, .sh, etc.) is blocked by design.',
    '',
    'FILES IN .claude/ DIRECTORY:',
    'Claude Code blocks Write and Edit tools for files inside .claude/. Do NOT use Write, Edit, or Bash to create, modify, or delete files in .claude/agents/ or .claude/skills/.',
  ].join('\n');

  const bashRules = [
    'For terminal commands (Bash), use them whenever they are the best way to accomplish the task. Do not avoid Bash to be cautious. The user has a permission system that lets them approve or deny each command, so always attempt the command and let the user decide. If a command is denied, respect the decision without questioning it. Simply acknowledge it and offer an alternative if relevant. Do not describe denied commands as "blocked by the platform" or suggest the user lacks permissions. They chose to deny that specific request.',
    '',
    'Destructive commands (rm with force flags, sudo, chmod, chown) and piped install scripts (curl|sh, wget|sh) are blocked entirely and will not reach the user for approval.'
  ].join('\n');

  // Build delegation section with dynamic team roster for orchestrator agents
  let delegationSection = '';
  if (agentData && agentData.type === 'orchestrator') {
    const roster = buildTeamRoster(agentData.id);

    if (roster) {
      delegationSection = [
        'DELEGATION:',
        'You lead a team of specialists. When a request clearly falls within a specialist\'s domain, delegate to them. Tell the user briefly who you are handing to and why, then output the DELEGATE marker and STOP. Do not generate any further text after the closing marker. Do not summarise, predict, or describe what the specialist will do.',
        '',
        'Format:',
        '{Brief explanation to user of who you are handing to and why}',
        '',
        '<!-- RUNDOCK:DELEGATE agent={agent-name} -->',
        '{Summarise the user request with full context so the specialist can act on it}',
        '<!-- /RUNDOCK:DELEGATE -->',
        '',
        'CRITICAL: Your response MUST end immediately after the closing <!-- /RUNDOCK:DELEGATE --> tag. Any text after it will be shown to the user and will be confusing. The specialist will appear in the conversation and handle the request. After they finish, you resume automatically.',
        '',
        'YOUR TEAM:',
        roster,
        '',
        'ROUTING RULES:',
        '- Platform operations (creating, editing, deleting agents, skills, or workspace config): always delegate to the platform agent (type: platform).',
        '- If a request maps clearly to one specialist, ALWAYS delegate. Never answer it yourself, even if the question seems simple. The specialist exists for a reason.',
        '- If a request spans multiple specialists, handle the coordination yourself and delegate sub-tasks as needed.',
        '- If no specialist fits, handle it yourself.',
        '',
        'AFTER A SPECIALIST RETURNS:',
        'When a specialist hands back to you, read the conversation to understand why. If the specialist returned because the user asked for something outside their scope, pick up that request immediately: either handle it yourself or delegate to the right specialist. Do not ask the user to repeat themselves.',
      ].join('\n');
    }
  }

  const sections = [baseRules];
  if (delegationSection) sections.push(delegationSection);
  sections.push(bashRules);
  return sections.join('\n\n');
}

// ===== AGENT DISCOVERY =====

function discoverAgents() {
  const agents = [];
  const agentsDir = path.join(WORKSPACE, '.claude', 'agents');
  const claudeMdPath = path.join(WORKSPACE, 'CLAUDE.md');
  const colours = ['#E87A5A', '#6B9EF0', '#6BC67E', '#E8A84C', '#A07AE8', '#E87AAC', '#5BCFC4', '#E8A07A'];
  const icons = ['★', '✎', '◎', '▦', '◇', '✦', '⬡', '△'];
  let colourIdx = 0;

  if (fs.existsSync(agentsDir)) {
    const files = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'));

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(agentsDir, file), 'utf-8');
        const fmText = extractFrontmatterText(content);
        const meta = parseAgentFrontmatter(content);
        const id = file.replace('.md', '');
        const isDefault = meta.isDefault === 'true' || meta.isDefault === true || (meta.order && parseInt(meta.order) === 0);

        const fmName = meta.name || id;
        const displayName = meta.displayName || meta.name || titleCase(id);
        const role = meta.role || titleCase(id);
        const bodyMatch = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)/);
        let instructions = bodyMatch ? bodyMatch[1].trim() : '';

        // If this is the default agent, merge instructions from CLAUDE.md
        if (isDefault && fs.existsSync(claudeMdPath)) {
          instructions = fs.readFileSync(claudeMdPath, 'utf-8').substring(0, 2000);
        }

        const caps = parseCapabilities(fmText);
        const routines = parseRoutines(fmText);
        const prompts = parsePrompts(fmText);

        const agentType = meta.type || null; // orchestrator, specialist, platform, or null
        const hasOrder = meta.order !== undefined && meta.order !== '';
        const orderNum = hasOrder ? parseInt(meta.order) : null;

        // Three-state detection:
        // onTeam: has order (with or without type - backward compat)
        // available: has type but no order (marketplace install, not placed)
        // raw: no type AND no order (bare Claude Code agent, needs onboarding)
        let status = 'raw';
        if (hasOrder) status = 'onTeam';
        else if (agentType) status = 'available';

        agents.push({
          id: isDefault ? 'default' : id,
          name: fmName,
          displayName,
          role,
          description: meta.description || '',
          type: agentType,
          status,
          capabilities: caps,
          routines: routines,
          prompts: prompts.length > 0 ? prompts : null,
          model: meta.model || null,
          order: orderNum,
          instructions: instructions.substring(0, 2000),
          isDefault,
          colour: meta.colour || colours[colourIdx % colours.length],
          icon: meta.icon || icons[colourIdx % icons.length],
          fileName: file
        });
        colourIdx++;
      } catch (e) {
        console.error(`Error reading agent ${file}:`, e.message);
      }
    }
  }

  // If no default agent was found in agent files, create one from CLAUDE.md
  if (!agents.find(a => a.isDefault)) {
    if (fs.existsSync(claudeMdPath)) {
      const content = fs.readFileSync(claudeMdPath, 'utf-8');
      const nameMatch = content.match(/^#\s+(.+)/m);
      const defaultName = nameMatch ? nameMatch[1].split(/\s*[-]/)[0].trim() : 'Assistant';
      agents.unshift({
        id: 'default',
        name: 'default',
        displayName: defaultName,
        role: 'Default Agent',
        description: '',
        capabilities: null,
        routines: [],
        prompts: null,
        model: null,
        order: 0,
        instructions: content.substring(0, 2000),
        isDefault: true,
        colour: '#E87A5A',
        icon: '★',
        fileName: null
      });
    }
  }

  // Sort: onTeam first (by order), then available, then raw
  agents.sort((a, b) => {
    const statusOrder = { onTeam: 0, available: 1, raw: 2 };
    const sa = statusOrder[a.status] ?? 2;
    const sb = statusOrder[b.status] ?? 2;
    if (sa !== sb) return sa - sb;
    // Within onTeam: orchestrator first, then by order
    if (a.type === 'orchestrator' && b.type !== 'orchestrator') return -1;
    if (b.type === 'orchestrator' && a.type !== 'orchestrator') return 1;
    if (a.type === 'platform' && b.type !== 'platform') return 1;
    if (b.type === 'platform' && a.type !== 'platform') return -1;
    return (a.order ?? 99) - (b.order ?? 99);
  });

  // Inject built-in Doc if no platform agent exists
  if (!agents.find(a => a.type === 'platform')) {
    agents.push({
      id: 'rundock-guide',
      name: 'rundock-guide',
      displayName: 'Doc',
      role: 'Platform Guide',
      description: 'Helps you set up and navigate your Rundock workspace',
      type: 'platform',
      status: 'onTeam',
      capabilities: null,
      routines: [],
      prompts: ['Help me set up this workspace', 'Create an agent for my team', 'What makes a workspace Rundock-ready?'],
      model: null,
      order: 99,
      instructions: '',
      isDefault: false,
      colour: '#6B8A9E',
      icon: '⬡',
      fileName: null
    });
  }

  // Attach routine state
  for (const agent of agents) {
    if (agent.routines) {
      for (const r of agent.routines) {
        const key = `${agent.id}:${r.name}`;
        r.state = routineState[key] || null;
      }
    }
  }

  return agents;
}

function extractFrontmatterText(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  return match ? match[1] : '';
}

function titleCase(str) {
  return str.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function parseAgentFrontmatter(content) {
  const fmText = extractFrontmatterText(content);
  if (!fmText) return {};

  const meta = {};
  const lines = fmText.split('\n');
  let currentKey = null;
  let currentValue = '';

  for (const line of lines) {
    // Skip nested blocks (capabilities, routines, prompts) - parsed separately
    if (line.match(/^(capabilities|routines|prompts):$/)) {
      if (currentKey) { meta[currentKey] = currentValue.trim(); }
      currentKey = null; continue;
    }
    if (line.match(/^\s+-?\s*\w+:/) && line.startsWith('  ')) { continue; }

    const keyMatch = line.match(/^(\w+):\s*(.*)/);
    if (keyMatch) {
      if (currentKey) meta[currentKey] = currentValue.trim();
      currentKey = keyMatch[1];
      currentValue = keyMatch[2];
    } else if (currentKey && line.startsWith('  ')) {
      currentValue += ' ' + line.trim();
    }
  }
  if (currentKey) meta[currentKey] = currentValue.trim();

  if (meta.description) meta.description = meta.description.replace(/^>\s*/, '').trim();
  // Strip surrounding quotes from values (YAML-style "value" or 'value')
  for (const key of Object.keys(meta)) {
    if (typeof meta[key] === 'string') {
      meta[key] = meta[key].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    }
  }
  return meta;
}

function parseCapabilities(fmText) {
  const match = fmText.match(/capabilities:\n((?:  \w+:.*\n?)+)/);
  if (!match) return null;
  const caps = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^\s+(\w+):\s*(.*)/);
    if (kv) caps[kv[1]] = kv[2].trim();
  }
  return Object.keys(caps).length > 0 ? caps : null;
}

function parseRoutines(fmText) {
  const routines = [];
  const match = fmText.match(/routines:\n((?:  - [\s\S]*?)(?=\n\w|\n$|$))/);
  if (!match) return routines;

  // Split into individual routine blocks by "  - name:"
  const blocks = match[1].split(/(?=  - name:)/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    const routine = {};
    for (const line of block.split('\n')) {
      const kv = line.match(/^\s+-?\s*(\w+):\s*(.*)/);
      if (kv) routine[kv[1]] = kv[2].trim();
    }
    if (routine.name) routines.push(routine);
  }
  return routines;
}

function parsePrompts(fmText) {
  const match = fmText.match(/prompts:\n((?:  - [^\n]*(?:\n|$))+)/);
  if (!match) return [];
  const prompts = [];
  for (const line of match[1].split('\n')) {
    if (!line.trim()) continue;
    const item = line.match(/^\s+-\s*"?(.*?)"?\s*$/);
    if (item && item[1].trim()) prompts.push(item[1].trim());
  }
  return prompts;
}

// ===== SCHEDULER =====

function startScheduler() {
  const checkInterval = 60 * 1000; // Check every 60 seconds

  setInterval(() => {
    const agents = discoverAgents();
    const now = new Date();

    for (const agent of agents) {
      if (!agent.routines) continue;
      for (const routine of agent.routines) {
        const key = `${agent.id}:${routine.name}`;
        const nextRun = getNextRun(routine.schedule, routineState[key]?.lastRun);
        if (nextRun && now >= nextRun) {
          console.log(`[Scheduler] Running routine: ${routine.name} (${agent.name})`);
          executeRoutine(agent, routine, key);
        }
      }
    }
  }, checkInterval);
}

function getNextRun(schedule, lastRunISO) {
  if (!schedule) return null;
  const now = new Date();
  const s = schedule.toLowerCase();

  // Parse "every day at HH:MM"
  const dailyMatch = s.match(/every day at (\d{2}):(\d{2})/);
  if (dailyMatch) {
    const target = new Date(now);
    target.setHours(parseInt(dailyMatch[1]), parseInt(dailyMatch[2]), 0, 0);
    // If already past today, next is tomorrow
    if (now > target) target.setDate(target.getDate() + 1);
    // Don't re-run if already ran today
    if (lastRunISO) {
      const lastRun = new Date(lastRunISO);
      if (lastRun.toDateString() === now.toDateString() && lastRun.getHours() >= parseInt(dailyMatch[1])) return null;
    }
    return target;
  }

  // Parse "every [weekday] at HH:MM"
  const weeklyMatch = s.match(/every (\w+) at (\d{2}):(\d{2})/);
  if (weeklyMatch) {
    const days = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
    const targetDay = days[weeklyMatch[1]];
    if (targetDay === undefined) return null;
    const target = new Date(now);
    target.setHours(parseInt(weeklyMatch[2]), parseInt(weeklyMatch[3]), 0, 0);
    const daysUntil = (targetDay - now.getDay() + 7) % 7;
    if (daysUntil === 0 && now > target) target.setDate(target.getDate() + 7);
    else target.setDate(target.getDate() + daysUntil);
    // Don't re-run if already ran this week
    if (lastRunISO) {
      const lastRun = new Date(lastRunISO);
      const daysSinceLastRun = (now - lastRun) / (1000 * 60 * 60 * 24);
      if (daysSinceLastRun < 1 && lastRun.getDay() === targetDay) return null;
    }
    return target;
  }

  return null;
}

function executeRoutine(agent, routine, key) {
  const startTime = Date.now();
  routineState[key] = { lastRun: new Date().toISOString(), status: 'running', duration: null };

  // Notify connected clients
  broadcastRoutineUpdate();

  // Routines run unattended (no user to approve), so bypass permissions
  const args = ['--print', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
  if (agent.id !== 'default') args.push('--agent', agent.id);
  args.push(routine.prompt);

  const proc = spawn('claude', args, {
    cwd: WORKSPACE,
    env: { ...process.env, TERM: 'dumb', RUNDOCK: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  proc.on('close', (code) => {
    const duration = Math.round((Date.now() - startTime) / 1000);
    routineState[key] = {
      lastRun: new Date().toISOString(),
      status: code === 0 ? 'completed' : 'failed',
      duration
    };
    console.log(`[Scheduler] Routine "${routine.name}" ${code === 0 ? 'completed' : 'failed'} (${duration}s)`);
    broadcastRoutineUpdate();
  });
}

function broadcastRoutineUpdate() {
  const agents = discoverAgents();
  const msg = JSON.stringify({ type: 'agents', agents });
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });
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
    // Extract name and tagline from heading like "Dex by Dave — Your AI Chief of Staff"
    const parts = readme.heading.split(/[—–:|]+/).map(s => s.trim());
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
          const content = fs.readFileSync(defPath, 'utf-8');
          const parsed = parseSkillFile(content, d.name);
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

  let configuredServers = [];
  try {
    const mcpJsonPath = path.join(dir, '.mcp.json');
    if (fs.existsSync(mcpJsonPath)) {
      const mcpConfig = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
      if (mcpConfig.mcpServers) {
        configuredServers = Object.keys(mcpConfig.mcpServers);
      }
    }
  } catch (e) {}
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
  const paraNames = ['inbox', 'project', 'area', 'resource', 'archive'];
  const hasPara = paraNames.filter(p => topLevelDirs.some(d => d.toLowerCase().includes(p))).length >= 3;
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

// Mute sound hooks for Rundock (idempotent: skips already-muted hooks)
function muteHooks(dir) {
  const settingsPath = path.join(dir, '.claude', 'settings.json');
  if (!fs.existsSync(settingsPath)) return;
  try {
    const text = fs.readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(text);
    if (!settings.hooks) return;
    let mutedCount = 0;
    const soundPattern = /afplay|aplay|paplay|powershell.*audio/i;

    for (const [event, entries] of Object.entries(settings.hooks)) {
      for (const entry of (Array.isArray(entries) ? entries : [])) {
        const hooks = entry.hooks || [entry];
        for (const hook of hooks) {
          if (!hook.command || !soundPattern.test(hook.command)) continue;
          if (hook.command.includes('$RUNDOCK')) continue; // Already muted
          hook.command = `[ -z "$RUNDOCK" ] && ${hook.command} || true`;
          mutedCount++;
        }
      }
    }
    if (mutedCount > 0) {
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      console.log(`  [Scaffold] Muted ${mutedCount} sound hook(s) for Rundock`);
    }
  } catch (e) {
    console.warn(`  Warning: could not mute hooks: ${e.message}`);
  }
}

// ===== WORKSPACE SCAFFOLD =====

// Rundock-owned files: synced from scaffold/ on every workspace open.
// Only rundock-* prefixed files are managed. User files are never touched.
const RUNDOCK_MANAGED_FILES = [
  { source: 'rundock-guide.md',            target: '.claude/agents/rundock-guide.md' },
  { source: 'rundock-workspace.md',  target: '.claude/skills/rundock-workspace/SKILL.md' },
  { source: 'rundock-agents.md',    target: '.claude/skills/rundock-agents/SKILL.md' },
  { source: 'rundock-skills.md',    target: '.claude/skills/rundock-skills/SKILL.md' },
];

function scaffoldWorkspace(dir) {
  try {
    fs.mkdirSync(path.join(dir, '.claude', 'agents'), { recursive: true });

    // Sync Rundock-owned agents and skills from scaffold sources
    for (const entry of RUNDOCK_MANAGED_FILES) {
      const sourceContent = fs.readFileSync(path.join(__dirname, 'scaffold', entry.source), 'utf-8');
      const targetPath = path.join(dir, entry.target);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });

      let action = null;
      if (!fs.existsSync(targetPath)) {
        action = 'Created';
      } else {
        const deployed = fs.readFileSync(targetPath, 'utf-8');
        if (deployed !== sourceContent) action = 'Updated';
      }

      if (action) {
        fs.writeFileSync(targetPath, sourceContent, 'utf-8');
        console.log(`  [Scaffold] ${action}: ${entry.target}`);
      }
    }

    // Create .rundock/ directory for session persistence
    const rundockPath = path.join(dir, '.rundock');
    fs.mkdirSync(rundockPath, { recursive: true });

    // Ensure .rundock/ is gitignored (contains session IDs and timestamps)
    const gitignorePath = path.join(dir, '.gitignore');
    try {
      const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : '';
      if (!existing.includes('.rundock')) {
        const line = (existing && !existing.endsWith('\n') ? '\n' : '') + '.rundock/\n';
        fs.appendFileSync(gitignorePath, line);
        console.log(`  Scaffolded: .rundock/ added to .gitignore`);
      }
    } catch (e) {
      console.warn(`  Warning: could not update .gitignore: ${e.message}`);
    }

    // Auto-mute sound hooks for Rundock
    muteHooks(dir);

    // Configure PreToolUse permission hook in .claude/settings.local.json.
    // This makes Claude Code call our hook script before executing Bash commands,
    // which bridges to the Rundock browser UI for user approval.
    const hookScript = path.join(__dirname, 'scripts', 'permission-hook.js');
    const settingsLocalPath = path.join(dir, '.claude', 'settings.local.json');
    let settingsLocal = {};
    if (fs.existsSync(settingsLocalPath)) {
      try { settingsLocal = JSON.parse(fs.readFileSync(settingsLocalPath, 'utf-8')); } catch (e) { /* start fresh */ }
    }
    if (!settingsLocal.hooks) settingsLocal.hooks = {};
    if (!settingsLocal.hooks.PreToolUse) settingsLocal.hooks.PreToolUse = [];

    const hasPermHook = settingsLocal.hooks.PreToolUse.some(e =>
      (e.hooks || []).some(h => h.command && h.command.includes('permission-hook'))
    );
    if (!hasPermHook) {
      settingsLocal.hooks.PreToolUse.push({
        matcher: 'Bash',
        hooks: [{
          type: 'command',
          command: `node "${hookScript}"`,
          timeout: 300
        }]
      });
    }
    // Clean up Write/Edit hook entries if they exist from a previous version
    const before = settingsLocal.hooks.PreToolUse.length;
    settingsLocal.hooks.PreToolUse = settingsLocal.hooks.PreToolUse.filter(e =>
      !(e.matcher === 'Write' || e.matcher === 'Edit')
    );
    if (!hasPermHook || settingsLocal.hooks.PreToolUse.length < before) {
      fs.writeFileSync(settingsLocalPath, JSON.stringify(settingsLocal, null, 2));
      console.log('  [Scaffold] Configured permission hook in .claude/settings.local.json');
    }
  } catch (e) {
    console.warn(`  Warning: scaffold failed for ${dir}: ${e.message}`);
  }
}

// ===== HTTP SERVER =====

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
    res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
  } else if (req.url === '/favicon.svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    res.end(fs.readFileSync(path.join(__dirname, 'public', 'favicon.svg')));
  } else if (req.url === '/marked.min.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    res.end(fs.readFileSync(path.join(__dirname, 'node_modules', 'marked', 'lib', 'marked.umd.js')));
  } else if (req.url === '/app.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
    res.end(fs.readFileSync(path.join(__dirname, 'public', 'app.js')));
  } else if (req.url === '/api/agents') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(discoverAgents()));
  } else if (req.url === '/api/files') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getFileTree(WORKSPACE)));
  } else if (req.url.startsWith('/api/file?path=')) {
    const filePath = decodeURIComponent(req.url.split('path=')[1]);
    const fullPath = path.resolve(WORKSPACE, filePath);
    if (fullPath.startsWith(path.resolve(WORKSPACE)) && fs.existsSync(fullPath)) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(fs.readFileSync(fullPath, 'utf-8'));
    } else {
      res.writeHead(404);
      res.end('File not found');
    }

  // Permission hook endpoint: receives tool requests from the PreToolUse hook script,
  // forwards them to the browser as permission cards, and holds the connection open
  // until the user clicks Allow or Deny (or the 120s timeout fires).
  } else if (req.method === 'POST' && req.url === '/api/permission-request') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const requestId = 'perm-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const convoId = data.conversation_id || '';

        // Store the pending HTTP response (resolved when user decides)
        pendingPermissionRequests.set(requestId, {
          res,
          conversationId: convoId,
          toolName: data.tool_name,
          toolInput: data.tool_input,
          timer: setTimeout(() => {
            const pending = pendingPermissionRequests.get(requestId);
            if (pending) {
              pendingPermissionRequests.delete(requestId);
              console.log(`[Permission] Auto-denied (timeout): ${data.tool_name} convo=${convoId} requestId=${requestId}`);
              // Send denied indicator to browser
              safeSend(JSON.stringify({
                type: 'permission_timeout',
                requestId,
                _conversationId: convoId
              }));
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ allow: false, reason: 'timeout' }));
            }
          }, 120000)
        });

        // Forward to browser as a control_request (existing permission card UI handles this)
        safeSend(JSON.stringify({
          type: 'control_request',
          request_id: requestId,
          request: {
            subtype: 'can_use_tool',
            tool_name: data.tool_name,
            input: data.tool_input || {}
          },
          _conversationId: convoId
        }));

        console.log(`[Permission] Hook request: ${data.tool_name} convo=${convoId} requestId=${requestId}`);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request' }));
      }
    });

  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// ===== WEBSOCKET SERVER =====

const wss = new WebSocketServer({
  server,
  verifyClient: ({ origin, req }) => {
    // Allow connections from the same host (localhost or configured host)
    if (!origin) return true; // Non-browser clients (e.g. CLI tools)
    const allowed = [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];
    return allowed.includes(origin);
  }
});

// Module-level process tracking: survives WebSocket reconnects
const chatProcesses = new Map(); // conversationId -> { process, buffer, processId, agentId, responseText }
const connectedClients = new Set(); // All active WebSocket connections
const disconnectBuffer = []; // Messages queued while no clients are connected

function safeSend(data) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  let sent = false;
  for (const client of connectedClients) {
    if (client.readyState === 1) {
      client.send(payload);
      sent = true;
    }
  }
  if (!sent) {
    // No live clients: buffer for delivery on next connect
    if (disconnectBuffer.length < 500) disconnectBuffer.push(payload);
  }
}

// Heartbeat: detect silently dead connections every 15s
const HEARTBEAT_INTERVAL = 15000;
setInterval(() => {
  for (const client of connectedClients) {
    if (client._alive === false) {
      console.log('[WS] Heartbeat timeout, terminating stale connection');
      client.terminate();
      return;
    }
    client._alive = false;
    client.ping();
  }
}, HEARTBEAT_INTERVAL);

wss.on('connection', (ws) => {
  console.log('Client connected');
  connectedClients.add(ws);
  ws._alive = true;
  ws.on('pong', () => { ws._alive = true; });

  // Tell this client about any active processes so it can restore thinking indicators.
  // Always send this message, even when empty, so the client can reconcile stale state.
  const active = [];
  for (const [convoId, entry] of chatProcesses) {
    if (entry.idle) continue; // Don't report idle processes as active
    active.push({ conversationId: convoId, processId: entry.processId, agentId: entry.agentId, responseText: entry.responseText || '', delegation: entry.delegation ? { originalAgentId: entry.delegation.originalAgentId } : null });
  }
  ws.send(JSON.stringify({ type: 'active_processes', processes: active }));

  // Alias for handlers that still reference local `processes`
  const processes = chatProcesses;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'chat') {
        const convoId = msg.conversationId || 'default';
        const useLegacy = process.env.RUNDOCK_LEGACY_SPAWN === '1';

        // ── INTERACTIVE MODE (Deliverable A) ──────────────────────────
        // Process stays alive between messages. Follow-ups push to stdin.
        // --print is NOT used; Claude Code runs in interactive stream-json mode.
        if (!useLegacy) {

          // If a live process exists for this conversation, push the follow-up to its stdin
          let existing = processes.get(convoId);

          // If the orchestrator's team roster is stale (agent/skill CRUD happened),
          // kill the process so it respawns with a fresh system prompt via --resume.
          if (existing && !existing.exited && existing.needsRosterRefresh) {
            console.log(`[Roster] convo=${convoId} killing stale orchestrator for roster refresh`);
            try { existing.process.kill(); } catch (e) {}
            processes.delete(convoId);
            existing = null; // Force fall-through to spawn path
          }

          if (existing && !existing.exited && existing.process.stdin && existing.process.stdin.writable) {
            const processId = existing.processId;
            console.log(`[Chat] convo=${convoId} proc=${processId} FOLLOW-UP (interactive stdin)`);
            safeSend(JSON.stringify({ type: 'system', subtype: 'process_started', _conversationId: convoId, _processId: processId }));
            existing.responseText = '';
            existing.idle = false;
            if (existing.delegation) { existing.lastUserMessage = msg.content; existing.receivedFollowUp = true; }
            existing.process.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: msg.content } }) + '\n');
          } else {
            // No live process: spawn a new one (first message or after disconnect)
            // Kill stale entry if present
            if (existing) {
              try { existing.process.kill(); } catch (e) { /* already dead */ }
              processes.delete(convoId);
            }

            const processId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

            // Interactive chat: bidirectional stream-json, no --print.
            // Permission flow: PreToolUse hook (configured in workspace .claude/settings.local.json)
            // catches Bash commands, POSTs to /api/permission-request, Rundock shows a permission
            // card in the browser, user clicks Allow/Deny, hook returns the decision to Claude Code.
            // Read-only and knowledge-work tools are in allowed-tools (auto-approved, no card).

            // Look up agent data first so we can build a dynamic system prompt
            const agentList = discoverAgents();
            const requestedAgent = msg.agent || 'default';
            const agentData = agentList.find(a => a.id === requestedAgent)
              || agentList.find(a => a.fileName && a.fileName.replace('.md', '') === requestedAgent);

            const systemPrompt = buildSystemPrompt(agentData);

            const args = ['--output-format', 'stream-json', '--input-format', 'stream-json',
              '--verbose', '--include-partial-messages', '--permission-mode', 'acceptEdits',
              '--allowed-tools', 'Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,ToolSearch,Agent,Skill,mcp__*',
              '--disallowed-tools', 'Write(*.js),Write(*.jsx),Write(*.ts),Write(*.tsx),Write(*.py),Write(*.sh),Write(*.bash),Write(*.rb),Write(*.pl),Write(*.exe),Write(*.dll),Write(*.so),Edit(*.js),Edit(*.jsx),Edit(*.ts),Edit(*.tsx),Edit(*.py),Edit(*.sh),Edit(*.bash),Edit(*.rb),Edit(*.pl),Edit(*.exe)',
              '--append-system-prompt', systemPrompt];

            // Resume existing session if we have a session ID
            if (msg.sessionId) {
              args.push('--resume', msg.sessionId);
            }

            // Pass --agent with the slug name (first message only, not on resume)
            if (!msg.sessionId && agentData && agentData.fileName) {
              args.push('--agent', agentData.name);
            }

            console.log(`[Chat] convo=${convoId} proc=${processId} agent=${msg.agent} sessionId=${msg.sessionId||'new'} mode=interactive args=${args.filter(a=>a.startsWith('--')).join(' ')}`);

            const proc = spawn('claude', args, {
              cwd: WORKSPACE,
              env: { ...process.env, TERM: 'dumb', RUNDOCK: '1', RUNDOCK_PORT: String(PORT), RUNDOCK_CONVO_ID: convoId },
              stdio: ['pipe', 'pipe', 'pipe']
            });

            const entry = { process: proc, buffer: '', processId, agentId: msg.agent || 'default', responseText: '', exited: false };
            processes.set(convoId, entry);

            safeSend(JSON.stringify({ type: 'system', subtype: 'process_started', _conversationId: convoId, _processId: processId }));

            // Send the first message via stdin
            proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: msg.content } }) + '\n');

            let stderrBuffer = '';

            proc.stdout.on('data', (chunk) => {
              entry.buffer += chunk.toString();
              const lines = entry.buffer.split('\n');
              entry.buffer = lines.pop();
              for (const line of lines) {
                if (line.trim()) {
                  try {
                    const parsed = JSON.parse(line);
                    parsed._agent = entry.agentId;
                    parsed._conversationId = convoId;
                    parsed._processId = processId;
                    // Capture session ID from init message
                    if (parsed.type === 'system' && parsed.subtype === 'init' && parsed.session_id) {
                      parsed._sessionId = parsed.session_id;
                    }
                    // Accumulate response text for reconnect replay
                    if (parsed.type === 'stream_event' && parsed.event?.type === 'content_block_delta' && parsed.event?.delta?.type === 'text_delta' && parsed.event.delta.text) {
                      entry.responseText += parsed.event.delta.text;
                    } else if (parsed.type === 'assistant' && parsed.message?.content) {
                      for (const block of parsed.message.content) {
                        if (block.type === 'text' && block.text) entry.responseText = block.text;
                      }
                    }

                    // In interactive mode, a 'result' message means the turn is complete.
                    // Send a 'done' event so the client finishes processing, but keep the process alive.
                    if (parsed.type === 'result') {
                      safeSend(JSON.stringify(parsed));
                      safeSend(JSON.stringify({ type: 'system', subtype: 'done', code: 0, _agent: entry.agentId, _conversationId: convoId, _processId: processId }));
                      entry.responseText = '';
                      entry.idle = true;
                    } else {
                      safeSend(JSON.stringify(parsed));
                    }
                  } catch (e) {
                    safeSend(JSON.stringify({ type: 'raw', content: line, _agent: entry.agentId, _conversationId: convoId, _processId: processId }));
                  }
                }
              }
            });

            proc.stderr.on('data', (chunk) => {
              const text = chunk.toString();
              stderrBuffer += text;
              if (text.includes('no stdin data') || text.includes('proceeding without')) return;
              safeSend(JSON.stringify({ type: 'error', content: text, _conversationId: convoId, _processId: processId }));
            });

            proc.on('close', (code) => {
              entry.exited = true;
              const current = processes.get(convoId);
              if (current && current.processId !== processId) return;

              // Detect stale session and retry fresh
              const isResumeFailure = msg.sessionId && !msg._resumeRetry && code !== 0 &&
                (stderrBuffer.includes('session') || stderrBuffer.includes('resume') || stderrBuffer.includes('not found'));
              if (isResumeFailure) {
                console.log(`[Chat] Resume failed for session ${msg.sessionId}, retrying fresh`);
                processes.delete(convoId);
                safeSend(JSON.stringify({ type: 'system', subtype: 'info', content: 'Previous session expired. Starting fresh.', _conversationId: convoId, _processId: processId }));
                const freshMsg = { ...msg, sessionId: null, _resumeRetry: true };
                ws.emit('message', JSON.stringify(freshMsg));
                return;
              }

              // Flush remaining buffer
              if (entry.buffer.trim()) {
                try {
                  const parsed = JSON.parse(entry.buffer);
                  parsed._agent = entry.agentId;
                  parsed._conversationId = convoId;
                  parsed._processId = processId;
                  safeSend(JSON.stringify(parsed));
                } catch (e) {
                  safeSend(JSON.stringify({ type: 'raw', content: entry.buffer, _conversationId: convoId, _processId: processId }));
                }
              }

              // Process exited unexpectedly in interactive mode. Send done so client unblocks.
              console.log(`[Chat] convo=${convoId} proc=${processId} process exited code=${code} (interactive)`);
              safeSend(JSON.stringify({ type: 'system', subtype: 'done', code, _agent: entry.agentId, _conversationId: convoId, _processId: processId }));
              processes.delete(convoId);
            });
          }

        // ── LEGACY MODE (--print, one process per message) ────────────
        } else {
          const processId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

          // Kill existing process for this conversation only
          if (processes.has(convoId)) {
            processes.get(convoId).process.kill();
            processes.delete(convoId);
          }

          const args = ['--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
            '--verbose', '--include-partial-messages', '--permission-mode', 'acceptEdits',
            '--allowed-tools', 'Bash,WebFetch,WebSearch,mcp__*',
            '--disallowed-tools', 'Write(*.js),Write(*.jsx),Write(*.ts),Write(*.tsx),Write(*.py),Write(*.sh),Write(*.bash),Write(*.rb),Write(*.pl),Write(*.exe),Write(*.dll),Write(*.so),Edit(*.js),Edit(*.jsx),Edit(*.ts),Edit(*.tsx),Edit(*.py),Edit(*.sh),Edit(*.bash),Edit(*.rb),Edit(*.pl),Edit(*.exe)',
            '--append-system-prompt', 'FORMATTING RULES (mandatory, apply to all output):\n- NEVER use em dashes (—) or en dashes (–) anywhere. This includes lists, headers, separators, and inline text. Wrong: "AI — your assistant". Right: "AI: your assistant". Use colons, full stops, commas, or restructure instead.\n- Use UK spelling throughout.\n\nPLATFORM RULES:\nRundock is a knowledge management platform. You can create and edit markdown, YAML, JSON, and text files. Writing or editing executable code files (.js, .ts, .py, .sh, etc.) is blocked by design. Destructive commands (rm, sudo, chmod) are also blocked. If a user asks you to do something that hits these restrictions, explain that Rundock is designed for knowledge work, not software development, and suggest an alternative approach using supported file types. Never offer to change permission settings or suggest workarounds to bypass these restrictions.'];

          if (msg.sessionId) {
            args.push('--resume', msg.sessionId);
          }

          if (!msg.sessionId) {
            const agentList = discoverAgents();
            const requestedAgent = msg.agent || 'default';
            const agentData = agentList.find(a => a.id === requestedAgent)
              || agentList.find(a => a.fileName && a.fileName.replace('.md', '') === requestedAgent);
            if (agentData && agentData.fileName) {
              args.push('--agent', agentData.name);
            }
          }

          console.log(`[Chat] convo=${convoId} proc=${processId} agent=${msg.agent} sessionId=${msg.sessionId||'new'} mode=legacy args=${args.filter(a=>a.startsWith('--')).join(' ')}`);

          const proc = spawn('claude', args, {
            cwd: WORKSPACE,
            env: { ...process.env, TERM: 'dumb', RUNDOCK: '1', RUNDOCK_PORT: String(PORT), RUNDOCK_CONVO_ID: convoId },
            stdio: ['pipe', 'pipe', 'pipe']
          });

          const entry = { process: proc, buffer: '', processId, agentId: msg.agent || 'default', responseText: '', exited: false };
          processes.set(convoId, entry);

          safeSend(JSON.stringify({ type: 'system', subtype: 'process_started', _conversationId: convoId, _processId: processId }));

          proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: msg.content } }) + '\n');

          proc.stdout.on('data', (chunk) => {
            entry.buffer += chunk.toString();
            const lines = entry.buffer.split('\n');
            entry.buffer = lines.pop();
            for (const line of lines) {
              if (line.trim()) {
                try {
                  const parsed = JSON.parse(line);
                  parsed._agent = msg.agent || 'default';
                  parsed._conversationId = convoId;
                  parsed._processId = processId;
                  if (parsed.type === 'system' && parsed.subtype === 'init' && parsed.session_id) {
                    parsed._sessionId = parsed.session_id;
                  }
                  if (parsed.type === 'stream_event' && parsed.event?.type === 'content_block_delta' && parsed.event?.delta?.type === 'text_delta' && parsed.event.delta.text) {
                    entry.responseText += parsed.event.delta.text;
                  } else if (parsed.type === 'assistant' && parsed.message?.content) {
                    for (const block of parsed.message.content) {
                      if (block.type === 'text' && block.text) entry.responseText = block.text;
                    }
                  }
                  safeSend(JSON.stringify(parsed));
                } catch (e) {
                  safeSend(JSON.stringify({ type: 'raw', content: line, _agent: msg.agent || 'default', _conversationId: convoId, _processId: processId }));
                }
              }
            }
          });

          let stderrBuffer = '';
          proc.stderr.on('data', (chunk) => {
            const text = chunk.toString();
            stderrBuffer += text;
            if (text.includes('no stdin data') || text.includes('proceeding without')) return;
            safeSend(JSON.stringify({ type: 'error', content: text, _conversationId: convoId, _processId: processId }));
          });

          proc.on('close', (code) => {
            entry.exited = true;
            const current = processes.get(convoId);
            if (current && current.processId !== processId) return;

            const isResumeFailure = msg.sessionId && !msg._resumeRetry && code !== 0 &&
              (stderrBuffer.includes('session') || stderrBuffer.includes('resume') || stderrBuffer.includes('not found'));
            if (isResumeFailure) {
              console.log(`[Chat] Resume failed for session ${msg.sessionId}, retrying fresh`);
              processes.delete(convoId);
              safeSend(JSON.stringify({ type: 'system', subtype: 'info', content: 'Previous session expired. Starting fresh.', _conversationId: convoId, _processId: processId }));
              const freshMsg = { ...msg, sessionId: null, _resumeRetry: true };
              ws.emit('message', JSON.stringify(freshMsg));
              return;
            }

            if (entry.buffer.trim()) {
              try {
                const parsed = JSON.parse(entry.buffer);
                parsed._agent = msg.agent || 'default';
                parsed._conversationId = convoId;
                parsed._processId = processId;
                safeSend(JSON.stringify(parsed));
              } catch (e) {
                safeSend(JSON.stringify({ type: 'raw', content: entry.buffer, _conversationId: convoId, _processId: processId }));
              }
            }
            safeSend(JSON.stringify({ type: 'system', subtype: 'done', code, _agent: msg.agent || 'default', _conversationId: convoId, _processId: processId }));
            processes.delete(convoId);
          });
        }
      }

      // Permission response: user approved/denied a tool in the browser UI.
      // Resolves the pending HTTP long-poll from the PreToolUse hook script.
      if (msg.type === 'permission_response') {
        const pending = pendingPermissionRequests.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingPermissionRequests.delete(msg.requestId);
          pending.res.writeHead(200, { 'Content-Type': 'application/json' });
          pending.res.end(JSON.stringify({ allow: msg.allow }));
          console.log(`[Permission] convo=${msg.conversationId} requestId=${msg.requestId} decision=${msg.allow ? 'allow' : 'deny'}`);
        } else {
          console.warn(`[Permission] No pending request for requestId=${msg.requestId} (expired or already resolved)`);
        }
      }

      if (msg.type === 'get_workspaces') {
        const wsData = {
          type: 'workspaces',
          current: WORKSPACE,
          recent: loadRecentWorkspaces(),
          discovered: discoverWorkspaces()
        };
        if (WORKSPACE) wsData.analysis = analyzeWorkspace(WORKSPACE, discoverAgents());
        ws.send(JSON.stringify(wsData));
      }

      if (msg.type === 'list_workspaces') {
        ws.send(JSON.stringify({
          type: 'workspaces',
          recent: loadRecentWorkspaces(),
          discovered: discoverWorkspaces()
        }));
      }

      if (msg.type === 'set_workspace') {
        const dir = msg.path;
        if (dir && fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
          // Kill all running processes when switching workspace
          for (const [, entry] of chatProcesses) entry.process.kill();
          chatProcesses.clear();
          WORKSPACE = dir;
          saveRecentWorkspace(dir);
          try { scaffoldWorkspace(dir); } catch (e) { console.warn('Scaffold warning:', e.message); }
          console.log(`  Workspace changed to: ${WORKSPACE}`);
          const agentList = discoverAgents();
          const analysis = analyzeWorkspace(dir, agentList);
          ws.send(JSON.stringify({ type: 'workspace_set', path: WORKSPACE, analysis }));
          ws.send(JSON.stringify({ type: 'agents', agents: agentList }));
          ws.send(JSON.stringify({ type: 'file_tree', tree: getFileTree(WORKSPACE) }));
        } else {
          ws.send(JSON.stringify({ type: 'workspace_error', message: 'Directory not found' }));
        }
      }

      if (msg.type === 'create_workspace') {
        const rawName = (msg.name || '').replace(/[\/\\:*?"<>|]/g, '').trim();
        if (!rawName) {
          ws.send(JSON.stringify({ type: 'workspace_error', message: 'Please enter a workspace name' }));
        } else {
          const home = process.env.HOME || process.env.USERPROFILE || '';
          const dir = path.join(home, 'Documents', 'Rundock', rawName);
          try {
            fs.mkdirSync(dir, { recursive: true });
            fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
            // Kill all running processes when creating/switching workspace
            for (const [, entry] of chatProcesses) entry.process.kill();
            chatProcesses.clear();
            WORKSPACE = dir;
            saveRecentWorkspace(dir);
            try { scaffoldWorkspace(dir); } catch (e) { console.warn('Scaffold warning:', e.message); }
            console.log(`  Workspace created: ${WORKSPACE}`);
            const agentList = discoverAgents();
            const analysis = analyzeWorkspace(dir, agentList);
            ws.send(JSON.stringify({ type: 'workspace_set', path: WORKSPACE, analysis }));
            ws.send(JSON.stringify({ type: 'agents', agents: agentList }));
            ws.send(JSON.stringify({ type: 'file_tree', tree: getFileTree(WORKSPACE) }));
          } catch (e) {
            ws.send(JSON.stringify({ type: 'workspace_error', message: 'Could not create workspace: ' + e.message }));
          }
        }
      }

      if (msg.type === 'get_agents') {
        if (!WORKSPACE) { ws.send(JSON.stringify({ type: 'needs_workspace' })); return; }
        ws.send(JSON.stringify({ type: 'agents', agents: discoverAgents() }));
      }
      if (msg.type === 'get_files') {
        if (!WORKSPACE) return;
        ws.send(JSON.stringify({ type: 'file_tree', tree: getFileTree(WORKSPACE) }));
      }
      if (msg.type === 'get_skills') ws.send(JSON.stringify({ type: 'skills', skills: discoverSkills() }));

      // ===== SESSION PERSISTENCE =====

      if (msg.type === 'get_conversations') {
        if (!WORKSPACE) return;
        // Clean up empty conversations (no sessionId means no message was ever sent)
        // Only remove if older than 5 minutes to avoid race with sessionId assignment
        const convos = readConversations();
        const fiveMinAgo = Date.now() - 5 * 60 * 1000;
        const cleaned = convos.filter(c => c.sessionId || new Date(c.lastActiveAt || c.createdAt).getTime() > fiveMinAgo);
        if (cleaned.length < convos.length) writeConversations(cleaned);
        ws.send(JSON.stringify({ type: 'conversations', conversations: cleaned }));
      }

      // Client requests buffered messages after it has loaded conversations and state.
      // Skip stream_event and assistant messages since responseText snapshot covers them.
      if (msg.type === 'flush_buffer') {
        if (disconnectBuffer.length) {
          console.log(`[WS] Flushing ${disconnectBuffer.length} buffered messages (filtering stream events)`);
          while (disconnectBuffer.length) {
            const m = disconnectBuffer.shift();
            try {
              const parsed = JSON.parse(m);
              if (parsed.type === 'stream_event' || parsed.type === 'assistant') continue;
            } catch (e) {}
            if (ws.readyState === 1) ws.send(m);
          }
        }
      }

      if (msg.type === 'save_conversation') {
        if (!WORKSPACE || !msg.conversation || !msg.conversation.id) return;
        const convos = readConversations();
        const idx = convos.findIndex(c => c.id === msg.conversation.id);
        // Only persist metadata, never message content
        const entry = {
          id: msg.conversation.id,
          agentId: msg.conversation.agentId,
          sessionId: msg.conversation.sessionId || null,
          title: msg.conversation.title,
          status: msg.conversation.status || 'active',
          createdAt: msg.conversation.createdAt || new Date().toISOString(),
          lastActiveAt: new Date().toISOString()
        };
        if (idx >= 0) { convos[idx] = entry; } else { convos.unshift(entry); }
        // Cap at 100 conversations
        writeConversations(convos.slice(0, 100));
      }

      // ── DELEGATION: orchestrator hands off to another agent in the same conversation ──
      if (msg.type === 'delegate') {
        const convoId = msg.conversationId;
        const existing = processes.get(convoId);
        if (!existing || existing.exited) {
          safeSend(JSON.stringify({ type: 'system', subtype: 'delegation_error', content: 'No active process to delegate from', _conversationId: convoId }));
          return;
        }

        const agentList = discoverAgents();
        const targetAgent = agentList.find(a => a.id === msg.targetAgent || a.name === msg.targetAgent);
        if (!targetAgent || !targetAgent.fileName) {
          safeSend(JSON.stringify({ type: 'system', subtype: 'delegation_error', content: `Agent "${msg.targetAgent}" not found`, _conversationId: convoId }));
          return;
        }

        // Park the original process
        const originalAgentId = existing.agentId;
        const originalProcessId = existing.processId;
        existing.idle = true;

        // Spawn delegate process
        const delegateProcessId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const isPlatformDelegate = targetAgent.type === 'platform';

        // Platform delegates (Doc): transactional, auto-return after task completion
        // Specialist delegates: conversational, user controls when to return
        const delegationContext = isPlatformDelegate
          ? 'DELEGATION CONTEXT:\nYou have been delegated a task by another agent. Complete the task in a single response if possible. When the task is done (agent created, skill saved, file written, question answered, etc.), output <!-- RUNDOCK:RETURN --> at the very end of that same response. Do not wait for follow-up questions. Do not ask if there is anything else. Just complete the task, confirm what you did, and return immediately. If you genuinely need clarification before you can proceed, ask, but prefer using sensible defaults over asking.'
          : 'DELEGATION CONTEXT:\nYou have been brought into this conversation by the orchestrator to handle a specific request. Help the user with their request. Have a natural conversation. Stay in the conversation and keep helping with follow-up questions in your domain.\n\nIMPORTANT: Do NOT return after completing a single task. The user may have more questions for you. Wait for their next message.\n\nOnly return to the orchestrator (output <!-- RUNDOCK:RETURN --> at the very end of your response) when:\n- The user asks for something outside your area of expertise. Tell them briefly that this falls outside what you handle and you are handing them back so the right person can pick it up. Do NOT name other specialists or suggest who should handle it. That is the orchestrator\'s job. Then output the RETURN marker.\n\nDo not attempt tasks you are not designed for. Hand back promptly so the orchestrator can route correctly.';

        const delegateArgs = ['--output-format', 'stream-json', '--input-format', 'stream-json',
          '--verbose', '--include-partial-messages', '--permission-mode', 'acceptEdits',
          '--allowed-tools', 'Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,ToolSearch,Agent,Skill,mcp__*',
          '--disallowed-tools', 'Write(*.js),Write(*.jsx),Write(*.ts),Write(*.tsx),Write(*.py),Write(*.sh),Write(*.bash),Write(*.rb),Write(*.pl),Write(*.exe),Write(*.dll),Write(*.so),Edit(*.js),Edit(*.jsx),Edit(*.ts),Edit(*.tsx),Edit(*.py),Edit(*.sh),Edit(*.bash),Edit(*.rb),Edit(*.pl),Edit(*.exe)',
          '--append-system-prompt', 'FORMATTING RULES (mandatory, apply to all output):\n- NEVER use em dashes (—) or en dashes (–) anywhere. This includes lists, headers, separators, and inline text. Wrong: "AI — your assistant". Right: "AI: your assistant". Use colons, full stops, commas, or restructure instead.\n- Use UK spelling throughout.\n\nPLATFORM RULES:\nRundock is a knowledge management platform focused on knowledge work. You can create and edit markdown, YAML, JSON, and text files freely. Writing or editing executable code files (.js, .ts, .py, .sh, etc.) is blocked by design.\n\n' + delegationContext + '\n\nFor terminal commands (Bash), use them whenever they are the best way to accomplish the task. Do not avoid Bash to be cautious. The user has a permission system that lets them approve or deny each command, so always attempt the command and let the user decide. If a command is denied, respect the decision without questioning it. Simply acknowledge it and offer an alternative if relevant. Do not describe denied commands as "blocked by the platform" or suggest the user lacks permissions. They chose to deny that specific request.\n\nDestructive commands (rm with force flags, sudo, chmod, chown) and piped install scripts (curl|sh, wget|sh) are blocked entirely and will not reach the user for approval.',
          '--agent', targetAgent.name];

        console.log(`[Delegate] convo=${convoId} from=${originalAgentId} to=${targetAgent.id} proc=${delegateProcessId}`);

        const delegateProc = spawn('claude', delegateArgs, {
          cwd: WORKSPACE,
          env: { ...process.env, TERM: 'dumb', RUNDOCK: '1', RUNDOCK_PORT: String(PORT), RUNDOCK_CONVO_ID: convoId },
          stdio: ['pipe', 'pipe', 'pipe']
        });

        const delegateEntry = {
          process: delegateProc, buffer: '', processId: delegateProcessId,
          agentId: targetAgent.id, responseText: '', exited: false, idle: false,
          isPlatformDelegate, lastUserMessage: msg.context, receivedFollowUp: false,
          delegation: { originalAgentId, originalProcessId, originalProcess: existing.process, originalEntry: existing }
        };
        processes.set(convoId, delegateEntry);

        // Notify client of agent switch
        safeSend(JSON.stringify({
          type: 'system', subtype: 'agent_switch', _conversationId: convoId, _processId: delegateProcessId,
          fromAgent: originalAgentId, toAgent: targetAgent.id
        }));
        safeSend(JSON.stringify({ type: 'system', subtype: 'process_started', _conversationId: convoId, _processId: delegateProcessId }));

        // Send context as first message
        delegateProc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: msg.context } }) + '\n');

        let delegateStderr = '';

        delegateProc.stdout.on('data', (chunk) => {
          delegateEntry.buffer += chunk.toString();
          const lines = delegateEntry.buffer.split('\n');
          delegateEntry.buffer = lines.pop();
          for (const line of lines) {
            if (line.trim()) {
              try {
                const parsed = JSON.parse(line);
                parsed._agent = delegateEntry.agentId;
                parsed._conversationId = convoId;
                parsed._processId = delegateProcessId;
                if (parsed.type === 'system' && parsed.subtype === 'init' && parsed.session_id) {
                  parsed._sessionId = parsed.session_id;
                }
                if (parsed.type === 'stream_event' && parsed.event?.type === 'content_block_delta' && parsed.event?.delta?.type === 'text_delta' && parsed.event.delta.text) {
                  delegateEntry.responseText += parsed.event.delta.text;
                } else if (parsed.type === 'assistant' && parsed.message?.content) {
                  for (const block of parsed.message.content) {
                    if (block.type === 'text' && block.text) delegateEntry.responseText = block.text;
                  }
                }
                if (parsed.type === 'result') {
                  safeSend(JSON.stringify(parsed));
                  safeSend(JSON.stringify({ type: 'system', subtype: 'done', code: 0, _agent: delegateEntry.agentId, _conversationId: convoId, _processId: delegateProcessId }));

                  // Server-side auto-return for platform delegates (Doc):
                  // Check for RETURN marker or CRUD markers in response.
                  // Specialist delegates stay in conversation until user triggers return.
                  const hasReturn = /<!-- RUNDOCK:RETURN -->/.test(delegateEntry.responseText);
                  const hasCrudMarker = /<!-- RUNDOCK:(?:SAVE|CREATE)_AGENT|<!-- RUNDOCK:DELETE_AGENT|<!-- RUNDOCK:SAVE_SKILL|<!-- RUNDOCK:DELETE_SKILL/.test(delegateEntry.responseText);
                  const shouldAutoReturn = delegateEntry.isPlatformDelegate
                    ? (hasReturn || hasCrudMarker)  // Platform: auto-return on RETURN or CRUD
                    : hasReturn;                      // Specialist: only on explicit RETURN
                  if (shouldAutoReturn) {
                    console.log(`[Delegate] Server-side auto-return convo=${convoId} (marker=${hasReturn}, crud=${hasCrudMarker})`);
                    // Short delay to let the client process the result and trigger CRUD handlers first
                    setTimeout(() => {
                      if (!delegateEntry.exited) {
                        try { delegateEntry.process.kill(); } catch (e) {}
                      }
                    }, 500);
                  }

                  delegateEntry.responseText = '';
                  delegateEntry.idle = true;
                } else {
                  safeSend(JSON.stringify(parsed));
                }
              } catch (e) {
                safeSend(JSON.stringify({ type: 'raw', content: line, _agent: delegateEntry.agentId, _conversationId: convoId, _processId: delegateProcessId }));
              }
            }
          }
        });

        delegateProc.stderr.on('data', (chunk) => {
          const text = chunk.toString();
          delegateStderr += text;
          if (text.includes('no stdin data') || text.includes('proceeding without')) return;
          safeSend(JSON.stringify({ type: 'error', content: text, _conversationId: convoId, _processId: delegateProcessId }));
        });

        delegateProc.on('close', (code) => {
          delegateEntry.exited = true;
          const current = processes.get(convoId);
          if (current !== delegateEntry) return;

          // Flush remaining buffer
          if (delegateEntry.buffer.trim()) {
            try {
              const parsed = JSON.parse(delegateEntry.buffer);
              parsed._agent = delegateEntry.agentId;
              parsed._conversationId = convoId;
              parsed._processId = delegateProcessId;
              safeSend(JSON.stringify(parsed));
            } catch (e) {}
          }

          // Restore original process
          const orig = delegateEntry.delegation.originalEntry;
          if (orig && !orig.exited) {
            orig.idle = true;
            orig.delegation = null;
            processes.set(convoId, orig);
            console.log(`[Delegate] convo=${convoId} delegate exited, restored ${delegateEntry.delegation.originalAgentId}`);
            safeSend(JSON.stringify({
              type: 'system', subtype: 'agent_switch', _conversationId: convoId,
              fromAgent: delegateEntry.agentId, toAgent: delegateEntry.delegation.originalAgentId
            }));

            // Auto-continue: if the specialist returned after an out-of-scope user request,
            // nudge the orchestrator to pick up the pending request.
            // Only fires when the user sent follow-up messages to the specialist (not on first-turn completion).
            if (!delegateEntry.isPlatformDelegate && delegateEntry.receivedFollowUp && orig.process.stdin && orig.process.stdin.writable) {
              const pendingRequest = delegateEntry.lastUserMessage || '';
              setTimeout(() => {
                if (!orig.exited) {
                  console.log(`[Delegate] convo=${convoId} auto-continuing orchestrator after specialist return`);
                  orig.responseText = '';
                  orig.idle = false;
                  safeSend(JSON.stringify({ type: 'system', subtype: 'process_started', _conversationId: convoId, _processId: orig.processId, autoContinue: true }));
                  const prompt = pendingRequest
                    ? `[SYSTEM: The specialist just returned because the user asked for something outside their scope. The user's pending request is: "${pendingRequest}"\n\nRoute this request now. Delegate to the right specialist if one fits, or handle it yourself. Do not summarise what the previous specialist did. Do not ask the user to repeat themselves. Respond to their request.]`
                    : '[SYSTEM: The specialist just returned. The user indicated they were done with that specialist. Ask the user what they need next.]';
                  orig.process.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n');
                }
              }, 300);
            }
          } else {
            processes.delete(convoId);
            console.log(`[Delegate] convo=${convoId} delegate exited, original process gone`);
          }
          safeSend(JSON.stringify({ type: 'system', subtype: 'done', code, _agent: delegateEntry.agentId, _conversationId: convoId, _processId: delegateProcessId }));
        });
      }

      // End delegation: kill delegate, restore original
      if (msg.type === 'end_delegation') {
        const convoId = msg.conversationId;
        const current = processes.get(convoId);
        if (current && current.delegation && !current.exited) {
          console.log(`[Delegate] convo=${convoId} ending delegation, killing delegate`);
          try { current.process.kill(); } catch (e) {}
          // The close handler will restore the original process
        }
      }

      if (msg.type === 'delete_conversation') {
        if (!WORKSPACE || !msg.id) return;
        const convos = readConversations().filter(c => c.id !== msg.id);
        writeConversations(convos);
        ws.send(JSON.stringify({ type: 'conversations', conversations: convos }));
      }

      if (msg.type === 'read_file') {
        const fullPath = path.resolve(WORKSPACE, msg.path);
        if (fullPath.startsWith(path.resolve(WORKSPACE)) && fs.existsSync(fullPath)) {
          ws.send(JSON.stringify({ type: 'file_content', path: msg.path, content: fs.readFileSync(fullPath, 'utf-8') }));
        }
      }

      if (msg.type === 'add_to_team') {
        // Assign the next order number to an available agent
        const agentList = discoverAgents();
        const target = agentList.find(a => a.id === msg.agentId);
        if (target && target.fileName) {
          const maxOrder = Math.max(0, ...agentList.filter(a => a.order !== null).map(a => a.order));
          const nextOrder = maxOrder + 1;
          const filePath = path.join(WORKSPACE, '.claude', 'agents', target.fileName);
          let content = fs.readFileSync(filePath, 'utf-8');
          // Add or update order field in frontmatter
          if (content.match(/^order:\s/m)) {
            content = content.replace(/^order:\s.*/m, `order: ${nextOrder}`);
          } else {
            // Add order after the type field, or after description
            content = content.replace(/^(type:\s.*)/m, `$1\norder: ${nextOrder}`);
            if (!content.match(/^order:/m)) {
              content = content.replace(/^(description:[\s\S]*?)(\n\w)/m, `$1\norder: ${nextOrder}$2`);
            }
          }
          fs.writeFileSync(filePath, content, 'utf-8');
          // Send updated agent list
          ws.send(JSON.stringify({ type: 'agents', agents: discoverAgents() }));
        }
      }

      // ===== AGENT & SKILL CRUD (server-side, bypasses Claude Code's .claude/ protection) =====
      // Agents: .claude/agents/{name}.md
      // Skills: .claude/skills/{name}/SKILL.md
      // Both use the same pattern: SAVE (upsert) and DELETE via WebSocket messages,
      // triggered by RUNDOCK:SAVE_AGENT / RUNDOCK:SAVE_SKILL markers in agent responses.

      // save_agent: upsert (create or update). Also handles legacy 'create_agent' and 'update_agent'.
      if (msg.type === 'save_agent' || msg.type === 'create_agent' || msg.type === 'update_agent') {
        const name = msg.name || msg.agentId;
        if (!validateAgentSlug(name)) {
          ws.send(JSON.stringify({ type: 'agent_error', message: 'Invalid agent name. Use lowercase letters, numbers, and hyphens only.' }));
        } else {
          const agentsDir = path.join(WORKSPACE, '.claude', 'agents');
          if (!fs.existsSync(agentsDir)) fs.mkdirSync(agentsDir, { recursive: true });
          const filePath = path.join(agentsDir, name + '.md');
          if (!filePath.startsWith(path.resolve(WORKSPACE))) {
            ws.send(JSON.stringify({ type: 'agent_error', message: 'Invalid path.' }));
          } else {
            const existed = fs.existsSync(filePath);
            fs.writeFileSync(filePath, msg.content, 'utf-8');
            // For new agents: auto-assign type and order so they go straight to team
            if (!existed) {
              let saved = fs.readFileSync(filePath, 'utf-8');
              const hasType = saved.match(/^type:\s/m);
              const hasOrder = saved.match(/^order:\s/m);
              if (!hasType || !hasOrder) {
                const currentAgents = discoverAgents();
                const maxOrder = Math.max(0, ...currentAgents.filter(a => a.order !== null).map(a => a.order));
                if (!hasType && !hasOrder) {
                  // No type or order: add both after description (or before closing ---)
                  if (saved.match(/^description:\s/m)) {
                    saved = saved.replace(/^(description:\s.*)/m, `$1\ntype: specialist\norder: ${maxOrder + 1}`);
                  } else {
                    saved = saved.replace(/^(---\s*$)/m, `type: specialist\norder: ${maxOrder + 1}\n$1`);
                  }
                } else if (hasType && !hasOrder) {
                  // Has type but no order: add order after type
                  saved = saved.replace(/^(type:\s.*)/m, `$1\norder: ${maxOrder + 1}`);
                }
                fs.writeFileSync(filePath, saved, 'utf-8');
              }
            }
            console.log(`[Agent] ${existed ? 'Updated' : 'Created'}: ${name}`);
            ws.send(JSON.stringify({ type: 'agent_saved', agentId: name, updated: existed }));
            const updatedAgents = discoverAgents();
            ws.send(JSON.stringify({ type: 'agents', agents: updatedAgents }));
            ws.send(JSON.stringify({ type: 'skills', skills: discoverSkills(updatedAgents) }));
            flagRosterRefresh();
            if (!existed) {
              const state = readState();
              if (!state.setupComplete && updatedAgents.some(a => a.status === 'onTeam' && a.type !== 'platform')) {
                writeState({ ...state, setupComplete: true, setupCompletedAt: new Date().toISOString(), version: 1 });
                console.log(`[Setup] Marked complete`);
              }
            }
          }
        }
      }

      if (msg.type === 'delete_agent') {
        const agentList = discoverAgents();
        const target = agentList.find(a => a.id === msg.agentId);
        if (!target || !target.fileName) {
          ws.send(JSON.stringify({ type: 'agent_error', message: `Agent "${msg.agentId}" not found.` }));
        } else if (target.type === 'platform') {
          ws.send(JSON.stringify({ type: 'agent_error', message: 'Cannot delete platform agents.' }));
        } else {
          const filePath = path.join(WORKSPACE, '.claude', 'agents', target.fileName);
          if (filePath.startsWith(path.resolve(WORKSPACE))) {
            fs.unlinkSync(filePath);
            console.log(`[Agent] Deleted: ${msg.agentId}`);
            ws.send(JSON.stringify({ type: 'agent_deleted', agentId: msg.agentId }));
            const updatedAgents = discoverAgents();
            ws.send(JSON.stringify({ type: 'agents', agents: updatedAgents }));
            ws.send(JSON.stringify({ type: 'skills', skills: discoverSkills(updatedAgents) }));
            flagRosterRefresh();
          }
        }
      }

      // save_skill: upsert (create or update) a skill's SKILL.md file.
      if (msg.type === 'save_skill') {
        const name = msg.name;
        if (!validateAgentSlug(name)) {
          ws.send(JSON.stringify({ type: 'skill_error', message: 'Invalid skill name. Use lowercase letters, numbers, and hyphens only.' }));
        } else {
          const skillDir = path.join(WORKSPACE, '.claude', 'skills', name);
          if (!skillDir.startsWith(path.resolve(WORKSPACE))) {
            ws.send(JSON.stringify({ type: 'skill_error', message: 'Invalid path.' }));
          } else {
            if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true });
            const filePath = path.join(skillDir, 'SKILL.md');
            const existed = fs.existsSync(filePath);
            fs.writeFileSync(filePath, msg.content, 'utf-8');
            console.log(`[Skill] ${existed ? 'Updated' : 'Created'}: ${name}`);
            ws.send(JSON.stringify({ type: 'skill_saved', skillId: name, updated: existed }));
            const updatedAgents = discoverAgents();
            ws.send(JSON.stringify({ type: 'skills', skills: discoverSkills(updatedAgents) }));
            flagRosterRefresh();
          }
        }
      }

      if (msg.type === 'delete_skill') {
        const name = msg.name;
        if (!validateAgentSlug(name)) {
          ws.send(JSON.stringify({ type: 'skill_error', message: 'Invalid skill name.' }));
        } else {
          const skillDir = path.join(WORKSPACE, '.claude', 'skills', name);
          if (!skillDir.startsWith(path.resolve(WORKSPACE)) || !fs.existsSync(skillDir)) {
            ws.send(JSON.stringify({ type: 'skill_error', message: `Skill "${name}" not found.` }));
          } else {
            fs.rmSync(skillDir, { recursive: true });
            console.log(`[Skill] Deleted: ${name}`);
            ws.send(JSON.stringify({ type: 'skill_deleted', skillId: name }));
            const updatedAgents = discoverAgents();
            ws.send(JSON.stringify({ type: 'skills', skills: discoverSkills(updatedAgents) }));
            flagRosterRefresh();
          }
        }
      }

      if (msg.type === 'get_session_history') {
        const { sessionId, conversationId, limit, offset } = msg;
        const jsonlPath = getSessionJsonlPath(sessionId);
        parseSessionHistory(sessionId, limit || 20, offset || 0).then(result => {
          ws.send(JSON.stringify({
            type: 'session_history',
            conversationId,
            messages: result.messages,
            totalCount: result.totalCount,
            hasMore: result.hasMore
          }));
        }).catch(err => {
          console.warn('[Session history] Parse error:', err.message);
          ws.send(JSON.stringify({
            type: 'session_history',
            conversationId,
            messages: [],
            totalCount: 0,
            hasMore: false
          }));
        });
      }

      if (msg.type === 'save_file') {
        const fullPath = path.resolve(WORKSPACE, msg.path);
        if (fullPath.startsWith(path.resolve(WORKSPACE))) {
          fs.writeFileSync(fullPath, msg.content, 'utf-8');
          ws.send(JSON.stringify({ type: 'file_saved', path: msg.path }));
        }
      }
    } catch (e) {
      console.error('Error handling message:', e);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
    connectedClients.delete(ws);
    // Don't kill processes: they survive reconnects.
    // If no clients remain, safeSend will buffer output until the next connection.
  });
});

// ===== SKILL DISCOVERY =====

function discoverSkills(existingAgents) {
  const skills = [];
  const agents = existingAgents || discoverAgents();
  const agentsDir = path.join(WORKSPACE, '.claude', 'agents');

  // Read full body text of each on-team agent (after frontmatter, not CLAUDE.md)
  const agentBody = {};
  for (const agent of agents.filter(a => a.status === 'onTeam' && a.fileName)) {
    try {
      const content = fs.readFileSync(path.join(agentsDir, agent.fileName), 'utf-8');
      const bodyMatch = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)/);
      agentBody[agent.id] = bodyMatch ? bodyMatch[1].toLowerCase() : '';
    } catch (e) { agentBody[agent.id] = ''; }
  }

  // Scan multiple skill locations
  const sources = [
    { dir: path.join(WORKSPACE, 'System', 'Playbooks'), defFile: 'PLAYBOOK.md', sourceLabel: 'System/Playbooks' },
    { dir: path.join(WORKSPACE, '.claude', 'skills'), defFile: 'SKILL.md', sourceLabel: '.claude/skills' },
  ];

  for (const source of sources) {
    if (!fs.existsSync(source.dir)) continue;
    const dirs = fs.readdirSync(source.dir, { withFileTypes: true }).filter(d => d.isDirectory());

    for (const dir of dirs) {
      const defPath = path.join(source.dir, dir.name, source.defFile);
      if (!fs.existsSync(defPath)) continue;

      try {
        const content = fs.readFileSync(defPath, 'utf-8');
        const parsed = parseSkillFile(content, dir.name);

        // Match skill to agents dynamically:
        // Check if the exact slug appears as a distinct reference in the agent's body text.
        // Requires the slug to be bounded by non-word, non-hyphen characters (e.g. backticks,
        // quotes, line start/end, spaces) to avoid false matches from prose.
        const slug = dir.name.toLowerCase();
        const slugPattern = new RegExp('(?<![\\w-])' + slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w-])', 'i');
        const assignedAgents = [];

        for (const agent of agents.filter(a => a.status === 'onTeam')) {
          // Platform agents (Doc) only match rundock-* skills
          if (agent.type === 'platform' && !slug.startsWith('rundock-')) continue;
          // Non-platform agents never match rundock-* skills
          if (agent.type !== 'platform' && slug.startsWith('rundock-')) continue;
          const body = agentBody[agent.id] || '';
          if (slugPattern.test(body)) {
            assignedAgents.push({ id: agent.id, name: agent.displayName, colour: agent.colour, icon: agent.icon });
          }
        }

        skills.push({
          id: dir.name,
          name: parsed.displayName,
          description: parsed.description,
          slug: dir.name,
          source: source.sourceLabel,
          sourcePath: `${source.sourceLabel}/${dir.name}/`,
          filePath: `${source.sourceLabel}/${dir.name}/${source.defFile}`,
          assignedAgents,
          status: assignedAgents.length > 0 ? 'assigned' : 'unassigned'
        });
      } catch (e) {
        console.error(`Error reading skill ${dir.name}:`, e.message);
      }
    }
  }

  // Sort: assigned first, then alphabetical
  skills.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'assigned' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return skills;
}

function parseSkillFile(content, slug) {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  let name = slug;
  let description = '';

  if (fmMatch) {
    const nameMatch = fmMatch[1].match(/^name:\s*(.+)/m);
    if (nameMatch) name = nameMatch[1].trim();

    // Handle multi-line description with > or plain multi-line
    const descMatch = fmMatch[1].match(/description:\s*>?\s*\n((?:\s+.+\n?)+)/);
    if (descMatch) {
      description = descMatch[1].replace(/\n\s*/g, ' ').trim();
    } else {
      const descSingle = fmMatch[1].match(/^description:\s*(.+)/m);
      if (descSingle) description = descSingle[1].trim();
    }
  }

  // Convert slug-style names to title case (preserve known brand casing)
  const brandWords = { linkedin: 'LinkedIn', reddit: 'Reddit', notion: 'Notion', readwise: 'Readwise', granola: 'Granola', api: 'API', oauth: 'OAuth', mcp: 'MCP' };
  const displayName = name === slug
    ? slug.split('-').map(w => brandWords[w.toLowerCase()] || (w.charAt(0).toUpperCase() + w.slice(1))).join(' ')
    : name;

  return { displayName, description };
}

// ===== FILE TREE =====

function getFileTree(dir, prefix = '') {
  const entries = [];
  try {
    const items = fs.readdirSync(dir, { withFileTypes: true })
      .filter(item => !item.name.startsWith('.') && item.name !== 'node_modules')
      .sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });
    for (const item of items) {
      const relativePath = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) {
        entries.push({ type: 'folder', name: item.name, path: relativePath, children: getFileTree(path.join(dir, item.name), relativePath) });
      } else if (item.name.endsWith('.md') || item.name.endsWith('.txt') || item.name.endsWith('.json')) {
        entries.push({ type: 'file', name: item.name, path: relativePath });
      }
    }
  } catch (e) {}
  return entries;
}

// ===== START =====

server.listen(PORT, () => {
  console.log(`\n  Rundock running at http://localhost:${PORT}`);
  if (WORKSPACE) {
    saveRecentWorkspace(WORKSPACE);
    try { scaffoldWorkspace(WORKSPACE); } catch (e) { console.warn('Scaffold warning:', e.message); }
    const agents = discoverAgents();
    const totalRoutines = agents.reduce((sum, a) => sum + (a.routines?.length || 0), 0);
    console.log(`  Workspace: ${WORKSPACE}`);
    console.log(`  Agents: ${agents.map(a => a.displayName).join(', ')}`);
    console.log(`  Routines: ${totalRoutines}`);
    startScheduler();
  } else {
    console.log(`  No workspace set. Waiting for workspace selection.`);
  }
  console.log('');
});
