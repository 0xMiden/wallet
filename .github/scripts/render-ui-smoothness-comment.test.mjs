import assert from 'node:assert/strict';
import test from 'node:test';

import { readArtifact, renderComment } from './render-ui-smoothness-comment.mjs';
import { DEFAULT_PROFILE, sampleCount } from './ui-smoothness-profile.mjs';

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
  assert.match(body, /floor provisional ±15\.00%/);
  assert.match(body, /\| ➖ \| `feel` \| 100\.0 \| 101\.0 \| \+1\.0 \| \+1\.00% \|/);
  assert.match(body, /median of 24 swipes: 6 passes from Overview to Swap/);
  assert.match(body, /Overview → Send → Receive → Earn → Swap/);
  assert.match(body, /never blocks merge/);
  assert.match(body, /The noise floor is provisional/);
  assert.doesNotMatch(body, /0\.01%/);
});

test('a lower feel score is smoother', () => {
  const body = renderComment(artifact(100, 50), ctx);
  assert.match(body, /^### 🔻 UI smoothness — -50\.00% smoother: `feel`/);
  assert.match(body, /Moved beyond a provisional noise floor/);
  assert.match(body, /\| 🔻 \| `feel` \| 100\.0 \| 50\.0 \| -50\.0 \| -50\.00% \|/);
});

test('a higher feel score is rougher', () => {
  const body = renderComment(artifact(100, 130), ctx);
  assert.match(body, /^### 🔺 UI smoothness — \+30\.00% rougher: `feel`/);
});

test('a short sample list is refused', () => {
  assert.throws(() => readArtifact({ feel: { base: [1, 2, 3], head: fill(sampleCount(), 1) } }), /feel base must be 24 samples/);
});

test('a tap slower than 500ms is poor even when the percent move is small', () => {
  const body = renderComment(artifact(100, 100, 580, 600), ctx);
  assert.match(body, /^### 🔺 UI smoothness — tap response 600\.0ms, above 500ms/);
  assert.match(body, /\| 🔺 \| `inp` \| 580\.0 ms \| 600\.0 ms \|/);
});
