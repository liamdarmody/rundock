'use strict';
// Theme and token cascade, end to end.
//
// This suite is the safety net for splitting the 1,125-line <style> block in
// index.html into linked stylesheets. Until it landed there was NO rendered
// theme coverage anywhere: the only theme test in the repo was
// test/unit/theme-choice.test.js, which tests the pure decision function and
// never renders a pixel. A broken cascade would therefore have reached a user
// before it reached a test.
//
// It asserts resolved values on a real page rather than class names, because
// a class name flipping proves nothing about whether the light-theme block
// still wins over :root once the two live in different files.
//
const base = require('@playwright/test');
const { appendRawCoverage, writeLcov, isClientEntry } = require('./coverage.js');

const test = base.test.extend({
  page: async ({ page }, use) => {
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await use(page);
    const entries = await page.coverage.stopJSCoverage();
    appendRawCoverage(entries.filter(e => isClientEntry(e.url)));
  },
});
const { expect } = base;

test.afterAll(async () => {
  await writeLcov();
});

// Every token the light theme overrides. If the split breaks the cascade,
// these stop changing between themes, which is the failure this suite exists
// to catch.
const THEMED = [
  '--base', '--surface', '--elevated', '--chrome', '--card',
  '--border', '--text-1', '--text-2', '--accent-glow',
];

// Tokens deliberately shared by both themes. The accent is the brand and does
// not shift; the type scale and layout metrics are not colours at all. If one
// of these starts changing, a light-theme block has grown a declaration it
// should not have.
const INVARIANT = [
  '--accent', '--accent-hover', '--success', '--attention', '--working', '--idle',
  '--danger',
  '--heading', '--title', '--body', '--caption', '--label',
  '--nav-rail-width', '--topbar-height', '--content-radius',
  '--radius-xs', '--radius-sm', '--radius-md', '--radius-lg', '--radius-xl',
  '--radius-pill', '--radius-circle',
  '--duration-fast', '--duration-base', '--duration-slow',
];

const NAV_SECTIONS = ['conversations', 'team', 'files', 'skills', 'settings'];

// ── helpers ──────────────────────────────────────────────────────────────────

async function boot(page) {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
}

// Read a batch of custom properties as the browser resolves them on <body>.
//
// Read them off <body>, never off documentElement. The light theme overrides
// tokens through `body.light { ... }`, so :root always reports the dark values
// however the app is themed. Custom properties inherit, so <body> sees both the
// :root declarations and the light overrides, which is what the app's own rules
// resolve against. Probing :root here silently passed the invariance test and
// failed the consumption test, which is how this was found.
function readTokens(page, names) {
  return page.evaluate((list) => {
    const cs = getComputedStyle(document.body);
    const out = {};
    for (const n of list) out[n] = cs.getPropertyValue(n).trim();
    return out;
  }, names);
}

// Switch theme and wait for it to finish arriving.
//
// The settle step is not optional. The universal selector carries
// `transition: background-color 0.2s ease, border-color .., color ..`, so for
// 200ms after a theme change getComputedStyle returns the INTERPOLATED colour
// rather than the target: a dark theme reports a light background and looks
// exactly like a broken cascade. This cost an hour to diagnose the first time.
//
// It polls rather than sleeping, so it settles as fast as the transition does
// and stays correct if that duration is ever tokenised to another value.
async function setTheme(page, light) {
  await page.evaluate((wantLight) => {
    if (document.body.classList.contains('light') !== wantLight) toggleTheme();
  }, light);
  await expect.poll(
    () => page.evaluate(() => document.body.classList.contains('light')),
  ).toBe(light);
  await expect.poll(
    () => page.evaluate(() => {
      const cs = getComputedStyle(document.body);
      return cs.backgroundColor === tokenAsRgb(cs, '--base');
      function tokenAsRgb(style, name) {
        const m = /^#([0-9a-f]{6})$/i.exec(style.getPropertyValue(name).trim());
        if (!m) return null;
        const n = parseInt(m[1], 16);
        return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
      }
    }),
    { message: `theme transition must settle (light=${light})` },
  ).toBe(true);
}

// Relative luminance, good enough to order two greys. Accepts the hex forms
// the token file actually uses.
function luma(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
}

// ── the cascade ──────────────────────────────────────────────────────────────

