import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflowPath = new URL('../.github/workflows/sentry-published-wasm-probe.yml', import.meta.url);
function workflow() {
  assert.ok(existsSync(workflowPath), 'published archive workflow must exist');
  return readFileSync(workflowPath, 'utf8');
}

test('published-wasm workflow is opt-in on one exact QA branch without secrets or write scope', () => {
  const text = workflow();
  assert.match(text, /^on:\n  workflow_dispatch:\s*\{\}/m);
  assert.match(text, /^  push:\n    branches:\n      - qa\/sentry-17y-published-startup-54312\n\npermissions:/m);
  assert.doesNotMatch(text, /^  (pull_request|pull_request_target|schedule|workflow_call|workflow_run):/m);
  assert.match(text, /^permissions:\n  contents: read\n/m);
  assert.doesNotMatch(text, /secrets[.:]|environment:|id-token:|contents: write|inputs:/);
  assert.match(text, /persist-credentials: false/);
  for (const action of text.matchAll(/uses: (\S+)/g)) {
    assert.match(action[1], /^actions\/(checkout|setup-node|upload-artifact)@[0-9a-f]{40}$/);
  }
});

test('published-wasm workflow binds the fixed release and validates ZIP members before extraction', () => {
  const text = workflow();
  assert.match(text, /https:\/\/github.com\/0xMiden\/wallet\/releases\/download\/v1\.17\.8\/MidenWallet\.1\.17\.8\.Testnet\.zip/);
  assert.match(text, /57cba7cbacfdfbda16243117e9baab99860c21c02d4b481ea39d9be5f1ea6bf4/);
  assert.match(text, /966161cc54ee2d27b4c2a3163c4ceed66762b4d1/);
  assert.match(text, /stat\.S_ISREG/);
  assert.match(text, /PurePosixPath/);
  assert.match(text, /is_absolute\(\)/);
  assert.match(text, /"\.\." in/);
  assert.match(text, /duplicate/);
  assert.match(text, /manifest\["version"\] == "1\.17\.8"/);
  assert.match(text, /current == expected/);
  assert.match(text, /archive_unchanged/);
  assert.doesNotMatch(text, /extractall\(/);
});

test('published-wasm workflow disables install scripts and never builds the wallet', () => {
  const text = workflow();
  assert.match(text, /yarn install --frozen-lockfile --ignore-scripts --non-interactive/);
  assert.match(text, /node --test scripts\/published-wasm-startup-workflow\.test\.mjs/);
  assert.match(text, /playwright install --with-deps chromium/);
  assert.doesNotMatch(text, /yarn (build|postinstall)|npm (install|run)|inject-linked|run-local-node|docker|guardian|funding/);
});

test('published-wasm workflow confines the entire probe to a loopback-only namespace as a non-root user', () => {
  const text = workflow();
  assert.match(text, /sudo unshare --net --/);
  assert.match(text, /ip link set lo up/);
  assert.match(text, /\[ "\$\(ls \/sys\/class\/net\)" = lo \]/);
  assert.match(text, /\[ -z "\$\(ip route show table all \| grep -v/);
  assert.match(text, /setpriv --reuid=.*--regid=.*--init-groups/);
  assert.match(text, /--bounding-set=-all --no-new-privs/);
  assert.match(text, /env -i/);
  assert.match(text, /timeout --signal=TERM --kill-after=10s 300s/);
  assert.ok(text.indexOf('playwright install') < text.indexOf('sudo unshare'));
  assert.doesNotMatch(text, /--no-sandbox|continue-on-error|\|\| true/);
});

test('published-wasm workflow selects only two bounded cases and never uploads raw browser artifacts', () => {
  const text = workflow();
  assert.match(text, /published-wasm-startup\.spec\.ts --config=playwright\.config\.ts/);
  assert.match(text, /--workers=1 --retries=0 --timeout=60000 --global-timeout=180000/);
  assert.match(text, /--trace=off --reporter=dot/);
  assert.match(text, />\/dev\/null 2>&1/);
  const uploads = [...text.matchAll(/path: (.+)/g)].map(match => match[1]);
  assert.deepEqual(uploads, ['${{ runner.temp }}/published-wasm-results/*.json']);
  assert.doesNotMatch(text, /playwright-report|upload.*profile|\.har\b/);
});
