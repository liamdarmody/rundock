'use strict';
// Extension confinement in the shipped Electron, with the desktop app's real
// guards (electron/extension-frame-guards.js). Run with:
//
//   npm run test:confinement:electron
//
// The confinement checks in the engine the desktop app is. The page is served
// WITHOUT the app's frame policy, so what is proved here is the Electron
// guards on their own: if the page policy were ever dropped, the desktop app
// would still hold. Safe by construction, like the Chromium spec: every
// listener is on 127.0.0.1, the data is canary text from a temporary folder,
// nothing is installed, and each run uses a fresh in-memory session.
//
// Exits 0 when every expectation holds and 1 otherwise, printing a JSON
// report either way, so the release gate can run it as a step.

// NON-INTERACTIVE: a main-process error exits with its stack instead of
// opening Electron's modal error dialog and waiting for someone to dismiss it.
// (A syntax error in this file is not caught here; `node --check` it first.)
process.on('uncaughtException', (e) => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exit(1); });

const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const harness = require('../helpers/confinement-harness.js');
const tb = require('../helpers/trust-boundary-harness.js');
const { installExtensionFrameGuards } = require('../../electron/extension-frame-guards.js');

const LEFT = 'the extension tried to leave its view and was stopped';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.on('window-all-closed', () => {});

async function run(name, url, { guards = true } = {}) {
  // An in-memory partition: nothing persists after the run.
  const ses = session.fromPartition(`confinement-${name}-${Date.now()}`);
  const win = new BrowserWindow({ show: false, webPreferences: { session: ses } });
  const log = [];
  // The same wiring as electron/main.js, including telling the page.
  if (guards) installExtensionFrameGuards(win.webContents, {
    log: (m) => log.push(m),
    onBlocked: () => { win.webContents.executeJavaScript('window.rundockExtensionFrameLeft && window.rundockExtensionFrameLeft()').catch(() => {}); },
  });
  try { await win.loadURL(url); } catch (e) { log.push(`load: ${e.message}`); }
  await wait(1800);
  const results = await win.webContents.executeJavaScript('window.results || null').catch(() => null);
  win.destroy();
  return { results, log };
}

// A window left open for a sequence of real clicks, with the same guards.
async function openWindow(name, url) {
  const ses = session.fromPartition(`trust-${name}-${Date.now()}`);
  const win = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { session: ses } });
  installExtensionFrameGuards(win.webContents, {
    log: () => {},
    onBlocked: () => { win.webContents.executeJavaScript('window.rundockExtensionFrameLeft && window.rundockExtensionFrameLeft()').catch(() => {}); },
  });
  await win.loadURL(url);
  return win;
}
function childFrame(win) {
  return win.webContents.mainFrame.framesInSubtree.find((f) => f !== win.webContents.mainFrame);
}
async function frameRecord(win) {
  const f = childFrame(win);
  if (!f) return { text: '', messages: [] };
  const text = await f.executeJavaScript("(document.getElementById('seen')||{}).textContent||''", false);
  return { text, messages: JSON.parse(text || '[]') };
}
const pageResults = (win) => win.webContents.executeJavaScript('window.results', false);
// A REAL CLICK. webContents.sendInputEvent does not reach an extension
// frame at all (measured: it lands on the host page's IFRAME element), so a
// pass using it would prove nothing. CDP's input router hit-tests into the
// out-of-process frame the way a real pointer does.
async function realClick(win, x, y) {
  const dbg = win.webContents.debugger;
  if (!dbg.isAttached()) dbg.attach('1.3');
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await dbg.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
    await wait(40);
  }
}
// A REAL KEY PRESS, the same way: CDP's input router delivers it to whatever
// has focus, a frame's own button included.
async function realKey(win, key = 'Enter', code = 13) {
  const dbg = win.webContents.debugger;
  if (!dbg.isAttached()) dbg.attach('1.3');
  await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
  await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'char', key, text: '\r', unmodifiedText: '\r' });
  await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
}
async function clickInFrame(win, id) {
  const frameRect = await win.webContents.executeJavaScript("(()=>{const r=document.querySelector('#pane iframe').getBoundingClientRect();return {x:r.x,y:r.y};})()", false);
  const btn = await childFrame(win).executeJavaScript(`(()=>{const r=document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`, false);
  await realClick(win, Math.round(frameRect.x + btn.x), Math.round(frameRect.y + btn.y));
}
const refusalsOf = (msgs, of) => msgs.filter((m) => m.type === 'refused' && m.of === of);
// Past the browser's activation lifespan, so the next click is a new one.
const NEXT_CLICK_MS = 6000;

