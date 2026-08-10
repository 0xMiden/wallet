import { AGGLAYER_CONTRACT_ADDRESS, MIDEN_CHAIN_ID } from 'lib/agglayer/constant';

import {
  bridgeDepositViaAgglayer,
  bridgeDepositViaEpoch,
  estimateDepositGasReserve,
  maxSendableDeposit,
  quoteDepositViaEpoch,
  type BridgeAssetRequest,
  type DepositFeeProbe
} from './execute';

jest.mock('@epoch-protocol/epoch-intents-sdk', () => ({ EpochIntentSDK: class {} }));
jest.mock('lib/agglayer/contract', () => ({
  midenAddrToEvmAddr: jest.fn(() => '0x00000000deadbeefdeadbeefdeadbeefdeadbe00')
}));
jest.mock('lib/epoch/bridge', () => ({ getEVMToMidenQuote: jest.fn(), buildEVMToMidenIntent: jest.fn() }));
jest.mock('lib/epoch/config', () => ({ EPOCH_ALLOCATOR_URL: 'http://alloc', MIDEN_DESTINATION_CHAIN_ID: 999 }));
jest.mock('lib/epoch/evm-account', () => ({ buildVaultEvmWalletClient: jest.fn() }));
jest.mock('lib/epoch/sdk', () => ({ ensureEpochSmartAccount: jest.fn() }));
jest.mock('lib/miden/activity', () => ({
  initiateBridgedReceiveTransaction: jest.fn(),
  registerPendingBridgeIn: jest.fn()
}));
jest.mock('lib/miden/assets', () => ({ getFaucetIdSetting: jest.fn() }));
jest.mock('lib/miden/transaction/complete', () => ({ updateBridgedReceivePhase: jest.fn() }));
jest.mock('lib/walletconnect/receipt', () => ({ waitForSepoliaReceipt: jest.fn() }));

const EVM_ADDRESS = '0x1111111111111111111111111111111111111111';
const MIDEN_ACCOUNT = 'mtst1recipient';
const ONE_ETH = 1_000_000_000_000_000_000n;
const NATIVE_FAUCET = '0xaabbccddeeff00112233445566';

/** Records the ORDER of the deps calls — several invariants are ordering ones. */
function orderTracker() {
  const calls: string[] = [];
  const track =
    <T,>(name: string, result: T) =>
    () => {
      calls.push(name);
      return Promise.resolve(result);
    };
  return { calls, track };
}

