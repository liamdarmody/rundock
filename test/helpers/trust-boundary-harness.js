'use strict';
// The harness for named sources and asking an agent, built on the
// confinement harness and safe by the same construction: loopback listeners
// only, canary data in a workspace under the system temporary directory,
// nothing installed, hostile fixtures read from test/fixtures/hostile only.
//
// A hostile view is mounted through the REAL host module, its sources
// resolved by the REAL server resolver against the canary workspace, and its
// source writes made by the REAL server write. What the frame received is
// read from the frame's own record; what was written is read from the disk.
//
// Every guard has a CONTROL: the same page with that one guard removed from
// the served host, by an exact string replacement that throws if the host no
// longer contains it, so a control can never silently become a no-op.

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const base = require('./confinement-harness.js');
const { PAGE_FRAME_POLICY } = require('../../lib/http-router.js');
const { resolveSources, saveSource } = require('../../lib/workspace/named-sources.js');

const ROOT = path.join(__dirname, '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const NOTE = 'dash.md';

const CANARIES = ['CANARY-UNNAMED', 'CANARY-ENV', 'CANARY-AGENT', 'CANARY-OUTSIDE', 'CANARY-HARD', 'CANARY-NOT-A-REAL-KEY'];

// The names the dashboard note lists: three that resolve, and one of each
// kind that must not. Every link points inside this run's temporary root.
const LISTED = ['notes/holdings.csv', '"[[notes/limits.csv]]"', 'notes/sub.md', '.env', '../outside/secret.txt',
  'notes/*.csv', 'notes/link-out.csv', 'notes/link-hidden.csv', 'notes/hard.csv', 'DASH.md'];
const HANDED = ['notes/holdings.csv', 'notes/limits.csv', 'notes/sub.md'];

function sourcesWorld() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-sources-')));
  const ws = path.join(root, 'ws');
  const outside = path.join(root, 'outside');
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true }); fs.writeFileSync(path.join(ws, rel), text); };
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'CANARY-OUTSIDE');
  w('.env', 'API_KEY=CANARY-ENV');
  w('.mcp.json', JSON.stringify({ k: 'CANARY-NOT-A-REAL-KEY' }));
  w('.claude/agents/decoy.md', 'CANARY-AGENT');
  w('notes/holdings.csv', 'ticker,qty\nAAA,10\n');
  w('notes/limits.csv', 'limit,value\nmax,0.2\n');
  w('notes/unnamed.csv', 'CANARY-UNNAMED');
  w('notes/hard-src.txt', 'CANARY-HARD');
  fs.linkSync(path.join(ws, 'notes', 'hard-src.txt'), path.join(ws, 'notes', 'hard.csv'));
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(ws, 'notes', 'link-out.csv'));
  fs.symlinkSync(path.join(ws, '.env'), path.join(ws, 'notes', 'link-hidden.csv'));
  w('notes/sub.md', '---\nsources:\n  - notes/limits.csv\n---\nsub\n');
  w(NOTE, `---\nportfolio-dashboard: true\nsources:\n${LISTED.map((n) => `  - ${n}`).join('\n')}\n---\n# Dashboard\n`);
  base.assertTemporaryWorkspace(ws);
  return { root, ws, outside };
}

// Every file whose bytes a run must leave alone, plus the ones it may change.
const WATCHED = ['notes/unnamed.csv', '.env', '.mcp.json', '.claude/agents/decoy.md', 'notes/hard-src.txt',
  'notes/holdings.csv', 'notes/limits.csv', 'notes/sub.md', NOTE];
function snapshot(world) {
  const out = {};
  for (const f of WATCHED) out[f] = fs.readFileSync(path.join(world.ws, f), 'utf8');
  out['../outside/secret.txt'] = fs.readFileSync(path.join(world.outside, 'secret.txt'), 'utf8');
  return out;
}

