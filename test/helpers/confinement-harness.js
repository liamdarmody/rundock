'use strict';
// The confinement harness: mounts a hostile extension through Rundock's REAL
// host modules, in a real engine, with nothing installed and nothing able to
// leave the machine.
//
// SAFE BY CONSTRUCTION, and each property is checked rather than hoped for:
//
// - Every destination is a listener this file opens on 127.0.0.1. The
//   fixtures under test/fixtures/hostile name no host at all, only the
//   placeholders __LOGGER__ and __UDP__, filled in here at run time
//   (test/unit/confinement-fixtures.test.js fails on any other address).
// - The "file" a hostile view is given is read from a canary workspace this
//   file creates under the system temporary directory, holding fake values,
//   and the harness refuses to run against any folder outside it.
// - Nothing is installed. The page below imports public/extension-host.js and
//   public/region-service.js directly and mounts the fixture itself. No
//   extension record, no install flow, no package.
//
// Used by the Chromium spec (test/e2e/extension-confinement.spec.js) and the
// desktop run (test/electron/confinement.cjs), so both engines see the same
// page, the same fixtures and the same listener.

const http = require('node:http');
const dgram = require('node:dgram');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PAGE_FRAME_POLICY } = require('../../lib/http-router.js');

const ROOT = path.join(__dirname, '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'hostile');

const CANARY_KEY = 'CANARY-NOT-A-REAL-KEY';
const CANARY_CONTENT = 'CANARY-FILE-CONTENT';

// Refuse any workspace that is not inside the system temporary directory.
// Resolved through realpath on both sides, because on macOS the temporary
// directory is itself a symlink, and a string prefix check would compare the
// wrong spellings.
function assertTemporaryWorkspace(dir) {
  const tmp = fs.realpathSync(os.tmpdir());
  let real;
  try { real = fs.realpathSync(dir); } catch (e) { throw new Error(`confinement harness: workspace ${dir} does not exist`); }
  if (!real.startsWith(tmp + path.sep)) {
    throw new Error(`confinement harness: refusing to run against ${real}, which is not under the system temporary directory ${tmp}`);
  }
  return real;
}

function canaryWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-confinement-'));
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { x: { env: { API_KEY: CANARY_KEY } } } }));
  fs.writeFileSync(path.join(dir, '.claude', 'agents', 'decoy.md'), `---\nname: decoy\n---\n${CANARY_CONTENT}\n`);
  fs.writeFileSync(path.join(dir, 'notes', 'q3.csv'), `${CANARY_CONTENT}\n`);
  return assertTemporaryWorkspace(dir);
}

// The stand-in attacker. HTTP and UDP, both on 127.0.0.1, both logging.
async function startListener() {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    res.setHeader('content-type', 'text/html');
    // Talk back the way a real replacement page would, so the host's refusal
    // to answer it is exercised rather than assumed.
    res.end("<script>parent.postMessage({type:'ready'},'*');</script>");
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const udpPackets = [];
  const udp = dgram.createSocket('udp4');
  udp.on('message', () => udpPackets.push(Date.now()));
  await new Promise((r) => udp.bind(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    udp: `127.0.0.1:${udp.address().port}`,
    hits,
    udpPackets,
    leaked: () => hits.filter((h) => h.includes(CANARY_CONTENT) || h.includes(CANARY_KEY)),
    close: () => { server.close(); udp.close(); },
  };
}

function fixtureSource(name, listener) {
  if (!/^[a-z-]+\.(js|html)$/.test(name)) throw new Error(`confinement harness: bad fixture name ${name}`);
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8')
    .replace(/__LOGGER__/g, listener.url)
    .replace(/__UDP__/g, listener.udp);
}

const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };

