'use strict';
// The manage model: the rows the Installed extensions section draws, the
// state each takes with its chip tone, the receipts Recently added lists,
// and the only messages the section is allowed to send. Pure, so every
// promise about what is sent when is exhausted here without a page.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const model = require('../../public/packages-manage-model.js');
const install = require('../../public/packages-install-model.js');

// A roster entry as the server's reader answers it: the record's own facts
// beside what the host needs.
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
  return {
    file: `2026-08-${String(10 + n).padStart(2, '0')}-run${n}.json`,
    source: { id: `https://github.com/someone/pack-${n}`, reference: 'v1.0.0' },
    appliedAt: `2026-08-${String(10 + n).padStart(2, '0')}T09:00:00.000Z`,
    items: [
      { id: 'agent:scribe', kind: 'agent', destination: '.claude/agents/scribe.md', outcome: 'written' },
      { id: 'skill:writer', kind: 'skill', destination: '.claude/skills/writer', outcome: 'written' },
    ],
    ...extra,
  };
}

const NOW = new Date('2026-09-07T12:00:00.000Z');
const receiptRowsOf = (state, now) => model.receiptRows(state, now).rows;

describe('each row shows the record as fact: name, version, source repository and the pinned reference', () => {
  test('the row carries owner/repo derived from the stored url, the pin, and the install date', () => {
    const [row] = model.rows(loaded([entry()]), install.initial(), NOW);
    assert.strictEqual(row.name, 'csv-echo');
    assert.strictEqual(row.version, '1.0.0');
    assert.strictEqual(row.repo, 'example/csv-echo');
    assert.strictEqual(row.reference, 'v1.0.0');
    assert.strictEqual(row.installedLabel, '25 Aug');
  });

  test('a repository name of any length is carried whole, never shortened by the model', () => {
    const long = 'wellington-park-investment-strategy-group/investment-hub-dashboard-and-portfolio-tools';
    const [row] = model.rows(loaded([entry({ source: { url: `https://github.com/${long}`, reference: 'v1.0.0' } })]), install.initial(), NOW);
    assert.strictEqual(row.repo, long);
  });

  test('a record without a source or a date says so rather than inventing one', () => {
    const [row] = model.rows(loaded([entry({ source: null, installedAt: null })]), install.initial(), NOW);
    assert.strictEqual(row.repo, null);
    assert.strictEqual(row.reference, null);
    assert.strictEqual(row.installedLabel, null);
  });
});

