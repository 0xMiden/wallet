/** @jest-environment node */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FullConfig, Suite, TestCase, TestResult } from '@playwright/test/reporter';

import WalletE2eReporter from '../playwright/e2e/reporting/wallet-e2e-reporter';
import { INVOCATIONS, TITLES } from './wallet-e2e/invocations.cjs';
import { main } from './wallet-e2e/job.cjs';
import { REPORT_FILENAME, createOperation, createStage } from './wallet-e2e/report.cjs';

type Stage = ReturnType<typeof createStage>;
type Operation = ReturnType<typeof createOperation>;
type Invocation = {
  id: string;
  status: string;
  tests: { status: string; attempts: { operations: Operation[] }[] }[];
};

let directory: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'wallet-report-semantics-'));
  env = {
    GITHUB_JOB: 'mainnet-nightly',
    GITHUB_REPOSITORY: '0xMiden/wallet',
    GITHUB_SHA: 'cccee6fb4001f4d3debf36c73329563fbb996d6f',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_REF: '0xMiden/wallet/.github/workflows/e2e-mainnet-nightly.yml@refs/heads/main',
    GITHUB_RUN_ID: '900004',
    GITHUB_RUN_NUMBER: '904',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_EVENT_NAME: 'schedule',
    MIDEN_E2E_MAINNET_NIGHTLY: 'true',
    E2E_NETWORK: 'mainnet',
    E2E_WALLET_REPORT_ROOT: directory
  };
  jest.replaceProperty(process, 'env', env);
  await main(env, ['initialize']);
});