// Named sources, asking an agent, and one click per request, in the shipped
// Electron. Each guard has its
// control in which the attack succeeds.
async function trustBoundaryChecks(check, listener) {
  const WATCHED = ['notes/unnamed.csv', '.env', '.mcp.json', '.claude/agents/decoy.md', 'notes/hard-src.txt', '../outside/secret.txt', 'notes/sub.md', 'notes/limits.csv'];
  {
    const world = tb.sourcesWorld(); const before = tb.snapshot(world);
    const srv = await tb.startTrustHarness({ world, listener, framePolicy: false });
    const win = await openWindow('sources', srv.url('sources-probe.js', { writes: true }));
    await wait(1800);
    const s = await frameRecord(win); const r = await pageResults(win); const after = tb.snapshot(world);
    const init = s.messages.find((m) => m.type === 'init') || { sources: [] };
    const handed = init.sources.filter((x) => typeof x.content === 'string').map((x) => x.path);
    check('handed exactly the named files that resolve, on desktop', JSON.stringify(handed) === JSON.stringify(tb.HANDED), handed);
    check('no canary and no real path reached the frame on desktop',
      tb.CANARIES.every((c) => !s.text.includes(c)) && !s.text.includes(world.outside) && !s.text.includes(world.ws), s.text.slice(0, 300));
    check('every hostile source write refused and no other file changed a byte, on desktop',
      refusalsOf(s.messages, 'saveSource').length === 16 && WATCHED.every((f) => after[f] === before[f]) && after['notes/holdings.csv'] === 'ticker,qty\nAAA,11\n',
      { refused: refusalsOf(s.messages, 'saveSource').length });
    check('widening the note by save or change is refused, a body edit is not, on desktop',
      refusalsOf(s.messages, 'save').length === 1 && refusalsOf(s.messages, 'change').length === 1 && r.saved.length === 1, { saved: r.saved.length });
    check('read, readSource, listSources and sources are unknown types, on desktop',
      ['readSource', 'read', 'sources', 'listSources'].every((t) => refusalsOf(s.messages, t).length === 1), null);
    fs.writeFileSync(path.join(world.ws, 'notes', 'limits.csv'), 'limit,value\nmax,0.3\n');
    fs.writeFileSync(path.join(world.ws, 'notes', 'new-unnamed.csv'), 'CANARY-UNNAMED-NEW');
    await wait(1200);
    const s2 = await frameRecord(win);
    const upd = s2.messages.filter((m) => m.type === 'sources');
    const last = upd[upd.length - 1];
    check('a change on disk reaches the view as a sources message, on desktop',
      !!last && last.sources.find((x) => x.path === 'notes/limits.csv').content === 'limit,value\nmax,0.3\n', upd.length);
    check('a new unnamed file never reaches the view, on desktop', !s2.text.includes('CANARY-UNNAMED-NEW'), null);
    win.destroy(); srv.close();
  }
  {
    const world = tb.sourcesWorld(); const before = tb.snapshot(world);
    const srv = await tb.startTrustHarness({ world, listener, framePolicy: false });
    const win = await openWindow('sources-server', srv.url('sources-probe.js', { writes: true, control: 'host-list' }));
    await wait(2000);
    const r = await pageResults(win); const after = tb.snapshot(world);
    check('control: with the host list check removed, the server alone refuses every unlisted write, on desktop',
      r.sourceSaves.length >= 15 && JSON.stringify(r.sourceSaves.filter((x) => x.result.ok).map((x) => x.source)) === '["notes/holdings.csv"]'
        && WATCHED.every((f) => after[f] === before[f]), r.sourceSaves.map((x) => [x.source, x.result.ok]));
    win.destroy(); srv.close();
  }
  {
    const world = tb.sourcesWorld();
    const srv = await tb.startTrustHarness({ world, listener, framePolicy: false });
    const win = await openWindow('list-guard', srv.url('sources-probe.js', { writes: true, control: 'list-guard' }));
    await wait(1500);
    const r = await pageResults(win);
    check('control: without the list rule the widened note is handed to the write, on desktop', r.saved.some((c) => c.includes('notes/unnamed.csv')), r.saved.length);
    win.destroy(); srv.close();
  }
  {
    const world = tb.sourcesWorld();
    const srv = await tb.startTrustHarness({ world, listener, framePolicy: false });
    const win = await openWindow('ask', srv.url('ask-probe.js', { mode: 'ask' }));
    await wait(1200);
    let r = await pageResults(win); let s = await frameRecord(win);
    check('script-sent asks are refused and draft nothing, on desktop', r.asked.length === 0 && refusalsOf(s.messages, 'ask').length === 2, r.asked);
    const n = s.messages.length;
    await clickInFrame(win, 'ask'); await wait(500);
    r = await pageResults(win); s = await frameRecord(win);
    check('a real click drafts one ask, with bidirectional and zero-width characters removed, on desktop',
      r.asked.length === 1 && r.asked[0].message === 'Summarise the risk dneS panel', r.asked);
    check('nothing is posted back on success, on desktop', s.messages.length === n, s.messages.slice(n));
    await wait(NEXT_CLICK_MS);
    await clickInFrame(win, 'burst'); await wait(500);
    r = await pageResults(win);
    check('one real click is one ask, a burst of six drafts one, on desktop', r.asked.length === 2, r.asked.length);
    await wait(NEXT_CLICK_MS);
    await clickInFrame(win, 'ghost'); await wait(500);
    r = await pageResults(win); s = await frameRecord(win);
    check('a declared agent not on the team is refused with a reason, on desktop',
      r.asked.length === 2 && refusalsOf(s.messages, 'ask').some((x) => x.reason === 'there is no agent called ghost on this team'), null);
    await wait(NEXT_CLICK_MS);
    await clickInFrame(win, 'proto'); await wait(500);
    r = await pageResults(win); s = await frameRecord(win);
    check('a prototype name is simply undeclared, on desktop',
      r.asked.length === 2 && refusalsOf(s.messages, 'ask').some((x) => x.reason === 'this extension did not declare that agent in its manifest'), null);
    await wait(NEXT_CLICK_MS);
    await clickInFrame(win, 'shape'); await wait(500);
    r = await pageResults(win);
    check('a malformed ask is refused by shape even after a click, on desktop', r.asked.length === 2, r.asked.length);
    await wait(NEXT_CLICK_MS);
    await clickInFrame(win, 'mixed'); await wait(500);
    r = await pageResults(win);
    check('a malformed first ask uses the click, so a valid one after it drafts nothing, on desktop', r.asked.length === 2, r.asked);
    await wait(NEXT_CLICK_MS);
    await clickInFrame(win, 'opens'); await wait(500);
    r = await pageResults(win);
    check('one click, one request: a burst of opens and web addresses honours exactly one, on desktop',
      r.opened.length + r.externals.length === 1, { opened: r.opened, externals: r.externals });
    win.destroy(); srv.close();
  }
  {
    const world = tb.sourcesWorld();
    const srv = await tb.startTrustHarness({ world, listener, framePolicy: false });
    const win = await openWindow('steal', srv.url('ask-steal-focus.js', { mode: 'deferred-ask' }));
    await wait(500);
    const tree = await win.webContents.executeJavaScript("(()=>{const r=document.getElementById('tree').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()", false);
    await realClick(win, tree.x, tree.y);
    await wait(300);
    const mounted = await win.webContents.executeJavaScript("!!document.querySelector('#pane iframe')", false);
    check('(instrument) the page click mounted the view, on desktop', mounted, null);
    await wait(1500);
    check('a view mounted by a page click cannot use it, even grabbing focus, on desktop', (await pageResults(win)).asked.length === 0, null);
    win.destroy(); srv.close();
  }
  // THE CHAIN: a real click in view A opens a note,
  // the page mounts view B on it, and B takes focus by script and asks to
  // open a file, open a web address and draft, twice, with no click in B.
  // Nothing happens but the bar; with the spend and inherit rule removed,
  // the chain succeeds.
  // The bar's arming, with real input. A real press on Open before the
  // bar is armed does nothing and leaves the request waiting; a real press
  // after it performs the request.
  {
    const world = tb.sourcesWorld();
    const srv = await tb.startTrustHarness({ world, listener, framePolicy: false });
    const win = await openWindow('arming', srv.url('chain-hop.js', { mode: 'chain' }));
    await wait(1200);
    await clickInFrame(win, 'hop');
    let at = null;
    for (let i = 0; i < 100 && !at; i += 1) {
      at = await win.webContents.executeJavaScript("(()=>{const b=document.querySelector('#pane > [data-extension-request=\"confirm\"] .rui-btn-primary');if(!b)return null;const r=b.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()", false);
      if (!at) await wait(10);
    }
    check('(instrument) the bar appeared after the chain, on desktop', !!at, null);
    if (at) {
      await realClick(win, at.x, at.y);
      const early = await win.webContents.executeJavaScript("({ timing: window.timing, opened: window.results.opened.slice(), bar: !!document.querySelector('#pane > [data-extension-request=\"confirm\"]') })", false);
      const press = early.timing.presses[early.timing.presses.length - 1] || {};
      check('a real press on Open before the bar is armed does nothing and leaves the request waiting, on desktop',
        press.onDisabled === true && press.at - early.timing.barShownAt < 400 && JSON.stringify(early.opened) === '["notes/next.md"]' && early.bar,
        { afterBarMs: press.at - early.timing.barShownAt, opened: early.opened, bar: early.bar });
      await wait(600);
      await realClick(win, at.x, at.y);
      await wait(400);
      const late = await pageResults(win);
      check('a real press on Open after the bar is armed performs the request, on desktop',
        JSON.stringify(late.opened) === '["notes/next.md","notes/chained-now.md"]', late.opened);
    }
    win.destroy(); srv.close();
  }
  // ONE USER ACTION, ONE REQUEST, on desktop. A no-activation ask shows the refusal line and
  // never the bar (with the control that routes it to the bar); the ask on
  // the bar drafts only on a press after it arms; a real key press grants one
  // ask while the same view's script-sent ask is refused (with the control
  // that removes the gate).
  for (const control of ['', 'no-activation-bar']) {
    const world = tb.sourcesWorld();
    const srv = await tb.startTrustHarness({ world, listener, framePolicy: false });
    const win = await openWindow(`a1-line-${control || 'real'}`, srv.url('ask-probe.js', { mode: 'ask', control }));
    await wait(1200);
    const r = await pageResults(win);
    const kinds = await win.webContents.executeJavaScript("[...document.querySelectorAll('#pane > [data-extension-request]')].map((e) => e.getAttribute('data-extension-request'))", false);
    if (!control) {
      check('a script-sent ask with no user action is refused and shows the refusal line, never the bar, on desktop',
        r.asked.length === 0 && JSON.stringify(kinds) === '["refused"]', { asked: r.asked, kinds });
    } else {
      check('control: with a no-activation request routed to the person, the bar goes up instead, on desktop', JSON.stringify(kinds) === '["confirm"]', kinds);
    }
    win.destroy(); srv.close();
  }
  {
    const world = tb.sourcesWorld();
    const srv = await tb.startTrustHarness({ world, listener, framePolicy: false });
    const win = await openWindow('a1-ask-bar', srv.url('ask-probe.js', { mode: 'ask' }));
    await wait(1200);
    await clickInFrame(win, 'burst');
    let at = null;
    for (let i = 0; i < 100 && !at; i += 1) {
      at = await win.webContents.executeJavaScript("(()=>{const b=document.querySelector('#pane > [data-extension-request=\"confirm\"] .rui-btn-primary');if(!b)return null;const r=b.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()", false);
      if (!at) await wait(10);
    }
    if (at) {
      await realClick(win, at.x, at.y);
      const early = await win.webContents.executeJavaScript("({ timing: window.timing, asked: window.results.asked.map((a) => a.message) })", false);
      const press = early.timing.presses[early.timing.presses.length - 1] || {};
      check('one user action drafts one ask, and a press on the ask bar before it arms drafts nothing, on desktop',
        press.onDisabled === true && press.at - early.timing.barShownAt < 400 && JSON.stringify(early.asked) === '["burst 0"]', { early: early.asked, afterBarMs: press.at - early.timing.barShownAt });
      await wait(600);
      await realClick(win, at.x, at.y);
      await wait(500);
      const late = (await pageResults(win)).asked.map((a) => a.message);
      check('the person\'s press on the armed ask bar drafts the waiting ask, and nothing else drafts, on desktop', JSON.stringify(late) === '["burst 0","burst 1"]', late);
    } else {
      check('(instrument) the ask bar appeared, on desktop', false, null);
    }
    win.destroy(); srv.close();
  }
  // Control for the early press: with the bar armed from the moment it
  // appears, the same early real press drafts the waiting ask.
  {
    const world = tb.sourcesWorld();
    const srv = await tb.startTrustHarness({ world, listener, framePolicy: false });
    const win = await openWindow('a1-unarmed', srv.url('ask-probe.js', { mode: 'ask', control: 'unarmed' }));
    await wait(1200);
    await clickInFrame(win, 'burst');
    let at = null;
    for (let i = 0; i < 100 && !at; i += 1) {
      at = await win.webContents.executeJavaScript("(()=>{const b=document.querySelector('#pane > [data-extension-request=\"confirm\"] .rui-btn-primary');if(!b)return null;const r=b.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()", false);
      if (!at) await wait(10);
    }
    if (at) await realClick(win, at.x, at.y);
    await wait(500);
    const t = await win.webContents.executeJavaScript('window.timing', false);
    const press = t.presses[t.presses.length - 1] || {};
    const msgs = (await pageResults(win)).asked.map((a) => a.message);
    check('control: with the bar armed from the moment it appears, the same early real press drafts the waiting ask, on desktop',
      !!at && press.at - t.barShownAt < 400 && JSON.stringify(msgs) === '["burst 0","burst 1"]', { msgs, afterBarMs: press.at - t.barShownAt });
    win.destroy(); srv.close();
  }
  // The ask on the bar, armed, answered with a real press: Dismiss tells the
  // view only that it was refused; Open drafts exactly the waiting ask; and
  // the two controls (Open's handler removed, the ask wired to the wrong
  // payload) each produce the wrong outcome that the checks would catch.
  for (const [control, answer] of [['', 'Dismiss'], ['', 'Open'], ['bar-unwired', 'Open'], ['ask-wrong-payload', 'Open'], ['dismiss-performs', 'Dismiss']]) {
    const world = tb.sourcesWorld();
    const srv = await tb.startTrustHarness({ world, listener, framePolicy: false });
    const win = await openWindow(`a1-bar-${control || 'real'}-${answer}`, srv.url('ask-probe.js', { mode: 'ask', control }));
    await wait(1200);
    await clickInFrame(win, 'burst');
    await wait(700);
    const sel = answer === 'Open' ? '.rui-btn-primary' : '.rui-btn-secondary';
    const at = await win.webContents.executeJavaScript(`(()=>{const b=document.querySelector('#pane > [data-extension-request="confirm"] ${sel}');if(!b||b.disabled)return null;const r=b.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`, false);
    const before = (await frameRecord(win)).messages.length;
    if (at) { await realClick(win, at.x, at.y); await wait(600); }
    const asked = (await pageResults(win)).asked;
    const toFrame = (await frameRecord(win)).messages.slice(before);
    const msgs = asked.map((a) => a.message);
    if (!at) check(`(instrument) the armed ask bar was there to press, ${control || 'real'} ${answer}, on desktop`, false, null);
    else if (!control && answer === 'Dismiss') {
      check('Dismiss on the ask bar drafts nothing and tells the view only that it was refused, on desktop',
        JSON.stringify(msgs) === '["burst 0"]' && JSON.stringify(toFrame) === JSON.stringify([{ type: 'refused', of: 'ask', reason: 'you dismissed this in Rundock' }]), { msgs, toFrame });
    } else if (!control) {
      check('the armed Open drafts exactly the waiting ask, agent and message, and tells the view nothing, on desktop',
        JSON.stringify(asked) === JSON.stringify([{ agent: 'analyst', message: 'burst 0' }, { agent: 'analyst', message: 'burst 1' }]) && toFrame.length === 0, { asked, toFrame });
    } else if (control === 'dismiss-performs') {
      check('control: with Dismiss wired to perform the request, Dismiss drafts the waiting ask and tells the view nothing, on desktop',
        JSON.stringify(msgs) === '["burst 0","burst 1"]' && toFrame.length === 0, { msgs, toFrame });
    } else if (control === 'bar-unwired') {
      check('control: with the bar\'s Open handler removed, an armed press drafts nothing, on desktop', JSON.stringify(msgs) === '["burst 0"]', msgs);
    } else {
      check('control: with the ask wired to the wrong payload, the armed press drafts the wrong ask, on desktop', JSON.stringify(msgs) === '["burst 0","burst 0"]', msgs);
    }
    win.destroy(); srv.close();
  }
  for (const control of ['', 'ask-click']) {
    const world = tb.sourcesWorld();
    const srv = await tb.startTrustHarness({ world, listener, framePolicy: false });
    const win = await openWindow(`a1-key-${control || 'real'}`, srv.url('keyboard-ask.js', { mode: 'ask', control }));
    await wait(1200);
    if (!control) {
      const before = (await pageResults(win)).asked.length;
      await realKey(win);
      await wait(500);
      const asked = (await pageResults(win)).asked.map((a) => a.message);
      check('the script-sent ask is refused, and a real key press inside the view grants one ask, on desktop', before === 0 && JSON.stringify(asked) === '["by key"]', { before, asked });
    } else {
      const asked = (await pageResults(win)).asked.map((a) => a.message);
      check('control: without the click gate, the keyboard view\'s script-sent ask drafts on its own, on desktop', JSON.stringify(asked) === '["script-sent"]', asked);
    }
    win.destroy(); srv.close();
  }
  // Each click guard holds on its own. One view's burst on one click is
  // stopped by the spent-activation guard alone; a frame rebuilt during a live
  // click that nothing spent is stopped by the inherited-activation guard
  // alone. Each attack runs with both guards, and with each one removed.
  for (const control of ['', 'spent-only', 'inherit-only']) {
    const world = tb.sourcesWorld();
    const srv = await tb.startTrustHarness({ world, listener, framePolicy: false });
    const win = await openWindow(`burst-${control || 'real'}`, srv.url('ask-probe.js', { mode: 'ask', control }));
    await wait(1200);
    await clickInFrame(win, 'opens'); await wait(600);
    const r = await pageResults(win);
    const honoured = r.opened.length + r.externals.length;
    const want = control === 'spent-only' ? 12 : 1;
    check(`one view's burst on one click honours ${want} with ${control ? `only the ${control === 'spent-only' ? 'spent-activation' : 'inherited-activation'} guard removed` : 'both guards'}, on desktop`, honoured === want, honoured);
    win.destroy(); srv.close();
  }
  for (const control of ['', 'inherit-only', 'spent-only']) {
    const world = tb.sourcesWorld();
    const srv = await tb.startTrustHarness({ world, listener, framePolicy: false });
    const win = await openWindow(`rebuild-${control || 'real'}`, srv.url('rebuild-ride.js', { mode: 'rebuild', control }));
    await wait(1200);
    await clickInFrame(win, 'poke'); await wait(1400);
    const r = await pageResults(win);
    const rebuilt = await childFrame(win).executeJavaScript("!!document.getElementById('grab')", false).catch(() => false);
    const want = control === 'inherit-only' ? '["notes/rebuilt.md"]' : '[]';
    check(`a frame rebuilt during a live click opens ${want === '[]' ? 'nothing' : 'a file'} with ${control ? `only the ${control === 'spent-only' ? 'spent-activation' : 'inherited-activation'} guard removed` : 'both guards'}, on desktop`,
      rebuilt && JSON.stringify(r.opened) === want, { rebuilt, opened: r.opened });
    win.destroy(); srv.close();
  }
  for (const control of ['', 'chain']) {
    const world = tb.sourcesWorld();
    const srv = await tb.startTrustHarness({ world, listener, framePolicy: false });
    const win = await openWindow(`chain-${control || 'real'}`, srv.url('chain-hop.js', { mode: 'chain', control }));
    await wait(1200);
    const hitsBefore = listener.hits.length;
    await clickInFrame(win, 'hop');
    await wait(1800);
    const r = await pageResults(win);
    const bars = await win.webContents.executeJavaScript(
      "[...document.querySelectorAll('#pane > [data-extension-request]')].map((el) => [el.getAttribute('data-extension-request'), el.querySelector('.rui-alert-message').textContent])", false);
    const chainedHits = listener.hits.slice(hitsBefore).filter((u) => u.includes('chained'));
    if (!control) {
      check('the chain: a view opened by another view\'s click opens, fetches and drafts nothing without a click of its own, on desktop',
        JSON.stringify(r.opened) === '["notes/next.md"]' && r.externals.length === 0 && r.asked.length === 0 && chainedHits.length === 0,
        { opened: r.opened, externals: r.externals, asked: r.asked, chainedHits });
      check('the chain: the person is asked about the first request, in the page above the view, on desktop',
        JSON.stringify(bars) === JSON.stringify([['confirm', 'Open chained-now.md?']]), bars);
    } else {
      check('control: with the spend and inherit rule removed, the chain opens, fetches and drafts, on desktop',
        r.opened.length === 3 && r.externals.length === 2 && r.asked.length === 2, { opened: r.opened, externals: r.externals.length, asked: r.asked.length });
    }
    win.destroy(); srv.close();
  }
  for (const [control, button, name, ok] of [
    ['ask-once', 'burst', 'control: without one ask per click, one real click drafts six, on desktop', (r) => r.asked.length === 6],
    ['ask-click', null, 'control: without the click gate, a script-sent ask drafts, on desktop', (r) => r.asked.some((a) => a.message === 'script-sent')],
    ['ask-declared', 'undeclared', 'control: without the declared list, an undeclared agent is drafted to, on desktop', (r) => r.asked.some((a) => a.agent === 'cos')],
    ['click-once', 'opens', 'control: without one request per click, one real click opens the whole burst, on desktop', (r) => r.opened.length === 6],
  ]) {
    const world = tb.sourcesWorld();
    const srv = await tb.startTrustHarness({ world, listener, framePolicy: false });
    const win = await openWindow(control, srv.url('ask-probe.js', { mode: 'ask', control }));
    await wait(1200);
    if (button) { await clickInFrame(win, button); await wait(500); }
    const r = await pageResults(win);
    check(name, ok(r), { asked: r.asked, opened: r.opened });
    win.destroy(); srv.close();
  }
}

