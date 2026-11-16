import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

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

test('published-wasm shared production seam rejects preflight before launch with private receipts', async () => {
  const [major, minor] = process.versions.node.split('.').map(Number);
  assert.ok(major > 22 || (major === 22 && minor >= 18), 'production helper requires stable Node type stripping');
  const { runPublishedProbe } = await import('../playwright/tests/published-wasm/published-wasm-startup-preflight.ts');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'published-wasm-planted-marker-')));
  const keys = ['PROBE_RESULTS', 'EXTENSION_DIST', 'PROBE_ORIGINAL_NETNS'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  let launches = 0;
  const launch = async () => {
    launches += 1;
    assert.equal(JSON.parse(readFileSync(join(process.env.PROBE_RESULTS, 'cold-startup.json'), 'utf8')).outcome, 'setup_failed');
    throw new Error('launch_must_not_run');
  };
  const expectOutcome = (actual, message) => ({ toBe: expected => assert.equal(actual, expected, message) });
  try {
    const output = join(root, 'published-wasm-results');
    mkdirSync(output, { mode: 0o700 });
    process.env.PROBE_RESULTS = output;
    process.env.EXTENSION_DIST = `${root}/missing/chrome-extension://planted-marker`;
    delete process.env.PROBE_ORIGINAL_NETNS;
    await assert.rejects(runPublishedProbe('cold-startup', launch, expectOutcome), error => {
      assert.match(error.message, /published_wasm_cold-startup_setup/);
      assert.ok(!error.message.includes(root) && !error.message.includes('planted-marker'));
      return true;
    });
    assert.equal(launches, 0);
    const receiptPath = join(output, 'cold-startup.json');
    const receipt = readFileSync(receiptPath, 'utf8');
    const record = JSON.parse(receipt);
    assert.deepEqual([record.outcome, record.phase, record.error_family, record.requests], ['setup_failed', 'setup', 'assertion', 0]);
    assert.equal(lstatSync(receiptPath).mode & 0o777, 0o600);
    assert.ok(!receipt.includes(root) && !receipt.includes('planted-marker') && !receipt.includes('chrome-extension:'));
    const missing = join(root, 'missing', 'published-wasm-results');
    const wrongName = join(root, 'wrong-name');
    mkdirSync(wrongName, { mode: 0o700 });
    const symlinkParent = join(root, 'symlink-parent');
    mkdirSync(symlinkParent, { mode: 0o700 });
    const symlink = join(symlinkParent, 'published-wasm-results');
    symlinkSync(output, symlink, 'dir');
    for (const unsafe of ['published-wasm-results', missing, wrongName, symlink]) {
      process.env.PROBE_RESULTS = unsafe;
      await assert.rejects(runPublishedProbe('retry-reload', launch, expectOutcome), { message: 'invalid_probe_paths' });
      assert.equal(existsSync(join(output, 'retry-reload.json')), false);
      assert.equal(existsSync(join(wrongName, 'retry-reload.json')), false);
      assert.equal(existsSync(missing), false);
    }
    assert.equal(launches, 0);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('published-wasm host CLI writes only a closed private setup receipt and stays silent', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'published-wasm-host-planted-marker-')));
  const cli = fileURLToPath(new URL('../playwright/tests/published-wasm/setup-failure.mjs', import.meta.url));
  const invoke = output => {
    const result = spawnSync(process.execPath, [cli], { env: { PROBE_RESULTS: output }, encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    return result.status;
  };
  try {
    const output = join(root, 'published-wasm-results');
    mkdirSync(output, { mode: 0o700 });
    writeFileSync(join(output, 'published-archive-receipt.json'), '{}\n', { mode: 0o600 });
    assert.equal(invoke(output), 0);
    const setup = join(output, 'setup-failure.json');
    assert.equal(readFileSync(setup, 'utf8'), '{"schema":1,"outcome":"setup_failed","phase":"setup","case_executed":false}\n');
    assert.equal(lstatSync(setup).mode & 0o777, 0o600);
    rmSync(setup);
    for (const name of ['cold-startup.json', 'retry-reload.json']) {
      const path = join(output, name);
      const seed = '{"case_receipt":"unchanged"}\n';
      writeFileSync(path, seed, { mode: 0o600 });
      assert.equal(invoke(output), 0);
      assert.equal(readFileSync(path, 'utf8'), seed);
      assert.equal(existsSync(setup), false);
      rmSync(path);
    }
    const wrongName = join(root, 'wrong-name');
    mkdirSync(wrongName, { mode: 0o700 });
    const symlinkParent = join(root, 'symlink-parent');
    mkdirSync(symlinkParent, { mode: 0o700 });
    const symlink = join(symlinkParent, 'published-wasm-results');
    symlinkSync(output, symlink, 'dir');
    for (const unsafe of ['published-wasm-results', join(root, 'missing', 'published-wasm-results'), wrongName, symlink]) {
      assert.equal(invoke(unsafe), 1);
      assert.equal(existsSync(join(wrongName, 'setup-failure.json')), false);
      assert.equal(existsSync(setup), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('published-wasm setup receipt wiring keeps Node compatibility and both actual case calls', () => {
  const text = workflow();
  const spec = readFileSync(new URL('../playwright/tests/published-wasm-startup.spec.ts', import.meta.url), 'utf8');
  const nested = JSON.parse(readFileSync(new URL('../playwright/tests/published-wasm/package.json', import.meta.url), 'utf8'));
  const rootPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(nested, { name: 'published-wasm-probe', private: true, type: 'module' });
  assert.equal(Object.hasOwn(rootPackage, 'type'), false);
  assert.match(text, /node-version: 22\.22\.0/);
  assert.match(text, /yarn tsc --noEmit --strict --skipLibCheck --types node --target ES2022 --module commonjs --moduleResolution node playwright\/tests\/published-wasm-startup\.spec\.ts/);
  assert.match(spec, /await runPublishedProbe\('cold-startup', productionLaunch, expect\)/);
  assert.match(spec, /await runPublishedProbe\('retry-reload', productionLaunch, expect\)/);
  assert.equal([...spec.matchAll(/chromium\.launchPersistentContext\(/g)].length, 1);
  const requiresHostReceipt = source => assert.match(source, /if \[ "\$status" -ne 0 \]; then\n\s+node playwright\/tests\/published-wasm\/setup-failure\.mjs \|\| :\n\s+exit "\$status"\n\s+fi/);
  requiresHostReceipt(text);
  assert.throws(() => requiresHostReceipt(text.replace('node playwright/tests/published-wasm/setup-failure.mjs', ':')), { code: 'ERR_ASSERTION' });
});

test('published-wasm initial receipt precedes the real preflight assertions', () => {
  const helper = readFileSync(new URL('../playwright/tests/published-wasm/published-wasm-startup-preflight.ts', import.meta.url), 'utf8');
  const requiresInitialReceipt = source => {
    const run = source.indexOf('export async function runPublishedProbe(');
    const save = source.indexOf('\n  save();', run);
    const preflight = source.indexOf("    assert.equal(process.platform, 'linux');", run);
    assert.ok(run >= 0 && save > run && preflight > save, 'published_wasm_initial_receipt_precedes_preflight');
  };
  requiresInitialReceipt(helper);
  assert.throws(() => requiresInitialReceipt(helper.replace('\n  save();', '')), { code: 'ERR_ASSERTION' });
});

test('published-wasm actual host fallback preserves probe failure even when receipt writing fails', () => {
  const branch = workflow().match(/          if \[ "\$status" -ne 0 \]; then\n[\s\S]*?          fi/);
  assert.ok(branch, 'published_wasm_host_fallback');
  for (const fallbackStatus of [0, 1]) {
    const result = spawnSync('/bin/bash', ['-euo', 'pipefail', '-c', `status=124\nnode() { return ${fallbackStatus}; }\n${branch[0]}`], {
      env: {}, encoding: 'utf8', timeout: 10000
    });
    assert.ifError(result.error);
    assert.equal(result.status, 124, 'published_wasm_host_preserves_probe_status');
    assert.equal(result.stdout + result.stderr, '');
  }
});

test('published-wasm real preflight rejection leaves closed setup evidence', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'published-wasm-preflight-')));
  try {
    const output = join(root, 'published-wasm-results');
    const extension = join(root, 'planted-extension-marker');
    mkdirSync(output, { mode: 0o700 });
    mkdirSync(extension, { mode: 0o700 });
    const cli = fileURLToPath(new URL('../node_modules/@playwright/test/cli.js', import.meta.url));
    const result = spawnSync(process.execPath, [cli, 'test', 'playwright/tests/published-wasm-startup.spec.ts',
      '--config=playwright.config.ts', '--workers=1', '--retries=0', '--timeout=10000',
      '--global-timeout=20000', '--trace=off', '--reporter=line',
      '--grep=published archive cold startup completes packaged WASM and reaches onboarding$'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: {
        PATH: '/usr/bin:/bin',
        HOME: root,
        CI: '1',
        EXTENSION_DIST: extension,
        PROBE_RESULTS: output,
        PROBE_ORIGINAL_NETNS: process.platform === 'linux' ? readlinkSync('/proc/self/ns/net') : 'net:[1]',
        PLAYWRIGHT_BROWSERS_PATH: join(root, 'no-browser-installed')
      },
      encoding: 'utf8',
      timeout: 30000
    });
    assert.ifError(result.error);
    assert.notEqual(result.status, 0, 'identical host namespace must reject preflight');
    const outputText = stripVTControlCharacters(result.stdout + result.stderr);
    assert.match(outputText, /Running 1 test using 1 worker/, 'preflight fixture must execute one real case');
    assert.match(outputText, /expect\(received\).*expected/, 'preflight fixture must reach an isolation assertion');
    const receiptPath = join(output, 'cold-startup.json');
    assert.ok(existsSync(receiptPath), 'published_wasm_preflight_receipt');
    const receipt = readFileSync(receiptPath, 'utf8');
    const record = JSON.parse(receipt);
    assert.equal(lstatSync(receiptPath).mode & 0o777, 0o600);
    assert.deepEqual([record.outcome, record.phase, record.requests], ['setup_failed', 'setup', 0]);
    assert.equal(record.error_family, 'assertion', 'real preflight must reject isolation before browser launch');
    assert.ok(!receipt.includes(root) && !receipt.includes('planted-extension-marker'), 'setup receipt must omit private paths');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function assertFixedRelease(text) {
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
}

test('published-wasm workflow binds the fixed release and validates ZIP members before extraction', () => {
  assertFixedRelease(workflow());
});

test('published-wasm release guard rejects a disabled digest check or prepare invocation', () => {
  const text = workflow();
  const comparison = '          assert sha(private / "archive.zip") == digest, "archive digest mismatch"';
  const mutants = [
    text.replace(comparison, `          # ${comparison.trim()}`),
    text.replace('python3 "$private/archive-check.py" prepare', 'python3 "$private/archive-check.py" verify')
  ];
  for (const mutant of mutants) {
    assert.notEqual(mutant, text, 'digest/prepare fixture must change active source');
    assert.throws(() => assertFixedRelease(mutant), { code: 'ERR_ASSERTION' }, 'published_wasm_active_digest_enforcement');
  }
});

test('published-wasm workflow disables install scripts and never builds the wallet', () => {
  const text = workflow();
  assert.match(text, /yarn install --frozen-lockfile --ignore-scripts --non-interactive/);
  assert.match(text, /node --test scripts\/published-wasm-startup-workflow\.test\.mjs/);
  assert.match(text, /playwright install --with-deps chromium/);
  assert.doesNotMatch(text, /yarn (build|postinstall)|npm (install|run)|inject-linked|run-local-node|docker|guardian|funding/);
});

function assertConfinement(text) {
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
}

test('published-wasm workflow confines the entire probe to a loopback-only namespace as a non-root user', () => {
  assertConfinement(workflow());
});

test('published-wasm confinement guard rejects the actual CLI moved outside unshare', () => {
  const text = workflow();
  const start = text.indexOf('              "$8" node_modules/@playwright/test/cli.js test');
  const closer = text.indexOf("          ' probe", start);
  const after = text.indexOf('\n          if [ "$status" -ne 0 ]; then', closer);
  assert.ok(start >= 0 && closer > start && after > closer, 'namespace move fixture must find the real invocation');
  const command = text.slice(start, closer).replace('"$8"', 'node').replace('$9/playwright-private', '$PROBE_PRIVATE/playwright-private');
  const mutant = text.slice(0, start) + '              "$8" -e ""\n' + text.slice(closer, after) + '\n' + command + text.slice(after);
  assert.equal([...mutant.matchAll(/node_modules\/@playwright\/test\/cli\.js/g)].length, 1);
  assert.throws(() => assertConfinement(mutant), { code: 'ERR_ASSERTION' }, 'published_wasm_namespace_bound_invocation');
});

function assertSelectedCases(text) {
  assert.match(text, /published-wasm-startup\.spec\.ts --config=playwright\.config\.ts/);
  assert.match(text, /--workers=1 --retries=0 --timeout=60000 --global-timeout=180000/);
  assert.match(text, /--trace=off --reporter=dot/);
  assert.match(text, />\/dev\/null 2>&1/);
  const uploads = [...text.matchAll(/path: (.+)/g)].map(match => match[1]);
  assert.deepEqual(uploads, ['${{ runner.temp }}/published-wasm-results/*.json']);
  assert.doesNotMatch(text, /playwright-report|upload.*profile|\.har\b/);
}

const specPath = new URL('../playwright/tests/published-wasm-startup.spec.ts', import.meta.url);

test('published-wasm workflow selects only two bounded cases and never uploads raw browser artifacts', () => {
  assertSelectedCases(workflow(), readFileSync(specPath, 'utf8'));
});

test('published-wasm selection guard rejects extra, aliased, focused or reordered cases', () => {
  const text = workflow();
  const spec = readFileSync(specPath, 'utf8');
  const first = 'published archive cold startup completes packaged WASM and reaches onboarding';
  const second = 'published archive binary fetch failure recovers only after Try Again reloads the document';
  for (const comment of ['// test("not selected", async () => {});', '/* test("not selected", async () => {}); */']) {
    assert.doesNotThrow(() => assertSelectedCases(text, `${spec}\n${comment}\n`));
  }
  const mutants = [
    `${spec}\ntest.describe('nested', () => {\n  test('third case', async () => {});\n});\n`,
    `${spec}\ntest(\n  'third case', async () => {});\n`,
    `${spec}\ntest.only('third case', async () => {});\n`,
    `${spec}\nconst unquotedTitle = 'third case';\ntest(unquotedTitle, async () => {});\n`,
    `${spec}\nconst selected = test;\nselected('third case', async () => {});\n`,
    `${spec.replace('expect, test }', 'expect, test as selected }').replace(/\btest\./g, 'selected.').replace(/\btest\(/g, 'selected(')}\nselected('third case', async () => {});\n`,
    spec.replace(`test('${first}'`, `test.skip('${first}'`),
    spec.replace(first, '__first_case__').replace(second, first).replace('__first_case__', second)
  ];
  for (const mutant of mutants) {
    assert.notEqual(mutant, spec, 'case fixture must change selected source');
    assert.throws(() => assertSelectedCases(text, mutant), { code: 'ERR_ASSERTION' }, 'published_wasm_exact_two_cases');
  }
});
