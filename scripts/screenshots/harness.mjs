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
// record video to `recordVideoDir`.
export async function newContext(browser, { motion = false, recordVideoDir = null } = {}) {
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE,
    timezoneId: TIMEZONE,
    reducedMotion: motion ? 'no-preference' : 'reduce',
    ...(recordVideoDir ? { recordVideo: { dir: recordVideoDir, size: VIEWPORT } } : {}),
  });
  await ctx.addInitScript(clockScript, FIXED_EPOCH);
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

// Opens a workspace file by relative path through the same read_file path the
// tree row uses, then waits for the editor surface to mount.
export async function openFile(page, relPath) {
  await page.evaluate((p) => {
    if (typeof switchNav === 'function') switchNav('files');
    ws.send(JSON.stringify({ type: 'read_file', path: p }));
  }, relPath);
  await page.waitForTimeout(700);
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

// Waits for web fonts and a short settle before a screenshot.
export async function settle(page, ms = 300) {
  await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
  await page.waitForTimeout(ms);
}
