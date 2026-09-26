'use strict';
// Extension confinement, in a real engine (Chromium, browser mode).
//
// jsdom enforces neither sandbox flags nor Content-Security-Policy, so the
// unit suite can only prove the host's rules fail fast when removed. This is
// where the claims on the trust card are observed: a hostile extension is
// mounted through the REAL host modules, and whether anything reached the
// stand-in attacker is read from the attacker's own log.
//
// Safe to run anywhere: see test/helpers/confinement-harness.js. Every
// listener is on 127.0.0.1, the data is canary text from a temporary folder,
// and nothing is installed.

const { test, expect } = require('@playwright/test');
const harness = require('../helpers/confinement-harness.js');

const LEFT = 'the extension tried to leave its view and was stopped';

// TRACING OFF, and no page.evaluate before the moment under test. Both run
// script in the page as though the person had clicked, which sets the very
// activation state the host's click gate reads: with tracing on, a
// script-sent open was honoured in this spec for that reason alone. Results
// are read once, at the end of each test.
test.use({ trace: 'off' });

let listener;
let workspace;

test.beforeEach(async () => {
  listener = await harness.startListener();
  workspace = harness.canaryWorkspace();
});
test.afterEach(() => { listener.close(); });

async function settle(page, ms = 1500) {
  await page.waitForTimeout(ms);
  const results = await page.evaluate(() => window.results);
  // Every view in this suite runs in a frame the host built with
  // Rundock UI in it. The frame proves it before the fixture's first
  // statement: the library is there, every factory builds, and the injected
  // stylesheet styles them. Read after the fact, so nothing here is script
  // run in the page during the moment under test.
  expectRundockUi(results);
  return results;
}

function expectRundockUi(results) {
  expect(results.ui.length, 'the frame reported Rundock UI before its own script ran').toBeGreaterThan(0);
  const report = results.ui[0];
  expect(report.version, 'Rundock.ui.version is present').toMatch(/^\d+\.\d+$/);
  expect(report.factories, 'every factory is there').toBeGreaterThanOrEqual(23);
  expect(report.made, 'and every one built an element').toBe(report.factories);
  expect(report.primaryFill, 'the injected stylesheet styles them').toBe('rgb(193, 87, 41)');
}

test.describe('a view cannot leave its frame', () => {
  test('with the app page\'s frame policy, a view that leaves with the file reaches nothing, and the view ends', async ({ page }) => {
    const h = await harness.startHarness({ workspace, listener, framePolicy: true });
    try {
      await page.goto(h.url('leave-with-file.js'));
      const results = await settle(page);
      expect(listener.leaked(), 'no request carrying the canary reached the listener').toEqual([]);
      expect(listener.hits, 'no request of any kind reached it').toEqual([]);
      expect(results.degraded).toEqual([LEFT]);
    } finally { h.close(); }
  });

  // The control. Without it the test above would pass just as well if the
  // fixture never tried anything, or if the listener could not be reached.
  test('without the page policy the same view does leak, which proves the instrument sees a leak', async ({ page }) => {
    const h = await harness.startHarness({ workspace, listener, framePolicy: false });
    try {
      await page.goto(h.url('leave-with-file.js'));
      const results = await settle(page);
      expect(listener.leaked().length, 'the listener received the canary: the escape is real without the policy').toBeGreaterThan(0);
      // Even then the host stops talking to what replaced the frame.
      expect(results.degraded).toEqual([LEFT]);
    } finally { h.close(); }
  });
});

test.describe('the region renderer cannot leave its frame', () => {
  test('a region frame that leaves with a diagram\'s source reaches nothing, and the service is stopped', async ({ page }) => {
    const h = await harness.startHarness({ workspace, listener, framePolicy: true });
    try {
      await page.goto(h.url('leave-region.js', 'region'));
      const results = await settle(page);
      expect(listener.hits).toEqual([]);
      expect(results.unusable).toContain(LEFT);
    } finally { h.close(); }
  });
});

