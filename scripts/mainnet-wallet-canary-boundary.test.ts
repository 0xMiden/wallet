/** @jest-environment node */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { releaseMainnetSendAuthorization } from '../playwright/e2e/helpers/mainnet-send-authorization';
import { saveMainnetSwapCheckpoint } from '../playwright/e2e/helpers/mainnet-swap-checkpoint';
import { readLiveSwapLeg } from '../playwright/e2e/helpers/mainnet-swap-ui';
import { MainnetWalletCanaryLedger } from '../playwright/e2e/helpers/mainnet-wallet-canary-ledger';
import { planCanarySwap } from '../playwright/e2e/helpers/mainnet-wallet-canary-plan';
import { runCanary, type CanaryBrowser } from '../playwright/e2e/helpers/mainnet-wallet-canary';
import type { GuardianAwareWalletPage } from '../playwright/e2e/fixtures/two-wallets';
import type { MainnetSwapCheckpoint } from '../playwright/e2e/helpers/mainnet-swap-checkpoint';
import { TEST_SEND_AUTHORIZATION_KEY } from '../src/lib/miden/sdk/test-send-authorization';
import { TEST_CONSUME_AUTHORIZATION_KEY } from '../src/lib/miden/sdk/test-consume-authorization';
import {
  WALLET_CANARY_REPORT_FILENAME,
  WALLET_CANARY_WORKFLOW_PATH
} from '../playwright/e2e/reporting/wallet-canary-report';

const slotStart = '2026-11-23T00:00:00Z';
const start = Date.parse(slotStart);
const account = 'mm1canaryfixture';
const offer = {
  faucetId: 'mm1offerfixture',
  hex: '0x' + '1'.repeat(30),
  symbol: 'USDCX',
  decimals: 6,
  balance: '10000000',
  usdMicros: '1000000'
};
const request = { ...offer, faucetId: 'mm1requestfixture', hex: '0x' + '2'.repeat(30), symbol: 'USDC' };
const native = { ...offer, faucetId: 'mm1nativefixture', hex: '0x' + '3'.repeat(30), symbol: 'MIDEN' };
const planInput = {
  account,
  runId: '900001',
  offer,
  request,
  native,
  principal: 1_100_000n,
  baseFee: 1n,
  pricedAt: slotStart,
  now: start + 1000,
  maxPrincipalUsdMicros: 1_200_000n,
  maxFeeBaseUnits: 80n,
  maxLossUsdMicros: 1_200_000n
};

afterEach(() => jest.restoreAllMocks());

function fixtureQuotes() {
  return jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = new URL(String(input));
    expect(url.searchParams.get('offered_faucet')).toBe(offer.hex);
    expect(url.searchParams.get('requested_faucet')).toBe(request.hex);
    if (url.pathname === '/v2/pair-price')
      return Response.json({
        offeredFaucet: offer.hex,
        requestedFaucet: request.hex,
        offeredDecimals: 6,
        requestedDecimals: 6,
        fillPrice: '1',
        asOf: Math.floor(start / 1000)
      });
    expect(url.pathname).toBe('/v2/swap-eta');
    const minimum = url.searchParams.get('requested_amount');
    return Response.json({
      offeredFaucet: offer.hex,
      requestedFaucet: request.hex,
      offeredAmount: '1100000',
      requestedAmount: minimum,
      settlementsRunning: true,
      fillStatus: 'full',
      priceBand: 'at_market',
      reason: null,
      fillableOfferedAmount: '1100000',
      fillableRequestedAmount: minimum
    });
  });
}

it('prices one chosen direction and reserves the whole exposed principal and both wallet fees', async () => {
  jest.spyOn(Date, 'now').mockReturnValue(start + 1000);
  const fetch = fixtureQuotes();
  const plan = planCanarySwap(planInput);
  const quote = await readLiveSwapLeg('https://solver.example', offer, request, planInput.principal);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(plan.checkpoint(quote.minimumReceive, []).forwardMinimum).toBe(quote.minimumReceive.toString());
  expect(plan.feeReserveBaseUnits).toBe(60n);
  expect(plan.lossReserveUsdMicros).toBe(1_100_060n);
  expect(() => planCanarySwap({ ...planInput, principal: 1_000_000n })).toThrow(/greater-than/);
  expect(() => planCanarySwap({ ...planInput, maxFeeBaseUnits: 59n })).toThrow(/reserve/);
  expect(() => planCanarySwap({ ...planInput, now: start + 300_001 })).toThrow(/valuation/);
});

