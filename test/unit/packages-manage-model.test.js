'use strict';
// The manage model: the rows the Installed extensions section draws, the
// state each takes with its chip tone, the receipts Recently added lists,
// and the only messages the section is allowed to send. Pure, so every
// promise about what is sent when is exhausted here without a page.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const model = require('../../public/packages-manage-model.js');
const install = require('../../public/packages-install-model.js');

// A roster entry as the server's reader answers it.
function entry(extra = {}) {
  return {
    id: 'csv-echo', name: 'csv-echo', version: '1.0.0', enabled: true,
    renderers: [{ id: 'view', target: '.csv' }], refusals: [], resources: [],
    source: { url: 'https://github.com/example/csv-echo', reference: 'v1.0.0' },
    installedAt: '2026-08-25T10:00:00.000Z',
    ...extra,
  };
}

function loaded(extensions, receipts = []) {
  return model.reply(model.initial(), { type: 'packages_page', extensions, receipts }).state;
}

function receipt(n, extra = {}) {
  const day = String(10 + n).padStart(2, '0');
  return {
    file: `2026-08-${day}-run${n}.json`,
    source: { id: `https://github.com/someone/pack-${n}`, reference: 'v1.0.0' },
    appliedAt: `2026-08-${day}T09:00:00.000Z`,
    items: [
      { id: 'agent:scribe', kind: 'agent', destination: '.claude/agents/scribe.md', outcome: 'written' },
      { id: 'skill:writer', kind: 'skill', destination: '.claude/skills/writer', outcome: 'written' },
    ],
    ...extra,
  };
}

const NOW = new Date('2026-09-07T12:00:00.000Z');
const rowsOf = (state, flow = install.initial()) => model.rows(state, flow, NOW);
const receiptRowsOf = (state) => model.receiptRows(state, NOW).rows;
const checked = (state, name, extra) => model.reply(state, { type: 'extension_update_status', operation: 'update-check', name, ...extra }).state;
const NEWER = { current: 'v1.0.0', newer: ['v1.1.0', 'v2.0.0'], outcome: 'newer-available' };
const UPDATE = { name: 'csv-echo', reference: 'v2.0.0', version: '1.0.0', link: 'https://github.com/example/csv-echo' };
const chipOf = (row) => [row.state, row.chip.label, row.chip.tone, row.chip.className];

describe('each row shows the record as fact: name, version, source repository and the pinned reference', () => {
  test('owner/repo comes from the stored url whole, however long; the pin and the install date ride beside it; an absent fact is null, never invented', () => {
    const [row] = rowsOf(loaded([entry()]));
    assert.deepStrictEqual([row.name, row.version, row.repo, row.reference, row.installedLabel], ['csv-echo', '1.0.0', 'example/csv-echo', 'v1.0.0', '25 Aug']);
    const long = 'wellington-park-investment-strategy-group/investment-hub-dashboard-and-portfolio-tools';
    assert.strictEqual(rowsOf(loaded([entry({ source: { url: `https://github.com/${long}`, reference: 'v1.0.0' } })]))[0].repo, long);
    const [bare] = rowsOf(loaded([entry({ source: null, installedAt: null })]));
    assert.deepStrictEqual([bare.repo, bare.reference, bare.installedLabel], [null, null, null]);
  });
});

