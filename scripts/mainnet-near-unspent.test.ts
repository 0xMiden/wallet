/** @jest-environment node */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OneClickStatusResponse } from '../src/lib/one-click/types';
import type { MainnetNearCheckpoint } from '../playwright/e2e/helpers/mainnet-near-checkpoint';
import { hashOneClickQuote } from '../src/lib/one-click/signature';
import { nativeNearFixture, nativeNearQuote } from './helpers/mainnet-near-fixture';

const mockState = jest.fn<MainnetNearCheckpoint, []>();
const mockSave = jest.fn();
const mockRestore = jest.fn();
const mockVault = jest.fn();
const mockStatus = jest.fn<Promise<OneClickStatusResponse>, []>();
const mockWrite = jest.fn();
const mockGrant = jest.fn();
const mockSubmit = jest.fn();
const mockQueueBlocker = jest.fn();
const mockOutputCandidates = jest.fn();
const mockClient = {
  getChainId: jest.fn(),
  getBalance: jest.fn(),
  readContract: jest.fn(),
  getTransactionCount: jest.fn()
};
jest.mock('@playwright/test', () => ({ expect }));
jest.mock('../playwright/e2e/fixtures/two-wallets', () => ({}));
jest.mock('node:fs', () => ({
  ...jest.requireActual('node:fs'),
  writeFileSync: (...args: unknown[]) => mockWrite(...args)
}));
jest.mock('viem', () => ({ ...jest.requireActual('viem'), createPublicClient: () => mockClient }));
jest.mock('../playwright/e2e/helpers/mainnet-near-checkpoint', () => ({
  ...jest.requireActual('../playwright/e2e/helpers/mainnet-near-checkpoint'),
  loadMainnetNearCheckpoint: () => mockState(),
  saveMainnetNearCheckpoint: (...args: unknown[]) => mockSave(...args)
}));
jest.mock('../playwright/e2e/helpers/mainnet-loop-wallet', () => ({
  restoreMainnetLoopGuardian: (...args: unknown[]) => mockRestore(...args)
}));
jest.mock('../playwright/e2e/helpers/balance-truth', () => ({
  vaultBalanceByFaucetId: (...args: unknown[]) => mockVault(...args)
}));
jest.mock('../src/lib/one-click/client', () => ({
  ...jest.requireActual('../src/lib/one-click/client'),
  fetchOneClickStatus: (...args: unknown[]) => mockStatus(...args),
  submitOneClickDeposit: (...args: unknown[]) => mockSubmit(...args)
}));
jest.mock('../playwright/e2e/helpers/mainnet-send-authorization', () => ({
  armMainnetSendAuthorization: (...args: unknown[]) => mockGrant(...args)
}));
jest.mock('../playwright/e2e/helpers/mainnet-consume-authorization', () => ({}));
jest.mock('../playwright/e2e/helpers/mainnet-one-click-ui', () => ({}));
jest.mock('../playwright/e2e/helpers/mainnet-miden-request', () => ({}));
jest.mock('../playwright/e2e/helpers/history', () => ({
  plantQueueBlocker: (...args: unknown[]) => mockQueueBlocker(...args)
}));
jest.mock('../playwright/e2e/helpers/mainnet-miden-indexer', () => ({
  readMainnetMidenOutputCandidates: (...args: unknown[]) => mockOutputCandidates(...args)
}));
jest.mock('../playwright/e2e/helpers/swap', () => ({}));
jest.mock('../playwright/e2e/ios/helpers/wc-counterparty', () => ({}));
import {
  claimMainnetNearNote,
  recordNearStageCause,
  runMainnetNearStage
} from '../playwright/e2e/helpers/mainnet-near-runtime';

