/** @jest-environment node */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { TestInfo } from '@playwright/test';
import type { FullConfig, Suite, TestCase, TestResult } from '@playwright/test/reporter';

import {
  commonSwapQuoteRefusal,
  readLiveSwapLeg,
  recordTerminalRouteRefusal,
  swapQuoteRefusal,
  validateSwapEta
} from '../playwright/e2e/helpers/mainnet-swap-ui';
import { observeNightly } from '../playwright/e2e/reporting/nightly-observation';
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

const evidenceDirectory = process.env.WALLET_REPORT_EVIDENCE_DIR;

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

function observe(invocationId: string, status: 'passed' | 'failed', operations: Operation[]) {
  return replayAnnotations(
    invocationId,
    status,
    operations.map(value => ({
      type: 'wallet-e2e-observation-v1',
      description: JSON.stringify({ operation: value, timeout: 30_000 })
    }))
  );
}

async function replayAnnotations(
  invocationId: string,
  status: 'passed' | 'failed' | 'timedOut' | 'interrupted',
  annotations: TestResult['annotations'],
  runStatus: string = status
) {
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
  reporter.onEnd({ status: runStatus } as Parameters<WalletE2eReporter['onEnd']>[0]);
  await main(env, ['invocation-end', invocationId, status === 'passed' ? '0' : '1']);
}

async function assembled(workflow: NodeJS.ProcessEnv = {}, fixtureName?: string) {
  await main({ ...env, ...workflow }, ['assemble']);
  const bytes = readFileSync(join(directory, REPORT_FILENAME), 'utf8');
  expect(bytes).not.toContain('private_checkpoint_sentinel');
  if (evidenceDirectory && fixtureName) {
    mkdirSync(evidenceDirectory, { recursive: true });
    writeFileSync(join(evidenceDirectory, fixtureName + '.json'), bytes);
  }
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

const offered = {
  hex: 'a',
  faucetId: 'private_checkpoint_sentinel',
  symbol: 'USDC',
  decimals: 6,
  balance: '987654321',
  usdMicros: '1000000'
};
const requested = { ...offered, hex: 'b', symbol: 'USDT' };
const eta = {
  offeredFaucet: 'a',
  requestedFaucet: 'b',
  offeredAmount: '1010000',
  requestedAmount: '1009444',
  settlementsRunning: true,
  fillStatus: 'full',
  priceBand: 'at_market',
  reason: null,
  fillableOfferedAmount: '1010000',
  fillableRequestedAmount: '1009444'
};

const quoteRefusals = [
  { code: 'quote_price_stale', priceOffset: -61 },
  { code: 'quote_price_clock_skew', priceOffset: 31 },
  { code: 'quote_settlement_paused', verdict: { ...eta, settlementsRunning: false } },
  {
    code: 'quote_liquidity_insufficient',
    verdict: {
      ...eta,
      fillStatus: 'none',
      reason: 'liquidity',
      fillableOfferedAmount: '0',
      fillableRequestedAmount: '0'
    }
  },
  {
    code: 'quote_price_out_of_band',
    verdict: {
      ...eta,
      fillStatus: 'none',
      priceBand: 'off_market',
      reason: 'price',
      fillableOfferedAmount: '0',
      fillableRequestedAmount: '0'
    }
  },
  { code: 'quote_unavailable', verdict: { ...eta, requestedFaucet: 'different-pair', settlementsRunning: false } }
];

it.each(quoteRefusals)('emits $code only from bound solver quote evidence', async ({ code, priceOffset, verdict }) => {
  const price = {
    offeredFaucet: offered.hex,
    requestedFaucet: requested.hex,
    offeredDecimals: 6,
    requestedDecimals: 6,
    fillPrice: '0.99995',
    asOf: Math.floor(Date.now() / 1000) + (priceOffset ?? 0)
  };
  const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json(price));
  if (verdict) fetch.mockResolvedValueOnce(Response.json(verdict));
  env.E2E_WALLET_REPORT_INVOCATION = 'swap-forward';
  const annotations: TestInfo['annotations'] = [];
  const record = observeNightly({ annotations, timeout: 30_000 } as TestInfo, {
    key: 'swap-forward',
    kind: 'swap',
    provider: 'solver'
  });
  await expect(readLiveSwapLeg('https://solver.example', offered, requested, 1_010_000n, record)).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(verdict ? 2 : 1);
  await replayAnnotations('swap-forward', 'failed', annotations);
  const report = await assembled({}, code.replaceAll('_', '-'));
  const quote = evidence(report.invocations[0]!);
  expect(quote.provider).toBe('solver');
  expect(quote.outcome).toBe('unknown');
  expect(quote.stages.at(-1)).toMatchObject({
    key: 'quote_availability',
    origin: 'wallet_assertion',
    status: 'failed',
    endpoint: verdict ? 'inicio_swap_eta' : 'inicio_pair_price',
    error: { code },
    priceAgeMs: { value: null }
  });
  expect(
    quote.stages
      .filter(value => value.key === 'quote_request')
      .map(({ endpoint, httpStatus }) => [endpoint, httpStatus.value])
  ).toEqual(
    verdict
      ? [
          ['inicio_pair_price', 200],
          ['inicio_swap_eta', 200]
        ]
      : [['inicio_pair_price', 200]]
  );
  expect(quote.stages.some(value => value.key === 'execution')).toBe(false);
  expect(report.coverage.freshSwapsStarted.value).toBeNull();
  expect(JSON.stringify(report)).not.toContain(offered.balance);
});