function epochDeps(overrides: Record<string, unknown> = {}) {
  return {
    ensureSmartAccount: jest.fn().mockResolvedValue(undefined),
    initiateRow: jest.fn().mockResolvedValue('TX1'),
    updatePhase: jest.fn().mockResolvedValue(undefined),
    registerBridgeIn: jest.fn().mockResolvedValue(undefined),
    getQuote: jest.fn().mockResolvedValue({ taskTypeString: 'tts', intentData: {}, quoteResult: {}, params: {} }),
    buildIntent: jest.fn().mockResolvedValue({
      taskTypeString: 'tts',
      intentData: {},
      intentNonce: 'NONCE1',
      solveResult: { nonce: 'NONCE1', depositResult: { transactionHash: '0xdeposit' } }
    }),
    getNativeFaucetId: jest.fn().mockResolvedValue(NATIVE_FAUCET),
    readWethBalance: jest.fn().mockResolvedValue(0n),
    sendWrap: jest.fn().mockResolvedValue('0xwrap'),
    waitForReceipt: jest.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

function agglayerDeps(overrides: Record<string, unknown> = {}) {
  return {
    initiateRow: jest.fn().mockResolvedValue('TX2'),
    updatePhase: jest.fn().mockResolvedValue(undefined),
    waitForReceipt: jest.fn().mockResolvedValue(undefined),
    sendBridgeAsset: jest.fn().mockResolvedValue('0xhash'),
    ...overrides
  };
}

const epochArgs = () => ({
  midenAccountPublicKey: MIDEN_ACCOUNT,
  evmAddress: EVM_ADDRESS,
  token: 'USDC' as const,
  amount: 5n * ONE_ETH
});

const agglayerArgs = () => ({
  midenAccountPublicKey: MIDEN_ACCOUNT,
  evmAddress: EVM_ADDRESS,
  token: 'ETH' as const,
  amount: ONE_ETH
});

beforeEach(() => jest.clearAllMocks());

describe('bridgeDepositViaEpoch', () => {
  it('creates the tracking row (and fires onRowCreated) BEFORE anything is submitted', async () => {
    const { calls, track } = orderTracker();
    const deps = epochDeps({
      initiateRow: jest.fn(track('initiateRow', 'TX1')),
      buildIntent: jest.fn(
        track('buildIntent', { taskTypeString: 't', intentData: {}, intentNonce: 'NONCE1', solveResult: {} })
      )
    });
    const onRowCreated = jest.fn(() => calls.push('onRowCreated'));

    const result = await bridgeDepositViaEpoch({ ...epochArgs(), onRowCreated }, deps);

    expect(calls.slice(0, 3)).toEqual(['initiateRow', 'onRowCreated', 'buildIntent']);
    expect(onRowCreated).toHaveBeenCalledWith('TX1');
    expect(result).toEqual({ txId: 'TX1', intentNonce: 'NONCE1', evmTxHash: undefined });
    expect(deps.initiateRow).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: MIDEN_ACCOUNT,
        amount: 5n * ONE_ETH,
        provider: 'epoch',
        sourceAddress: EVM_ADDRESS,
        sourceAmount: '5',
        sourceSymbol: 'USDC'
      })
    );
  });

  it('registers the bridge-in BEFORE patching the row phase, and records nonce + tx hash', async () => {
    const { calls, track } = orderTracker();
    const deps = epochDeps({
      registerBridgeIn: jest.fn(track('registerBridgeIn', undefined)),
      updatePhase: jest.fn(track('updatePhase', undefined))
    });

    const result = await bridgeDepositViaEpoch(epochArgs(), deps);

    expect(calls).toEqual(['registerBridgeIn', 'updatePhase']);
    expect(deps.registerBridgeIn).toHaveBeenCalledWith(
      EVM_ADDRESS,
      'NONCE1',
      expect.objectContaining({ provider: 'epoch', bridgeReceiveTxId: 'TX1', intentNonce: 'NONCE1' })
    );
    expect(deps.updatePhase).toHaveBeenCalledWith('TX1', 'delivering', {
      intentNonce: 'NONCE1',
      evmTxHash: '0xdeposit'
    });
    expect(result.evmTxHash).toBe('0xdeposit');
  });

  it('marks the row failed and rethrows when the submit throws (nothing is in flight)', async () => {
    const deps = epochDeps({ buildIntent: jest.fn().mockRejectedValue(new Error('solver down')) });

    await expect(bridgeDepositViaEpoch(epochArgs(), deps)).rejects.toThrow('solver down');
    expect(deps.updatePhase).toHaveBeenCalledWith('TX1', 'failed', { error: 'solver down' });
    expect(deps.registerBridgeIn).not.toHaveBeenCalled();
  });

  it('marks the row failed when the intent comes back with an error field', async () => {
    const deps = epochDeps({
      buildIntent: jest.fn().mockResolvedValue({ taskTypeString: 't', intentData: {}, error: 'no liquidity' })
    });

    await expect(bridgeDepositViaEpoch(epochArgs(), deps)).rejects.toThrow('no liquidity');
    expect(deps.updatePhase).toHaveBeenCalledWith('TX1', 'failed', { error: 'no liquidity' });
  });

  it('NEVER marks the row failed when POST-submit bookkeeping fails', async () => {
    const deps = epochDeps({
      registerBridgeIn: jest.fn().mockRejectedValue(new Error('storage full')),
      updatePhase: jest.fn().mockRejectedValue(new Error('db closed'))
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    // The intent is live: the call still resolves and the row stays non-terminal.
    const result = await bridgeDepositViaEpoch(epochArgs(), deps);

    expect(result.intentNonce).toBe('NONCE1');
    expect(deps.updatePhase).not.toHaveBeenCalledWith('TX1', 'failed', expect.anything());
    warn.mockRestore();
  });

  it('fails the row when the intent came back without a trackable nonce', async () => {
    const deps = epochDeps({
      buildIntent: jest.fn().mockResolvedValue({ taskTypeString: 't', intentData: {}, solveResult: {} })
    });

    await expect(bridgeDepositViaEpoch(epochArgs(), deps)).rejects.toThrow(/trackable nonce/);
    expect(deps.updatePhase).toHaveBeenCalledWith('TX1', 'failed', expect.objectContaining({ error: expect.any(String) }));
  });

  it('rejects an invalid address and a zero amount before creating any row', async () => {
    const deps = epochDeps();

    await expect(bridgeDepositViaEpoch({ ...epochArgs(), evmAddress: 'nope' }, deps)).rejects.toThrow(
      /not a valid EVM address/
    );
    await expect(bridgeDepositViaEpoch({ ...epochArgs(), amount: 0n }, deps)).rejects.toThrow(/greater than zero/);
    expect(deps.initiateRow).not.toHaveBeenCalled();
  });

  it('never wraps on the USDC route', async () => {
    const deps = epochDeps();

    await bridgeDepositViaEpoch(epochArgs(), deps);

    expect(deps.sendWrap).not.toHaveBeenCalled();
    expect(deps.readWethBalance).not.toHaveBeenCalled();
  });

  describe('ETH via WETH wrap', () => {
    const ethArgs = () => ({ ...epochArgs(), token: 'ETH' as const, amount: ONE_ETH });

    it('wraps the ETH after the row exists, waits for the receipt, then submits the intent', async () => {
      const { calls, track } = orderTracker();
      const deps = epochDeps({
        initiateRow: jest.fn(track('initiateRow', 'TX1')),
        sendWrap: jest.fn(track('sendWrap', '0xwrap')),
        waitForReceipt: jest.fn(track('waitForReceipt', undefined)),
        buildIntent: jest.fn(
          track('buildIntent', { taskTypeString: 't', intentData: {}, intentNonce: 'NONCE1', solveResult: {} })
        )
      });

      await bridgeDepositViaEpoch(ethArgs(), deps);

      expect(calls).toEqual(['initiateRow', 'sendWrap', 'waitForReceipt', 'buildIntent']);
      expect(deps.sendWrap).toHaveBeenCalledWith({ account: EVM_ADDRESS, value: ONE_ETH });
      expect(deps.initiateRow).toHaveBeenCalledWith(
        expect.objectContaining({ faucetId: NATIVE_FAUCET, sourceSymbol: 'ETH', outputSymbol: 'ETH' })
      );
    });

    it('wraps only the shortfall when leftover WETH already sits on the address', async () => {
      const deps = epochDeps({ readWethBalance: jest.fn().mockResolvedValue(ONE_ETH / 4n) });

      await bridgeDepositViaEpoch(ethArgs(), deps);

      expect(deps.sendWrap).toHaveBeenCalledWith({ account: EVM_ADDRESS, value: (3n * ONE_ETH) / 4n });
    });

    it('skips the wrap entirely when the WETH balance already covers the amount', async () => {
      const deps = epochDeps({ readWethBalance: jest.fn().mockResolvedValue(2n * ONE_ETH) });

      const result = await bridgeDepositViaEpoch(ethArgs(), deps);

      expect(deps.sendWrap).not.toHaveBeenCalled();
      expect(result.intentNonce).toBe('NONCE1');
    });

    it('marks the row failed when the wrap broadcast throws (nothing is in flight)', async () => {
      const deps = epochDeps({ sendWrap: jest.fn().mockRejectedValue(new Error('wrap reverted')) });

      await expect(bridgeDepositViaEpoch(ethArgs(), deps)).rejects.toThrow('wrap reverted');
      expect(deps.updatePhase).toHaveBeenCalledWith('TX1', 'failed', { error: 'wrap reverted' });
      expect(deps.registerBridgeIn).not.toHaveBeenCalled();
    });

    it('rejects before creating any row when the native Miden faucet is unknown', async () => {
      const deps = epochDeps({ getNativeFaucetId: jest.fn().mockResolvedValue(null) });

      await expect(bridgeDepositViaEpoch(ethArgs(), deps)).rejects.toThrow(/native Miden faucet/);
      expect(deps.initiateRow).not.toHaveBeenCalled();
    });
  });
});

describe('quoteDepositViaEpoch', () => {
  it('quotes the human amount against the USDC token config', async () => {
    const getQuote = jest.fn().mockResolvedValue({ quoteResult: {} });

    await quoteDepositViaEpoch(
      { midenAccountPublicKey: MIDEN_ACCOUNT, evmAddress: EVM_ADDRESS, token: 'USDC', amount: 2n * ONE_ETH },
      { sdk: undefined, getQuote }
    );

    expect(getQuote).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ evmAmount: '2', evmTokenDecimals: 18, midenRecipientId: MIDEN_ACCOUNT }),
      EVM_ADDRESS
    );
  });

  it('quotes ETH against the WETH contract and the native Miden faucet', async () => {
    const getQuote = jest.fn().mockResolvedValue({ quoteResult: {} });

    await quoteDepositViaEpoch(
      { midenAccountPublicKey: MIDEN_ACCOUNT, evmAddress: EVM_ADDRESS, token: 'ETH', amount: ONE_ETH },
      { sdk: undefined, getQuote, getNativeFaucetId: jest.fn().mockResolvedValue(NATIVE_FAUCET) }
    );

    expect(getQuote).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        evmTokenAddress: '0x7946dd86eE310D0aC16804A37787289Fa5b88A8A',
        evmAmount: '1',
        evmTokenDecimals: 18,
        midenFaucetId: NATIVE_FAUCET
      }),
      EVM_ADDRESS
    );
  });
});

