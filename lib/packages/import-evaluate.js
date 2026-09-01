'use strict';

const APPROVAL_SCHEMA = 'rundock.package-import-approval/v1';
const ABSENT_DIGEST = 'absent';
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KINDS = new Set(['agent', 'skill']);
const DECISIONS = new Set(['add', 'overwrite', 'skip']);

function compareIds(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(path, message) {
  throw new TypeError(`Invalid package import ${path}: ${message}.`);
}
function assertRecord(value, path, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid(path, 'must be an object');
  }
  const allowed = new Set(fields);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) invalid(path, `has unknown field "${field}"`);
  }
}
function assertArray(value, path) {
  if (!Array.isArray(value)) invalid(path, 'must be an array');
}
function assertString(value, path) {
  if (typeof value !== 'string' || value.length === 0) invalid(path, 'must be a non-empty string');
}
function assertBoolean(value, path) {
  if (typeof value !== 'boolean') invalid(path, 'must be a boolean');
}
function assertDigest(value, path, allowAbsent = false) {
  if (allowAbsent && value === ABSENT_DIGEST) return;
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    invalid(path, `must be ${allowAbsent ? '"absent" or ' : ''}a sha256 digest`);
  }
}
function canonicalDestination(kind, slug) {
  return kind === 'agent'
    ? `.claude/agents/${slug}.md`
    : `.claude/skills/${slug}`;
}
function validateIdentity(entry, path) {
  assertString(entry.id, `${path}.id`);
  if (!KINDS.has(entry.kind)) invalid(`${path}.kind`, 'must be "agent" or "skill"');
  if (typeof entry.slug !== 'string' || !SLUG_PATTERN.test(entry.slug)) {
    invalid(`${path}.slug`, 'must contain lower-case letters, numbers and single hyphens');
  }
  const expectedId = `${entry.kind}:${entry.slug}`;
  if (entry.id !== expectedId) invalid(`${path}.id`, `must equal "${expectedId}"`);
}
function validateManifest(manifest) {
  assertArray(manifest, 'approval.manifest');
  const byId = new Map();
  let previousId = null;
  for (const [index, entry] of manifest.entries()) {
    const path = `approval.manifest[${index}]`;
    assertRecord(entry, path, ['id', 'kind', 'slug', 'sourceDigest']);
    validateIdentity(entry, path);
    assertDigest(entry.sourceDigest, `${path}.sourceDigest`);
    if (byId.has(entry.id)) invalid('approval.manifest', `contains duplicate manifest id "${entry.id}"`);
    if (previousId !== null && compareIds(previousId, entry.id) >= 0) {
      invalid('approval.manifest', 'must be sorted by id');
    }
    byId.set(entry.id, entry);
    previousId = entry.id;
  }
  return byId;
}
function validateAgentMetadata(value, path) {
  assertRecord(value, path, ['plannedDefault', 'approvedDefault']);
  assertBoolean(value.plannedDefault, `${path}.plannedDefault`);
  assertBoolean(value.approvedDefault, `${path}.approvedDefault`);
}
function validateItem(item, index) {
  const path = `approval.items[${index}]`;
  assertRecord(item, path, [
    'id', 'kind', 'slug', 'destination', 'collision',
    'decision', 'plannedDigest', 'approvedDigest', 'sourceDigest', 'agent',
  ]);
  validateIdentity(item, path);
  const expectedDestination = canonicalDestination(item.kind, item.slug);
  if (item.destination !== expectedDestination) {
    invalid(`${path}.destination`, `must equal "${expectedDestination}"`);
  }
  assertBoolean(item.collision, `${path}.collision`);
  if (!DECISIONS.has(item.decision)) {
    invalid(`${path}.decision`, 'must be "add", "overwrite" or "skip"');
  }
  assertDigest(item.plannedDigest, `${path}.plannedDigest`, true);
  assertDigest(item.approvedDigest, `${path}.approvedDigest`, item.decision === 'skip');
  assertDigest(item.sourceDigest, `${path}.sourceDigest`);
  if (item.collision !== (item.plannedDigest !== ABSENT_DIGEST)) {
    invalid(`${path}.collision`, 'must match plannedDigest');
  }
  if (item.decision === 'add' && item.collision) {
    invalid(`${path}.decision`, 'add requires an absent planned destination');
  }
  if (item.decision === 'overwrite' && !item.collision) {
    invalid(`${path}.decision`, 'overwrite requires an existing planned destination');
  }
  if (item.decision === 'skip' && item.approvedDigest !== item.plannedDigest) {
    invalid(path, 'skip requires approvedDigest to equal plannedDigest');
  }
  if (item.kind === 'agent') {
    validateAgentMetadata(item.agent, `${path}.agent`);
    if (item.plannedDigest === ABSENT_DIGEST && item.agent.plannedDefault) {
      invalid(`${path}.agent.plannedDefault`, 'must be false for an absent destination');
    }
    if (item.decision === 'skip'
      && item.agent.approvedDefault !== item.agent.plannedDefault) {
      invalid(`${path}.agent`, 'skip requires matching planned and approved default state');
    }
    if (item.plannedDigest === item.approvedDigest
      && item.agent.approvedDefault !== item.agent.plannedDefault) {
      invalid(`${path}.agent`, 'matching digests require matching default state');
    }
  } else if (item.agent !== null) {
    invalid(`${path}.agent`, 'must be null for a skill');
  }
}
function validateApproval(approval) {
  assertRecord(approval, 'approval', ['schema', 'source', 'manifest', 'items']);
  if (approval.schema !== APPROVAL_SCHEMA) {
    invalid('approval.schema', `must equal "${APPROVAL_SCHEMA}"`);
  }
  assertRecord(approval.source, 'approval.source', ['id', 'reference']);
  assertString(approval.source.id, 'approval.source.id');
  if (approval.source.reference !== null) {
    assertString(approval.source.reference, 'approval.source.reference');
  }
  const manifestById = validateManifest(approval.manifest);
  assertArray(approval.items, 'approval.items');
  const itemsById = new Map();
  for (const [index, item] of approval.items.entries()) {
    validateItem(item, index);
    if (itemsById.has(item.id)) invalid('approval.items', `contains duplicate item id "${item.id}"`);
    itemsById.set(item.id, item);
  }
  const manifestIds = [...manifestById.keys()].sort(compareIds);
  const itemIds = [...itemsById.keys()].sort(compareIds);
  if (manifestIds.length !== itemIds.length
    || manifestIds.some((id, index) => id !== itemIds[index])) {
    invalid('approval', 'manifest and items must contain the same ids');
  }
  for (const id of manifestIds) {
    const manifestEntry = manifestById.get(id);
    const item = itemsById.get(id);
    if (manifestEntry.kind !== item.kind
      || manifestEntry.slug !== item.slug
      || manifestEntry.sourceDigest !== item.sourceDigest) {
      invalid(`approval.items[${id}]`, 'must match its manifest entry');
    }
  }
  return [...itemsById.values()];
}
function indexFacts(entries, path, key, fields, validate) {
  assertArray(entries, path);
  const indexed = new Map();
  for (const [index, entry] of entries.entries()) {
    const entryPath = `${path}[${index}]`;
    assertRecord(entry, entryPath, fields);
    assertString(entry[key], `${entryPath}.${key}`);
    validate(entry, entryPath);
    if (indexed.has(entry[key])) invalid(path, `contains duplicate ${key} "${entry[key]}"`);
    indexed.set(entry[key], entry);
  }
  return indexed;
}
function validateCurrent(current, items) {
  assertRecord(current, 'current', ['destinations', 'sources', 'agents']);
  const destinations = indexFacts(
    current.destinations,
    'current.destinations',
    'destination',
    ['destination', 'digest'],
    (entry, path) => assertDigest(entry.digest, `${path}.digest`, true),
  );
  const sources = indexFacts(
    current.sources,
    'current.sources',
    'id',
    ['id', 'digest'],
    (entry, path) => assertDigest(entry.digest, `${path}.digest`),
  );
  const agents = indexFacts(
    current.agents,
    'current.agents',
    'destination',
    ['destination', 'digest', 'isDefault'],
    (entry, path) => {
      const prefix = '.claude/agents/';
      const slug = entry.destination.startsWith(prefix) && entry.destination.endsWith('.md')
        ? entry.destination.slice(prefix.length, -3) : '';
      if (!SLUG_PATTERN.test(slug) || entry.destination !== canonicalDestination('agent', slug)) {
        invalid(`${path}.destination`, 'must be a canonical agent destination');
      }
      assertDigest(entry.digest, `${path}.digest`);
      assertBoolean(entry.isDefault, `${path}.isDefault`);
    },
  );
  for (const item of items) {
    if (!destinations.has(item.destination)) {
      invalid('current.destinations', `is missing "${item.destination}"`);
    }
    if (item.kind !== 'agent') continue;
    const currentDigest = destinations.get(item.destination).digest;
    const currentAgent = agents.get(item.destination);
    if (currentDigest === ABSENT_DIGEST && currentAgent) {
      invalid('current.agents', `contains absent destination "${item.destination}"`);
    }
    if (currentDigest !== ABSENT_DIGEST
      && (!currentAgent || currentAgent.digest !== currentDigest)) {
      invalid('current.agents', `must match destination "${item.destination}"`);
    }
    // Default metadata is derived from agent bytes, so matching digests must agree with it.
    if (currentDigest === item.plannedDigest && currentDigest !== ABSENT_DIGEST
      && currentAgent.isDefault !== item.agent.plannedDefault) {
      invalid('current.agents', `has contradictory planned default metadata for "${item.destination}"`);
    }
    if (currentDigest === item.approvedDigest && currentDigest !== ABSENT_DIGEST
      && currentAgent.isDefault !== item.agent.approvedDefault) {
      invalid('current.agents', `has contradictory approved default metadata for "${item.destination}"`);
    }
  }
  return { destinations, sources, agents };
}
function basicOutcome(item) {
  return { id: item.id, kind: item.kind, destination: item.destination };
}
function writeOutcome(item) {
  return {
    id: item.id,
    kind: item.kind,
    destination: item.destination,
    approvedDigest: item.approvedDigest,
    sourceDigest: item.sourceDigest,
  };
}
function sortOutcomes(entries) {
  return entries.sort((left, right) => compareIds(left.id, right.id));
}
function result(status, writes, unchanged, skipped, blocked, stale) {
  return {
    status,
    writes: sortOutcomes(writes),
    unchanged: sortOutcomes(unchanged),
    skipped: sortOutcomes(skipped),
    blocked: sortOutcomes(blocked),
    stale: sortOutcomes(stale),
  };
}
function evaluateImport(approval, current) {
  const items = validateApproval(approval);
  const facts = validateCurrent(current, items);
  const pending = [];
  const unchanged = [];
  const skipped = [];
  const stale = [];

  for (const item of items) {
    const currentDigest = facts.destinations.get(item.destination).digest;
    if (item.decision === 'skip') {
      if (currentDigest === item.plannedDigest) {
        skipped.push(basicOutcome(item));
      } else {
        stale.push({ ...basicOutcome(item), reason: 'destination-changed' });
      }
    } else if (currentDigest === item.approvedDigest) {
      unchanged.push(basicOutcome(item));
    } else if (currentDigest === item.plannedDigest) {
      pending.push(item);
    } else {
      stale.push({ ...basicOutcome(item), reason: 'destination-changed' });
    }
  }

  if (stale.length) return result('stale', [], unchanged, skipped, [], stale);

  for (const item of pending) {
    const source = facts.sources.get(item.id);
    if (!source) {
      stale.push({ ...basicOutcome(item), reason: 'source-missing' });
    } else if (source.digest !== item.sourceDigest) {
      stale.push({ ...basicOutcome(item), reason: 'source-changed' });
    }
  }
  if (stale.length) return result('stale', [], unchanged, skipped, [], stale);

  const projectedAgents = new Map([...facts.agents.values()]
    .map(agent => [agent.destination, agent.isDefault]));
  const selectedAgents = items.filter(item => item.kind === 'agent' && item.decision !== 'skip');
  for (const item of selectedAgents) {
    projectedAgents.set(item.destination, item.agent.approvedDefault);
  }

  const blockedIds = new Set();
  const projectedDefaults = [...projectedAgents.values()].filter(Boolean).length;
  if (projectedDefaults > 1) {
    for (const item of selectedAgents) {
      const currentDefault = facts.agents.get(item.destination)?.isDefault || false;
      if (currentDefault !== item.agent.approvedDefault) blockedIds.add(item.id);
    }
  }

  const blocked = items
    .filter(item => blockedIds.has(item.id))
    .map(item => ({ ...basicOutcome(item), reason: 'default-conflict' }));
  const writes = pending
    .filter(item => !blockedIds.has(item.id))
    .map(writeOutcome);
  const status = blocked.length && writes.length === 0 ? 'decisions-blocked' : 'ready';
  return result(status, writes, unchanged, skipped, blocked, []);
}

module.exports = {
  ABSENT_DIGEST,
  APPROVAL_SCHEMA,
  evaluateImport,
};
