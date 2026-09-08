'use strict';
// The walk's steps, in the order the release runbook walks them: boot, the
// two repositories at their tags, the package install, the extension
// install, pins, the map, and a routine pressed by hand. Each step drives
// the real page through Playwright and reads the disk the server wrote.
//
// A step names the surface it needs in `precondition`, so a server that
// does not carry that surface fails the step out loud with the selector it
// looked for, and every step that builds on it fails for that reason. That
// is the whole answer to "did we walk it": a skipped step never reads as a
// walked one.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { LEAN_TEAM, CSV_EXTENSION, cloneAt, checkLeanTeam, checkCsvExtension, networkTokensIn } = require('./repos.js');

const LONG = 90000; // a clone over the network, waited for in the page

async function waitFor(pred, timeout = 30000, interval = 200) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let v = null;
    try { v = await pred(); } catch { v = null; }
    if (v) return v;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, interval));
  }
}

const inWorkspace = (ctx, rel) => path.join(ctx.workspace, ...rel.split('/'));
const onDisk = (ctx, rel) => fs.existsSync(inWorkspace(ctx, rel));
const readIf = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
const count = (page, selector) => page.locator(selector).count();

// A precondition on a control: the reason names what was looked for.
const surface = (selector, what) => async ({ page }) => ((await count(page, selector)) > 0 ? null : `${what} is absent from the page (${selector})`);
const reachable = (spec) => async () => {
  try { execFileSync('git', ['ls-remote', '--tags', '--refs', spec.url], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }); return null; }
  catch (e) { return `GitHub is unreachable for ${spec.repo}: ${String(e && e.message || e).split('\n')[0]}`; }
};

function unmet(findings) { return findings.filter((f) => !f.ok).map((f) => f.what).join('; '); }

async function openFromTree(page, name) {
  await page.locator('.nav-item[data-nav="files"]').click();
  const row = page.locator('#file-tree .file-item', { hasText: name }).first();
  await row.waitFor({ state: 'visible', timeout: 20000 });
  await row.click();
  await page.locator('#editor-filename', { hasText: name }).waitFor({ timeout: 15000 });
}

// The Packages section, asked for again on every poll: a redraw can undo a
// single showView, and asking twice costs nothing.
async function openPackages(page) {
  return waitFor(() => page.evaluate(() => {
    if (typeof showView !== 'function' || typeof showSettingsSection !== 'function') return false;
    showView('settings'); showSettingsSection('packages');
    if (typeof packagesCancel === 'function' && document.querySelector('.packages-success-card')) packagesCancel();
    const el = document.getElementById('packages-source-link');
    return !!(el && el.offsetParent !== null && !el.disabled);
  }), 15000);
}

async function submitLink(page, spec) {
  await page.fill('#packages-source-link', spec.url);
  await page.fill('#packages-source-ref', spec.tag);
  await page.getByRole('button', { name: 'Read it' }).click();
}

async function cardText(page, selector, timeout) {
  return waitFor(() => page.locator(selector).first().textContent(), timeout);
}

const openByPath = (page, rel) => page.evaluate((p) => openWorkspaceFilePath(p), rel);
const currentFile = (page) => page.evaluate(() => currentFilePath);
const extensionRecord = (ctx) => {
  const raw = readIf(inWorkspace(ctx, '.claude/rundock/extensions.json'));
  return raw ? (JSON.parse(raw).extensions || []).find((r) => r.name === CSV_EXTENSION.name) || null : null;
};