describe('bridgeDepositViaAgglayer', () => {
  it('writes bridgeAsset with the AggLayer args and the amount as msg.value', async () => {
    const deps = agglayerDeps();

    const result = await bridgeDepositViaAgglayer(agglayerArgs(), deps);

    const request: BridgeAssetRequest = deps.sendBridgeAsset.mock.calls[0][0];
    expect(request.account).toBe(EVM_ADDRESS);
    expect(request.address).toBe(AGGLAYER_CONTRACT_ADDRESS.get('sepolia'));
    expect(request.value).toBe(ONE_ETH);
    expect(request.args).toEqual([
      MIDEN_CHAIN_ID,
      '0x00000000deadbeefdeadbeefdeadbeefdeadbe00',
      ONE_ETH,
      '0x0000000000000000000000000000000000000000',
      true,
      '0x'
    ]);
    expect(result).toEqual({ txId: 'TX2', evmTxHash: '0xhash' });
  });

  it('advances submitting → delivering around the receipt wait', async () => {
    const deps = agglayerDeps();

    await bridgeDepositViaAgglayer(agglayerArgs(), deps);

    expect(deps.updatePhase.mock.calls).toEqual([
      ['TX2', 'submitting', { evmTxHash: '0xhash' }],
      ['TX2', 'delivering', { evmTxHash: '0xhash' }]
    ]);
    expect(deps.waitForReceipt).toHaveBeenCalledWith('0xhash');
  });

  it('marks the row failed when the broadcast itself throws', async () => {
    const deps = agglayerDeps({ sendBridgeAsset: jest.fn().mockRejectedValue(new Error('user rejected')) });

    await expect(bridgeDepositViaAgglayer(agglayerArgs(), deps)).rejects.toThrow('user rejected');
    expect(deps.updatePhase).toHaveBeenCalledWith('TX2', 'failed', { error: 'user rejected' });
  });

  it('NEVER marks the row failed once the tx is broadcast, even if the receipt wait fails', async () => {
    const deps = agglayerDeps({ waitForReceipt: jest.fn().mockRejectedValue(new Error('rpc timeout')) });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await bridgeDepositViaAgglayer(agglayerArgs(), deps);

    expect(result.evmTxHash).toBe('0xhash');
    expect(deps.updatePhase).not.toHaveBeenCalledWith('TX2', 'failed', expect.anything());
    warn.mockRestore();
  });

  it('rejects a non-ETH token before creating any row', async () => {
    const deps = agglayerDeps();
    await expect(bridgeDepositViaAgglayer({ ...agglayerArgs(), token: 'USDC' }, deps)).rejects.toThrow(
      /only bridges native ETH/
    );
    expect(deps.initiateRow).not.toHaveBeenCalled();
  });
});