test.describe('a view cannot choose its file or open the web unasked', () => {
  test('open with no click opens nothing; the same open after a click is honoured', async ({ page }) => {
    const h = await harness.startHarness({ workspace, listener, framePolicy: true });
    try {
      await page.goto(h.url('walk-the-workspace.js'));
      let results = await settle(page, 800);
      expect(results.opened, 'the script-sent open for .mcp.json reached nothing').toEqual([]);
      await page.frameLocator('#pane iframe').locator('#go').click();
      await page.waitForTimeout(300);
      results = await page.evaluate(() => window.results);
      expect(results.opened).toEqual(['notes/next.md']);
    } finally { h.close(); }
  });

  test('openExternal after a click is handed to the host\'s opener, never navigated in the frame', async ({ page }) => {
    const h = await harness.startHarness({ workspace, listener, framePolicy: true });
    try {
      await page.goto(h.url('walk-the-workspace.js'));
      await settle(page, 500);
      await page.frameLocator('#pane iframe').locator('#web').click();
      await page.waitForTimeout(300);
      const results = await page.evaluate(() => window.results);
      expect(results.externals).toEqual([`${listener.url}/web`]);
      expect(listener.hits, 'the frame itself went nowhere').toEqual([]);
      expect(results.degraded).toEqual([]);
    } finally { h.close(); }
  });
});

test.describe('one click inside a view is one request', () => {
  // The browser's record of a click lasts about five seconds and posting a
  // message does not use it up, so one click could carry a burst.
  test('a burst of opens and web addresses on one click honours exactly one', async ({ page }) => {
    const h = await harness.startHarness({ workspace, listener, framePolicy: true });
    try {
      await page.goto(h.url('one-click-many.js'));
      await settle(page, 500);
      await page.frameLocator('#pane iframe').locator('#burst').click();
      await page.waitForTimeout(400);
      const results = await page.evaluate(() => window.results);
      expect(results.opened.length + results.externals.length, 'one request for one click').toBe(1);
      expect(results.opened).toEqual(['notes/burst-0.md']);
    } finally { h.close(); }
  });

  // The control: with the spent click unable to stick, the same click lets
  // the whole burst through, so the test above is measuring the rule.
  test('without the rule the same click lets the whole burst through', async ({ page }) => {
    const h = await harness.startHarness({ workspace, listener, framePolicy: true, spendClicks: false });
    try {
      await page.goto(h.url('one-click-many.js'));
      await settle(page, 500);
      await page.frameLocator('#pane iframe').locator('#burst').click();
      await page.waitForTimeout(400);
      const results = await page.evaluate(() => window.results);
      expect(results.opened.length).toBe(6);
      expect(results.externals.length).toBe(6);
    } finally { h.close(); }
  });
});

test.describe('the click that opened a view is not a click inside it', () => {
  test('a view mounted by a click in the tree cannot use that click, even if it grabs focus', async ({ page }) => {
    const h = await harness.startHarness({ workspace, listener, framePolicy: true });
    try {
      await page.goto(h.url('steal-focus.js', 'deferred'));
      await page.waitForTimeout(300);
      await page.click('#tree');
      await page.waitForTimeout(1200);
      const results = await page.evaluate(() => window.results);
      expectRundockUi(results);
      expect(results.opened, 'neither open, at once or a moment later, was honoured').toEqual([]);
      expect(results.externals).toEqual([]);
      expect(listener.hits).toEqual([]);
    } finally { h.close(); }
  });
});

test.describe('nothing outside extension frames changes', () => {
  // The page policy that stops an extension leaving would also stop the HTML
  // file preview following an off-site link. The preview sends such a link
  // to the browser instead; before, it loaded the site inside the pane.
  test('a web link in an HTML file preview opens outside the pane, and the preview stays put', async ({ page }) => {
    const h = await harness.startHarness({ workspace, listener, framePolicy: true });
    try {
      await page.goto(h.url('preview-link.html', 'preview'));
      await page.waitForTimeout(600);
      await page.frameLocator('#pane iframe').locator('#out').click();
      await page.waitForTimeout(400);
      const results = await page.evaluate(() => window.results);
      expect(results.windowOpened).toEqual([`${listener.url}/preview-click`]);
      expect(listener.hits, 'the preview frame itself went nowhere').toEqual([]);
    } finally { h.close(); }
  });
});

