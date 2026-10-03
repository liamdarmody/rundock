'use strict';
// Org chart orientation toggle: the team chart can be pivoted from the default
// top-down layout (Vertical) to a left-to-right layout (Horizontal), with
// right-angled connectors in both.
//
// These tests drive the real rendered page and measure real geometry
// (bounding boxes and the endpoints of the connector paths) rather than class
// names, because "the leader is on the left" is a property of where pixels
// land, not of what an attribute says.
//
// Like org-chart.spec.js, the roster is injected straight into the client so
// the layout is controlled and independent of the shared workspace fixture.
const { test, expect } = require('@playwright/test');

const STORAGE_KEY = 'rundock.orgOrientation';

// Selectors from the documented DOM contract for the control and the chart.
const ORIENT = '.org-zoom button.org-orient';
const ZOOM_IN = '.org-zoom button[title="Zoom in"]';
const ZOOM_OUT = '.org-zoom button[title="Zoom out"]';
const CARD = '.org-layout .org-card[data-org-agent]';
const PATH = '.org-connectors path';

// The control's accessible name names the layout it switches to; its tooltip
// is the same in both states.
const TO_HORIZONTAL = 'Switch to left-to-right layout';
const TO_VERTICAL = 'Switch to top-down layout';
const TITLE = 'Switch layout';

// Pixel tolerance for connector endpoints and column alignment. Card edges are
// rounded to layout units and the chart is scaled to fit, so exact equality
// would be a flaky assertion.
const TOL = 2;

function member(id, displayName, order, reportsTo, extra) {
  return {
    id, name: id, displayName, role: 'Spec', order, status: 'onTeam',
    type: reportsTo === undefined ? 'orchestrator' : 'specialist',
    ...(reportsTo ? { reportsTo } : {}),
    colour: '#6B9EF0', icon: displayName[0],
    ...extra,
  };
}

// One orchestrator over four leads. Two has a single report, Three has two
// reports, One and Four have none. That gives every shape the layout has to
// handle: a childless lead, a single-report lead, a two-report lead, and three
// levels deep.
const ROSTER = [
  member('boss', 'Boss', 0),
  member('l1', 'One', 1, 'boss'),
  member('l2', 'Two', 2, 'boss'),
  member('l3', 'Three', 3, 'boss'),
  member('l4', 'Four', 4, 'boss'),
  member('r2', 'ReportA', 5, 'l2'),
  member('r3a', 'ReportB', 6, 'l3'),
  member('r3b', 'ReportC', 7, 'l3'),
];

// Parent-child pairs by displayed name, derived from the roster so the
// expected link count can never drift from the data.
function linksOf(roster) {
  const nameById = Object.fromEntries(roster.map((a) => [a.id, a.displayName]));
  return roster.filter((a) => a.reportsTo).map((a) => [nameById[a.reportsTo], a.displayName]);
}

// A wide, flat team: an orchestrator with ten direct reports, which is the
// shape that crowds the platform row when the chart is pivoted.
const WIDE = [
  member('boss', 'Boss', 0),
  ...Array.from({ length: 10 }, (_, i) => member(`w${i}`, `Wide${i + 1}`, i + 1, 'boss')),
];
const PLATFORM_AGENT = {
  id: 'doc', name: 'doc', displayName: 'Guide', role: 'Platform Guide',
  type: 'platform', order: 99, status: 'onTeam', colour: '#5BCFC4', icon: 'G',
};

// ── helpers ──────────────────────────────────────────────────────────────────

// Collect uncaught page errors from before the first navigation.
function trackPageErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  return errors;
}

async function mount(page, roster) {
  await page.goto('/');
  await page.waitForSelector('.nav-item[data-nav="team"]', { state: 'visible' });
  await page.evaluate((r) => {
    // eslint-disable-next-line no-global-assign
    agents = r;
    switchNav('team');
    renderOrgChart();
  }, roster);
  // An empty roster renders the empty state rather than cards.
  await page.waitForSelector(roster.length ? CARD : '.org-chart');
}

// Wait for any running transition to finish so measurements are not taken
// mid-animation. The status dot pulse is infinite and is ignored.
async function settle(page) {
  await page.evaluate(async () => {
    const finite = document.getAnimations().filter((a) => {
      const t = a.effect && a.effect.getTiming();
      return t && t.iterations !== Infinity;
    });
    await Promise.all(finite.map((a) => a.finished.catch(() => {})));
  });
}

// Fail fast, with a clear message, when the control is missing. Without this a
// missing control makes every later click wait out the whole test timeout.
async function requireControl(page) {
  await expect(page.locator(ORIENT), 'the orientation control is present').toHaveCount(1);
}

// Click the control until it reports the wanted orientation.
async function setOrientation(page, want) {
  await requireControl(page);
  const ctl = page.locator(ORIENT);
  const pressed = (await ctl.getAttribute('aria-label')) === TO_VERTICAL;
  if (pressed !== (want === 'horizontal')) await ctl.click();
  await expect(page.locator(ORIENT)).toHaveAttribute('aria-label', want === 'horizontal' ? TO_VERTICAL : TO_HORIZONTAL);
  await settle(page);
}

