'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ABSENT_DIGEST,
  APPROVAL_SCHEMA,
  evaluateImport,
} = require('../../lib/packages/import-evaluate.js');

const digest = character => `sha256:${character.repeat(64)}`;

function skill(slug = 'notes', overrides = {}) {
  return {
    id: `skill:${slug}`,
    kind: 'skill',
    slug,
    destination: `.claude/skills/${slug}`,
    collision: false,
    decision: 'add',
    plannedDigest: ABSENT_DIGEST,
    approvedDigest: digest('a'),
    sourceDigest: digest('b'),
    agent: null,
    ...overrides,
  };
}

function agent(slug, overrides = {}) {
  return {
    id: `agent:${slug}`,
    kind: 'agent',
    slug,
    destination: `.claude/agents/${slug}.md`,
    collision: false,
    decision: 'add',
    plannedDigest: ABSENT_DIGEST,
    approvedDigest: digest('c'),
    sourceDigest: digest('d'),
    agent: { plannedDefault: false, approvedDefault: false },
    ...overrides,
  };
}

function approval(items) {
  return {
    schema: APPROVAL_SCHEMA,
    source: { id: 'package:local:test', reference: null },
    manifest: items
      .map(item => ({ id: item.id, kind: item.kind, slug: item.slug, sourceDigest: item.sourceDigest }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    items,
  };
}

function current(destinations, sources, agents = []) {
  return {
    destinations: Object.entries(destinations)
      .map(([destination, value]) => ({ destination, digest: value })),
    sources: Object.entries(sources).map(([id, value]) => ({ id, digest: value })),
    agents,
  };
}

function currentFor(items, overrides = {}) {
  const destinations = {};
  const sources = {};
  for (const item of items) {
    destinations[item.destination] = item.plannedDigest;
    sources[item.id] = item.sourceDigest;
  }
  return current(
    { ...destinations, ...(overrides.destinations || {}) },
    { ...sources, ...(overrides.sources || {}) },
    overrides.agents || [],
  );
}

function ids(entries) {
  return entries.map(entry => entry.id);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

test('exports the versioned approval schema and absent digest', () => {
  assert.equal(APPROVAL_SCHEMA, 'rundock.package-import-approval/v1');
  assert.equal(ABSENT_DIGEST, 'absent');
});

test('rejects missing, extra and malformed approval fields', () => {
  const item = skill();
  const valid = approval([item]);
  assert.throws(
    () => evaluateImport({ ...valid, schema: undefined }, currentFor([item])),
    /approval\.schema/,
  );
  assert.throws(
    () => evaluateImport({ ...valid, extra: true }, currentFor([item])),
    /approval.*unknown field "extra"/,
  );
  assert.throws(
    () => evaluateImport(approval([{ ...item, decision: undefined }]), currentFor([item])),
    /decision/,
  );
  assert.throws(
    () => evaluateImport(approval([{ ...item, approvedDigest: 'bad' }]), currentFor([item])),
    /approvedDigest/,
  );
});

test('rejects duplicate, missing and unknown approval items', () => {
  const item = skill();
  const duplicateManifest = approval([item]);
  duplicateManifest.manifest.push({ ...duplicateManifest.manifest[0] });
  assert.throws(
    () => evaluateImport(duplicateManifest, currentFor([item])),
    /duplicate manifest id/,
  );
  const missingItem = approval([item]);
  missingItem.items = [];
  assert.throws(
    () => evaluateImport(missingItem, currentFor([item])),
    /manifest and items must contain the same ids/,
  );
  const other = skill('other', { approvedDigest: digest('e'), sourceDigest: digest('f') });
  const unknownItem = approval([item]);
  unknownItem.items = [item, other];
  assert.throws(
    () => evaluateImport(unknownItem, currentFor([item, other])),
    /manifest and items must contain the same ids/,
  );
});

test('rejects non-canonical identities, destinations and decision state', () => {
  const item = skill();
  assert.throws(
    () => evaluateImport(approval([{ ...item, id: 'skill:other' }]), currentFor([item])),
    /id: must equal/,
  );
  assert.throws(
    () => evaluateImport(
      approval([{ ...item, destination: '../outside' }]),
      current({ '../outside': ABSENT_DIGEST }, { [item.id]: item.sourceDigest }),
    ),
    /destination: must equal/,
  );
  assert.throws(
    () => evaluateImport(
      approval([{ ...item, collision: true }]),
      currentFor([{ ...item, collision: true }]),
    ),
    /collision: must match plannedDigest/,
  );
  assert.throws(
    () => evaluateImport(
      approval([skill('notes', {
        collision: true,
        decision: 'skip',
        plannedDigest: digest('1'),
        approvedDigest: digest('2'),
      })]),
      current({}, {}),
    ),
    /skip.*approvedDigest.*plannedDigest/,
  );
});

test('rejects agent metadata that contradicts the matching current digest', () => {
  const item = agent('existing', {
    collision: true, decision: 'overwrite',
    plannedDigest: digest('1'), approvedDigest: digest('2'),
    agent: { plannedDefault: true, approvedDefault: false },
  });
  const snapshot = currentFor([item], { agents: [{
    destination: item.destination, digest: item.plannedDigest, isDefault: false,
  }] });
  assert.throws(() => evaluateImport(approval([item]), snapshot), /planned default metadata/);

  const approvedSnapshot = currentFor([item], {
    destinations: { [item.destination]: item.approvedDigest },
    agents: [{ destination: item.destination, digest: item.approvedDigest, isDefault: true }],
  });
  assert.throws(() => evaluateImport(approval([item]), approvedSnapshot), /approved default metadata/);
});

test('rejects malformed manifest, item and current fact combinations', () => {
  const first = skill('first', { approvedDigest: digest('1'), sourceDigest: digest('2') });
  const second = skill('second', { approvedDigest: digest('3'), sourceDigest: digest('4') });
  const unsorted = approval([first, second]);
  unsorted.manifest.reverse();
  assert.throws(() => evaluateImport(unsorted, currentFor([first, second])), /sorted by id/);
  const mismatch = approval([first]);
  mismatch.manifest[0].sourceDigest = digest('5');
  assert.throws(() => evaluateImport(mismatch, currentFor([first])), /match its manifest entry/);
  const duplicate = approval([first]);
  duplicate.items.push({ ...first });
  assert.throws(() => evaluateImport(duplicate, currentFor([first])), /duplicate item id/);
  assert.throws(() => evaluateImport(approval([{ ...first, agent: {} }]), currentFor([first])), /must be null for a skill/);
  assert.throws(() => evaluateImport(approval([first]), current({}, { [first.id]: first.sourceDigest })), /is missing/);
  const absent = agent('absent');
  assert.throws(() => evaluateImport(approval([absent]), currentFor([absent], { agents: [{
    destination: absent.destination, digest: digest('6'), isDefault: false,
  }] })), /contains absent destination/);
});

const overwriteItem = skill('notes', {
  collision: true, decision: 'overwrite',
  plannedDigest: digest('1'), approvedDigest: digest('2'),
});
const skippedAbsentItem = skill('notes', {
  decision: 'skip', approvedDigest: ABSENT_DIGEST,
});
const skippedExistingItem = skill('notes', {
  collision: true, decision: 'skip',
  plannedDigest: digest('1'), approvedDigest: digest('1'),
});

for (const row of [
  { name: 'add at P', item: skill(), currentDigest: ABSENT_DIGEST, outcome: 'writes' },
  { name: 'add at A', item: skill(), currentDigest: digest('a'), outcome: 'unchanged' },
  { name: 'add at other C', item: skill(), currentDigest: digest('1'), outcome: 'stale' },
  { name: 'overwrite at P', item: overwriteItem, currentDigest: digest('1'), outcome: 'writes' },
  { name: 'overwrite at A', item: overwriteItem, currentDigest: digest('2'), outcome: 'unchanged' },
  { name: 'overwrite at other C', item: overwriteItem, currentDigest: digest('3'), outcome: 'stale' },
  { name: 'skip absent at P and A', item: skippedAbsentItem, currentDigest: ABSENT_DIGEST, outcome: 'skipped' },
  { name: 'agent skip absent at P and A', item: agent('skipped', { decision: 'skip', approvedDigest: ABSENT_DIGEST }), currentDigest: ABSENT_DIGEST, outcome: 'skipped' },
  { name: 'agent add at A', item: agent('present'), currentDigest: digest('c'), outcome: 'unchanged' },
  { name: 'skip at P and A', item: skippedExistingItem, currentDigest: digest('1'), outcome: 'skipped' },
  { name: 'skip at other C', item: skippedExistingItem, currentDigest: digest('2'), outcome: 'stale' },
]) {
  test(`classifies ${row.name}`, () => {
    const input = approval([row.item]);
    const snapshot = current(
      { [row.item.destination]: row.currentDigest },
      { [row.item.id]: row.item.sourceDigest },
      row.item.kind === 'agent' && row.currentDigest !== ABSENT_DIGEST
        ? [{
          destination: row.item.destination,
          digest: row.currentDigest,
          isDefault: row.item.agent.approvedDefault,
        }]
        : [],
    );
    const result = evaluateImport(input, snapshot);
    assert.deepEqual(ids(result[row.outcome]), [row.item.id]);
    if (row.outcome === 'stale') {
      assert.equal(result.status, 'stale');
      assert.deepEqual(result.writes, []);
    } else {
      assert.equal(result.status, 'ready');
    }
  });
}

test('one stale item suppresses every otherwise eligible write', () => {
  const stale = skill('stale', { approvedDigest: digest('1'), sourceDigest: digest('2') });
  const eligible = skill('eligible', { approvedDigest: digest('3'), sourceDigest: digest('4') });
  const snapshot = currentFor([stale, eligible], {
    destinations: { [stale.destination]: digest('5') },
  });
  const result = evaluateImport(approval([eligible, stale]), snapshot);
  assert.equal(result.status, 'stale');
  assert.deepEqual(result.writes, []);
  assert.deepEqual(ids(result.stale), [stale.id]);
});

test('changed or missing source bytes make a pending write stale', () => {
  const item = skill();
  const changed = evaluateImport(
    approval([item]),
    current({ [item.destination]: ABSENT_DIGEST }, { [item.id]: digest('1') }),
  );
  assert.equal(changed.status, 'stale');
  assert.equal(changed.stale[0].reason, 'source-changed');
  const missing = evaluateImport(
    approval([item]),
    current({ [item.destination]: ABSENT_DIGEST }, {}),
  );
  assert.equal(missing.status, 'stale');
  assert.equal(missing.stale[0].reason, 'source-missing');
});

test('source bytes are not required when approved bytes are already present', () => {
  const item = skill();
  const result = evaluateImport(
    approval([item]),
    current({ [item.destination]: item.approvedDigest }, { [item.id]: digest('1') }),
  );
  assert.equal(result.status, 'ready');
  assert.deepEqual(ids(result.unchanged), [item.id]);
  assert.deepEqual(result.stale, []);
});

test('a current source item absent from approval cannot enter any outcome', () => {
  const approved = skill();
  const result = evaluateImport(
    approval([approved]),
    current(
      { [approved.destination]: ABSENT_DIGEST },
      { [approved.id]: approved.sourceDigest, 'skill:later': digest('1') },
    ),
  );
  assert.equal(result.status, 'ready');
  assert.deepEqual(
    ['writes', 'unchanged', 'skipped', 'blocked', 'stale'].flatMap(key => ids(result[key])),
    [approved.id],
  );
});

test('blocks an added default when the workspace already has one', () => {
  const incoming = agent('incoming', {
    agent: { plannedDefault: false, approvedDefault: true },
  });
  const existing = {
    destination: '.claude/agents/existing.md',
    digest: digest('1'),
    isDefault: true,
  };
  const result = evaluateImport(
    approval([incoming]),
    currentFor([incoming], { agents: [existing] }),
  );
  assert.equal(result.status, 'decisions-blocked');
  assert.deepEqual(result.writes, []);
  assert.deepEqual(ids(result.blocked), [incoming.id]);
  assert.equal(result.blocked[0].reason, 'default-conflict');
});

test('accepts replacing the existing default with another default as one set', () => {
  const removeDefault = agent('existing', {
    collision: true,
    decision: 'overwrite',
    plannedDigest: digest('1'),
    approvedDigest: digest('2'),
    sourceDigest: digest('3'),
    agent: { plannedDefault: true, approvedDefault: false },
  });
  const addDefault = agent('incoming', {
    approvedDigest: digest('4'),
    sourceDigest: digest('5'),
    agent: { plannedDefault: false, approvedDefault: true },
  });

  const result = evaluateImport(
    approval([addDefault, removeDefault]),
    currentFor([addDefault, removeDefault], {
      agents: [{
        destination: removeDefault.destination,
        digest: removeDefault.plannedDigest,
        isDefault: true,
      }],
    }),
  );
  assert.equal(result.status, 'ready');
  assert.deepEqual(ids(result.writes), [removeDefault.id, addDefault.id]);
  assert.deepEqual(result.blocked, []);
});

test('blocks two incoming defaults in either input order', () => {
  const first = agent('first', {
    approvedDigest: digest('1'),
    sourceDigest: digest('2'),
    agent: { plannedDefault: false, approvedDefault: true },
  });
  const second = agent('second', {
    approvedDigest: digest('3'),
    sourceDigest: digest('4'),
    agent: { plannedDefault: false, approvedDefault: true },
  });

  for (const items of [[first, second], [second, first]]) {
    const result = evaluateImport(approval(items), currentFor(items));
    assert.equal(result.status, 'decisions-blocked');
    assert.deepEqual(ids(result.blocked), [first.id, second.id]);
    assert.deepEqual(result.writes, []);
  }
});

test('keeps an unrelated skill eligible when default choices conflict', () => {
  const first = agent('first', {
    approvedDigest: digest('1'),
    sourceDigest: digest('2'),
    agent: { plannedDefault: false, approvedDefault: true },
  });
  const second = agent('second', {
    approvedDigest: digest('3'),
    sourceDigest: digest('4'),
    agent: { plannedDefault: false, approvedDefault: true },
  });
  const unrelated = skill('unrelated', {
    approvedDigest: digest('5'),
    sourceDigest: digest('6'),
  });
  const nonDefault = agent('non-default', {
    approvedDigest: digest('7'), sourceDigest: digest('8'),
  });
  const items = [first, unrelated, nonDefault, second];
  const result = evaluateImport(approval(items), currentFor(items));
  assert.equal(result.status, 'ready');
  assert.deepEqual(ids(result.blocked), [first.id, second.id]);
  assert.deepEqual(ids(result.writes), [nonDefault.id, unrelated.id]);
});

test('keeps a skipped default and writes an unrelated item', () => {
  const skipped = agent('existing', {
    collision: true,
    decision: 'skip',
    plannedDigest: digest('1'),
    approvedDigest: digest('1'),
    sourceDigest: digest('2'),
    agent: { plannedDefault: true, approvedDefault: true },
  });
  const unrelated = skill('unrelated', {
    approvedDigest: digest('3'),
    sourceDigest: digest('4'),
  });

  const result = evaluateImport(
    approval([unrelated, skipped]),
    currentFor([unrelated, skipped], {
      agents: [{
        destination: skipped.destination,
        digest: skipped.plannedDigest,
        isDefault: true,
      }],
    }),
  );
  assert.equal(result.status, 'ready');
  assert.deepEqual(ids(result.skipped), [skipped.id]);
  assert.deepEqual(ids(result.writes), [unrelated.id]);
});

test('a pre-existing multi-default workspace does not block an unrelated item', () => {
  const unrelated = skill();
  const result = evaluateImport(
    approval([unrelated]),
    currentFor([unrelated], {
      agents: [
        { destination: '.claude/agents/one.md', digest: digest('1'), isDefault: true },
        { destination: '.claude/agents/two.md', digest: digest('2'), isDefault: true },
      ],
    }),
  );

  assert.equal(result.status, 'ready');
  assert.deepEqual(ids(result.writes), [unrelated.id]);
  assert.deepEqual(result.blocked, []);
});

test('permuting every input collection produces the same result', () => {
  const first = agent('first', {
    approvedDigest: digest('1'),
    sourceDigest: digest('2'),
    agent: { plannedDefault: false, approvedDefault: true },
  });
  const second = agent('second', {
    approvedDigest: digest('3'),
    sourceDigest: digest('4'),
    agent: { plannedDefault: false, approvedDefault: true },
  });
  const unrelated = skill('unrelated', {
    approvedDigest: digest('5'),
    sourceDigest: digest('6'),
  });
  const items = [first, second, unrelated];
  const leftApproval = approval(items);
  const rightApproval = approval([...items].reverse());
  const leftCurrent = currentFor(items, {
    agents: [
      { destination: '.claude/agents/zulu.md', digest: digest('7'), isDefault: false },
      { destination: '.claude/agents/alpha.md', digest: digest('8'), isDefault: false },
    ],
  });
  const rightCurrent = {
    destinations: [...leftCurrent.destinations].reverse(), sources: [...leftCurrent.sources].reverse(),
    agents: [...leftCurrent.agents].reverse(),
  };

  assert.deepEqual(
    evaluateImport(leftApproval, leftCurrent),
    evaluateImport(rightApproval, rightCurrent),
  );
});

test('does not mutate frozen approval or current inputs', () => {
  const item = skill();
  const input = deepFreeze(approval([item]));
  const snapshot = deepFreeze(currentFor([item]));
  const approvalBefore = JSON.stringify(input);
  const currentBefore = JSON.stringify(snapshot);

  assert.doesNotThrow(() => evaluateImport(input, snapshot));
  assert.equal(JSON.stringify(input), approvalBefore);
  assert.equal(JSON.stringify(snapshot), currentBefore);
});

test('replaying exact approved destinations produces only unchanged outcomes', () => {
  const first = skill('first', { approvedDigest: digest('1'), sourceDigest: digest('2') });
  const second = skill('second', { approvedDigest: digest('3'), sourceDigest: digest('4') });
  const result = evaluateImport(
    approval([first, second]),
    current(
      { [first.destination]: first.approvedDigest, [second.destination]: second.approvedDigest },
      {},
    ),
  );

  assert.equal(result.status, 'ready');
  assert.deepEqual(result.writes, []);
  assert.deepEqual(ids(result.unchanged), [first.id, second.id]);
});

test('write outcomes expose only approved adapter fields', () => {
  const item = skill();
  const result = evaluateImport(approval([item]), currentFor([item]));

  assert.deepEqual(result.writes, [{ id: item.id, kind: item.kind,
    destination: item.destination, approvedDigest: item.approvedDigest,
    sourceDigest: item.sourceDigest }]);
});