const env = { ...process.env };
const wallet = { getAccountAddress: jest.fn(), extensionId: 'a'.repeat(32), page: {} };
const recover = () => Reflect.apply(runMainnetNearStage, undefined, [wallet, 'recover']);
function fixture() {
  const state = nativeNearFixture();
  state.sourceRunId = state.authorizationRunId = '43811169447';
  const quote = nativeNearQuote('mm1apeg8ae87qy4n52a2myu6kpk8c3y4mav', state.principal);
  const status: OneClickStatusResponse = {
    status: 'PENDING_DEPOSIT',
    correlationId: quote.correlationId,
    updatedAt: state.createdAt,
    swapDetails: { intentHashes: [], nearTxHashes: [], originChainTxHashes: [], destinationChainTxHashes: [] },
    quoteResponse: {
      timestamp: state.createdAt,
      signature: 'previously-validated-boundary',
      correlationId: quote.correlationId,
      quoteRequest: {
        dry: false,
        swapType: 'EXACT_INPUT',
        slippageTolerance: 100,
        originAsset: state.nativeAssetId,
        destinationAsset: state.evmAssetId,
        amount: state.principal,
        refundTo: state.account,
        refundType: 'ORIGIN_CHAIN',
        recipient: state.evm.account,
        recipientType: 'DESTINATION_CHAIN',
        depositType: 'ORIGIN_CHAIN',
        deadline: quote.deadline
      },
      quote: {
        depositAddress: quote.depositAddress,
        deadline: quote.deadline,
        amountIn: state.principal,
        amountInFormatted: '1.01',
        amountInUsd: '1.01',
        minAmountIn: state.principal,
        amountOut: '1000000',
        amountOutFormatted: '1',
        amountOutUsd: '1',
        minAmountOut: quote.minimumOutput,
        refundFee: quote.refundFee,
        timeEstimate: 30
      }
    }
  };
  state.forwardQuote = { ...quote, quoteHash: hashOneClickQuote(status.quoteResponse) };
  return { state, status };
}
it('does not block the transaction queue before discovering the exact NEAR claim note', async () => {
  jest.clearAllMocks();
  const { state } = fixture();
  mockQueueBlocker.mockResolvedValue('blocker');
  mockOutputCandidates.mockResolvedValue({ noteIds: [] });
  const syncFailed = new Error('note discovery did not complete');
  const scopedWallet = {
    ...wallet,
    getAccountAddress: async () => state.account,
    triggerSync: async () => {
      throw syncFailed;
    }
  };
  await expect(
    Reflect.apply(claimMainnetNearNote, undefined, [
      scopedWallet,
      state,
      `0x${'a'.repeat(64)}`,
      'refund',
      'test-gate',
      new AbortController().signal
    ])
  ).rejects.toBe(syncFailed);
  expect(mockOutputCandidates).toHaveBeenCalledTimes(1);
  expect(mockQueueBlocker).not.toHaveBeenCalled();
  expect(mockSave).not.toHaveBeenCalled();
});

