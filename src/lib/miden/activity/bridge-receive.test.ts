import { reconcileAgglayerBridgedReceives, reconcileBridgedReceives } from './bridge-receive';

const rows: any[] = [];
const waitForReceipt = jest.fn();
const updatePhase = jest.fn();
const registerBridgeIn = jest.fn();
const fetchDeposits = jest.fn();

jest.mock('lib/miden/repo', () => ({
  transactions: {
    filter: jest.fn((predicate: (row: any) => boolean) => ({
      toArray: jest.fn(async () => rows.filter(predicate))
    }))
  }
}));
jest.mock('lib/walletconnect/receipt', () => ({
  waitForSepoliaReceipt: (...args: unknown[]) => waitForReceipt(...args)
}));
jest.mock('lib/agglayer/contract', () => ({
  midenAddrToEvmAddr: (address: string) => `evm:${address}`
}));
jest.mock('lib/agglayer/status', () => ({
  fetchDeposits: (...args: unknown[]) => fetchDeposits(...args),
  isAgglayerDepositReady: (deposit: any) =>
    Boolean(
      deposit.ready_for_claim || deposit.ready_to_claim || deposit.finalized || deposit.status === 'READY_TO_CLAIM'
    )
}));
jest.mock('lib/epoch/sdk', () => ({
  getEpochReadOnlySdk: jest.fn(async () => ({ getIntentStatus: jest.fn(async () => []) }))
}));
jest.mock('../transaction/complete', () => ({
  updateBridgedReceivePhase: (...args: unknown[]) => updatePhase(...args)
}));
jest.mock('./bridge-in', () => ({
  registerPendingBridgeIn: (...args: unknown[]) => registerBridgeIn(...args),
  resolveBridgeInNoteId: jest.fn()
}));

beforeEach(() => {
  rows.splice(0);
  jest.clearAllMocks();
  waitForReceipt.mockResolvedValue(undefined);
  updatePhase.mockResolvedValue(undefined);
  registerBridgeIn.mockResolvedValue(undefined);
  fetchDeposits.mockResolvedValue([]);
});

describe('reconcileBridgedReceives', () => {
  it('resumes an AggLayer receipt wait when a hash was persisted', async () => {
    rows.push({
      id: 'agg-row',
      type: 'bridged-receive',
      accountId: 'miden-account',
      initiatedAt: Math.floor(Date.now() / 1000),
      extraInputs: {
        provider: 'agglayer',
        phase: 'submitting',
        evmTxHash: `0x${'1'.repeat(64)}`
      }
    });

    await reconcileBridgedReceives();

    expect(waitForReceipt).toHaveBeenCalledWith(`0x${'1'.repeat(64)}`);
    expect(updatePhase).toHaveBeenCalledWith('agg-row', 'delivering');
    expect(fetchDeposits).toHaveBeenCalledWith('evm:miden-account');
  });

  it('marks only the matching AggLayer transaction ready once the indexer finalizes it', async () => {
    const hash = `0x${'a'.repeat(64)}`;
    rows.push({
      id: 'agg-ready',
      type: 'bridged-receive',
      accountId: 'miden-account',
      initiatedAt: Math.floor(Date.now() / 1000),
      extraInputs: { provider: 'agglayer', phase: 'delivering', evmTxHash: hash }
    });
    fetchDeposits.mockResolvedValue([
      { tx_hash: `0x${'b'.repeat(64)}`, ready_for_claim: true },
      { tx_hash: hash.toUpperCase(), ready_for_claim: false, status: 'READY_TO_CLAIM' }
    ]);

    await reconcileAgglayerBridgedReceives();

    expect(updatePhase).toHaveBeenCalledWith('agg-ready', 'ready');
  });

  it('leaves an indexed but non-final AggLayer transaction pending for the next poll', async () => {
    const hash = `0x${'c'.repeat(64)}`;
    rows.push({
      id: 'agg-pending',
      type: 'bridged-receive',
      accountId: 'miden-account',
      initiatedAt: Math.floor(Date.now() / 1000),
      extraInputs: { provider: 'agglayer', phase: 'delivering', evmTxHash: hash }
    });
    fetchDeposits.mockResolvedValue([{ tx_hash: hash, ready_for_claim: false }]);

    await reconcileAgglayerBridgedReceives();

    expect(updatePhase).not.toHaveBeenCalled();
  });

  it('fails an interrupted row that has no provider identifier', async () => {
    rows.push({
      id: 'interrupted',
      type: 'bridged-receive',
      initiatedAt: Math.floor(Date.now() / 1000),
      extraInputs: { provider: 'agglayer', phase: 'submitting' }
    });

    await reconcileBridgedReceives();

    expect(updatePhase).toHaveBeenCalledWith(
      'interrupted',
      'failed',
      expect.objectContaining({ error: expect.stringContaining('interrupted') })
    );
  });

  it('re-registers a delivering Epoch intent with its tracking-row link', async () => {
    rows.push({
      id: 'epoch-row',
      type: 'bridged-receive',
      initiatedAt: Math.floor(Date.now() / 1000),
      extraInputs: {
        provider: 'epoch',
        phase: 'delivering',
        sourceAddress: '0x1111111111111111111111111111111111111111',
        sourceAmount: '10',
        sourceSymbol: 'USDC',
        intentNonce: 'nonce-1'
      }
    });

    await reconcileBridgedReceives();

    expect(registerBridgeIn).toHaveBeenCalledWith(
      '0x1111111111111111111111111111111111111111',
      'nonce-1',
      expect.objectContaining({ bridgeReceiveTxId: 'epoch-row' })
    );
  });
});
