import assert from 'node:assert/strict';
import test from 'node:test';

import { joinSummaries } from './ui-smoothness-artifact.mjs';

const totals = { reversals: 0, stallFrames: 0, bothVisibleFrames: 0 };
const summary = overrides => ({
  samples: [1, 2],
  inp: [16],
  listDropped: [1],
  listP95: [16],
  tapFeel: [3],
  tapFirstFrame: [8],
  tapSettle: [225],
  tapDropped: [0],
  tabInp: [24],
  tapTotals: totals,
  ...overrides
});

test('both summaries are joined series by series', () => {
  const artifact = joinSummaries(summary({ samples: [5] }), summary({ tapSettle: [400] }));
  assert.deepEqual(artifact.feel, { base: [5], head: [1, 2] });
  assert.deepEqual(artifact.swipeRemoved, { base: null, head: null });
  assert.deepEqual(artifact.tapSettle, { base: [225], head: [400] });
  assert.deepEqual(artifact.tapTotals, { base: totals, head: totals });
});

test('a side without a swipe carries null feel with its verified reason', () => {
  const reason = 'verified: 0px travel, route unchanged';
  const artifact = joinSummaries(summary(), summary({ samples: null, swipeRemoved: reason }));
  assert.deepEqual(artifact.feel, { base: [1, 2], head: null });
  assert.deepEqual(artifact.swipeRemoved, { base: null, head: reason });
});

test('null feel without a verified reason is refused', () => {
  assert.throws(() => joinSummaries(summary(), summary({ samples: null })), /no verified reason/);
  assert.throws(() => joinSummaries(summary(), summary({ tabInp: undefined })), /has no tabInp/);
});