function buildSteps() {
  const seed = (ctx) => ctx.seed;
  return [
    { id: 'boot', name: 'the server boots from source and the page opens on the stub runtime',
      run: async (ctx, check) => {
        const up = await waitFor(async () => (await fetch(`http://127.0.0.1:${ctx.port}/`)).ok, 30000);
        check(!!up, `the server did not answer on port ${ctx.port}`);
        await ctx.page.goto(`http://127.0.0.1:${ctx.port}/`);
        // The tree the server pushes over the socket is the page's proof of
        // life; it holds for a workspace with no default agent, which the
        // seed deliberately is.
        const tree = await waitFor(() => count(ctx.page, '#file-tree .file-item'), 20000);
        check(!!tree, 'the file tree never arrived over the socket');
        const status = await ctx.page.evaluate(() => new Promise((resolve) => {
          const h = (ev) => { const m = JSON.parse(ev.data); if (m.type === 'runtime_status') { ws.removeEventListener('message', h); resolve(m); } };
          ws.addEventListener('message', h); ws.send(JSON.stringify({ type: 'get_runtime_status' }));
        }));
        const version = status && status.claude && status.claude.version;
        check(String(version).startsWith('0.0.0-stub'), `the server resolved claude ${version}, not the stub, so nothing may run`);
      } },
    { id: 'repo-team', name: `${LEAN_TEAM.repo} at ${LEAN_TEAM.tag} meets the stated expectations`, precondition: reachable(LEAN_TEAM),
      run: async (ctx, check) => {
        const dir = cloneAt(LEAN_TEAM.url, LEAN_TEAM.tag, path.join(ctx.scratch, 'lean-agent-team'));
        const missing = unmet(checkLeanTeam(dir));
        check(!missing, missing);
        // The product gives an order-0 agent the id `default`, so Team is
        // asked for that id where the package's own file says order 0.
        ctx.teamIds = Object.fromEntries(LEAN_TEAM.agents.map((a) =>
          [a, /^order:\s*0\s*$/m.test(fs.readFileSync(path.join(dir, '.claude', 'agents', `${a}.md`), 'utf8')) ? 'default' : a]));
      } },
    { id: 'repo-csv', name: `${CSV_EXTENSION.repo} at ${CSV_EXTENSION.tag} meets the stated expectations`, precondition: reachable(CSV_EXTENSION),
      run: async (ctx, check) => {
        ctx.csvClone = cloneAt(CSV_EXTENSION.url, CSV_EXTENSION.tag, path.join(ctx.scratch, 'rundock-csv-extension'));
        const missing = unmet(checkCsvExtension(ctx.csvClone));
        check(!missing, missing);
      } },
    { id: 'pack-offer', name: 'pasting the team link offers 3 agents and 2 skills as not a Rundock package', needs: ['boot', 'repo-team'],
      precondition: async (ctx) => ((await openPackages(ctx.page)) ? null : 'the GitHub link field (#packages-source-link) is absent from Settings'),
      run: async ({ page }, check) => {
        await submitLink(page, LEAN_TEAM);
        const headline = await cardText(page, '.packages-confirm-card .packages-headline', LONG);
        check(headline === "This isn't a Rundock package", `offer headline was ${JSON.stringify(headline)}`);
        const body = await page.locator('.packages-confirm-card .packages-body').first().textContent();
        check(/3 agents and 2 skills/.test(body), `offer body did not count 3 agents and 2 skills: ${body}`);
      } },
    { id: 'pack-confirm', name: 'confirming lands the agents, the skills and a receipt on disk', needs: ['pack-offer'],
      run: async (ctx, check) => {
        const { page } = ctx;
        await page.locator('.packages-confirm-card').getByRole('button', { name: 'Add to my team' }).click();
        const headline = await cardText(page, '.packages-success-card .packages-headline', 60000);
        check(headline === 'Added to your team', `success headline was ${JSON.stringify(headline)}`);
        for (const a of LEAN_TEAM.agents) check(onDisk(ctx, `.claude/agents/${a}.md`), `agent file ${a}.md missing on disk`);
        for (const s of LEAN_TEAM.skills) check(onDisk(ctx, `.claude/skills/${s}/SKILL.md`), `skill ${s} missing on disk`);
        const receipt = await page.locator('.packages-success-card').getAttribute('data-receipt');
        check(/^\.claude\/rundock\/receipts\//.test(receipt || ''), `receipt path not under .claude/rundock/receipts: ${receipt}`);
        check(onDisk(ctx, receipt), `receipt file ${receipt} missing on disk`);
        ctx.receipt = receipt;
      } },
    { id: 'pack-team', name: 'the three agents appear in Team', needs: ['pack-confirm'],
      run: async ({ page, teamIds }, check) => {
        await page.locator('.nav-item[data-nav="team"]').click();
        for (const a of LEAN_TEAM.agents) {
          const id = teamIds[a];
          const seen = await waitFor(() => count(page, `[data-org-agent="${id}"], [data-agent="${id}"]`), 20000);
          check(!!seen, `agent ${a} (id ${id}) is not shown in Team`);
        }
      } },
    { id: 'pack-skills', name: 'the two skills appear in Skills', needs: ['pack-confirm'],
      run: async ({ page }, check) => {
        await page.locator('.nav-item[data-nav="skills"]').click();
        for (const s of LEAN_TEAM.skills) {
          const seen = await waitFor(() => page.locator('.skill-sidebar-item', { hasText: new RegExp(s.replace(/-/g, '[- ]'), 'i') }).count(), 20000);
          check(!!seen, `skill ${s} is not listed in Skills`);
        }
      } },
    { id: 'pack-receipt', name: 'the receipt appears under Recently added', needs: ['pack-confirm'],
      precondition: async (ctx) => { await openPackages(ctx.page); return surface('.receipt-row', 'the Recently added list')(ctx); },
      run: async ({ page }, check) => {
        const rows = await page.locator('.receipt-row', { hasText: 'lean-agent-team' }).count();
        check(rows > 0, 'no Recently added row names lean-agent-team');
      } },
    { id: 'ext-trust', name: 'pasting the csv extension link at its tag reaches the trust step naming the init payload', needs: ['boot', 'repo-csv'],
      precondition: async (ctx) => ((await openPackages(ctx.page)) ? null : 'the GitHub link field (#packages-source-link) is absent from Settings'),
      run: async ({ page }, check) => {
        await submitLink(page, CSV_EXTENSION);
        const headline = await cardText(page, '.extension-trust-card .packages-headline', LONG);
        check(headline === `Install ${CSV_EXTENSION.name} ${CSV_EXTENSION.tag.replace(/^v/, '')}?`, `trust headline was ${JSON.stringify(headline)}`);
        const claims = await page.locator('.extension-trust-card .extension-host-claims').textContent();
        check(/opened file's/.test(claims) && /\bpath\b/.test(claims) && /\bcontent\b/.test(claims), `the trust step does not say the extension receives the opened file's text and path: ${claims}`);
      } },
    { id: 'ext-install', name: 'confirming installs the extension, whose served entry is the tagged file and free of network tokens', needs: ['ext-trust'],
      precondition: async ({ page }) => ((await page.evaluate(() => typeof window.rundockExtensionUiFetcher === 'function')) ? null : 'window.rundockExtensionUiFetcher is not wired'),
      run: async (ctx, check) => {
        const { page } = ctx;
        await page.locator('.extension-trust-card').getByRole('button', { name: 'Install it' }).click();
        const headline = await cardText(page, '.packages-success-card .packages-headline', 60000);
        check(/^Installed csv-table 1\.0\.1/.test(headline || ''), `install headline was ${JSON.stringify(headline)}`);
        const record = extensionRecord(ctx);
        check(!!record && record.version === '1.0.1', `no csv-table 1.0.1 record in .claude/rundock/extensions.json`);
        const served = await page.evaluate(() => window.rundockExtensionUiFetcher('csv-table', 'view'));
        check(served && typeof served.entry === 'string', `the server served no entry: ${JSON.stringify(served)}`);
        const tokens = networkTokensIn(served.entry);
        check(tokens.length === 0, `served entry carries ${tokens.join(', ')}`);
        check(served.entry === fs.readFileSync(path.join(ctx.csvClone, 'ui', 'index.js'), 'utf8'), 'served entry bytes differ from the tagged ui/index.js');
      } },
    { id: 'ext-listed', name: 'Installed extensions lists it', needs: ['ext-install'],
      precondition: async (ctx) => { await openPackages(ctx.page); return surface('.ext-row', 'the Installed extensions list')(ctx); },
      run: async ({ page }, check) => {
        const row = page.locator('.ext-row', { hasText: 'csv-table' });
        check((await row.count()) > 0, 'no Installed extensions row names csv-table');
        check(/1\.0\.1/.test(await row.first().textContent()), 'the row does not show version 1.0.1');
      } },
    { id: 'ext-render', name: 'opening a csv shows a table with a header row inside the extension frame', needs: ['ext-install'],
      run: async (ctx, check) => {
        const { page } = ctx;
        await openFromTree(page, seed(ctx).csv);
        const frame = page.locator('#editor-content iframe.extension-frame');
        await frame.waitFor({ timeout: 20000 });
        check(await frame.getAttribute('sandbox') === 'allow-scripts', 'the frame is not sandboxed to allow-scripts alone');
        const inner = page.frameLocator('#editor-content iframe.extension-frame');
        await inner.locator('table thead th').first().waitFor({ timeout: 20000 });
        const header = await inner.locator('table thead th').allTextContents();
        check(JSON.stringify(header) === JSON.stringify(seed(ctx).csvHeader), `header row was ${JSON.stringify(header)}`);
        check((await inner.locator('table tbody tr').count()) === 2, 'the two data rows are not in the table body');
      } },
    { id: 'ext-disable', name: 'disabling it shows the plain file', needs: ['ext-render'],
      precondition: async (ctx) => { await openPackages(ctx.page); return surface('.ext-row button:has-text("Disable")', 'the Disable action')(ctx); },
      run: async (ctx, check) => {
        const { page } = ctx;
        await page.locator('.ext-row button:has-text("Disable")').first().click();
        const off = await waitFor(() => { const r = extensionRecord(ctx); return r && r.enabled === false; }, 15000);
        check(!!off, 'the record did not gain enabled: false on disk');
        await openByPath(page, seed(ctx).csv);
        await page.locator('#editor-content .viewer-unsupported').waitFor({ timeout: 15000 });
        check((await count(page, '#editor-content iframe.extension-frame')) === 0, 'a frame is still mounted');
      } },
    { id: 'ext-uninstall', name: 'uninstalling removes it from the list and from disk, and the file shows plain', needs: ['ext-disable'],
      precondition: async (ctx) => { await openPackages(ctx.page); return surface('.ext-row button:has-text("Uninstall")', 'the Uninstall action')(ctx); },
      run: async (ctx, check) => {
        const { page } = ctx;
        await page.locator('.ext-row button:has-text("Uninstall")').first().click();
        // The filled danger button lives only inside the confirmation step.
        const confirm = page.locator('.ext-row .ext-confirm .settings-btn-danger');
        await confirm.waitFor({ timeout: 10000 });
        await confirm.click();
        const gone = await waitFor(() => !extensionRecord(ctx) && !onDisk(ctx, '.claude/rundock/extensions/csv-table'), 15000);
        check(!!gone, 'the record or the extension directory is still on disk');
        // The disk changes first and the reply that redraws the list follows
        // it over the socket, so the row is waited for, not read once.
        const unlisted = await waitFor(async () => (await page.locator('.ext-row', { hasText: 'csv-table' }).count()) === 0, 15000);
        check(!!unlisted, 'the row is still listed');
        await openByPath(page, seed(ctx).csv);
        await page.locator('#editor-content .viewer-unsupported').waitFor({ timeout: 15000 });
        check((await count(page, '#editor-content iframe.extension-frame')) === 0, 'a frame is still mounted');
      } },
    { id: 'pin', name: 'pinning the open file from the editor header lists it in the Pins rail', needs: ['boot'],
      precondition: async (ctx) => (await surface('.nav-item[data-nav="pins"]', 'the Pins rail entry')(ctx)) || surface('#editor-pin', 'the editor header pin control')(ctx),
      run: async (ctx, check) => {
        const { page } = ctx;
        await openFromTree(page, seed(ctx).target);
        await page.locator('#editor-pin').click();
        const pressed = await waitFor(async () => (await page.locator('#editor-pin').getAttribute('aria-pressed')) === 'true', 10000);
        check(!!pressed, 'the header control did not report pinned');
        check((await count(page, `#pin-list .pin-item[data-path="${seed(ctx).target}"]`)) > 0, 'the Pins rail does not list the file');
        const stored = readIf(path.join(ctx.home, '.rundock-pins.json')) || '';
        check(stored.includes(seed(ctx).target), 'the pin is not in the home directory store');
      } },
    { id: 'pin-open', name: 'opening it from the rail lands on that file with its content shown', needs: ['pin'],
      run: async (ctx, check) => {
        const { page } = ctx;
        await openFromTree(page, seed(ctx).noteA);
        await page.locator('.nav-item[data-nav="pins"]').click();
        await page.locator(`#pin-list .pin-item[data-path="${seed(ctx).target}"]`).click();
        await page.locator('#editor-filename', { hasText: seed(ctx).target }).waitFor({ timeout: 15000 });
        check(await currentFile(page) === seed(ctx).target, 'currentFilePath is not the pinned file');
        const shown = await waitFor(async () => (await page.locator('#view-editor').textContent()).includes(seed(ctx).targetSentinel), 15000);
        check(!!shown, 'the file body is not shown in the editor');
      } },
    { id: 'map-open', name: 'Map opens on a canvas over the workspace', needs: ['boot'], precondition: surface('.nav-item[data-nav="map"]', 'the Map rail entry'),
      run: async ({ page }, check) => {
        await page.locator('.nav-item[data-nav="map"]').click();
        await page.locator('#view-map canvas').waitFor({ timeout: 30000 });
        const readout = await waitFor(async () => /files/.test(await page.locator('#graph-readout').textContent()), 15000);
        check(!!readout, 'the readout does not count files');
      } },
    { id: 'map-filter', name: 'a keyword matches exactly the seeded file', needs: ['map-open'],
      run: async (ctx, check) => {
        const { page } = ctx;
        await page.fill('#graph-filter-input', seed(ctx).targetKeyword);
        const one = await waitFor(async () => (await page.locator('#graph-readout b').first().textContent()) === '1', 10000);
        check(!!one, `the readout did not report one match: ${await page.locator('#graph-readout').textContent()}`);
        ctx.nodeAt = await page.evaluate((p) => mapNodeScreenPosition(p), seed(ctx).target);
        check(!!ctx.nodeAt && ctx.nodeAt.visible, 'the view does not place the matched node on screen');
      } },
    { id: 'map-click', name: 'clicking the node lands the editor on that file', needs: ['map-filter'],
      run: async (ctx, check) => {
        const { page } = ctx;
        await page.mouse.click(ctx.nodeAt.x, ctx.nodeAt.y);
        await page.locator('#editor-filename', { hasText: seed(ctx).target }).waitFor({ timeout: 15000 });
        check(await currentFile(page) === seed(ctx).target, 'currentFilePath is not the clicked file');
        check((await count(page, '#view-map canvas')) === 0, 'the map canvas is still mounted after leaving');
      } },
    { id: 'routine-create', name: 'a routine is created through the editor', needs: ['boot'],
      precondition: async (ctx) => {
        await ctx.page.locator('.nav-item[data-nav="routines"]').click();
        return surface('[data-routines-action="add"]', 'the add-routine door')(ctx);
      },
      run: async (ctx, check) => {
        const { page } = ctx;
        await page.locator('[data-routines-action="add"]').click();
        await page.locator('.re-row[data-skill-key]', { hasText: seed(ctx).skillName }).click({ timeout: 20000 });
        await page.locator('#view-routine-editor button', { hasText: 'Continue' }).click();
        await page.locator('#view-routine-editor button', { hasText: 'Continue' }).click();
        await page.locator('[data-routine-editor="save"]').click();
        await page.locator('.routine-row', { hasText: seed(ctx).skillName }).waitFor({ timeout: 20000 });
        const agentFile = readIf(inWorkspace(ctx, `.claude/agents/${seed(ctx).agent}.md`)) || '';
        check(/routines:/.test(agentFile) && agentFile.includes(seed(ctx).skillName), 'the routine was not written into the agent file');
      } },
    { id: 'routine-run', name: 'pressing Run writes a manual run record and leaves the routine state file unchanged', needs: ['routine-create'],
      precondition: surface('.routine-row [data-routines-action="run"]', 'the Run control on the routine row'),
      run: async (ctx, check) => {
        const { page } = ctx;
        const stateFile = inWorkspace(ctx, '.rundock/routine-state.json');
        const before = readIf(stateFile);
        const run = page.locator('.routine-row', { hasText: seed(ctx).skillName }).locator('[data-routines-action="run"]');
        await run.click();
        const started = await waitFor(() => run.isDisabled(), 10000);
        check(!!started, 'the Run control did not disable while the run was in flight');
        const finished = await waitFor(() => run.isEnabled(), 60000);
        check(!!finished, 'the run did not finish');
        const runsDir = inWorkspace(ctx, '.rundock/runs');
        const records = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).map((f) => JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8'))) : [];
        const mine = records.filter((r) => r.routine === seed(ctx).skillName);
        check(mine.length === 1 && mine[0].trigger === 'manual', `run records for the routine: ${JSON.stringify(mine.map((r) => r.trigger))}`);
        check(readIf(stateFile) === before, 'the routine state file changed');
        check((readIf(inWorkspace(ctx, 'stub-invocations.jsonl')) || '').includes('"print":true'), 'the stub runtime was not invoked in print mode');
      } },
  ];
}

module.exports = { buildSteps, waitFor };
