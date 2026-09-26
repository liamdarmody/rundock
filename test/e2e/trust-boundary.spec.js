'use strict';
// Named sources and asking an agent, in a real engine (Chromium, browser
// mode), through the REAL host, resolver and source write. What a view
// received is read from its own record; what was written is read from the
// disk. Every guard has a control in which it is removed and the attack
// succeeds, so a pass is the guard holding, not a fixture that never tried.
//
// Safe to run anywhere: see test/helpers/trust-boundary-harness.js.

const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../helpers/trust-boundary-harness.js');

// Tracing off, and no page.evaluate before the moment under test: both run
// script in the page as though the person had clicked (see the confinement
// spec).
test.use({ trace: 'off' });

let listener;
let world;
test.beforeEach(async () => { listener = await h.startListener(); world = h.sourcesWorld(); });
test.afterEach(() => listener.close());

async function seen(page) {
  const text = await page.frameLocator('#pane iframe').locator('#seen').textContent();
  return { text, messages: JSON.parse(text || '[]') };
}
const refusalsOf = (msgs, of) => msgs.filter((m) => m.type === 'refused' && m.of === of);
const EVIDENCE = path.join(__dirname, '..', '..', 'docs', 'evidence', 'trust-boundary');
// Written only when asked (RUNDOCK_RECORD_EVIDENCE=1), so an ordinary run
// never rewrites the committed evidence it would then have to be checked in.
function record(name, data) {
  if (process.env.RUNDOCK_RECORD_EVIDENCE !== '1') return;
  fs.mkdirSync(EVIDENCE, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE, `chromium-${name}.json`), `${JSON.stringify(data, null, 1)}\n`);
}