describe('every state the list can show, with the chip tone each takes', () => {
  test('the empty state keeps both sections with empty copy under each', () => {
    const state = loaded([], []);
    assert.deepStrictEqual(model.rows(state, install.initial(), NOW), []);
    assert.deepStrictEqual(model.receiptRows(state, NOW).rows, []);
    assert.match(model.EMPTY_EXTENSIONS, /nothing installed/i);
    assert.match(model.EMPTY_RECEIPTS, /nothing added/i);
  });

  test('enabled: the success chip, with check, disable and uninstall', () => {
    const [row] = model.rows(loaded([entry()]), install.initial(), NOW);
    assert.strictEqual(row.state, 'enabled');
    assert.deepStrictEqual(row.chip, { label: 'Enabled', tone: 'success', className: 'enabled' });
    assert.strictEqual(row.dimmed, false);
    assert.deepStrictEqual(row.actions.map((a) => a.action), ['check', 'disable', 'uninstall']);
    assert.strictEqual(row.actions[2].danger, true, 'uninstall is the one destructive action');
  });

  test('disabled: the idle chip on a dimmed row, with enable and uninstall', () => {
    const [row] = model.rows(loaded([entry({ enabled: false })]), install.initial(), NOW);
    assert.strictEqual(row.state, 'disabled');
    assert.deepStrictEqual(row.chip, { label: 'Disabled', tone: 'idle', className: 'disabled' });
    assert.strictEqual(row.dimmed, true);
    assert.deepStrictEqual(row.actions.map((a) => a.action), ['enable', 'uninstall']);
  });

  test('installing: the working chip on a transient row read from the install flow, with no actions of its own', () => {
    const flow = { phase: 'installing', link: 'someone/csv-echo', reference: 'v1.0.0', token: 't', manifest: { name: 'csv-echo', version: '1.0.0' }, updating: null };
    const [row] = model.rows(loaded([]), flow, NOW);
    assert.strictEqual(row.state, 'installing');
    assert.deepStrictEqual(row.chip, { label: 'Installing', tone: 'working', className: 'working' });
    assert.strictEqual(row.repo, 'someone/csv-echo');
    assert.deepStrictEqual(row.actions, []);
    assert.strictEqual(row.transient, true);
  });

  test('update available: the attention chip with an Update action, and no re-trust chip', () => {
    const state = model.reply(loaded([entry()]), {
      type: 'extension_update_status', operation: 'update-check', name: 'csv-echo', current: 'v1.0.0', newer: ['v1.1.0', 'v2.0.0'], outcome: 'newer-available',
    }).state;
    const [row] = model.rows(state, install.initial(), NOW);
    assert.strictEqual(row.state, 'update-available');
    assert.deepStrictEqual(row.chip, { label: 'Update available', tone: 'attention', className: 'update' });
    assert.deepStrictEqual(row.actions.map((a) => a.action), ['update', 'disable', 'uninstall']);
    assert.strictEqual(row.actions[0].accent, true, 'the update action is the row\'s accented one');
    assert.strictEqual(row.actions[0].label, 'Update to v2.0.0', 'the newest reference is the one offered');
    assert.ok(!/re-trust/i.test(JSON.stringify(row)), 'no standing re-trust chip for an ordinary update');
    assert.strictEqual(row.note, null, 'the chip says everything true; nothing is repeated beneath it');
  });

  test('a check that finds nothing newer notes that the installed reference is current, and the chip stays Enabled', () => {
    const state = model.reply(loaded([entry()]), {
      type: 'extension_update_status', operation: 'update-check', name: 'csv-echo', current: 'v1.0.0', newer: [], outcome: 'up-to-date',
    }).state;
    const [row] = model.rows(state, install.initial(), NOW);
    assert.strictEqual(row.state, 'enabled');
    assert.deepStrictEqual(row.note, { text: 'Up to date at v1.0.0.', tone: 'neutral' });
  });

  test('a pin the check cannot order is said to be exactly that, never current', () => {
    const state = model.reply(loaded([entry({ source: { url: 'https://github.com/example/csv-echo', reference: 'a1b2c3d4' } })]), {
      type: 'extension_update_status', operation: 'update-check', name: 'csv-echo', current: 'a1b2c3d4', newer: [], outcome: 'unorderable-pin',
    }).state;
    const [row] = model.rows(state, install.initial(), NOW);
    assert.strictEqual(row.state, 'enabled');
    assert.match(row.note.text, /cannot be compared/);
    assert.ok(!/up to date/i.test(row.note.text));
  });

  test('install failed: the danger chip with the failure line, on a transient row', () => {
    const flow = { phase: 'failed', link: 'someone/csv-echo', reference: 'v1.0.0', message: 'the entry could not be read', manifest: { name: 'csv-echo', version: '1.0.0' }, updating: null };
    const [row] = model.rows(loaded([]), flow, NOW);
    assert.strictEqual(row.state, 'install-failed');
    assert.deepStrictEqual(row.chip, { label: 'Install failed', tone: 'danger', className: 'bad' });
    assert.match(row.problem, /the entry could not be read/);
    assert.match(row.problem, /Nothing was enabled/);
  });

  test('installed but broken: the danger chip with the problem line, and uninstall as the way out', () => {
    const broken = { id: 'csv-echo', name: 'csv-echo', version: '1.0.0', broken: true, reason: 'neither the record nor the extension\'s rundock.json declares an entry and a match rule', enabled: false, renderers: [], refusals: [], resources: [], source: { url: 'https://github.com/example/csv-echo', reference: 'v1.0.0' }, installedAt: null };
    const [row] = model.rows(loaded([broken]), install.initial(), NOW);
    assert.strictEqual(row.state, 'broken');
    assert.deepStrictEqual(row.chip, { label: 'Broken', tone: 'danger', className: 'bad' });
    assert.match(row.problem, /declares an entry/);
    assert.deepStrictEqual(row.actions.map((a) => a.action), ['uninstall']);
  });

  test('a renderer refusal on a working record is a problem line, not a broken chip: the extension is installed, its rule is not honoured', () => {
    const refused = entry({ renderers: [], refusals: [{ match: '**/*.csv', reason: 'the match rule "**/*.csv" is not of the form "*.<ext>", the only rule a renderer can claim' }] });
    const [row] = model.rows(loaded([refused]), install.initial(), NOW);
    assert.strictEqual(row.state, 'enabled');
    assert.match(row.problem, /not of the form/);
  });

  test('a failed update on a working extension keeps the Enabled chip with the failure as a danger note beneath, never a Failed chip', () => {
    const flow = { phase: 'failed', link: 'https://github.com/example/csv-echo', reference: 'v2.0.0', message: 'could not verify the tag', updating: { name: 'csv-echo', reference: 'v2.0.0', version: '1.0.0' } };
    const [row] = model.rows(loaded([entry()]), flow, NOW);
    assert.strictEqual(row.state, 'enabled');
    assert.deepStrictEqual(row.chip, { label: 'Enabled', tone: 'success', className: 'enabled' });
    assert.deepStrictEqual(row.note, { text: 'Update to v2.0.0 failed: could not verify the tag. Still running 1.0.0.', tone: 'danger' });
    assert.deepStrictEqual(row.actions.map((a) => a.action), ['retry-update', 'disable', 'uninstall']);
    assert.strictEqual(model.rows(loaded([entry()]), flow, NOW).length, 1, 'the failed update draws no second row');
  });

  test('an update in flight is the working chip on the installed row, from the old version to the new', () => {
    const flow = { phase: 'installing', link: 'https://github.com/example/csv-echo', reference: 'v2.0.0', token: 't', manifest: { name: 'csv-echo', version: '2.0.0' }, updating: { name: 'csv-echo', reference: 'v2.0.0', version: '1.0.0' } };
    const rows = model.rows(loaded([entry()]), flow, NOW);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].state, 'updating');
    assert.deepStrictEqual(rows[0].chip, { label: 'Updating', tone: 'working', className: 'working' });
    assert.strictEqual(rows[0].versionLabel, 'v1.0.0 → v2.0.0');
    assert.deepStrictEqual(rows[0].actions, []);
  });

  test('disabled with an update waiting: one chip leads and the second fact is prose in the attention tone', () => {
    const state = model.reply(loaded([entry({ enabled: false })]), {
      type: 'extension_update_status', operation: 'update-check', name: 'csv-echo', current: 'v1.0.0', newer: ['v1.1.0'], outcome: 'newer-available',
    }).state;
    const [row] = model.rows(state, install.initial(), NOW);
    assert.strictEqual(row.state, 'disabled');
    assert.deepStrictEqual(row.note, { text: 'v1.1.0 is available. Re-enabling does not update it automatically.', tone: 'attention' });
  });

  test('the tone table is the one source: every chip tone the rows can take is declared there', () => {
    assert.deepStrictEqual(model.CHIP_TONES, {
      enabled: 'success', disabled: 'idle', update: 'attention', working: 'working', bad: 'danger',
    });
  });
});