it('reports a consistent terminal route-search refusal before starting fresh swap execution', async () => {
  const price = {
    offeredFaucet: offered.hex,
    requestedFaucet: requested.hex,
    offeredDecimals: 6,
    requestedDecimals: 6,
    fillPrice: '0.99995',
    asOf: Math.floor(Date.now() / 1000) - 61
  };
  const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(price));
  const refusals = [];
  for (const amount of [1_010_000n, 1_020_000n]) {
    try {
      await readLiveSwapLeg('https://solver.example', offered, requested, amount);
    } catch (error) {
      const refusal = swapQuoteRefusal(error);
      if (refusal) refusals.push(refusal);
    }
  }
  expect(fetch).toHaveBeenCalledTimes(2);
  const agreed = commonSwapQuoteRefusal(2, refusals);
  expect(agreed).toEqual({ errorCode: 'quote_price_stale', endpoint: 'inicio_pair_price' });
  expect(commonSwapQuoteRefusal(3, refusals)).toBeUndefined();
  expect(commonSwapQuoteRefusal(0, [])).toBeUndefined();

  env.E2E_WALLET_REPORT_INVOCATION = 'swap-prepare';
  const annotations: TestInfo['annotations'] = [];
  const observe = observeNightly({ annotations, timeout: 30_000 } as TestInfo, {
    key: 'swap-forward',
    kind: 'setup',
    provider: 'solver'
  });
  recordTerminalRouteRefusal(observe, 3, refusals);
  expect(annotations).toHaveLength(0);
  recordTerminalRouteRefusal(observe, 2, refusals);
  expect(annotations).toHaveLength(1);
  await replayAnnotations('swap-prepare', 'failed', annotations);
  const report = await assembled({ REPORT_INVOCATION_SWAP_FORWARD: 'skipped' }, 'quote-route-selection-stale');
  expect(evidence(report.invocations[0]!)).toMatchObject({
    kind: 'setup',
    provider: 'solver',
    outcome: 'unknown',
    stages: [{ key: 'quote_availability', status: 'failed', error: { code: 'quote_price_stale' } }]
  });
  expect(report.coverage.freshSwapsStarted.value).toBe(0);
});