test.describe('named sources', () => {
  test('the view is handed exactly the named files that resolve; nothing else is learned or written', async ({ page }) => {
    const before = h.snapshot(world);
    const srv = await h.startTrustHarness({ world, listener });
    try {
      await page.goto(srv.url('sources-probe.js', { writes: true }));
      await page.waitForTimeout(1500);
      const { text, messages } = await seen(page);
      const init = messages.find((m) => m.type === 'init');
      const handed = init.sources.filter((s) => typeof s.content === 'string').map((s) => s.path);
      expect(handed).toEqual(h.HANDED);
      for (const s of init.sources) expect(Object.keys(s).sort()).toEqual(typeof s.content === 'string' ? ['content', 'path'] : ['path', 'refused']);
      for (const c of h.CANARIES) expect(text, `the frame never saw ${c}`).not.toContain(c);
      expect(text, 'no real path of the workspace').not.toContain(world.ws);
      expect(text, 'no real path of the outside folder').not.toContain(world.outside);
      expect(refusalsOf(messages, 'saveSource').length, 'fifteen hostile names and the widening write, refused').toBe(16);
      const after = h.snapshot(world);
      for (const f of ['notes/unnamed.csv', '.env', '.mcp.json', '.claude/agents/decoy.md', 'notes/hard-src.txt', '../outside/secret.txt', 'notes/sub.md', 'notes/limits.csv']) {
        expect(after[f], `${f} unchanged, byte for byte`).toBe(before[f]);
      }
      expect(after['notes/holdings.csv'], 'the one listed write landed').toBe('ticker,qty\nAAA,11\n');
      record('sources-handed', { handed, init: init.sources, refusedSaves: refusalsOf(messages, 'saveSource').length });
    } finally { srv.close(); }
  });

  test('no message reads, lists or finds a file; each is refused as an unknown type', async ({ page }) => {
    const srv = await h.startTrustHarness({ world, listener });
    try {
      await page.goto(srv.url('sources-probe.js', { writes: true }));
      await page.waitForTimeout(1200);
      const { messages } = await seen(page);
      for (const t of ['readSource', 'read', 'sources', 'listSources']) expect(refusalsOf(messages, t).length, t).toBe(1);
      const results = await page.evaluate(() => window.results);
      expect(results.opened, 'an open with no click reached nothing').toEqual([]);
      expect(listener.hits).toEqual([]);
    } finally { srv.close(); }
  });

  test('without writes every source write is refused and nothing on disk changes', async ({ page }) => {
    const before = h.snapshot(world);
    const srv = await h.startTrustHarness({ world, listener });
    try {
      await page.goto(srv.url('sources-probe.js', { writes: false }));
      await page.waitForTimeout(1200);
      const { messages } = await seen(page);
      expect(refusalsOf(messages, 'saveSource').length).toBe(17);
      expect(refusalsOf(messages, 'saveSource').every((r) => /did not declare writes/.test(r.reason))).toBe(true);
      expect(h.snapshot(world)).toEqual(before);
    } finally { srv.close(); }
  });

  test('a view cannot widen its note\'s list by save or change, or a source note\'s by saveSource; a body edit is allowed', async ({ page }) => {
    const before = h.snapshot(world);
    const srv = await h.startTrustHarness({ world, listener });
    try {
      await page.goto(srv.url('sources-probe.js', { writes: true }));
      await page.waitForTimeout(1500);
      const { messages } = await seen(page);
      expect(refusalsOf(messages, 'save').map((r) => r.reason)).toEqual(['a view cannot change which files a note lists as sources']);
      expect(refusalsOf(messages, 'change').map((r) => r.reason)).toEqual(['a view cannot change which files a note lists as sources']);
      expect(refusalsOf(messages, 'saveSource').some((r) => r.reason === 'a view cannot change which files a note lists as sources')).toBe(true);
      const results = await page.evaluate(() => window.results);
      expect(results.saved.length, 'only the edit that keeps the list is handed to the write').toBe(1);
      expect(results.saved[0]).toContain('# Dashboard (edited)');
      expect(h.snapshot(world)['notes/sub.md']).toBe(before['notes/sub.md']);
    } finally { srv.close(); }
  });

  test('control: without the host\'s list rule, the widened note is handed to the write', async ({ page }) => {
    const srv = await h.startTrustHarness({ world, listener });
    try {
      await page.goto(srv.url('sources-probe.js', { writes: true, control: 'list-guard' }));
      await page.waitForTimeout(1500);
      const results = await page.evaluate(() => window.results);
      expect(results.saved.some((c) => c.includes('notes/unnamed.csv'))).toBe(true);
    } finally { srv.close(); }
  });

  test('control: with the host\'s list check removed, the server alone refuses every unlisted write, with nothing changed', async ({ page }) => {
    const before = h.snapshot(world);
    const srv = await h.startTrustHarness({ world, listener });
    try {
      await page.goto(srv.url('sources-probe.js', { writes: true, control: 'host-list' }));
      await page.waitForTimeout(2000);
      const results = await page.evaluate(() => window.results);
      const reached = results.sourceSaves;
      expect(reached.length, 'every hostile write reached the server').toBeGreaterThanOrEqual(15);
      expect(reached.filter((r) => r.result.ok).map((r) => r.source)).toEqual(['notes/holdings.csv']);
      const after = h.snapshot(world);
      for (const f of ['notes/unnamed.csv', '.env', '.mcp.json', '.claude/agents/decoy.md', 'notes/hard-src.txt', '../outside/secret.txt', 'notes/sub.md', 'notes/limits.csv']) {
        expect(after[f], f).toBe(before[f]);
      }
      record('sources-server-alone', { reached: reached.map((r) => ({ source: r.source, ok: r.result.ok })) });
    } finally { srv.close(); }
  });

  test('a changed source reaches the view; a new unnamed file never does; the person removes a name', async ({ page }) => {
    const srv = await h.startTrustHarness({ world, listener });
    try {
      await page.goto(srv.url('sources-probe.js', { writes: false }));
      await page.waitForTimeout(800);
      fs.writeFileSync(path.join(world.ws, 'notes', 'limits.csv'), 'limit,value\nmax,0.3\n');
      fs.writeFileSync(path.join(world.ws, 'notes', 'new-unnamed.csv'), 'CANARY-UNNAMED-NEW');
      await page.waitForTimeout(1000);
      let { text, messages } = await seen(page);
      const updates = messages.filter((m) => m.type === 'sources');
      expect(updates.length).toBe(1);
      expect(updates[0].sources.find((s) => s.path === 'notes/limits.csv').content).toBe('limit,value\nmax,0.3\n');
      expect(text).not.toContain('CANARY-UNNAMED-NEW');
      const dash = fs.readFileSync(path.join(world.ws, h.NOTE), 'utf8');
      fs.writeFileSync(path.join(world.ws, h.NOTE), dash.replace('  - notes/holdings.csv\n', ''));
      await page.waitForTimeout(1000);
      ({ messages } = await seen(page));
      const later = messages.filter((m) => m.type === 'sources');
      expect(later.length).toBe(2);
      expect(later[1].sources.map((s) => s.path)).not.toContain('notes/holdings.csv');
    } finally { srv.close(); }
  });

  test('a view whose claim was not by marker is handed an empty list, whatever the note lists', async ({ page }) => {
    const srv = await h.startTrustHarness({ world, listener });
    try {
      await page.goto(srv.url('sources-probe.js', { mode: 'bare', writes: true }));
      await page.waitForTimeout(1000);
      const { text, messages } = await seen(page);
      expect(messages.find((m) => m.type === 'init').sources).toEqual([]);
      expect(text).not.toContain('ticker,qty');
    } finally { srv.close(); }
  });
});