describe('the messages the section sends, and when', () => {
  test('opening the section asks for the page and nothing else', () => {
    const out = model.open(model.initial());
    assert.deepStrictEqual(out.send, { type: 'get_packages_page' });
    assert.deepStrictEqual(out.state.busy, { operation: 'page', name: null });
  });

  test('check for update carries the extension name only: no url field, the handler reads the record', () => {
    const out = model.checkForUpdate(loaded([entry()]), 'csv-echo');
    assert.deepStrictEqual(out.send, { type: 'check_extension_update', name: 'csv-echo' });
    assert.ok(!('url' in out.send));
    assert.deepStrictEqual(out.state.busy, { operation: 'update-check', name: 'csv-echo' });
    const [row] = model.rows(out.state, install.initial(), NOW);
    assert.strictEqual(row.actions[0].label, 'Checking…');
    assert.strictEqual(row.actions[0].disabled, true);
  });

  test('enable and disable send a state message naming only the extension and the flag', () => {
    const off = model.setEnabled(loaded([entry()]), 'csv-echo', false);
    assert.deepStrictEqual(off.send, { type: 'set_extension_enabled', name: 'csv-echo', enabled: false });
    const on = model.setEnabled(loaded([entry({ enabled: false })]), 'csv-echo', true);
    assert.deepStrictEqual(on.send, { type: 'set_extension_enabled', name: 'csv-echo', enabled: true });
  });

  test('a state reply carries the fresh roster into the list', () => {
    const state = model.setEnabled(loaded([entry()]), 'csv-echo', false).state;
    const next = model.reply(state, { type: 'extension_state', operation: 'set-enabled', name: 'csv-echo', enabled: false, extensions: [entry({ enabled: false })] }).state;
    assert.strictEqual(next.busy, null);
    assert.strictEqual(model.rows(next, install.initial(), NOW)[0].state, 'disabled');
  });

  test('a second action while one is in flight sends nothing', () => {
    const busy = model.checkForUpdate(loaded([entry()]), 'csv-echo').state;
    assert.strictEqual(model.setEnabled(busy, 'csv-echo', false).send, undefined);
    assert.strictEqual(model.checkForUpdate(busy, 'csv-echo').send, undefined);
  });

  test('an unknown name sends nothing', () => {
    assert.strictEqual(model.checkForUpdate(loaded([entry()]), 'ghost').send, undefined);
    assert.strictEqual(model.setEnabled(loaded([entry()]), 'ghost', false).send, undefined);
  });

  test('an error for the operation in flight lands as a danger note on that row and frees the section', () => {
    const busy = model.checkForUpdate(loaded([entry()]), 'csv-echo').state;
    const next = model.reply(busy, { type: 'package_install_error', operation: 'update-check', token: null, message: 'the remote could not be reached', code: null }).state;
    assert.strictEqual(next.busy, null);
    const [row] = model.rows(next, install.initial(), NOW);
    assert.deepStrictEqual(row.note, { text: 'the remote could not be reached', tone: 'danger' });
  });

  test('an error for an operation the section is not waiting on changes nothing', () => {
    const state = loaded([entry()]);
    const next = model.reply(state, { type: 'package_install_error', operation: 'install', token: 'pkg-1', message: 'x' }).state;
    assert.strictEqual(next, state);
  });

  test('the update action names the extension, its newest reference and the stored link, for the install flow to plan from', () => {
    const state = model.reply(loaded([entry()]), {
      type: 'extension_update_status', operation: 'update-check', name: 'csv-echo', current: 'v1.0.0', newer: ['v1.1.0', 'v2.0.0'], outcome: 'newer-available',
    }).state;
    assert.deepStrictEqual(model.updateTarget(state, 'csv-echo'), {
      name: 'csv-echo', reference: 'v2.0.0', version: '1.0.0', link: 'https://github.com/example/csv-echo',
    });
    assert.strictEqual(model.updateTarget(loaded([entry()]), 'csv-echo'), null, 'no target until a check has found something newer');
  });

  test('a completed install or import asks for the page again, so the list and the host read the record that changed', () => {
    const state = loaded([entry()]);
    assert.deepStrictEqual(model.reply(state, { type: 'extension_install_result', operation: 'install', token: 'pkg-1', record: entry() }).send, { type: 'get_packages_page' });
    assert.deepStrictEqual(model.reply(state, { type: 'package_import_result', operation: 'apply', status: 'ready', writes: [] }).send, { type: 'get_packages_page' });
    assert.strictEqual(model.reply(state, { type: 'package_import_result', operation: 'evaluate', status: 'ready' }).send, undefined, 'a projection writes nothing, so nothing changed');
    assert.strictEqual(model.reply(model.initial(), { type: 'extension_install_result', operation: 'install', token: 'pkg-1', record: entry() }).send, undefined, 'a page never read has nothing on screen to refresh');
  });

  test('a lost connection frees the section with the reason on the row, and sends nothing', () => {
    const busy = model.setEnabled(loaded([entry()]), 'csv-echo', false).state;
    const out = model.connectionLost(busy);
    assert.strictEqual(out.send, undefined);
    assert.strictEqual(out.state.busy, null);
    assert.match(model.rows(out.state, install.initial(), NOW)[0].note.text, /connection dropped/);
    assert.strictEqual(model.connectionLost(loaded([entry()])).state.busy, null);
  });
});

