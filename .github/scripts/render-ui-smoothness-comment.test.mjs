import assert from 'node:assert/strict';
import test from 'node:test';

import { readArtifact, renderComment } from './render-ui-smoothness-comment.mjs';

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

function artifact(base, head) {
  return { base, head, thresholdPct: 0.01 };
}

test('a movement inside the floor is noise and the artifact cannot set the floor', () => {
  const body = renderComment(artifact([100, 100, 100, 100, 100, 100], [101, 101, 101, 101, 101, 101]), ctx);
  assert.match(body, /^### ➖ UI smoothness — No significant change/);
  assert.match(body, /floor provisional ±15\.00%/);
  assert.match(body, /\| ➖ \| `feel` \| 100\.0 \| 101\.0 \| \+1\.0 \| \+1\.00% \|/);
  assert.match(body, /never blocks merge/);
  assert.match(body, /The noise floor is provisional/);
  assert.doesNotMatch(body, /0\.01%/);
});

test('a lower feel score is smoother', () => {
  const body = renderComment(artifact([100, 100, 100, 100, 100, 100], [50, 50, 50, 50, 50, 50]), ctx);
  assert.match(body, /^### 🔻 UI smoothness — -50\.00% smoother: `feel`/);
  assert.match(body, /Moved beyond a provisional noise floor/);
  assert.match(body, /\| 🔻 \| `feel` \| 100\.0 \| 50\.0 \| -50\.0 \| -50\.00% \|/);
});

test('a higher feel score is rougher', () => {
  const body = renderComment(artifact([100, 100, 100, 100, 100, 100], [130, 130, 130, 130, 130, 130]), ctx);
  assert.match(body, /^### 🔺 UI smoothness — \+30\.00% rougher: `feel`/);
});

test('a short sample list is refused', () => {
  assert.throws(() => readArtifact({ base: [1, 2, 3], head: [1, 2, 3, 4, 5, 6] }), /6 feel samples/);
});