// Every team card's rectangle by displayed name, and every connector path with
// its start and end points converted to the same screen coordinates as the
// card rectangles (the chart is scaled to fit, so path units are not pixels).
async function measure(page) {
  await settle(page);
  return page.evaluate(() => {
    const cards = {};
    for (const c of document.querySelectorAll('.org-layout .org-card[data-org-agent]')) {
      const name = c.querySelector('.org-card-name')?.textContent?.trim();
      const r = c.getBoundingClientRect();
      cards[name] = {
        left: r.left, right: r.right, top: r.top, bottom: r.bottom,
        cx: (r.left + r.right) / 2, cy: (r.top + r.bottom) / 2, w: r.width, h: r.height,
      };
    }
    const NUM = /-?\d*\.?\d+(?:e[-+]?\d+)?/gi;
    const paths = [...document.querySelectorAll('.org-connectors path')].map((p) => {
      const d = p.getAttribute('d') || '';
      const nums = (d.match(NUM) || []).map(Number);
      const letters = (d.match(/[A-Za-z]/g) || []);
      const m = p.getScreenCTM();
      const toScreen = (x, y) => {
        const pt = new DOMPoint(x, y).matrixTransform(m);
        return { x: pt.x, y: pt.y };
      };
      const points = [];
      for (let i = 0; i + 1 < nums.length; i += 2) points.push(toScreen(nums[i], nums[i + 1]));
      return {
        d, letters, count: nums.length, points,
        start: points[0] || null,
        end: points[points.length - 1] || null,
      };
    });
    return { cards, paths };
  });
}

function overlaps(a, b, eps = 0.5) {
  return a.left < b.right - eps && b.left < a.right - eps
      && a.top < b.bottom - eps && b.top < a.bottom - eps;
}

function expectNoOverlap(cards) {
  const names = Object.keys(cards);
  const clashes = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      if (overlaps(cards[names[i]], cards[names[j]])) clashes.push(`${names[i]} / ${names[j]}`);
    }
  }
  expect(clashes, 'cards that overlap').toEqual([]);
}

// Where a connector should start (parent) and end (child) in each layout.
const ANCHORS = {
  horizontal: {
    from: (c) => ({ x: c.right, y: c.cy }),
    to: (c) => ({ x: c.left, y: c.cy }),
  },
  vertical: {
    from: (c) => ({ x: c.cx, y: c.bottom }),
    to: (c) => ({ x: c.cx, y: c.top }),
  },
};

function near(p, q) {
  return Math.abs(p.x - q.x) <= TOL && Math.abs(p.y - q.y) <= TOL;
}

// Every straight piece of every connector, in screen coordinates.
function segmentsOf(paths) {
  const segs = [];
  for (const p of paths) {
    for (let i = 0; i + 1 < p.points.length; i++) segs.push([p.points[i], p.points[i + 1]]);
  }
  return segs;
}

// True when point q lies on the axis-aligned segment [a, b], within TOL.
function onSegment(q, [a, b]) {
  return q.x >= Math.min(a.x, b.x) - TOL && q.x <= Math.max(a.x, b.x) + TOL
      && q.y >= Math.min(a.y, b.y) - TOL && q.y <= Math.max(a.y, b.y) + TOL;
}

// True when the drawn lines join point `from` to point `to`: starting from the
// segments that touch `from`, follow segments that touch each other until one
// touches `to`. This does not care how many paths a link is drawn with.
function joined(segs, from, to) {
  const seen = new Set();
  const queue = [];
  segs.forEach((s, i) => { if (onSegment(from, s)) { seen.add(i); queue.push(i); } });
  while (queue.length) {
    const i = queue.shift();
    if (onSegment(to, segs[i])) return true;
    segs.forEach((s, j) => {
      if (seen.has(j)) return;
      const touches = onSegment(s[0], segs[i]) || onSegment(s[1], segs[i])
        || onSegment(segs[i][0], s) || onSegment(segs[i][1], s);
      if (touches) { seen.add(j); queue.push(j); }
    });
  }
  return false;
}

// The connectors are right-angled: only straight-line commands, and every
// segment horizontal or vertical. No curves or arcs of any kind.
function expectRightAngles(paths) {
  for (const p of paths) {
    expect(p.letters.filter((l) => /[CcQqAaSsTt]/.test(l)), `curve commands in "${p.d}"`).toEqual([]);
    expect(p.letters.every((l) => /[MLHVZmlhvz]/.test(l)), `only straight commands in "${p.d}"`).toBe(true);
    expect(p.letters.filter((l) => /[mlhvz]/.test(l)), `relative commands in "${p.d}"`).toEqual([]);
  }
  for (const [a, b] of segmentsOf(paths)) {
    const straight = Math.abs(a.x - b.x) <= 0.5 || Math.abs(a.y - b.y) <= 0.5;
    expect(straight, `segment ${JSON.stringify(a)} to ${JSON.stringify(b)} is horizontal or vertical`).toBe(true);
  }
}

