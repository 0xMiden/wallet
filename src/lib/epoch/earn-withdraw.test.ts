import * as Repo from 'lib/miden/repo';

import { gaslessEarnWithdrawalToMiden, resumeEarnWithdrawal, reconcileEarnWithdrawals } from './earn-withdraw';

jest.mock('@epoch-protocol/epoch-intents-sdk', () => ({
  EpochIntentSDK: class {},
  TaskType: { ProtocolInteraction: 'ProtocolInteraction' },
  ActionType: { Withdraw: 'Withdraw' },
  EVM_ZERO_ADDRESS: '0x0000000000000000000000000000000000000000'
}));
jest.mock('./bridge', () => ({ normalizeMidenIdToHex: (v: string) => v }));
jest.mock('./bridgeable-token', () => ({ BRIDGEABLE_EVM_OUTPUT_TOKEN_DECIMALS: 6 }));
jest.mock('./config', () => ({ EPOCH_ALLOCATOR_URL: 'http://alloc', MIDEN_DESTINATION_CHAIN_ID: 999 }));
jest.mock('./earn', () => ({
  EARN_PROTOCOL_HASH: '0xhash',
  EARN_UNDERLYING: '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
  EARN_DONE_STATUSES: new Set(['completed']),
  EARN_FAILED_STATUSES: new Set(['failed'])
}));
jest.mock('./evm-account', () => ({ buildVaultEvmWalletClient: jest.fn(() => ({})) }));
jest.mock('./sdk', () => ({ getEpochReadOnlySdk: jest.fn(), ensureEpochSmartAccount: jest.fn() }));
jest.mock('lib/miden-chain/native-asset', () => ({ getNativeAssetId: jest.fn().mockResolvedValue('mtst1native') }));
jest.mock('lib/miden/activity', () => ({
  initiateEarnWithdrawTransaction: jest.fn(),
  registerPendingBridgeIn: jest.fn(),
  resolveBridgeInNoteId: jest.fn(),
  updateEarnWithdrawPhase: jest.fn()
}));
jest.mock('lib/miden/repo', () => ({ transactions: { where: jest.fn(), filter: jest.fn() } }));

const EVM_OWNER = '0x1111111111111111111111111111111111111111';
const UNDERLYING = '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69';
const MARKET_UID = `DUMMY_LENDING:11155111:${UNDERLYING}`;

const validArgs = () => ({
  midenAccountPublicKey: 'mtst1recipient',
  evmAddress: EVM_OWNER,
  marketUid: MARKET_UID,
  underlyingAddress: UNDERLYING,
  amount: '10',
  underlyingDecimals: 6
});

function fakeSdk(executeActions: jest.Mock) {
  return {
    getWalletGaslessStatus: jest.fn().mockResolvedValue({ is7702Capable: true, needsSetup: false }),
    convertToSmartAccount: jest.fn().mockResolvedValue({ ok: true }),
    helpers: { executeActions }
  };
}

function baseDeps(overrides: Record<string, unknown> = {}) {
  return {
    ensureSmartAccount: jest.fn().mockResolvedValue(undefined),
    registerBridgeIn: jest.fn().mockResolvedValue(undefined),
    initiateRow: jest.fn().mockResolvedValue('TX1'),
    updatePhase: jest.fn().mockResolvedValue(undefined),
    startDeliveryPoll: jest.fn(),
    ...overrides
  };
}