// RUNDOCK UI IS IN EVERY FRAME, AND EVERY RUN SAYS SO. The host injects the
// library and its stylesheet into every frame it builds, so every hostile run
// here is already a run against a frame carrying it. This makes that
// observable rather than assumed: before a fixture's first statement, the
// frame builds one of every Rundock UI component and reports what it found.
// The report is a message type the host's closed table does not name, so the
// host refuses it like any other stranger's message (the table is unchanged
// by the library, and by this); only the harness page, which is not the host,
// reads it. A run that sets `probe: false` carries no report at all, which is
// how the "a frame using every component posts nothing new" run is taken.
function rundockUiProbe() {
  var ui = window.Rundock && window.Rundock.ui;
  var report = { type: 'rundock-ui-probe', version: null, factories: 0, made: 0, primaryFill: null, bodyClass: document.body ? document.body.className : null };
  if (ui) {
    var calls = {
      button: { label: 'b', variant: 'primary' }, iconButton: { label: 'i' }, card: { title: 'c' }, input: {},
      select: { options: ['a'] }, checkbox: { label: 'x' }, toggle: { label: 't' }, slider: { label: 's' },
      tabs: { label: 't', options: ['a', 'b'] }, table: { columns: [{ key: 'k' }], rows: [{ k: 1 }] }, chip: { label: 'c' },
      emptyState: { title: 'e' }, loading: {}, board: { columns: [{ id: 'a', cards: [{ id: '1' }] }, { id: 'b' }] },
      canvas: { render: function () {} }, meter: { value: 0.2 }, alert: { message: 'm' }, stat: { label: 'l', value: 1 },
      optionList: { label: 'o', options: ['a', 'b'] }, relativeTime: { iso: '2026-01-01T00:00:00Z' }, liveChip: {},
      menu: { label: 'm', items: ['a'] },
    };
    var holder = document.createElement('div');
    holder.hidden = true;
    (document.body || document.documentElement).appendChild(holder);
    report.version = ui.version;
    report.factories = Object.keys(ui).filter(function (k) { return typeof ui[k] === 'function'; }).length;
    Object.keys(calls).forEach(function (k) { holder.appendChild(ui[k](calls[k])); report.made += 1; });
    holder.appendChild(ui.field({ label: 'f', control: ui.input({}) }));
    report.made += 1;
    report.primaryFill = getComputedStyle(holder.querySelector('.rui-btn-primary')).backgroundColor;
    holder.remove();
  }
  parent.postMessage(report, '*');
}
const PROBE = `(${rundockUiProbe.toString()})();\n`;

function page({ entry, content, mode, spendClicks = true, probe = true }) {
  // `deferred` mounts from a click on the page, the way opening a file from
  // the tree does, so a run can test a view that boots inside the window
  // of the person's own click.
  //
  // The page links the same three sheets the app does for its frames, so the
  // host reads the tokens, the floor and Rundock UI's stylesheet off it and
  // builds every frame exactly as the app would.
  const fullEntry = (probe ? PROBE : '') + entry;
  return `<!doctype html><html><head>
<link rel="stylesheet" href="/styles/tokens.css">
<link rel="stylesheet" href="/styles/extension-base.css" media="not all" data-extension-base>
<link rel="stylesheet" href="/styles/rundock-ui.css" data-rundock-ui>
</head><body><button id="tree">notes/q3.csv</button><div id="pane" style="height:300px"></div>
<script src="/host-gestures.js"></script>
<script src="/region-service.js"></script>
<script type="module">
// THE CONTROL for one click, one request: the host is served with its spend
// removed (see the server below), so a run can show the burst gets through
// without it.
import { mountExtension, buildRegionSrcdoc, endViewsForLeaving } from '/extension-host.js${spendClicks ? '' : '?spend=0'}';
// The same hook the app page installs (public/views/files.js), so the
// desktop run can tell this page a frame was stopped from leaving.
window.rundockExtensionFrameLeft = () => { endViewsForLeaving(); window.RundockRegionService.endAllForLeaving(); };
const entry = ${JSON.stringify(fullEntry)};
const content = ${JSON.stringify(content)};
window.results = { degraded: [], opened: [], externals: [], saved: [], unusable: [], rendered: [], windowOpened: [], ui: [], frameMessages: [] };
// What frames said, as the page saw it: every message type from any frame,
// and each Rundock UI report. Read-only; the host's own listener is separate.
window.addEventListener('message', (e) => {
  if (e.source === window || !e.data || typeof e.data !== 'object') return;
  window.results.frameMessages.push(String(e.data.type));
  if (e.data.type === 'rundock-ui-probe') window.results.ui.push(e.data);
});
if (${JSON.stringify(mode)} === 'preview') {
  // The HTML file preview, mounted by the real viewer module, with a web
  // link in it. window.open is recorded rather than performed.
  window.open = (url) => { window.results.windowOpened.push(url); return null; };
  const { mountArtifactPreview } = await import('/viewers/registry.js');
  mountArtifactPreview({ paneElement: document.getElementById('pane'), path: 'notes/page.html', content: entry });
} else if (${JSON.stringify(mode)} === 'region') {
  const svc = window.RundockRegionService.startRegionService({
    doc: document, win: window,
    srcdoc: () => buildRegionSrcdoc({ entry }, document),
    onUnusable: (r) => window.results.unusable.push(r),
    timeoutMs: 4000,
  });
  svc.render(content).then((a) => window.results.rendered.push(a));
} else {
  const mount = () => mountExtension({
    paneElement: document.getElementById('pane'),
    payload: { entry, styles: [] },
    embedded: ${JSON.stringify(mode)} === 'embedded',
    path: 'notes/q3.csv',
    content,
    onDegrade: (r) => window.results.degraded.push(r),
    onOpen: (t) => window.results.opened.push(t),
    onOpenExternal: (u) => window.results.externals.push(u),
    onSave: (c) => window.results.saved.push(c),
  });
  if (${JSON.stringify(mode)} === 'deferred') document.getElementById('tree').addEventListener('click', mount);
  else mount();
}
window.harnessReady = true;
</script></body></html>`;
}

