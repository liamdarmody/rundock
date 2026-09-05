'use strict';
// The HTTP request router: the page and static-asset routes, the JSON API
// (/api/agents, /api/files, file reads), the binary file transport for the
// viewer registry, the review-sidecar write endpoint, and the permission
// hook bridge (/api/permission-request long-poll that becomes a browser
// permission card).
//
// The workspace root is read at USE time via lib/config.js: a workspace
// switch immediately redirects every later file read. Root-owned
// capabilities arrive through wireHttpRouterDeps BY IDENTITY: live-state
// accessors (chatProcesses, pendingPermissionRequests) return the root's
// own maps, never copies. Unwired deps throw at first use.
//
// ROOT_DIR hops from lib/ to the repo (or app.asar) root: public/ and
// node_modules/ live there, exactly as when this code read __dirname in
// server.js.
const fs = require('fs');
const path = require('path');
const { getWorkspace } = require('./config.js');
const { discoverAgents } = require('./agents/discovery.js');
const { crossingCovered } = require('./workspace/boundary.js');
const { recordEvent } = require('./signals.js');
const { resolvePermissionConvoId } = require('../permission-routing.js');

const ROOT_DIR = path.join(__dirname, '..');

const unwired = (name) => () => {
  throw new Error(`lib/http-router: ${name} not wired (call wireHttpRouterDeps at boot)`);
};
const deps = {
  chatProcesses: unwired('chatProcesses'),                         // () => Map (BY IDENTITY)
  pendingPermissionRequests: unwired('pendingPermissionRequests'), // () => Map (BY IDENTITY)
  isInsideWorkspace: unwired('isInsideWorkspace'),
  getFileTreeCached: unwired('getFileTreeCached'),
  getSearchEngine: unwired('getSearchEngine'),
  safeSend: unwired('safeSend'),
  getPermissionTimeoutMs: unwired('getPermissionTimeoutMs'),
};
// The graph endpoint's resolution memo: one entry per link target, valid for
// exactly one cached-tree object. The counter exists for tests, which are the
// only reader: proving "nothing is re-resolved per request" needs a number,
// not an adjective.
let graphMemo = { tree: null, resolved: new Map() };
let graphResolutionCount = 0;
function graphResolutionStats() { return { count: graphResolutionCount }; }

function wireHttpRouterDeps(next) {
  const prev = { ...deps };
  Object.assign(deps, next);
  return prev;
}

const BINARY_FILE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

