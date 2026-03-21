/**
 * Rundock Server
 *
 * 1. Discovers agents from .claude/agents/ (including default from cos.md + CLAUDE.md)
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
const WORKSPACE = process.env.WORKSPACE || process.cwd();

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

        const displayName = meta.name || titleCase(id);
        const role = meta.role || titleCase(id);
        const bodyMatch = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)/);
        let instructions = bodyMatch ? bodyMatch[1].trim() : '';

        // If this is the default agent, merge instructions from CLAUDE.md
        if (isDefault && fs.existsSync(claudeMdPath)) {
          instructions = fs.readFileSync(claudeMdPath, 'utf-8').substring(0, 2000);
        }

        const caps = parseCapabilities(fmText);
        const routines = parseRoutines(fmText);

        agents.push({
          id: isDefault ? 'default' : id,
          name: displayName,
          role,
          description: meta.description || '',
          capabilities: caps,
          routines: routines,
          model: meta.model || null,
          order: meta.order ? parseInt(meta.order) : 99,
          instructions: instructions.substring(0, 2000),
          isDefault,
          colour: colours[colourIdx % colours.length],
          icon: icons[colourIdx % icons.length]
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
      agents.unshift({
        id: 'default',
        name: nameMatch ? nameMatch[1].split(/\s*[-]/)[0].trim() : 'Assistant',
        role: 'Default Agent',
        description: '',
        capabilities: null,
        routines: [],
        model: null,
        order: 0,
        instructions: content.substring(0, 2000),
        isDefault: true,
        colour: '#E87A5A',
        icon: '★'
      });
    }
  }

  // Sort: default first, then by order
  agents.sort((a, b) => {
    if (a.isDefault) return -1;
    if (b.isDefault) return 1;
    return (a.order || 99) - (b.order || 99);
  });

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
    // Skip nested blocks (capabilities, routines) - parsed separately
    if (line.match(/^(capabilities|routines):$/)) {
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

// ===== HTTP SERVER =====

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
    res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
  } else if (req.url === '/marked.min.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    res.end(fs.readFileSync(path.join(__dirname, 'node_modules', 'marked', 'lib', 'marked.umd.js')));
  } else if (req.url === '/api/agents') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(discoverAgents()));
  } else if (req.url === '/api/files') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getFileTree(WORKSPACE)));
  } else if (req.url.startsWith('/api/file?path=')) {
    const filePath = decodeURIComponent(req.url.split('path=')[1]);
    const fullPath = path.join(WORKSPACE, filePath);
    if (fs.existsSync(fullPath) && !fullPath.includes('..')) {
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

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('Client connected');
  const processes = new Map(); // conversationId -> { process, buffer }

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

        // Always pass --agent with the agent's display name (from frontmatter)
        // Claude Code uses the frontmatter 'name' field, not the filename
        if (!msg.sessionId) {
          const agentList = discoverAgents();
          const agentData = agentList.find(a => a.id === (msg.agent || 'default'));
          if (agentData && agentData.name) {
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
                ws.send(JSON.stringify(parsed));
              } catch (e) {
                ws.send(JSON.stringify({ type: 'raw', content: line, _agent: msg.agent || 'default', _conversationId: convoId }));
              }
            }
          }
        });

        proc.stderr.on('data', (chunk) => {
          const text = chunk.toString();
          if (text.includes('no stdin data') || text.includes('proceeding without')) return;
          ws.send(JSON.stringify({ type: 'error', content: text, _conversationId: convoId }));
        });

        proc.on('close', (code) => {
          if (entry.buffer.trim()) {
            try {
              const parsed = JSON.parse(entry.buffer);
              parsed._agent = msg.agent || 'default';
              parsed._conversationId = convoId;
              ws.send(JSON.stringify(parsed));
            } catch (e) {
              ws.send(JSON.stringify({ type: 'raw', content: entry.buffer, _conversationId: convoId }));
            }
          }
          ws.send(JSON.stringify({ type: 'system', subtype: 'done', code, _agent: msg.agent || 'default', _conversationId: convoId }));
          processes.delete(convoId);
        });
      }

      if (msg.type === 'get_agents') ws.send(JSON.stringify({ type: 'agents', agents: discoverAgents() }));
      if (msg.type === 'get_files') ws.send(JSON.stringify({ type: 'file_tree', tree: getFileTree(WORKSPACE) }));

      if (msg.type === 'read_file') {
        const fullPath = path.join(WORKSPACE, msg.path);
        if (fs.existsSync(fullPath) && !fullPath.includes('..')) {
          ws.send(JSON.stringify({ type: 'file_content', path: msg.path, content: fs.readFileSync(fullPath, 'utf-8') }));
        }
      }

      if (msg.type === 'save_file') {
        const fullPath = path.join(WORKSPACE, msg.path);
        if (!fullPath.includes('..')) {
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
  const agents = discoverAgents();
  const totalRoutines = agents.reduce((sum, a) => sum + (a.routines?.length || 0), 0);
  console.log(`\n  Rundock running at http://localhost:${PORT}`);
  console.log(`  Workspace: ${WORKSPACE}`);
  console.log(`  Agents: ${agents.map(a => a.name).join(', ')}`);
  console.log(`  Routines: ${totalRoutines}\n`);
  startScheduler();
});