describe('uninstall rests quiet, confirms inside the row, and sends nothing before the confirmation', () => {
  test('asking to uninstall opens the confirmation on that row and sends nothing', () => {
    const out = model.askUninstall(loaded([entry()]), 'csv-echo');
    assert.strictEqual(out.send, undefined);
    const [row] = model.rows(out.state, install.initial(), NOW);
    assert.strictEqual(row.confirming, true);
    assert.match(row.confirm.text, /csv-echo/);
    assert.match(row.confirm.text, /agents and skills/i);
    assert.strictEqual(row.confirm.confirmLabel, 'Uninstall csv-echo');
    assert.strictEqual(row.confirm.cancelLabel, 'Keep it');
  });

  test('the way back closes the confirmation and sends nothing', () => {
    const asked = model.askUninstall(loaded([entry()]), 'csv-echo').state;
    const out = model.cancelUninstall(asked);
    assert.strictEqual(out.send, undefined);
    assert.strictEqual(model.rows(out.state, install.initial(), NOW)[0].confirming, false);
  });

  test('confirming sends the uninstall for the confirmed name, and only from an open confirmation', () => {
    const asked = model.askUninstall(loaded([entry()]), 'csv-echo').state;
    assert.deepStrictEqual(model.confirmUninstall(asked, 'csv-echo').send, { type: 'uninstall_extension', name: 'csv-echo' });
    assert.strictEqual(model.confirmUninstall(loaded([entry()]), 'csv-echo').send, undefined, 'no confirmation open, nothing sent');
    assert.strictEqual(model.confirmUninstall(asked, 'other').send, undefined, 'a different name than the one confirmed is not sent');
  });

  test('the reply removes the row and carries its own untouched sentence beneath the list', () => {
    const sent = model.confirmUninstall(model.askUninstall(loaded([entry(), entry({ id: 'other', name: 'other' })]), 'csv-echo').state, 'csv-echo').state;
    const next = model.reply(sent, {
      type: 'extension_uninstalled', operation: 'uninstall', token: null, name: 'csv-echo', removed: '.claude/rundock/extensions/csv-echo',
      untouched: 'Agents and skills imported from this package are ordinary workspace files and remain.',
      extensions: [entry({ id: 'other', name: 'other' })],
    }).state;
    assert.deepStrictEqual(model.rows(next, install.initial(), NOW).map((r) => r.name), ['other']);
    assert.deepStrictEqual(next.notice, { text: 'Agents and skills imported from this package are ordinary workspace files and remain.', tone: 'neutral' });
    assert.strictEqual(next.busy, null);
    assert.strictEqual(next.confirming, null);
  });
});

