/** @jest-environment node */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import YAML from 'yaml';

import { recoveryFixture } from './wallet-e2e/fixtures/generate.cjs';
import { INVOCATIONS } from './wallet-e2e/invocations.cjs';
import { main } from './wallet-e2e/job.cjs';
import { REPORT_FILENAME, errorFor, formatReport } from './wallet-e2e/report.cjs';

const cwd = resolve(__dirname, '..');
const roots: string[] = [];

function sandbox() {
  const tmp = mkdtempSync(join(tmpdir(), 'wallet-nightly-report-'));
  roots.push(tmp);
  const root = join(tmp, 'report');
  const env = {
    PATH: process.env.PATH,
    TMPDIR: tmp,
    GITHUB_JOB: 'mainnet-nightly',
    GITHUB_REPOSITORY: '0xMiden/wallet',
    GITHUB_SHA: 'cccee6fb4001f4d3debf36c73329563fbb996d6f',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_REF: '0xMiden/wallet/.github/workflows/e2e-mainnet-nightly.yml@refs/heads/main',
    GITHUB_RUN_ID: '900002',
    GITHUB_RUN_NUMBER: '902',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_EVENT_NAME: 'schedule',
    MIDEN_E2E_MAINNET_NIGHTLY: 'true',
    E2E_NETWORK: 'mainnet',
    E2E_WALLET_REPORT_ROOT: root
  };
  const report = () => readFileSync(join(root, REPORT_FILENAME), 'utf8');
  return { tmp, root, env, report };
}

function runInvocation(id: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync('bash', ['scripts/wallet-e2e/run.sh', id, process.execPath, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 25_000
  });
}

