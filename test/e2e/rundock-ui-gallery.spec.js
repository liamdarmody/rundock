'use strict';
// Rundock UI in a real engine: the gallery page the app serves, drawn in both
// themes inside frames the extension host builds, measured and driven.
//
// Visual: the frames paint the tokens of their own theme, the filled controls
// carry --accent-action with white, and the two places the design review
// corrected geometry (the checkbox tick and the slider thumb) are measured in
// pixels off a real screenshot, not inferred from CSS.
//
// Keyboard: tabs, the option list, the slider, the menu and a board card move,
// each with real key presses inside the sandboxed frame.
//
// Set RUNDOCK_UI_EVIDENCE to a folder to keep full-page screenshots of both
// themes; nothing is written otherwise.

const { test, expect } = require('@playwright/test');
const path = require('node:path');

test.use({ deviceScaleFactor: 4, viewport: { width: 1480, height: 1000 } });

const THEMES = {
  dark: { control: 'rgb(232, 122, 90)', controlRgb: [232, 122, 90], base: 'rgb(39, 39, 39)', elevated: 'rgb(39, 39, 39)', dangerText: 'rgb(240, 112, 110)', text3: 'rgb(118, 113, 105)', stale: 'rgb(232, 168, 76)' },
  light: { control: 'rgb(219, 89, 51)', controlRgb: [219, 89, 51], base: 'rgb(255, 255, 255)', elevated: 'rgb(255, 255, 255)', dangerText: 'rgb(212, 44, 42)', text3: 'rgb(140, 134, 126)', stale: 'rgb(26, 26, 26)' },
};
const ACTION = 'rgb(193, 87, 41)';
const WHITE = 'rgb(255, 255, 255)';

async function open(page) {
  await page.goto('/rundock-ui/gallery');
  const frames = {};
  for (const theme of Object.keys(THEMES)) {
    frames[theme] = page.frameLocator(`iframe[data-theme="${theme}"]`);
    await expect(frames[theme].locator('body[data-drawn="true"]')).toHaveCount(1);
  }
  return frames;
}

const style = (locator, prop, pseudo) => locator.evaluate((el, [p, ps]) => getComputedStyle(el, ps || null)[p], [prop, pseudo]);

// Decode a PNG in the page and return the bounding box of pixels that match.
async function pixelBox(page, png, match) {
  return page.evaluate(async ([b64, m]) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, img.width, img.height);
    const hit = (i) => Math.abs(data[i] - m.r) <= m.tol && Math.abs(data[i + 1] - m.g) <= m.tol && Math.abs(data[i + 2] - m.b) <= m.tol;
    const box = { minX: Infinity, minY: Infinity, maxX: -1, maxY: -1, width: img.width, height: img.height, columns: {} };
    for (let y = 0; y < img.height; y += 1) {
      for (let x = 0; x < img.width; x += 1) {
        if (!hit((y * img.width + x) * 4)) continue;
        box.minX = Math.min(box.minX, x); box.maxX = Math.max(box.maxX, x);
        box.minY = Math.min(box.minY, y); box.maxY = Math.max(box.maxY, y);
        const col = box.columns[x] || (box.columns[x] = { min: y, max: y });
        col.min = Math.min(col.min, y); col.max = Math.max(col.max, y);
      }
    }
    return box;
  }, [png.toString('base64'), match]);
}