describe('Recently added: the last five receipts, See all beyond that, each item linking to the live thing', () => {
  test('five receipts render five rows, newest first, and no See all', () => {
    const state = loaded([], [1, 2, 3, 4, 5].map((n) => receipt(n)));
    const { rows, hidden } = model.receiptRows(state, NOW);
    assert.strictEqual(rows.length, 5);
    assert.strictEqual(hidden, 0);
    assert.deepStrictEqual(rows.map((r) => r.date), ['15 Aug', '14 Aug', '13 Aug', '12 Aug', '11 Aug']);
  });

  test('six receipts render five and a See all row naming the total; activating it reveals the rest', () => {
    const state = loaded([], [1, 2, 3, 4, 5, 6].map((n) => receipt(n)));
    const first = model.receiptRows(state, NOW);
    assert.strictEqual(first.rows.length, 5);
    assert.strictEqual(first.hidden, 1);
    assert.strictEqual(first.seeAllLabel, 'See all (6)');
    const all = model.receiptRows(model.toggleSeeAll(state).state, NOW);
    assert.strictEqual(all.rows.length, 6);
    assert.strictEqual(all.hidden, 0);
  });

  test('a row names the package, its source as owner/repo, the date and a count line of what arrived by kind', () => {
    const [row] = receiptRowsOf(loaded([], [receipt(1, {
      items: [
        { id: 'agent:scribe', kind: 'agent', destination: '.claude/agents/scribe.md', outcome: 'written' },
        { id: 'agent:editor', kind: 'agent', destination: '.claude/agents/editor.md', outcome: 'unchanged' },
        { id: 'skill:writer', kind: 'skill', destination: '.claude/skills/writer', outcome: 'written' },
        { id: 'skill:old', kind: 'skill', destination: '.claude/skills/old', outcome: 'skipped' },
      ],
    })]), NOW);
    assert.strictEqual(row.name, 'pack-1');
    assert.strictEqual(row.repo, 'someone/pack-1');
    assert.strictEqual(row.date, '11 Aug');
    assert.strictEqual(row.countLine, '2 agents · 1 skill');
    assert.strictEqual(row.skipped, 1);
  });

  test('a receipt from another year carries the year in its date', () => {
    const [row] = receiptRowsOf(loaded([], [receipt(1, { appliedAt: '2025-08-11T09:00:00.000Z' })]), NOW);
    assert.strictEqual(row.date, '11 Aug 2025');
  });

  test('an agent item opens Team on that agent, a skill item opens Skills on that skill, a file or folder item opens Files on that path', () => {
    const [row] = receiptRowsOf(loaded([], [receipt(1, {
      items: [
        { id: 'agent:scribe', kind: 'agent', destination: '.claude/agents/scribe.md', outcome: 'written' },
        { id: 'skill:writer', kind: 'skill', destination: '.claude/skills/writer', outcome: 'written' },
        { id: 'file:notes', kind: 'file', destination: 'notes/plan.md', outcome: 'written' },
        { id: 'folder:investments', kind: 'folder', destination: 'Investments', outcome: 'written' },
        { id: 'skill:old', kind: 'skill', destination: '.claude/skills/old', outcome: 'skipped' },
        { id: 'agent:blocked', kind: 'agent', destination: '.claude/agents/blocked.md', outcome: 'blocked' },
      ],
    })]), NOW);
    assert.deepStrictEqual(row.items.map((i) => [i.label, i.kind, i.open, i.target]), [
      ['scribe', 'agent', 'agent', 'scribe'],
      ['writer', 'skill', 'skill', 'writer'],
      ['notes', 'file', 'file', 'notes/plan.md'],
      ['investments', 'folder', 'file', 'Investments'],
    ], 'only what arrived links; a skipped or blocked item never became a live thing');
  });

  test('the next page reply replaces the receipts, so a receipt deleted from disk is gone with nothing else touched', () => {
    const six = loaded([entry()], [1, 2, 3, 4, 5, 6].map((n) => receipt(n)));
    const five = model.reply(six, { type: 'packages_page', extensions: [entry()], receipts: [1, 2, 3, 4, 6].map((n) => receipt(n)) }).state;
    assert.deepStrictEqual(model.receiptRows(five, NOW).rows.map((r) => r.file), ['2026-08-16-run6.json', '2026-08-14-run4.json', '2026-08-13-run3.json', '2026-08-12-run2.json', '2026-08-11-run1.json']);
    assert.deepStrictEqual(model.rows(five, install.initial(), NOW).map((r) => r.name), ['csv-echo'], 'the extensions are untouched by a receipt leaving');
  });

  test('a typed-path source shows its last segment as the name and the path as the source', () => {
    const [row] = receiptRowsOf(loaded([], [receipt(1, { source: { id: '/Users/me/packs/investment-pack', reference: null } })]), NOW);
    assert.strictEqual(row.name, 'investment-pack');
    assert.strictEqual(row.repo, '/Users/me/packs/investment-pack');
  });
});

