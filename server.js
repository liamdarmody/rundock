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

const PORT = process.env.PORT || 3000;
let WORKSPACE = process.env.WORKSPACE || null;

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

  const args = ['--print', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions'];
  if (agent.id !== 'default') args.push('--agent', agent.id);
  args.push(routine.prompt);

  const proc = spawn('claude', args, {
    cwd: WORKSPACE,
    env: { ...process.env, TERM: 'dumb' },
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

// ===== WORKSPACE SCAFFOLD =====

function scaffoldWorkspace(dir) {
  try {
    const agentsDir = path.join(dir, '.claude', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });

    // Fast path: if rundock-guide.md already exists, skip agent scaffold
    const guideFile = path.join(agentsDir, 'rundock-guide.md');
    if (!fs.existsSync(guideFile)) {
      // Slow path: check if any existing agent has type: platform in frontmatter
      let hasPlatformAgent = false;
      try {
        const existingFiles = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'));
        for (const file of existingFiles) {
          const content = fs.readFileSync(path.join(agentsDir, file), 'utf-8');
          const fmText = extractFrontmatterText(content);
          if (fmText && /^type:\s*platform\s*$/m.test(fmText)) {
            hasPlatformAgent = true;
            break;
          }
        }
      } catch (e) {}

      if (!hasPlatformAgent) {
        const guideContent = fs.readFileSync(path.join(__dirname, 'scaffold', 'rundock-guide.md'), 'utf-8');
        fs.writeFileSync(guideFile, guideContent, 'utf-8');
        console.log(`  Scaffolded: .claude/agents/rundock-guide.md`);
      }
    }

    // Scaffold skills
    const skillsDir = path.join(dir, '.claude', 'skills');
    const skillTemplates = [
      { slug: 'rundock-workspace-setup', templateFile: 'rundock-workspace-setup.md' },
      { slug: 'rundock-agent-onboarding', templateFile: 'rundock-agent-onboarding.md' }
    ];

    for (const skill of skillTemplates) {
      const skillDir = path.join(skillsDir, skill.slug);
      const skillFile = path.join(skillDir, 'SKILL.md');
      if (!fs.existsSync(skillFile)) {
        fs.mkdirSync(skillDir, { recursive: true });
        const content = fs.readFileSync(path.join(__dirname, 'scaffold', skill.templateFile), 'utf-8');
        fs.writeFileSync(skillFile, content, 'utf-8');
        console.log(`  Scaffolded: .claude/skills/${skill.slug}/SKILL.md`);
      }
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

wss.on('connection', (ws) => {
  console.log('Client connected');
  const processes = new Map(); // conversationId -> { process, buffer }
  function safeSend(data) { if (ws.readyState === 1) ws.send(typeof data === 'string' ? data : JSON.stringify(data)); }

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'chat') {
        const convoId = msg.conversationId || 'default';

        // Kill existing process for this conversation only
        if (processes.has(convoId)) {
          processes.get(convoId).process.kill();
          processes.delete(convoId);
        }

        const args = ['--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', 'bypassPermissions'];

        // Resume existing session if we have a session ID
        if (msg.sessionId) {
          args.push('--resume', msg.sessionId);
        }

        // Pass --agent with the slug name (matches filename, used by Claude Code for resolution)
        if (!msg.sessionId) {
          const agentList = discoverAgents();
          const agentData = agentList.find(a => a.id === (msg.agent || 'default'));
          if (agentData && agentData.id !== 'default' && agentData.fileName) {
            args.push('--agent', agentData.name);
          }
        }

        args.push(msg.content);

        console.log(`[Chat] convo=${convoId} agent=${msg.agent} sessionId=${msg.sessionId||'new'} args=${args.filter(a=>a.startsWith('--')).join(' ')}`);

        const proc = spawn('claude', args, {
          cwd: WORKSPACE,
          env: { ...process.env, TERM: 'dumb' },
          stdio: ['ignore', 'pipe', 'pipe']
        });

        const entry = { process: proc, buffer: '' };
        processes.set(convoId, entry);

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
                // Capture session ID from init message
                if (parsed.type === 'system' && parsed.subtype === 'init' && parsed.session_id) {
                  parsed._sessionId = parsed.session_id;
                }
                safeSend(JSON.stringify(parsed));
              } catch (e) {
                safeSend(JSON.stringify({ type: 'raw', content: line, _agent: msg.agent || 'default', _conversationId: convoId }));
              }
            }
          }
        });

        proc.stderr.on('data', (chunk) => {
          const text = chunk.toString();
          if (text.includes('no stdin data') || text.includes('proceeding without')) return;
          safeSend(JSON.stringify({ type: 'error', content: text, _conversationId: convoId }));
        });

        proc.on('close', (code) => {
          if (entry.buffer.trim()) {
            try {
              const parsed = JSON.parse(entry.buffer);
              parsed._agent = msg.agent || 'default';
              parsed._conversationId = convoId;
              safeSend(JSON.stringify(parsed));
            } catch (e) {
              safeSend(JSON.stringify({ type: 'raw', content: entry.buffer, _conversationId: convoId }));
            }
          }
          safeSend(JSON.stringify({ type: 'system', subtype: 'done', code, _agent: msg.agent || 'default', _conversationId: convoId }));
          processes.delete(convoId);
        });
      }

      if (msg.type === 'get_workspaces') {
        ws.send(JSON.stringify({
          type: 'workspaces',
          current: WORKSPACE,
          recent: loadRecentWorkspaces(),
          discovered: discoverWorkspaces()
        }));
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
          WORKSPACE = dir;
          saveRecentWorkspace(dir);
          try { scaffoldWorkspace(dir); } catch (e) { console.warn('Scaffold warning:', e.message); }
          console.log(`  Workspace changed to: ${WORKSPACE}`);
          ws.send(JSON.stringify({ type: 'workspace_set', path: WORKSPACE }));
          ws.send(JSON.stringify({ type: 'agents', agents: discoverAgents() }));
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
            WORKSPACE = dir;
            saveRecentWorkspace(dir);
            try { scaffoldWorkspace(dir); } catch (e) { console.warn('Scaffold warning:', e.message); }
            console.log(`  Workspace created: ${WORKSPACE}`);
            ws.send(JSON.stringify({ type: 'workspace_set', path: WORKSPACE }));
            ws.send(JSON.stringify({ type: 'agents', agents: discoverAgents() }));
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
    for (const [, entry] of processes) entry.process.kill();
    processes.clear();
  });
});

// ===== SKILL DISCOVERY =====

function discoverSkills() {
  const skills = [];
  const agents = discoverAgents();
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
        // Check if the exact slug appears in the agent's body text
        const slug = dir.name.toLowerCase();
        const assignedAgents = [];

        for (const agent of agents.filter(a => a.status === 'onTeam')) {
          const body = agentBody[agent.id] || '';
          // Look for exact slug reference (e.g. "linkedin-hook-generator" or "hook-generator")
          if (body.includes(slug)) {
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