test.describe('the gallery draws every component in both themes, in real frames', () => {
  test('both frames draw all twenty-two components on their own theme', async ({ page }) => {
    const frames = await open(page);
    for (const [theme, t] of Object.entries(THEMES)) {
      const f = frames[theme];
      await expect(f.locator('section.g-block')).toHaveCount(22);
      // Full bleed: the frame document paints the editor pane's --elevated.
      expect(await style(f.locator('body'), 'backgroundColor')).toBe(t.base);
      expect(await f.locator('body').evaluate((b) => b.classList.contains('light'))).toBe(theme === 'light');
      expect(await f.locator('body').evaluate(() => typeof window.Rundock.ui.button)).toBe('function');
    }
    if (process.env.RUNDOCK_UI_EVIDENCE) {
      for (const theme of Object.keys(THEMES)) {
        const sections = frames[theme].locator('section.g-block');
        for (let i = 0; i < 22; i += 1) {
          await sections.nth(i).screenshot({ path: path.join(process.env.RUNDOCK_UI_EVIDENCE, `${theme}-${String(i + 1).padStart(2, '0')}.png`), scale: 'css', animations: 'disabled' });
        }
      }
    }
  });

  test('filled controls carry --accent-action with white, and danger is an outline', async ({ page }) => {
    const frames = await open(page);
    for (const [theme, t] of Object.entries(THEMES)) {
      const f = frames[theme];
      const primary = f.locator('.rui-btn-primary').first();
      expect(await style(primary, 'backgroundColor')).toBe(ACTION);
      expect(await style(primary, 'color')).toBe(WHITE);
      const danger = f.locator('.rui-btn-danger').first();
      expect(await style(danger, 'backgroundColor')).toBe(t.elevated);
      expect(await style(danger, 'color')).toBe(t.dangerText);
      expect(await style(danger, 'borderTopColor')).toBe('rgb(212, 44, 42)');
      expect(await style(f.locator('.rui-btn-danger-confirm').first(), 'backgroundColor')).toBe('rgb(212, 44, 42)');
      const checked = f.locator('[data-component="Checkbox"] .rui-checkbox:checked').first();
      expect(await style(checked, 'backgroundColor')).toBe(t.control);
      const on = f.locator('[data-component="Toggle"] .rui-toggle:checked').first();
      expect(await style(on, 'backgroundColor')).toBe(t.control);
      expect(await style(on, 'backgroundColor', '::after')).toBe(WHITE);
      expect(await style(f.locator('.rui-input').first(), 'borderTopColor')).toBe(t.text3);
      expect(await style(f.locator('.rui-chip-accent'), 'backgroundColor')).toBe(ACTION);
      expect(await style(f.locator('.rui-chip-accent'), 'color')).toBe(WHITE);
      expect(await style(f.locator('.rui-meter-fill').first(), 'backgroundColor')).toBe(t.control);
      const send = f.locator('#icon-buttons .rui-icon-btn-send.rui-active').first();
      expect(await style(send, 'backgroundColor')).toBe(ACTION);
      expect(await style(send, 'width')).toBe('42px');
      expect(await style(f.locator('#icon-buttons .rui-icon-btn:not(.rui-icon-btn-send)').first(), 'width')).toBe('32px');
      expect(await style(f.locator('.rui-time.rui-stale'), 'color')).toBe(t.stale);
    }
  });

  test('a stat with no trend has its secondary line flush with its label, and a trend draws its dot', async ({ page }) => {
    const frames = await open(page);
    for (const theme of Object.keys(THEMES)) {
      const stats = frames[theme].locator('[data-component="Stat"] .rui-stat');
      const plain = stats.filter({ hasText: 'Across 4 accounts' });
      const edge = async (sel) => plain.locator(sel).evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return range.getBoundingClientRect().left;
      });
      const indent = (await edge('.rui-stat-delta')) - (await edge('.rui-stat-label'));
      expect(Math.abs(indent), `${theme}: the plain secondary line is indented ${indent.toFixed(2)}px`).toBeLessThanOrEqual(0.5);
      expect(await style(plain.locator('.rui-stat-delta'), 'content', '::before')).toBe('none');
      const up = stats.filter({ hasText: '1.2pp this week' }).locator('.rui-stat-delta');
      expect(await style(up, 'backgroundColor', '::before')).toBe('rgb(107, 198, 126)');
    }
  });

  // Measured from the text box of the message's first line (a Range over its
  // first text node) against each button's box: a single line sits on the
  // buttons' centre line, and a block of text keeps its action and icon on
  // its first line. Both themes, in the real frames.
  test('an alert with an action centres one line on its buttons, and keeps a block of text\'s action on its first line', async ({ page }) => {
    const frames = await open(page);
    const measure = (alert) => alert.evaluate((el) => {
      const walker = document.createTreeWalker(el.querySelector('.rui-alert-message'), NodeFilter.SHOW_TEXT);
      const first = walker.nextNode();
      const range = document.createRange();
      range.selectNodeContents(first);
      const line = range.getClientRects()[0];
      const centre = (r) => r.top + r.height / 2;
      const icon = el.querySelector(':scope > svg').getBoundingClientRect();
      return {
        text: centre(line),
        buttons: [...el.querySelectorAll('button')].map((b) => centre(b.getBoundingClientRect())),
        icon: centre(icon),
      };
    });
    for (const theme of Object.keys(THEMES)) {
      const alerts = frames[theme].locator('[data-component="Alert"]');
      for (const which of ['alert-line', 'alert-block']) {
        const m = await measure(alerts.locator(`[data-g="${which}"]`));
        for (const b of m.buttons) {
          expect(Math.abs(m.text - b), `${theme} ${which}: the first line's centre is ${(m.text - b).toFixed(2)}px from a button's`).toBeLessThanOrEqual(0.5);
        }
        expect(Math.abs(m.icon - m.text), `${theme} ${which}: the icon is ${(m.icon - m.text).toFixed(2)}px off the first line`).toBeLessThanOrEqual(1);
      }
      // The first gallery alert, one line and one action, holds the same rule.
      const review = await measure(alerts.locator('.rui-alert').first());
      expect(Math.abs(review.text - review.buttons[0])).toBeLessThanOrEqual(0.5);
    }
  });

  test('a chip label is centred on its ink, not on the font box', async ({ page }) => {
    // Measured as the design review measured it: the label's ink from the
    // font's own glyph metrics (canvas actualBoundingBox), placed on the
    // label's real baseline, against the chip's box. A capitals-only label,
    // which has no ascender or descender to confuse the question. Pixel
    // thresholds were tried first and disagree with the metrics by half a
    // pixel through antialiasing, so they are not used here.
    const frames = await open(page);
    for (const theme of Object.keys(THEMES)) {
      const f = frames[theme];
      expect(await f.locator('body').evaluate(() => CSS.supports('text-box', 'trim-both cap alphabetic')), 'this engine trims the text box').toBe(true);
      const offset = await f.locator('body').evaluate((body) => {
        const chip = window.Rundock.ui.chip({ tone: 'attention', label: 'STALE' });
        body.appendChild(chip);
        const label = chip.firstChild;
        const probe = document.createElement('span');
        probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
        label.appendChild(probe);
        const baseline = probe.getBoundingClientRect().top;
        const cs = getComputedStyle(label);
        const ctx = document.createElement('canvas').getContext('2d');
        ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const m = ctx.measureText('STALE');
        const box = chip.getBoundingClientRect();
        const inkCentre = baseline + (m.actualBoundingBoxDescent - m.actualBoundingBoxAscent) / 2;
        chip.remove();
        return inkCentre - (box.top + box.height / 2);
      });
      expect(Math.abs(offset), `${theme}: the label's ink sits ${offset.toFixed(2)}px off the chip's centre`).toBeLessThanOrEqual(0.25);
    }
  });

  test('without text-box, the fallback keeps a chip label on a one-line box inside the chip', async ({ page }) => {
    // An engine without text-box never applies the @supports block, so the
    // shipped fallback rule, the label's line-height of 1, is what sets the
    // label. That engine is reproduced exactly: the one @supports rule is
    // taken out of the stylesheet the host injected into the frame, and
    // nothing else changes. No inline style stands in for the fallback, so
    // this measures the shipped rule: the label's line box is its font size,
    // the chip keeps its height, and the ink stays within 0.75px of centre.
    const frames = await open(page);
    for (const theme of Object.keys(THEMES)) {
      const r = await frames[theme].locator('body').evaluate((body) => {
        const removed = [];
        for (const sheet of document.styleSheets) {
          for (let i = sheet.cssRules.length - 1; i >= 0; i -= 1) {
            const rule = sheet.cssRules[i];
            if (rule.type === CSSRule.SUPPORTS_RULE && /text-box/.test(rule.conditionText) && /\.rui-chip-label/.test(rule.cssText)) {
              removed.push({ sheet, index: i, text: rule.cssText });
              sheet.deleteRule(i);
            }
          }
        }
        const chip = window.Rundock.ui.chip({ tone: 'attention', label: 'STALE' });
        const label = chip.firstChild;
        body.appendChild(chip);
        const probe = document.createElement('span');
        probe.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
        label.appendChild(probe);
        const cs = getComputedStyle(label);
        const ctx = document.createElement('canvas').getContext('2d');
        ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const m = ctx.measureText('STALE');
        const box = chip.getBoundingClientRect();
        const baseline = probe.getBoundingClientRect().top;
        const out = { removed: removed.length, inline: label.getAttribute('style'), textBox: cs.getPropertyValue('text-box'),
          lineHeight: cs.lineHeight, fontSize: cs.fontSize, height: box.height,
          offset: baseline + (m.actualBoundingBoxDescent - m.actualBoundingBoxAscent) / 2 - (box.top + box.height / 2) };
        chip.remove();
        for (const { sheet, index, text } of removed.reverse()) sheet.insertRule(text, index);
        return out;
      });
      expect(r.removed, `${theme}: exactly the one @supports trim rule was taken out`).toBe(1);
      expect(r.inline, 'the label carries no inline style standing in for the fallback').toBeNull();
      expect(r.textBox, `${theme}: with the trim rule gone the label is untrimmed, as in an engine without text-box`).toMatch(/^(normal|none|auto|)$/);
      expect(r.lineHeight, `${theme}: the shipped fallback sets the label's line box to its font size`).toBe(r.fontSize);
      expect(r.height, `${theme}: the chip keeps its 20px height`).toBe(20);
      expect(Math.abs(r.offset), `${theme}: the fallback label sits ${r.offset.toFixed(2)}px off centre`).toBeLessThanOrEqual(0.75);
    }
  });

  test('a card\'s header stands 16px clear of its content, with or without a subtitle, and a header alone adds nothing', async ({ page }) => {
    const frames = await open(page);
    for (const theme of Object.keys(THEMES)) {
      const gaps = await frames[theme].locator('#cards').evaluate((block) => [...block.querySelectorAll('.rui-card')].map((card) => {
        const head = card.querySelector(':scope > .rui-card-sub') || card.querySelector(':scope > .rui-card-title') || card.querySelector(':scope > .rui-card-head');
        const next = head.nextElementSibling;
        const bottom = card.getBoundingClientRect().bottom - parseFloat(getComputedStyle(card).paddingBottom) - parseFloat(getComputedStyle(card).borderBottomWidth);
        return next ? +(next.getBoundingClientRect().top - head.getBoundingClientRect().bottom).toFixed(2) : +(bottom - head.getBoundingClientRect().bottom).toFixed(2);
      }));
      expect(gaps, `${theme}: header alone, header alone (interactive), subtitle then content, title then content, actions and subtitle then content, actions then content`).toEqual([0, 0, 16, 16, 16, 16]);
    }
  });

  test('card actions sit at the end of the title line, centred on the title, and the title does not move', async ({ page }) => {
    const frames = await open(page);
    for (const theme of Object.keys(THEMES)) {
      const facts = await frames[theme].locator('#cards').evaluate((block) => [...block.querySelectorAll('.rui-card-head')].map((head) => {
        const card = head.parentElement;
        const cs = getComputedStyle(card);
        const t = head.querySelector('.rui-card-title').getBoundingClientRect();
        const a = head.querySelector('.rui-card-actions').getBoundingClientRect();
        const c = card.getBoundingClientRect();
        return {
          centre: +Math.abs((t.top + t.height / 2) - (a.top + a.height / 2)).toFixed(2),
          end: +Math.abs(a.right - (c.right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth))).toFixed(2),
          titleLeft: +(t.left - (c.left + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth))).toFixed(2),
          size: getComputedStyle(head.querySelector('.rui-card-title')).fontSize,
        };
      }));
      expect(facts.length, theme).toBe(2);
      for (const f of facts) {
        expect(f.centre, `${theme}: centred on the title`).toBeLessThan(0.5);
        expect(f.end, `${theme}: at the end of the row`).toBeLessThan(0.5);
        expect(f.titleLeft, `${theme}: the title where a card title always is`).toBe(0);
        expect(f.size, theme).toBe('14px');
      }
    }
  });

  test('the checkbox tick is centred in its box', async ({ page }) => {
    const frames = await open(page);
    for (const theme of Object.keys(THEMES)) {
      const box = frames[theme].locator('[data-component="Checkbox"] .rui-checkbox:checked:not(:disabled)').first();
      const png = await box.screenshot({ animations: 'disabled' });
      const tick = await pixelBox(page, png, { r: 255, g: 255, b: 255, tol: 40 });
      expect(tick.maxX, `${theme}: no tick pixels found`).toBeGreaterThan(0);
      const scale = tick.width / 16;
      const dx = ((tick.minX + tick.maxX + 1) / 2 - tick.width / 2) / scale;
      const dy = ((tick.minY + tick.maxY + 1) / 2 - tick.height / 2) / scale;
      expect(Math.abs(dx), `${theme}: tick is ${dx.toFixed(2)}px off centre horizontally`).toBeLessThanOrEqual(0.75);
      expect(Math.abs(dy), `${theme}: tick is ${dy.toFixed(2)}px off centre vertically`).toBeLessThanOrEqual(0.75);
    }
  });

  test('the slider thumb is centred on its track', async ({ page }) => {
    const frames = await open(page);
    for (const [theme, t] of Object.entries(THEMES)) {
      const range = frames[theme].locator('#live-slider input[type=range]');
      const png = await range.screenshot({ animations: 'disabled' });
      // The thumb and the filled track are both --accent-control. The thumb is
      // the columns where that colour runs taller than the 4px track.
      const [r, g, b] = t.controlRgb;
      const fill = await pixelBox(page, png, { r, g, b, tol: 12 });
      const scale = fill.height / 16;
      const cols = Object.entries(fill.columns).map(([x, c]) => ({ x: Number(x), ...c, h: c.max - c.min + 1 }));
      const thumb = cols.filter((c) => c.h > 6 * scale);
      const track = cols.filter((c) => c.h <= 4.5 * scale && c.h >= 2 * scale);
      expect(thumb.length, `${theme}: no thumb found`).toBeGreaterThan(0);
      expect(track.length, `${theme}: no filled track found`).toBeGreaterThan(0);
      const centre = (list) => list.reduce((sum, c) => sum + (c.min + c.max + 1) / 2, 0) / list.length;
      const offset = (centre(thumb) - centre(track)) / scale;
      expect(Math.abs(offset), `${theme}: thumb sits ${offset.toFixed(2)}px off the track's centre`).toBeLessThanOrEqual(0.5);
      const thumbHeight = Math.max(...thumb.map((c) => c.h)) / scale;
      expect(thumbHeight, `${theme}: the thumb's fill is ${thumbHeight}px tall`).toBeGreaterThanOrEqual(11);
    }
  });
});