// Every manager with reports has a line leaving its facing edge, every report
// has a line arriving at its facing edge, and the lines join the two.
function expectLinksDrawn(cards, paths, links, orientation) {
  const { from, to } = ANCHORS[orientation];
  const segs = segmentsOf(paths);
  const endpoints = segs.flat();
  for (const parent of new Set(links.map(([p]) => p))) {
    expect(endpoints.some((q) => near(q, from(cards[parent]))), `a line leaves ${parent}`).toBe(true);
  }
  for (const [parent, child] of links) {
    expect(endpoints.some((q) => near(q, to(cards[child]))), `a line reaches ${child}`).toBe(true);
    expect(joined(segs, from(cards[parent]), to(cards[child])), `${parent} is joined to ${child}`).toBe(true);
  }
}

// ── control: presence, accessibility, activation ─────────────────────────────

test('the orientation control sits in the zoom stack with the documented attributes', async ({ page }) => {
  await mount(page, ROSTER);

  const ctl = page.locator(ORIENT);
  await expect(ctl).toHaveCount(1);
  await expect(ctl).toBeVisible();
  await expect(ctl).not.toHaveAttribute('aria-pressed', /.*/);
  await expect(ctl).toHaveAttribute('aria-label', TO_HORIZONTAL);
  await expect(ctl).toHaveAttribute('title', TITLE);

  // Placement: after the zoom out button, below a divider.
  const placement = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const divider = el.previousElementSibling;
    const zoomOut = divider && divider.previousElementSibling;
    return {
      parentIsZoom: el.parentElement.classList.contains('org-zoom'),
      afterDivider: !!divider && divider.classList.contains('org-zoom-divider'),
      afterZoomOut: !!zoomOut && zoomOut.getAttribute('title') === 'Zoom out',
    };
  }, ORIENT);
  expect(placement).toEqual({ parentIsZoom: true, afterDivider: true, afterZoomOut: true });
});

test('the control names the layout it switches to and swaps that name when toggled, under one tooltip', async ({ page }) => {
  await mount(page, ROSTER);
  await requireControl(page);

  await page.locator(ORIENT).click();
  const ctl = page.locator(ORIENT);
  await expect(ctl).toHaveAttribute('aria-label', TO_VERTICAL);
  await expect(ctl).toHaveAttribute('title', TITLE);

  await ctl.click();
  await expect(page.locator(ORIENT)).toHaveAttribute('aria-label', TO_HORIZONTAL);
  await expect(page.locator(ORIENT)).toHaveAttribute('title', TITLE);
});

test('the control is a real button in the tab order, after zoom out', async ({ page }) => {
  await mount(page, ROSTER);
  await requireControl(page);

  const ctl = page.locator(ORIENT);
  expect(await ctl.evaluate((el) => el.tagName)).toBe('BUTTON');
  expect(await ctl.evaluate((el) => el.tabIndex)).toBeGreaterThanOrEqual(0);

  await page.locator(ZOOM_OUT).focus();
  await page.keyboard.press('Tab');
  await expect(ctl).toBeFocused();
});

test('Enter and Space both activate the control from the keyboard', async ({ page }) => {
  await mount(page, ROSTER);
  await requireControl(page);

  await page.locator(ORIENT).focus();
  await expect(page.locator(ORIENT)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator(ORIENT)).toHaveAttribute('aria-label', TO_VERTICAL);

  // The chart re-renders on toggle, so the control is looked up again rather
  // than assuming the same element survived.
  await page.locator(ORIENT).focus();
  await page.keyboard.press('Space');
  await expect(page.locator(ORIENT)).toHaveAttribute('aria-label', TO_HORIZONTAL);
});

// ── Horizontal geometry ──────────────────────────────────────────────────────

test('Horizontal puts the leader left of every report and each report right of its parent', async ({ page }) => {
  await mount(page, ROSTER);
  await setOrientation(page, 'horizontal');
  const { cards } = await measure(page);

  expect(Object.keys(cards).sort()).toEqual(ROSTER.map((a) => a.displayName).sort());

  // The leader is left of every other card.
  for (const a of ROSTER.filter((x) => x.reportsTo)) {
    expect(cards.Boss.right, `Boss left of ${a.displayName}`).toBeLessThanOrEqual(cards[a.displayName].left + 0.5);
  }
  // Every report sits in a column strictly to the right of its own parent.
  for (const [parent, child] of linksOf(ROSTER)) {
    expect(cards[parent].right, `${parent} left of ${child}`).toBeLessThanOrEqual(cards[child].left + 0.5);
    expect(cards[child].cx, `${child} column right of ${parent}`).toBeGreaterThan(cards[parent].cx + TOL);
  }
  // Grandchildren sit right of the leads, not just right of the leader.
  for (const lead of ['One', 'Two', 'Three', 'Four']) {
    for (const rep of ['ReportA', 'ReportB', 'ReportC']) {
      expect(cards[rep].cx, `${rep} right of ${lead}`).toBeGreaterThan(cards[lead].cx + TOL);
    }
  }
});