it('records the terminal route-search refusal from the production no-candidate branch', () => {
  const spec = readFileSync(join(__dirname, '../playwright/e2e/tests/mainnet/mainnet-swap-loop.spec.ts'), 'utf8');
  const branch = spec.indexOf("recordTerminalRouteRefusal(observeSwap('forward'), attempts, refusals)");
  expect(branch).toBeGreaterThan(0);
  expect(branch).toBeLessThan(spec.indexOf('No funded two-way mainnet swap fits both'));
});

it('keeps contradictory and mixed quote declines from explaining route selection', () => {
  const refusalFor = (result: object) => {
    try {
      validateSwapEta(result, offered.hex, requested.hex, 1_010_000n, 1_009_444n);
    } catch (error) {
      return swapQuoteRefusal(error);
    }
    throw new Error('Expected quote rejection');
  };
  const noFill = { ...eta, fillStatus: 'none', reason: 'liquidity' };
  expect(refusalFor(noFill)).toBeUndefined();
  const insufficient = refusalFor({ ...noFill, fillableOfferedAmount: '0', fillableRequestedAmount: '0' });
  const paused = refusalFor({ ...eta, settlementsRunning: false });
  expect(insufficient?.errorCode).toBe('quote_liquidity_insufficient');
  expect(paused?.errorCode).toBe('quote_settlement_paused');
  expect(commonSwapQuoteRefusal(2, [insufficient!, paused!])).toBeUndefined();
});

it.each([
  ['near-recover', 'near-recovery', 'NEAR', 'recovery_checkpoint_account_mismatch'],
  ['swap-recovery-grant', 'swap-recovery', 'solver', 'recovery_approval_missing']
])('preserves the observed %s refusal without releasing new authority', async (invocation, key, provider, code) => {
  await observe(invocation, 'failed', [
    operation(
      key,
      'recovery',
      'unknown',
      [createStage({ key: 'recovery_gate', status: 'failed', origin: 'wallet_assertion', errorCode: code })],
      provider
    )
  ]);
  const report = await assembled(
    {
      REPORT_BARRIER_OUTCOME: 'failure',
      REPORT_INVOCATION_SWAP_FORWARD: 'skipped'
    },
    code.replaceAll('_', '-')
  );
  expect(evidence(report.invocations[0]!)).toMatchObject({
    provider,
    outcome: 'unknown',
    stages: [{ key: 'recovery_gate', status: 'failed', error: { code } }]
  });
  expect(report.coverage.freshSwapsStarted.value).toBe(0);
});

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
  expect(JSON.stringify(report)).not.toContain('private_checkpoint_sentinel');
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
  expect(JSON.stringify(report)).not.toContain('private_checkpoint_sentinel');
});

it('records a whole-run Playwright timeout as timed_out and keeps the report available', async () => {
  await replayAnnotations('swap-forward', 'timedOut', [], 'timedout');
  await main(env, ['assemble']);
  const report = JSON.parse(readFileSync(join(directory, REPORT_FILENAME), 'utf8')) as {
    availability: string;
    invocations: { id: string; status: string; playwrightOutcome: { value: string | null } }[];
  };
  const row = report.invocations.find(value => value.id === 'swap-forward');
  expect(row!.playwrightOutcome.value).toBe('timed_out');
  expect(row!.status).toBe('timed_out');
  expect(report.availability).toBe('available');
});