test.describe('the keyboard, inside a sandboxed frame', () => {
  test('tabs: one tab stop, arrows move and select with wrapping, Home and End', async ({ page }) => {
    const f = (await open(page)).dark;
    const tabs = f.locator('#live-tabs [role=tab]');
    const selected = () => f.locator('#live-tabs [aria-selected=true]');
    await tabs.nth(0).focus();
    await expect(f.locator('#live-tabs [tabindex="0"]')).toHaveCount(1);
    await page.keyboard.press('ArrowRight');
    await expect(selected()).toHaveText('Positions');
    await expect(tabs.nth(1)).toBeFocused();
    await expect(tabs.nth(1)).toHaveAttribute('tabindex', '0');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(selected()).toHaveText('Overview');
    await page.keyboard.press('ArrowLeft');
    await expect(selected()).toHaveText('Risk profile');
    await page.keyboard.press('Home');
    await expect(selected()).toHaveText('Overview');
    await page.keyboard.press('End');
    await expect(selected()).toHaveText('Risk profile');
    await expect(f.locator('#live-tabs [tabindex="0"]')).toHaveCount(1);
    await page.keyboard.press('Tab');
    const stillInside = await f.locator('#live-tabs').evaluate((list) => list.contains(document.activeElement));
    expect(stillInside, 'Tab leaves the tablist: it is one tab stop').toBe(false);
  });

  test('vertical tabs: ArrowDown and ArrowUp move and select with wrapping, and the selected tab stays the one tab stop', async ({ page }) => {
    const f = (await open(page)).dark;
    const list = f.locator('#live-tabs-vertical');
    await expect(list).toHaveAttribute('aria-orientation', 'vertical');
    const tabs = list.locator('[role=tab]');
    const selected = () => list.locator('[aria-selected=true]');
    const stops = () => list.locator('[tabindex="0"]');
    await tabs.nth(0).focus();
    await page.keyboard.press('ArrowDown');
    await expect(selected()).toHaveText('Holdings');
    await expect(tabs.nth(1)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(selected()).toHaveText('Summary');
    await expect(tabs.nth(0)).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(selected()).toHaveText('Activity');
    await expect(tabs.nth(2)).toBeFocused();
    await expect(stops()).toHaveCount(1);
    await expect(stops()).toHaveText('Activity');
    // The horizontal arrows are not this tablist's keys.
    await page.keyboard.press('ArrowRight');
    await expect(selected()).toHaveText('Activity');
    await expect(tabs.nth(2)).toBeFocused();
  });

  test('option list: arrows move and select, wrapping; Space checks', async ({ page }) => {
    const f = (await open(page)).dark;
    const checked = () => f.locator('#live-options [aria-checked=true]');
    await f.locator('#live-options [aria-checked=true]').focus();
    await expect(checked()).toHaveText('Growth and income');
    await page.keyboard.press('ArrowDown');
    await expect(checked()).toHaveText('Capital preservation');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    await expect(checked()).toHaveText('Aggressive growth');
    await page.keyboard.press('ArrowUp');
    await expect(checked()).toHaveText('Value opportunities');
    await page.keyboard.press('ArrowLeft');
    await expect(checked()).toHaveText('Capital preservation');
    await expect(f.locator('#live-options [tabindex="0"]')).toHaveText('Capital preservation');
    await page.keyboard.press('Space');
    await expect(checked()).toHaveText('Capital preservation');
  });

  test('slider: the arrows move it and the announced value follows', async ({ page }) => {
    const f = (await open(page)).dark;
    const range = f.locator('#live-slider input[type=range]');
    await range.focus();
    await page.keyboard.press('ArrowRight');
    await expect(range).toHaveAttribute('aria-valuetext', '51 percent');
    await expect(f.locator('#live-slider .rui-slider-value b')).toHaveText('51 percent');
    await page.keyboard.press('End');
    await expect(range).toHaveAttribute('aria-valuetext', '100 percent');
    await page.keyboard.press('Home');
    await expect(range).toHaveAttribute('aria-valuetext', '0 percent');
  });

  test('menu: opens from the keyboard, moves, selects, and Escape returns focus', async ({ page }) => {
    const f = (await open(page)).dark;
    const trigger = f.locator('#live-menu .rui-menu-btn');
    const items = f.locator('#live-menu [role=menuitem]');
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(items.nth(0)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(items.nth(1)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toBeFocused();
    await expect(f.locator('body')).toHaveAttribute('data-last-select', 'Thesis built');
    await page.keyboard.press('ArrowUp');
    await expect(items.nth(2)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toBeFocused();
  });

  test('board: a card moves between columns from its menu, and focus follows it', async ({ page }) => {
    const f = (await open(page)).dark;
    const trigger = f.locator('#live-board [data-card="pltr"] .rui-menu-btn');
    await expect(trigger).toHaveAttribute('aria-label', 'Move PLTR');
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(f.locator('#live-board [data-card="pltr"] [role=menuitemradio][aria-checked=true]')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(f.locator('#live-board .rui-board-col[data-column="thesis"] [data-card="pltr"]')).toHaveCount(1);
    await expect(f.locator('#live-board [data-card="pltr"] .rui-menu-btn')).toBeFocused();
    await expect(f.locator('body')).toHaveAttribute('data-last-move', 'pltr:thesis');
    await expect(f.locator('#live-board [role=status]')).toHaveText('Moved PLTR to Thesis built');
  });
});

// Default widths (docs/RUNDOCK-UI.md, table): natural widths, locked, the
// spare taken by the main column (the widest text column that is not fixed),
// the filler only when there is none, and a narrow table scrolling inside its
// own wrapper.
test.describe('default column widths, in a real engine', () => {
  // Per column: its width, and its natural width measured independently here
  // (the widest one-line content of its header and cells, plus padding).
  // The status sample ("Not priced") is probed only in the tables that
  // have that column at index 4.
  const facts = (loc) => loc.evaluate((wrap) => {
    const table = wrap.querySelector('table');
    // What is drawn in a cell, left to right, leaving out visually hidden
    // text (an "Actions" header label is for assistive technology only).
    const inkOf = (cell) => {
      let left = Infinity;
      let right = -Infinity;
      for (const child of cell.childNodes) {
        if (child.nodeType === 1 && child.classList.contains('rui-visually-hidden')) continue;
        const r = document.createRange();
        r.selectNode(child);
        const box = r.getBoundingClientRect();
        if (!box.width) continue;
        left = Math.min(left, box.left);
        right = Math.max(right, box.right);
      }
      return right > left ? right - left : 0;
    };
    const pad = (cell) => { const cs = getComputedStyle(cell); return parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight); };
    const ths = [...table.querySelectorAll('thead th')];
    const rows = [...table.querySelectorAll('tbody tr')];
    const out = ths.map((th, i) => {
      const cells = [th, ...rows.map((tr) => tr.children[i])];
      const box = th.getBoundingClientRect();
      return { label: th.textContent, width: box.width, right: box.right, natural: Math.max(...cells.map((c) => inkOf(c) + pad(c))), truncated: th.scrollWidth > th.clientWidth };
    });
    // The right edge of the wrapper's content box, where a full row ends.
    const edge = wrap.getBoundingClientRect().left + wrap.clientLeft + wrap.clientWidth;
    // The status column's sample, "Not priced", measured in one of its cells.
    const cell = ths[4] && ths[4].textContent === 'Status' ? rows[0].children[4] : null;
    if (!cell) return { columns: out, edge, wrap: wrap.clientWidth, scroll: wrap.scrollWidth, pageScroll: document.documentElement.scrollWidth, page: window.innerWidth, fixed: table.classList.contains('rui-table-fixed') };
    const probe = document.createElement('span');
    probe.textContent = 'Not priced';
    cell.appendChild(probe);
    out[4].sample = probe.getBoundingClientRect().width + pad(cell);
    probe.remove();
    return { columns: out, edge, wrap: wrap.clientWidth, scroll: wrap.scrollWidth, pageScroll: document.documentElement.scrollWidth, page: window.innerWidth, fixed: table.classList.contains('rui-table-fixed') };
  });
  const near = (a, b) => Math.abs(a - b) < 1.5;

  test('the widest text column is the main column: it takes the spare room, every other column keeps its natural width, a row menu sits at the right edge, and longer text is capped with its title, in both themes', async ({ page }) => {
    const frames = await open(page);
    for (const theme of Object.keys(THEMES)) {
      const loc = frames[theme].locator('#default-widths');
      const f = await facts(loc);
      expect(f.fixed, `${theme}: locked in a fixed layout`).toBe(true);
      const [holding, note, units, value, status, actions] = f.columns;
      for (const c of f.columns) expect(c.truncated, `${theme}: ${c.label} header`).toBe(false);
      expect(status.sample, `${theme}: "Not priced" is the widest Status can show`).toBeGreaterThan(status.natural);
      status.natural = status.sample;
      // Holding is the widest text column, so it is the main column.
      for (const c of [note, status]) expect(holding.natural, `${theme}: Holding is wider than ${c.label}`).toBeGreaterThan(c.natural);
      expect(holding.width - holding.natural, `${theme}: Holding took the spare room`).toBeGreaterThan(20);
      for (const c of [note, units, value, status, actions]) expect(near(c.width, c.natural), `${theme}: ${c.label} keeps its natural width`).toBe(true);
      expect(f.columns.length, `${theme}: no filler while there is a main column`).toBe(6);
      expect(Math.abs(f.columns.reduce((sum, c) => sum + c.width, 0) - f.wrap), `${theme}: the columns fill the wrapper`).toBeLessThan(2);
      expect(near(actions.right, f.edge), `${theme}: the row menu sits at the right edge`).toBe(true);
      expect(f.scroll, `${theme}: no scroll when it fits`).toBeLessThanOrEqual(f.wrap);
      // Capping, in its own table: Ticker grows, so Note stays at its cap.
      const cut = await frames[theme].locator('#default-widths-capped').evaluate((w) => {
        const td = w.querySelector('tbody tr').children[1];
        const r = document.createRange();
        r.selectNodeContents(td);
        return { width: w.querySelectorAll('thead th')[1].getBoundingClientRect().width, ink: r.getBoundingClientRect().width, title: td.title, text: td.textContent, overflow: getComputedStyle(td).textOverflow, cut: td.scrollWidth > td.clientWidth };
      });
      expect(cut.ink, `${theme}: the note is longer than the cap`).toBeGreaterThan(280);
      expect(Math.abs(cut.width - 280), `${theme}: longer text is capped at 280px`).toBeLessThan(1.5);
      expect([cut.cut, cut.overflow], `${theme}: cut off with an ellipsis`).toEqual([true, 'ellipsis']);
      expect(cut.title, `${theme}: the whole text in its title`).toBe(cut.text);
      // A header wider than the cap sets the column's floor: never narrower
      // than its header, never cut.
      const reason = await frames[theme].locator('#default-widths-capped').evaluate((w) => {
        const th = w.querySelectorAll('thead th')[3];
        return { width: th.getBoundingClientRect().width, cut: th.scrollWidth > th.clientWidth };
      });
      expect(reason.width, `${theme}: the long header holds the column past the cap`).toBeGreaterThan(280);
      expect(reason.cut, `${theme}: and is not cut`).toBe(false);
    }
  });

  test('a sparse table: the text column takes the room, the pill column keeps its natural width, and the row menu sits at the right edge, in both themes', async ({ page }) => {
    const frames = await open(page);
    for (const theme of Object.keys(THEMES)) {
      const f = await facts(frames[theme].locator('#default-widths-sparse'));
      expect(f.columns.length, `${theme}: no filler`).toBe(3);
      const [item, section, actions] = f.columns;
      expect(item.width - item.natural, `${theme}: Item, the main column, took the room`).toBeGreaterThan(40);
      expect(near(section.width, section.natural), `${theme}: the pill column keeps its natural width`).toBe(true);
      expect(near(actions.width, actions.natural), `${theme}: the row menu keeps its natural width`).toBe(true);
      expect(near(actions.right, f.edge), `${theme}: the row menu sits at the right edge`).toBe(true);
      expect(Math.abs(f.columns.reduce((sum, c) => sum + c.width, 0) - f.wrap), `${theme}: the columns fill the wrapper`).toBeLessThan(2);
    }
  });

  test('a dense table: the widest text column takes what room there is, and with none to spare every column keeps its natural width and the table scrolls, in both themes', async ({ page }) => {
    const frames = await open(page);
    for (const theme of Object.keys(THEMES)) {
      const loc = frames[theme].locator('#default-widths-dense');
      const sum = (f) => f.columns.reduce((total, c) => total + c.natural, 0);
      const natural = sum(await facts(loc));
      // Room to spare: Name, the widest text column, takes all of it. The
      // box is sized here, free of the gallery's item cap and of its flex
      // row (which would shrink it back to the frame's width), so the room
      // is known whatever the frame's width; and the wrapper the table
      // observes is checked to have that width before anything is read.
      const roomyBox = Math.ceil(natural) + 120;
      await loc.evaluate((w, px) => { w.parentNode.style.maxWidth = 'none'; w.parentNode.style.flex = '0 0 auto'; w.parentNode.style.width = `${px}px`; }, roomyBox);
      await expect.poll(() => loc.evaluate((w) => w.getBoundingClientRect().width), { message: `${theme}: the wrapper has the width the test set` }).toBeCloseTo(roomyBox, 0);
      await expect.poll(async () => { const f = await facts(loc); return f.columns[1].width - f.columns[1].natural; }, { message: `${theme}: Name takes the room` }).toBeGreaterThan(100);
      const roomy = await facts(loc);
      expect(roomy.columns.length, `${theme}: no filler`).toBe(8);
      for (const c of roomy.columns.filter((_, i) => i !== 1)) expect(near(c.width, c.natural), `${theme}: ${c.label} keeps its natural width`).toBe(true);
      expect(near(roomy.columns[7].right, roomy.edge), `${theme}: the row menu sits at the right edge`).toBe(true);
      // No room to spare: unchanged, every column at its natural width, and
      // it scrolls inside its wrapper.
      const fullBox = Math.floor(natural) - 60;
      await loc.evaluate((w, px) => { w.parentNode.style.width = `${px}px`; }, fullBox);
      await expect.poll(() => loc.evaluate((w) => w.getBoundingClientRect().width), { message: `${theme}: the wrapper has the width the test set` }).toBeCloseTo(fullBox, 0);
      await expect.poll(async () => { const f = await facts(loc); return f.scroll > f.wrap; }, { message: `${theme}: it scrolls` }).toBe(true);
      const full = await facts(loc);
      expect(full.columns.length, `${theme}: no filler`).toBe(8);
      for (const c of full.columns) expect(near(c.width, c.natural), `${theme}: ${c.label} at its natural width`).toBe(true);
      expect(full.pageScroll, `${theme}: the page does not scroll sideways`).toBeLessThanOrEqual(full.page);
      await loc.evaluate((w) => { w.parentNode.style.maxWidth = ''; w.parentNode.style.flex = ''; w.parentNode.style.width = '100%'; });
    }
  });

  test('when no column qualifies, an empty filler takes the rest', async ({ page }) => {
    const frames = await open(page);
    for (const theme of Object.keys(THEMES)) {
      const loc = frames[theme].locator('#default-widths-held');
      const f = await facts(loc);
      const [ticker, units, actions, fill] = f.columns;
      expect(near(ticker.width, 90), `${theme}: Ticker keeps its width`).toBe(true);
      expect(near(units.width, units.natural), `${theme}: a numeric column is never the main column`).toBe(true);
      expect(near(actions.width, actions.natural), `${theme}: nor is a row menu`).toBe(true);
      expect(fill && fill.width, `${theme}: the filler takes the rest`).toBeGreaterThan(20);
      expect(Math.abs(f.columns.reduce((sum, c) => sum + c.width, 0) - f.wrap), `${theme}: so rows run the full width`).toBeLessThan(2);
      const filler = await loc.evaluate((w) => [...w.querySelectorAll('.rui-table-filler')].map((c) => ({ tag: c.tagName, hidden: c.getAttribute('aria-hidden'), text: c.textContent, focusable: c.tabIndex >= 0 || !!c.querySelector('[tabindex], button, input, a'), handle: !!c.querySelector('.rui-col-resize') })));
      expect(filler.filter((c) => c.tag !== 'COL').every((c) => c.hidden === 'true' && c.text === '' && !c.focusable && !c.handle), `${theme}: the filler is empty, hidden, never focusable, never resizable`).toBe(true);
      expect(filler.filter((c) => c.tag === 'TD').length, `${theme}: one filler cell per row`).toBe(2);
    }
  });

  test('measuring and sharing raise no error in the frame, into and out of scrolling (the host stands a view down on the first)', async ({ page }) => {
    const frames = await open(page);
    for (const theme of Object.keys(THEMES)) {
      const f = frames[theme];
      for (const id of ['#default-widths', '#live-edit-table']) {
        for (const px of ['200px', '100%', '320px', '100%']) {
          await f.locator(id).evaluate((w, width) => { w.parentNode.style.width = width; }, px);
          await page.waitForTimeout(150);
        }
      }
      await page.waitForTimeout(300);
      expect(await f.locator('body').evaluate((b) => b.dataset.errors || ''), `${theme}: errors raised in the frame`).toBe('');
    }
  });

  test('widths never move while a cell is being edited, and the spare is shared again once it closes', async ({ page }) => {
    const f = (await open(page)).dark;
    const t = f.locator('#live-edit-table');
    const widths = () => t.evaluate((w) => [...w.querySelectorAll('thead th')].map((th) => Math.round(th.getBoundingClientRect().width)));
    const full = await widths();
    // Narrowed a little with nothing open, still with room to spare: the
    // table shares the smaller room.
    await t.evaluate((w) => { w.parentNode.style.width = `${w.parentNode.getBoundingClientRect().width - 12}px`; });
    await expect.poll(async () => (await widths())[1], { message: 'Account gives up spare when the room narrows' }).toBeLessThan(full[1]);
    const narrow = await widths();
    expect(await t.evaluate((w) => w.scrollWidth <= w.clientWidth), 'still room to spare, so no scroll').toBe(true);
    // An editor opens, and the room comes back: nothing moves under it,
    // neither to shrink nor to stretch.
    await t.locator('tbody tr').first().locator('td').nth(3).locator('.rui-cell').click();
    await t.evaluate((w) => { w.parentNode.style.width = '560px'; });
    await page.waitForTimeout(250);
    expect(await widths(), 'nothing moves under an open editor when the room shrinks').toEqual(narrow);
    await t.evaluate((w) => { w.parentNode.style.width = '100%'; });
    await page.waitForTimeout(250);
    expect(await widths(), 'nor when it grows').toEqual(narrow);
    // Closed, with no further resize: the change that arrived under the
    // editor is applied at once, for the room there is now.
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await widths())[1], { message: 'Account takes the room back once editing ends' }).toBe(full[1]);
    const after = await widths();
    expect([after[0], after[after.length - 1]], 'the explicit widths hold throughout').toEqual([full[0], full[full.length - 1]]);
  });

  test('a table narrower than its columns keeps them, and scrolls inside its wrapper, never the page', async ({ page }) => {
    const frames = await open(page);
    for (const theme of Object.keys(THEMES)) {
      const f = await facts(frames[theme].locator('#default-widths-narrow'));
      for (const c of f.columns) {
        expect(c.truncated, `${theme}: ${c.label} header`).toBe(false);
        expect(Math.abs(c.width - Math.max(c.natural, c.sample || 0)), `${theme}: ${c.label} keeps exactly its natural width`).toBeLessThan(1.5);
      }
      expect(f.scroll, `${theme}: wider than its wrapper`).toBeGreaterThan(f.wrap);
      expect(f.pageScroll, `${theme}: the page does not scroll sideways`).toBeLessThanOrEqual(f.page);
      // A person can scroll it: a sideways wheel over the table moves it.
      const wrap = frames[theme].locator('#default-widths-narrow');
      await wrap.hover();
      await page.mouse.wheel(200, 0);
      await expect.poll(() => wrap.evaluate((w) => w.scrollLeft), { message: `${theme}: the wrapper scrolls under a sideways wheel` }).toBeGreaterThan(0);
    }
  });
});

// Column resizing (docs/RUNDOCK-UI.md, table): pointer and keyboard, the
// floors, a reset to the rule, and no column but the resized one moving.
test.describe('column resizing, in a real engine', () => {
  const t = (f) => f.locator('#resizable-table');
  const state = (f) => t(f).evaluate((w) => ({
    widths: [...w.querySelectorAll('thead th')].map((th) => Math.round(th.getBoundingClientRect().width)),
    table: Math.round(w.querySelector('table').getBoundingClientRect().width),
    wrap: w.clientWidth, scroll: w.scrollWidth,
    handles: [...w.querySelectorAll('thead th')].map((th) => { const h = th.querySelector('.rui-col-resize'); return h ? { now: Number(h.getAttribute('aria-valuenow')), min: Number(h.getAttribute('aria-valuemin')) } : null; }),
    last: document.body.dataset.lastResize || '',
  }));
  const handle = (f, i) => t(f).locator('thead th').nth(i).locator('.rui-col-resize');
  // Each column's natural width, measured here: its widest drawn content
  // (not a resize handle, not a hidden label) plus padding.
  const naturals = (f) => t(f).evaluate((w) => {
    const ink = (c) => { let l = Infinity; let r = -Infinity; for (const n of c.childNodes) { if (n.nodeType === 1 && (n.classList.contains('rui-col-resize') || n.classList.contains('rui-visually-hidden'))) continue; const g = document.createRange(); g.selectNode(n); const b = g.getBoundingClientRect(); if (!b.width) continue; l = Math.min(l, b.left); r = Math.max(r, b.right); } return r > l ? r - l : 0; };
    const ths = [...w.querySelectorAll('thead th')];
    const rows = [...w.querySelectorAll('tbody tr')];
    // Units has a minWidth of 90 in the gallery, which is part of its natural width.
    const minWidth = [0, 0, 90, 0, 0];
    return ths.map((th, i) => Math.max(minWidth[i] || 0, ...[th, ...rows.map((tr) => tr.children[i])].filter(Boolean).map((c) => { const cs = getComputedStyle(c); return ink(c) + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight); })));
  });
  const drag = async (page, f, i, dx) => {
    await handle(f, i).scrollIntoViewIfNeeded();
    const box = await handle(f, i).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dx / 2, box.y + box.height / 2, { steps: 4 });
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();
  };

  test('a drag fixes that column at its new width, the main column takes up the difference (the filler, once the main column itself is fixed), and onResize hears the width', async ({ page }) => {
    const frames = await open(page);
    for (const theme of Object.keys(THEMES)) {
      const f = frames[theme];
      const nat = await naturals(f);
      const before = await state(f);
      expect(before.handles.slice(0, 5).map(Boolean), `${theme}: every column but the row menu`).toEqual([true, true, true, true, false]);
      // Holding is the main column; Units and Status keep their natural
      // widths; Account (150px, as saved) and the row menu (a control) are
      // fixed.
      const natural = (s, i) => Math.abs(s.widths[i] - nat[i]) <= 1;
      expect(before.widths[0] - nat[0], `${theme}: Holding takes the spare room`).toBeGreaterThan(60);
      expect([2, 3].map((i) => natural(before, i)), `${theme}: Units and Status at their natural widths`).toEqual([true, true]);
      // Beside the main column: Status takes the drag, Holding gives it up.
      await drag(page, f, 3, 60);
      const after = await state(f);
      expect(Math.abs(after.widths[3] - before.widths[3] - 60), `${theme}: Status took the drag`).toBeLessThanOrEqual(1);
      expect(Math.abs(before.widths[0] - after.widths[0] - 60), `${theme}: Holding, the main column, gave up exactly that`).toBeLessThanOrEqual(1);
      expect([1, 2, 4].map((i) => after.widths[i]), `${theme}: no other column moved`).toEqual([1, 2, 4].map((i) => before.widths[i]));
      expect(Math.abs(after.table - after.wrap), `${theme}: the table still fills its wrapper`).toBeLessThanOrEqual(1);
      expect(JSON.parse(after.last), `${theme}: onResize`).toEqual({ key: 'status', width: after.widths[3] });
      expect(after.handles[3].now, `${theme}: aria-valuenow follows`).toBe(after.widths[3]);
      // The main column itself: fixed at its new width, and the room it gave
      // up goes to the filler; no other column moves.
      await drag(page, f, 0, -40);
      const fixed = await state(f);
      expect(Math.abs(after.widths[0] - fixed.widths[0] - 40), `${theme}: Holding took the drag`).toBeLessThanOrEqual(1);
      expect([1, 2, 3, 4].map((i) => fixed.widths[i]), `${theme}: no other column took the room`).toEqual([1, 2, 3, 4].map((i) => after.widths[i]));
      expect(fixed.widths.length, `${theme}: a filler column now`).toBe(6);
      expect(Math.abs(fixed.widths[5] - 40), `${theme}: the filler holds the room Holding gave up`).toBeLessThanOrEqual(1);
      expect(Math.abs(fixed.table - fixed.wrap), `${theme}: the rows still run the full width`).toBeLessThanOrEqual(1);
      expect(JSON.parse(fixed.last), `${theme}: onResize`).toEqual({ key: 'holding', width: fixed.widths[0] });
      // Wider than the room: the unfixed columns sit at their natural width,
      // and the table scrolls inside its wrapper, never the page.
      await drag(page, f, 0, 700);
      const wide = await state(f);
      expect(natural(wide, 2), `${theme}: Units at its natural width, not below`).toBe(true);
      expect(wide.scroll, `${theme}: the wrapper scrolls`).toBeGreaterThan(wide.wrap);
      expect(await t(f).evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${theme}: the page does not`).toBe(true);
    }
  });

  test('the keyboard: arrows step 8px, Shift 32px, never below the header or minWidth; Enter and a double-click put it back to the rule', async ({ page }) => {
    const f = (await open(page)).dark;
    const start = await state(f);
    await handle(f, 2).focus();
    await page.keyboard.press('ArrowRight');
    expect((await state(f)).widths[2]).toBe(start.widths[2] + 8);
    await page.keyboard.press('Shift+ArrowRight');
    expect((await state(f)).widths[2]).toBe(start.widths[2] + 40);
    await page.keyboard.press('ArrowLeft');
    const stepped = await state(f);
    expect(stepped.widths[2]).toBe(start.widths[2] + 32);
    expect(JSON.parse(stepped.last)).toEqual({ key: 'units', width: stepped.widths[2] });
    for (let i = 0; i < 20; i += 1) await page.keyboard.press('Shift+ArrowLeft');
    const floor = await state(f);
    expect(floor.widths[2], 'Units stops at its minWidth').toBe(90);
    expect(floor.handles[2].min).toBe(90);
    // Holding stops at its own header.
    await handle(f, 0).focus();
    for (let i = 0; i < 20; i += 1) await page.keyboard.press('Shift+ArrowLeft');
    const header = await t(f).evaluate((w) => {
      const th = w.querySelector('thead th');
      const r = document.createRange();
      r.selectNodeContents(th.firstChild);
      const cs = getComputedStyle(th);
      return { uncut: th.scrollWidth <= th.clientWidth, ink: r.getBoundingClientRect().width + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) };
    });
    expect(header.uncut, 'the header is never cut').toBe(true);
    expect((await state(f)).widths[0]).toBe((await state(f)).handles[0].min);
    expect(Math.abs((await state(f)).widths[0] - header.ink), 'the floor is the header text and its padding, not the handle').toBeLessThanOrEqual(1);
    // Account came in at 150px, as a saved width would: Enter puts it back
    // to the rule, and says so with a null width.
    expect(start.widths[1]).toBe(150);
    await handle(f, 1).focus();
    await page.keyboard.press('Enter');
    const reset = await state(f);
    expect(reset.widths[1], 'back to its natural width').toBeLessThan(150);
    expect(JSON.parse(reset.last)).toEqual({ key: 'account', width: null });
    await handle(f, 2).scrollIntoViewIfNeeded();
    await handle(f, 2).dblclick();
    const again = await state(f);
    const nat = await naturals(f);
    expect(Math.abs(again.widths[2] - nat[2]), 'a double-click resets too: Units is back under the rule, at its natural width').toBeLessThanOrEqual(1);
    expect(JSON.parse(again.last)).toEqual({ key: 'units', width: null });
  });

  test('resizing beside a grow column: the grow column takes up the difference, and no other column moves', async ({ page }) => {
    const f = (await open(page)).dark;
    const table = f.locator('#live-edit-table');
    const widths = () => table.evaluate((w) => [...w.querySelectorAll('thead th')].map((th) => Math.round(th.getBoundingClientRect().width)));
    // Give the grow column room above its natural width first, so the step
    // is taken up in full whatever the platform's font metrics: the box is
    // freed from the gallery's item cap and flex row, and widened.
    const start = await widths();
    const box = await table.evaluate((w) => Math.ceil(w.getBoundingClientRect().width) + 120);
    await table.evaluate((w, px) => { w.parentNode.style.maxWidth = 'none'; w.parentNode.style.flex = '0 0 auto'; w.parentNode.style.width = `${px}px`; }, box);
    await expect.poll(() => table.evaluate((w) => w.getBoundingClientRect().width), { message: 'the wrapper has the width the test set' }).toBeCloseTo(box, 0);
    await expect.poll(async () => (await widths())[1], { message: 'Account, the grow column, takes the new room' }).toBeGreaterThanOrEqual(start[1] + 100);
    const before = await widths();
    await table.locator('thead th').nth(2).locator('.rui-col-resize').focus();
    await page.keyboard.press('Shift+ArrowRight');
    const after = await widths();
    expect(after[2], 'Kind took the step').toBe(before[2] + 32);
    expect(after[1], 'Account, the grow column, gave up exactly the step').toBe(before[1] - 32);
    expect([0, 3, 4, 5, 6, 7].map((i) => after[i]), 'nor did any other column').toEqual([0, 3, 4, 5, 6, 7].map((i) => before[i]));
  });

  test('a focused handle shows its line in control orange, in both themes', async ({ page }) => {
    const frames = await open(page);
    for (const [theme, th] of Object.entries(THEMES)) {
      await handle(frames[theme], 0).focus();
      expect(await handle(frames[theme], 0).evaluate((h) => getComputedStyle(h, '::after').backgroundColor), theme).toBe(th.control);
    }
  });
});

// The editable table (docs/RUNDOCK-UI.md, table). Geometry and behaviour are
// measured here; the editing state's look is provisional under design review,
// so nothing below takes a pixel baseline of it.
test.describe('the editable table, in a real engine', () => {
  const table = (f) => f.locator('#live-edit-table');
  const cell = (f, row, col) => table(f).locator('tbody tr:not(.rui-table-message-row)').nth(row).locator('td').nth(col);
  // A refusal's line: the message row directly under row `row`.
  const line = (f, row) => table(f).locator('tbody tr:not(.rui-table-message-row)').nth(row).locator('xpath=following-sibling::tr[1][contains(@class, "rui-table-message-row")]').locator('.rui-cell-message');
  const QTY = 3;
  const PRICE = 4;
  const KIND = 2;
  const WATCH = 6;
  const ACTIONS = 7;
  const geometry = (t) => t.evaluate((wrap) => ({
    cols: [...wrap.querySelectorAll('thead th')].map((th) => { const r = th.getBoundingClientRect(); return [r.x, r.width]; }),
    rows: [...wrap.querySelectorAll('tr:not(.rui-table-message-row)')].map((tr) => tr.getBoundingClientRect().height),
  }));
  // Seen, not only present: the element takes a click where it is drawn, so
  // nothing clips or covers it.
  const seen = (loc) => loc.evaluate((m) => {
    const r = m.getBoundingClientRect();
    return r.width > 0 && m.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  });
  const same = (a, b, what) => {
    expect(a.cols.length, what).toBe(b.cols.length);
    a.cols.forEach(([x, w], i) => { expect(Math.abs(x - b.cols[i][0]), `${what}: column ${i} x`).toBeLessThan(0.01); expect(Math.abs(w - b.cols[i][1]), `${what}: column ${i} width`).toBeLessThan(0.01); });
    a.rows.forEach((h, i) => expect(Math.abs(h - b.rows[i]), `${what}: row ${i} height`).toBeLessThan(0.01));
  };
  // The editor lies exactly over the button it replaces.
  const covers = (td) => td.evaluate((c) => {
    const box = c.querySelector('.rui-cell-editor').getBoundingClientRect();
    const r = c.querySelector('.rui-cell').getBoundingClientRect();
    return { dx: Math.abs(box.x - r.x), dy: Math.abs(box.y - r.y), dw: Math.abs(box.width - r.width), dh: Math.abs(box.height - r.height) };
  });

  test('widths hold, overlong text ends in an ellipsis, and opening any editor moves no column and changes no row height, in both themes', async ({ page }) => {
    const frames = await open(page);
    for (const theme of Object.keys(THEMES)) {
      const f = frames[theme];
      const before = await geometry(table(f));
      const widths = before.cols.map(([, w]) => Math.round(w));
      expect([widths[0], widths[widths.length - 1]], `${theme}: the explicit widths win`).toEqual([72, 36]);
      // Beside explicit widths a numeric column is still exactly its natural
      // width: the explicit ones were read at their own widths, not stretched.
      const mv = await table(f).evaluate((w) => {
        const i = 5;
        const cells = [w.querySelectorAll('thead th')[i], ...[...w.querySelectorAll('tbody tr:not(.rui-table-message-row)')].map((tr) => tr.children[i])];
        // Drawn content only: a resize handle is not the header's text.
        const ink = (c) => { let l = Infinity; let r2 = -Infinity; for (const n of c.childNodes) { if (n.nodeType === 1 && n.classList.contains('rui-col-resize')) continue; const r = document.createRange(); r.selectNode(n); const b = r.getBoundingClientRect(); if (!b.width) continue; l = Math.min(l, b.left); r2 = Math.max(r2, b.right); } return r2 > l ? r2 - l : 0; };
        const natural = Math.max(...cells.map((c) => { const cs = getComputedStyle(c); return ink(c) + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight); }));
        return { width: w.querySelectorAll('thead th')[i].getBoundingClientRect().width, natural };
      });
      expect(Math.abs(mv.width - mv.natural), `${theme}: Market value at its natural width`).toBeLessThan(0.75);
      expect(await table(f).evaluate((w) => [...w.querySelectorAll('th')].filter((th) => th.scrollWidth > th.clientWidth).map((th) => th.textContent)), `${theme}: no header truncates`).toEqual([]);
      // Padding boxes, since a collapsed border adds half a pixel to some rows.
      const inner = await table(f).evaluate((w) => [...w.querySelectorAll('tbody tr')].map((tr) => tr.children[0].clientHeight));
      expect(new Set(inner).size, `${theme}: every body row one height, the overlong ticker included`).toBe(1);
      const ticker = cell(f, 3, 0);
      expect(await ticker.evaluate((c) => c.scrollWidth > c.clientWidth)).toBe(true);
      expect(await style(ticker, 'textOverflow')).toBe('ellipsis');
      const openers = [
        ['click on a quantity', () => cell(f, 0, QTY).locator('.rui-cell').click(), cell(f, 0, QTY)],
        ['F2 on a price', async () => { await cell(f, 1, PRICE).locator('.rui-cell').focus(); await page.keyboard.press('F2'); }, cell(f, 1, PRICE)],
        ['click on a kind select', () => cell(f, 2, KIND).locator('.rui-cell').click(), cell(f, 2, KIND)],
        ['click on an account (text)', () => cell(f, 0, 1).locator('.rui-cell').click(), cell(f, 0, 1)],
      ];
      for (const [what, openIt, td] of openers) {
        await openIt();
        await expect(td.locator('.rui-cell-editor')).toHaveCount(1);
        same(await geometry(table(f)), before, `${theme}, ${what}`);
        // The covered button still holds the cell's size, which is what keeps
        // a row of editable cells from collapsing under its editors.
        const held = await td.locator('.rui-cell').evaluate((b) => ({ h: b.getBoundingClientRect().height, v: getComputedStyle(b).visibility }));
        expect(held.v, `${theme}, ${what}: the button is hidden, not removed`).toBe('hidden');
        expect(held.h, `${theme}, ${what}: and keeps its height`).toBeGreaterThan(20);
        const c = await covers(td);
        for (const [k, v] of Object.entries(c)) expect(v, `${theme}, ${what}: the editor's ${k}`).toBeLessThan(0.5);
        await page.keyboard.press('Escape');
        await expect(td.locator('.rui-cell-editor')).toHaveCount(0);
      }
      await cell(f, 0, QTY).locator('.rui-cell').click();
      await page.keyboard.type('20000');
      await page.keyboard.press('Enter');
      await expect(line(f, 0)).toHaveText('Quantity: More than this account holds.');
      same(await geometry(table(f)), before, `${theme}, a refusal showing`);
      await page.keyboard.press('Escape');
      // On the last row the message reaches past the table's rounded wrapper.
      await cell(f, 3, QTY).locator('.rui-cell').click();
      await page.keyboard.type('x');
      await page.keyboard.press('Enter');
      expect(await seen(line(f, 3)), `${theme}: a last-row refusal is seen, inside the table`).toBe(true);
      await page.keyboard.press('Escape');
    }
  });

  test('the keyboard: Enter opens and commits, Tab moves on, Shift+Tab back, Escape returns focus, F2 opens, a refusal keeps focus', async ({ page }) => {
    const f = (await open(page)).dark;
    const button = (r, c) => cell(f, r, c).locator('.rui-cell');
    const editor = (r, c) => cell(f, r, c).locator('.rui-cell-editor');
    await button(0, QTY).focus();
    await page.keyboard.press('Enter');
    await expect(editor(0, QTY)).toBeFocused();
    await expect(editor(0, QTY)).toHaveAttribute('aria-label', 'Quantity of CRWD');
    await page.keyboard.type('130');
    await page.keyboard.press('Tab');
    await expect(f.locator('body')).toHaveAttribute('data-last-edit', '{"key":"quantity","value":130,"previous":120}');
    await expect(editor(0, PRICE)).toBeFocused();
    await expect(editor(0, PRICE)).toHaveAttribute('aria-label', 'Price (USD) of CRWD in Taxable');
    await page.keyboard.press('Shift+Tab');
    await expect(editor(0, QTY)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(button(0, QTY)).toBeFocused();
    await expect(button(0, QTY)).toHaveText('130');
    await expect(button(0, QTY)).toHaveAttribute('aria-label', 'Quantity of CRWD, 130');
    await page.keyboard.press('F2');
    await page.keyboard.type('abc');
    await page.keyboard.press('Enter');
    await expect(line(f, 0)).toHaveText('Quantity: Enter a number of 0 or more.');
    await expect(editor(0, QTY)).toBeFocused();
    await editor(0, QTY).fill('20000');
    await page.keyboard.press('Enter');
    await expect(line(f, 0)).toHaveText('Quantity: More than this account holds.');
    await expect(editor(0, QTY)).toHaveValue('130');
    await expect(editor(0, QTY)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(table(f).locator('.rui-table-message-row')).toHaveCount(0);
    await expect(button(0, QTY)).toBeFocused();
    // A save that holds: the cell is busy, then settles on the new value.
    // The gallery holds a price save for 150ms; here it holds for two seconds,
    // so the check on the held state cannot lose a race with it.
    await table(f).evaluate(() => { const t = window.setTimeout; window.setTimeout = (fn, ms, ...a) => t(fn, ms === 150 ? 2000 : ms, ...a); });
    await button(1, PRICE).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.type('110');
    await page.keyboard.press('Enter');
    await expect(cell(f, 1, PRICE)).toHaveAttribute('aria-busy', 'true');
    await expect(cell(f, 1, PRICE).locator('.rui-cell-saving')).toHaveText('Saving…');
    expect(await style(cell(f, 1, PRICE).locator('.rui-cell-editor'), 'opacity'), 'held at full strength').toBe('1');
    await expect(button(1, PRICE)).toHaveText('110.00');
    await expect(button(1, PRICE)).toBeFocused();
    await expect(cell(f, 1, PRICE)).not.toHaveAttribute('aria-busy', 'true');
    // A checkbox toggles in one activation.
    const watch = cell(f, 0, WATCH).locator('input[type=checkbox]');
    await watch.focus();
    await page.keyboard.press('Space');
    await expect(watch).toBeChecked();
    await expect(f.locator('body')).toHaveAttribute('data-last-edit', '{"key":"watch","value":true,"previous":false}');
  });

  test('Tab alone, from before the table, reaches every editable cell in row order, each named for its column and row; an open editor takes the covered display out of the order', async ({ page }) => {
    const f = (await open(page)).dark;
    const t = table(f);
    // What Tab should reach in the table, in document order: every editable
    // cell's control, named "<Column> of <row>, <value>" (a checkbox,
    // "<Column> of <row>"). Read off the DOM, not written out, so a cell
    // the order skipped is a cell missing from the walk.
    const expected = await t.evaluate((w) => {
      const heads = [...w.querySelectorAll('thead th')].map((th) => th.textContent.trim());
      return [...w.querySelectorAll('tbody tr:not(.rui-table-message-row)')].flatMap((tr, r) => [...tr.children].flatMap((td, c) => {
        const control = td.querySelector(':scope > .rui-cell, :scope > input[type=checkbox]:not(:disabled)');
        return control ? [{ r, c, head: heads[c] }] : [];
      }));
    });
    expect(expected.length, 'the gallery table has editable cells to walk').toBeGreaterThan(8);
    // Focus rests on the last tab stop before the table; from there on,
    // only the Tab key moves it, until it leaves the table.
    const walk = async () => {
      await t.evaluate((w) => {
        const stops = [...document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')]
          .filter((el) => el.tabIndex >= 0 && !el.disabled && el.getClientRects().length
            && (w.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING) && !w.contains(el));
        if (stops.length) stops[stops.length - 1].focus();
        else document.activeElement.blur();
      });
      const seen = [];
      for (let i = 0; i < 200; i += 1) {
        await page.keyboard.press('Tab');
        const at = await t.evaluate((w) => {
          const el = document.activeElement;
          if (!w.contains(el)) return { inside: false, after: !!(w.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) };
          const td = el.closest('tbody td');
          const tr = td && td.parentNode;
          const rows = [...w.querySelectorAll('tbody tr:not(.rui-table-message-row)')];
          return {
            inside: true, r: tr ? rows.indexOf(tr) : -1, c: td ? [...tr.children].indexOf(td) : -1,
            kind: el.matches('.rui-cell') ? 'display' : el.matches('.rui-cell-editor, .rui-cell-editor *') ? 'editor' : el.matches('input[type=checkbox]') ? 'checkbox' : 'other',
            name: el.getAttribute('aria-label'), text: el.textContent,
          };
        });
        if (!at.inside && seen.length) {
          expect(at.after, 'focus leaves the table forwards').toBe(true);
          return seen;
        }
        if (at.inside) seen.push(at);
      }
      throw new Error('Tab never left the table');
    };
    const rowName = async (r) => cell(f, r, 0).innerText();
    const clean = (await walk()).filter((s) => s.kind !== 'other');
    expect(clean.map(({ r, c }) => [r, c]), 'every editable cell, in row order, by Tab alone').toEqual(expected.map(({ r, c }) => [r, c]));
    for (const [i, s] of clean.entries()) {
      const { head } = expected[i];
      const who = head === 'Price (USD)' ? `${await rowName(s.r)} in ${(await cell(f, s.r, 1).innerText()).trim()}` : await rowName(s.r);
      expect(s.name, `row ${s.r}, column ${s.c}`).toBe(s.kind === 'checkbox' ? `${head} of ${who}` : `${head} of ${who}, ${s.text}`);
    }
    // Held open: a price save that never settles in this test keeps its
    // editor open when focus leaves, so the walk meets the editor where the
    // display was, and never the covered display.
    await t.evaluate(() => { const later = window.setTimeout; window.setTimeout = (fn, ms, ...a) => later(fn, ms === 150 ? 600000 : ms, ...a); });
    await cell(f, 1, PRICE).locator('.rui-cell').focus();
    await page.keyboard.press('Enter');
    await page.keyboard.type('111');
    await page.keyboard.press('Enter');
    await expect(cell(f, 1, PRICE)).toHaveAttribute('aria-busy', 'true');
    const held = await walk();
    const at = held.filter((s) => s.r === 1 && s.c === PRICE);
    expect(at.map((s) => s.kind), 'the open editor is reached, the display it covers is not').toEqual(['editor']);
    expect(held.filter((s) => s.kind !== 'other' && !(s.r === 1 && s.c === PRICE)).map(({ r, c }) => [r, c]), 'every other cell is still reached, in order')
      .toEqual(expected.filter(({ r, c }) => !(r === 1 && c === PRICE)).map(({ r, c }) => [r, c]));
  });

  test('clicking away commits, and focus stays where the click went', async ({ page }) => {
    const f = (await open(page)).dark;
    await cell(f, 1, QTY).locator('.rui-cell').click();
    await page.keyboard.type('641');
    await f.locator('#live-menu .rui-menu-btn').click();
    await expect(cell(f, 1, QTY).locator('.rui-cell')).toHaveText('641');
    await expect(f.locator('#live-menu [role=menuitem]').nth(0)).toBeFocused();
  });

  test('a row menu in a fixed-width column opens whole, never clipped by the table', async ({ page }) => {
    const f = (await open(page)).dark;
    const menu = cell(f, 3, ACTIONS).locator('.rui-menu');
    await menu.locator('.rui-menu-btn').click();
    const items = menu.locator('[role=menuitem]');
    await expect(items).toHaveCount(3);
    const hits = await menu.evaluate((m) => [...m.querySelectorAll('[role=menuitem]')].map((item) => {
      const r = item.getBoundingClientRect();
      return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === item;
    }));
    expect(hits, 'every item of the open menu takes a click where it is drawn').toEqual([true, true, true]);
  });

  // Treatment A's colours, per theme, from tokens.css.
  const LOOK = {
    dark: { text1: [240, 237, 232], text2: 'rgb(154, 149, 144)', surface: 'rgb(33, 33, 33)', danger: 'rgb(240, 112, 110)', active: 'rgb(61, 61, 61)', edit: 'rgb(232, 122, 90)', row: 'rgb(39, 39, 39)' },
    light: { text1: [26, 26, 26], text2: 'rgb(122, 117, 110)', surface: 'rgb(250, 248, 245)', danger: 'rgb(212, 44, 42)', active: 'rgb(255, 255, 255)', edit: 'rgb(191, 64, 27)', row: 'rgb(245, 242, 237)' },
  };
  // Where a cell's text is drawn: the box of its --text-1 ink, off a real
  // screenshot, so an input's text is measured the same way as a button's.
  const ink = async (page, td, rgb) => pixelBox(page, await td.screenshot(), { r: rgb[0], g: rgb[1], b: rgb[2], tol: 48 });

  test('the text does not move when an editor opens: a numeric and a text column, both themes', async ({ page }) => {
    const frames = await open(page);
    for (const theme of Object.keys(THEMES)) {
      const f = frames[theme];
      for (const [what, col] of [['numeric (quantity)', QTY], ['text (account)', 1]]) {
        const td = cell(f, 1, col);
        await page.mouse.move(0, 0);
        const reading = await ink(page, td, LOOK[theme].text1);
        await td.locator('.rui-cell').click();
        const editor = td.locator('.rui-cell-editor');
        // No caret and no selection, so only the text itself is ink.
        await editor.evaluate((e) => { e.style.caretColor = 'transparent'; e.setSelectionRange(e.value.length, e.value.length); });
        await page.mouse.move(0, 0);
        const editing = await ink(page, td, LOOK[theme].text1);
        expect(reading.maxX, `${theme}, ${what}: ink found`).toBeGreaterThan(0);
        // One device pixel at 4x: a quarter of a CSS pixel.
        for (const k of ['minX', 'maxX', 'minY', 'maxY']) expect(Math.abs(editing[k] - reading[k]), `${theme}, ${what}: ${k}`).toBeLessThanOrEqual(1);
        expect(await style(editor, 'textAlign')).toBe(await style(td, 'textAlign'));
        await page.keyboard.press('Escape');
      }
    }
  });

  test('treatment A: the active cell keeps the raised surface off the row, and an inset ring says focus, editing or refused', async ({ page }) => {
    const frames = await open(page);
    for (const [theme, t] of Object.entries(THEMES)) {
      const f = frames[theme];
      const td = cell(f, 0, QTY);
      const shadow = () => style(td, 'boxShadow');
      await td.locator('.rui-cell').click();
      await page.mouse.move(0, 0);
      expect(await style(td, 'backgroundColor'), `${theme}: raised while editing, pointer gone`).toBe(LOOK[theme].active);
      expect(await style(cell(f, 1, QTY), 'backgroundColor'), `${theme}: the other rows are the table's own colour`).toBe('rgba(0, 0, 0, 0)');
      expect(await shadow()).toBe(`${LOOK[theme].edit} 0px 0px 0px 2px inset`);
      expect(await style(td.locator('.rui-cell-editor'), 'borderTopWidth')).toBe('0px');
      expect(await style(td.locator('.rui-cell-editor'), 'borderTopLeftRadius')).toBe('0px');
      await page.keyboard.type('abc');
      await page.keyboard.press('Enter');
      expect(await shadow(), `${theme}: refused`).toBe(`${LOOK[theme].danger} 0px 0px 0px 2px inset`);
      expect(await seen(line(f, 0)), `${theme}: the refusal is seen on its own line under the row`).toBe(true);
      await page.keyboard.press('Escape');
      expect(await shadow(), `${theme}: keyboard focus`).toBe(`${LOOK[theme].text2} 0px 0px 0px 1px inset`);
      expect(await style(td, 'backgroundColor'), `${theme}: raised with keyboard focus`).toBe(LOOK[theme].active);
      await cell(f, 2, 0).hover();
      expect(await style(cell(f, 2, 0), 'backgroundColor'), `${theme}: the row tint`).toBe(LOOK[theme].row);
      await cell(f, 2, QTY).locator('.rui-cell').hover();
      expect(await style(cell(f, 2, QTY).locator('.rui-cell'), 'backgroundColor'), `${theme}: a hovered editable cell's own tint`).toBe(LOOK[theme].surface);
      expect(await style(cell(f, 2, QTY), 'boxShadow'), `${theme}: hover draws no ring`).toBe('none');
    }
  });

  test('one row menu per row, and no pencil anywhere, hovered or not', async ({ page }) => {
    const f = (await open(page)).dark;
    const count = () => table(f).evaluate((w) => ({
      triggers: [...w.querySelectorAll('tbody tr')].map((tr) => tr.querySelectorAll('[aria-haspopup]').length),
      icons: [...w.querySelectorAll('td.rui-td-edit svg, .rui-cell svg')].length,
    }));
    expect(await count()).toEqual({ triggers: [1, 1, 1, 1], icons: 0 });
    // Nothing is drawn beside the trigger: a clipped narrow cell used to draw
    // an ellipsis there, which read as a second set of dots.
    for (let r = 0; r < 4; r += 1) {
      const td = cell(f, r, ACTIONS);
      const [tb, bb] = [await td.boundingBox(), await td.locator('.rui-menu-btn').boundingBox()];
      const stray = await page.evaluate(async ([b64, from]) => {
        const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const x = c.getContext('2d'); x.drawImage(img, 0, 0);
        const { data } = x.getImageData(0, 0, img.width, img.height);
        const at = (i, y) => data.slice((y * img.width + i) * 4, (y * img.width + i) * 4 + 3);
        const bg = at(2, Math.floor(img.height / 2));
        let n = 0;
        for (let y = 3; y < img.height - 3; y += 1) for (let i = from; i < img.width; i += 1) {
          const p = at(i, y);
          if (Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]) > 40) n += 1;
        }
        return n;
      }, [(await td.screenshot()).toString('base64'), Math.ceil((bb.x + bb.width - tb.x) * 4) + 2]);
      expect(stray, `row ${r}: ink beside the menu trigger`).toBe(0);
    }
    for (let r = 0; r < 4; r += 1) {
      await cell(f, r, QTY).locator('.rui-cell').hover();
      expect(await count(), `hovering row ${r}`).toEqual({ triggers: [1, 1, 1, 1], icons: 0 });
    }
  });

  test('rows are square: no cell of a hovered row is rounded', async ({ page }) => {
    const frames = await open(page);
    for (const theme of Object.keys(THEMES)) {
      const f = frames[theme];
      await cell(f, 1, 0).hover();
      const radii = await table(f).evaluate((wrap) => [...wrap.querySelectorAll('th, td')].map((c) => {
        const s = getComputedStyle(c);
        return [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomLeftRadius, s.borderBottomRightRadius].join(' ');
      }));
      expect(new Set(radii), theme).toEqual(new Set(['0px 0px 0px 0px']));
    }
  });
});
