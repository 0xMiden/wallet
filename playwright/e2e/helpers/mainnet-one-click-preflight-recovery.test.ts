type PlaywrightFixtures = {
  walletB: {
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
  'E2E_MAINNET_GUARDIAN_KEY_PAIR',
  'E2E_MAINNET_EVM_KEY',
  'MAINNET_ONE_CLICK_MODE',
  'MAINNET_NEAR_MODE',
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

function registerMainnetLoop(): void {
  jest.resetModules();
  mockSavedCheckpoints.length = 0;
  mockRegisteredCallback = undefined;

  jest.doMock('@playwright/test', () => ({ expect: jest.fn() }));
  jest.doMock('../fixtures/two-wallets', () => ({ test: mockPlaywrightTest, expect: jest.fn() }));
  jest.doMock('./mainnet-one-click-ui', () => ({
    confirmMainnetOneClickReview: jest.fn(),
    selectMainnetOneClickAssets: jest.fn()
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
    saveMainnetNearCheckpoint: jest.fn((_path: string, checkpoint: Record<string, unknown>) => mockSavedCheckpoints.push(checkpoint))
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

async function runRegisteredLoop(fixtures: PlaywrightFixtures): Promise<unknown> {
  if (typeof mockRegisteredCallback !== 'function') throw new Error('The mainnet 1Click callback was not registered');
  return Reflect.apply(mockRegisteredCallback, undefined, [fixtures]);
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
    delete process.env.MAINNET_NEAR_MODE; mockNativeCheckpoint = undefined;
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
    jest.dontMock('../ios/helpers/wc-counterparty');
    jest.dontMock('./test-dapp');
    jest.dontMock('./mainnet-one-click-checkpoint');
    jest.dontMock('./mainnet-near-checkpoint');
    jest.dontMock('./mainnet-swap-checkpoint');
    jest.dontMock('./mainnet-epoch-checkpoint');
  });

  it('refuses native preparation without exact same-run predecessor costs before restoring or spending', async () => {
    process.env.MAINNET_NEAR_MODE = 'prepare'; process.env.GITHUB_RUN_ID = '100'; process.env.GITHUB_RUN_ATTEMPT = '1';
    const walletB = { recoverGuardianFromHotKey: jest.fn(), triggerSync: jest.fn() };
    await expect(runRegisteredLoop({ walletB })).rejects.toThrow(/same-run predecessor|mainnet loop cost evidence/i);
    expect(walletB.recoverGuardianFromHotKey).not.toHaveBeenCalled(); expect(mockSavedCheckpoints).toHaveLength(0);
  });
  it('refuses native forward authority from another source run before restoring or confirming a send', async () => {
    process.env.MAINNET_NEAR_MODE = 'forward'; process.env.GITHUB_RUN_ID = '100'; process.env.GITHUB_RUN_ATTEMPT = '1';
    mockNativeCheckpoint = { phase: 'forward-authorized', sourceRunId: '99', authorizationRunId: '99' };
    const walletB = { recoverGuardianFromHotKey: jest.fn(), triggerSync: jest.fn() };
    await expect(runRegisteredLoop({ walletB })).rejects.toThrow(/same-run.*forward|forward.*same-run/i);
    expect(walletB.recoverGuardianFromHotKey).not.toHaveBeenCalled(); expect(mockSavedCheckpoints).toHaveLength(0);
  });
  it('never refreshes an existing original native reverse nonce or quote after an uncertain attempt', async () => {
    process.env.MAINNET_NEAR_MODE = 'reverse'; process.env.GITHUB_RUN_ID = '100'; process.env.GITHUB_RUN_ATTEMPT = '1';
    mockNativeCheckpoint = { phase: 'forward-settled', sourceRunId: '100', authorizationRunId: '100', evmNonceBefore: 0 };
    const walletB = { recoverGuardianFromHotKey: jest.fn(), triggerSync: jest.fn() };
    await expect(runRegisteredLoop({ walletB })).rejects.toThrow(/original.*reverse.*(used|unresolved)|never.*(refresh|renew)/i);
    expect(walletB.recoverGuardianFromHotKey).not.toHaveBeenCalled(); expect(mockSavedCheckpoints).toHaveLength(0);
  });
  it('blocks an unknown original native claim outcome before restoration, funding or renewed authority', async () => {
    process.env.MAINNET_NEAR_MODE = 'recover'; process.env.GITHUB_RUN_ID = '100'; process.env.GITHUB_RUN_ATTEMPT = '1';
    mockNativeCheckpoint = { phase: 'recovery-required', consumeAuthority: { nonce: 'original' } };
    const walletB = { recoverGuardianFromHotKey: jest.fn(), triggerSync: jest.fn() };
    await expect(runRegisteredLoop({ walletB })).rejects.toThrow(/original.*claim.*(unknown|unresolved)|unknown.*claim/i);
    expect(walletB.recoverGuardianFromHotKey).not.toHaveBeenCalled(); expect(mockSavedCheckpoints).toHaveLength(0);
  });
  it('returns an execution checkpoint to preflight when guardian recovery fails before submission', async () => {
    const recoveryError = new Error('fixture guardian recovery failed');
    const walletB = {
      recoverGuardianFromHotKey: jest.fn().mockRejectedValue(recoveryError),
      triggerSync: jest.fn()
    };

    await expect(runRegisteredLoop({ walletB })).rejects.toBe(recoveryError);

    expect(walletB.recoverGuardianFromHotKey).toHaveBeenCalledWith('fixture-payload');
    expect(walletB.triggerSync).not.toHaveBeenCalled();
    expect(mockSavedCheckpoints.at(-1)).toMatchObject({
      phase: 'preflight',
      sourceRunId: mockRunId,
      routeId: 'arb:USDC',
      principalBaseUnits: '1000000'
    });
  });

  it('rejects an execution checkpoint from another run without consuming it', async () => {
    mockCheckpoint = { ...authorizedCheckpoint(), sourceRunId: 'different-fixture-run' };
    registerMainnetLoop();
    const walletB = {
      recoverGuardianFromHotKey: jest.fn(),
      triggerSync: jest.fn()
    };

    await expect(runRegisteredLoop({ walletB })).rejects.toThrow('same-run execution marker is required');

    expect(walletB.recoverGuardianFromHotKey).not.toHaveBeenCalled();
    expect(mockSavedCheckpoints).toHaveLength(0);
  });

  it('rejects an execution attempt without authorization and leaves the checkpoint unchanged', async () => {
    mockCheckpoint = { ...authorizedCheckpoint(), phase: 'preflight' };
    registerMainnetLoop();
    const walletB = {
      recoverGuardianFromHotKey: jest.fn(),
      triggerSync: jest.fn()
    };

    await expect(runRegisteredLoop({ walletB })).rejects.toThrow('same-run execution marker is required');

    expect(walletB.recoverGuardianFromHotKey).not.toHaveBeenCalled();
    expect(mockSavedCheckpoints).toHaveLength(0);
  });

  it('keeps a submitted transaction checkpoint unchanged for recovery review', async () => {
    mockCheckpoint = {
      ...authorizedCheckpoint(),
      phase: 'forward-submitted',
      forwardTransactionId: 'fixture-miden-transaction'
    };
    registerMainnetLoop();
    const walletB = {
      recoverGuardianFromHotKey: jest.fn(),
      triggerSync: jest.fn()
    };

    await expect(runRegisteredLoop({ walletB })).rejects.toThrow('same-run execution marker is required');

    expect(walletB.recoverGuardianFromHotKey).not.toHaveBeenCalled();
    expect(mockSavedCheckpoints).toHaveLength(0);
  });
});