test.describe('ask an agent', () => {
  test('no click is refused; a click drafts one, cleaned, and nothing comes back', async ({ page }) => {
    const srv = await h.startTrustHarness({ world, listener });
    try {
      await page.goto(srv.url('ask-probe.js', { mode: 'ask' }));
      await page.waitForTimeout(900);
      let results = await page.evaluate(() => window.results);
      expect(results.asked, 'script-sent asks drafted nothing').toEqual([]);
      let s = await seen(page);
      expect(refusalsOf(s.messages, 'ask').map((r) => r.reason)).toEqual(['Rundock stopped this because it did not come from your click', 'Rundock stopped this because it did not come from your click']);
      const before = s.messages.length;
      await page.frameLocator('#pane iframe').locator('#ask').click();
      await page.waitForTimeout(400);
      results = await page.evaluate(() => window.results);
      expect(results.asked).toEqual([{ agent: 'analyst', message: 'Summarise the risk dneS panel' }]);
      s = await seen(page);
      expect(s.messages.length, 'the frame\'s own record is unchanged by an honoured ask').toBe(before);
      record('ask-honoured', { asked: results.asked, frameRecord: s.messages });
    } finally { srv.close(); }
  });

  test('control: without the click gate, a script-sent ask drafts', async ({ page }) => {
    const srv = await h.startTrustHarness({ world, listener });
    try {
      await page.goto(srv.url('ask-probe.js', { mode: 'ask', control: 'ask-click' }));
      await page.waitForTimeout(900);
      const results = await page.evaluate(() => window.results);
      expect(results.asked.some((a) => a.message === 'script-sent')).toBe(true);
    } finally { srv.close(); }
  });

  test('a view mounted by a click on the page cannot use that click, even if it grabs focus', async ({ page }) => {
    const srv = await h.startTrustHarness({ world, listener });
    try {
      await page.goto(srv.url('ask-steal-focus.js', { mode: 'deferred-ask' }));
      await page.waitForTimeout(300);
      await page.click('#tree');
      await page.waitForTimeout(1200);
      expect((await page.evaluate(() => window.results)).asked).toEqual([]);
    } finally { srv.close(); }
  });

  test('one click is one ask: a burst of six drafts one', async ({ page }) => {
    const srv = await h.startTrustHarness({ world, listener });
    try {
      await page.goto(srv.url('ask-probe.js', { mode: 'ask' }));
      await page.waitForTimeout(900);
      await page.frameLocator('#pane iframe').locator('#burst').click();
      await page.waitForTimeout(400);
      expect((await page.evaluate(() => window.results)).asked.map((a) => a.message)).toEqual(['burst 0']);
      const s = await seen(page);
      // The second is put to the person in the page's own bar; the rest wait.
      expect(refusalsOf(s.messages, 'ask').filter((r) => r.reason === 'Rundock is already asking you about another request').length).toBe(4);
      await expect(page.locator('#pane > [data-extension-request="confirm"] .rui-alert-message')).toHaveText('Start a conversation with analyst with a drafted message?');
    } finally { srv.close(); }
  });

  test('a malformed first ask still uses the click, so a valid one after it drafts nothing', async ({ page }) => {
    const srv = await h.startTrustHarness({ world, listener });
    try {
      await page.goto(srv.url('ask-probe.js', { mode: 'ask' }));
      await page.waitForTimeout(900);
      await page.frameLocator('#pane iframe').locator('#mixed').click();
      await page.waitForTimeout(400);
      expect((await page.evaluate(() => window.results)).asked).toEqual([]);
      // The valid ask after the malformed one is the person's to answer, never the view's.
      await expect(page.locator('#pane > [data-extension-request="confirm"]')).toHaveCount(1);
    } finally { srv.close(); }
  });

  test('control: without one ask per click, the same click drafts six', async ({ page }) => {
    const srv = await h.startTrustHarness({ world, listener });
    try {
      await page.goto(srv.url('ask-probe.js', { mode: 'ask', control: 'ask-once' }));
      await page.waitForTimeout(900);
      await page.frameLocator('#pane iframe').locator('#burst').click();
      await page.waitForTimeout(400);
      expect((await page.evaluate(() => window.results)).asked.length).toBe(6);
    } finally { srv.close(); }
  });

  for (const [button, reason] of [
    ['ghost', 'there is no agent called ghost on this team'],
    ['undeclared', 'this extension did not declare that agent in its manifest'],
    ['proto', 'this extension did not declare that agent in its manifest'],
  ]) {
    test(`a click that asks ${button} is refused with its reason, and drafts nothing`, async ({ page }) => {
      const srv = await h.startTrustHarness({ world, listener });
      try {
        await page.goto(srv.url('ask-probe.js', { mode: 'ask' }));
        await page.waitForTimeout(900);
        await page.frameLocator('#pane iframe').locator(`#${button}`).click();
        await page.waitForTimeout(400);
        expect((await page.evaluate(() => window.results)).asked).toEqual([]);
        expect(refusalsOf((await seen(page)).messages, 'ask').map((r) => r.reason)).toContain(reason);
      } finally { srv.close(); }
    });
  }

  test('control: without the declared list, an undeclared team agent is drafted to', async ({ page }) => {
    const srv = await h.startTrustHarness({ world, listener });
    try {
      await page.goto(srv.url('ask-probe.js', { mode: 'ask', control: 'ask-declared' }));
      await page.waitForTimeout(900);
      await page.frameLocator('#pane iframe').locator('#undeclared').click();
      await page.waitForTimeout(400);
      expect((await page.evaluate(() => window.results)).asked.map((a) => a.agent)).toEqual(['cos']);
    } finally { srv.close(); }
  });

  test('a malformed ask is refused by shape, even after a click', async ({ page }) => {
    const srv = await h.startTrustHarness({ world, listener });
    try {
      await page.goto(srv.url('ask-probe.js', { mode: 'ask' }));
      await page.waitForTimeout(900);
      await page.frameLocator('#pane iframe').locator('#shape').click();
      await page.waitForTimeout(400);
      expect((await page.evaluate(() => window.results)).asked).toEqual([]);
      expect(refusalsOf((await seen(page)).messages, 'ask').filter((r) => /requires "(agent|message)"|shape|field/.test(r.reason)).length).toBe(3);
    } finally { srv.close(); }
  });
});