afterEach(() => {
  jest.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

function stage(key: string, status = 'passed', origin = 'wallet_assertion'): Stage {
  return createStage({ key, status, origin });
}

function operation(key: string, kind: string, outcome: string, stages: Stage[], provider = 'solver'): Operation {
  return { ...createOperation({ key, kind, outcome, provider }), stages };
}

async function observe(invocationId: string, status: 'passed' | 'failed', operations: Operation[]) {
  const invocation = INVOCATIONS.get(invocationId);
  if (!invocation) throw new Error('Unknown fixture invocation');
  env.E2E_WALLET_REPORT_INVOCATION = invocationId;
  await main(env, ['invocation-start', invocationId]);
  const test = {
    id: 'fixture-' + invocationId,
    title: TITLES.get(invocation.suite)?.[0],
    location: { file: invocation.spec },
    parent: { project: () => ({ name: '' }) },
    expectedStatus: 'passed',
    outcome: () => (status === 'passed' ? 'expected' : 'unexpected')
  } as unknown as TestCase;
  const annotations = operations.map(value => ({
    type: 'wallet-e2e-observation-v1',
    description: JSON.stringify({ operation: value, timeout: 30_000 })
  }));
  const result = {
    retry: 0,
    workerIndex: 0,
    startTime: new Date(),
    duration: 1,
    status,
    annotations,
    error: { message: 'private_checkpoint_sentinel' }
  } as TestResult;
  const reporter = new WalletE2eReporter();
  reporter.onBegin({} as FullConfig, { allTests: () => [test] } as Suite);
  reporter.onTestBegin(test, result);
  reporter.onTestEnd(test, result);
  reporter.onEnd({ status } as Parameters<WalletE2eReporter['onEnd']>[0]);
  await main(env, ['invocation-end', invocationId, status === 'passed' ? '0' : '1']);
}

async function assembled(workflow: NodeJS.ProcessEnv = {}) {
  await main({ ...env, ...workflow }, ['assemble']);
  const bytes = readFileSync(join(directory, REPORT_FILENAME), 'utf8');
  expect(bytes).not.toContain('private_checkpoint_sentinel');
  return JSON.parse(bytes) as {
    coverage: { swap: { status: string }; bridge: { status: string }; freshSwapsStarted: { value: number | null } };
    invocations: Invocation[];
  };
}

function evidence(row: Invocation) {
  const [logical] = row.tests;
  const [attempt] = logical!.attempts;
  return attempt!.operations[0]!;
}

const freshStart = () => stage('execution', 'in_progress', 'wallet_ui');

it('uses actual Epoch forward and return observations even with an unchanged prepare-only summary', async () => {
  writeFileSync(
    join(directory, 'epoch-summary.json'),
    JSON.stringify({
      status: 'prepared',
      checkpoint: 'private_checkpoint_sentinel'
    })
  );
  await observe('epoch-prepare', 'passed', [
    operation('epoch-forward', 'setup', 'prepared', [stage('preparation')], 'Epoch')
  ]);
  await observe('epoch-forward', 'passed', [
    operation('epoch-forward', 'bridge', 'usable_receipt', [stage('usable_receipt')], 'Epoch')
  ]);
  await observe('epoch-reverse', 'passed', [
    operation('epoch-reverse', 'bridge', 'bridge_completion_asserted', [stage('usable_receipt')], 'Epoch')
  ]);
  const report = await assembled({ REPORT_INVOCATION_SWAP_FORWARD: 'skipped' });
  expect(report.invocations.map(row => evidence(row).outcome)).toEqual([
    'prepared',
    'usable_receipt',
    'bridge_completion_asserted'
  ]);
  expect(report.coverage.freshSwapsStarted.value).toBe(0);
  expect(readFileSync(join(directory, 'epoch-summary.json'), 'utf8')).toContain('"status":"prepared"');
});

it('preserves partial claim and refunded input on final failure despite a completed recovery checkpoint', async () => {
  writeFileSync(
    join(directory, 'roundtrip.json'),
    JSON.stringify({
      phase: 'complete',
      refundedInput: true,
      proof: 'private_checkpoint_sentinel'
    })
  );
  await observe('swap-forward', 'passed', [
    operation('swap-forward', 'swap', 'partial_fill', [freshStart(), stage('order'), stage('claim')])
  ]);
  await observe('swap-reverse', 'failed', [
    operation('swap-reverse', 'swap', 'partially_filled_and_refunded', [
      stage('claim'),
      stage('usable_receipt', 'failed')
    ])
  ]);
  const report = await assembled();
  const reverse = report.invocations.find(row => row.id === 'swap-reverse');
  expect(reverse!.status).toBe('failed');
  expect(reverse!.tests[0]?.status).toBe('failed');
  expect(evidence(reverse!).outcome).toBe('partially_filled_and_refunded');
  expect(evidence(reverse!).stages.map(value => [value.key, value.status])).toContainEqual(['claim', 'passed']);
});

it.each([
  ['inclusion', 'payment_unclaimed'],
  ['claim', 'claimed']
])('preserves observed %s without reporting full completion', async (key, outcome) => {
  await observe('swap-forward', 'failed', [operation('swap-forward', 'swap', outcome, [freshStart(), stage(key)])]);
  const report = await assembled();
  const observation = evidence(report.invocations[0]!);
  expect(observation.outcome).toBe(outcome);
  expect(observation.stages.map(value => value.key)).toEqual(['execution', key]);
  expect(report.coverage.swap.status).toBe('failed');
});

it.each(['swap-reverse', 'usdcx-round-trip'])(
  'keeps forward swap success distinct from failure in %s',
  async failure => {
    await observe('swap-forward', 'passed', [
      operation('swap-forward', 'swap', 'usable_receipt', [freshStart(), stage('usable_receipt')])
    ]);
    const bridge = failure === 'usdcx-round-trip';
    if (bridge) {
      await observe('swap-reverse', 'passed', [
        operation('swap-reverse', 'swap', 'full_swap_asserted', [stage('usable_receipt')])
      ]);
    }
    const failed = bridge
      ? operation(
          'usdcx-ethereum',
          'bridge',
          'executed',
          [stage('bridge_finality', 'failed', 'provider')],
          'Circle USDCx'
        )
      : operation('swap-reverse', 'swap', 'executed', [stage('approval'), stage('inclusion', 'failed')]);
    await observe(failure, 'failed', [failed]);
    const report = await assembled();
    expect(report.invocations[0]?.status).toBe('passed');
    expect(report.invocations.find(row => row.id === failure)?.status).toBe('failed');
    expect(report.coverage.swap.status).toBe(bridge ? 'passed' : 'failed');
    if (bridge) expect(report.coverage.bridge.status).toBe('failed');
    expect(report.coverage.freshSwapsStarted.value).toBe(1);
  }
);

it('counts zero fresh swaps when wallet session setup fails after Playwright starts the test', async () => {
  await observe('swap-forward', 'failed', [
    operation('swap-forward', 'swap', 'not_started', [stage('wallet_session', 'failed', 'wallet_ui')])
  ]);
  const report = await assembled();
  expect(report.invocations[0]?.tests[0]?.status).toBe('failed');
  expect(report.coverage.freshSwapsStarted.value).toBe(0);
});