describe('every state the list can show, with the chip tone each takes', () => {
  test('the empty state keeps both sections with empty copy under each', () => {
    const state = loaded([], []);
    assert.deepStrictEqual([rowsOf(state), receiptRowsOf(state)], [[], []]);
    assert.match(model.EMPTY_EXTENSIONS, /nothing installed/i);
    assert.match(model.EMPTY_RECEIPTS, /nothing added/i);
  });

  test('enabled: the success chip with check, disable and uninstall; disabled: the idle chip on a dimmed row with enable and uninstall', () => {
    const [on] = rowsOf(loaded([entry()]));
    assert.deepStrictEqual(chipOf(on), ['enabled', 'Enabled', 'success', 'enabled']);
    assert.deepStrictEqual([on.dimmed, on.actions.map((a) => a.action), on.actions[2].danger], [false, ['check', 'disable', 'uninstall'], true]);
    const [off] = rowsOf(loaded([entry({ enabled: false })]));
    assert.deepStrictEqual(chipOf(off), ['disabled', 'Disabled', 'idle', 'disabled']);
    assert.deepStrictEqual([off.dimmed, off.actions.map((a) => a.action)], [true, ['enable', 'uninstall']]);
  });

  test('installing and install failed are transient rows read from the install flow: the working chip, then the danger chip with the failure line, and no actions of their own', () => {
    const flow = { phase: 'installing', link: 'someone/csv-echo', reference: 'v1.0.0', token: 't', manifest: { name: 'csv-echo', version: '1.0.0' }, updating: null };
    const [row] = rowsOf(loaded([]), flow);
    assert.deepStrictEqual(chipOf(row), ['installing', 'Installing', 'working', 'working']);
    assert.deepStrictEqual([row.repo, row.actions, row.transient], ['someone/csv-echo', [], true]);
    const [failed] = rowsOf(loaded([]), { ...flow, phase: 'failed', message: 'the entry could not be read' });
    assert.deepStrictEqual(chipOf(failed), ['install-failed', 'Install failed', 'danger', 'bad']);
    assert.match(failed.problem, /the entry could not be read.*Nothing was enabled/);
  });

  test('update available: the attention chip with the newest reference offered, and no re-trust chip or note beneath', () => {
    const [row] = rowsOf(checked(loaded([entry()]), 'csv-echo', NEWER));
    assert.deepStrictEqual(chipOf(row), ['update-available', 'Update available', 'attention', 'update']);
    assert.deepStrictEqual(row.actions.map((a) => [a.action, a.label, a.accent]), [['update', 'Update to v2.0.0', true], ['disable', 'Disable', false], ['uninstall', 'Uninstall', false]]);
    assert.ok(!/re-trust/i.test(JSON.stringify(row)), 'no standing re-trust chip for an ordinary update');
    assert.strictEqual(row.note, null);
  });

  test('a check that finds nothing newer notes that the installed reference is current; a pin it cannot order is said to be exactly that, never current', () => {
    const [current] = rowsOf(checked(loaded([entry()]), 'csv-echo', { current: 'v1.0.0', newer: [], outcome: 'up-to-date' }));
    assert.strictEqual(current.state, 'enabled');
    assert.deepStrictEqual(current.note, { text: 'Up to date at v1.0.0.', tone: 'neutral' });
    const [pinned] = rowsOf(checked(loaded([entry()]), 'csv-echo', { current: 'a1b2c3d4', newer: [], outcome: 'unorderable-pin' }));
    assert.strictEqual(pinned.state, 'enabled');
    assert.match(pinned.note.text, /cannot be compared/);
    assert.ok(!/up to date/i.test(pinned.note.text));
  });

  test('installed but broken: the danger chip with the problem line and uninstall as the way out; a refused match rule on a working record is a problem line, not a broken chip', () => {
    const broken = entry({ broken: true, reason: 'neither the record nor the extension\'s rundock.json declares an entry and a match rule', enabled: false, renderers: [] });
    const [row] = rowsOf(loaded([broken]));
    assert.deepStrictEqual(chipOf(row), ['broken', 'Broken', 'danger', 'bad']);
    assert.match(row.problem, /declares an entry/);
    assert.deepStrictEqual(row.actions.map((a) => a.action), ['uninstall']);
    const [refused] = rowsOf(loaded([entry({ renderers: [], refusals: [{ match: '**/*.csv', reason: 'the match rule "**/*.csv" is not of the form "*.<ext>"' }] })]));
    assert.strictEqual(refused.state, 'enabled');
    assert.match(refused.problem, /not of the form/);
  });

  test('a failed update on a working extension keeps the Enabled chip with the failure as a danger note beneath, never a Failed chip and never a second row', () => {
    const flow = { phase: 'failed', link: UPDATE.link, reference: 'v2.0.0', message: 'could not verify the tag', updating: { name: 'csv-echo', reference: 'v2.0.0', version: '1.0.0' } };
    const rows = rowsOf(loaded([entry()]), flow);
    assert.strictEqual(rows.length, 1);
    assert.deepStrictEqual(chipOf(rows[0]), ['enabled', 'Enabled', 'success', 'enabled']);
    assert.deepStrictEqual(rows[0].note, { text: 'Update to v2.0.0 failed: could not verify the tag. Still running 1.0.0.', tone: 'danger' });
    assert.deepStrictEqual(rows[0].actions.map((a) => a.action), ['retry-update', 'disable', 'uninstall']);
  });

  test('an update in flight is the working chip on the installed row, from the old version to the new; disabled with an update waiting keeps one chip and says the rest in the attention tone', () => {
    const flow = { phase: 'installing', link: UPDATE.link, reference: 'v2.0.0', token: 't', manifest: { name: 'csv-echo', version: '2.0.0' }, updating: { name: 'csv-echo', reference: 'v2.0.0', version: '1.0.0' } };
    const rows = rowsOf(loaded([entry()]), flow);
    assert.strictEqual(rows.length, 1);
    assert.deepStrictEqual(chipOf(rows[0]), ['updating', 'Updating', 'working', 'working']);
    assert.deepStrictEqual([rows[0].versionLabel, rows[0].actions], ['v1.0.0 → v2.0.0', []]);
    const [off] = rowsOf(checked(loaded([entry({ enabled: false })]), 'csv-echo', { current: 'v1.0.0', newer: ['v1.1.0'], outcome: 'newer-available' }));
    assert.strictEqual(off.state, 'disabled');
    assert.deepStrictEqual(off.note, { text: 'v1.1.0 is available. Re-enabling does not update it automatically.', tone: 'attention' });
  });

  test('the tone table is the one source', () => {
    assert.deepStrictEqual(model.CHIP_TONES, { enabled: 'success', disabled: 'idle', update: 'attention', working: 'working', bad: 'danger' });
  });
});

