/**
 * Lean MVP Server
 *
 * A Node.js server that:
 * 1. Serves the web UI as a static file
 * 2. Accepts WebSocket connections
 * 3. Spawns Claude Code with stream-json output
 * 4. Pipes messages between browser and Claude Code
 *
 * Usage:
 *   npm install ws
 *   node server.js
 *   Open http://localhost:3000
 *
 * Requirements:
 *   - Claude Code CLI installed and authenticated
 *   - Node.js 18+
 *   - ws package (npm install ws)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const WORKSPACE = process.env.WORKSPACE || process.cwd();

// Serve static files
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
  } else if (req.url === '/api/files') {
    // Return the workspace file tree as JSON
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getFileTree(WORKSPACE)));
  } else if (req.url.startsWith('/api/file?path=')) {
    // Return file contents
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

// WebSocket server
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('Client connected');
  let claudeProcess = null;

  // Spawn Claude Code with stream-json
  function startClaude() {
    claudeProcess = spawn('claude', [
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages'
    ], {
      cwd: WORKSPACE,
      env: { ...process.env, TERM: 'dumb' }
    });

    let buffer = '';

    claudeProcess.stdout.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // Keep incomplete line in buffer

      for (const line of lines) {
        if (line.trim()) {
          try {
            const parsed = JSON.parse(line);
            ws.send(JSON.stringify(parsed));
          } catch (e) {
            // Non-JSON output, send as raw text
            ws.send(JSON.stringify({ type: 'raw', content: line }));
          }
        }
      }
    });

    claudeProcess.stderr.on('data', (data) => {
      ws.send(JSON.stringify({ type: 'error', content: data.toString() }));
    });

    claudeProcess.on('close', (code) => {
      ws.send(JSON.stringify({ type: 'system', subtype: 'process_exit', code }));
      claudeProcess = null;
    });
  }

  // Handle messages from browser
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === 'chat') {
        // Start a new Claude process for each message (print mode)
        if (claudeProcess) {
          claudeProcess.kill();
        }

        claudeProcess = spawn('claude', [
          '--print',
          '--output-format', 'stream-json',
          '--verbose',
          '--include-partial-messages',
          msg.content
        ], {
          cwd: WORKSPACE,
          env: { ...process.env, TERM: 'dumb' },
          stdio: ['ignore', 'pipe', 'pipe']
        });

        let buffer = '';

        claudeProcess.stdout.on('data', (data) => {
          buffer += data.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            if (line.trim()) {
              try {
                const parsed = JSON.parse(line);
                ws.send(JSON.stringify(parsed));
              } catch (e) {
                ws.send(JSON.stringify({ type: 'raw', content: line }));
              }
            }
          }
        });

        claudeProcess.stderr.on('data', (data) => {
          const text = data.toString();
          // Filter out known harmless warnings
          if (text.includes('no stdin data') || text.includes('proceeding without')) return;
          ws.send(JSON.stringify({ type: 'error', content: text }));
        });

        claudeProcess.on('close', (code) => {
          // Flush remaining buffer
          if (buffer.trim()) {
            try {
              ws.send(JSON.stringify(JSON.parse(buffer)));
            } catch (e) {
              ws.send(JSON.stringify({ type: 'raw', content: buffer }));
            }
          }
          ws.send(JSON.stringify({ type: 'system', subtype: 'done', code }));
          claudeProcess = null;
        });
      }

      if (msg.type === 'get_files') {
        ws.send(JSON.stringify({ type: 'file_tree', tree: getFileTree(WORKSPACE) }));
      }

      if (msg.type === 'read_file') {
        const fullPath = path.join(WORKSPACE, msg.path);
        if (fs.existsSync(fullPath) && !fullPath.includes('..')) {
          ws.send(JSON.stringify({
            type: 'file_content',
            path: msg.path,
            content: fs.readFileSync(fullPath, 'utf-8')
          }));
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
    if (claudeProcess) {
      claudeProcess.kill();
    }
  });
});

// Build a simple file tree from a directory
function getFileTree(dir, prefix = '') {
  const entries = [];
  try {
    const items = fs.readdirSync(dir, { withFileTypes: true })
      .filter(item => !item.name.startsWith('.') && item.name !== 'node_modules')
      .sort((a, b) => {
        // Folders first, then files
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

    for (const item of items) {
      const relativePath = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) {
        entries.push({
          type: 'folder',
          name: item.name,
          path: relativePath,
          children: getFileTree(path.join(dir, item.name), relativePath)
        });
      } else if (item.name.endsWith('.md') || item.name.endsWith('.txt') || item.name.endsWith('.json')) {
        entries.push({
          type: 'file',
          name: item.name,
          path: relativePath
        });
      }
    }
  } catch (e) {
    // Skip unreadable directories
  }
  return entries;
}

server.listen(PORT, () => {
  console.log(`\n  Lean MVP running at http://localhost:${PORT}`);
  console.log(`  Workspace: ${WORKSPACE}\n`);
});