// A page with an app-page request and a frame with an opaque origin (the
// shape of an extension frame) making a request of its own. The frame carries
// no policy of its own here, so the only thing that can stop its request is
// the desktop request filter under test.
async function requestPage(listener) {
  const http = require('node:http');
  const frameDoc = `<script>fetch('${listener.url}/frame-request').catch(() => {});</script>`;
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><script>fetch('${listener.url}/app-request').catch(() => {});</script>`
      + `<iframe sandbox="allow-scripts" srcdoc="${frameDoc.replace(/"/g, '&quot;')}"></iframe>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() };
}

// The REAL guard module with its request filter widened to the whole session,
// loaded from a temporary copy, so a check can show it would fail if the
// filter ever stopped being keyed to extension frames.
function widenedGuards() {
  const os = require('node:os');
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'electron', 'extension-frame-guards.js'), 'utf8');
  const guard = '  return isExtensionFrame(details.frame);';
  if (!src.includes(guard)) throw new Error('the request filter no longer matches; update the widened control');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-widened-')), 'guards.js');
  fs.writeFileSync(file, src.replace(guard, '  return true;'));
  return require(file).installExtensionFrameGuards;
}

async function requestFilterChecks(check, listener) {
  const pageSrv = await requestPage(listener);
  const runWith = async (name, install) => {
    const before = listener.hits.length;
    const ses = session.fromPartition(`filter-${name}-${Date.now()}`);
    const win = new BrowserWindow({ show: false, webPreferences: { session: ses } });
    if (install) install(win.webContents, { log: () => {}, onBlocked: () => {} });
    await win.loadURL(pageSrv.url);
    await wait(1200);
    win.destroy();
    return listener.hits.slice(before);
  };
  const guarded = await runWith('guarded', installExtensionFrameGuards);
  check('with the real request filter, an app-page request reaches its host, on desktop', guarded.includes('/app-request'), guarded);
  check('with the real request filter, an extension-frame request is cancelled, on desktop', !guarded.includes('/frame-request'), guarded);
  const open = await runWith('unguarded', null);
  check('control: without the filter the same frame request reaches its host, on desktop', open.includes('/frame-request'), open);
  const widened = await runWith('widened', widenedGuards());
  check('control: with the filter widened to the whole session, the app-page request no longer reaches its host, so the check above would fail',
    !widened.includes('/app-request'), widened);
  pageSrv.close();
}