describe('the messages the section sends, and when', () => {
  test('opening asks for the page; check carries the name only, no url; enable and disable name the extension and the flag', () => {
    const opened = model.open(model.initial());
    assert.deepStrictEqual([opened.send, opened.state.busy], [{ type: 'get_packages_page' }, { operation: 'page', name: null }]);
    const check = model.checkForUpdate(loaded([entry()]), 'csv-echo');
    assert.deepStrictEqual(check.send, { type: 'check_extension_update', name: 'csv-echo' });
    assert.ok(!('url' in check.send));
    assert.deepStrictEqual(check.state.busy, { operation: 'update-check', name: 'csv-echo' });
    assert.deepStrictEqual([rowsOf(check.state)[0].actions[0].label, rowsOf(check.state)[0].actions[0].disabled], ['Checking…', true]);
    assert.deepStrictEqual(model.setEnabled(loaded([entry()]), 'csv-echo', false).send, { type: 'set_extension_enabled', name: 'csv-echo', enabled: false });
    assert.deepStrictEqual(model.setEnabled(loaded([entry({ enabled: false })]), 'csv-echo', true).send, { type: 'set_extension_enabled', name: 'csv-echo', enabled: true });
  });

  test('a state reply carries the fresh roster into the list; a second action while one is in flight, or an unknown name, sends nothing', () => {
    const busy = model.setEnabled(loaded([entry()]), 'csv-echo', false).state;
    const next = model.reply(busy, { type: 'extension_state', operation: 'set-enabled', name: 'csv-echo', enabled: false, extensions: [entry({ enabled: false })] }).state;
    assert.deepStrictEqual([next.busy, rowsOf(next)[0].state], [null, 'disabled']);
    assert.strictEqual(model.setEnabled(busy, 'csv-echo', false).send, undefined);
    assert.strictEqual(model.checkForUpdate(busy, 'csv-echo').send, undefined);
    assert.strictEqual(model.checkForUpdate(loaded([entry()]), 'ghost').send, undefined);
    assert.strictEqual(model.setEnabled(loaded([entry()]), 'ghost', false).send, undefined);
  });

  test('an error for the operation in flight lands as a danger note on that row and frees the section; an error for another operation changes nothing', () => {
    const busy = model.checkForUpdate(loaded([entry()]), 'csv-echo').state;
    const next = model.reply(busy, { type: 'package_install_error', operation: 'update-check', token: null, message: 'the remote could not be reached', code: null }).state;
    assert.strictEqual(next.busy, null);
    assert.deepStrictEqual(rowsOf(next)[0].note, { text: 'the remote could not be reached', tone: 'danger' });
    const state = loaded([entry()]);
    assert.strictEqual(model.reply(state, { type: 'package_install_error', operation: 'install', token: 'pkg-1', message: 'x' }).state, state);
  });

  test('the update target names the extension, its newest reference, the installed version and the stored link; null until a check found something newer', () => {
    assert.deepStrictEqual(model.updateTarget(checked(loaded([entry()]), 'csv-echo', NEWER), 'csv-echo'), UPDATE);
    assert.strictEqual(model.updateTarget(loaded([entry()]), 'csv-echo'), null);
  });

  test('a completed install or import asks for the page again, but only once the page has been read; a projection asks nothing', () => {
    const state = loaded([entry()]);
    assert.deepStrictEqual(model.reply(state, { type: 'extension_install_result', operation: 'install', token: 'pkg-1', record: entry() }).send, { type: 'get_packages_page' });
    assert.deepStrictEqual(model.reply(state, { type: 'package_import_result', operation: 'apply', status: 'ready', writes: [] }).send, { type: 'get_packages_page' });
    assert.strictEqual(model.reply(state, { type: 'package_import_result', operation: 'evaluate', status: 'ready' }).send, undefined);
    assert.strictEqual(model.reply(model.initial(), { type: 'extension_install_result', operation: 'install', token: 'pkg-1', record: entry() }).send, undefined);
  });

  test('a lost connection frees the section with the reason on the row, and sends nothing', () => {
    const out = model.connectionLost(model.setEnabled(loaded([entry()]), 'csv-echo', false).state);
    assert.deepStrictEqual([out.send, out.state.busy], [undefined, null]);
    assert.match(rowsOf(out.state)[0].note.text, /connection dropped/);
  });
});