// ONE ACTIVATION, ONE REQUEST, ACROSS EVERY FRAME.
// A real click in view A opens a note; the page mounts view B on it; B takes
// focus by script and asks to open a file, open a web address and draft to
// an agent, with no click inside B, twice. Nothing happens but the bar.
test.describe('the chain from one view to the next', () => {
  async function chainRun(page, control) {
    const srv = await h.startTrustHarness({ world, listener });
    try {
      await page.goto(srv.url('chain-hop.js', { mode: 'chain', control }));
      await page.waitForTimeout(900);
      await page.frameLocator('#pane iframe').locator('#hop').click();
      await page.waitForTimeout(1500);
      const results = await page.evaluate(() => window.results);
      const bars = await page.locator('#pane > [data-extension-request]').evaluateAll((els) => els.map((el) => ({
        kind: el.getAttribute('data-extension-request'),
        text: el.querySelector('.rui-alert-message').textContent,
        aboveFrame: !!(el.nextElementSibling && el.nextElementSibling.tagName === 'IFRAME'),
      })));
      const { messages } = await seen(page);
      return { results, bars, refused: messages.filter((m) => m.type === 'refused'), hits: [...listener.hits] };
    } finally { srv.close(); }
  }

  test('B cannot use the click spent in A: no file, no address, no draft; the person is asked about the first, the rest wait', async ({ page }) => {
    const run = await chainRun(page, '');
    expect(run.results.opened, 'only the click in A was honoured').toEqual(['notes/next.md']);
    expect(run.results.externals).toEqual([]);
    expect(run.results.asked).toEqual([]);
    expect(run.hits.filter((u) => u.includes('chained')), 'nothing reached the network').toEqual([]);
    expect(run.bars).toEqual([{ kind: 'confirm', text: 'Open chained-now.md?', aboveFrame: true }]);
    expect(run.refused.map((m) => m.reason), 'the rest are told a request is waiting')
      .toEqual(Array(5).fill('Rundock is already asking you about another request'));
    record('chain', run);
  });

  test('control: with the spend and inherit rule removed, the chain succeeds', async ({ page }) => {
    const run = await chainRun(page, 'chain');
    expect(run.results.opened).toEqual(['notes/next.md', 'notes/chained-now.md', 'notes/chained-later.md']);
    expect(run.results.externals.length).toBe(2);
    expect(run.results.asked.map((a) => a.message)).toEqual(['chained now', 'chained later']);
    expect(run.bars).toEqual([]);
    record('chain-control', { opened: run.results.opened, externals: run.results.externals.length, asked: run.results.asked });
  });
});

