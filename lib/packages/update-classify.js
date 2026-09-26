'use strict';
// ONE ITEM OF A PACKAGE UPDATE, CLASSIFIED (B+, decided 2026-09-24). Three
// authored digests decide it: `base`, what this package last wrote (null
// when it never wrote the item, or wrote it before fingerprints existed);
// `live`, the workspace now ('absent' when nothing is there); `incoming`,
// the author's new version (null when the new version no longer carries
// it). The group decides the rest, in the evaluator's own vocabulary, so the
// approval an update builds is judged by the unchanged evaluator.
//
// There are no per-item choices. Whatever the person changed is kept, and
// where the author changed it too the author's version is saved for review
// (`saveAuthor`) rather than written over theirs. A starter file is never
// replaced at all: a changed one arrives alongside.

const ABSENT = 'absent';
const KINDS = new Set(['agent', 'skill', 'starter']);

const out = (group, decision, saveAuthor = false) => ({ group, decision, saveAuthor });

function classifyUpdate({ kind, inPackage, base, live, incoming, gainsUnasked }) {
  if (!KINDS.has(kind)) throw new TypeError(`cannot classify an item of kind "${kind}"`);
  if (incoming === null) return out('retired', null);
  // What the person removed stays removed. Only an item this package once
  // wrote can have been removed by them; anything else absent is new.
  if (live === ABSENT) {
    if (base) return out('removed-by-you', 'skip');
    return gainsUnasked ? out('acts-without-asking', 'skip', true) : out('new', 'add');
  }
  // A starter file is the person's the moment it lands.
  if (kind === 'starter') return live === incoming || base === incoming ? out('matches', 'skip') : out('starter-alongside', 'skip');
  // Written through, so the receipt records the new version as the base.
  if (live === incoming) return out('matches', 'overwrite');
  if (gainsUnasked) return out('acts-without-asking', 'skip', true);
  if (!base) return inPackage ? out('unknown', 'skip', true) : out('path-taken', 'skip', true);
  if (live === base) return out('author-changed', 'overwrite');
  return incoming === base ? out('edited', 'skip') : out('both-changed', 'skip', true);
}

module.exports = { classifyUpdate, ABSENT };