test('Horizontal siblings share a column and are stacked, in the same order Vertical lays them out', async ({ page }) => {
  await mount(page, ROSTER);
  const vertical = (await measure(page)).cards;
  await setOrientation(page, 'horizontal');
  const { cards } = await measure(page);

  const groups = [
    ['One', 'Two', 'Three', 'Four'],
    ['ReportB', 'ReportC'],
  ];
  for (const group of groups) {
    const xs = group.map((n) => cards[n].cx);
    expect(Math.max(...xs) - Math.min(...xs), `${group.join(',')} share x`).toBeLessThanOrEqual(TOL);

    // Distinct, non-overlapping vertical slots.
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = cards[group[i]];
        const b = cards[group[j]];
        expect(Math.abs(a.cy - b.cy), `${group[i]} and ${group[j]} differ in y`).toBeGreaterThan(TOL);
        const separated = a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5;
        expect(separated, `${group[i]} and ${group[j]} do not share vertical space`).toBe(true);
      }
    }

    // Top-to-bottom order matches the left-to-right order of the Vertical
    // layout, so pivoting never reorders the team.
    const byTop = [...group].sort((p, q) => cards[p].cy - cards[q].cy);
    const byLeft = [...group].sort((p, q) => vertical[p].cx - vertical[q].cx);
    expect(byTop).toEqual(byLeft);
  }
});

test('Vertical keeps the leader above its reports with siblings on one row', async ({ page }) => {
  await mount(page, ROSTER);
  const { cards } = await measure(page);

  for (const [parent, child] of linksOf(ROSTER)) {
    expect(cards[parent].bottom, `${parent} above ${child}`).toBeLessThanOrEqual(cards[child].top + 0.5);
  }
  const leadYs = ['One', 'Two', 'Three', 'Four'].map((n) => cards[n].cy);
  expect(Math.max(...leadYs) - Math.min(...leadYs)).toBeLessThanOrEqual(TOL);
  expect(Math.abs(cards.ReportB.cy - cards.ReportC.cy)).toBeLessThanOrEqual(TOL);
  expect(Math.abs(cards.ReportB.cx - cards.ReportC.cx)).toBeGreaterThan(TOL);
});

for (const orientation of ['vertical', 'horizontal']) {
  for (const [label, roster] of [['the standard team', ROSTER], ['a ten-report team', WIDE]]) {
    test(`no two cards overlap in ${orientation} layout for ${label}`, async ({ page }) => {
      await mount(page, roster);
      await setOrientation(page, orientation);
      const { cards } = await measure(page);
      expect(Object.keys(cards)).toHaveLength(roster.length);
      expectNoOverlap(cards);
    });
  }
}

// ── connectors ───────────────────────────────────────────────────────────────

for (const orientation of ['vertical', 'horizontal']) {
  test(`connectors in ${orientation} layout are right-angled and join every manager to every report`, async ({ page }) => {
    await mount(page, ROSTER);
    await setOrientation(page, orientation);
    const { cards, paths } = await measure(page);

    expect(paths.length, 'connectors are drawn').toBeGreaterThan(0);
    expectRightAngles(paths);
    expectLinksDrawn(cards, paths, linksOf(ROSTER), orientation);

    // A card without reports has no line leaving it.
    const { from } = ANCHORS[orientation];
    const endpoints = segmentsOf(paths).flat();
    for (const leaf of ['One', 'Four', 'ReportA', 'ReportB', 'ReportC']) {
      expect(endpoints.some((q) => near(q, from(cards[leaf]))), `no line leaves ${leaf}`).toBe(false);
    }
  });
}

test('connectors are redrawn on every toggle, with no stale lines left behind', async ({ page }) => {
  await mount(page, ROSTER);
  const counts = {};
  for (const o of ['horizontal', 'vertical', 'horizontal', 'vertical']) {
    await setOrientation(page, o);
    await expect(page.locator(CARD)).toHaveCount(ROSTER.length);
    const { cards, paths } = await measure(page);
    expectRightAngles(paths);
    expectLinksDrawn(cards, paths, linksOf(ROSTER), o);
    // The same layout always draws the same number of lines, so nothing from
    // the previous layout survives the redraw.
    if (counts[o] !== undefined) expect(paths.length, `${o} line count is stable`).toBe(counts[o]);
    counts[o] = paths.length;
  }
});

test('switching the layout fades the chart in, and zooming does not', async ({ page }) => {
  await mount(page, ROSTER);
  await expect(page.locator('.org-tree.org-tree-switched')).toHaveCount(0);
  await page.locator(ORIENT).click();
  await expect(page.locator('.org-tree.org-tree-switched')).toHaveCount(1);
  await page.locator(ZOOM_IN).click();
  await expect(page.locator('.org-tree.org-tree-switched')).toHaveCount(0);
});