it('fails closed before restoring or persisting when an explicit NEAR replacement lacks provenance', async () => {
  jest.clearAllMocks();
  try {
    Object.assign(process.env, {
      E2E_NETWORK: 'mainnet',
      GITHUB_RUN_ID: '44930000000',
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF: 'refs/heads/main',
      MAINNET_NEAR_REPLACEMENT_APPROVED: 'true',
      MAINNET_NEAR_REPLACEMENT_PROVENANCE: 'false'
    });
    mockState.mockReturnValue(fixture().state);
    await expect(recover()).rejects.toThrow('NEAR replacement requires verified original authority');
    expect(mockRestore).not.toHaveBeenCalled();
    expect(mockSave).not.toHaveBeenCalled();
    expect(mockSubmit).not.toHaveBeenCalled();
  } finally {
    process.env = { ...env };
  }
});
describe.each([
  ['43811169447', 84],
  ['43999834254', 84],
  ['44970377919', 85],
  ['45055827591', 87]
])('audited unsigned NEAR source %s', (sourceRunId, expectedNonce) => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(new Date('2026-11-17T03:00:00Z'));
    process.env.E2E_NETWORK = 'mainnet';
    process.env.GITHUB_RUN_ID = '43930000000';
    process.env.GITHUB_RUN_ATTEMPT = '1';
    process.env.MAINNET_NEAR_FORWARD_ATTEMPTED = 'true';
    process.env.MAINNET_NEAR_PREAUTH_UNSPENT = 'true';
    process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR = 'existing-original-secret';
    const { state, status } = fixture();
    state.sourceRunId = state.authorizationRunId = sourceRunId;
    mockState.mockReturnValue(state);
    mockStatus.mockResolvedValue(status);
    jest.mocked(wallet.getAccountAddress).mockResolvedValue(state.account);
    mockVault.mockResolvedValue(BigInt(state.native.balance));
    mockClient.getChainId.mockResolvedValue(state.evm.chainId);
    mockClient.getBalance.mockResolvedValue(BigInt(state.evm.nativeBalance));
    mockClient.readContract.mockResolvedValue(BigInt(state.evm.tokenBalance));
    mockClient.getTransactionCount.mockResolvedValue(expectedNonce);
  });
  afterEach(() => {
    process.env = { ...env };
    jest.useRealTimers();
  });
  function noFunding() {
    expect(mockGrant).not.toHaveBeenCalled();
    expect(mockSubmit).not.toHaveBeenCalled();
  }
  it('reconciles the known expired unsigned quote after live checks, retains every authority field and forces recovery-only', async () => {
    const state = mockState();
    const original = structuredClone(state);
    await expect(recover()).resolves.toBeUndefined();
    expect(mockRestore).toHaveBeenCalledTimes(1);
    expect(mockStatus).toHaveBeenCalledTimes(1);
    expect(mockSave).toHaveBeenCalledWith(expect.any(String), {
      ...original,
      phase: 'unspent',
      updatedAt: new Date().toISOString()
    });
    expect(mockWrite).toHaveBeenCalledWith(
      'test-results/mainnet-near-recovery.json',
      expect.stringContaining('"recoveryOnly":true')
    );
    noFunding();
  });
  it('passes the canonical hex faucet required by the real 1Click client configuration boundary', async () => {
    await expect(recover()).resolves.toBeUndefined();
    expect(mockStatus).toHaveBeenCalledWith(
      {
        serviceUrl: mockState().serviceUrl,
        chains: [],
        midenAssets: [
          { id: 'usdcx', assetId: mockState().nativeAssetId, faucetId: mockState().native.hex, decimals: 6 }
        ]
      },
      expect.any(String),
      undefined,
      undefined,
      expect.any(Function)
    );
  });
  it('binds original signed terms rather than unsigned per-request correlation metadata', async () => {
    const status = await mockStatus();
    status.quoteResponse.correlationId = 'new-status-request-trace';
    mockStatus.mockClear();
    await expect(recover()).resolves.toBeUndefined();
    expect(mockSave).toHaveBeenCalledTimes(1);
    noFunding();
  });
  it.each(['false', '', undefined])(
    'does not infer an unspent state without exact official provenance: %s',
    async verified => {
      if (verified === undefined) delete process.env.MAINNET_NEAR_PREAUTH_UNSPENT;
      else process.env.MAINNET_NEAR_PREAUTH_UNSPENT = verified;
      await expect(recover()).rejects.toThrow();
      expect(mockSave).not.toHaveBeenCalled();
      noFunding();
    }
  );
  it.each([
    'native',
    'token',
    'gas',
    'pending-nonce',
    'chain',
    'guardian',
    'provider',
    'quote',
    'deposit-reference',
    'deposited',
    'live-quote',
    'live-price',
    'wrong-source',
    'fees',
    'send-authority',
    'forward-tx',
    'return-note',
    'consume-authority'
  ])('retains the original checkpoint on changed or unknown %s', async changed => {
    const state = mockState();
    const status = await mockStatus();
    if (changed === 'native') mockVault.mockResolvedValue(1n);
    if (changed === 'token') mockClient.readContract.mockResolvedValue(1n);
    if (changed === 'gas') mockClient.getBalance.mockResolvedValue(1n);
    if (changed === 'pending-nonce')
      mockClient.getTransactionCount.mockResolvedValueOnce(expectedNonce).mockResolvedValueOnce(expectedNonce + 1);
    if (changed === 'chain') mockClient.getChainId.mockResolvedValue(1);
    if (changed === 'guardian') jest.mocked(wallet.getAccountAddress).mockResolvedValue('different');
    if (changed === 'provider') status.status = 'PROCESSING';
    if (changed === 'quote') status.quoteResponse.quote.amountOut = '999999';
    if (changed === 'deposit-reference') status.quoteResponse.quote.depositAddress = 'different';
    if (changed === 'deposited') status.swapDetails.depositedAmount = '1';
    if (changed === 'live-quote') state.forwardQuote!.deadline = new Date(Date.now() + 60_000).toISOString();
    if (changed === 'live-price') state.pricedAt = new Date().toISOString();
    if (changed === 'wrong-source') state.sourceRunId = '43811169448';
    if (changed === 'fees') state.paidMidenFees = '1';
    if (changed === 'send-authority') Reflect.set(state, 'sendAuthority', { noteId: `0x${'1'.repeat(64)}` });
    if (changed === 'forward-tx') state.forwardMidenTxId = `0x${'1'.repeat(64)}`;
    if (changed === 'return-note') state.returnNoteId = `0x${'1'.repeat(64)}`;
    if (changed === 'consume-authority') Reflect.set(state, 'consumeAuthority', { nonce: 'retained' });
    mockStatus.mockClear();
    const original = JSON.stringify(state);
    await expect(recover()).rejects.toThrow();
    expect(JSON.stringify(state)).toBe(original);
    expect(mockSave).not.toHaveBeenCalled();
    noFunding();
  });
});
describe('native NEAR recovery reporting', () => {
  const info = () => ({ annotations: [] as { type: string; description?: string }[], timeout: 30_000 });
  const reported = (value: ReturnType<typeof info>) =>
    value.annotations.map(row => JSON.parse(row.description ?? '{}').operation as { recoveryEffect: string });
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.E2E_NETWORK = 'mainnet';
    process.env.GITHUB_RUN_ID = '43930000000';
    process.env.GITHUB_RUN_ATTEMPT = '1';
    process.env.MAINNET_NEAR_FORWARD_ATTEMPTED = 'true';
    process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR = 'existing-original-secret';
    process.env.E2E_WALLET_REPORT_INVOCATION = 'near-recover';
    delete process.env.MAINNET_NEAR_PREAUTH_UNSPENT;
    const { state } = fixture();
    state.phase = 'recovery-required';
    Reflect.set(state, 'sendAuthority', { noteId: `0x${'1'.repeat(64)}` });
    mockState.mockReturnValue(state);
    jest.mocked(wallet.getAccountAddress).mockResolvedValue(state.account);
  });
  afterEach(() => {
    process.env = { ...env };
  });
  const run = (value: ReturnType<typeof info>, recoverNear: jest.Mock) =>
    Reflect.apply(runMainnetNearStage, undefined, [wallet, 'recover', value, recoverNear]);
  it.each([
    ['cancelled', 'refunded'],
    ['complete', 'bridge_completion_asserted']
  ])('reports a settled %s recovery as a prior-authorized return', async (phase, outcome) => {
    const value = info();
    const recoverNear = jest.fn(async () => {
      mockState().phase = phase as MainnetNearCheckpoint['phase'];
    });
    await expect(run(value, recoverNear)).resolves.toBeUndefined();
    expect(recoverNear).toHaveBeenCalledTimes(1);
    expect(reported(value)).toMatchObject([{ recoveryEffect: 'prior_authorized_return', outcome }]);
  });
  it('reports no work for a terminal checkpoint without calling recovery', async () => {
    mockState().phase = 'complete';
    const value = info();
    const recoverNear = jest.fn();
    await expect(run(value, recoverNear)).resolves.toBeUndefined();
    expect(recoverNear).not.toHaveBeenCalled();
    expect(reported(value)).toMatchObject([{ recoveryEffect: 'no_work' }]);
  });
  it('reports nothing when recovery fails', async () => {
    const value = info();
    const recoverNear = jest.fn().mockRejectedValue(new Error('unresolved'));
    await expect(run(value, recoverNear)).rejects.toThrow('Original native NEAR recovery blocked');
    expect(reported(value)).toEqual([]);
  });
});

