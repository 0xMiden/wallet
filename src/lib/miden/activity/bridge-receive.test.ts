import { reconcileAgglayerBridgedReceives, reconcileBridgedReceives } from './bridge-receive';

const rows: any[] = [];
const waitForReceipt = jest.fn();
const updatePhase = jest.fn();
const registerBridgeIn = jest.fn();
const fetchDeposits = jest.fn();
const resolveNoteId = jest.fn();
const getIntentStatus = jest.fn();

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
  getEpochReadOnlySdk: jest.fn(async () => ({
    getIntentStatus: (...args: unknown[]) => getIntentStatus(...args)
  }))
}));
jest.mock('../transaction/complete', () => ({
  updateBridgedReceivePhase: (...args: unknown[]) => updatePhase(...args)
}));
jest.mock('./bridge-in', () => ({
  registerPendingBridgeIn: (...args: unknown[]) => registerBridgeIn(...args),
  resolveBridgeInNoteId: (...args: unknown[]) => resolveNoteId(...args)
}));

beforeEach(() => {
  rows.splice(0);
  jest.clearAllMocks();
  waitForReceipt.mockResolvedValue(undefined);
  updatePhase.mockResolvedValue(undefined);
  registerBridgeIn.mockResolvedValue(undefined);
  fetchDeposits.mockResolvedValue([]);
  resolveNoteId.mockResolvedValue(undefined);
  getIntentStatus.mockResolvedValue([]);
});

const WEEK_AGO_SEC = Math.floor(Date.now() / 1000) - 8 * 24 * 60 * 60;

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

  it('times out rows older than the max tracking age on both provider paths', async () => {
    rows.push(
      {
        id: 'stale-agg',
        type: 'bridged-receive',
        initiatedAt: WEEK_AGO_SEC,
        extraInputs: { provider: 'agglayer', phase: 'delivering', evmTxHash: `0x${'d'.repeat(64)}` }
      },
      {
        id: 'stale-epoch',
        type: 'bridged-receive',
        initiatedAt: WEEK_AGO_SEC,
        extraInputs: { provider: 'epoch', phase: 'delivering', sourceAddress: '0x1', intentNonce: 'n' }
      }
    );

    await reconcileBridgedReceives();

    expect(updatePhase).toHaveBeenCalledWith('stale-agg', 'failed', { error: 'Bridge delivery timed out.' });
    expect(updatePhase).toHaveBeenCalledWith('stale-epoch', 'failed', { error: 'Bridge delivery timed out.' });
    expect(registerBridgeIn).not.toHaveBeenCalled();
  });

  it('fails an AggLayer row whose receipt wait rejects', async () => {
    waitForReceipt.mockRejectedValue(new Error('reverted on L1'));
    rows.push({
      id: 'agg-reverted',
      type: 'bridged-receive',
      accountId: 'miden-account',
      initiatedAt: Math.floor(Date.now() / 1000),
      extraInputs: { provider: 'agglayer', phase: 'submitting', evmTxHash: `0x${'e'.repeat(64)}` }
    });

    await reconcileAgglayerBridgedReceives();

    expect(updatePhase).toHaveBeenCalledWith('agg-reverted', 'failed', { error: 'reverted on L1' });
    expect(fetchDeposits).not.toHaveBeenCalled();
  });

  it('leaves an AggLayer row pending when the indexer is unreachable', async () => {
    fetchDeposits.mockRejectedValue(new Error('indexer down'));
    rows.push({
      id: 'agg-outage',
      type: 'bridged-receive',
      accountId: 'miden-account',
      initiatedAt: Math.floor(Date.now() / 1000),
      extraInputs: { provider: 'agglayer', phase: 'delivering', evmTxHash: `0x${'f'.repeat(64)}` }
    });

    await reconcileAgglayerBridgedReceives();

    expect(updatePhase).not.toHaveBeenCalled();
  });

  it('fails an interrupted Epoch submission that never recorded an intent', async () => {
    rows.push({
      id: 'epoch-interrupted',
      type: 'bridged-receive',
      initiatedAt: Math.floor(Date.now() / 1000),
      extraInputs: { provider: 'epoch', phase: 'submitting', sourceAddress: '0x1' }
    });

    await reconcileBridgedReceives();

    expect(updatePhase).toHaveBeenCalledWith(
      'epoch-interrupted',
      'failed',
      expect.objectContaining({ error: expect.stringContaining('intent') })
    );
    expect(registerBridgeIn).not.toHaveBeenCalled();
  });

  it('resolves a reported Miden note id and fails the row when the Miden leg failed', async () => {
    getIntentStatus.mockResolvedValue([
      { chainId: 11155111, status: 'FILLED', notAString: 5 },
      { chainId: 999999999, status: 'FAILED', midenNoteId: '  0xnote-1  ' }
    ]);
    rows.push({
      id: 'epoch-failed-leg',
      type: 'bridged-receive',
      initiatedAt: Math.floor(Date.now() / 1000),
      extraInputs: {
        provider: 'epoch',
        phase: 'delivering',
        sourceAddress: '0x1111111111111111111111111111111111111111',
        intentNonce: 'nonce-2'
      }
    });

    await reconcileBridgedReceives();

    expect(resolveNoteId).toHaveBeenCalledWith('nonce-2', '0xnote-1');
    expect(updatePhase).toHaveBeenCalledWith('epoch-failed-leg', 'failed', {
      error: 'The Epoch bridge intent failed.'
    });
  });

  it('survives an Epoch status-poll outage without touching the row', async () => {
    getIntentStatus.mockRejectedValue(new Error('allocator down'));
    rows.push({
      id: 'epoch-outage',
      type: 'bridged-receive',
      initiatedAt: Math.floor(Date.now() / 1000),
      extraInputs: {
        provider: 'epoch',
        phase: 'delivering',
        sourceAddress: '0x1111111111111111111111111111111111111111',
        intentNonce: 'nonce-3'
      }
    });

    await reconcileBridgedReceives();

    expect(registerBridgeIn).toHaveBeenCalled();
    expect(updatePhase).not.toHaveBeenCalled();
  });
});