describe('gaslessEarnWithdrawalToMiden', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates a redeeming row, submits the intent, and returns its txId + nonce', async () => {
    const executeActions = jest.fn().mockResolvedValue({ nonce: 'NONCE1' });
    const deps = baseDeps({ sdk: fakeSdk(executeActions) });

    const result = await gaslessEarnWithdrawalToMiden(validArgs(), deps);

    expect(result).toEqual({ txId: 'TX1', nonce: 'NONCE1', gaslessUsed: true });
    // Row created up front with the parsed atomic amount + destination faucet.
    expect(deps.initiateRow).toHaveBeenCalledWith(
      'mtst1recipient',
      10_000_000n,
      EVM_OWNER,
      MARKET_UID,
      'mtst1native',
      '10',
      'USDC'
    );
    expect(deps.updatePhase).toHaveBeenCalledWith('TX1', 'redeeming', { withdrawIntentNonce: 'NONCE1' });
    expect(deps.registerBridgeIn).toHaveBeenCalledWith(
      EVM_OWNER,
      'NONCE1',
      expect.objectContaining({ provider: 'epoch', earnWithdrawTxId: 'TX1', intentNonce: 'NONCE1' })
    );
    expect(deps.startDeliveryPoll).toHaveBeenCalledWith(expect.objectContaining({ txId: 'TX1', nonce: 'NONCE1' }));
  });

  it('rejects validation failures before creating any row', async () => {
    const deps = baseDeps({ sdk: fakeSdk(jest.fn()) });

    await expect(
      gaslessEarnWithdrawalToMiden({ ...validArgs(), evmAddress: 'not-an-address' }, deps)
    ).rejects.toThrow();
    expect(deps.initiateRow).not.toHaveBeenCalled();
  });

  it('marks the row failed when the intent submission throws', async () => {
    const executeActions = jest.fn().mockRejectedValue(new Error('solve boom'));
    const deps = baseDeps({ sdk: fakeSdk(executeActions) });

    await expect(gaslessEarnWithdrawalToMiden(validArgs(), deps)).rejects.toThrow('solve boom');
    expect(deps.initiateRow).toHaveBeenCalled();
    expect(deps.updatePhase).toHaveBeenCalledWith('TX1', 'failed', { error: 'solve boom' });
  });
});

describe('resumeEarnWithdrawal', () => {
  beforeEach(() => jest.clearAllMocks());

  it('re-registers the bridge-in and restarts polling for a submitted redeeming row', async () => {
    (Repo.transactions.where as jest.Mock).mockReturnValue({
      first: jest.fn().mockResolvedValue({
        id: 'TX1',
        type: 'earn-withdraw',
        extraInputs: {
          phase: 'redeeming',
          evmOwner: EVM_OWNER,
          withdrawIntentNonce: 'NONCE1',
          sourceAmount: '10',
          sourceSymbol: 'USDC'
        }
      })
    });
    const deps = baseDeps();

    await resumeEarnWithdrawal('TX1', deps);

    expect(deps.registerBridgeIn).toHaveBeenCalledWith(
      EVM_OWNER,
      'NONCE1',
      expect.objectContaining({ earnWithdrawTxId: 'TX1' })
    );
    expect(deps.startDeliveryPoll).toHaveBeenCalled();
    expect(deps.updatePhase).not.toHaveBeenCalled();
  });

  it('fails a row that was interrupted before the intent was submitted', async () => {
    (Repo.transactions.where as jest.Mock).mockReturnValue({
      first: jest.fn().mockResolvedValue({
        id: 'TX2',
        type: 'earn-withdraw',
        extraInputs: { phase: 'redeeming', evmOwner: EVM_OWNER, sourceAmount: '10', sourceSymbol: 'USDC' }
      })
    });
    const deps = baseDeps();

    await resumeEarnWithdrawal('TX2', deps);

    expect(deps.updatePhase).toHaveBeenCalledWith(
      'TX2',
      'failed',
      expect.objectContaining({ error: expect.any(String) })
    );
    expect(deps.startDeliveryPoll).not.toHaveBeenCalled();
  });
});

describe('reconcileEarnWithdrawals', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fails rows older than the TTL without resuming them', async () => {
    (Repo.transactions.filter as jest.Mock).mockReturnValue({
      toArray: jest
        .fn()
        .mockResolvedValue([
          { id: 'OLD', type: 'earn-withdraw', initiatedAt: 0, extraInputs: { phase: 'redeeming', evmOwner: EVM_OWNER } }
        ])
    });
    const deps = baseDeps();

    await reconcileEarnWithdrawals(deps);

    expect(deps.updatePhase).toHaveBeenCalledWith(
      'OLD',
      'failed',
      expect.objectContaining({ error: expect.any(String) })
    );
    expect(deps.startDeliveryPoll).not.toHaveBeenCalled();
  });
});
