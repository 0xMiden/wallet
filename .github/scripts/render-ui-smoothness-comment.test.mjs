import assert from 'node:assert/strict';
import test from 'node:test';

import { readArtifact, renderComment } from './render-ui-smoothness-comment.mjs';
import { DEFAULT_PROFILE, sampleCount, tapSampleCount } from './ui-smoothness-profile.mjs';

const fill = (count, value) => Array(count).fill(value);

function artifact(feelBase, feelHead, inpBase = 40, inpHead = 40, droppedBase = 5, droppedHead = 5, p95Base = 16, p95Head = 16) {
  return {
    feel: { base: fill(sampleCount(), feelBase), head: fill(sampleCount(), feelHead) },
    inp: { base: fill(DEFAULT_PROFILE.inpTaps, inpBase), head: fill(DEFAULT_PROFILE.inpTaps, inpHead) },
    listDropped: { base: fill(DEFAULT_PROFILE.listRuns, droppedBase), head: fill(DEFAULT_PROFILE.listRuns, droppedHead) },
    listP95: { base: fill(DEFAULT_PROFILE.listRuns, p95Base), head: fill(DEFAULT_PROFILE.listRuns, p95Head) },
    thresholdPct: 0.01
  };
}

const ctx = {
  owner: '0xMiden',
  repo: 'wallet',
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  baseRef: 'main',
  runId: '123',
  runUrl: 'https://github.com/0xMiden/wallet/actions/runs/123',
  runner: 'ubuntu-latest'
};