test('every light-theme token override actually takes effect', async ({ page }) => {
  await boot(page);

  await setTheme(page, false);
  const dark = await readTokens(page, THEMED);
  await setTheme(page, true);
  const light = await readTokens(page, THEMED);

  for (const name of THEMED) {
    expect(dark[name], `${name} must resolve in dark`).not.toBe('');
    expect(light[name], `${name} must resolve in light`).not.toBe('');
    expect(
      light[name],
      `${name} is the same in both themes, so the light override is not winning`,
    ).not.toBe(dark[name]);
  }
});

test('tokens shared by both themes do not drift apart', async ({ page }) => {
  await boot(page);

  await setTheme(page, false);
  const dark = await readTokens(page, INVARIANT);
  await setTheme(page, true);
  const light = await readTokens(page, INVARIANT);

  for (const name of INVARIANT) {
    expect(dark[name], `${name} must resolve`).not.toBe('');
    expect(light[name], `${name} must not change with the theme`).toBe(dark[name]);
  }
});

test('the tokens are consumed, not merely declared', async ({ page }) => {
  await boot(page);

  // A token can resolve correctly while nothing uses it. Reading it back off a
  // painted element proves the declaration reaches the pixels. setTheme has
  // already waited out the colour transition, so these reads are the settled
  // values.
  for (const light of [false, true]) {
    await setTheme(page, light);
    const settled = await page.evaluate(() => {
      const cs = getComputedStyle(document.body);
      const hex = (v) => {
        const m = /^#([0-9a-f]{6})$/i.exec(cs.getPropertyValue(v).trim());
        if (!m) return null;
        const n = parseInt(m[1], 16);
        return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
      };
      return { bg: cs.backgroundColor, wantBg: hex('--base'), fg: cs.color, wantFg: hex('--text-1') };
    });
    expect(settled.bg, `body background must be --base (light=${light})`).toBe(settled.wantBg);
    expect(settled.fg, `body colour must be --text-1 (light=${light})`).toBe(settled.wantFg);
  }
});

test('the chrome stays recessed behind the content in both themes', async ({ page }) => {
  await boot(page);

  // Documented intent in the token file: the top bar and rail sit BEHIND the
  // content, so the chrome is always further from the content than the panel
  // surface is. In dark that means darker; in light the same direction is
  // achieved by darkening, because the surface has no headroom to lighten.
  for (const light of [false, true]) {
    await setTheme(page, light);
    const t = await readTokens(page, ['--chrome', '--surface']);
    const chrome = luma(t['--chrome']);
    const surface = luma(t['--surface']);
    expect(chrome, `--chrome must be a plain hex (light=${light})`).not.toBeNull();
    expect(surface, `--surface must be a plain hex (light=${light})`).not.toBeNull();
    expect(chrome, `chrome must sit behind surface (light=${light})`).toBeLessThan(surface);
  }
});

// ── load order ───────────────────────────────────────────────────────────────

test('tokens resolve before first paint, with no flash of unstyled content', async ({ page }) => {
  // Recorded at DOMContentLoaded rather than after load, so a stylesheet that
  // 404s, or arrives late enough to repaint, fails here instead of being
  // noticed by a user as a flicker. This is the specific regression the split
  // into linked stylesheets risks.
  await page.addInitScript(() => {
    window.addEventListener('DOMContentLoaded', () => {
      const cs = getComputedStyle(document.body);
      window.__themeAtDcl = {
        base: cs.getPropertyValue('--base').trim(),
        text: cs.getPropertyValue('--text-1').trim(),
        rail: cs.getPropertyValue('--nav-rail-width').trim(),
      };
    });
  });
  await boot(page);

  const atDcl = await page.evaluate(() => window.__themeAtDcl);
  expect(atDcl, 'the DOMContentLoaded probe must have run').toBeTruthy();
  expect(atDcl.base, '--base must resolve before first paint').not.toBe('');
  expect(atDcl.text, '--text-1 must resolve before first paint').not.toBe('');
  expect(atDcl.rail, '--nav-rail-width must resolve before first paint').not.toBe('');
});

// ── every view, both themes ──────────────────────────────────────────────────

test('no view leaves a token unresolved in either theme', async ({ page }) => {
  await boot(page);

  // The standing acceptance criterion is a per-view eyeball in both themes.
  // This is the mechanical half: it cannot judge whether a colour looks right,
  // but it does catch a view whose stylesheet failed to load, which is exactly
  // what an eyeball on a busy day misses.
  for (const light of [false, true]) {
    await setTheme(page, light);
    for (const nav of NAV_SECTIONS) {
      await page.evaluate((n) => switchNav(n), nav);
      await expect(page.locator(`.nav-item.active[data-nav="${nav}"]`)).toBeVisible();

      const unresolved = await page.evaluate((names) => {
        const cs = getComputedStyle(document.body);
        return names.filter(n => cs.getPropertyValue(n).trim() === '');
      }, THEMED.concat(INVARIANT));

      expect(
        unresolved,
        `${nav} view, light=${light}: these tokens stopped resolving`,
      ).toEqual([]);
    }
  }
});

