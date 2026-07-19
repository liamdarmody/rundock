'use strict';
// Card reorder index math: dropping a card computes an insertion index from the
// cursor's side of a card; this pins the pre-removal-to-post-removal correction.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { reorderTargetIndex } from '../../public/viewers/board-view.js';

describe('reorderTargetIndex', () => {
  test('cross-lane moves are used as-is', () => {
    assert.equal(reorderTargetIndex(0, 1, 1, 0), 0);
    assert.equal(reorderTargetIndex(0, 1, 1, 3), 3);
  });

  test('moving down within a lane shifts the target left by one (removal first)', () => {
    // Drag card 0 to after card 2 (index 3) -> lands at 2 after its own removal.
    assert.equal(reorderTargetIndex(0, 0, 0, 3), 2);
    assert.equal(reorderTargetIndex(0, 1, 0, 4), 3);
  });

  test('moving up within a lane keeps the target', () => {
    assert.equal(reorderTargetIndex(0, 3, 0, 1), 1);
    assert.equal(reorderTargetIndex(0, 2, 0, 0), 0);
  });

  test('dropping back onto its own position is a no-op (-1)', () => {
    assert.equal(reorderTargetIndex(0, 2, 0, 2), -1); // insert before self
    assert.equal(reorderTargetIndex(0, 2, 0, 3), -1); // insert after self (3 -> 2 == from)
  });
});