test('the layout fade is switched off when reduced motion is requested', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mount(page, ROSTER);
  await page.locator(ORIENT).click();
  const name = await page.locator('.org-tree').evaluate((el) => getComputedStyle(el).animationName);
  expect(name).toBe('none');
});

// ── persistence ──────────────────────────────────────────────────────────────

test('with nothing stored the chart opens Vertical', async ({ page }) => {
  await mount(page, ROSTER);
  expect(await page.evaluate((k) => localStorage.getItem(k), STORAGE_KEY)).toBeNull();
  await expect(page.locator(ORIENT)).toHaveAttribute('aria-label', TO_HORIZONTAL);
  const { cards } = await measure(page);
  expect(cards.Boss.bottom).toBeLessThanOrEqual(cards.One.top + 0.5);
});

test('toggling writes the choice to rundock.orgOrientation', async ({ page }) => {
  await mount(page, ROSTER);
  await setOrientation(page, 'horizontal');
  expect(await page.evaluate((k) => localStorage.getItem(k), STORAGE_KEY)).toBe('horizontal');
  await setOrientation(page, 'vertical');
  expect(await page.evaluate((k) => localStorage.getItem(k), STORAGE_KEY)).toBe('vertical');
});

test('the Horizontal choice survives a reload', async ({ page }) => {
  await mount(page, ROSTER);
  await setOrientation(page, 'horizontal');

  await page.reload();
  await mount(page, ROSTER);

  await expect(page.locator(ORIENT)).toHaveAttribute('aria-label', TO_VERTICAL);
  const { cards } = await measure(page);
  expect(cards.Boss.right).toBeLessThanOrEqual(cards.One.left + 0.5);
});

test('the Vertical choice survives a reload after having been Horizontal', async ({ page }) => {
  await mount(page, ROSTER);
  await setOrientation(page, 'horizontal');
  await setOrientation(page, 'vertical');

  await page.reload();
  await mount(page, ROSTER);

  await expect(page.locator(ORIENT)).toHaveAttribute('aria-label', TO_HORIZONTAL);
});

test('a stored Horizontal value is honoured on the first render', async ({ page }) => {
  await page.addInitScript((k) => {
    try { localStorage.setItem(k, 'horizontal'); } catch { /* private mode */ }
  }, STORAGE_KEY);
  await mount(page, ROSTER);

  await expect(page.locator(ORIENT)).toHaveAttribute('aria-label', TO_VERTICAL);
  const { cards } = await measure(page);
  expect(cards.Boss.right).toBeLessThanOrEqual(cards.One.left + 0.5);
});

test('an unrecognised stored value falls back to Vertical and the control still works', async ({ page }) => {
  const errors = trackPageErrors(page);
  await page.addInitScript((k) => {
    try { localStorage.setItem(k, 'sideways'); } catch { /* private mode */ }
  }, STORAGE_KEY);
  await mount(page, ROSTER);

  await expect(page.locator(ORIENT)).toHaveAttribute('aria-label', TO_HORIZONTAL);
  await setOrientation(page, 'horizontal');
  expect(await page.evaluate((k) => localStorage.getItem(k), STORAGE_KEY)).toBe('horizontal');
  expect(errors).toEqual([]);
});

test('when storage refuses the key the toggle still works for the session', async ({ page }) => {
  const errors = trackPageErrors(page);
  // Only this key is blocked, so the rest of the app is unaffected.
  await page.addInitScript((k) => {
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key) { if (key === k) throw new Error('blocked'); return get.call(this, key); };
    Storage.prototype.setItem = function (key, v) { if (key === k) throw new Error('blocked'); return set.call(this, key, v); };
  }, STORAGE_KEY);
  await mount(page, ROSTER);

  await expect(page.locator(ORIENT)).toHaveAttribute('aria-label', TO_HORIZONTAL);
  await setOrientation(page, 'horizontal');
  const { cards } = await measure(page);
  expect(cards.Boss.right).toBeLessThanOrEqual(cards.One.left + 0.5);
  expect(errors).toEqual([]);
});

test('the orientation is kept when the window is resized', async ({ page }) => {
  await mount(page, ROSTER);
  await setOrientation(page, 'horizontal');
  await page.locator(ZOOM_IN).click();
  expect(await page.evaluate(() => orgZoomOffset)).toBeGreaterThan(0);

  // The debounced resize handler re-fits the chart and clears the zoom offset.
  // Waiting for that proves it has run before the orientation is checked.
  await page.setViewportSize({ width: 1000, height: 640 });
  await expect.poll(() => page.evaluate(() => orgZoomOffset)).toBe(0);

  await expect(page.locator(ORIENT)).toHaveAttribute('aria-label', TO_VERTICAL);
  const { cards } = await measure(page);
  expect(cards.Boss.right).toBeLessThanOrEqual(cards.One.left + 0.5);
});

// ── re-fit and zoom ──────────────────────────────────────────────────────────