describe('maxSendableDeposit', () => {
  const probe = (overrides: Partial<DepositFeeProbe> = {}): DepositFeeProbe => ({
    estimateGas: jest.fn().mockResolvedValue(100_000n),
    estimateFeesPerGas: jest.fn().mockResolvedValue({ maxFeePerGas: 1_000_000_000n }),
    ...overrides
  });

  const ethArgs = (balance: bigint) => ({
    token: 'ETH' as const,
    balance,
    evmAddress: EVM_ADDRESS,
    midenAccountPublicKey: MIDEN_ACCOUNT
  });

  it('sends the full balance for the gasless USDC route', async () => {
    await expect(
      maxSendableDeposit({ ...ethArgs(7n * ONE_ETH), token: 'USDC' }, { probe: probe() })
    ).resolves.toBe(7n * ONE_ETH);
  });

  it('subtracts the estimated ETH gas reserve (with headroom) from the balance', async () => {
    // 100_000 gas × 1 gwei × 1.3 headroom = 1.3e14 wei.
    const expectedReserve = 130_000_000_000_000n;

    await expect(estimateDepositGasReserve(ethArgs(ONE_ETH), { probe: probe() })).resolves.toBe(expectedReserve);
    await expect(maxSendableDeposit(ethArgs(ONE_ETH), { probe: probe() })).resolves.toBe(ONE_ETH - expectedReserve);
  });

  it('falls back to a fixed gas ceiling when the estimate reverts on a near-empty address', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const reverting = probe({ estimateGas: jest.fn().mockRejectedValue(new Error('insufficient funds')) });

    // 150_000 gas × 1 gwei × 1.3 = 1.95e14 wei.
    await expect(estimateDepositGasReserve(ethArgs(ONE_ETH), { probe: reverting })).resolves.toBe(195_000_000_000_000n);
    warn.mockRestore();
  });

  it('falls back to a fixed gas price when fee estimation fails', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const noFees = probe({ estimateFeesPerGas: jest.fn().mockRejectedValue(new Error('no block')) });

    // 100_000 gas × 3 gwei × 1.3 = 3.9e14 wei.
    await expect(estimateDepositGasReserve(ethArgs(ONE_ETH), { probe: noFees })).resolves.toBe(390_000_000_000_000n);
    warn.mockRestore();
  });

  it('returns 0 when the balance cannot cover its own network fee', async () => {
    await expect(maxSendableDeposit(ethArgs(1_000n), { probe: probe() })).resolves.toBe(0n);
    await expect(maxSendableDeposit(ethArgs(0n), { probe: probe() })).resolves.toBe(0n);
  });
});
