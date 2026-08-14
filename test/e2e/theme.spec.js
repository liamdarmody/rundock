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
  '--radius-pill', '--radius-circle', '--radius-bubble',
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
  // path from the <link> tags the rest of the styling arrives through.
  //
  // What this proves, precisely: THREE of the five formerly-fallback rules in
  // that injected file render the resolved --danger. It does not cover the
  // .review-btn.reject:hover pair in the same file, nor the two in editor.css
  // and one in sidebar.css, which would need every state driven. All eight are
  // covered statically by test/unit/style-resolve-diff.test.js. An earlier
  // version of this comment claimed to prove all eight, which it never did.
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

test('every color-mix tint renders the colour the literal it replaced rendered', async ({ page }) => {
  // AC-5 asked for the channel values either side of each substitution, and
  // nothing computed them. The allowlist prose asserted the tints were safe;
  // an assertion in prose cannot fail.
  //
  // color-mix is resolved by the browser, so this has to run in one. Each pair
  // is the literal that was there before and the expression that replaced it.
  const PAIRS = [
    ['rgba(232,90,90,0.1)',  'color-mix(in srgb, var(--danger) 10%, transparent)', 'connection-bar disconnected'],
    ['rgba(232,90,90,0.08)', 'color-mix(in srgb, var(--danger) 8%, transparent)',  'danger callout background'],
    ['rgba(232,90,90,0.20)', 'color-mix(in srgb, var(--danger) 20%, transparent)', 'danger callout border'],
  ];
  // These three replaced a DIFFERENT red (232,93,93) as part of unifying the
  // reds, so they are expected to differ by exactly that, and the expectation
  // is written as the new red rather than the old one.
  const UNIFIED = [
    ['rgba(232,90,90,0.15)', 'color-mix(in srgb, var(--danger) 15%, transparent)', 'cancel button'],
    ['rgba(232,90,90,0.25)', 'color-mix(in srgb, var(--danger) 25%, transparent)', 'cancel button hover'],
    ['rgba(232,90,90,0.12)', 'color-mix(in srgb, var(--danger) 12%, transparent)', 'cancelled badge'],
  ];

  await boot(page);
  const resolve = (pairs) => page.evaluate((list) => {
    // Compare CHANNELS, not serialisations. Chromium reports an rgba() literal
    // as "rgba(232, 90, 90, 0.1)" and the equivalent color-mix as
    // "color(srgb 0.909804 0.352941 0.352941 / 0.1)". Those are the same
    // colour: 0.909804 x 255 is 232. A string comparison would call an exact
    // match a failure.
    const channels = (s) => {
      let m = /^rgba?\(([^)]+)\)$/.exec(s);
      if (m) {
        const p = m[1].split(',').map(v => parseFloat(v));
        return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
      }
      m = /^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)$/.exec(s);
      if (m) return [+m[1] * 255, +m[2] * 255, +m[3] * 255, m[4] === undefined ? 1 : +m[4]];
      return null;
    };
    return list.map(([expected, expr, label]) => {
      const a = document.createElement('div');
      const b = document.createElement('div');
      a.style.backgroundColor = expected;
      b.style.backgroundColor = expr;
      document.body.append(a, b);
      const want = channels(getComputedStyle(a).backgroundColor);
      const got = channels(getComputedStyle(b).backgroundColor);
      const rawGot = getComputedStyle(b).backgroundColor;
      a.remove(); b.remove();
      return { label, want, got, rawGot };
    });
  }, pairs);

  for (const r of [...(await resolve(PAIRS)), ...(await resolve(UNIFIED))]) {
    expect(r.want, `${r.label}: the literal must parse`).not.toBeNull();
    expect(r.got, `${r.label}: the tint must parse, got ${r.rawGot}`).not.toBeNull();
    // Separate tolerances, because the channels are not on the same scale.
    // RGB runs 0 to 255 and 0.6 is sub-rounding; alpha runs 0 to 1, where 0.6
    // is most of the range. A single tolerance of 0.6 let a tint written at
    // 14% pass as 10%, which the red proof caught.
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(r.got[i] - r.want[i]),
        `${r.label}: rgb channel ${i} differs by more than rounding`).toBeLessThanOrEqual(0.6);
    }
    expect(Math.abs(r.got[3] - r.want[3]),
      `${r.label}: alpha differs`).toBeLessThanOrEqual(0.005);
  }
});

test('the canvas follows the theme, which it did not until 0.11.7', async ({ page }) => {
  // The light theme overrides its tokens on body, so --base read at :root is
  // the dark value whatever theme is showing. While `html` carried the
  // background, the canvas painted #1A1A1A in light mode too. Dropping html
  // from that rule leaves it transparent, and CSS propagates body's background
  // to the canvas instead.
  //
  // This was carried as "invisible" for two slices on the grounds that the
  // app's own chrome covers the canvas. It was not invisible, it was unmeasured.
  await boot(page);
  for (const light of [false, true]) {
    await setTheme(page, light);
    const seen = await page.evaluate(() => {
      const cs = getComputedStyle(document.body);
      const m = /^#([0-9a-f]{6})$/i.exec(cs.getPropertyValue('--base').trim());
      const n = m ? parseInt(m[1], 16) : null;
      return {
        html: getComputedStyle(document.documentElement).backgroundColor,
        body: cs.backgroundColor,
        wantBody: n === null ? null : `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`,
      };
    });
    expect(seen.html, `html must stay transparent so body's background reaches the canvas (light=${light})`)
      .toBe('rgba(0, 0, 0, 0)');
    expect(seen.body, `the canvas colour must follow the theme (light=${light})`).toBe(seen.wantBody);
  }
});

test('the two pill conversions really were no-ops, measured rather than asserted', async ({ page }) => {
  // .msg-system and .prompt-pill were written with border-radius: 20px and are
  // now --radius-pill (999px). That is only a no-op if 20px already exceeded
  // half the rendered height, because border-radius clamps there.
  //
  // Those heights were measured once by hand and then stated in a comment,
  // which is the same shape of claim as "zero painted properties differ" and
  // "invisible", both of which were wrong earlier in this programme. Height
  // depends on font metrics, line-height and padding, none of which are pinned
  // anywhere, so the claim needs to be able to fail.
  await boot(page);

  const measured = await page.evaluate(() => {
    const host = document.querySelector('.messages') || document.body;
    const sample = (cls, text) => {
      const live = document.querySelector('.' + cls);
      if (live && live.getBoundingClientRect().height > 0) {
        return { cls, height: live.getBoundingClientRect().height, source: 'live element' };
      }
      // No live instance in this view: build one in the same container so it
      // inherits the same font metrics the real thing would.
      const el = document.createElement('div');
      el.className = cls;
      el.textContent = text;
      host.appendChild(el);
      const h = el.getBoundingClientRect().height;
      el.remove();
      return { cls, height: h, source: 'probe in .messages' };
    };
    return [sample('msg-system', 'Previous session'), sample('prompt-pill', 'Summarise this file')];
  });

  for (const m of measured) {
    expect(m.height, `.${m.cls} must render (${m.source})`).toBeGreaterThan(0);
    // The condition that makes 20px a full pill: twice the radius covers the
    // height. Stated as the inequality rather than as a remembered number.
    expect(m.height,
      `.${m.cls} renders ${m.height.toFixed(1)}px (${m.source}); a 20px radius only clamped to a pill while this stayed at or under 40px, so the switch to --radius-pill is no longer a no-op`,
    ).toBeLessThanOrEqual(40);
  }
});
