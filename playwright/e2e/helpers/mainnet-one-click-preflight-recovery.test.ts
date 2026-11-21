import type { TestInfo } from '@playwright/test';

type PlaywrightFixtures = {
  walletB: {
    getAccountAddress?: jest.Mock;
    recoverGuardianFromHotKey: jest.Mock;
    triggerSync: jest.Mock;
  };
};

const mockRunId = 'mainnet-one-click-fixture-run';
const mockSavedCheckpoints: Array<Record<string, unknown>> = [];
let mockCheckpoint: Record<string, unknown>;
let mockNativeCheckpoint: Record<string, unknown> | undefined;
let mockRegisteredCallback: unknown;

const mockPlaywrightTest = Object.assign(
  jest.fn((_title: string, callback: (...args: never[]) => unknown) => {
    mockRegisteredCallback = callback;
  }),
  {
    use: jest.fn(),
    setTimeout: jest.fn(),
    describe: { configure: jest.fn() },
    skip: jest.fn(),
    afterEach: jest.fn()
  }
);

const originalEnvironment = new Map<string, string | undefined>();
const environmentKeys = [
  'E2E_NETWORK',
  'E2E_WALLET_REPORT_INVOCATION',
  'E2E_MAINNET_GUARDIAN_KEY_PAIR',
  'E2E_MAINNET_EVM_KEY',
  'MAINNET_ONE_CLICK_MODE',
  'MAINNET_NEAR_MODE',
  'MAINNET_NEAR_FORWARD_ATTEMPTED',
  'MAINNET_LOOP_RECOVERY_CLEARED',
  'GITHUB_RUN_ATTEMPT',
  'GITHUB_RUN_ID'
];

const authorizedCheckpoint = () => ({
  version: 1,
  phase: 'execution-authorized',
  routeId: 'arb:USDC',
  symbol: 'MID',
  principalBaseUnits: '1000000',
  sourceRunId: mockRunId,
  updatedAt: '2026-10-23T10:00:00.000Z'
});

function registerMainnetLoop(restoreGuardian?: jest.Mock): void {
  jest.resetModules();
  mockSavedCheckpoints.length = 0;
  mockRegisteredCallback = undefined;

  jest.doMock('@playwright/test', () => ({ expect: jest.fn() }));
  jest.doMock('../fixtures/two-wallets', () => ({ test: mockPlaywrightTest, expect: jest.fn() }));
  if (restoreGuardian) {
    jest.doMock('./mainnet-loop-wallet', () => ({ restoreMainnetLoopGuardian: restoreGuardian }));
  }
  jest.doMock('./mainnet-one-click-ui', () => ({
    captureMainnetNearIntentsQuote: jest.fn(),
    readMainnetNearIntentsDeposit: jest.fn(),
    selectMainnetNearIntentsDeposit: jest.fn()
  }));
  jest.doMock('../ios/helpers/wc-counterparty', () => ({ WcCounterparty: jest.fn() }));
  jest.doMock('./test-dapp', () => ({ setAutoConsume: jest.fn().mockResolvedValue(undefined) }));
  jest.doMock('./mainnet-one-click-checkpoint', () => ({
    assertMainnetOneClickMayStart: jest.fn(),
    loadMainnetOneClickCheckpoint: jest.fn(() => mockCheckpoint),
    saveMainnetOneClickCheckpoint: jest.fn((_path: string, checkpoint: Record<string, unknown>) => {
      mockSavedCheckpoints.push(checkpoint);
    })
  }));

  jest.doMock('./mainnet-near-checkpoint', () => ({
    ...jest.requireActual<typeof import('./mainnet-near-checkpoint')>('./mainnet-near-checkpoint'),
    loadMainnetNearCheckpoint: jest.fn(() => mockNativeCheckpoint),
    saveMainnetNearCheckpoint: jest.fn((_path: string, checkpoint: Record<string, unknown>) =>
      mockSavedCheckpoints.push(checkpoint)
    )
  }));
  jest.doMock('./mainnet-swap-checkpoint', () => ({
    ...jest.requireActual<typeof import('./mainnet-swap-checkpoint')>('./mainnet-swap-checkpoint'),
    loadMainnetSwapCheckpoint: jest.fn(() => undefined)
  }));
  jest.doMock('./mainnet-epoch-checkpoint', () => ({
    ...jest.requireActual<typeof import('./mainnet-epoch-checkpoint')>('./mainnet-epoch-checkpoint'),
    loadMainnetEpochCheckpoint: jest.fn(() => undefined)
  }));

  jest.isolateModules(() => {
    require('../tests/mainnet/mainnet-1click-loop.spec');
  });
}