function assertSanitized(data: string) {
  expect(data).not.toMatch(/sentinel|signed\.invalid|authorization|proofbytes|<script|rawnote|browserstorage/i);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('wallet-e2e/v1 projection', () => {
  it('distinguishes prior-run claims and blocked recovery from fresh swaps', () => {
    const failure = recoveryFixture();
    const failureJson = formatReport(failure);
    assertSanitized(failureJson);
    const failureReport = JSON.parse(failureJson);
    expect(failureReport.runId).toBe('900002');
    expect(failureReport.coverage.freshSwapsStarted.value).toBe(0);
    expect(failureReport.coverage.swap.status).toBe('not_started');
    expect(failureReport.stages[0]?.error).toEqual(errorFor('recovery_gate_failed'));

    const previous = recoveryFixture(true);
    const previousJson = formatReport(previous);
    assertSanitized(previousJson);
    const previousReport = JSON.parse(previousJson);
    expect(previousReport.runId).toBe('900003');
    expect(previousReport.invocations[0]?.tests[0]?.status).toBe('passed');
    expect(previousReport.coverage.freshSwapsStarted.value).toBe(0);
    const action = previousReport.invocations[0]?.tests[0]?.attempts[0]?.operations[0];
    expect(action?.sourceRunId.value).toBe('900001');
    expect(action?.sourceRunId.value).not.toEqual(previousReport.runId);
    expect(action?.recoveryEffect).toEqual('prior_authorized_claim');
  });

  it.each([
    ['unsupported version', { schemaVersion: 'wallet-e2e/v99' }],
    ['unsafe numeric run ID', { runId: 17 }],
    ['invalid run ID', { runId: '900002\n' }],
    ['impossible date', { generatedAt: '2026-02-30T05:45:18Z' }],
    ['private attachment', { attachments: { seed: 'private_seed_sentinel', authorization: 'header' } }]
  ])('rejects %s', (name, change) => {
    expect(() => formatReport({ ...recoveryFixture(), ...change })).toThrow(/Invalid wallet E2E/);
  });

  it('rejects unsigned numeric coercion or decomposed invalid elapsed evidence', () => {
    const fixture = recoveryFixture();
    const stage = fixture.stages[0];
    expect(() =>
      formatReport({ ...fixture, stages: [{ ...stage, elapsedMs: { value: -1, reason: null } }] })
    ).toThrow();
    expect(() =>
      formatReport({
        ...fixture,
        stages: [{ ...stage, elapsedMs: { value: null, reason: null } }]
      })
    ).toThrow();
  });
});

describe('wallet report command boundary', () => {
  it.each([0, 17])('preserves command exit %i on reporting-write failure', async code => {
    const { root, env } = sandbox();
    await main(env, ['initialize']);
    mkdirSync(join(root, 'invocations'));
    writeFileSync(join(root, 'invocations', 'swap-forward'), 'journal write must fail');
    const invocation = runInvocation('swap-forward', env, '-e', 'process.exit(' + code + ')');
    expect(invocation.status).toBe(code);
    expect(invocation.stdout).toBe('');
    expect(invocation.stderr).toBe('');
  });

  it('keeps each overlapping invocation and original command outcome in its own journal', async () => {
    const { root, env, report } = sandbox();
    await main(env, ['initialize']);
    const result = spawnSync(
      'bash',
      [
        '-c',
        [
          'bash scripts/wallet-e2e/run.sh swap-forward "$1" -e "process.exit(0)" &',
          'a=$!',
          'bash scripts/wallet-e2e/run.sh swap-reverse "$1" -e "process.exit(17)" &',
          'b=$!',
          'wait "$a"; a_status=$?',
          'wait "$b"; b_status=$?',
          '[ "$a_status" = 0 ] && [ "$b_status" = 17 ]'
        ].join('\n'),
        'offline-wallet-e2e',
        process.execPath
      ],
      { cwd, env, timeout: 10_000 }
    );
    expect(result.status).toBe(0);
    await main(env, ['assemble']);
    const assembled = JSON.parse(report());
    expect(assembled.availability).toBe('partial');
    expect(
      assembled.invocations.map((row: { id: string; exitCode: { value: number } }) => [row.id, row.exitCode.value])
    ).toEqual([
      ['swap-forward', 0],
      ['swap-reverse', 17]
    ]);
    expect(readFileSync(join(root, 'invocations', 'swap-forward', 'exit.json'), 'utf8')).toContain('"code":0');
  });

  it('withholds affected payload if projection fails and refuses funded rerun and topic-ref manifests', async () => {
    const { root, env, report } = sandbox();
    await main({ ...env, GITHUB_RUN_ATTEMPT: '2' }, ['initialize']);
    await main({ ...env, GITHUB_REF: 'refs/heads/temporary' }, ['initialize']);
    expect(() => readFileSync(join(root, 'job.json'))).toThrow();
    await main(env, ['initialize']);
    await main(env, ['assemble']);
    expect(report()).toContain('wallet-e2e/v1');
    writeFileSync(join(root, 'job.json'), '{"identity":null}');
    await expect(main(env, ['assemble'])).rejects.toThrow('Wallet E2E manifest unavailable');
    expect(() => report()).toThrow();
  });

  it('reports bridge-only selection while keeping swap recovery evidence', async () => {
    const { env, report } = sandbox();
    const bridgeOnly = { ...env, GITHUB_EVENT_NAME: 'workflow_dispatch', REPORT_BRIDGES_ONLY: 'true' };
    await main(bridgeOnly, ['initialize']);
    await main(
      {
        ...bridgeOnly,
        REPORT_BUILD_OUTCOME: 'success',
        REPORT_WAIT_SWAP_RECOVER: 'failure',
        REPORT_INVOCATION_SWAP_FORWARD: 'skipped'
      },
      ['assemble']
    );
    const assembled = JSON.parse(report());
    expect(assembled.coverage).toEqual({
      swap: { selection: 'not_selected', status: 'not_started', reason: 'workflow_selection' },
      bridge: { selection: 'selected', status: 'not_started', reason: 'blocked_by_recovery' },
      freshSwapsStarted: { value: 0, reason: null }
    });
    expect(assembled.stages).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'recovery_gate', status: 'failed' })])
    );
  });

  it('uses setup and recovery gate evidence, while keeping workflow selection separate', async () => {
    const { env, report } = sandbox();
    await main({ ...env, REPORT_SWAPS_ONLY: 'true' }, ['initialize']);
    await main(
      {
        ...env,
        REPORT_BUILD_OUTCOME: 'success',
        REPORT_WAIT_SWAP_RECOVER: 'failure',
        REPORT_INVOCATION_SWAP_FORWARD: 'skipped'
      },
      ['assemble']
    );
    let assembled = JSON.parse(report());
    expect(assembled.availability).toBe('partial');
    expect(assembled.coverage).toEqual({
      swap: { selection: 'selected', status: 'not_started', reason: 'blocked_by_recovery' },
      bridge: { selection: 'not_selected', status: 'not_started', reason: 'workflow_selection' },
      freshSwapsStarted: { value: 0, reason: null }
    });
    await main(env, ['initialize']);
    await main({ ...env, REPORT_BUILD_OUTCOME: 'failure', REPORT_INVOCATION_SWAP_FORWARD: 'skipped' }, ['assemble']);
    assembled = JSON.parse(report());
    expect(assembled.coverage.bridge.reason).toBe('blocked_by_setup');
    expect(assembled.stages[0].error.code).toBe('setup_failed');
    assertSanitized(report());
  });

  it.each([
    ['a failed pre-build step', 'success failure skipped', 'skipped', 'failed', 'setup_failed'],
    ['a cancelled pre-build step', 'success cancelled skipped', 'skipped', 'interrupted', null],
    ['an unexpected outcome string beside a failure', 'success sentinel failure', 'skipped', 'failed', 'setup_failed'],
    ['all setup steps and the build passing', 'success skipped success', 'success', 'passed', null]
  ])('records the setup stage for %s', async (_, setup, build, status, code) => {
    const { env, report } = sandbox();
    await main(env, ['initialize']);
    await main(
      { ...env, REPORT_SETUP_OUTCOMES: setup, REPORT_BUILD_OUTCOME: build, REPORT_INVOCATION_SWAP_FORWARD: 'skipped' },
      ['assemble']
    );
    const assembled = JSON.parse(report());
    expect(assembled.stages).toEqual([
      expect.objectContaining({
        key: 'setup',
        status,
        origin: 'workflow',
        error: code ? expect.objectContaining({ code }) : null
      })
    ]);
    if (status === 'failed') expect(assembled.coverage.bridge.reason).toBe('blocked_by_setup');
    assertSanitized(report());
  });

  it('records no setup stage when no setup step ran or all were skipped', async () => {
    const { env, report } = sandbox();
    await main(env, ['initialize']);
    await main({ ...env, REPORT_SETUP_OUTCOMES: 'skipped skipped', REPORT_BUILD_OUTCOME: 'skipped' }, ['assemble']);
    expect(JSON.parse(report()).stages).toEqual([]);
  });

  // GitHub Actions steps 49–59 in the two referenced mainnet jobs.
  it.each([
    ['164', 'success', 'failure', 'failed', 'recovery_gate_failed'],
    ['153', 'cancelled', 'skipped', 'interrupted', null]
  ])('replays the public NEAR recovery and fresh-swap outcomes from run %s', async (_, launch, auth, status, code) => {
    const { env, report } = sandbox();
    await main(env, ['initialize']);
    await main(
      {
        ...env,
        REPORT_BUILD_OUTCOME: 'success',
        REPORT_INVOCATION_SWAP_RECOVER: 'success',
        REPORT_WAIT_SWAP_RECOVER: 'success',
        REPORT_INVOCATION_EPOCH_RECOVER: 'success',
        REPORT_WAIT_EPOCH_RECOVER: 'success',
        REPORT_INVOCATION_NEAR_RECOVER: launch,
        REPORT_RECOVERY_AUTH_OUTCOMES: ['success', auth, 'skipped'].join(' '),
        REPORT_WAIT_NEAR_RECOVER: 'skipped',
        REPORT_BARRIER_OUTCOME: 'skipped',
        REPORT_INVOCATION_SWAP_PREPARE: 'skipped',
        REPORT_INVOCATION_SWAP_FORWARD: 'skipped'
      },
      ['assemble']
    );
    expect(JSON.parse(report())).toMatchObject({
      availability: 'partial',
      invocations: [],
      coverage: {
        swap: { selection: 'selected', status: 'not_started', reason: 'blocked_by_recovery' },
        bridge: { selection: 'selected', status: 'not_started', reason: 'blocked_by_recovery' },
        freshSwapsStarted: { value: 0, reason: null }
      },
      stages: expect.arrayContaining([
        expect.objectContaining({ key: 'recovery_gate', origin: 'workflow', status, error: errorFor(code) })
      ])
    });
    assertSanitized(report());
  });

  it('runs the real reporter on a hermetic fixture and keeps failed retry evidence', async () => {
    const { tmp, env, report } = sandbox();
    await main(env, ['initialize']);
    const testModule = JSON.stringify(resolve(cwd, 'node_modules/@playwright/test'));
    const codec = JSON.stringify(resolve(cwd, 'scripts/wallet-e2e/report.cjs'));
    const reporter = resolve(cwd, 'playwright/e2e/reporting/wallet-e2e-reporter.ts');
    const config = join(tmp, 'offline.config.cjs');
    writeFileSync(
      config,
      'module.exports = ' +
        JSON.stringify({
          testDir: tmp,
          timeout: 2_000,
          retries: 1,
          reporter: [[reporter]],
          workers: 1
        })
    );
    writeFileSync(join(tmp, 'mainnet-swap-loop.spec.cjs'), 'throw new Error("not the selected suffix");');
    writeFileSync(
      join(tmp, 'mainnet-swap-loop.spec.ts'),
      [
        'const { test, expect } = require(' + testModule + ');',
        'const { createOperation, createStage } = require(' + codec + ');',
        "test('real Guardian mainnet solver swaps out and back with recycled principal', async ({}, info) => {",
        '  const operation = createOperation({',
        "    key: 'swap-forward', kind: 'swap', surface: 'wallet_ui_and_helper', provider: 'solver',",
        "    sourceNetwork: 'Miden', destinationNetwork: 'Miden', outcome: 'prepared', secret: 'rawnote_sentinel'",
        '  });',
        "  const stages = [createStage({key: 'preparation', origin: 'wallet_assertion', status: 'passed'})];",
        "  if (info.retry === 1) stages.push(createStage({key: 'execution', origin: 'wallet_ui', status: 'in_progress'}));",
        "  info.annotations.push({type: 'wallet-e2e-observation-v1', description: JSON.stringify({operation: {...operation, stages}, timeout: 2000})});",
        "  await info.attach('authorization', {body: Buffer.from('proofbytes_sentinel'), contentType: 'text/plain'});",
        "  expect(info.retry, 'browserstorage_sentinel <script>alert(1)</script>').toBe(1);",
        '});'
      ].join('\n')
    );
    const run = runInvocation(
      'swap-forward',
      env,
      resolve(cwd, 'node_modules/playwright/cli.js'),
      'test',
      '--config',
      config,
      'mainnet-swap-loop.spec.ts$'
    );
    expect(run.status).toBe(0);
    await main(env, ['assemble']);
    const bytes = report();
    assertSanitized(bytes);
    const parsed = JSON.parse(bytes);
    const [invocation] = parsed.invocations;
    const [logical] = invocation.tests;
    expect(parsed.coverage.freshSwapsStarted.value).toBe(1);
    expect(invocation.exitCode.value).toBe(0);
    expect(invocation.playwrightOutcome.value).toBe('passed');
    expect(logical.outcome).toBe('flaky');
    expect(logical.attempts.map(({ status }: { status: string }) => status)).toEqual(['failed', 'passed']);
    expect(logical.attempts.every(({ operations }: { operations: unknown[] }) => operations.length === 1)).toBe(true);
  }, 30_000);
});