describe('the update begins in the install flow from the manage row, and its plan reply is the same trust step', () => {
  test('beginUpdate sends the update plan with the name and the chosen reference, never a url, and waits on the plan', () => {
    const out = install.beginUpdate(install.initial(), { name: 'csv-echo', reference: 'v2.0.0', version: '1.0.0', link: 'https://github.com/example/csv-echo' });
    assert.deepStrictEqual(out.send, { type: 'plan_extension_update', name: 'csv-echo', reference: 'v2.0.0' });
    assert.strictEqual(out.state.phase, 'classifying');
    assert.deepStrictEqual(out.state.outstanding, { operation: 'plan', token: null });
    assert.deepStrictEqual(out.state.updating, { name: 'csv-echo', reference: 'v2.0.0', version: '1.0.0' });
    assert.strictEqual(out.state.link, 'https://github.com/example/csv-echo', 'the trust card names the stored source');
  });

  test('the plan reply enters the trust phase carrying what is being replaced, and the trust card names the replaced version', () => {
    const begun = install.beginUpdate(install.initial(), { name: 'csv-echo', reference: 'v2.0.0', version: '1.0.0', link: 'https://github.com/example/csv-echo' }).state;
    const trust = install.reply(begun, {
      type: 'extension_install_plan', operation: 'plan', token: 'pkg-9',
      manifest: { name: 'csv-echo', version: '2.0.0' }, facts: { agents: 0, skills: 0, files: ['view/index.html'], match: '*.csv' },
      source: { url: 'https://github.com/example/csv-echo', reference: 'v2.0.0' }, replaces: { version: '1.0.0', reference: 'v1.0.0' },
    }).state;
    assert.strictEqual(trust.phase, 'trust');
    assert.deepStrictEqual(trust.updating, { name: 'csv-echo', reference: 'v2.0.0', version: '1.0.0' });
    const copy = install.trustCopy(trust);
    assert.strictEqual(copy.replacesLine, 'This replaces the installed 1.0.0 (pinned at v1.0.0).');
    assert.strictEqual(copy.headline, 'Install csv-echo 2.0.0?');
    const installing = install.confirm(trust).state;
    assert.strictEqual(installing.phase, 'installing');
    assert.deepStrictEqual(installing.updating, trust.updating, 'the row keeps knowing which install it is watching');
    assert.deepStrictEqual(installing.manifest, { name: 'csv-echo', version: '2.0.0' });
  });

  test('declining the trust step returns the flow to idle with the decline sent, so the record, files and flag are the server\'s to leave alone', () => {
    const begun = install.beginUpdate(install.initial(), { name: 'csv-echo', reference: 'v2.0.0', version: '1.0.0', link: 'x' }).state;
    const trust = install.reply(begun, { type: 'extension_install_plan', operation: 'plan', token: 'pkg-9', manifest: { name: 'csv-echo', version: '2.0.0' }, facts: { agents: 0, skills: 0, files: [], match: '*.csv' } }).state;
    const out = install.decline(trust);
    assert.deepStrictEqual(out.send, { type: 'decline_package_install', token: 'pkg-9' });
    assert.deepStrictEqual(out.state, install.initial());
  });

  test('a failed update keeps the name it was updating, so the row can say so', () => {
    const begun = install.beginUpdate(install.initial(), { name: 'csv-echo', reference: 'v2.0.0', version: '1.0.0', link: 'x' }).state;
    const failedPlan = install.reply(begun, { type: 'package_install_error', operation: 'plan', token: null, message: 'could not verify the tag' }).state;
    assert.strictEqual(failedPlan.phase, 'failed');
    assert.deepStrictEqual(failedPlan.updating, { name: 'csv-echo', reference: 'v2.0.0', version: '1.0.0' });
    const trust = install.reply(begun, { type: 'extension_install_plan', operation: 'plan', token: 'pkg-9', manifest: { name: 'csv-echo', version: '2.0.0' }, facts: { agents: 0, skills: 0, files: [], match: '*.csv' } }).state;
    const failedInstall = install.reply(install.confirm(trust).state, { type: 'package_install_error', operation: 'install', token: 'pkg-9', message: 'the transaction rolled back' }).state;
    assert.strictEqual(failedInstall.phase, 'failed');
    assert.deepStrictEqual(failedInstall.updating, { name: 'csv-echo', reference: 'v2.0.0', version: '1.0.0' });
    assert.deepStrictEqual(failedInstall.manifest, { name: 'csv-echo', version: '2.0.0' });
  });
});