function handleHttpRequest(req, res) {
  if (req.url === '/' || req.url === '/index.html' || req.url.startsWith('/?') || req.url.startsWith('/index.html?')) {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
    res.end(fs.readFileSync(path.join(ROOT_DIR, 'public', 'index.html')));
  } else if (req.url === '/favicon.svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    res.end(fs.readFileSync(path.join(ROOT_DIR, 'public', 'favicon.svg')));
  } else if (req.url === '/marked.min.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    res.end(fs.readFileSync(path.join(ROOT_DIR, 'node_modules', 'marked', 'lib', 'marked.umd.js')));
  } else if (req.url === '/app.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
    res.end(fs.readFileSync(path.join(ROOT_DIR, 'public', 'app.js')));
  } else if (req.url === '/api/agents') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(discoverAgents()));
  } else if (req.url === '/api/files') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(deps.getFileTreeCached()));
  } else if (req.url === '/api/graph' || req.url.startsWith('/api/graph?')) {
    // The workspace's graph: nodes from the cached tree, edges from the links
    // table, each edge carrying what its target resolves to. Resolution goes
    // through the same resolver every click goes through, and it is MEMOISED
    // PER TREE GENERATION: a target is resolved at most once for a given
    // cached tree object, so a request against an unchanged tree recomputes
    // nothing, and a new tree (the server replaces the cached object when the
    // workspace changes) empties the memo because every answer may have
    // moved. The per-request work is reading the table and looking answers
    // up.
    //
    // No index is a statement, not an error: the search engine is absent on
    // runtimes without node:sqlite, and a consumer is told the capability is
    // missing rather than handed an empty graph indistinguishable from an
    // unlinked workspace.
    try {
      const engine = deps.getSearchEngine();
      if (!engine) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ indexed: false, nodes: [], links: [] }));
        return;
      }
      const resolver = require('../public/views/files.js');
      const tree = deps.getFileTreeCached() || [];
      if (graphMemo.tree !== tree) graphMemo = { tree, resolved: new Map() };
      const resolveOnce = (target) => {
        if (!graphMemo.resolved.has(target)) {
          graphResolutionCount += 1;
          graphMemo.resolved.set(target, resolver.findFileInTree(tree, resolver.wikilinkSearchName(target)));
        }
        return graphMemo.resolved.get(target);
      };
      const nodes = [];
      (function walk(items) {
        for (const item of items) {
          if (item.type === 'file') nodes.push({ path: item.path, name: item.name });
          else if (item.type === 'folder' && item.children) walk(item.children);
        }
      })(tree);
      const links = engine.allLinks().map((link) => ({ ...link, resolved: resolveOnce(link.target) }));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ indexed: true, nodes, links }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String((e && e.message) || e) }));
    }
  } else if (req.url.startsWith('/workspace-file?path=')) {
    // Binary transport for the file-type registry's image and PDF viewers.
    // Allowlist-only; bytes are served raw (the WS read_file path utf-8
    // normalises and would corrupt them). Boundary guard mirrors /api/file.
    // decodeURIComponent throws a URIError on malformed escapes (e.g. a lone
    // '%'); guard it so one bad request cannot take the process down.
    let filePath;
    try { filePath = decodeURIComponent(req.url.split('path=')[1]); }
    catch { res.writeHead(400); res.end('Bad request'); return; }
    const fullPath = path.resolve(getWorkspace(), filePath);
    const mime = BINARY_FILE_TYPES[path.extname(fullPath).toLowerCase()];
    if (mime && deps.isInsideWorkspace(fullPath) && fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      res.writeHead(200, {
        'Content-Type': mime,
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': 'inline',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      });
      res.end(fs.readFileSync(fullPath));
    } else {
      res.writeHead(404);
      res.end('File not found');
    }
  // Review-sidecar writes: the WS save_file path expects existing parent
  // directories; sidecars live under .rundock/reviews/ which is created on
  // first use. Constrained to exactly that directory, flat filenames only.
  } else if (req.method === 'POST' && req.url === '/api/review-sidecar') {
    let body = '';
    let tooBig = false;
    // Cap the accumulated body: an unbounded string is a memory/disk DoS
    // primitive. Review sidecars are small; 4 MB is generous headroom.
    const SIDECAR_MAX_BYTES = 4 * 1024 * 1024;
    req.on('data', chunk => {
      if (tooBig) return;
      body += chunk;
      if (body.length > SIDECAR_MAX_BYTES) {
        tooBig = true;
        body = ''; // release; stop accumulating (remaining chunks are ignored)
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Sidecar too large' }));
      }
    });
    req.on('end', () => {
      if (tooBig) return;
      try {
        const data = JSON.parse(body);
        const relPath = String(data.path || '');
        if (!/^\.rundock\/reviews\/[\w.-]+\.json$/.test(relPath) || typeof data.content !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid sidecar request' }));
          return;
        }
        const fullPath = path.resolve(getWorkspace(), relPath);
        if (!deps.isInsideWorkspace(fullPath)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid path' }));
          return;
        }
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, data.content, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ saved: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request' }));
      }
    });

  } else if (req.url.startsWith('/api/file?path=')) {
    // Guard decodeURIComponent: a malformed escape (lone '%') throws a
    // URIError that would otherwise crash the process (no top-level handler).
    let filePath;
    try { filePath = decodeURIComponent(req.url.split('path=')[1]); }
    catch { res.writeHead(400); res.end('Bad request'); return; }
    const fullPath = path.resolve(getWorkspace(), filePath);
    if (deps.isInsideWorkspace(fullPath) && fs.existsSync(fullPath)) {
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
        // Attribute the request to its conversation. Prefer the hook-supplied
        // id; if empty, resolve from the session's running process so an id-less
        // request is never misattributed to whatever conversation is on screen
        // (L10). Log the genuinely-unattributable case so it is observable.
        const convoId = resolvePermissionConvoId(data.conversation_id, data.session_id, deps.chatProcesses());
        if (!convoId) {
          console.warn(`[Permission] Unattributed request (conversation_id empty, session=${data.session_id || 'none'} unmatched): ${data.tool_name} requestId=${requestId}`);
        }

        // Workspace boundary: a standing folder grant answers without a card,
        // which also keeps granted folders working when no browser is open.
        //
        // EVERY crossing has to be covered, not just the one the request
        // happens to name first. A shell command can reach several places at
        // once, and answering from a grant that covers only the first would
        // let the rest through with no card: the grant was given for one
        // folder and would be silently spending itself on another. The card
        // is raised for the first UNCOVERED crossing, so it names the target
        // the user has not already decided about rather than one they have.
        // The hook is the only producer of boundary requests and always sends
        // `crossings`, so an absent list means none rather than "reconstruct
        // it from resolved_path".
        //
        // `grantable` is false for every shell command, and the reason is the
        // load-bearing one: a folder grant says an agent may touch a folder,
        // while approving a shell request says a command may run. Answering
        // the second from the first would let `rm -rf * ; touch <granted>/x`
        // run with nothing shown, retiring a per-command card that already
        // existed. Grants keep working exactly as before for file access.
        const crossings = Array.isArray(data.crossings) ? data.crossings.filter(c => c && c.path) : [];
        const grantable = data.grantable !== false;
        // crossingCovered (lib/workspace/boundary.js) is AF-3's decision: a
        // crossing the secrets registry names is covered by no stored grant,
        // however broad, so a standing grant over the whole runtime home
        // still cards the credential file that lives inside it.
        const uncovered = grantable ? crossings.filter(c => !crossingCovered(c)) : crossings;
        if (data.boundary && grantable && crossings.length && uncovered.length === 0) {
          console.log(`[Permission] Standing folder grants cover ${crossings.map(c => c.path).join(', ')}: allowed without a card`);
          recordEvent('permission', { conv: convoId || undefined, d: { tool: data.tool_name, decision: 'allow' } });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ allow: true, reason: 'standing-folder-grant' }));
          return;
        }
        const chosen = uncovered[0] || null;
        const boundaryPath = data.boundary ? (chosen ? chosen.path : null) : null;
        const boundaryGrantDir = data.boundary && chosen && chosen.grantDir ? chosen.grantDir : null;

        // Store the pending HTTP response (resolved when user decides)
        deps.pendingPermissionRequests().set(requestId, {
          res,
          conversationId: convoId,
          toolName: data.tool_name,
          toolInput: data.tool_input,
          boundary: !!data.boundary,
          resolvedPath: boundaryPath,
          grantDir: boundaryGrantDir,
          crossings: data.boundary ? uncovered : [],
          timer: setTimeout(() => {
            const pending = deps.pendingPermissionRequests().get(requestId);
            if (pending) {
              deps.pendingPermissionRequests().delete(requestId);
              console.log(`[Permission] Auto-denied (timeout): ${data.tool_name} convo=${convoId} requestId=${requestId}`);
              recordEvent('permission', { conv: convoId, d: { tool: data.tool_name, decision: 'timeout' } });
              // Send denied indicator to browser
              deps.safeSend(JSON.stringify({
                type: 'permission_timeout',
                requestId,
                _conversationId: convoId
              }));
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ allow: false, reason: 'timeout' }));
            }
          }, deps.getPermissionTimeoutMs())
        });

        // Forward to browser as a control_request (existing permission card UI handles this)
        deps.safeSend(JSON.stringify({
          type: 'control_request',
          request_id: requestId,
          request: {
            subtype: 'can_use_tool',
            tool_name: data.tool_name,
            input: data.tool_input || {},
            ...(data.boundary ? { boundary: true, resolved_path: boundaryPath, grant_dir: boundaryGrantDir, crossings: uncovered } : {})
          },
          _conversationId: convoId
        }));

        console.log(`[Permission] Hook request: ${data.tool_name} convo=${convoId} requestId=${requestId}`);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request' }));
      }
    });

  } else if (/^\/[\w-]+\.m?js$/.test(req.url)) {
    // Top-level client modules under public/ (code-language.js, markers.js,
    // and future extracted modules). The pattern allows no slashes and no
    // dots outside the extension, so traversal cannot be expressed; the
    // realpath prefix check guards anything that somehow gets past it.
    // Regression note: code-language.js shipped in 0.10.0 with a script tag
    // but no route, so browsers 404ed it and a defensive fallback in app.js
    // silently masked the loss. The index-html-to-route test pins every
    // script tag to a live route now.
    const publicRoot = path.resolve(ROOT_DIR, 'public');
    const filePath = path.resolve(publicRoot, req.url.slice(1));
    if (filePath.startsWith(publicRoot + path.sep) && fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
      res.end(fs.readFileSync(filePath));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  } else if (/^\/(editor|styles|vendor|viewers|views)\/[\w./-]+\.(m?js|css|woff2)$/.test(req.url)) {
    // Static JS/MJS/CSS files for the Tiptap editor module, its vendor bundle,
    // vendored assets (e.g. highlight.js), the file-type registry, the
    // extracted view modules under /views/, and the stylesheets under
    // /styles/, plus the vendored typeface. Path is constrained to
    // /editor/..., /styles/..., /vendor/..., /viewers/... and /views/... under
    // public/, with only .js/.mjs/.css/.woff2 extensions and only
    // word chars + dot/slash/hyphen in the path. The realpath check below blocks
    // any directory traversal that somehow gets past the regex.
    const publicRoot = path.resolve(ROOT_DIR, 'public');
    const filePath = path.resolve(publicRoot, req.url.slice(1));
    if (filePath.startsWith(publicRoot + path.sep) && fs.existsSync(filePath)) {
      const contentType = filePath.endsWith('.css') ? 'text/css'
        : filePath.endsWith('.woff2') ? 'font/woff2'
        : 'application/javascript';
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache, no-store, must-revalidate' });
      res.end(fs.readFileSync(filePath));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
}

module.exports = {
  graphResolutionStats, wireHttpRouterDeps, handleHttpRequest };