describe('native NEAR stage failure cause', () => {
  const info = () => ({ annotations: [] as { type: string; description?: string }[], timeout: 30_000 });
  const written = () =>
    mockWrite.mock.calls.filter(([path]) => path === 'test-results/mainnet-near-forward-stage.json');
  beforeEach(() => {
    process.env.E2E_NETWORK = 'mainnet';
    process.env.GITHUB_RUN_ID = '43930000000';
    process.env.GITHUB_RUN_ATTEMPT = '1';
    process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR = 'existing-original-secret';
    process.env.E2E_WALLET_REPORT_INVOCATION = 'near-recover';
    process.env.MAINNET_NEAR_FORWARD_ATTEMPTED = 'true';
    mockWrite.mockClear();
    const { state } = fixture();
    state.phase = 'recovery-required';
    Reflect.set(state, 'sendAuthority', { noteId: `0x${'1'.repeat(64)}` });
    mockState.mockReturnValue(state);
    jest.mocked(wallet.getAccountAddress).mockResolvedValue(state.account);
  });
  afterEach(() => {
    process.env = { ...env };
  });
  it('keeps a sanitized bounded cause while the thrown error stays generic', async () => {
    const secret = 'topsecretvalue-123456';
    process.env.E2E_MAINNET_EVM_KEY = secret;
    const recoverNear = jest
      .fn()
      .mockRejectedValue(new TypeError(`boom ${secret} 0x${'ab'.repeat(32)} token=abc ${'x'.repeat(900)}`));
    const failure = Reflect.apply(runMainnetNearStage, undefined, [wallet, 'recover', info(), recoverNear]);
    await expect(failure).rejects.toThrow(
      'Original native NEAR recovery blocked; retain its original public checkpoint, never renew uncertain authority'
    );
    const [, body] = written().at(-1) ?? [];
    const cause = JSON.parse(String(body)).cause as string;
    expect(cause).toContain('TypeError: boom');
    expect(cause).not.toContain(secret);
    expect(cause).not.toContain('ab'.repeat(32));
    expect(cause).not.toContain('abc');
    expect(cause.length).toBeLessThanOrEqual(300);
  });
  const stored = () => JSON.parse(String(written().at(-1)?.[1])).cause as string;
  it('records the real cause of a wrapped error instead of its generic wrapper', () => {
    const wrapper = new Error('Native NEAR return blocked; never retry', { cause: new Error('nonce too low') });
    recordNearStageCause(wrapper);
    expect(stored()).toContain('nonce too low');
    expect(stored()).not.toContain('never retry');
  });
  it('keeps only the first line of the message and the other stage-file fields', () => {
    const read = jest.spyOn(jest.requireMock('node:fs'), 'readFileSync').mockReturnValue('{"stage":"arm","other":1}');
    try {
      recordNearStageCause(new Error('rejected\nCall log:\n  - sk-live-leaky'));
    } finally {
      read.mockRestore();
    }
    const body = JSON.parse(String(written().at(-1)?.[1]));
    expect(body).toMatchObject({ stage: 'arm', other: 1, cause: 'Error: rejected' });
  });
  it('still logs the cause when the stage file cannot be written', () => {
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockWrite.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    try {
      expect(() => recordNearStageCause(new Error('real cause'))).not.toThrow();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('real cause'));
    } finally {
      log.mockRestore();
    }
  });
  it('lets the generic error propagate when the rejection cannot be stringified', async () => {
    const hostile = {
      toString() {
        throw new Error('hostile');
      }
    };
    const recoverNear = jest.fn().mockRejectedValue(hostile);
    await expect(
      Reflect.apply(runMainnetNearStage, undefined, [wallet, 'recover', info(), recoverNear])
    ).rejects.toThrow('Original native NEAR recovery blocked');
  });
  it('wraps the blocked return error around the rejected transfer so its cause is not lost', () => {
    const source = readFileSync(resolve(__dirname, '../playwright/e2e/helpers/mainnet-near-runtime.ts'), 'utf8');
    expect(source).toMatch(/never retry'\s*,\s*\{ cause: error \}\s*\)/);
  });
});

