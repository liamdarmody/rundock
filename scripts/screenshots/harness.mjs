// Shared Playwright harness helpers for the screenshot pipeline: deterministic
// context setup (fixed clock, fixed timezone, retina viewport), theme control,
// workspace navigation, and client-state seeding. Both capture.mjs (stills) and
// motion.mjs (GIF clips) build on these so the two stay consistent.

import { CURSORS } from './cursors.mjs';

// Locked capture geometry: 1440x900 logical at deviceScaleFactor 2 gives a
// 2880x1800 @2x master.
export const VIEWPORT = { width: 1440, height: 900 };
export const DEVICE_SCALE = 2;

// An extension view is a sandboxed, opaque-origin frame, which Chromium
// isolates into a renderer process of its own. The context's emulated
// deviceScaleFactor does not reach that process, so the frame rasterised at
// 1x and was upscaled into the 2x master: the extension's text read visibly
// softer than the app chrome around it (IMG-08), which the desktop app on a
// retina display does not do. Keeping sandboxed frames in-process, and
// telling every renderer the screen is 2x, draws the frame at the master's
// own resolution. Neither touches the frame's sandbox or its opaque origin.
export const BROWSER_ARGS = [
  '--disable-features=IsolateSandboxedIframes',
  `--force-device-scale-factor=${DEVICE_SCALE}`,
];

// Fixed "now" for the whole run, so relative labels ("2h ago", "Yesterday",
// "09:30") never shimmer between runs. Paired with a fixed zone so the local
// time formatters resolve identically on any machine.
export const FIXED_EPOCH = Date.UTC(2026, 6, 18, 12, 0, 0); // 2026-07-18T12:00:00Z
// One zone for the browser AND the server (serve.mjs sets the server's TZ to
// it). The scheduler reads a schedule's "8:00am" in the server's zone and the
// page shows the next run in the browser's, so with the browser on UTC and
// the server on the capture machine's zone every row read an hour off its own
// schedule. Europe/London because the seeded run history is written against
// it (08:00 BST is 07:00Z).
export const TIMEZONE = 'Europe/London';

// Injected before any page script runs: freezes Date.now()/new Date() to
// FIXED_EPOCH while leaving explicit-argument parsing and timers intact.
function clockScript(fixed) {
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(fixed); else super(...args); }
    static now() { return fixed; }
  }
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  // eslint-disable-next-line no-global-assign
  window.Date = FakeDate;
}

// Stills: kill every animation and transition, hide scrollbars, hide the text
// caret. Applied as an init style so it is present from first paint.
export const STILL_CSS = `
  *,*::before,*::after{animation:none!important;transition:none!important;animation-duration:0s!important;animation-delay:0s!important;caret-color:transparent!important}
  ::-webkit-scrollbar{width:0!important;height:0!important;display:none!important}
  *{scrollbar-width:none!important}
  #connection-bar,#external-edit-banner{display:none!important}
`;

// Motion: keep animations (the org pulse and streaming type-in must run), just
// hide scrollbars and the caret so clips read clean.
export const MOTION_CSS = `
  ::-webkit-scrollbar{width:0!important;height:0!important;display:none!important}
  *{scrollbar-width:none!important;caret-color:transparent!important}
  #connection-bar,#external-edit-banner{display:none!important}
`;

// Creates a deterministic context. `motion:true` keeps animations and can
// record video to `recordVideoDir`. `theme` boots the app already in light or
// dark (the client reads localStorage on load), so a clip never flips theme
// mid-recording. `viewport` and `deviceScaleFactor` default to the locked
// marketing geometry; look-view passes its own.
export async function newContext(browser, {
  motion = false, recordVideoDir = null, theme = 'dark', viewport = VIEWPORT, deviceScaleFactor = DEVICE_SCALE,
} = {}) {
  const ctx = await browser.newContext({
    viewport,
    deviceScaleFactor,
    timezoneId: TIMEZONE,
    reducedMotion: motion ? 'no-preference' : 'reduce',
    ...(recordVideoDir ? { recordVideo: { dir: recordVideoDir, size: viewport } } : {}),
  });
  await ctx.addInitScript(clockScript, FIXED_EPOCH);
  await ctx.addInitScript((t) => { try { localStorage.setItem('rundock-theme', t); } catch { /* ignore */ } }, theme);
  const css = motion ? MOTION_CSS : STILL_CSS;
  await ctx.addInitScript((c) => {
    const apply = () => {
      const s = document.createElement('style');
      s.id = '__capture_css__';
      s.textContent = c;
      (document.head || document.documentElement).appendChild(s);
    };
    if (document.head) apply(); else document.addEventListener('DOMContentLoaded', apply);
  }, css);
  return ctx;
}