describe('nightly workflow report wiring', () => {
  const source = readFileSync(resolve(cwd, '.github/workflows/e2e-mainnet-nightly.yml'), 'utf8');
  function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a workflow mapping');
    return Object.fromEntries(Object.entries(value));
  }

  it('assigns one stable id per existing call and leaves each exit-file protocol in place', () => {
    const calls = Array.from(
      source.matchAll(/scripts\/wallet-e2e\/run\.sh ([a-z-]+) xvfb-run -a yarn playwright test/g)
    );
    expect(calls.map(call => call[1]).sort()).toEqual(Array.from(INVOCATIONS.keys()).sort());
    for (const id of ['swap-recover', 'swap-forward', 'swap-reverse', 'epoch-recover', 'near-recover']) {
      expect(source).toContain('> "$RUNNER_TEMP/' + id + '.exit"');
      expect(source).toMatch(new RegExp('read -r code < "\\$RUNNER_TEMP/' + id + '\\.exit"'));
    }
  });

  it('projects the original provider recovery steps into the report without changing their verdicts', () => {
    const jobs = record(record(YAML.parse(source)).jobs);
    const mainJob = record(jobs['mainnet-nightly']);
    if (!Array.isArray(mainJob.steps)) throw new Error('Expected mainnet steps');
    const steps = mainJob.steps.map(record);
    const assemble = steps.find(step => step.name === 'Assemble Wallet E2E report');
    const variables = record(assemble?.env);
    const authorizationOutcomes = String(variables.REPORT_RECOVERY_AUTH_OUTCOMES);
    expect(authorizationOutcomes).toContain('${{ steps.epoch-recover-auth.outcome }}');
    expect(authorizationOutcomes).toContain('${{ steps.near-recover-auth.outcome }}');
    const referenced = Array.from(authorizationOutcomes.matchAll(/steps\.([a-z0-9-]+)\.outcome/g), match => match[1]);
    const recoveryBarrier = steps.findIndex(step => step.id === 'recovery-barrier');
    for (const id of referenced) {
      const index = steps.findIndex(step => step.id === id);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(recoveryBarrier);
      expect(steps[index]?.['continue-on-error']).toBeUndefined();
    }
    expect(variables).toMatchObject({
      REPORT_INVOCATION_NEAR_RECOVER: '${{ steps.wallet-observe-near-recover.outcome }}',
      REPORT_WAIT_NEAR_RECOVER: '${{ steps.near-recovered.outcome }}',
      REPORT_BARRIER_OUTCOME: '${{ steps.recovery-barrier.outcome }}',
      REPORT_INVOCATION_SWAP_FORWARD: '${{ steps.swap-forward-run.outcome }}'
    });
  });

  it('isolates projection and upload failures from verdicts and uploads only the fixed safe filename', () => {
    const jobs = record(record(YAML.parse(source)).jobs);
    for (const [id, value] of Object.entries(jobs)) {
      const job = record(value);
      const key = id === 'mainnet-nightly' ? 'mainnet' : 'agglayer';
      expect(job['continue-on-error']).toBeUndefined();
      if (!Array.isArray(job.steps)) throw new Error('Expected job steps');
      const steps = job.steps.map(record);
      const assemble = steps.find(step => step.name === 'Assemble Wallet E2E report');
      const upload = steps.find(step => step.name === 'Upload Wallet E2E report');
      expect(assemble).toMatchObject({
        'continue-on-error': true,
        if: "always() && steps.wallet-report-init.outcome == 'success'"
      });
      expect(upload).toMatchObject({
        'continue-on-error': true,
        if: "always() && steps.wallet-report-assemble.outcome == 'success'",
        with: {
          name: 'wallet-e2e-v1-${{ github.run_id }}-${{ github.run_attempt }}-' + key,
          path: '${{runner.temp}}/wallet-e2e/' + key + '/wallet-e2e-report-v1.json'
        }
      });
      for (const name of ['Initialize Wallet E2E report', 'Capture Wallet E2E build identity']) {
        expect(steps.find(step => step.name === name)?.['continue-on-error']).toBe(true);
      }
    }
  });
});
