'use strict';
// The Packages page's update model: what it sends and when, what a
// package's history entry says, the review's groups and words, and the
// ready-made prompt afterwards. Driven with replies shaped by the real
// handlers (see package-update-wire.test.js).

const { test, describe } = require('node:test');
const assert = require('node:assert');

const model = require('../../public/packages-update-model.js');

const ID = 'https://github.com/someone/investment-partner';
const status = (extra) => ({ type: 'package_update_status', operation: 'package-update-check', token: null, id: ID, outcome: 'newer-available', current: 'v1.0.0', newer: ['v1.1.0'], moved: null, ...extra });
const PLAN = {
  type: 'package_update_plan', operation: 'package-update-plan', token: 'pkg-7', id: ID, from: 'v1.0.0', to: 'v1.1.0',
  extension: { manifest: { name: 'investment-partner', version: '1.1.0', writes: true }, facts: {}, added: { writes: true, sources: false, asks: [] } },
  approval: { items: [] },
  groups: {
    'author-changed': [{ id: 'agent:analyst', kind: 'agent', slug: 'analyst', destination: '.claude/agents/analyst.md', saveAuthor: false }],
    'both-changed': [{ id: 'agent:risk', kind: 'agent', slug: 'risk', destination: '.claude/agents/risk.md', saveAuthor: true, saved: '.rundock/package-updates/someone-investment-partner/v1.1.0/.claude/agents/risk.md' }],
    new: [{ id: 'skill:harvest', kind: 'skill', slug: 'harvest', destination: '.claude/skills/harvest', saveAuthor: false }],
    retired: [{ id: 'skill:rebalance', kind: 'skill', slug: 'rebalance', destination: '.claude/skills/rebalance', saveAuthor: false }],
    matches: [{ id: 'skill:notes', kind: 'skill', slug: 'notes', destination: '.claude/skills/notes', saveAuthor: false }],
    'starter-alongside': [{ id: 'starter:Investments/Portfolio.md', kind: 'starter', slug: 'Investments/Portfolio.md', destination: 'Investments/Portfolio.md', saveAuthor: false, alongside: 'Investments/Portfolio (v1.1.0).md' }],
  },
  routines: { 'agent:analyst': [{ name: 'Weekly check', schedule: 'every monday at 07:00', enabled: false }] },
};

// A package card as the server sends it (package-state.js packageCards).
const CARD = {
  id: ID, name: 'investment-partner', title: 'Investment Partner', repo: 'someone/investment-partner', updatable: true,
  reference: 'v1.0.0', commit: 'a3f9c21'.padEnd(40, '0'), extension: { name: 'investment-partner', version: '1.0.0', enabled: true },
  counts: { agent: 2, skill: 1, routine: 1, starter: 0, extension: 1 },
  items: [
    { id: 'agent:lead', kind: 'agent', label: 'lead', open: 'agent', target: 'lead', state: 'as-installed', routines: ['Weekly check'] },
    { id: 'agent:risk', kind: 'agent', label: 'risk', open: 'agent', target: 'risk', state: 'changed', routines: [] },
    { id: 'skill:review', kind: 'skill', label: 'review', open: 'skill', target: 'review', state: 'as-installed', routines: [] },
    { id: 'skill:gone', kind: 'skill', label: 'gone', open: 'skill', target: 'gone', state: 'absent', routines: [] },
  ],
};
const PAGE = { packages: [CARD], extensions: [{ id: 'investment-partner', version: '1.0.0', enabled: true }] };
const card = (state, page = PAGE) => model.cardRows(state, page)[0];