// THE BAR'S ARMING, WITH REAL INPUT. A genuine press on Open before the
// bar has been on screen for its arming time does nothing and leaves the
// request waiting; a genuine press after it performs the request. The page's
// own clock records when the bar appeared and when each press landed.
test('a real press on Open before the bar is armed does nothing; a real press after it performs the request', async ({ page }) => {
  const srv = await h.startTrustHarness({ world, listener });
  try {
    await page.goto(srv.url('chain-hop.js', { mode: 'chain' }));
    await page.waitForTimeout(900);
    await page.frameLocator('#pane iframe').locator('#hop').click();
    const bar = page.locator('#pane > [data-extension-request="confirm"]');
    await bar.waitFor({ state: 'attached', timeout: 2000 });
    const open = bar.getByRole('button', { name: 'Open', exact: true });
    const box = await open.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const early = await page.evaluate(() => ({ timing: window.timing, opened: window.results.opened.slice() }));
    const press = early.timing.presses[early.timing.presses.length - 1];
    expect(press.onDisabled, 'the press landed on the unarmed button').toBe(true);
    expect(press.at - early.timing.barShownAt, 'and before the arming time had passed').toBeLessThan(400);
    expect(early.opened, 'the early press opened nothing').toEqual(['notes/next.md']);
    await expect(bar, 'and the request is still waiting').toHaveCount(1);

    await expect(open).toBeEnabled({ timeout: 2000 });
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(() => page.evaluate(() => window.results.opened)).toEqual(['notes/next.md', 'notes/chained-now.md']);
    await expect(bar).toHaveCount(0);
    record('bar-arming', { earlyPressAfterBarMs: Math.round(press.at - early.timing.barShownAt), earlyOpened: early.opened, afterArming: ['notes/next.md', 'notes/chained-now.md'] });
  } finally { srv.close(); }
});