// Each control removes exactly one guard from the served host.
const CONTROLS = {
  // The click gate on ask: an ask is treated as a fresh click whatever it met.
  'ask-click': ['    const standing = requestStanding(win, frame);\n', "    const standing = of === 'ask' ? 'click' : requestStanding(win, frame);\n"],
  // One click, one ask. The activation is no longer spent by an ask.
  'ask-once': ["    if (standing === 'click') {\n      spendActivation(win);", "    if (standing === 'click') {\n      if (of !== 'ask') spendActivation(win);"],
  // The declared list.
  'ask-declared': ['      const declared = asks.indexOf(data.agent) >= 0;\n', '      const declared = true;\n'],
  // The host's own "is this name on the list" check, so the server
  // alone is shown refusing every unlisted write.
  'host-list': ["      const hit = sources.find((s) => s.path === data.source && typeof s.content === 'string');", "      const hit = { path: data.source, content: '' };"],
  // The host's rule that no write may change a file's sources list.
  'list-guard': ['  return grammar.sameSources(before, after) ? null : grammar.CHANGED_LIST_REASON;', '  return null;'],
  // One activation, one request: nothing spends the activation any more.
  'click-once': ['  state.spent = state.generation;\n', ''],
  // The chain: a view mounted while an activation is live, and one already
  // spent by another view, are both treated as a fresh click of its own.
  // A request with no activation at all is put to the person instead of
  // refused: the control for "a no-activation ask shows the refusal line, not
  // the bar".
  'no-activation-bar': ["  if (!hasUserActivation(win)) {\n    lapsed(activationOf(win));\n    return 'refuse';", "  if (!hasUserActivation(win)) {\n    lapsed(activationOf(win));\n    return 'confirm';"],
  // The ask bar's own path (one ask per click): the bar's Open handler
  // removed, so an armed press does nothing; and the ask handler wired to the
  // wrong payload, so a press drafts an earlier ask instead of the waiting one.
  'bar-unwired': ['        onOpen: () => { if (alive) perform(); },', '        onOpen: () => {},'],
  // The bar's Open armed from the moment it appears, so an early press acts.
  'unarmed': ["  const open = ui.button({ label: 'Open', variant: 'primary', onClick: answer(onOpen), disabled: true });", "  const open = ui.button({ label: 'Open', variant: 'primary', onClick: answer(onOpen) });"],
  // Dismiss wired to perform the request instead of refusing it.
  'dismiss-performs': ["        onDismiss: () => send({ type: 'refused', of, reason: REQUEST_REASONS.dismissed }),", '        onDismiss: () => { if (alive) perform(); },'],
  'ask-wrong-payload': ['          ? opts.onAsk(data.agent, message)', "          ? opts.onAsk(data.agent, 'burst 0')"],
  // Each of the two guards alone: the spent-activation guard, and the
  // inherited-activation guard. Each has its own attack that only it stops.
  'spent-only': ['  if (activationSpent(win) || inheritsActivation(win, frame) ||', '  if (inheritsActivation(win, frame) ||'],
  'inherit-only': ['  if (activationSpent(win) || inheritsActivation(win, frame) ||', '  if (activationSpent(win) ||'],
  'chain': ['  if (activationSpent(win) || inheritsActivation(win, frame) || now - last <= ACTIVATION_LIFESPAN_MS) return \'confirm\';',
    "  if (now - last <= ACTIVATION_LIFESPAN_MS) return 'confirm';"],
};
function hostSource(control) {
  const src = fs.readFileSync(path.join(PUBLIC, 'extension-host.js'), 'utf8');
  if (!control) return src;
  const pair = CONTROLS[control];
  if (!pair) throw new Error(`trust-boundary harness: no control named ${control}`);
  if (!src.includes(pair[0])) throw new Error(`trust-boundary harness: control ${control} no longer matches the host`);
  return src.split(pair[0]).join(pair[1]);
}