describe('a package card', () => {
  test('names the package, its release and repository, counts only the kinds it has, and links each item', () => {
    const c = card(model.initial());
    assert.deepStrictEqual([c.title, c.version, c.repoLabel, c.repoUrl], ['Investment Partner', 'v1.0.0', 'github.com/someone/investment-partner', ID]);
    assert.strictEqual(c.counts, '2 agents · 1 skill · 1 routine · 1 extension');
    assert.deepStrictEqual(c.items.map((i) => [i.label, i.kind, i.open]), [
      ['lead', 'agent', 'agent'], ['risk', 'agent', 'agent'], ['review', 'skill', 'skill'], ['gone', 'skill', null],
      ['Weekly check', 'routine', 'routine'], ['Investment Partner', 'extension', 'extension'],
    ]);
    assert.strictEqual(c.status, null, 'nothing is said until the check answers');
    assert.deepStrictEqual(c.actions.map((a) => a.label), ['Check for updates', 'Uninstall']);
  });

  test('an item that is gone is marked removed and not linked; one the package no longer carries is marked, and linked only while it is in the workspace', () => {
    const items = [
      { id: 'agent:lead', kind: 'agent', label: 'lead', open: 'agent', target: 'lead', state: 'as-installed', routines: ['Weekly check'], carried: true },
      { id: 'agent:writer', kind: 'agent', label: 'writer', open: 'agent', target: 'writer', state: 'absent', routines: ['Daily digest'], carried: true },
      { id: 'skill:rebalance', kind: 'skill', label: 'rebalance', open: 'skill', target: 'rebalance', state: 'changed', routines: [], carried: false },
      { id: 'skill:old', kind: 'skill', label: 'old', open: 'skill', target: 'old', state: 'absent', routines: [], carried: false },
      { id: 'starter:Notes.md', kind: 'starter', label: 'Notes.md', open: 'file', target: 'Notes.md', state: 'absent', routines: [], carried: true },
    ];
    const c = card(model.initial(), { ...PAGE, packages: [{ ...CARD, items }] });
    assert.deepStrictEqual(c.items.map((i) => [i.label, i.kind, i.open, i.target, i.mark]), [
      ['lead', 'agent', 'agent', 'lead', null],
      ['writer', 'agent', null, null, 'removed'],
      ['rebalance', 'skill', 'skill', 'rebalance', 'no longer in the package'],
      ['old', 'skill', null, null, 'removed'],
      ['Weekly check', 'routine', 'routine', 'lead', null],
      ['Notes.md', 'starter file', null, null, 'removed'],
      ['Investment Partner', 'extension', 'extension', 'investment-partner', null],
    ], 'a gone agent\'s routines went with it, so they are not listed');
  });

  test('a newer release says so, and offers the update in place of the check', () => {
    const c = card(model.reply(model.initial(), status()).state);
    assert.deepStrictEqual(c.status, { text: 'Update available: v1.1.0', tone: 'update' });
    assert.deepStrictEqual(c.actions.map((a) => a.label), ['Update to v1.1.0', 'Uninstall']);
  });

  test('up to date, and a moved tag named in a sentence', () => {
    assert.strictEqual(card(model.reply(model.initial(), status({ outcome: 'up-to-date', newer: [] })).state).status.text, 'Up to date');
    const moved = card(model.reply(model.initial(), status({ outcome: 'up-to-date', newer: [], moved: { tag: 'v1.0.0', was: 'a', now: 'b' } })).state);
    assert.strictEqual(moved.status.text, 'Up to date. The author moved v1.0.0 to different code after you added it.');
  });

  test('a package installed at a commit shows its commit, says how to get the latest, and offers no check', () => {
    const c = card(model.initial(), { ...PAGE, packages: [{ ...CARD, reference: null }] });
    assert.strictEqual(c.version, 'a3f9c21');
    assert.strictEqual(c.status.text, 'Installed from a commit. Paste the link again to get the latest.');
    assert.deepStrictEqual(c.actions.map((a) => a.label), ['Uninstall']);
  });

  test('an extension that could not load wears the chip, says why, and offers only Uninstall', () => {
    const c = card(model.initial(), { ...PAGE, extensions: [{ id: 'investment-partner', broken: true }] });
    assert.strictEqual(c.chip, 'Couldn\'t load');
    assert.deepStrictEqual(c.status, { text: 'Rundock couldn\'t load this package\'s extension.', tone: 'danger' });
    assert.deepStrictEqual(c.actions.map((a) => a.label), ['Uninstall']);
  });

  test('there is no Disable, and no card says Disabled', () => {
    const off = card(model.initial(), { ...PAGE, packages: [{ ...CARD, extension: { ...CARD.extension, enabled: false } }] });
    assert.ok(!off.actions.some((a) => /disable/i.test(a.label)));
    assert.ok(!off.status || !/disabled/i.test(off.status.text));
  });
});