// EACH GUARD ALONE. The spent-activation guard is the only thing that
// stops one view's burst on one click; the inherited-activation guard is the
// only thing that stops a frame rebuilt during a live click that nothing
// spent and that was not a press on Rundock's page. Each attack is run with
// both guards, with only its own guard removed (it succeeds), and with only
// the other guard removed (it still fails), so each guard is shown to hold on
// its own.
test.describe('each click guard holds on its own', () => {
  async function burst(page, control) {
    const srv = await h.startTrustHarness({ world, listener });
    try {
      await page.goto(srv.url('ask-probe.js', { mode: 'ask', control }));
      await page.waitForTimeout(900);
      await page.frameLocator('#pane iframe').locator('#opens').click();
      await page.waitForTimeout(600);
      const r = await page.evaluate(() => window.results);
      return { honoured: r.opened.length + r.externals.length };
    } finally { srv.close(); }
  }
  async function rebuild(page, control) {
    const srv = await h.startTrustHarness({ world, listener });
    try {
      await page.goto(srv.url('rebuild-ride.js', { mode: 'rebuild', control }));
      await page.waitForTimeout(900);
      await page.frameLocator('#pane iframe').locator('#poke').click();
      await page.waitForTimeout(1200);
      const r = await page.evaluate(() => window.results);
      const rebuilt = await page.frameLocator('#pane iframe').locator('#grab').count();
      const bars = await page.locator('#pane > [data-extension-request="confirm"]').count();
      return { opened: r.opened, rebuilt, bars };
    } finally { srv.close(); }
  }

  test('the spent-activation guard alone stops one click honouring a burst', async ({ page }) => {
    const guarded = await burst(page, '');
    const withoutSpent = await burst(page, 'spent-only');
    const withoutInherit = await burst(page, 'inherit-only');
    expect(guarded.honoured, 'both guards: one request').toBe(1);
    expect(withoutSpent.honoured, 'spent guard removed: the whole burst of twelve is honoured').toBe(12);
    expect(withoutInherit.honoured, 'inherit guard removed: the spent guard alone still allows one').toBe(1);
    record('guard-spent-alone', { guarded, withoutSpent, withoutInherit });
  });

  test('the inherited-activation guard alone stops a rebuilt frame riding the click that preceded it', async ({ page }) => {
    const guarded = await rebuild(page, '');
    const withoutInherit = await rebuild(page, 'inherit-only');
    const withoutSpent = await rebuild(page, 'spent-only');
    for (const run of [guarded, withoutInherit, withoutSpent]) expect(run.rebuilt, '(instrument) the frame was rebuilt').toBe(1);
    expect(guarded.opened, 'both guards: nothing opens, the person is asked').toEqual([]);
    expect(guarded.bars).toBe(1);
    expect(withoutInherit.opened, 'inherit guard removed: the rebuilt frame opens a file on a click it never received').toEqual(['notes/rebuilt.md']);
    expect(withoutSpent.opened, 'spent guard removed: the inherit guard alone still stops it').toEqual([]);
    expect(withoutSpent.bars).toBe(1);
    record('guard-inherit-alone', { guarded, withoutInherit, withoutSpent });
  });
});