// The page that hosts the mount. `framePolicy` is whether it carries the
// app page's real frame policy (imported from the router, never retyped), so
// a run can prove each layer on its own.
async function startHarness({ workspace, listener, framePolicy = true, spendClicks = true, brokenLibrary = false }) {
  const ws = assertTemporaryWorkspace(workspace);
  const content = fs.readFileSync(path.join(ws, 'notes', 'q3.csv'), 'utf8');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://harness');
    if (url.pathname === '/harness') {
      const headers = { 'content-type': 'text/html' };
      if (framePolicy) headers['Content-Security-Policy'] = PAGE_FRAME_POLICY;
      res.writeHead(200, headers);
      res.end(page({ entry: fixtureSource(url.searchParams.get('fixture'), listener), content, mode: url.searchParams.get('mode') || 'view', spendClicks, probe: url.searchParams.get('probe') !== '0' }));
      return;
    }
    // A library that fails as it installs, for the run that proves a Rundock
    // UI failure ends in the plain view with a named reason. Refused if the
    // line it breaks has moved.
    if (brokenLibrary && url.pathname === '/rundock-ui.js') {
      const src = fs.readFileSync(path.join(PUBLIC, 'rundock-ui.js'), 'utf8');
      const at = "  const doc = win.document;\n";
      if (!src.includes(at)) throw new Error('confinement harness: the broken-library control no longer matches the library');
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(src.replace(at, `${at}  throw new Error('Rundock UI failed to install (harness control)');\n`));
      return;
    }
    // The control: the real host with the one line that spends a click
    // removed, refused if that line has moved.
    if (url.pathname === '/extension-host.js' && url.searchParams.get('spend') === '0') {
      const src = fs.readFileSync(path.join(PUBLIC, 'extension-host.js'), 'utf8');
      const spend = '  state.spent = state.generation;\n';
      if (!src.includes(spend)) throw new Error('confinement harness: the spend control no longer matches the host');
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(src.replace(spend, ''));
      return;
    }
    // The real host modules, served from public/ and nowhere else.
    const file = path.normalize(path.join(PUBLIC, url.pathname));
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); res.end(); return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    url: (fixture, mode = 'view', { probe = true } = {}) => `${base}/harness?fixture=${encodeURIComponent(fixture)}&mode=${mode}${probe ? '' : '&probe=0'}`,
    close: () => server.close(),
  };
}

// A page whose sub-frame carries the page's OWN origin and navigates away:
// the shape of the HTML file preview and the PDF viewer, which the desktop
// guards must leave alone. Scripts are allowed here only so the frame can be
// made to navigate; what the guard keys on is the origin, and this frame's
// origin is the page's, not the opaque "null" an extension frame has.
async function startPreviewPage(listener) {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    const inner = `<script>location.href=${JSON.stringify(`${listener.url}/preview-link`)};</script>`;
    res.end(`<!doctype html><iframe sandbox="allow-same-origin allow-scripts" srcdoc="${inner.replace(/"/g, '&quot;')}"></iframe>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() };
}

module.exports = {
  CANARY_KEY, CANARY_CONTENT, FIXTURES,
  assertTemporaryWorkspace, canaryWorkspace, startListener, startHarness, startPreviewPage, fixtureSource, rundockUiProbe,
};