describe('uninstall rests quiet, confirms inside the row, and sends nothing before the confirmation', () => {
  test('asking opens the confirmation on that row and sends nothing; the way back sends nothing; confirming sends only for the name confirmed', () => {
    const asked = model.askUninstall(loaded([entry()]), 'csv-echo');
    assert.strictEqual(asked.send, undefined);
    const [row] = rowsOf(asked.state);
    assert.strictEqual(row.confirming, true);
    assert.match(row.confirm.text, /csv-echo.*agents and skills/i);
    assert.deepStrictEqual([row.confirm.confirmLabel, row.confirm.cancelLabel], ['Uninstall csv-echo', 'Keep it']);
    const back = model.cancelUninstall(asked.state);
    assert.deepStrictEqual([back.send, rowsOf(back.state)[0].confirming], [undefined, false]);
    assert.deepStrictEqual(model.confirmUninstall(asked.state, 'csv-echo').send, { type: 'uninstall_extension', name: 'csv-echo' });
    assert.strictEqual(model.confirmUninstall(loaded([entry()]), 'csv-echo').send, undefined, 'no confirmation open, nothing sent');
    assert.strictEqual(model.confirmUninstall(asked.state, 'other').send, undefined, 'a different name than the one confirmed is not sent');
  });

  test('the reply removes the row and carries its own untouched sentence beneath the list', () => {
    const sent = model.confirmUninstall(model.askUninstall(loaded([entry(), entry({ id: 'other', name: 'other' })]), 'csv-echo').state, 'csv-echo').state;
    const next = model.reply(sent, {
      type: 'extension_uninstalled', operation: 'uninstall', token: null, name: 'csv-echo', removed: '.claude/rundock/extensions/csv-echo',
      untouched: 'Agents and skills imported from this package are ordinary workspace files and remain.',
      extensions: [entry({ id: 'other', name: 'other' })],
    }).state;
    assert.deepStrictEqual(rowsOf(next).map((r) => r.name), ['other']);
    assert.deepStrictEqual(next.notice, { text: 'Agents and skills imported from this package are ordinary workspace files and remain.', tone: 'neutral' });
    assert.deepStrictEqual([next.busy, next.confirming], [null, null]);
  });
});

