import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateBuildRequest } from './create-receipt.mjs';

const root = new URL('../../', import.meta.url);
const request = { releaseTag: 'v1.17.7', sourceSha: 'b'.repeat(40), platform: 'all', network: 'testnet', buildNumber: '7' };

test('standard signed build request includes official Chrome Devnet after the production stores', () => {
  const plan = validateBuildRequest(request);
  assert.deepEqual(plan.targets?.map(target => [target.platform, target.network, target.identity]), [
    ['chrome', 'testnet', 'coajhopfooegmaifelglfboehacldcbo'],
    ['ios', 'testnet', 'com.miden.bread'],
    ['android', 'testnet', 'com.miden.wallet'],
    ['chrome', 'devnet', 'eeghndabgeicdpkbcohgglidpfpiafnb']
  ]);
});

test('all-target build delegates to independent existing child producers instead of sharing their result', () => {
  const workflow = readFileSync(new URL('.github/workflows/build-store-artifacts.yml', root), 'utf8');
  assert.match(workflow, /release-plan\.mjs[^\n]*--stage build/);
  assert.match(workflow, /platform:[\s\S]*?default: all/);
  assert.match(workflow, /request_token:/);
  assert.match(workflow, /actions: write/);
  assert.match(workflow, /GITHUB_RUN_ATTEMPT !== '1'/);
  assert.match(workflow, /inputs\.platform != 'all'/);
});

test('publication remains the exact individual proof workflow and exposes optional request correlation', () => {
  const workflow = readFileSync(new URL('.github/workflows/publish-stores.yml', root), 'utf8');
  assert.match(workflow, /request_token:/);
  assert.match(workflow, /run-name:.*Store request/);
  assert.match(workflow, /options: \[chrome, ios, android\]/);
  assert.match(workflow, /group: wallet-store-publishing/);
  assert.match(workflow, /options: \[none, create-new-play-edit, submit-pending-play-changes\]/);
});

test('standard local build explicitly preserves a separate Chrome Devnet archive', () => {
  const scripts = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).scripts;
  assert.match(scripts['build-all'], /build-chrome-devnet\.mjs/);
  assert.match(scripts['store:build'], /release-plan\.mjs --stage build/);
  assert.match(scripts['store:publish'], /release-plan\.mjs/);
});