describe('quoteless NEAR preflight stop gate', () => {
  const expectedNonce = 90;
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(new Date('2026-11-25T06:00:00Z'));
    Object.assign(process.env, {
      E2E_NETWORK: 'mainnet',
      GITHUB_RUN_ID: '45400000000',
      GITHUB_RUN_ATTEMPT: '1',
      MAINNET_NEAR_FORWARD_ATTEMPTED: 'true',
      MAINNET_NEAR_PREAUTH_UNSPENT: 'true',
      E2E_MAINNET_GUARDIAN_KEY_PAIR: 'existing-original-secret'
    });
    const { state } = fixture();
    state.sourceRunId = state.authorizationRunId = '45334301017';
    delete state.forwardQuote;
    mockState.mockReturnValue(state);
    jest.mocked(wallet.getAccountAddress).mockResolvedValue(state.account);
    mockVault.mockResolvedValue(BigInt(state.native.balance));
    mockClient.getChainId.mockResolvedValue(state.evm.chainId);
    mockClient.getBalance.mockResolvedValue(BigInt(state.evm.nativeBalance));
    mockClient.readContract.mockResolvedValue(BigInt(state.evm.tokenBalance));
    mockClient.getTransactionCount.mockResolvedValue(expectedNonce);
  });
  afterEach(() => {
    process.env = { ...env };
    jest.useRealTimers();
  });
  it('accepts the audited run without a quote and marks it unspent without any provider call', async () => {
    await expect(recover()).resolves.toBeUndefined();
    expect(mockSave).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ phase: 'unspent' }));
    expect(mockStatus).not.toHaveBeenCalled();
    expect(mockSubmit).not.toHaveBeenCalled();
  });
  it.each([
    [
      'another run id',
      (state: MainnetNearCheckpoint) => (state.sourceRunId = state.authorizationRunId = '45055827591')
    ],
    [
      'a send authority',
      (state: MainnetNearCheckpoint) => Reflect.set(state, 'sendAuthority', { noteId: `0x${'1'.repeat(64)}` })
    ],
    ['a changed nonce', () => mockClient.getTransactionCount.mockResolvedValue(expectedNonce + 1)]
  ])('rejects a quoteless checkpoint with %s', async (_name, change) => {
    change(mockState());
    await expect(recover()).rejects.toThrow();
    expect(mockSave).not.toHaveBeenCalled();
    expect(mockGrant).not.toHaveBeenCalled();
  });
});