describe('Recently added: the last five receipts, See all beyond that, each item linking to the live thing', () => {
  test('five render five newest first with no See all; six render five plus a See all row naming the total, which reveals the rest', () => {
    const five = model.receiptRows(loaded([], [1, 2, 3, 4, 5].map((n) => receipt(n))), NOW);
    assert.deepStrictEqual([five.rows.map((r) => r.date), five.hidden, five.seeAllLabel], [['15 Aug', '14 Aug', '13 Aug', '12 Aug', '11 Aug'], 0, null]);
    const six = loaded([], [1, 2, 3, 4, 5, 6].map((n) => receipt(n)));
    const first = model.receiptRows(six, NOW);
    assert.deepStrictEqual([first.rows.length, first.hidden, first.seeAllLabel], [5, 1, 'See all (6)']);
    const all = model.receiptRows(model.toggleSeeAll(six).state, NOW);
    assert.deepStrictEqual([all.rows.length, all.hidden], [6, 0]);
  });

  test('a row names the package, its source as owner/repo (or a typed path whole), the date with the year when not this one, and a count line by kind', () => {
    const [row] = receiptRowsOf(loaded([], [receipt(1, {
      items: [
        { id: 'agent:scribe', kind: 'agent', destination: '.claude/agents/scribe.md', outcome: 'written' },
        { id: 'agent:editor', kind: 'agent', destination: '.claude/agents/editor.md', outcome: 'unchanged' },
        { id: 'skill:writer', kind: 'skill', destination: '.claude/skills/writer', outcome: 'written' },
        { id: 'skill:old', kind: 'skill', destination: '.claude/skills/old', outcome: 'skipped' },
      ],
    })]));
    assert.deepStrictEqual([row.name, row.repo, row.date, row.countLine, row.skipped], ['pack-1', 'someone/pack-1', '11 Aug', '2 agents · 1 skill', 1]);
    assert.strictEqual(receiptRowsOf(loaded([], [receipt(1, { appliedAt: '2025-08-11T09:00:00.000Z' })]))[0].date, '11 Aug 2025');
    const [typed] = receiptRowsOf(loaded([], [receipt(1, { source: { id: '/Users/me/packs/investment-pack', reference: null } })]));
    assert.deepStrictEqual([typed.name, typed.repo], ['investment-pack', '/Users/me/packs/investment-pack']);
  });

  test('an agent item opens Team on that agent, a skill item opens Skills on that skill, a file or folder item opens Files on that path; only what arrived links', () => {
    const [row] = receiptRowsOf(loaded([], [receipt(1, {
      items: [
        { id: 'agent:scribe', kind: 'agent', destination: '.claude/agents/scribe.md', outcome: 'written' },
        { id: 'skill:writer', kind: 'skill', destination: '.claude/skills/writer', outcome: 'written' },
        { id: 'file:notes', kind: 'file', destination: 'notes/plan.md', outcome: 'written' },
        { id: 'folder:investments', kind: 'folder', destination: 'Investments', outcome: 'written' },
        { id: 'skill:old', kind: 'skill', destination: '.claude/skills/old', outcome: 'skipped' },
        { id: 'agent:blocked', kind: 'agent', destination: '.claude/agents/blocked.md', outcome: 'blocked' },
      ],
    })]));
    assert.deepStrictEqual(row.items.map((i) => [i.label, i.kind, i.open, i.target]), [
      ['scribe', 'agent', 'agent', 'scribe'], ['writer', 'skill', 'skill', 'writer'],
      ['notes', 'file', 'file', 'notes/plan.md'], ['investments', 'folder', 'file', 'Investments'],
    ]);
  });

  test('the next page reply replaces the receipts, so a receipt deleted from disk is gone with nothing else touched', () => {
    const six = loaded([entry()], [1, 2, 3, 4, 5, 6].map((n) => receipt(n)));
    const five = model.reply(six, { type: 'packages_page', extensions: [entry()], receipts: [1, 2, 3, 4, 6].map((n) => receipt(n)) }).state;
    assert.deepStrictEqual(receiptRowsOf(five).map((r) => r.file), ['2026-08-16-run6.json', '2026-08-14-run4.json', '2026-08-13-run3.json', '2026-08-12-run2.json', '2026-08-11-run1.json']);
    assert.deepStrictEqual(rowsOf(five).map((r) => r.name), ['csv-echo']);
  });
});