async function runRegisteredLoop(
  fixtures: PlaywrightFixtures,
  info?: Pick<TestInfo, 'annotations' | 'timeout'>
): Promise<unknown> {
  if (typeof mockRegisteredCallback !== 'function') throw new Error('The mainnet 1Click callback was not registered');
  return Reflect.apply(mockRegisteredCallback, undefined, [fixtures, info]);
}

describe('mainnet 1Click checkpoint recovery', () => {
  beforeEach(() => {
    originalEnvironment.clear();
    for (const key of environmentKeys) originalEnvironment.set(key, process.env[key]);
    process.env.E2E_NETWORK = 'mainnet';
    process.env.E2E_MAINNET_GUARDIAN_KEY_PAIR = 'fixture-payload';
    process.env.E2E_MAINNET_EVM_KEY = 'fixture-only';
    process.env.MAINNET_ONE_CLICK_MODE = 'execute';
    process.env.GITHUB_RUN_ID = mockRunId;
    delete process.env.MAINNET_NEAR_MODE;
    delete process.env.E2E_WALLET_REPORT_INVOCATION;
    mockNativeCheckpoint = undefined;
    mockCheckpoint = authorizedCheckpoint();
    registerMainnetLoop();
  });

  afterEach(() => {
    for (const [key, value] of originalEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    jest.resetModules();
    jest.dontMock('@playwright/test');
    jest.dontMock('../fixtures/two-wallets');
    jest.dontMock('./mainnet-one-click-ui');
    jest.dontMock('./mainnet-loop-wallet');
    jest.dontMock('../ios/helpers/wc-counterparty');
    jest.dontMock('./test-dapp');
    jest.dontMock('./mainnet-one-click-checkpoint');
    jest.dontMock('./mainnet-near-checkpoint');
    jest.dontMock('./mainnet-swap-checkpoint');
    jest.dontMock('./mainnet-epoch-checkpoint');
  });

  it('refuses native preparation without exact same-run predecessor costs before restoring or spending', async () => {
    process.env.MAINNET_NEAR_MODE = 'prepare';
    process.env.GITHUB_RUN_ID = '100';
    process.env.GITHUB_RUN_ATTEMPT = '1';
    const walletB = { recoverGuardianFromHotKey: jest.fn(), triggerSync: jest.fn() };
    await expect(runRegisteredLoop({ walletB })).rejects.toThrow(/same-run predecessor|mainnet loop cost evidence/i);
    expect(walletB.recoverGuardianFromHotKey).not.toHaveBeenCalled();
    expect(mockSavedCheckpoints).toHaveLength(0);
  });
  it.each(['forward', 'reverse'])(
    'requires the completed all-provider recovery barrier before native %s restoration or funding',
    async mode => {
      process.env.MAINNET_NEAR_MODE = mode;
      process.env.GITHUB_RUN_ID = '100';
      process.env.GITHUB_RUN_ATTEMPT = '1';
      delete process.env.MAINNET_LOOP_RECOVERY_CLEARED;
      mockNativeCheckpoint = {
        sourceRunId: '100',
        authorizationRunId: '100',
        phase: mode === 'forward' ? 'forward-authorized' : 'forward-settled'
      };
      const walletB = { recoverGuardianFromHotKey: jest.fn(), triggerSync: jest.fn() };
      await expect(runRegisteredLoop({ walletB })).rejects.toThrow(/recovery barrier/i);
      expect(walletB.recoverGuardianFromHotKey).not.toHaveBeenCalled();
      expect(mockSavedCheckpoints).toHaveLength(0);
    }
  );
  it('refuses native forward authority from another source run before restoring or confirming a send', async () => {
    process.env.MAINNET_NEAR_MODE = 'forward';
    process.env.GITHUB_RUN_ID = '100';
    process.env.GITHUB_RUN_ATTEMPT = '1';
    mockNativeCheckpoint = { phase: 'forward-authorized', sourceRunId: '99', authorizationRunId: '99' };
    const walletB = { recoverGuardianFromHotKey: jest.fn(), triggerSync: jest.fn() };
    await expect(runRegisteredLoop({ walletB })).rejects.toThrow(/same-run.*forward|forward.*same-run/i);
    expect(walletB.recoverGuardianFromHotKey).not.toHaveBeenCalled();
    expect(mockSavedCheckpoints).toHaveLength(0);
  });
  it('never refreshes an existing original native reverse nonce or quote after an uncertain attempt', async () => {
    process.env.MAINNET_NEAR_MODE = 'reverse';
    process.env.GITHUB_RUN_ID = '100';
    process.env.GITHUB_RUN_ATTEMPT = '1';
    mockNativeCheckpoint = {
      phase: 'forward-settled',
      sourceRunId: '100',
      authorizationRunId: '100',
      evmNonceBefore: 0
    };
    const walletB = { recoverGuardianFromHotKey: jest.fn(), triggerSync: jest.fn() };
    await expect(runRegisteredLoop({ walletB })).rejects.toThrow(
      /original.*reverse.*(used|unresolved)|never.*(refresh|renew)/i
    );
    expect(walletB.recoverGuardianFromHotKey).not.toHaveBeenCalled();
    expect(mockSavedCheckpoints).toHaveLength(0);
  });
  it('closes only a provably read-only original native preflight without renewing its run, budget or actor', async () => {
    process.env.MAINNET_NEAR_MODE = 'recover';
    process.env.GITHUB_RUN_ID = '100';
    process.env.GITHUB_RUN_ATTEMPT = '1';
    process.env.MAINNET_NEAR_FORWARD_ATTEMPTED = 'false';
    mockNativeCheckpoint = {
      phase: 'forward-authorized',
      sourceRunId: '99',
      authorizationRunId: '99',
      account: 'original-actor',
      lossBudgetUsdMicros: '1800000',
      paidMidenFees: '0',
      paidEvmFees: '0'
    };
    const walletB = { recoverGuardianFromHotKey: jest.fn(), triggerSync: jest.fn() };
    await expect(runRegisteredLoop({ walletB })).resolves.toBeUndefined();
    expect(walletB.recoverGuardianFromHotKey).not.toHaveBeenCalled();
    expect(mockSavedCheckpoints).toEqual([
      expect.objectContaining({
        phase: 'unspent',
        sourceRunId: '99',
        authorizationRunId: '99',
        account: 'original-actor',
        lossBudgetUsdMicros: '1800000'
      })
    ]);
  });
  it('reports read-only recovery with no inferred network when checkpoint telemetry is absent', async () => {
    process.env.MAINNET_NEAR_MODE = 'recover';
    process.env.E2E_WALLET_REPORT_INVOCATION = 'near-recover';
    process.env.GITHUB_RUN_ID = '100';
    process.env.GITHUB_RUN_ATTEMPT = '1';
    process.env.MAINNET_NEAR_FORWARD_ATTEMPTED = 'false';
    mockNativeCheckpoint = {
      phase: 'forward-authorized',
      sourceRunId: '99',
      authorizationRunId: '99',
      account: 'test_only_original_guardian',
      paidMidenFees: '0',
      paidEvmFees: '0'
    };
    const info: Pick<TestInfo, 'annotations' | 'timeout'> = { annotations: [], timeout: 30_000 };
    const walletB = { recoverGuardianFromHotKey: jest.fn(), triggerSync: jest.fn() };
    await expect(runRegisteredLoop({ walletB }, info)).resolves.toBeUndefined();

    expect(walletB.recoverGuardianFromHotKey).not.toHaveBeenCalled();
    expect(mockSavedCheckpoints[0]).toMatchObject({ phase: 'unspent', sourceRunId: '99' });
    expect(info.annotations).toHaveLength(1);
    const description = info.annotations[0]?.description ?? '';
    expect(JSON.parse(description)).toMatchObject({
      operation: {
        key: 'near-recovery',
        provider: 'NEAR',
        sourceRunId: { value: '99', reason: null },
        sourceNetwork: null,
        destinationNetwork: null,
        recoveryEffect: 'read_only',
        outcome: 'unknown',
        stages: [{ key: 'cleanup', status: 'passed' }]
      }
    });
    expect(description).not.toContain('test_only_original_guardian');
  });

  it.each([false, true])('blocks a mismatched original NEAR account with reporting enabled %s', async reporting => {
    process.env.MAINNET_NEAR_MODE = 'recover';
    process.env.GITHUB_RUN_ID = '100';
    process.env.GITHUB_RUN_ATTEMPT = '1';
    if (reporting) process.env.E2E_WALLET_REPORT_INVOCATION = 'near-recover';
    mockNativeCheckpoint = {
      phase: 'forward-authorized',
      sourceRunId: '99',
      account: 'test_only_original_guardian',
      forwardQuote: {},
      sendAuthority: {}
    };
    const restoreGuardian = jest.fn().mockResolvedValue(undefined);
    registerMainnetLoop(restoreGuardian);
    const info: Pick<TestInfo, 'annotations' | 'timeout'> = { annotations: [], timeout: 30_000 };
    const walletB = {
      getAccountAddress: jest.fn().mockResolvedValue('test_only_restored_guardian'),
      recoverGuardianFromHotKey: jest.fn(),
      triggerSync: jest.fn()
    };
    await expect(runRegisteredLoop({ walletB }, info)).rejects.toThrow(
      'Original native NEAR recovery Guardian changed'
    );

    expect(restoreGuardian).toHaveBeenCalledTimes(1);
    expect(walletB.getAccountAddress).toHaveBeenCalledTimes(1);
    expect(mockSavedCheckpoints).toHaveLength(0);
    expect(info.annotations).toHaveLength(reporting ? 1 : 0);
    if (!reporting) return;
    const description = info.annotations[0]?.description ?? '';
    expect(JSON.parse(description)).toMatchObject({
      operation: {
        key: 'near-recovery',
        provider: 'NEAR',
        outcome: 'unknown',
        stages: [
          {
            key: 'recovery_gate',
            status: 'failed',
            endpoint: null,
            error: {
              code: 'recovery_checkpoint_account_mismatch',
              explanation: 'The recovery checkpoint did not match the wallet account.'
            }
          }
        ]
      }
    });
    expect(description).not.toMatch(/test_only_(original|restored)_guardian/);
  });
  it('never calls a missing native send fingerprint unspent when the original forward stage was attempted', async () => {
    process.env.MAINNET_NEAR_MODE = 'recover';
    process.env.GITHUB_RUN_ID = '100';
    process.env.GITHUB_RUN_ATTEMPT = '1';
    process.env.MAINNET_NEAR_FORWARD_ATTEMPTED = 'true';
    mockNativeCheckpoint = { phase: 'forward-authorized', sourceRunId: '99', paidMidenFees: '0', paidEvmFees: '0' };
    const walletB = { recoverGuardianFromHotKey: jest.fn(), triggerSync: jest.fn() };
    await expect(runRegisteredLoop({ walletB })).rejects.toThrow();
    expect(walletB.recoverGuardianFromHotKey).not.toHaveBeenCalled();
    expect(mockSavedCheckpoints).toHaveLength(0);
  });
  it('blocks an unknown original native claim outcome before restoration, funding or renewed authority', async () => {
    process.env.MAINNET_NEAR_MODE = 'recover';
    process.env.GITHUB_RUN_ID = '100';
    process.env.GITHUB_RUN_ATTEMPT = '1';
    mockNativeCheckpoint = { phase: 'recovery-required', consumeAuthority: { nonce: 'original' } };
    const walletB = { recoverGuardianFromHotKey: jest.fn(), triggerSync: jest.fn() };
    await expect(runRegisteredLoop({ walletB })).rejects.toThrow(
      /original.*claim.*(unknown|unresolved)|unknown.*claim/i
    );
    expect(walletB.recoverGuardianFromHotKey).not.toHaveBeenCalled();
    expect(mockSavedCheckpoints).toHaveLength(0);
  });
  it.each([
    {},
    { sourceRunId: 'different-fixture-run' },
    { phase: 'preflight' },
    { phase: 'forward-submitted', forwardTransactionId: 'fixture-miden-transaction' }
  ])('keeps legacy v1 execution read-only without restoring, rewriting or pretending it is v2: %j', async patch => {
    mockCheckpoint = { ...authorizedCheckpoint(), ...patch };
    const original = JSON.stringify(mockCheckpoint);
    registerMainnetLoop();
    const walletB = {
      recoverGuardianFromHotKey: jest.fn().mockRejectedValue(new Error('fixture recovery must never run')),
      triggerSync: jest.fn()
    };
    await expect(runRegisteredLoop({ walletB })).rejects.toThrow(/legacy.*read.only/i);
    expect(walletB.recoverGuardianFromHotKey).not.toHaveBeenCalled();
    expect(walletB.triggerSync).not.toHaveBeenCalled();
    expect(mockSavedCheckpoints).toHaveLength(0);
    expect(JSON.stringify(mockCheckpoint)).toBe(original);
  });
});