it('reports an included unpaid order, reconciles its exact original through restart, and quotes only a new slot', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wallet-canary-restart-'));
  const readReport = () =>
    JSON.parse(readFileSync(join(process.env.MAINNET_CANARY_REPORT_DIR!, WALLET_CANARY_REPORT_FILENAME), 'utf8'));
  const clock = jest.spyOn(Date, 'now').mockReturnValue(start + 1000);
  const fetch = fixtureQuotes();
  jest.replaceProperty(process, 'env', {
    ...process.env,
    MAINNET_CANARY_LOCK_HELD: 'true',
    MAINNET_CANARY_SLOT: slotStart,
    MAINNET_CANARY_STATE_DIR: directory,
    MAINNET_CANARY_CHECKPOINT_PATH: join(directory, 'checkpoint.json'),
    MAINNET_CANARY_REPORT_DIR: join(directory, 'first'),
    E2E_WALLET_B_PROFILE: join(directory, 'profile'),
    MAINNET_CANARY_ACCOUNT: account,
    MAINNET_CANARY_OFFER_FAUCET: offer.hex,
    MAINNET_CANARY_REQUEST_FAUCET: request.hex,
    MAINNET_CANARY_DAILY_FEE_BASE_UNITS: '600',
    MAINNET_CANARY_DAILY_LOSS_USD_MICROS: '10000000',
    MAINNET_CANARY_PRINCIPAL_BASE_UNITS: '1100000',
    MAINNET_CANARY_MAX_PRINCIPAL_USD_MICROS: '1200000',
    MAINNET_CANARY_MAX_ORDER_FEE_BASE_UNITS: '80',
    MAINNET_CANARY_MAX_ORDER_LOSS_USD_MICROS: '1200000',
    MAINNET_CANARY_WORKFLOW_ID: '123',
    MAINNET_SWAP_SDK_GATE: join(directory, 'ack'),
    GITHUB_REPOSITORY: '0xMiden/wallet',
    GITHUB_REPOSITORY_ID: '853430876',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: 'a'.repeat(40),
    GITHUB_JOB: 'wallet-canary',
    GITHUB_WORKFLOW_REF: `0xMiden/wallet/${WALLET_CANARY_WORKFLOW_PATH}@refs/heads/main`,
    GITHUB_RUN_ID: planInput.runId,
    GITHUB_RUN_ATTEMPT: '1'
  });
  new MainnetWalletCanaryLedger({
    directory,
    account,
    initialize: true,
    activationSlot: slotStart,
    dailyFeeBaseUnits: 600n,
    dailyLossUsdMicros: 10_000_000n,
    maxPrincipalUsdMicros: 1_200_000n
  }).close();

  const storage: Record<string, unknown> = {};
  const chrome = {
    storage: {
      local: {
        get: async (keys: string[], callback?: (items: Record<string, unknown>) => void) => {
          const items = Object.fromEntries(keys.map(key => [key, storage[key]]));
          callback?.(items);
          return items;
        },
        set: async (items: Record<string, unknown>) => {
          Object.assign(storage, items);
        },
        remove: async (keys: string[]) => {
          for (const key of keys) delete storage[key];
        }
      }
    }
  };
  const globals = { chrome, localStorage: { setItem: jest.fn() } };
  const saved = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.assign(globalThis, globals);
  const locator = { or: () => locator, first: () => locator, waitFor: async () => {}, isVisible: async () => false };
  const wallet = {
    page: {
      getByTestId: () => locator,
      evaluate: async (callback: (arg: unknown) => unknown, arg: unknown) => callback(arg)
    },
    getAccountAddress: async () => account,
    triggerSync: async () => {}
  } as unknown as GuardianAwareWalletPage;
  const submit = jest.fn(
    async (_: GuardianAwareWalletPage, state: MainnetSwapCheckpoint, leg: string, control: CanaryBrowser) => {
      expect(leg).toBe('forward');
      const authority = {
        noteId: '0x' + 'a'.repeat(64),
        sha256: 'b'.repeat(64),
        canonicalSha256: 'c'.repeat(64),
        nonce: '11111111-1111-4111-8111-111111111111',
        orderId: '42',
        minimumReceive: state.forwardMinimum,
        expiresAt: start + 300_000
      };
      state.forwardOrderId = authority.orderId;
      state.forwardRequestAuthority = authority;
      control.beforeRelease(state);
      storage[TEST_SEND_AUTHORIZATION_KEY] = { ...authority, accountId: account, status: 'spent' };
      storage[`${TEST_SEND_AUTHORIZATION_KEY}_required`] = { accountId: account, nonce: authority.nonce };
      control.observe(
        { outcome: 'authorization_released' },
        { key: 'execution', origin: 'wallet_assertion', status: 'passed' }
      );
    }
  );
  const settle = jest.fn(
    async (_: GuardianAwareWalletPage, state: MainnetSwapCheckpoint, leg: string, control: CanaryBrowser) => {
      expect(leg).toBe('forward');
      expect(state.forwardOrderId).toBe('42');
      if (process.env.GITHUB_RUN_ID === state.sourceRunId) {
        control.observe({ outcome: 'included' }, { key: 'inclusion', origin: 'sdk_read', status: 'passed' });
        control.markPaybackTimeout();
        throw new Error('fixture order included, unpaid');
      }
      expect(storage[TEST_SEND_AUTHORIZATION_KEY]).toBeUndefined();
      expect(storage[`${TEST_CONSUME_AUTHORIZATION_KEY}_required`]).toEqual({ status: 'blocked' });
      const claim = {
        noteId: '0x' + 'd'.repeat(64),
        sha256: 'e'.repeat(64),
        canonicalSha256: 'f'.repeat(64),
        requestCanonicalSha256: '0'.repeat(64),
        nonce: '22222222-2222-4222-8222-222222222222',
        expiresAt: Date.now() + 240_000,
        amount: state.principal
      };
      state.forwardClaimAuthority = claim;
      state.paidFees = '1';
      control.save(state);
      control.observe({ outcome: 'fully_filled' }, { key: 'order', origin: 'sdk_read', status: 'passed' });
      control.observe(undefined, { key: 'payback', origin: 'sdk_read', status: 'passed' });
      control.observe({ outcome: 'claimed' }, { key: 'claim', origin: 'sdk_read', status: 'passed' });
      storage[TEST_CONSUME_AUTHORIZATION_KEY] = { ...claim, accountId: account, status: 'spent' };
      storage[`${TEST_CONSUME_AUTHORIZATION_KEY}_required`] = { accountId: account, nonce: claim.nonce };
      return { refunded: 0n, fees: 2n, now: { offer: 8_900_000n, request: 11_100_000n, native: 9_999_998n } };
    }
  );
  const browser = {
    registry: async () => ({
      service: 'https://solver.example',
      tokens: [offer, request, native],
      native,
      baseFee: 1n,
      pairs: [{ faucetIds: [offer.hex, request.hex] }] as never,
      prices: { pricesUpdatedAt: slotStart }
    }),
    evidence: async () => ({ orders: [] }),
    submit,
    settle
  };
  try {
    await expect(runCanary(wallet, 'canary', browser)).rejects.toThrow(/included, unpaid/);
    const first = readReport();
    expect(first.slot.status).toBe('submitted');
    expect(first.observations.map(({ stage }: { stage: string }) => stage)).toEqual(
      expect.arrayContaining(['authorization_released', 'submission', 'inclusion', 'timed_out'])
    );
    expect(first.slot.usableReceiptAt).toBeNull();
    process.env.GITHUB_RUN_ID = '900002';
    process.env.MAINNET_CANARY_REPORT_DIR = join(directory, 'duplicate');
    await runCanary(wallet, 'canary', browser);
    expect(existsSync(process.env.MAINNET_CANARY_REPORT_DIR)).toBe(false);
    expect(submit).toHaveBeenCalledTimes(1);

    clock.mockReturnValue(start + 301_000);
    process.env.MAINNET_CANARY_REPORT_DIR = join(directory, 'recover');
    await runCanary(wallet, 'canary-recover', browser);
    const recovered = readReport();
    expect(recovered.original).toEqual(first.original);
    expect(recovered.source.runId).toBe('900002');
    expect(recovered.slot).toMatchObject({ status: 'usable_receipt', submittedAt: first.slot.submittedAt });
    expect(recovered.observations.map(({ stage }: { stage: string }) => stage)).toEqual(
      expect.arrayContaining(['full_fill', 'payback', 'claim', 'usable_receipt'])
    );
    expect(storage[TEST_CONSUME_AUTHORIZATION_KEY]).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);

    process.env.GITHUB_RUN_ID = '900003';
    process.env.MAINNET_CANARY_SLOT = '2026-11-23T00:05:00Z';
    process.env.MAINNET_CANARY_REPORT_DIR = join(directory, 'refused');
    fetch.mockResolvedValueOnce(Response.json({}, { status: 503 }));
    await expect(runCanary(wallet, 'canary', browser)).rejects.toThrow();
    expect(readReport().slot).toMatchObject({ status: 'blocked', reason: 'quote_unavailable', submittedAt: null });
    expect(submit).toHaveBeenCalledTimes(1);
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

it('commits the exact held request before acknowledgement and never re-admits it after restart', async () => {
  jest.spyOn(Date, 'now').mockReturnValue(start + 1000);
  const directory = mkdtempSync(join(tmpdir(), 'wallet-canary-boundary-'));
  const options = { directory, account, dailyFeeBaseUnits: 600n, dailyLossUsdMicros: 10_000_000n };
  let ledger = new MainnetWalletCanaryLedger({ ...options, initialize: true, activationSlot: slotStart });
  const plan = planCanarySwap(planInput);
  const admission = {
    slotStart,
    runId: planInput.runId,
    runAttempt: '1',
    offerFaucetId: offer.hex,
    requestFaucetId: request.hex,
    principalBaseUnits: planInput.principal,
    principalUsdMicros: plan.principalUsdMicros,
    feeReserveBaseUnits: plan.feeReserveBaseUnits,
    lossReserveUsdMicros: plan.lossReserveUsdMicros
  };
  const intent = plan.checkpoint(1_050_000n, []);
  const handle = {
    kind: 'swap' as const,
    accountId: '0x' + '4'.repeat(30),
    faucetId: offer.hex,
    amount: '1100000',
    requestedFaucetId: request.hex,
    requestedAmount: intent.forwardMinimum,
    expiresAt: start + 300_000,
    nonce: '11111111-1111-4111-8111-111111111111'
  };
  const authority = {
    noteId: '0x' + 'a'.repeat(64),
    sha256: 'b'.repeat(64),
    canonicalSha256: 'c'.repeat(64),
    orderId: '42'
  };
  const checkpointPath = join(directory, 'checkpoint.json');
  const gatePath = join(directory, 'ack');
  let releases = 0;
  const page = {
    evaluate: jest
      .fn()
      .mockResolvedValueOnce({ ...handle, ...authority, status: 'waiting' })
      .mockImplementationOnce(async () => {
        expect(ledger.get(slotStart)?.checkpoint?.forwardRequestAuthority?.noteId).toBe(authority.noteId);
        expect(ledger.get(slotStart)?.status).toBe('unknown');
        expect(existsSync(gatePath)).toBe(true);
        releases++;
      })
  };
  const ack = setInterval(() => {
    if (existsSync(gatePath + '.ready') && !existsSync(gatePath)) {
      writeFileSync(gatePath, readFileSync(gatePath + '.ready'), { mode: 0o600, flag: 'wx' });
    }
  }, 10);
  try {
    expect(ledger.admit(admission).kind).toBe('admitted');
    ledger.saveCheckpoint(slotStart, intent);
    await releaseMainnetSendAuthorization(page, handle, {
      checkpointPath,
      gatePath,
      signal: new AbortController().signal,
      persist: async () => {
        intent.forwardOrderId = authority.orderId;
        intent.forwardRequestAuthority = {
          ...authority,
          minimumReceive: intent.forwardMinimum,
          expiresAt: handle.expiresAt,
          nonce: handle.nonce
        };
        ledger.armSend(slotStart, intent);
        saveMainnetSwapCheckpoint(checkpointPath, intent);
      }
    });
    expect(releases).toBe(1);
    expect(ledger.get(slotStart)?.submittedAt).toBeUndefined();
    ledger.close();
    ledger = new MainnetWalletCanaryLedger(options);
    expect(ledger.admit({ ...admission, runId: '900002' }).kind).toBe('duplicate');
    expect(() => ledger.armSend(slotStart, intent)).toThrow();
    expect(ledger.active()?.checkpoint?.forwardOrderId).toBe('42');
    expect(releases).toBe(1);
  } finally {
    clearInterval(ack);
    ledger.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