// ── the typeface ─────────────────────────────────────────────────────────────

test('the app renders in its own copy of Inter, fetched from nowhere', async ({ page }) => {
  const external = [];
  page.on('request', (r) => {
    const u = r.url();
    if (/^https?:\/\//.test(u) && !u.startsWith('http://localhost')) external.push(u);
  });

  await boot(page);
  await page.evaluate(() => document.fonts.ready);

  // Loaded, not merely declared: document.fonts reports what actually resolved,
  // so a missing or unserved file fails here rather than silently falling back
  // to San Francisco or Segoe, which is exactly how the Google-hosted version
  // hid for as long as it did.
  const loaded = await page.evaluate(() => [...document.fonts]
    .filter(f => f.family === 'Inter' && f.status === 'loaded')
    .map(f => f.style));
  expect(loaded, 'the roman face must load').toContain('normal');

  const usedByBody = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  expect(usedByBody).toContain('Inter');

  // Nothing at all may leave the machine. This watches real requests, so it
  // catches a fetch the static scan cannot see.
  expect(external, 'the client must not fetch from other origins').toEqual([]);
});

test('the editor stylesheet, injected at runtime, can see the tokens it uses', async ({ page }) => {
  // public/editor/styles.js is a <style> element built in JavaScript and
  // appended to the head when the editor first opens, which is a different
  // path from the <link> tags the rest of the styling arrives through. Eight
  // var(--danger, #fallback) fallbacks were removed from that file on the
  // grounds that --danger is always defined, and nothing proved the token
  // actually resolves in the context those rules run in. This is that proof.
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
  await page.locator('.nav-item[data-nav="files"]').click();
  // Named, not first: the first .file-item sits inside a collapsed folder and
  // is not clickable. wikilink-line.md is what test/e2e/editor.spec.js opens.
  await page.locator('.file-item', { hasText: 'wikilink-line.md' }).first().click();
  await expect(page.locator('.ProseMirror').first()).toBeVisible();

  // Read the RENDERED colour of elements the de-fallbacked rules actually
  // govern, not the token off the host.
  //
  // The first version of this test read getComputedStyle(host)
  // .getPropertyValue('--danger') and asserted it resolved. That proves almost
  // nothing: custom properties inherit, so it succeeds purely because
  // tokens.css declares --danger on :root, whether or not the editor's injected
  // stylesheet exists, parses, or still contains those rules. It would have
  // passed with all eight declarations malformed. Checking the style tag by
  // substring was a shape check, not a rendering one.
  const seen = await page.evaluate(() => {
    const host = document.querySelector('.tiptap-editor') || document.querySelector('.ProseMirror').closest('div');
    const probe = (cls) => {
      const el = document.createElement('span');
      el.className = cls;
      host.appendChild(el);
      const c = getComputedStyle(el).color;
      el.remove();
      return c;
    };
    const wrap = document.createElement('span');
    wrap.className = 'critic-substitution';
    const inner = document.createElement('span');
    inner.className = 'critic-sub-from';
    wrap.appendChild(inner); host.appendChild(wrap);
    const subFrom = getComputedStyle(inner).color;
    wrap.remove();
    return {
      hostFound: !!host,
      criticDelete: probe('critic-delete'),
      reviewSubFrom: probe('review-sub-from'),
      criticSubFrom: subFrom,
      plainSpan: probe('nothing-styles-me'),
    };
  });

  const DANGER = 'rgb(232, 90, 90)';
  expect(seen.hostFound, 'the editor host must exist').toBe(true);
  expect(seen.criticDelete, '.critic-delete must render --danger').toBe(DANGER);
  expect(seen.reviewSubFrom, '.review-sub-from must render --danger').toBe(DANGER);
  expect(seen.criticSubFrom, '.critic-substitution .critic-sub-from must render --danger').toBe(DANGER);
  // A control: if an unstyled span also came back red, the assertions above
  // would be measuring inheritance rather than the rules under test.
  expect(seen.plainSpan, 'an unstyled span must NOT be red').not.toBe(DANGER);
});
