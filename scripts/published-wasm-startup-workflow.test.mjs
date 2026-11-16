import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function runArchiveTransfer(text, version) {
  const step = text.indexOf('      - name: Verify and safely extract fixed published archive\n');
  const start = text.indexOf('        run: |\n', step) + '        run: |\n'.length;
  const end = text.indexOf('          cat > "$private/archive-check.py"', start);
  assert.ok(step >= 0 && end > start, 'archive transfer program must be present');
  const script = text.slice(start, end).split('\n').map(line => line.slice(10)).join('\n');
  const root = mkdtempSync(join(tmpdir(), 'published-wasm-transfer-'));
  try {
    const bin = join(root, 'bin');
    const argsPath = join(root, 'curl-arguments');
    mkdirSync(bin, { mode: 0o700 });
    writeFileSync(join(bin, 'curl'), '#!/bin/sh\nif [ "$1" = "--version" ]; then\n  printf "%s\\n" "$FIXTURE_CURL_VERSION"\nelse\n  printf "%s\\0" "$@" > "$FIXTURE_CURL_ARGS"\nfi\n', { mode: 0o700 });
    const result = spawnSync('/bin/bash', ['-euo', 'pipefail', '-c', script], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        LC_ALL: 'C',
        RUNNER_TEMP: root,
        GITHUB_ENV: join(root, 'environment'),
        FIXTURE_CURL_VERSION: version,
        FIXTURE_CURL_ARGS: argsPath
      },
      encoding: 'utf8',
      timeout: 10000
    });
    assert.ifError(result.error);
    return { status: result.status, args: existsSync(argsPath) ? readFileSync(argsPath, 'utf8').split('\0').filter(Boolean) : null };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('published-wasm transfer emits its byte bound on supported curl versions', () => {
  for (const version of ['curl 8.4.0 (fixture)', 'curl 8.10.1 (fixture)']) {
    const result = runArchiveTransfer(workflow(), version);
    assert.equal(result.status, 0, 'supported archive transfer must run');
    const cap = result.args?.indexOf('--max-filesize') ?? -1;
    assert.ok(cap >= 0 && result.args[cap + 1] === '15535119', 'published_archive_byte_cap');
  }
});

test('published-wasm transfer refuses old curl before invoking the download', () => {
  for (const version of ['curl 8.3.0 (fixture)', 'curl 7.88.1 (fixture)']) {
    const result = runArchiveTransfer(workflow(), version);
    assert.notEqual(result.status, 0, 'published_archive_byte_cap');
    assert.equal(result.args, null, 'unsupported curl must not start the download');
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
  assert.match(text, /"\.\." not in name\.parts/);
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
  assert.match(text, /\[ "\$\(ip -o link show \| wc -l\)" -eq 1 \]/);
  assert.match(text, /ip link show dev lo >\/dev\/null/);
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