function page({ entry, content, mode, writes, control }) {
  // The app's own tokens and Rundock UI's sheet, as the real page loads
  // them, so the host's bar and refusal line above the view are drawn at
  // their real size and a real click lands where the person's would.
  return `<!doctype html><html><head><link rel="stylesheet" href="/styles/tokens.css"><link rel="stylesheet" href="/styles/rundock-ui.css" data-rundock-ui></head>
<body><button id="tree">${NOTE}</button><div id="pane" style="height:400px"></div>
<script src="/host-gestures.js"></script>
<script src="/named-sources-model.js"></script>
<script type="module">
import { mountExtension, endViewsForLeaving } from '/extension-host.js?control=${encodeURIComponent(control || '')}';
window.rundockExtensionFrameLeft = () => endViewsForLeaving();
const entry = ${JSON.stringify(entry)};
const content = ${JSON.stringify(content)};
const mode = ${JSON.stringify(mode)};
window.results = { degraded: [], saved: [], sourceSaves: [], asked: [], opened: [], externals: [], updates: 0 };
// The app's stand-in for asking: team membership is the app's to judge, and
// it answers a reason or nothing. It records what would reach the composer.
const TEAM = ['analyst', 'cos'];
function onAsk(agent, message) {
  if (TEAM.indexOf(agent) < 0) return 'there is no agent called ' + agent + ' on this team';
  window.results.asked.push({ agent, message });
  return null;
}
async function mount() { return mountAt(${JSON.stringify(NOTE)}); }
async function mountAt(at) {
  // 'bare' is a view whose claim was not by marker: the seam hands it no
  // sources whatever the note says, and the host is given none.
  const initial = mode === 'sources' ? await (await fetch('/sources')).json() : { sources: [] };
  let last = JSON.stringify(initial.sources);
  const handle = mountExtension({
    paneElement: document.getElementById('pane'),
    payload: { entry, styles: [], writes: ${writes ? 'true' : 'false'}, sources: mode === 'sources' || mode === 'bare', asks: ['analyst', 'ghost'] },
    path: at,
    content,
    extensionName: 'chain-probe',
    sources: initial.sources,
    onDegrade: (r) => window.results.degraded.push(r),
    onOpen: (t) => {
      window.results.opened.push(t);
      // The chain: the app mounts the note a view opened, in the same pane,
      // exactly as it would; the fixture becomes the second view there.
      if (mode === 'chain' && t === 'notes/next.md' && !window.chained) { window.chained = true; handle.teardown(); mountAt(t); }
    },
    onOpenExternal: (u) => window.results.externals.push(u),
    onSave: (c) => window.results.saved.push(c),
    onChange: (c) => window.results.saved.push(c),
    onSaveSource: async (source, c) => {
      const r = await fetch('/save-source', { method: 'POST', body: JSON.stringify({ source, content: c }) });
      window.results.sourceSaves.push({ source, result: await r.json() });
    },
    onAsk,
  });
  window.handle = handle;
  // Live refresh: the server's watch resolves the whole list again each
  // interval and pushes a changed one, exactly as the product's handler does.
  if (mode === 'sources') setInterval(async () => {
    const next = await (await fetch('/sources')).json();
    const s = JSON.stringify(next.sources);
    if (s !== last) { last = s; window.results.updates += 1; handle.updateSources(next.sources); }
  }, 250);
}
if (mode === 'deferred-ask') document.getElementById('tree').addEventListener('click', mount);
else mount();
// REBUILD: the frame is rebuilt while the person's click inside it is still
// live, by the host's own theme-change rebuild, the way an operating system
// theme change reaches the page: no click or key on the page, and nothing
// spent. The view's own resize is the cue, so the rebuild lands right after a
// click inside it, which the page itself never sees.
if (mode === 'rebuild') {
  const pane = document.getElementById('pane');
  let flipped = false;
  new MutationObserver(() => {
    const f = pane.querySelector('iframe');
    if (!flipped && f && f.style.height === '321px') { flipped = true; document.body.classList.add('light'); }
  }).observe(pane, { subtree: true, attributes: true, attributeFilter: ['style'] });
}
// When the host's bar appeared, and every press on the page, by the page's
// own clock, so a test can show a press landed before the bar was armed.
window.timing = { barShownAt: null, presses: [] };
new MutationObserver(() => {
  if (window.timing.barShownAt === null && document.querySelector('#pane > [data-extension-request="confirm"]')) window.timing.barShownAt = performance.now();
}).observe(document.getElementById('pane'), { childList: true });
document.addEventListener('pointerdown', (e) => window.timing.presses.push({ at: performance.now(), onDisabled: !!(e.target && e.target.disabled) }), true);
window.harnessReady = true;
</script></body></html>`;
}

async function startTrustHarness({ world, listener, framePolicy = true }) {
  const ws = base.assertTemporaryWorkspace(world.ws);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://harness');
    if (url.pathname === '/harness') {
      const headers = { 'content-type': 'text/html; charset=utf-8' };
      if (framePolicy) headers['Content-Security-Policy'] = PAGE_FRAME_POLICY;
      res.writeHead(200, headers);
      res.end(page({
        entry: base.fixtureSource(url.searchParams.get('fixture'), listener),
        content: fs.readFileSync(path.join(ws, NOTE), 'utf8'),
        mode: url.searchParams.get('mode') || 'sources',
        writes: url.searchParams.get('writes') === '1',
        control: url.searchParams.get('control') || '',
      }));
      return;
    }
    if (url.pathname === '/sources') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(resolveSources(ws, NOTE)));
      return;
    }
    if (url.pathname === '/save-source' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let reason;
        try { const m = JSON.parse(body); reason = saveSource(ws, NOTE, m.source, m.content); } catch (e) { reason = String(e.message); }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: reason === null, reason }));
      });
      return;
    }
    if (url.pathname === '/extension-host.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(hostSource(url.searchParams.get('control')));
      return;
    }
    const file = path.normalize(path.join(PUBLIC, url.pathname));
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); res.end(); return;
    }
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    resolve({
      url: (fixture, { mode = 'sources', writes = false, control = '' } = {}) =>
        `${baseUrl}/harness?fixture=${encodeURIComponent(fixture)}&mode=${mode}&writes=${writes ? 1 : 0}&control=${encodeURIComponent(control)}`,
      close: () => server.close(),
    });
  }));
}

// Every symlink and hard link a world plants, and where each resolves: the
// fixture safety test holds every one of them inside the run's root.
function plantedLinks(world) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) out.push({ path: p, target: fs.realpathSync(p) });
      else if (e.isDirectory()) walk(p);
      else if (fs.statSync(p).nlink > 1) out.push({ path: p, target: p });
    }
  };
  walk(world.root);
  return out;
}

module.exports = { CANARIES, HANDED, LISTED, NOTE, sourcesWorld, snapshot, startTrustHarness, plantedLinks, CONTROLS, hostSource,
  startListener: base.startListener };