// On desktop: the update check runs through the updater's own network
// session, and must still reach its host with the guards installed. (An
// agent's WebFetch is proved through a real turn in agentTurnAndLinkChecks.)
async function workflowChecks(check, listener) {
  // Guards installed on a window first, exactly as the app has them.
  const win = new BrowserWindow({ show: false, webPreferences: { session: session.fromPartition(`workflows-${Date.now()}`) } });
  installExtensionFrameGuards(win.webContents, { log: () => {}, onBlocked: () => {} });
  let before;
  before = listener.hits.length;
  const { autoUpdater } = require('electron-updater');
  autoUpdater.forceDevUpdateConfig = true;
  autoUpdater.autoDownload = false;
  autoUpdater.logger = null;
  autoUpdater.on('error', () => {});
  autoUpdater.setFeedURL({ provider: 'generic', url: `${listener.url}/updates` });
  await autoUpdater.checkForUpdates().catch(() => {});
  await wait(500);
  const updateHits = listener.hits.slice(before);
  check('the update check reaches its host while the desktop guards are installed',
    updateHits.some((h) => h.startsWith('/updates/')), updateHits);
  win.destroy();
}

// A REAL AGENT TURN, AND THE MAIN WINDOW'S EXTERNAL LINKS, run last because
// booting the real server rewrites this process's environment (HOME, PATH).
// The harness boots server.js in this process with a temporary home and
// workspace (so the spawn helper's pid file lands in that workspace) and the
// stub CLI first on PATH; it refuses to run against a real binary. The turn
// goes through Rundock's own chat handling and runtime spawn, and the stub,
// standing in for the model, runs its WebFetch in its own process as the real
// CLI does.
async function agentTurnAndLinkChecks(check, listener) {
  const h = require('../helpers/harness.js');
  const { installExternalLinkGuards } = require('../../electron/external-links.js');
  await h.boot();
  const appUrl = `http://127.0.0.1:${h.port}`;
  const handed = [];
  const win = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { session: session.fromPartition(`app-${Date.now()}`) } });
  // The main window's wiring, as electron/main.js does it.
  installExtensionFrameGuards(win.webContents, { log: () => {}, onBlocked: () => {} });
  installExternalLinkGuards(win.webContents, { appOrigin: appUrl, openExternal: (u) => handed.push(u) });
  await win.loadURL(appUrl);
  await wait(1500);
  try {
    // An agent's WebFetch, through a real Rundock agent turn.
    const client = await h.connect();
    h.writeScenario([{ match: { agent: 'chief-of-staff', promptIncludes: 'fetch the page' }, webFetch: `${listener.url}/webfetch-turn` }]);
    let before = listener.hits.length;
    const invocationsBefore = h.readInvocations().length;
    client.send({ type: 'chat', conversationId: 'webfetch-turn', agent: 'chief-of-staff', content: 'fetch the page' });
    let result = null;
    try { result = (await client.waitFor((m) => m.type === 'result' && m._conversationId === 'webfetch-turn', { timeout: 15000, label: 'turn result' })).msg; } catch (e) { result = null; }
    const spawned = h.readInvocations().slice(invocationsBefore).filter((i) => i.agent === 'chief-of-staff');
    check('an agent\'s WebFetch in a real Rundock turn reaches its host with the desktop guards installed',
      listener.hits.slice(before).includes('/webfetch-turn') && !!result && /WEBFETCH-STATUS 200/.test(result.result || ''),
      { result: result && result.result, hits: listener.hits.slice(before) });
    check('(instrument) Rundock itself spawned the runtime for that turn', spawned.length >= 1, spawned.length);
    client.close();

    // The main window never navigates to an external address; each is handed
    // to the system browser instead.
    const navigatesTo = async (script) => {
      const n = handed.length;
      before = listener.hits.length;
      await win.webContents.executeJavaScript(script).catch(() => {});
      await wait(600);
      return { handed: handed.slice(n), url: win.webContents.getURL(), hits: listener.hits.slice(before) };
    };
    let r = await navigatesTo(`location.href = '${listener.url}/navigate'`);
    check('the main window does not navigate to an external address; it is handed to the system browser',
      r.url.startsWith(appUrl) && JSON.stringify(r.handed) === JSON.stringify([`${listener.url}/navigate`]) && r.hits.length === 0, r);
    r = await navigatesTo(`window.open('${listener.url}/window-open', '_blank')`);
    check('a new window for an external address is denied and handed to the system browser',
      r.url.startsWith(appUrl) && JSON.stringify(r.handed) === JSON.stringify([`${listener.url}/window-open`]) && r.hits.length === 0, r);
    r = await navigatesTo(`location.href = 'file:///etc/hosts'`);
    check('a navigation to any other scheme is stopped and handed to nothing',
      r.url.startsWith(appUrl) && r.handed.length === 0, r);
    // A real click, through CDP input, on a web link a conversation rendered:
    // the page's own rule opens it, and the window hands it out.
    const n = handed.length;
    before = listener.hits.length;
    const rect = await win.webContents.executeJavaScript(`(() => {
      document.querySelector('.convo-item') && document.querySelector('.convo-item').click();
      const m = document.getElementById('messages');
      const a = document.createElement('div');
      a.innerHTML = RundockRenderer.renderMarkdown('[outside](${listener.url}/clicked)');
      m.appendChild(a);
      const r = a.querySelector('a').getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    await realClick(win, rect.x, rect.y);
    await wait(800);
    check('a real click on a web link in the app opens it in the system browser, and the window stays',
      win.webContents.getURL().startsWith(appUrl) && JSON.stringify(handed.slice(n)) === JSON.stringify([`${listener.url}/clicked`]) && listener.hits.length === before,
      { handed: handed.slice(n), url: win.webContents.getURL() });
  } finally {
    win.destroy();
    await h.shutdown();
  }
}

// The frame reports Rundock UI before the fixture's first
// statement (see rundockUiProbe in the harness): the library present, every
// factory building, and the injected stylesheet styling them.
function rundockUiPresent(results) {
  const r = results && results.ui && results.ui[0];
  return !!(r && /^\d+\.\d+$/.test(String(r.version)) && r.factories >= 23 && r.made === r.factories && r.primaryFill === 'rgb(193, 87, 41)');
}

async function rundockUiChecks(check, listener, workspace) {
  const h = await harness.startHarness({ workspace, listener, framePolicy: false });
  const broken = await harness.startHarness({ workspace, listener, framePolicy: false, brokenLibrary: true });
  try {
    let before = listener.hits.length;
    const leave = await run('ui-leave', h.url('ui-then-leave.js'));
    check('a view that uses Rundock UI and then leaves with the file reaches nothing on desktop, and ends',
      listener.hits.length === before && rundockUiPresent(leave.results) && leave.results.degraded.includes(LEFT),
      { hits: listener.hits.slice(before), results: leave.results, log: leave.log });

    before = listener.hits.length;
    const every = await run('ui-every', h.url('every-component.js', 'view', { probe: false }));
    check('a frame working every Rundock UI component sends nothing but ready, and reaches nothing',
      every.results && JSON.stringify(every.results.frameMessages) === JSON.stringify(['ready'])
        && every.results.degraded.length === 0 && listener.hits.length === before,
      { results: every.results, hits: listener.hits.slice(before) });

    const embedded = await run('ui-embedded', h.url('ui-then-leave.js', 'embedded'));
    check('an embedded view is built with Rundock UI before its entry runs, and told it is embedded',
      rundockUiPresent(embedded.results) && String(embedded.results.ui[0].bodyClass).includes('rundock-embedded'),
      embedded.results);

    const misuse = await run('ui-misuse', h.url('misuse-component.js'));
    check('a view that misuses a component ends in the plain view with the library\'s reason',
      misuse.results && misuse.results.degraded.length === 1 && /Rundock\.ui\.button: variant must be one of/.test(misuse.results.degraded[0]),
      misuse.results);

    const failed = await run('ui-broken', broken.url('walk-the-workspace.js'));
    check('a library that fails as it installs ends the view with the reason named, and the entry never runs',
      failed.results && failed.results.degraded.length === 1 && /Rundock UI failed to install/.test(failed.results.degraded[0])
        && JSON.stringify(failed.results.frameMessages) === JSON.stringify(['error'])
        && failed.results.ui.length === 0 && failed.results.opened.length === 0,
      failed.results);
  } finally {
    h.close(); broken.close();
  }
}

app.whenReady().then(async () => {
  const report = { electron: process.versions.electron, checks: [] };
  const check = (name, ok, detail) => report.checks.push({ name, ok: !!ok, detail });
  const listener = await harness.startListener();
  const workspace = harness.canaryWorkspace();
  const h = await harness.startHarness({ workspace, listener, framePolicy: false });
  const preview = await harness.startPreviewPage(listener);
  try {
    let before = listener.hits.length;
    const leave = await run('leave', h.url('leave-with-file.js'));
    check('a view leaving with the file reaches nothing on desktop',
      listener.hits.length === before, { hits: listener.hits.slice(before), log: leave.log });
    check('the view ends and says why',
      leave.results && leave.results.degraded.includes(LEFT), leave.results);
    check('that view ran in a frame carrying Rundock UI',
      rundockUiPresent(leave.results), leave.results && leave.results.ui);

    before = listener.hits.length;
    const region = await run('region', h.url('leave-region.js', 'region'));
    check('a region frame leaving with a diagram source reaches nothing on desktop',
      listener.hits.length === before, { hits: listener.hits.slice(before), log: region.log });
    check('the region frame carries Rundock UI too',
      rundockUiPresent(region.results), region.results && region.results.ui);

    const udpBefore = listener.udpPackets.length;
    await run('rtc', h.url('peer-connection.js'));
    check('a peer connection sends nothing on desktop',
      listener.udpPackets.length === udpBefore, { packets: listener.udpPackets.length - udpBefore });

    // The control: the same leaving view with the guards absent does leak,
    // so a pass above is the guards and not a broken instrument.
    before = listener.hits.length;
    await run('control', h.url('leave-with-file.js'), { guards: false });
    check('control: without the desktop guards the same view does leak',
      listener.leaked().length > 0 && listener.hits.length > before, { hits: listener.hits.slice(before) });

    // A same-origin frame, standing in for the HTML file preview and
    // the PDF viewer, is NOT touched by the guards.
    before = listener.hits.length;
    const same = await run('same-origin', preview.url);
    check('a same-origin frame navigating is not blocked by the desktop guards',
      listener.hits.slice(before).includes('/preview-link'), { hits: listener.hits.slice(before), log: same.log });
    await rundockUiChecks(check, listener, workspace);
    await trustBoundaryChecks(check, listener);
    await requestFilterChecks(check, listener);
    await workflowChecks(check, listener);
    await agentTurnAndLinkChecks(check, listener);
  } catch (e) {
    check('run completed', false, String(e && e.stack || e));
  } finally {
    h.close(); preview.close(); listener.close();
  }
  const failed = report.checks.filter((c) => !c.ok);
  report.ok = failed.length === 0;
  process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);
  if (process.env.RUNDOCK_RECORD_EVIDENCE === '1') {
    const out = path.join(__dirname, '..', '..', 'docs', 'evidence', 'trust-boundary', 'electron-confinement.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(report, null, 1)}\n`);
  }
  app.exit(report.ok ? 0 : 1);
});