test('toggling resets the zoom offset to 0 and re-fits the chart, in both directions', async ({ page }) => {
  await mount(page, ROSTER);

  // Reference fit sizes for each layout with no zoom applied.
  await setOrientation(page, 'horizontal');
  const fitH = (await measure(page)).cards.Boss.w;
  await setOrientation(page, 'vertical');
  const fitV = (await measure(page)).cards.Boss.w;

  // Zoom in on Vertical, then pivot: the offset clears and the size is the
  // Horizontal fit, not the zoomed-in size.
  await page.locator(ZOOM_IN).click();
  await page.locator(ZOOM_IN).click();
  expect(await page.evaluate(() => orgZoomOffset)).toBeGreaterThan(0);
  expect((await measure(page)).cards.Boss.w).toBeGreaterThan(fitV + 1);

  await setOrientation(page, 'horizontal');
  expect(await page.evaluate(() => orgZoomOffset)).toBe(0);
  expect(Math.abs((await measure(page)).cards.Boss.w - fitH)).toBeLessThanOrEqual(1);

  // And back, from a zoomed-out Horizontal chart.
  await page.locator(ZOOM_OUT).click();
  await page.locator(ZOOM_OUT).click();
  expect(await page.evaluate(() => orgZoomOffset)).toBeLessThan(0);

  await setOrientation(page, 'vertical');
  expect(await page.evaluate(() => orgZoomOffset)).toBe(0);
  expect(Math.abs((await measure(page)).cards.Boss.w - fitV)).toBeLessThanOrEqual(1);
});

for (const orientation of ['vertical', 'horizontal']) {
  test(`zoom in and zoom out still work in ${orientation} layout and keep the orientation`, async ({ page }) => {
    const errors = trackPageErrors(page);
    await mount(page, ROSTER);
    await setOrientation(page, orientation);
    const base = (await measure(page)).cards.Boss.w;

    await page.locator(ZOOM_IN).click();
    expect(await page.evaluate(() => orgZoomOffset)).toBeGreaterThan(0);
    const zoomed = await measure(page);
    expect(zoomed.cards.Boss.w).toBeGreaterThan(base + 1);
    // Zooming re-renders; it must not drop the chosen layout.
    await expect(page.locator(ORIENT)).toHaveAttribute('aria-label', orientation === 'horizontal' ? TO_VERTICAL : TO_HORIZONTAL);
    expectRightAngles(zoomed.paths);
    expectLinksDrawn(zoomed.cards, zoomed.paths, linksOf(ROSTER), orientation);

    await page.locator(ZOOM_OUT).click();
    await page.locator(ZOOM_OUT).click();
    expect(await page.evaluate(() => orgZoomOffset)).toBeLessThan(0);
    const shrunk = await measure(page);
    expect(shrunk.cards.Boss.w).toBeLessThan(base - 1);
    expectLinksDrawn(shrunk.cards, shrunk.paths, linksOf(ROSTER), orientation);
    expect(errors).toEqual([]);
  });

  test(`when the chart overflows in ${orientation} layout every card can be scrolled into view`, async ({ page }) => {
    // A small window and a high zoom guarantee overflow in both directions.
    await page.setViewportSize({ width: 900, height: 600 });
    await mount(page, ROSTER);
    await setOrientation(page, orientation);
    for (let i = 0; i < 12; i++) await page.locator(ZOOM_IN).click();

    const reach = await page.evaluate(() => {
      const box = document.querySelector('.org-chart');
      const cs = (n) => n.getBoundingClientRect();
      const overflowsX = box.scrollWidth > box.clientWidth + 1;
      const overflowsY = box.scrollHeight > box.clientHeight + 1;
      const cards = [...document.querySelectorAll('.org-layout .org-card[data-org-agent]')];

      // At the scroll origin nothing may sit beyond the top or left edge, where
      // it could never be scrolled to. This is the failure mode of centring an
      // overflowing flex child.
      box.scrollTo(0, 0);
      const origin = cs(box);
      const clippedAtOrigin = cards
        .filter((c) => cs(c).left < origin.left - 1 || cs(c).top < origin.top - 1)
        .map((c) => c.querySelector('.org-card-name')?.textContent?.trim());

      // At the far end nothing may sit beyond the bottom or right edge.
      box.scrollTo(box.scrollWidth, box.scrollHeight);
      const end = cs(box);
      const clippedAtEnd = cards
        .filter((c) => cs(c).right > end.right + 1 || cs(c).bottom > end.bottom + 1)
        .map((c) => c.querySelector('.org-card-name')?.textContent?.trim());

      return { overflowsX, overflowsY, clippedAtOrigin, clippedAtEnd };
    });

    expect(reach.overflowsX || reach.overflowsY, 'the setup must actually overflow').toBe(true);
    expect(reach.clippedAtOrigin, 'cards unreachable at scroll origin').toEqual([]);
    expect(reach.clippedAtEnd, 'cards unreachable at scroll end').toEqual([]);
  });
}

// ── platform row ─────────────────────────────────────────────────────────────