describe('uninstalling from a card', () => {
  const PLAN = {
    type: 'package_uninstall_plan', id: ID, title: 'Investment Partner', key: 'k'.repeat(64),
    goes: [{ id: 'agent:lead', kind: 'agent', label: 'lead' }, { id: 'skill:review', kind: 'skill', label: 'review' }],
    stays: [{ id: 'agent:risk', kind: 'agent', label: 'risk', why: 'edited' }, { id: 'starter:P.md', kind: 'starter', label: 'P.md', why: 'starter' }],
    extension: { name: 'investment-partner', root: '.rundock/extensions/investment-partner' },
  };
  const asking = () => model.reply(model.beginUninstall(model.initial(), ID).state, PLAN).state;

  test('asking reads the plan and removes nothing', () => {
    const out = model.beginUninstall(model.initial(), ID);
    assert.deepStrictEqual(out.send, { type: 'plan_package_uninstall', source: ID });
  });

  test('the confirmation lists what goes and what stays, with a named confirm', () => {
    const u = card(asking()).uninstall;
    assert.strictEqual(u.title, 'Uninstall Investment Partner?');
    assert.deepStrictEqual(u.groups.map((g) => [g.label, g.sub, g.items]), [
      ['Goes', 'Unchanged since install.', ['lead (agent)', 'review (skill)', 'Investment Partner (extension)']],
      ['Stays', 'Anything you edited, and every starter file.', ['risk (agent), edited since install', 'P.md (starter file)']],
    ]);
    assert.strictEqual(u.confirmLabel, 'Uninstall Investment Partner');
  });

  test('confirm names the plan by its key, once; cancel sends nothing', () => {
    const out = model.confirmUninstall(asking());
    assert.deepStrictEqual(out.send, { type: 'confirm_package_uninstall', source: ID, key: PLAN.key, requestId: `uninstall-${PLAN.key.slice(0, 12)}` });
    assert.strictEqual(model.confirmUninstall(out.state).send, undefined);
    const back = model.cancelUninstall(asking());
    assert.deepStrictEqual([back.send, back.state.uninstall], [undefined, null]);
  });

  test('the result says what was kept, in a sentence; a refusal lands on the card', () => {
    const done = model.reply(model.confirmUninstall(asking()).state, { type: 'package_uninstall_result', id: ID, title: 'Investment Partner', removed: PLAN.goes, kept: PLAN.stays }).state;
    assert.deepStrictEqual(done.notice, { text: "Investment Partner is uninstalled. Kept, because you edited them or they're starter files: risk, P.md.", tone: 'neutral' });
    const refused = model.reply(model.confirmUninstall(asking()).state, { type: 'package_install_error', operation: 'package-uninstall', id: ID, message: 'Something in this package changed since you opened the confirmation, so nothing was removed. Open it again to see what would go.' }).state;
    assert.strictEqual(refused.uninstall, null);
    assert.match(model.statusFor(refused, CARD).text, /nothing was removed/);
  });
});

describe('checking', () => {
  test('one message checks every package, and nothing more is sent while it runs', () => {
    const first = model.checkAll(model.initial());
    assert.deepStrictEqual(first.send, { type: 'check_package_update' });
    assert.strictEqual(model.checkAll(first.state).send, undefined);
  });

  test('a failed check is said on the card that asked', () => {
    const s = model.reply(model.initial(), { type: 'package_install_error', operation: 'package-update-check', id: ID, message: 'Could not list the releases.' }).state;
    assert.deepStrictEqual(model.statusFor(s, CARD), { text: 'Could not list the releases.', tone: 'danger' });
  });

  test('the button frees only when the whole check has answered', () => {
    const asked = model.checkAll(model.initial()).state;
    const one = model.reply(asked, status()).state;
    assert.strictEqual(one.checking, true, 'one package answering is not the end of the check');
    assert.strictEqual(model.reply(one, { type: 'package_update_checked', count: 1 }).state.checking, false);
  });

  test('one package\'s own check names it, and its end frees only that card', () => {
    const asked = model.checkOne(model.initial(), ID);
    assert.deepStrictEqual(asked.send, { type: 'check_package_update', source: ID });
    assert.strictEqual(model.checkOne(asked.state, ID).send, undefined, 'not twice at once');
    assert.deepStrictEqual(model.reply(asked.state, { type: 'package_update_checked', id: ID }).state.checkingIds, {});
  });
});

