// Shared Playwright harness helpers for the screenshot pipeline: deterministic
// context setup (fixed clock, UTC timezone, retina viewport), theme control,
// workspace navigation, and client-state seeding. Both capture.mjs (stills) and
// motion.mjs (GIF clips) build on these so the two stay consistent.

import { CURSORS } from './cursors.mjs';

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

// The app symbols the pipeline drives. Asserted once at startup so a future
// Rundock rename fails fast with a named missing symbol, instead of a clip
// quietly producing a broken GIF (an unknown effect type only warns in the app)
// or a shot capturing the wrong thing. Extend these lists when a clip/shot
// starts depending on a new global function or effect executor.
export const APP_CONTRACT = {
  functions: [
    'switchNav', 'openConversation', 'addUserMsg', 'executeEffects', 'openPalette',
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