for (const orientation of ['vertical', 'horizontal']) {
  test(`the platform row stays below the chart in ${orientation} layout for a ten-report team`, async ({ page }) => {
    await mount(page, [...WIDE, PLATFORM_AGENT]);
    // Proves the injected roster really produces a platform row before the
    // layout is pivoted, so a wrong fixture fails here rather than as a
    // missing control.
    await expect(page.locator('.org-platform-section')).toHaveCount(1);
    await setOrientation(page, orientation);

    const rects = await page.evaluate(() => {
      const r = (el) => { const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }; };
      return {
        cards: [...document.querySelectorAll('.org-layout .org-card[data-org-agent]')].map(r),
        section: r(document.querySelector('.org-platform-section')),
        label: r(document.querySelector('.org-platform-label')),
        platformCards: [...document.querySelectorAll('.org-platform-section .org-card')].map(r),
        chart: r(document.querySelector('.org-chart')),
        // True when the chart needs scrolling to reach everything in it.
        scrolls: (() => { const c = document.querySelector('.org-chart'); return c.scrollHeight > c.clientHeight + 1 || c.scrollWidth > c.clientWidth + 1; })(),
      };
    });

    // At the fitted size the whole chart, platform row included, is on screen
    // without scrolling. This is what pins the room reserved for the row: if
    // the reserve fell short of the row's real height, the row would fall
    // below the fold and the chart would scroll.
    expect(rects.scrolls, 'chart needs no scrolling at fit').toBe(false);
    expect(rects.section.bottom, 'platform row is inside the chart').toBeLessThanOrEqual(rects.chart.bottom + 0.5);

    const lowestCard = Math.max(...rects.cards.map((c) => c.bottom));
    expect(rects.label.top, 'label below the lowest chart card').toBeGreaterThanOrEqual(lowestCard - 0.5);
    expect(rects.section.top, 'section below the lowest chart card').toBeGreaterThanOrEqual(lowestCard - 0.5);
    for (const c of rects.cards) {
      expect(overlaps(c, rects.label), 'chart card overlaps the platform label').toBe(false);
      for (const pc of rects.platformCards) expect(overlaps(c, pc), 'chart card overlaps a platform card').toBe(false);
    }
  });
}

// ── agents with no resolvable parent ─────────────────────────────────────────

// An agent whose reportsTo names someone who is not on the team (here the
// platform guide) has nothing to hang from, so it joins the leader at the top
// level. Both then sit in the first column or row, and the leader's own reports
// sit one level further out. The second roster is compact, which is where the
// leader's taller card shares a column with other cards.
const LOST = member('lost', 'Lost', 99, 'doc');
const ORPHAN_ROSTERS = [
  ['a small team', [
    member('boss', 'Boss', 0),
    member('a1', 'KidA', 1, 'boss'),
    member('a2', 'KidB', 2, 'boss'),
    LOST,
  ]],
  ['a compact team', [...WIDE, LOST]],
];

for (const orientation of ['vertical', 'horizontal']) {
  for (const [label, roster] of ORPHAN_ROSTERS) {
    test(`an agent with no resolvable parent shares the leader's level in ${orientation} layout for ${label}`, async ({ page }) => {
      const errors = trackPageErrors(page);
      await mount(page, [...roster, PLATFORM_AGENT]);
      await setOrientation(page, orientation);
      const { cards, paths } = await measure(page);
      const kids = roster.filter((a) => a.reportsTo === 'boss').map((a) => a.displayName);

      expect(Object.keys(cards).sort()).toEqual(roster.map((a) => a.displayName).sort());

      // Same level: one row in Vertical, one column in Horizontal.
      if (orientation === 'vertical') {
        expect(Math.abs(cards.Lost.top - cards.Boss.top), 'Lost and Boss share a row').toBeLessThanOrEqual(TOL);
      } else {
        expect(Math.abs(cards.Lost.cx - cards.Boss.cx), 'Lost and Boss share a column').toBeLessThanOrEqual(TOL);
      }

      // The leader's reports are one level further out than the leader.
      for (const kid of kids) {
        if (orientation === 'vertical') {
          expect(cards.Boss.bottom, `Boss above ${kid}`).toBeLessThanOrEqual(cards[kid].top + 0.5);
        } else {
          expect(cards[kid].cx, `${kid} right of Boss`).toBeGreaterThan(cards.Boss.cx + TOL);
        }
      }

      expectNoOverlap(cards);

      // Only the leader's links are drawn: the orphan has no parent to join,
      // so no line reaches it.
      expectRightAngles(paths);
      expectLinksDrawn(cards, paths, kids.map((k) => ['Boss', k]), orientation);
      const endpoints = segmentsOf(paths).flat();
      expect(endpoints.some((q) => near(q, ANCHORS[orientation].to(cards.Lost))), 'no line reaches Lost').toBe(false);
      expect(errors).toEqual([]);
    });
  }
}

// ── empty and single-leader cases ────────────────────────────────────────────