describe('the review', () => {
  const reviewing = () => {
    const checked = model.reply(model.initial(), status()).state;
    const asked = model.beginReview(checked, ID);
    return { asked, state: model.reply(asked.state, PLAN).state };
  };

  test('Update asks for the newest release by name, and nothing else', () => {
    assert.deepStrictEqual(reviewing().asked.send, { type: 'plan_package_update', source: ID, reference: 'v1.1.0' });
    assert.strictEqual(model.beginReview(model.initial(), ID).send, undefined, 'nothing is asked without an update to review');
    const current = model.reply(model.initial(), status({ outcome: 'up-to-date', newer: [] })).state;
    assert.strictEqual(model.beginReview(current, ID).send, undefined, 'nor for a package that is up to date');
    const planning = model.beginReview(model.reply(model.initial(), status()).state, ID).state;
    assert.strictEqual(model.beginReview(planning, ID).send, undefined, 'nor twice while one is being read');
  });

  test('the groups read in the mock\'s order and words, with nothing to do left out', () => {
    const copy = model.reviewCopy(reviewing().state);
    assert.strictEqual(copy.title, 'Update investment-partner to v1.1.0?');
    assert.strictEqual(model.reviewCopy(reviewing().state, 'Investment Partner').title, 'Update Investment Partner to v1.1.0?', 'the card\'s name is used where given');
    assert.deepStrictEqual(copy.groups.map((g) => g.label), [
      'Changed by the author', 'New in this version', 'New starter templates', 'You and the author both changed these', 'No longer in the package',
    ]);
    const changed = copy.groups[0];
    assert.deepStrictEqual(changed.items.map((i) => i.label), ['analyst (agent)', 'investment-partner (extension) → v1.1.0']);
    assert.match(changed.items[0].routines[0], /arrives switched off/);
    assert.match(changed.items[1].privileges[0], /It can change the file it opens/);
    assert.strictEqual(copy.groups[2].items[0].label, 'Investments/Portfolio (v1.1.0).md, beside Investments/Portfolio.md');
    assert.strictEqual(copy.summary, '3 changes, 1 of yours kept.');
    assert.strictEqual(copy.note, 'Your starter files are never touched.');
    assert.strictEqual(copy.confirmLabel, 'Update investment-partner');
  });

  test('confirm sends only the token, so the server applies the plan it holds', () => {
    const out = model.confirm(reviewing().state);
    assert.deepStrictEqual(out.send, { type: 'confirm_package_update', token: 'pkg-7', requestId: 'update-pkg-7' });
    assert.strictEqual(model.confirm(out.state).send, undefined, 'one confirm per review');
  });

  test('cancel releases what was fetched', () => {
    const out = model.cancel(reviewing().state);
    assert.deepStrictEqual(out.send, { type: 'decline_package_install', token: 'pkg-7' });
    assert.strictEqual(out.state.review, null);
  });

  test('a stale result updates nothing and says to review again', () => {
    const s = model.reply(model.confirm(reviewing().state).state, { type: 'package_update_result', id: ID, status: 'stale', to: 'v1.1.0' }).state;
    assert.match(model.statusFor(s, CARD).text, /nothing was updated/);
  });
});

describe('afterwards', () => {
  test('the summary offers a prompt naming every kept file beside its saved author version, and every new template', () => {
    const s = model.reply(model.initial(), { type: 'package_update_result', id: ID, status: 'ready', to: 'v1.1.0', groups: PLAN.groups }).state;
    const done = model.doneCopy(s);
    assert.strictEqual(done.text, 'investment-partner is updated to v1.1.0.');
    assert.match(done.prompt, /- \.claude\/agents\/risk\.md and \.rundock\/package-updates\/someone-investment-partner\/v1\.1\.0\/\.claude\/agents\/risk\.md/);
    assert.match(done.prompt, /- Investments\/Portfolio\.md into Investments\/Portfolio \(v1\.1\.0\)\.md/);
    assert.match(done.prompt, /show me the result before saving/i);
  });

  test('an update that kept nothing offers no prompt', () => {
    const s = model.reply(model.initial(), { type: 'package_update_result', id: ID, status: 'ready', to: 'v1.1.0', groups: { 'author-changed': PLAN.groups['author-changed'] } }).state;
    assert.strictEqual(model.doneCopy(s).prompt, null);
  });
});
