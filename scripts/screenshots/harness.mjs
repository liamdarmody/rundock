// Shared Playwright harness helpers for the screenshot pipeline: deterministic
// context setup (fixed clock, UTC timezone, retina viewport), theme control,
// workspace navigation, and client-state seeding. Both capture.mjs (stills) and
// motion.mjs (GIF clips) build on these so the two stay consistent.

// Locked capture geometry: 1440x900 logical at deviceScaleFactor 2 gives a
// 2880x1800 @2x master.
export const VIEWPORT = { width: 1440, height: 900 };
export const DEVICE_SCALE = 2;

// Fixed "now" for the whole run, so relative labels ("2h ago", "Yesterday",
// "09:30") never shimmer between runs. Paired with a UTC timezone so the local
// time formatters resolve identically on any machine.
export const FIXED_EPOCH = Date.UTC(2026, 6, 18, 12, 0, 0); // 2026-07-18T12:00:00Z
export const TIMEZONE = 'UTC';

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
// mid-recording.
export async function newContext(browser, { motion = false, recordVideoDir = null, theme = 'dark' } = {}) {
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE,
    timezoneId: TIMEZONE,
    reducedMotion: motion ? 'no-preference' : 'reduce',
    ...(recordVideoDir ? { recordVideo: { dir: recordVideoDir, size: VIEWPORT } } : {}),
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
export async function gotoWorkspace(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.nav-item[data-nav="team"]', { state: 'visible', timeout: 20000 });
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

// Opens a conversation and puts it into a live "streaming a reply" state by
// driving the same client entry points the WebSocket path uses. Leaves the
// conversation processing (no result frame), so the streaming bubble persists
// for a still or grows chunk by chunk for a clip.
export async function beginStream(page, { convoId, agentId, pid = 'p-stream' }) {
  await page.evaluate(({ convoId, pid }) => {
    if (typeof openConversation === 'function') openConversation(convoId);
    startProcessing(convoId);
    const st = getConvoState(convoId);
    st.activeProcessId = pid;
  }, { convoId, agentId, pid });
  await page.waitForTimeout(400);
}

// Pushes one streaming text delta into the open conversation, exactly as a
// 'stream_event' WebSocket frame would.
export async function pushChunk(page, { convoId, agentId, text, pid = 'p-stream' }) {
  await page.evaluate(({ convoId, agentId, text, pid }) => {
    handle({
      type: 'stream_event', _conversationId: convoId, _processId: pid, _agent: agentId,
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
    });
  }, { convoId, agentId, text, pid });
}

// Injects a synthetic pointer cursor, since Playwright video renders none. The
// pointer-driven clips (a drag, a click) then read as an actual hand moving.
// Three shapes are available via cursorKind(): the default arrow, an open
// "grab" hand (hovering a draggable), and a closed "grabbing" hand (mid-drag).
// Each is positioned by its own hotspot, so swapping shape never shifts the
// point the cursor is aiming at.
export async function installCursor(page) {
  await page.evaluate(() => {
    if (document.getElementById('__mkcursor')) return;
    const c = document.createElement('div');
    c.id = '__mkcursor';
    Object.assign(c.style, {
      position: 'fixed', left: '0', top: '0', zIndex: '2147483647', pointerEvents: 'none',
      transform: 'translate(-140px,-140px)', filter: 'drop-shadow(0 2px 3px rgba(0,0,0,0.35))',
    });
    document.body.appendChild(c);

    const ARROW = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M5 3l14 7-5.6 1.6L10.5 18 5 3z" fill="#131313" stroke="#fff" stroke-width="1.3" stroke-linejoin="round"/></svg>';
    // Hand cursors are stroke shapes, so give each a white halo under a dark
    // core: legible on both light and dark UI, matching the arrow's contrast.
    const handSvg = (paths) => {
      const layer = (stroke, w) => `<g fill="none" stroke="${stroke}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${paths.map((d) => `<path d="${d}"/>`).join('')}</g>`;
      return `<svg width="28" height="28" viewBox="0 0 24 24" style="overflow:visible">${layer('#fff', 3.6)}${layer('#131313', 1.6)}</svg>`;
    };
    const HAND_OPEN = [
      'M18 11V6a2 2 0 0 0-4 0',
      'M14 10V4a2 2 0 0 0-4 0v2',
      'M10 10.5V6a2 2 0 0 0-4 0v8',
      'M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-6-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L9 13',
    ];
    const HAND_GRAB = [
      'M8 13.5V9a2 2 0 0 1 4 0v1',
      'M12 10.5V8.6a2 2 0 0 1 4 0V11',
      'M16 11v-.4a2 2 0 0 1 4 0V15a6 6 0 0 1-6 6h-1.5a6 6 0 0 1-5-2.7l-2-3a2 2 0 0 1 3.1-2.5L12 15',
    ];
    const KINDS = {
      arrow: { hx: 4, hy: 3, svg: ARROW },
      grab: { hx: 13, hy: 6, svg: handSvg(HAND_OPEN) },
      grabbing: { hx: 13, hy: 8, svg: handSvg(HAND_GRAB) },
    };
    let hx = 4, hy = 3, px = -140, py = -140;
    window.__cursorKind = (kind) => {
      const k = KINDS[kind] || KINDS.arrow;
      hx = k.hx; hy = k.hy; c.innerHTML = k.svg;
      c.style.transition = 'none';
      c.style.transform = `translate(${px - hx}px, ${py - hy}px)`;
    };
    window.__cursorAt = (x, y, ms) => {
      px = x; py = y;
      c.style.transition = `transform ${ms || 550}ms cubic-bezier(.4,0,.2,1)`;
      c.style.transform = `translate(${x - hx}px, ${y - hy}px)`;
    };
    window.__cursorKind('arrow');
  });
}

// Moves the synthetic cursor to a point over `ms` milliseconds.
export async function cursorTo(page, x, y, ms = 550) {
  await page.evaluate(({ x, y, ms }) => window.__cursorAt && window.__cursorAt(x, y, ms), { x, y, ms });
}

// Swaps the cursor shape: 'arrow', 'grab' (open hand), or 'grabbing' (closed).
export async function cursorKind(page, kind) {
  await page.evaluate((k) => window.__cursorKind && window.__cursorKind(k), kind);
}

// Waits for web fonts and a short settle before a screenshot.
export async function settle(page, ms = 300) {
  await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
  await page.waitForTimeout(ms);
}