describe('the update begins in the install flow from the manage row, and its plan reply is the same trust step', () => {
  const PLAN = { type: 'extension_install_plan', operation: 'plan', token: 'pkg-9', manifest: { name: 'csv-echo', version: '2.0.0' }, facts: { agents: 0, skills: 0, files: ['view/index.html'], match: '*.csv' }, replaces: { version: '1.0.0', reference: 'v1.0.0' } };

  test('beginUpdate sends the plan with the name and reference and never a url; the reply enters trust naming the replaced version; confirm carries the manifest and the update into the wait', () => {
    const out = install.beginUpdate(install.initial(), UPDATE);
    assert.deepStrictEqual(out.send, { type: 'plan_extension_update', name: 'csv-echo', reference: 'v2.0.0' });
    assert.deepStrictEqual([out.state.phase, out.state.outstanding, out.state.updating, out.state.link],
      ['classifying', { operation: 'plan', token: null }, { name: 'csv-echo', reference: 'v2.0.0', version: '1.0.0' }, UPDATE.link]);
    const trust = install.reply(out.state, PLAN).state;
    assert.deepStrictEqual([trust.phase, trust.updating], ['trust', out.state.updating]);
    const copy = install.trustCopy(trust);
    assert.deepStrictEqual([copy.headline, copy.replacesLine], ['Install csv-echo 2.0.0?', 'This replaces the installed 1.0.0 (pinned at v1.0.0).']);
    const installing = install.confirm(trust).state;
    assert.deepStrictEqual([installing.phase, installing.updating, installing.manifest], ['installing', trust.updating, PLAN.manifest]);
  });

  test('declining returns the flow to idle with the decline sent; a failed plan or install keeps the name it was updating', () => {
    const begun = install.beginUpdate(install.initial(), UPDATE).state;
    const trust = install.reply(begun, PLAN).state;
    const declined = install.decline(trust);
    assert.deepStrictEqual([declined.send, declined.state], [{ type: 'decline_package_install', token: 'pkg-9' }, install.initial()]);
    const failedPlan = install.reply(begun, { type: 'package_install_error', operation: 'plan', token: null, message: 'could not verify the tag' }).state;
    assert.deepStrictEqual([failedPlan.phase, failedPlan.updating], ['failed', begun.updating]);
    const failedInstall = install.reply(install.confirm(trust).state, { type: 'package_install_error', operation: 'install', token: 'pkg-9', message: 'the transaction rolled back' }).state;
    assert.deepStrictEqual([failedInstall.phase, failedInstall.updating, failedInstall.manifest], ['failed', begun.updating, PLAN.manifest]);
  });
});