it('reports a selected interrupted invocation as interrupted swap coverage', async () => {
  await replayAnnotations('swap-forward', 'interrupted', [], 'interrupted');
  const report = await assembled();
  expect(report.coverage.swap.status).toBe('interrupted');
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

const unobserved = (key: string) =>
  createStage({ key, status: 'unknown', origin: 'sdk_read', evidence: 'not_recorded', reason: 'not_instrumented' });

const authorizationReleased = () =>
  operation('swap-forward', 'swap', 'authorization_released', [
    freshStart(),
    stage('approval', 'passed', 'wallet_ui'),
    stage('execution'),
    unobserved('proof'),
    unobserved('submission')
  ]);

const originalIncluded = () =>
  createStage({
    key: 'inclusion',
    status: 'passed',
    origin: 'sdk_read',
    endpoint: 'miden_mainnet_rpc'
  });

it('keeps releasing authorization separate from proof and network submission', async () => {
  await observe('swap-forward', 'failed', [authorizationReleased()]);
  const report = await assembled({}, 'authorization-released');
  const observation = evidence(report.invocations[0]!);
  expect(observation.outcome).toBe('authorization_released');
  expect(observation.stages.map(value => [value.key, value.status])).toEqual([
    ['execution', 'in_progress'],
    ['approval', 'passed'],
    ['execution', 'passed'],
    ['proof', 'unknown'],
    ['submission', 'unknown']
  ]);
});

it('keeps canonical original inclusion when the wait for exact payback expires', async () => {
  await observe('swap-forward', 'failed', [
    authorizationReleased(),
    operation('swap-forward', 'swap', 'included', [originalIncluded()]),
    operation('swap-forward', 'swap', 'unknown', [
      createStage({
        key: 'payback',
        status: 'failed',
        origin: 'sdk_read',
        endpoint: 'miden_mainnet_rpc',
        errorCode: 'order_outcome_unconfirmed',
        elapsedMs: 300_000,
        timeoutMs: 300_000
      })
    ])
  ]);
  const report = await assembled({}, 'included-payback-timeout');
  const observation = evidence(report.invocations[0]!);
  expect(observation.outcome).toBe('included');
  expect(observation.received.value).toBeNull();
  expect(observation.fee.value).toBeNull();
  expect(observation.stages.map(value => [value.key, value.status])).toEqual(
    expect.arrayContaining([
      ['inclusion', 'passed'],
      ['payback', 'failed']
    ])
  );
  expect(report.coverage.swap.status).toBe('failed');
});

it('keeps an unclaimed payment separate from funds verified in the wallet', async () => {
  await observe('swap-forward', 'failed', [
    authorizationReleased(),
    operation('swap-forward', 'swap', 'included', [originalIncluded()]),
    operation('swap-forward', 'swap', 'fully_filled', [
      stage('payback', 'passed', 'sdk_read'),
      stage('order', 'passed', 'sdk_read')
    ]),
    operation('swap-forward', 'swap', 'payment_unclaimed', [])
  ]);
  const report = await assembled({}, 'payment-unclaimed');
  expect(evidence(report.invocations[0]!)).toMatchObject({
    outcome: 'payment_unclaimed',
    received: { value: null, reason: 'not_observed' },
    fee: { value: null, reason: 'not_observed' }
  });
});

it('reports usable received funds after inclusion, full-fill proof and native claim', async () => {
  const received = { asset: 'USDC', baseUnits: '1200000', decimals: 6 };
  await observe('swap-forward', 'passed', [
    authorizationReleased(),
    operation('swap-forward', 'swap', 'included', [originalIncluded()]),
    operation('swap-forward', 'swap', 'fully_filled', [
      stage('payback', 'passed', 'sdk_read'),
      stage('order', 'passed', 'sdk_read')
    ]),
    operation('swap-forward', 'swap', 'claimed', [stage('claim')]),
    {
      ...createOperation({
        key: 'swap-forward',
        kind: 'swap',
        outcome: 'usable_receipt',
        provider: 'solver',
        received
      }),
      stages: [stage('usable_receipt')]
    }
  ]);
  await observe('swap-reverse', 'passed', [
    operation('swap-reverse', 'swap', 'full_swap_asserted', [stage('usable_receipt')])
  ]);
  const report = await assembled({}, 'verified-wallet-receipt');
  const observation = evidence(report.invocations[0]!);
  expect(observation.outcome).toBe('usable_receipt');
  expect(observation.received.value).toEqual(received);
  expect(observation.stages.slice(-5).map(value => [value.key, value.status])).toEqual([
    ['inclusion', 'passed'],
    ['payback', 'passed'],
    ['order', 'passed'],
    ['claim', 'passed'],
    ['usable_receipt', 'passed']
  ]);
  expect(report.coverage.swap.status).toBe('passed');
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