// ONE USER ACTION, ONE REQUEST. What each part of the rule asks to be shown, in a real
// engine, each with its control.
test.describe('a user action grants one request, and the host bar is the only other way an ask drafts', () => {
  test('a script-sent ask with no user action at all is refused with its reason and shows the refusal line, never the bar', async ({ page }) => {
    const srv = await h.startTrustHarness({ world, listener });
    try {
      await page.goto(srv.url('ask-probe.js', { mode: 'ask' }));
      await page.waitForTimeout(900);
      expect((await page.evaluate(() => window.results)).asked, 'nothing drafted').toEqual([]);
      expect(refusalsOf((await seen(page)).messages, 'ask').every((r) => r.reason === 'Rundock stopped this because it did not come from your click')).toBe(true);
      await expect(page.locator('#pane > [data-extension-request="confirm"]'), 'no bar').toHaveCount(0);
      await expect(page.locator('#pane > [data-extension-request="refused"] .rui-alert-message'))
        .toHaveText('The chain-probe extension tried to start a conversation with analyst without you asking, so Rundock stopped it.');
      record('a1-no-activation-ask', { asked: [], line: 'refused', bar: false });
    } finally { srv.close(); }
  });

  test('control: routing a no-activation request to the person puts the bar up instead, which the check above would catch', async ({ page }) => {
    const srv = await h.startTrustHarness({ world, listener });
    try {
      await page.goto(srv.url('ask-probe.js', { mode: 'ask', control: 'no-activation-bar' }));
      await page.waitForTimeout(900);
      await expect(page.locator('#pane > [data-extension-request="confirm"]')).toHaveCount(1);
      await expect(page.locator('#pane > [data-extension-request="refused"]')).toHaveCount(0);
    } finally { srv.close(); }
  });

  test('the ask on the bar: one click drafts one; the next waits on the bar, a press before it arms drafts nothing, and only a press after it drafts', async ({ page }) => {
    const srv = await h.startTrustHarness({ world, listener });
    try {
      await page.goto(srv.url('ask-probe.js', { mode: 'ask' }));
      await page.waitForTimeout(900);
      await page.frameLocator('#pane iframe').locator('#burst').click();
      const bar = page.locator('#pane > [data-extension-request="confirm"]');
      await bar.waitFor({ state: 'attached', timeout: 2000 });
      const open = bar.getByRole('button', { name: 'Open', exact: true });
      const box = await open.boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      const early = await page.evaluate(() => ({ timing: window.timing, asked: window.results.asked.map((a) => a.message) }));
      const press = early.timing.presses[early.timing.presses.length - 1];
      expect(press.onDisabled && press.at - early.timing.barShownAt < 400, 'the press landed before the bar armed').toBe(true);
      expect(early.asked, 'one user action drafted one ask, and the early press drafted nothing').toEqual(['burst 0']);
      await expect(open).toBeEnabled({ timeout: 2000 });
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expect.poll(() => page.evaluate(() => window.results.asked.map((a) => a.message))).toEqual(['burst 0', 'burst 1']);
      await page.waitForTimeout(400);
      expect((await page.evaluate(() => window.results.asked)).length, 'and nothing else drafts').toBe(2);
      record('a1-ask-bar', { afterOneClick: early.asked, earlyPressAfterBarMs: Math.round(press.at - early.timing.barShownAt), afterArmedPress: ['burst 0', 'burst 1'] });
    } finally { srv.close(); }
  });

  // The ask on the bar, driven to its armed state: one real click drafts the
  // first ask of a burst and the second waits on the bar; `answer` presses
  // Open or Dismiss once the bar has armed.
  async function askOnBar(page, control, answer) {
    const srv = await h.startTrustHarness({ world, listener });
    try {
      await page.goto(srv.url('ask-probe.js', { mode: 'ask', control }));
      await page.waitForTimeout(900);
      await page.frameLocator('#pane iframe').locator('#burst').click();
      const bar = page.locator('#pane > [data-extension-request="confirm"]');
      await bar.waitFor({ state: 'attached', timeout: 2000 });
      await expect(bar.getByRole('button', { name: 'Open', exact: true })).toBeEnabled({ timeout: 2000 });
      const before = (await seen(page)).messages.length;
      const button = bar.getByRole('button', { name: answer, exact: true });
      const box = await button.boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(600);
      const after = (await seen(page)).messages;
      return {
        asked: (await page.evaluate(() => window.results.asked)),
        toFrame: after.slice(before),
        bar: await bar.count(),
      };
    } finally { srv.close(); }
  }

  test('Dismiss on the ask bar tells the view only that it was refused, and drafts nothing', async ({ page }) => {
    const run = await askOnBar(page, '', 'Dismiss');
    expect(run.asked.map((a) => a.message), 'only the first ask, which a click made').toEqual(['burst 0']);
    expect(run.toFrame, 'the view is told one thing: refused, as dismissed').toEqual([{ type: 'refused', of: 'ask', reason: 'you dismissed this in Rundock' }]);
    expect(run.bar).toBe(0);
    record('a1-ask-bar-dismiss', run);
  });

  test('the armed Open drafts exactly the waiting ask, agent and message, and tells the view nothing', async ({ page }) => {
    const run = await askOnBar(page, '', 'Open');
    expect(run.asked).toEqual([{ agent: 'analyst', message: 'burst 0' }, { agent: 'analyst', message: 'burst 1' }]);
    expect(run.toFrame, 'nothing is posted back on success').toEqual([]);
  });

  test('control: with the bar armed from the moment it appears, the same early press drafts the waiting ask', async ({ page }) => {
    const srv = await h.startTrustHarness({ world, listener });
    try {
      await page.goto(srv.url('ask-probe.js', { mode: 'ask', control: 'unarmed' }));
      await page.waitForTimeout(900);
      await page.frameLocator('#pane iframe').locator('#burst').click();
      const bar = page.locator('#pane > [data-extension-request="confirm"]');
      await bar.waitFor({ state: 'attached', timeout: 2000 });
      const box = await bar.getByRole('button', { name: 'Open', exact: true }).boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      const t = await page.evaluate(() => window.timing);
      const press = t.presses[t.presses.length - 1];
      expect(press.at - t.barShownAt, 'the press was as early as in the proof').toBeLessThan(400);
      await expect.poll(() => page.evaluate(() => window.results.asked.map((a) => a.message))).toEqual(['burst 0', 'burst 1']);
    } finally { srv.close(); }
  });

  test('control: with Dismiss wired to perform the request, Dismiss drafts the waiting ask and tells the view nothing', async ({ page }) => {
    const run = await askOnBar(page, 'dismiss-performs', 'Dismiss');
    expect(run.asked.map((a) => a.message)).toEqual(['burst 0', 'burst 1']);
    expect(run.toFrame).toEqual([]);
  });

  test('control: with the bar\'s Open handler removed, an armed press drafts nothing, which the test above would catch', async ({ page }) => {
    const run = await askOnBar(page, 'bar-unwired', 'Open');
    expect(run.asked.map((a) => a.message)).toEqual(['burst 0']);
  });

  test('control: with the ask handler wired to the wrong payload, the armed press drafts the wrong ask, which the test above would catch', async ({ page }) => {
    const run = await askOnBar(page, 'ask-wrong-payload', 'Open');
    expect(run.asked.map((a) => a.message)).toEqual(['burst 0', 'burst 0']);
  });

  test('a real key press inside the view grants one ask; the same view\'s script-sent ask with no key press is refused', async ({ page }) => {
    const srv = await h.startTrustHarness({ world, listener });
    try {
      await page.goto(srv.url('keyboard-ask.js', { mode: 'ask' }));
      await page.waitForTimeout(900);
      expect((await page.evaluate(() => window.results)).asked, 'the script-sent ask drafted nothing').toEqual([]);
      expect(refusalsOf((await seen(page)).messages, 'ask').map((r) => r.reason)).toEqual(['Rundock stopped this because it did not come from your click']);
      await page.keyboard.press('Enter');
      await expect.poll(() => page.evaluate(() => window.results.asked.map((a) => a.message))).toEqual(['by key']);
      await expect(page.locator('#pane > [data-extension-request="confirm"]'), 'honoured directly, no bar').toHaveCount(0);
      record('a1-key-press', { asked: ['by key'] });
    } finally { srv.close(); }
  });

  test('control: without the click gate, the script-sent ask in the keyboard view drafts on its own', async ({ page }) => {
    const srv = await h.startTrustHarness({ world, listener });
    try {
      await page.goto(srv.url('keyboard-ask.js', { mode: 'ask', control: 'ask-click' }));
      await page.waitForTimeout(900);
      expect((await page.evaluate(() => window.results.asked.map((a) => a.message)))).toEqual(['script-sent']);
    } finally { srv.close(); }
  });
});