test.describe('what the browser-mode card admits is true', () => {
  // The browser-mode trust card says peer-to-peer connections are only
  // blocked in the desktop app. This observes that the sentence is needed:
  // in a browser, a peer connection's STUN traffic does reach the listener.
  // If a future engine starts blocking it, this fails, and the card can say
  // more.
  test('a peer connection is not blocked in browser mode, which is what the card says', async ({ page }) => {
    const h = await harness.startHarness({ workspace, listener, framePolicy: true });
    try {
      await page.goto(h.url('peer-connection.js'));
      await settle(page, 2000);
      expect(listener.udpPackets.length).toBeGreaterThan(0);
    } finally { h.close(); }
  });
});

test.describe('Rundock UI in the frame widens nothing', () => {
  test('a view that uses the library and then leaves with the file reaches nothing, and the view ends', async ({ page }) => {
    const h = await harness.startHarness({ workspace, listener, framePolicy: true });
    try {
      await page.goto(h.url('ui-then-leave.js'));
      const results = await settle(page);
      expect(listener.hits, 'no request of any kind reached the listener').toEqual([]);
      expect(results.degraded).toEqual([LEFT]);
    } finally { h.close(); }
  });

  test('a frame working every component posts nothing but ready, and reaches nothing', async ({ page }) => {
    const h = await harness.startHarness({ workspace, listener, framePolicy: true });
    try {
      await page.goto(h.url('every-component.js', 'view', { probe: false }));
      await page.waitForTimeout(1500);
      const results = await page.evaluate(() => window.results);
      expect(await page.frameLocator('#pane iframe').locator('body').getAttribute('data-worked'), 'the fixture worked every component, before and after init').toBe('twice');
      expect(results.frameMessages, 'the only message the frame sent is ready').toEqual(['ready']);
      expect(results.degraded).toEqual([]);
      expect(listener.hits).toEqual([]);
    } finally { h.close(); }
  });

  test('an embedded view is built with Rundock UI before its entry runs, and told it is embedded', async ({ page }) => {
    const h = await harness.startHarness({ workspace, listener, framePolicy: true });
    try {
      await page.goto(h.url('ui-then-leave.js', 'embedded'));
      const results = await settle(page);
      expect(results.ui[0].bodyClass).toContain('rundock-embedded');
      expect(listener.hits).toEqual([]);
    } finally { h.close(); }
  });

  test('a view that misuses a component ends in the plain view with the library\'s reason', async ({ page }) => {
    const h = await harness.startHarness({ workspace, listener, framePolicy: true });
    try {
      await page.goto(h.url('misuse-component.js'));
      const results = await settle(page);
      expect(results.degraded).toHaveLength(1);
      expect(results.degraded[0]).toMatch(/^the extension reported a failure: .*Rundock\.ui\.button: variant must be one of/);
    } finally { h.close(); }
  });

  test('a library that fails as it installs ends the view in the plain view, with the reason named', async ({ page }) => {
    const h = await harness.startHarness({ workspace, listener, framePolicy: true, brokenLibrary: true });
    try {
      await page.goto(h.url('walk-the-workspace.js'));
      await page.waitForTimeout(1500);
      const results = await page.evaluate(() => window.results);
      expect(results.degraded).toHaveLength(1);
      expect(results.degraded[0]).toMatch(/Rundock UI failed to install \(harness control\)/);
      // The entry never ran: not its first statement (the Rundock UI report),
      // not its ready, not its open. The frame said exactly one thing.
      expect(results.frameMessages, 'the failed install is the only thing the frame said').toEqual(['error']);
      expect(results.ui).toEqual([]);
      expect(results.opened).toEqual([]);
    } finally { h.close(); }
  });
});