test('a movement inside the floor is noise and the artifact cannot set the floor', () => {
  const body = renderComment(artifact(100, 101), ctx);
  assert.match(body, /^### ➖ UI smoothness — No significant change/);
  assert.match(body, /floor ±50\.00%/);
  assert.match(body, /\| ➖ \| `feel` \| 100\.0 \| 101\.0 \| \+1\.0 \| \+1\.00% \|/);
  assert.match(body, /median of 24 swipes: 6 passes from Overview to Swap/);
  assert.match(body, /Overview → Send → Receive → Earn → Swap/);
  assert.match(body, /never blocks merge/);
  assert.doesNotMatch(body, /provisional/);
  assert.doesNotMatch(body, /0\.01%/);
});

test('a lower feel score is smoother', () => {
  const body = renderComment(artifact(100, 50), ctx);
  assert.match(body, /^### 🔻 UI smoothness — -50\.00% smoother: `feel`/);
  assert.match(body, /Moved beyond the noise floor/);
  assert.match(body, /\| 🔻 \| `feel` \| 100\.0 \| 50\.0 \| -50\.0 \| -50\.00% \|/);
});

test('a higher feel score is rougher', () => {
  const body = renderComment(artifact(100, 180), ctx);
  assert.match(body, /^### 🔺 UI smoothness — \+80\.00% rougher: `feel`/);
});

test('a short sample list is refused', () => {
  assert.throws(() => readArtifact({ feel: { base: [1, 2, 3], head: fill(sampleCount(), 1) } }), /feel base must be 24 samples/);
});

test('a tap slower than 500ms is poor even when the percent move is small', () => {
  const body = renderComment(artifact(100, 100, 580, 600), ctx);
  assert.match(body, /^### 🔺 UI smoothness — tap response 600\.0ms, above 500ms/);
  assert.match(body, /\| 🔺 \| `inp` \| 580\.0 ms \| 600\.0 ms \|/);
});

const tapSeries = (base, head, count = tapSampleCount()) => ({ base: fill(count, base), head: fill(count, head) });
const totals = (both = 0) => ({ reversals: 0, stallFrames: 0, bothVisibleFrames: both });

function withTaps(base = artifact(100, 100), overrides = {}) {
  return {
    ...base,
    tapFeel: tapSeries(20, 20),
    tapFirstFrame: tapSeries(10, 10),
    tapSettle: tapSeries(400, 400),
    tapDropped: tapSeries(0, 0),
    tabInp: tapSeries(40, 40, DEFAULT_PROFILE.tabInpTaps),
    tapTotals: { base: totals(40), head: totals(0) },
    ...overrides
  };
}

const removedOnHead = body => ({
  ...body,
  feel: { base: body.feel.base, head: null },
  swipeRemoved: { base: null, head: 'verified: 0px travel, route unchanged' }
});

test('the tap rows are rendered with the floors from the profile', () => {
  const body = renderComment(withTaps(artifact(100, 100), { tapSettle: tapSeries(400, 100) }), ctx);
  assert.match(body, /\| 🔻 \| `tap-settle` \| 400\.0 ms \| 100\.0 ms \| -300\.0 \| -75\.00% \|/);
  assert.match(body, /\| ➖ \| `tap-feel` \| 20\.0 \| 20\.0 \|/);
  assert.match(body, /\| ➖ \| `tap-dropped` \| 0\.0 \| 0\.0 \|/);
  assert.match(body, /\| ➖ \| `tab-inp` \| 40\.0 ms \| 40\.0 ms \|/);
  assert.match(body, /\| \*\*Workload\*\* \| 9 numbers: `feel`, `inp`, `tab-inp`, `tap-feel`, `tap-first-frame`, `tap-settle`, `tap-dropped`, `list-dropped`, `list-p95` \|/);
  assert.match(body, /both-visible frames 40/);
  assert.equal(DEFAULT_PROFILE.tapSettleThresholdPct > 0, true);
});

test('a short or partial tap series is refused', () => {
  assert.throws(() => readArtifact(withTaps(artifact(1, 1), { tapFeel: tapSeries(1, 1, 29) })), /tap feel base must be 30 samples/);
  const partial = withTaps(artifact(1, 1));
  delete partial.tabInp;
  assert.throws(() => readArtifact(partial), /tap series are incomplete/);
  assert.throws(() => readArtifact(withTaps(artifact(1, 1), { tapTotals: { base: totals() } })), /tap totals head/);
});

test('an artifact with no tap series says so instead of staying silent', () => {
  const body = renderComment(artifact(100, 101), ctx);
  assert.match(body, /No tap rows:\*\* this branch's harness has no tap scenario/);
  assert.match(body, /4 numbers: `feel`, `inp`, `list-dropped`, `list-p95`/);
  assert.doesNotMatch(body, /`tap-settle`/);
});

test('a swipe removed on head is shown as verified and is never the headline', () => {
  const body = renderComment(removedOnHead(withTaps()), ctx);
  assert.match(body, /\| ❔ \| `feel` \| 100\.0 \| removed on head \(verified\) \| n\/a \| n\/a \|/);
  assert.match(body, /^### ➖ UI smoothness \u2014 No significant change/);
  assert.match(body, /head verified: 0px travel, route unchanged/);
});

test('a swipe removed on both sides drops the row and says why', () => {
  const both = withTaps({
    ...artifact(1, 1),
    feel: { base: null, head: null },
    swipeRemoved: { base: 'verified: 0px travel, route unchanged', head: 'verified: 0px travel, route unchanged' }
  });
  const body = renderComment(both, ctx);
  assert.doesNotMatch(body, /\| `feel` \|/);
  assert.match(body, /no swipe on either side \(#2415\)/);
});

test('a swipe on head that base removed is forced worse', () => {
  const body = renderComment(
    withTaps({
      ...artifact(1, 30),
      feel: { base: null, head: fill(sampleCount(), 30) },
      swipeRemoved: { base: 'verified: 0px travel, route unchanged', head: null }
    }),
    ctx
  );
  assert.match(body, /^### 🔺 UI smoothness: `feel` swipe present on head, removed on base/);
  assert.match(body, /\| 🔺 \| `feel` \| removed on base \(verified\) \| 30\.0 \|/);
});

test('a null feel needs a verified reason, and samples cannot carry one', () => {
  assert.throws(() => readArtifact({ ...artifact(1, 1), feel: { base: fill(sampleCount(), 1), head: null } }), /without a verified reason/);
  assert.throws(
    () => readArtifact({ ...artifact(1, 1), swipeRemoved: { base: null, head: 'verified: nothing' } }),
    /has samples and a removed reason/
  );
  assert.throws(
    () => readArtifact({ ...artifact(1, 1), feel: { base: fill(sampleCount(), 1), head: null }, swipeRemoved: { head: 'trust me' } }),
    /not a verified reason/
  );
});

test('tab-inp keeps the 200ms and 500ms bands', () => {
  const left = renderComment(withTaps(artifact(100, 100), { tabInp: tapSeries(150, 210, DEFAULT_PROFILE.tabInpTaps) }), ctx);
  assert.match(left, /^### 🔺 UI smoothness: tab tap response 210\.0ms, above 200ms/);
  const good = renderComment(withTaps(artifact(100, 100), { tabInp: tapSeries(16, 40, DEFAULT_PROFILE.tabInpTaps) }), ctx);
  assert.match(good, /\| ➖ \| `tab-inp` \| 16\.0 ms \| 40\.0 ms \|/);
});

test('a tap drop on head from a base that drops none is forced worse', () => {
  const body = renderComment(withTaps(artifact(100, 100), { tapDropped: { base: fill(30, 0), head: [2, ...fill(29, 0)] } }), ctx);
  assert.match(body, /^### 🔺 UI smoothness: `tap-dropped` 2\.0 on head, from 0 on base/);
  assert.match(body, /\| 🔺 \| `tap-dropped` \| 0\.0 \| 2\.0 \| n\/a \| n\/a \|/);
});