// Navigates to the app and waits for the workspace to connect (nav revealed)
// and the first agents/skills payloads to arrive.
// The desktop app reserves space at the left of the top bar for the macOS
// window controls, which since 0.11.4 live inside that bar rather than in a
// strip above it. That reservation comes from computeChromeInsets, which keys
// off window.electronAPI: undefined in a browser, so a plain capture lays the
// bar out with no inset and the centred search field sits slightly left of
// where a real user sees it. Every shot therefore declares the macOS inset, so
// the captured layout matches the product rather than the browser.
export const MAC_CHROME_INSET_LEFT = 88;   // computeChromeInsets MAC_TRAFFIC_LIGHTS
export const TOPBAR_HEIGHT = 60;           // electron/main.js TOPBAR_HEIGHT

// `url` may be a function that yields a fresh link per call (serve.mjs).
export async function gotoWorkspace(page, url) {
  const target = typeof url === 'function' ? await url() : url;
  await page.goto(target, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.nav-item[data-nav="team"]', { state: 'visible', timeout: 20000 });
  await page.evaluate(({ inset, lightY }) => {
    document.documentElement.style.setProperty('--chrome-inset-left', inset + 'px');
    // Draw the macOS window controls into the app's own top bar.
    //
    // On macOS these are drawn by the OS over a window whose title bar is
    // hidden, so they never appear in a browser capture. Since 0.11.4 they sit
    // INSIDE the top bar rather than in a strip above it, so a screenshot
    // without them shows a bar with an unexplained empty gutter at its left.
    //
    // Injecting them here rather than during framing means every asset gets
    // them from one definition: flat masters, self-framed variants, heroes and
    // motion clips alike. Element-scoped crops exclude them for free, because
    // those are captured from a selector that does not contain the top bar.
    //
    // Position is the app's own (electron/main.js trafficLightPosition), and
    // the inset above reserves the space they occupy, so they can never
    // collide with the search field. Above everything, because the real ones
    // are drawn by the OS and are never covered by the app's own overlays.
    if (document.getElementById('__mkchrome')) return;
    const wrap = document.createElement('div');
    wrap.id = '__mkchrome';
    Object.assign(wrap.style, {
      position: 'fixed', left: '20px', top: lightY + 'px', display: 'flex', gap: '9px',
      zIndex: '2147483646', pointerEvents: 'none',
    });
    for (const colour of ['#ff5f57', '#febc2e', '#28c840']) {
      const dot = document.createElement('span');
      Object.assign(dot.style, {
        width: '12px', height: '12px', borderRadius: '50%', background: colour,
      });
      wrap.appendChild(dot);
    }
    document.body.appendChild(wrap);
  }, { inset: MAC_CHROME_INSET_LEFT, lightY: (TOPBAR_HEIGHT - 12) / 2 });
  // Let the initial agents/skills/conversations messages settle.
  await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
  await page.waitForTimeout(400);
}

// Sets light or dark. Theme is a single class on <body> (dark is the default).
export async function setTheme(page, theme) {
  await page.evaluate((t) => {
    document.body.classList.toggle('light', t === 'light');
    if (typeof applyHljsTheme === 'function') applyHljsTheme(t === 'light');
  }, theme);
}

// Org-chart status story (locked by the spec): Dev, Cleo and Reese are working
// (pulsing green); Cody, Ana and Glen were active at varied recent times. Cody
// reports to Dev and Ana to Cleo, so it reads as reports handing back to their
// lead. Times are fixed relative to FIXED_EPOCH (2026-07-18T12:00:00Z), giving
// "2h ago", "25m ago" and "20h ago".
export const ORG_WORKING = ['dev', 'cleo', 'reese'];
export const ORG_LAST_ACTIVE = {
  cody: '2026-07-18T10:00:00.000Z', // 2h ago
  ana: '2026-07-18T11:35:00.000Z',  // 25m ago
  glen: '2026-07-17T16:00:00.000Z', // 20h ago
};

// Seeds three conversations as actively processing so the given agent ids show
// the working (pulsing) state on the org chart and in the sidebar list. Mirrors
// the product's real code path (getWorkingAgentIds reads convoState).
export async function seedWorking(page, agentIds) {
  await page.evaluate((ids) => {
    window.convoState = window.convoState || {};
    ids.forEach((id, i) => { convoState['__seed_' + i] = { isProcessing: true, activeAgentId: id }; });
    if (typeof renderOrgChart === 'function') renderOrgChart();
    if (typeof renderAgentList === 'function') renderAgentList();
  }, agentIds);
}

// Seeds fixed "last active" times on agents so the sidebar list shows varied
// recent states. `entries` is { agentId: isoString }.
export async function seedLastActive(page, entries) {
  await page.evaluate((map) => {
    window.agentLastActivity = window.agentLastActivity || {};
    for (const [id, iso] of Object.entries(map)) {
      agentLastActivity[id] = { time: new Date(iso), label: '' };
    }
    if (typeof renderAgentList === 'function') renderAgentList();
    if (typeof renderOrgChart === 'function') renderOrgChart();
  }, entries);
}

// Zooms the org chart up until the tree nearly fills the panel, so the hero
// does not sit in a third of the frame. The app auto-fits only downward (scale
// capped at 1), so a small team renders small; this bumps orgZoomOffset until
// one more step would overflow, then backs off. Deterministic for a fixed
// roster. Call after the chart has rendered.
export async function fitOrgChart(page, { fill = 0.94 } = {}) {
  await page.evaluate((fill) => {
    const chart = document.getElementById('org-chart');
    if (!chart || typeof renderOrgChart !== 'function') return;
    const layout = () => chart.querySelector('.org-layout');
    const overflows = () => {
      const l = layout();
      if (!l) return true;
      return l.offsetWidth > (chart.clientWidth * fill) || l.offsetHeight > (chart.clientHeight * fill);
    };
    // eslint-disable-next-line no-global-assign
    if (typeof orgZoomOffset === 'undefined') return;
    for (let i = 0; i < 40; i++) {
      if (overflows()) { orgZoomOffset -= 0.08; renderOrgChart(); break; }
      orgZoomOffset += 0.08; renderOrgChart();
    }
  }, fill);
  await page.waitForTimeout(120);
}

// Opens a workspace file by relative path through the same read_file path the
// tree row uses, then waits for the editor surface to mount.
export async function openFile(page, relPath) {
  await page.evaluate((p) => {
    if (typeof switchNav === 'function') switchNav('files');
    ws.send(JSON.stringify({ type: 'read_file', path: p }));
  }, relPath);
  await page.waitForTimeout(700);
  // Re-assert the real "reveal and highlight in the tree" behaviour after the
  // tree has finished any re-render, so the open file shows selected (a bare
  // read_file can race the tree render and lose the highlight).
  await page.evaluate((p) => {
    if (typeof highlightFileInSidebar === 'function') highlightFileInSidebar(p);
  }, relPath);
  await page.waitForTimeout(150);
}

// The app symbols the pipeline drives. Asserted once at startup so a future
// Rundock rename fails fast with a named missing symbol, instead of a clip
// quietly producing a broken GIF (an unknown effect type only warns in the app)
// or a shot capturing the wrong thing. Extend these lists when a clip/shot
// starts depending on a new global function or effect executor.
export const APP_CONTRACT = {
  functions: [
    'switchNav', 'openConversation', 'createConversation', 'addUserMsg', 'executeEffects', 'openPalette',
    'renderOrgChart', 'renderAgentList', 'highlightFileInSidebar', 'showProfile', 'getConvoState',
  ],
  globals: ['ws', 'convoState'],
  effects: [
    'start-streaming-bubble', 'render-stream-text', 'promote-handoff-message',
    'clear-streaming-bubble', 'show-delegation-divider', 'update-chat-header',
  ],
};

// Boots a throwaway page and verifies the app exposes everything in APP_CONTRACT.
// Throws (naming exactly what is missing) so the run aborts before capturing
// broken assets. `typeof` is used throughout so an absent symbol never throws.
export async function assertAppContract(browser, url, log = () => {}) {
  const ctx = await newContext(browser, { theme: 'dark' });
  try {
    const page = await ctx.newPage();
    await gotoWorkspace(page, url);
    const missing = await page.evaluate((c) => {
      const out = { functions: [], globals: [], effects: [] };
      for (const n of c.functions) if (typeof window[n] !== 'function') out.functions.push(n);
      if (typeof ws === 'undefined') out.globals.push('ws');
      if (typeof convoState === 'undefined') out.globals.push('convoState');
      const ex = (typeof EFFECT_EXECUTORS !== 'undefined') ? EFFECT_EXECUTORS : null;
      for (const e of c.effects) if (!ex || !ex[e]) out.effects.push(e);
      return out;
    }, APP_CONTRACT);
    const problems = [
      ...missing.functions.map((n) => `function ${n}()`),
      ...missing.globals.map((n) => `global ${n}`),
      ...missing.effects.map((e) => `effect "${e}"`),
    ];
    if (problems.length) {
      throw new Error(
        'App contract check failed. This Rundock build is missing symbols the '
        + 'screenshot pipeline depends on:\n  - ' + problems.join('\n  - ')
        + '\nUpdate the clips/shots (or APP_CONTRACT in harness.mjs) to match the '
        + 'current app before capturing.',
      );
    }
    log(`      app contract: OK (${APP_CONTRACT.functions.length} functions, ${APP_CONTRACT.effects.length} effects)`);
  } finally {
    await ctx.close();
  }
}

// Injects a synthetic pointer cursor, since Playwright video renders none. The
// pointer-driven clips (a drag, a click) then read as an actual cursor moving.
// Shapes come from the shared macOS cursor set (cursors.mjs): arrow, text
// (I-beam), hand1 (open grab hand), hand2 (pointing hand). Each carries its own
// hotspot, so swapping shape never shifts the point the cursor is aiming at.
export async function installCursor(page) {
  await page.evaluate((CURSORS) => {
    if (document.getElementById('__mkcursor')) return;
    const c = document.createElement('div');
    c.id = '__mkcursor';
    Object.assign(c.style, {
      position: 'fixed', left: '0', top: '0', zIndex: '2147483647', pointerEvents: 'none',
      transform: 'translate(-200px,-200px)',
    });
    document.body.appendChild(c);
    let hx = 0, hy = 0, px = -200, py = -200;
    window.__cursorKind = (kind) => {
      const k = CURSORS[kind] || CURSORS.arrow;
      hx = k.hotspot[0] * k.size; hy = k.hotspot[1] * k.size;
      c.innerHTML = `<svg width="${k.size}" height="${k.size}" viewBox="${k.viewBox}" style="overflow:visible;display:block">${k.svg}</svg>`;
      c.style.transition = 'none';
      c.style.transform = `translate(${px - hx}px, ${py - hy}px)`;
    };
    window.__cursorAt = (x, y, ms) => {
      px = x; py = y;
      c.style.transition = `transform ${ms || 550}ms cubic-bezier(.4,0,.2,1)`;
      c.style.transform = `translate(${x - hx}px, ${y - hy}px)`;
    };
    window.__cursorKind('arrow');
  }, CURSORS);
}

// Moves the synthetic cursor to a point over `ms` milliseconds.
export async function cursorTo(page, x, y, ms = 550) {
  await page.evaluate(({ x, y, ms }) => window.__cursorAt && window.__cursorAt(x, y, ms), { x, y, ms });
}

// Swaps the cursor shape: 'arrow', 'text', 'hand1' (grab), or 'hand2' (point).
export async function cursorKind(page, kind) {
  await page.evaluate((k) => window.__cursorKind && window.__cursorKind(k), kind);
}

// Waits for web fonts and a short settle before a screenshot.
export async function settle(page, ms = 300) {
  await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
  await page.waitForTimeout(ms);
}

// Which themes a run captures. Dark only by default: every placement the
// current shot list feeds is dark. RUNDOCK_CAPTURE_THEMES=light,dark brings
// the light set back without a code change.
export const CAPTURE_THEMES = (process.env.RUNDOCK_CAPTURE_THEMES || 'dark')
  .split(',').map((t) => t.trim()).filter((t) => t === 'light' || t === 'dark');

// RUNDOCK_CAPTURE_ONLY narrows a run to the named shots and clips, by name or
// by shot-list id (e.g. "IMG-03,IMG-04,files"), so one scene can be checked
// without capturing the whole set. Unset, everything runs.
export function selectedForCapture(item) {
  const raw = process.env.RUNDOCK_CAPTURE_ONLY;
  if (!raw) return true;
  const wanted = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return wanted.some((w) => w === String(item.name).toLowerCase() || (item.id && w === item.id.toLowerCase()));
}

// Opens Settings at a section through the rail and the section list, the way
// a person reaches it.
export async function openSettings(page, section) {
  await page.click('.nav-item[data-nav="settings"]');
  await page.click(`.settings-nav-item[data-settings="${section}"]`);
  await page.waitForTimeout(300);
}

// The Map's layout is seeded, so it ends in the same place every run, but it
// arrives over a second or two on d3's timer. Waits until a node has stopped
// moving across several reads.
export async function waitForMapSettled(page, nodePath, { timeoutMs = 20000 } = {}) {
  await page.waitForSelector('#view-map canvas', { state: 'visible', timeout: timeoutMs });
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let still = 0;
  while (Date.now() < deadline) {
    const at = await page.evaluate((p) => (typeof mapNodeScreenPosition === 'function' ? mapNodeScreenPosition(p) : null), nodePath);
    const key = at ? `${at.x.toFixed(1)},${at.y.toFixed(1)}` : null;
    still = key && key === last ? still + 1 : 0;
    if (still >= 4) return at;
    last = key;
    await page.waitForTimeout(250);
  }
  throw new Error(`the map did not settle within ${timeoutMs / 1000}s`);
}

// Redraws Settings at `section` as the desktop app would draw it. A few
// strings depend on whether the page is inside the desktop app
// (window.electronAPI), and a browser capture is not. The flag is present
// only for the one synchronous redraw and removed straight after, so no other
// code path ever sees it.
export async function redrawSettingsAsDesktopApp(page, section) {
  await page.evaluate((s) => {
    const had = Object.prototype.hasOwnProperty.call(window, 'electronAPI');
    if (!had) window.electronAPI = {};
    try { showSettingsSection(s); } finally { if (!had) delete window.electronAPI; }
  }, section);
}

// Runs `fn` with the viewport temporarily taller, for a tile whose subject is
// longer than one screen, then puts the locked geometry back.
export async function withTallViewport(page, height, fn) {
  await page.setViewportSize({ width: VIEWPORT.width, height });
  await page.waitForTimeout(250);
  try { return await fn(); } finally { await page.setViewportSize(VIEWPORT); }
}

// Centres the Map on the given notes. The app's fit frames every node, the
// unlinked ring included, and that ring's few far-flung dots set the bounds,
// so the clusters, which are the picture, sat right of centre with the left
// half of the pane empty. This pans the way a person does, a drag on the
// canvas, until the middle of the given notes' bounding box is the middle of
// the pane. A drag of that length is a pan to the app, never a click, so no
// file opens. Call after waitForMapSettled; afterwards the pointer is parked
// off the canvas (and off the rail, whose tooltip would otherwise show), so
// nothing reads as hovered.
export async function centreMapOn(page, paths) {
  const target = await page.evaluate((list) => {
    const canvas = document.querySelector('#view-map canvas');
    if (!canvas || typeof mapNodeScreenPosition !== 'function') return null;
    const at = list.map((p) => mapNodeScreenPosition(p)).filter(Boolean);
    if (!at.length) return null;
    const xs = at.map((a) => a.x), ys = at.map((a) => a.y);
    const r = canvas.getBoundingClientRect();
    return {
      from: { x: r.left + r.width / 2, y: r.top + r.height / 2 },
      dx: r.left + r.width / 2 - (Math.min(...xs) + Math.max(...xs)) / 2,
      dy: r.top + r.height / 2 - (Math.min(...ys) + Math.max(...ys)) / 2,
    };
  }, paths);
  if (!target) throw new Error('the map has none of the notes to centre on');
  if (Math.abs(target.dx) + Math.abs(target.dy) > 4) {
    await page.mouse.move(target.from.x, target.from.y);
    await page.mouse.down();
    await page.mouse.move(target.from.x + target.dx, target.from.y + target.dy, { steps: 12 });
    await page.mouse.up();
  }
  await parkPointer(page);
  await page.waitForTimeout(200);
}

// Moves the pointer to an empty stretch of the top bar, right of the search
// field, where it hovers nothing: no tooltip, no hovered node, no lit row.
export async function parkPointer(page) {
  const vp = page.viewportSize();
  await page.mouse.move(vp.width - 120, TOPBAR_HEIGHT / 2);
}