test('with no team there is no zoom stack and no orientation control', async ({ page }) => {
  const errors = trackPageErrors(page);
  await mount(page, []);

  // The existing empty state is what shows, and it carries no controls.
  await expect(page.locator('.org-empty-state')).toHaveCount(1);
  await expect(page.locator(ORIENT)).toHaveCount(0);
  await expect(page.locator('.org-zoom')).toHaveCount(0);
  await expect(page.locator(CARD)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the control disappears when the team is emptied after it was shown', async ({ page }) => {
  await mount(page, ROSTER);
  await expect(page.locator(ORIENT)).toHaveCount(1);

  await page.evaluate(() => {
    // eslint-disable-next-line no-global-assign
    agents = [];
    renderOrgChart();
  });
  await expect(page.locator(ORIENT)).toHaveCount(0);
});

for (const orientation of ['vertical', 'horizontal']) {
  test(`a single leader with no reports renders without error in ${orientation} layout`, async ({ page }) => {
    const errors = trackPageErrors(page);
    await mount(page, [member('boss', 'Boss', 0)]);
    await setOrientation(page, orientation);

    const { cards, paths } = await measure(page);
    expect(Object.keys(cards)).toEqual(['Boss']);
    expect(cards.Boss.w).toBeGreaterThan(0);
    expect(cards.Boss.h).toBeGreaterThan(0);
    expect(paths).toHaveLength(0);
    await expect(page.locator(ORIENT)).toHaveCount(1);

    // Zoom and pivot back still work with a single card.
    await page.locator(ZOOM_IN).click();
    await setOrientation(page, orientation === 'horizontal' ? 'vertical' : 'horizontal');
    await expect(page.locator(CARD)).toHaveCount(1);
    expect(errors).toEqual([]);
  });
}

test('pivoting back and forth returns the chart to exactly where it started', async ({ page }) => {
  const errors = trackPageErrors(page);
  await mount(page, ROSTER);
  const before = await measure(page);

  await setOrientation(page, 'horizontal');
  await setOrientation(page, 'vertical');
  const after = await measure(page);

  for (const name of Object.keys(before.cards)) {
    for (const k of ['left', 'top', 'w', 'h']) {
      expect(Math.abs(after.cards[name][k] - before.cards[name][k]), `${name}.${k}`).toBeLessThanOrEqual(1);
    }
  }
  expect(after.paths).toHaveLength(before.paths.length);
  expect(errors).toEqual([]);
});

// ── themes ───────────────────────────────────────────────────────────────────

// Resolve a theme token to the rgb() string the browser reports for computed
// colours, so a path stroke can be compared with the token it should use.
async function resolvedToken(page, token) {
  return page.evaluate((t) => {
    const probe = document.createElement('div');
    probe.style.color = `var(${t})`;
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, token);
}

for (const theme of ['dark', 'light']) {
  for (const orientation of ['vertical', 'horizontal']) {
    test(`the chart, control and connectors render in the ${theme} theme in ${orientation} layout`, async ({ page }) => {
      const errors = trackPageErrors(page);
      // Pin the theme rather than relying on the runner's OS setting.
      await page.addInitScript((t) => {
        try { localStorage.setItem('rundock-theme', t); } catch { /* private mode */ }
      }, theme);
      await mount(page, ROSTER);
      expect(await page.evaluate(() => document.body.classList.contains('light'))).toBe(theme === 'light');
      await setOrientation(page, orientation);

      await expect(page.locator(ORIENT)).toBeVisible();
      const { cards, paths } = await measure(page);
      expect(Object.keys(cards)).toHaveLength(ROSTER.length);
      expect(paths.length, 'connectors are drawn').toBeGreaterThan(0);
      expectLinksDrawn(cards, paths, linksOf(ROSTER), orientation);

      // Connectors take their colour from the theme token, so they stay
      // visible against either background.
      const stroke = await page.locator(PATH).first().evaluate((p) => getComputedStyle(p).stroke);
      expect(stroke).not.toBe('none');
      expect(stroke).toBe(await resolvedToken(page, '--text-2'));

      // The control is drawn, not collapsed or transparent.
      const ctl = await page.locator(ORIENT).evaluate((el) => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return { w: r.width, h: r.height, color: cs.color, visibility: cs.visibility, opacity: cs.opacity };
      });
      expect(ctl.w).toBeGreaterThan(0);
      expect(ctl.h).toBeGreaterThan(0);
      expect(ctl.visibility).toBe('visible');
      expect(Number(ctl.opacity)).toBeGreaterThan(0);
      expect(ctl.color).not.toBe('rgba(0, 0, 0, 0)');
      expect(errors).toEqual([]);
    });
  }
}

test('connector colour differs between the dark and light themes', async ({ browser }) => {
  const seen = {};
  for (const theme of ['dark', 'light']) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript((t) => {
      try { localStorage.setItem('rundock-theme', t); } catch { /* private mode */ }
    }, theme);
    await mount(page, ROSTER);
    await setOrientation(page, 'horizontal');
    seen[theme] = await page.locator(PATH).first().evaluate((p) => getComputedStyle(p).stroke);
    await context.close();
  }
  expect(seen.dark).not.toBe(seen.light);
});
