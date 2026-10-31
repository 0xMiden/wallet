import { EPOCH_INTENT_STATUS_TIMEOUT_MS } from 'lib/epoch/intent-status';
import { getEpochReadOnlySdk } from 'lib/epoch/sdk';
import * as Repo from 'lib/miden/repo';
import { EVM_CHAIN_DEFINITIONS } from 'lib/walletconnect/config';
import { EvmTransactionRevertedError } from 'lib/walletconnect/receipt';

import { BridgeReceiveLockManager, createBridgeReceiveReconciler, reconcileBridgedReceives } from './bridge-receive';

const rows: any[] = [];
const waitForReceipt = jest.fn();
const updatePhase = jest.fn();
const registerBridgeIn = jest.fn();
const fetchDeposits = jest.fn();
const resolveNoteId = jest.fn();
const getIntentStatus = jest.fn();
const fetchAttestations = jest.fn();
const matchAttestation = jest.fn();

// Only the type index is read: a pass that falls back to walking the table has no `filter` to call here.
jest.mock('lib/remote-config/runtime', () =>
  jest
    .requireActual<typeof import('lib/epoch/testing/bridge-config')>('lib/epoch/testing/bridge-config')
    .remoteConfigRuntimeMock(() =>
      jest
        .requireActual<typeof import('lib/remote-config/testing/fixture')>('lib/remote-config/testing/fixture')
        .testBridgeSnapshot()
    )
);
jest.mock('lib/miden/repo', () => ({
  transactions: {
    where: jest.fn((index: string) => ({
      equals: (value: string) => ({
        filter: (predicate: (row: any) => boolean) => ({
          toArray: async () => rows.filter(row => row[index] === value && predicate(row))
        })
      })
    }))
  }
}));
jest.mock('lib/usdcx/attestation', () => ({
  fetchXReserveAttestations: (...args: unknown[]) => fetchAttestations(...args),
  matchUsdcxDepositAttestation: (...args: unknown[]) => matchAttestation(...args)
}));
// The SDK's id parse stands in as a tag of the ref it was given; bridge-receive.usdcx.test.ts runs the real one.
jest.mock('lib/usdcx/deposit-target', () => ({
  usdcxRemoteRecipientFor: (ref: string) => {
    if (ref === 'no-account') throw new Error('not an account id');
    return `recipient-of:${ref}`;
  },
  usdcxExpectedRemoteTokenFor: (ref: string) => `token-of:${ref}`
}));
const fetchAttestedMessage = jest.fn();
jest.mock('lib/usdcx/cctp', () => ({
  ...jest.requireActual<typeof import('lib/usdcx/cctp')>('lib/usdcx/cctp'),
  fetchAttestedCctpMessage: (...args: unknown[]) => fetchAttestedMessage(...args)
}));
const readOutcome = jest.fn();
jest.mock('lib/walletconnect/receipt', () => ({
  ...jest.requireActual<typeof import('lib/walletconnect/receipt')>('lib/walletconnect/receipt'),
  waitForEvmReceipt: (...args: unknown[]) => waitForReceipt(...args),
  readEvmReceiptOutcome: (...args: unknown[]) => readOutcome(...args)
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
// A value no real chain uses, so a hardcoded virtual id in bridge-receive cannot pass for the shared one.
jest.mock('lib/epoch/config', () => ({ MIDEN_DESTINATION_CHAIN_ID: 4242 }));
jest.mock('../transaction/complete', () => ({
  updateBridgedReceivePhase: (...args: unknown[]) => updatePhase(...args)
}));
jest.mock('./bridge-in', () => ({
  BRIDGE_RECEIVE_MAX_AGE_MS: jest.requireActual('./bridge-in').BRIDGE_RECEIVE_MAX_AGE_MS,
  BRIDGE_DELIVERY_TIMED_OUT: jest.requireActual('./bridge-in').BRIDGE_DELIVERY_TIMED_OUT,
  registerPendingBridgeIn: (...args: unknown[]) => registerBridgeIn(...args),
  resolveBridgeInNoteId: (...args: unknown[]) => resolveNoteId(...args)
}));

beforeEach(() => {
  rows.splice(0);
  jest.clearAllMocks();
  waitForReceipt.mockResolvedValue(undefined);
  updatePhase.mockResolvedValue(undefined);
  fetchAttestations.mockResolvedValue([]);
  matchAttestation.mockReturnValue({ kind: 'pending' });
  readOutcome.mockResolvedValue('pending');
  registerBridgeIn.mockResolvedValue(undefined);
  fetchDeposits.mockResolvedValue([]);
  resolveNoteId.mockResolvedValue(undefined);
  getIntentStatus.mockResolvedValue([]);
});

const WEEK_AGO_SEC = Math.floor(Date.now() / 1000) - 8 * 24 * 60 * 60;

describe('reconcileBridgedReceives', () => {
  it('leaves 1Click rows to their dedicated reconciler', async () => {
    rows.push({
      id: 'one-click-row',
      type: 'bridged-receive',
      accountId: 'miden-account',
      initiatedAt: Math.floor(Date.now() / 1000),
      extraInputs: { provider: 'near-intents', phase: 'submitting', oneClick: { direction: 'evm-to-miden' } }
    });

    await reconcileBridgedReceives();

    expect(updatePhase).not.toHaveBeenCalled();
    expect(fetchDeposits).not.toHaveBeenCalled();
    expect(readOutcome).not.toHaveBeenCalled();
    expect(registerBridgeIn).not.toHaveBeenCalled();
  });

  it('resumes an AggLayer receipt read when a hash was persisted', async () => {
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

    readOutcome.mockResolvedValue('success');

    await reconcileBridgedReceives();

    expect(readOutcome).toHaveBeenCalledWith(`0x${'1'.repeat(64)}`, expect.objectContaining({ id: 11155111 }));
    expect(waitForReceipt).not.toHaveBeenCalled();
    expect(updatePhase).toHaveBeenCalledWith('agg-row', 'delivering');
    expect(fetchDeposits).toHaveBeenCalledWith('evm:miden-account', undefined, undefined);
  });

  it('reads an AggLayer receipt on the chain the row saved', async () => {
    const hash = `0x${'5'.repeat(64)}`;
    const agglayerRoute = {
      chainId: 84532,
      contractAddress: '0x528e26b25a34a4a5d0dbda1d57d318153d2ed582',
      midenBridgeId: '0x187cabbc404359d16be94954ca9879',
      indexerUrl: 'https://indexer.test/api',
      rollupId: 86,
      evmNetworkId: 6
    };
    rows.push({
      id: 'agg-base',
      type: 'bridged-receive',
      accountId: 'miden-account',
      initiatedAt: Math.floor(Date.now() / 1000),
      extraInputs: { provider: 'agglayer', phase: 'submitting', evmTxHash: hash, agglayerRoute }
    });

    readOutcome.mockResolvedValue('success');

    await reconcileBridgedReceives();

    expect(readOutcome).toHaveBeenCalledWith(hash, expect.objectContaining({ id: 84532 }));
    expect(fetchDeposits).toHaveBeenCalledWith('evm:miden-account', undefined, agglayerRoute);
  });

  it("reads an Epoch row's intent through the allocator the row saved", async () => {
    rows.push({
      id: 'epoch-saved-allocator',
      type: 'bridged-receive',
      initiatedAt: Math.floor(Date.now() / 1000),
      extraInputs: {
        provider: 'epoch',
        phase: 'delivering',
        sourceAddress: '0xabc',
        sourceAmount: '1',
        sourceSymbol: 'USDC',
        intentNonce: '42',
        epochAllocatorUrl: 'https://allocator-a.test'
      }
    });

    await reconcileBridgedReceives();

    expect(getEpochReadOnlySdk).toHaveBeenCalledWith('0xabc', 'https://allocator-a.test');
    expect(registerBridgeIn).toHaveBeenCalledWith(
      '0xabc',
      '42',
      expect.objectContaining({
        bridgeReceiveTxId: 'epoch-saved-allocator',
        epochAllocatorUrl: 'https://allocator-a.test'
      })
    );
  });

  it('walks the history once per pass and advances rows of both providers', async () => {
    const hash = `0x${'2'.repeat(64)}`;
    rows.push(
      {
        id: 'agg-once',
        type: 'bridged-receive',
        accountId: 'miden-account',
        initiatedAt: Math.floor(Date.now() / 1000),
        extraInputs: { provider: 'agglayer', phase: 'delivering', evmTxHash: hash }
      },
      {
        id: 'epoch-once',
        type: 'bridged-receive',
        initiatedAt: Math.floor(Date.now() / 1000),
        extraInputs: {
          provider: 'epoch',
          phase: 'delivering',
          sourceAddress: '0x1111111111111111111111111111111111111111',
          intentNonce: 'nonce-once'
        }
      }
    );
    fetchDeposits.mockResolvedValue([{ tx_hash: hash, ready_for_claim: true }]);

    await reconcileBridgedReceives();

    expect(Repo.transactions.where).toHaveBeenCalledTimes(1);
    expect(Repo.transactions.where).toHaveBeenCalledWith('type');
    expect(updatePhase).toHaveBeenCalledWith('agg-once', 'ready');
    expect(registerBridgeIn).toHaveBeenCalledWith(
      '0x1111111111111111111111111111111111111111',
      'nonce-once',
      expect.objectContaining({ bridgeReceiveTxId: 'epoch-once' })
    );
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

    await reconcileBridgedReceives();

    expect(updatePhase).toHaveBeenCalledWith('agg-ready', 'ready');
  });

  // A restored row is a record, not live work: its `evmTxHash` and account come
  // from whoever authored the backup. It must neither be waited on nor left
  // pending forever — the tracking state that would resume it does not travel
  // in the dump, so nothing else would ever move it off a non-terminal phase.
  describe('rows restored from a backup', () => {
    const restoredRow = (id: string, provider: string) => ({
      id,
      type: 'bridged-receive',
      accountId: 'miden-account',
      initiatedAt: Math.floor(Date.now() / 1000),
      restoredFromBackup: true,
      extraInputs: { provider, phase: 'submitting', evmTxHash: `0x${'9'.repeat(64)}` }
    });

    it('terminalizes an AggLayer row without waiting on its hash', async () => {
      rows.push(restoredRow('agg-restored', 'agglayer'));

      await reconcileBridgedReceives();

      expect(waitForReceipt).not.toHaveBeenCalled();
      expect(readOutcome).not.toHaveBeenCalled();
      expect(fetchDeposits).not.toHaveBeenCalled();
      expect(updatePhase).toHaveBeenCalledWith(
        'agg-restored',
        'failed',
        expect.objectContaining({ error: expect.any(String) })
      );
    });

    it('terminalizes an Epoch row instead of registering a bridge-in for it', async () => {
      rows.push(restoredRow('epoch-restored', 'epoch'));

      await reconcileBridgedReceives();

      expect(updatePhase).toHaveBeenCalledWith(
        'epoch-restored',
        'failed',
        expect.objectContaining({ error: expect.any(String) })
      );
    });
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

    await reconcileBridgedReceives();

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
      expect.objectContaining({
        error: expect.stringContaining('interrupted'),
        failure: { step: 'submission_interrupted', orphanCheck: 'realm_idle' }
      })
    );
  });

  // A USDCx row closes like its Agglayer sibling: with no hash and no flow left to write one, it can never progress.
  it.each([
    ['the direct route', {}, 'unrecorded'],
    ['the executor route', { sourceChainId: 84532 }, 'unrecorded'],
    ['a recorded direct route', { usdcxSource: { route: 'xreserve' } }, 'xreserve'],
    ['a recorded executor route', { usdcxSource: { route: 'cctp-executor' } }, 'cctp_executor'],
    ['a recorded route the wallet does not define', { usdcxSource: { route: '0xdeadbeef' } }, 'unrecorded']
  ])('fails an interrupted USDCx row on %s that never recorded a hash', async (_route, extra, sourceRoute) => {
    rows.push({
      id: 'usdcx-interrupted',
      type: 'bridged-receive',
      initiatedAt: Math.floor(Date.now() / 1000),
      extraInputs: { provider: 'usdcx', phase: 'submitting', ...extra }
    });

    await reconcileBridgedReceives();

    expect(updatePhase).toHaveBeenCalledWith('usdcx-interrupted', 'failed', {
      error: 'Bridge submission was interrupted before a transaction hash was recorded.',
      failure: { step: 'submission_interrupted', orphanCheck: 'realm_idle', sourceRoute }
    });
    expect(fetchAttestations).not.toHaveBeenCalled();
    expect(fetchAttestedMessage).not.toHaveBeenCalled();
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

    expect(updatePhase).toHaveBeenCalledWith('stale-agg', 'failed', {
      error: 'Bridge delivery timed out.',
      failure: { step: 'delivery_timed_out' }
    });
    expect(updatePhase).toHaveBeenCalledWith('stale-epoch', 'failed', {
      error: 'Bridge delivery timed out.',
      failure: { step: 'delivery_timed_out' }
    });
    expect(registerBridgeIn).not.toHaveBeenCalled();
  });

  const submittingAggRow = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    type: 'bridged-receive',
    accountId: 'miden-account',
    initiatedAt: Math.floor(Date.now() / 1000),
    extraInputs: { provider: 'agglayer', phase: 'submitting', evmTxHash: `0x${'e'.repeat(64)}`, ...extra }
  });

  it('fails an AggLayer row whose receipt reverted', async () => {
    readOutcome.mockResolvedValue('reverted');
    rows.push(submittingAggRow('agg-reverted'));
    const chainName = EVM_CHAIN_DEFINITIONS.find(candidate => candidate.id === 11155111)!.name;

    await reconcileBridgedReceives();

    expect(updatePhase).toHaveBeenCalledWith('agg-reverted', 'failed', {
      error: new EvmTransactionRevertedError(chainName).message,
      failure: { step: 'reconciler_receipt', cause: expect.any(EvmTransactionRevertedError) }
    });
    expect(fetchDeposits).not.toHaveBeenCalled();
  });

  it('keeps an AggLayer row submitting while its receipt is pending', async () => {
    readOutcome.mockResolvedValue('pending');
    rows.push(submittingAggRow('agg-pending'));

    await reconcileBridgedReceives();

    expect(readOutcome).toHaveBeenCalledTimes(1);
    expect(readOutcome).toHaveBeenCalledWith(`0x${'e'.repeat(64)}`, expect.objectContaining({ id: 11155111 }));
    expect(updatePhase).not.toHaveBeenCalled();
    expect(fetchDeposits).not.toHaveBeenCalled();
  });

  it.each([new Error('timeout'), new Error('Sepolia RPC is not configured')])(
    'keeps an AggLayer row submitting when its receipt cannot be read (%s)',
    async error => {
      readOutcome.mockRejectedValue(error);
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      rows.push(submittingAggRow('agg-unreadable'));

      await reconcileBridgedReceives();

      expect(updatePhase).not.toHaveBeenCalled();
      expect(fetchDeposits).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('[bridge-receive] AggLayer receipt read failed', 'agg-unreadable', error);
      warn.mockRestore();
    }
  );

  it('keeps an AggLayer row submitting whose chain is not configured', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    rows.push(submittingAggRow('agg-no-chain', { agglayerRoute: { chainId: 999999 } }));

    await reconcileBridgedReceives();

    expect(readOutcome).not.toHaveBeenCalled();
    expect(updatePhase).not.toHaveBeenCalled();
    expect(fetchDeposits).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[bridge-receive] AggLayer receipt not readable', 'agg-no-chain');
    warn.mockRestore();
  });

  it('keeps an AggLayer row submitting whose saved hash is not a transaction hash', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    rows.push(submittingAggRow('agg-bad-hash', { evmTxHash: '0x1234' }));

    await reconcileBridgedReceives();

    expect(readOutcome).not.toHaveBeenCalled();
    expect(updatePhase).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('[bridge-receive] AggLayer receipt not readable', 'agg-bad-hash');
    warn.mockRestore();
  });

  // A receipt that never settles leaves the row submitting, so the delivery window is what ends it.
  it('times out a submitting AggLayer row older than the tracking age without reading its receipt', async () => {
    rows.push({ ...submittingAggRow('agg-stale-submitting'), initiatedAt: WEEK_AGO_SEC });

    await reconcileBridgedReceives();

    expect(readOutcome).not.toHaveBeenCalled();
    expect(updatePhase).toHaveBeenCalledWith('agg-stale-submitting', 'failed', {
      error: 'Bridge delivery timed out.',
      failure: { step: 'delivery_timed_out' }
    });
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

    await reconcileBridgedReceives();

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
      expect.objectContaining({
        error: expect.stringContaining('intent'),
        failure: { step: 'submission_interrupted', orphanCheck: 'realm_idle' }
      })
    );
    expect(registerBridgeIn).not.toHaveBeenCalled();
  });

  it('resolves a reported Miden note id and fails the row when the Miden leg failed', async () => {
    getIntentStatus.mockResolvedValue([
      { chainId: 11155111, status: 'FILLED', notAString: 5 },
      { chainId: 4242, status: 'FAILED', midenNoteId: '  0xnote-1  ' }
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

    expect(resolveNoteId).toHaveBeenCalledWith('0x1111111111111111111111111111111111111111', 'nonce-2', '0xnote-1');
    expect(updatePhase).toHaveBeenCalledWith('epoch-failed-leg', 'failed', {
      error: 'The Epoch bridge intent failed.',
      failure: { step: 'epoch_intent_failed' }
    });
  });

  it('reads the Miden leg by the shared virtual chain id, not a copy of it', async () => {
    getIntentStatus.mockResolvedValue([{ chainId: 999999999, status: 'FAILED' }]);
    rows.push({
      id: 'epoch-other-leg',
      type: 'bridged-receive',
      initiatedAt: Math.floor(Date.now() / 1000),
      extraInputs: {
        provider: 'epoch',
        phase: 'delivering',
        sourceAddress: '0x1111111111111111111111111111111111111111',
        intentNonce: 'nonce-5'
      }
    });

    await reconcileBridgedReceives();

    expect(updatePhase).not.toHaveBeenCalled();
  });

  it('keeps reconciling later rows when one row fails, and names the failing row', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    registerBridgeIn.mockRejectedValueOnce(new Error('registry locked'));
    const hash = `0x${'5'.repeat(64)}`;
    rows.push(
      {
        id: 'epoch-broken',
        type: 'bridged-receive',
        initiatedAt: Math.floor(Date.now() / 1000),
        extraInputs: {
          provider: 'epoch',
          phase: 'delivering',
          sourceAddress: '0x1111111111111111111111111111111111111111',
          intentNonce: 'nonce-broken'
        }
      },
      {
        id: 'agg-after',
        type: 'bridged-receive',
        accountId: 'miden-account',
        initiatedAt: Math.floor(Date.now() / 1000),
        extraInputs: { provider: 'agglayer', phase: 'delivering', evmTxHash: hash }
      }
    );
    fetchDeposits.mockResolvedValue([{ tx_hash: hash, ready_for_claim: true }]);

    await reconcileBridgedReceives();

    expect(updatePhase).toHaveBeenCalledWith('agg-after', 'ready');
    expect(warn).toHaveBeenCalledWith('[bridge-receive] reconcile failed', 'epoch-broken', 'epoch', expect.any(Error));
    warn.mockRestore();
  });

  it('does not hold the rows after an Epoch status read that never answers', async () => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      getIntentStatus.mockReturnValueOnce(new Promise(() => {}));
      const hash = `0x${'2'.repeat(64)}`;
      rows.push(
        {
          id: 'epoch-hung',
          type: 'bridged-receive',
          initiatedAt: Math.floor(Date.now() / 1000),
          extraInputs: {
            provider: 'epoch',
            phase: 'delivering',
            sourceAddress: '0x1111111111111111111111111111111111111111',
            intentNonce: 'nonce-hung'
          }
        },
        {
          id: 'agg-after',
          type: 'bridged-receive',
          accountId: 'miden-account',
          initiatedAt: Math.floor(Date.now() / 1000),
          extraInputs: { provider: 'agglayer', phase: 'delivering', evmTxHash: hash }
        }
      );
      fetchDeposits.mockResolvedValue([{ tx_hash: hash, ready_for_claim: true }]);

      const pass = reconcileBridgedReceives();
      await jest.advanceTimersByTimeAsync(EPOCH_INTENT_STATUS_TIMEOUT_MS);
      await pass;

      expect(updatePhase).toHaveBeenCalledWith('agg-after', 'ready');
      expect(updatePhase).not.toHaveBeenCalledWith('epoch-hung', expect.anything(), expect.anything());
    } finally {
      jest.useRealTimers();
    }
  });

  it('reconciles rows at once, so Epoch reads that never answer do not delay the rows after them', async () => {
    jest.useFakeTimers();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      getIntentStatus.mockReturnValue(new Promise(() => {}));
      const hash = `0x${'3'.repeat(64)}`;
      const hungEpochRow = (id: string) => ({
        id,
        type: 'bridged-receive',
        initiatedAt: Math.floor(Date.now() / 1000),
        extraInputs: {
          provider: 'epoch',
          phase: 'delivering',
          sourceAddress: '0x1111111111111111111111111111111111111111',
          intentNonce: id
        }
      });
      rows.push(hungEpochRow('epoch-hung-1'), hungEpochRow('epoch-hung-2'), {
        id: 'agg-after',
        type: 'bridged-receive',
        accountId: 'miden-account',
        initiatedAt: Math.floor(Date.now() / 1000),
        extraInputs: { provider: 'agglayer', phase: 'delivering', evmTxHash: hash }
      });
      fetchDeposits.mockResolvedValue([{ tx_hash: hash, ready_for_claim: true }]);

      const pass = reconcileBridgedReceives();
      for (let i = 0; i < 30; i += 1) await Promise.resolve();
      expect(updatePhase).toHaveBeenCalledWith('agg-after', 'ready');
      expect(getIntentStatus).toHaveBeenCalledTimes(2);

      await jest.advanceTimersByTimeAsync(EPOCH_INTENT_STATUS_TIMEOUT_MS);
      await pass;
      // Rows now warn interleaved, so each warning names its row.
      expect(warn).toHaveBeenCalledWith(
        '[bridge-receive] Epoch reconcile poll failed',
        'epoch-hung-1',
        expect.any(Error)
      );
      expect(warn).toHaveBeenCalledWith(
        '[bridge-receive] Epoch reconcile poll failed',
        'epoch-hung-2',
        expect.any(Error)
      );
    } finally {
      jest.useRealTimers();
    }
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
  it('keeps an Epoch row pending while the bridge config cannot build the SDK', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.mocked(getEpochReadOnlySdk).mockRejectedValueOnce(new Error('bridge config unavailable'));
    rows.push({
      id: 'epoch-unconfigured',
      type: 'bridged-receive',
      initiatedAt: Math.floor(Date.now() / 1000),
      extraInputs: {
        provider: 'epoch',
        phase: 'delivering',
        sourceAddress: '0x1111111111111111111111111111111111111111',
        intentNonce: 'nonce-6'
      }
    });

    await reconcileBridgedReceives();

    expect(registerBridgeIn).toHaveBeenCalled();
    expect(updatePhase).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[bridge-receive] Epoch reconcile poll failed',
      'epoch-unconfigured',
      expect.any(Error)
    );
    warn.mockRestore();
  });
});

// One Web Lock manager shared by every realm in a test: shared holders coexist,
// an exclusive request waits for them (or is refused with `ifAvailable`).
class SharedModeLocks implements BridgeReceiveLockManager {
  private shared = 0;
  private exclusive = false;
  private readonly waiting: Array<() => void> = [];

  request(
    _name: string,
    options: { mode?: 'exclusive' | 'shared'; ifAvailable?: boolean },
    callback: (lock: object | null) => Promise<void>
  ): Promise<void> {
    const shared = options.mode === 'shared';
    const free = () => !this.exclusive && (shared || this.shared === 0);
    if (!free() && options.ifAvailable) return callback(null);
    return new Promise<void>((resolve, reject) => {
      const run = () => {
        if (shared) this.shared += 1;
        else this.exclusive = true;
        void callback({})
          .then(resolve, reject)
          .finally(() => {
            if (shared) this.shared -= 1;
            else this.exclusive = false;
            this.waiting.splice(0).forEach(retry => retry());
          });
      };
      const attempt = () => (free() ? run() : this.waiting.push(attempt));
      attempt();
    });
  }
}

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(res => {
    resolve = res;
  });
  return { promise, resolve };
};

const settle = async () => {
  for (let n = 0; n < 12; n += 1) await Promise.resolve();
};

describe('deposit submissions', () => {
  const liveRow = (id: string, provider: 'agglayer' | 'epoch') => ({
    id,
    type: 'bridged-receive',
    accountId: 'miden-account',
    initiatedAt: Math.floor(Date.now() / 1000),
    extraInputs: { provider, phase: 'submitting', sourceAddress: '0x1' }
  });

  it.each(['agglayer', 'epoch'] as const)(
    'leaves a %s row alone while another page still drives it, and resumes it once that page is gone',
    async provider => {
      const locks = new SharedModeLocks();
      const depositPage = createBridgeReceiveReconciler({ getLocks: () => locks });
      const watcherPage = createBridgeReceiveReconciler({ getLocks: () => locks });
      const signing = deferred();

      const txId = await depositPage.startSubmission(
        async () => {
          rows.push(liveRow('live', provider));
          return 'live';
        },
        () => signing.promise
      );
      expect(txId).toBe('live');

      await watcherPage.reconcile();
      expect(updatePhase).not.toHaveBeenCalled();

      signing.resolve();
      await settle();
      await watcherPage.reconcile();
      // The origin-wide lock, not this realm's count, said no page still owned the row.
      expect(updatePhase).toHaveBeenCalledWith(
        'live',
        'failed',
        expect.objectContaining({
          error: expect.stringContaining('interrupted'),
          failure: { step: 'submission_interrupted', orphanCheck: 'origin_lock' }
        })
      );
    }
  );

  it('does not wait on the hash of a submission that is still being driven', async () => {
    const locks = new SharedModeLocks();
    const realm = createBridgeReceiveReconciler({ getLocks: () => locks });
    const confirming = deferred();

    await realm.startSubmission(
      async () => {
        rows.push({
          ...liveRow('hashed', 'agglayer'),
          extraInputs: { provider: 'agglayer', phase: 'submitting', evmTxHash: `0x${'3'.repeat(64)}` }
        });
        return 'hashed';
      },
      () => confirming.promise
    );
    await realm.reconcile();

    expect(waitForReceipt).not.toHaveBeenCalled();
    expect(readOutcome).not.toHaveBeenCalled();
    expect(updatePhase).not.toHaveBeenCalled();
    confirming.resolve();
  });

  it('keeps the same rule without Web Locks, including a submission that starts while the rows are read', async () => {
    const realm = createBridgeReceiveReconciler({ getLocks: () => undefined });
    const reading = deferred();
    jest.requireMock('lib/miden/repo').transactions.where.mockImplementationOnce((index: string) => ({
      equals: (value: string) => ({
        filter: (predicate: (row: any) => boolean) => ({
          toArray: async () => {
            await reading.promise;
            return rows.filter(row => row[index] === value && predicate(row));
          }
        })
      })
    }));

    const pass = realm.reconcile();
    const signing = deferred();
    await realm.startSubmission(
      async () => {
        rows.push(liveRow('mid-read', 'epoch'));
        return 'mid-read';
      },
      () => signing.promise
    );
    reading.resolve();
    await pass;
    expect(updatePhase).not.toHaveBeenCalled();

    await realm.reconcile();
    expect(updatePhase).not.toHaveBeenCalled();

    signing.resolve();
    await settle();
    await realm.reconcile();
    expect(updatePhase).toHaveBeenCalledWith(
      'mid-read',
      'failed',
      expect.objectContaining({ error: expect.stringContaining('intent') })
    );
  });

  it('does not resume a row read while its submission started and finished during the read', async () => {
    const realm = createBridgeReceiveReconciler({ getLocks: () => undefined });
    const beforeRead = deferred();
    const afterRead = deferred();
    jest.requireMock('lib/miden/repo').transactions.where.mockImplementationOnce((index: string) => ({
      equals: (value: string) => ({
        filter: (predicate: (row: any) => boolean) => ({
          toArray: async () => {
            await beforeRead.promise;
            const snapshot = rows
              .filter(row => row[index] === value && predicate(row))
              .map(row => ({ ...row, extraInputs: { ...row.extraInputs } }));
            await afterRead.promise;
            return snapshot;
          }
        })
      })
    }));

    const pass = realm.reconcile();
    const signing = deferred();
    const row: any = liveRow('finished', 'agglayer');
    await realm.startSubmission(
      async () => {
        rows.push(row);
        return 'finished';
      },
      async () => {
        await signing.promise;
        row.extraInputs = { ...row.extraInputs, phase: 'delivering', evmTxHash: `0x${'4'.repeat(64)}` };
      }
    );
    beforeRead.resolve();
    await settle();
    signing.resolve();
    await settle();
    afterRead.resolve();
    await pass;

    expect(updatePhase).not.toHaveBeenCalled();
  });

  it('rejects with the row-creation error and never drives a row that was not created', async () => {
    const realm = createBridgeReceiveReconciler({ getLocks: () => new SharedModeLocks() });
    const drive = jest.fn(async () => undefined);

    await expect(
      realm.startSubmission(async () => {
        throw new Error('dexie closed');
      }, drive)
    ).rejects.toThrow('dexie closed');
    expect(drive).not.toHaveBeenCalled();
  });
});

// A USDCx (Circle xReserve) row is driven to `delivering` by the deposit screen.
// The reconciler asks Circle for the deposit's attestation and nothing else: in
// particular it must NOT fall into the Epoch branch, which would poll the Epoch
// SDK with no intent nonce on every tick.
describe('reconcileBridgedReceives with a USDCx row', () => {
  const DEPOSIT_HASH = `0x${'5'.repeat(64)}`;
  const usdcxRow = (extraInputs: Record<string, unknown> = {}, row: Record<string, unknown> = {}) => ({
    id: 'usdcx-row',
    type: 'bridged-receive',
    accountId: 'miden-account',
    faucetId: 'usdcx-faucet',
    amount: 5_000_000n,
    initiatedAt: Math.floor(Date.now() / 1000),
    ...row,
    extraInputs: { provider: 'usdcx', phase: 'delivering', evmTxHash: DEPOSIT_HASH, ...extraInputs }
  });
  const derived = {
    remoteRecipient: 'recipient-of:miden-account',
    remoteToken: 'token-of:usdcx-faucet',
    amount: 5_000_000n
  };

  it('leaves a delivering USDCx row untouched while Circle has not attested it', async () => {
    rows.push(usdcxRow());

    await reconcileBridgedReceives();

    // A legacy row names no source chain, so the attestation module's testnet default applies.
    expect(fetchAttestations).toHaveBeenCalledWith(DEPOSIT_HASH, { baseUrl: undefined });
    expect(getIntentStatus).not.toHaveBeenCalled();
    expect(fetchDeposits).not.toHaveBeenCalled();
    expect(waitForReceipt).not.toHaveBeenCalled();
    expect(updatePhase).not.toHaveBeenCalled();
  });

  it('moves a USDCx row to ready once Circle attested what it signed', async () => {
    const list = [{ remoteDomain: 10007 }];
    fetchAttestations.mockResolvedValue(list);
    matchAttestation.mockReturnValue({ kind: 'attested' });
    rows.push(usdcxRow());

    await reconcileBridgedReceives();

    // A row written before the signed recipient was kept derives it from its own account.
    expect(matchAttestation).toHaveBeenCalledWith(list, derived);
    expect(updatePhase).toHaveBeenCalledTimes(1);
    expect(updatePhase).toHaveBeenCalledWith('usdcx-row', 'ready');
  });

  it('compares the recipient the deposit persisted rather than the one its account derives', async () => {
    const signed = `0x${'0'.repeat(32)}${'ab'.repeat(15)}00`;
    rows.push(usdcxRow({ usdcxRemoteRecipient: signed }));

    await reconcileBridgedReceives();

    expect(matchAttestation).toHaveBeenCalledWith([], { ...derived, remoteRecipient: signed });
  });

  it('derives the recipient when the one the row persisted is hex but not 32 bytes', async () => {
    rows.push(usdcxRow({ usdcxRemoteRecipient: '0xabcd' }));

    await reconcileBridgedReceives();

    expect(matchAttestation).toHaveBeenCalledWith([], derived);
  });

  it('derives the recipient when the one the row persisted is not hex', async () => {
    rows.push(usdcxRow({ usdcxRemoteRecipient: 'not-hex' }));

    await reconcileBridgedReceives();

    expect(matchAttestation).toHaveBeenCalledWith([], derived);
  });

  it.each([
    ['remoteDomain', 'Circle attested this deposit to a different network.', 'usdcx_mismatch_domain'],
    ['remoteToken', 'Circle attested this deposit to a different token.', 'usdcx_mismatch_token'],
    ['recipient', 'Circle attested this deposit to a different Miden account.', 'usdcx_mismatch_recipient'],
    ['amount', 'Circle attested this deposit to a different amount.', 'usdcx_mismatch_amount']
  ])('fails a USDCx row whose attestation differs in %s, saying so', async (field, error, step) => {
    matchAttestation.mockReturnValue({ kind: 'mismatch', field });
    rows.push(usdcxRow());

    await reconcileBridgedReceives();

    expect(updatePhase).toHaveBeenCalledTimes(1);
    expect(updatePhase).toHaveBeenCalledWith('usdcx-row', 'failed', { error, failure: { step } });
  });

  it('writes nothing for an attestation it cannot read, and warns once', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    matchAttestation.mockReturnValue({ kind: 'unreadable' });
    rows.push(usdcxRow({}, { id: 'usdcx-unreadable' }));

    await reconcileBridgedReceives();
    await reconcileBridgedReceives();

    expect(updatePhase).not.toHaveBeenCalled();
    expect(warn.mock.calls.filter(([message]) => String(message).includes('attestation unreadable'))).toHaveLength(1);
    warn.mockRestore();
  });

  it.each([
    ['names no faucet', { faucetId: undefined }],
    ['has no amount', { amount: undefined }],
    ['belongs to no account id', { accountId: 'no-account' }]
  ])('asks Circle nothing for a row that %s', async (_label, row) => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    rows.push(usdcxRow({}, row));

    await reconcileBridgedReceives();

    expect(fetchAttestations).not.toHaveBeenCalled();
    expect(updatePhase).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('makes no request for a hash that is not a transaction hash', async () => {
    rows.push(usdcxRow({ evmTxHash: 'not-a-hash' }));

    await reconcileBridgedReceives();

    expect(fetchAttestations).not.toHaveBeenCalled();
    expect(updatePhase).not.toHaveBeenCalled();
  });

  it('leaves the row for the next pass when the attestation request fails', async () => {
    fetchAttestations.mockRejectedValue(new Error('HTTP 503'));
    rows.push(usdcxRow());

    await expect(reconcileBridgedReceives()).resolves.toBeUndefined();

    expect(updatePhase).not.toHaveBeenCalled();
  });

  it("asks the attestation service of the direct row's own source chain", async () => {
    rows.push(usdcxRow({ sourceChainId: 5042002, evmTxHash: `0x${'4'.repeat(64)}` }, { id: 'usdcx-arc' }));

    await reconcileBridgedReceives();

    expect(fetchAttestations).toHaveBeenCalledWith(`0x${'4'.repeat(64)}`, {
      baseUrl: 'https://xreserve-api-testnet.circle.com'
    });
  });

  // A `ready` row is never polled again, so only the cutoff can end one whose mint never came.
  it('times out a USDCx row that has been ready for longer than the tracking age', async () => {
    rows.push(
      usdcxRow({ phase: 'ready', readyAt: WEEK_AGO_SEC }, { id: 'usdcx-stale-ready', initiatedAt: WEEK_AGO_SEC })
    );

    await reconcileBridgedReceives();

    expect(updatePhase).toHaveBeenCalledWith('usdcx-stale-ready', 'failed', {
      error: 'Bridge delivery timed out.',
      failure: { step: 'delivery_timed_out' }
    });
  });

  it('times out a ready USDCx row from before readyAt by its age', async () => {
    rows.push(usdcxRow({ phase: 'ready' }, { id: 'usdcx-legacy-ready', initiatedAt: WEEK_AGO_SEC }));

    await reconcileBridgedReceives();

    expect(updatePhase).toHaveBeenCalledWith('usdcx-legacy-ready', 'failed', {
      error: 'Bridge delivery timed out.',
      failure: { step: 'delivery_timed_out' }
    });
  });

  it('never asks Circle again about a fresh ready USDCx row, nor writes it', async () => {
    rows.push(usdcxRow({ phase: 'ready', readyAt: Math.floor(Date.now() / 1000) }));

    await reconcileBridgedReceives();

    expect(fetchAttestations).not.toHaveBeenCalled();
    expect(updatePhase).not.toHaveBeenCalled();
  });

  // The cutoff runs from when the row was attested: a deposit attested late in its week still gets its own week.
  it('keeps a USDCx row that became ready recently, however old its deposit', async () => {
    rows.push(usdcxRow({ phase: 'ready', readyAt: Math.floor(Date.now() / 1000) }, { initiatedAt: WEEK_AGO_SEC }));

    await reconcileBridgedReceives();

    expect(updatePhase).not.toHaveBeenCalled();
  });

  it.each([
    ['an AggLayer row', { provider: 'agglayer' }, {}],
    ['a USDCx row restored from a backup', {}, { restoredFromBackup: true }]
  ])('leaves %s that is ready alone', async (_label, extraInputs, row) => {
    rows.push(usdcxRow({ phase: 'ready', ...extraInputs }, { initiatedAt: WEEK_AGO_SEC, ...row }));

    await reconcileBridgedReceives();

    expect(updatePhase).not.toHaveBeenCalled();
    expect(fetchDeposits).not.toHaveBeenCalled();
  });

  it('still times out a stale USDCx row', async () => {
    rows.push({
      id: 'usdcx-old',
      type: 'bridged-receive',
      accountId: 'miden-account',
      initiatedAt: WEEK_AGO_SEC,
      extraInputs: { provider: 'usdcx', phase: 'delivering', evmTxHash: `0x${'5'.repeat(64)}` }
    });

    await reconcileBridgedReceives();

    expect(updatePhase).toHaveBeenCalledWith('usdcx-old', 'failed', {
      error: 'Bridge delivery timed out.',
      failure: { step: 'delivery_timed_out' }
    });
  });
});

// An executor-route row (Base Sepolia → Arc → Miden) has two Circle attestations: Iris attests the CCTP
// burn, which the wallet then executes on Arc, and xReserve's service attests the deposit that execute
// made. The reconciler drives each step from what the row holds, and never polls the direct route.
describe('reconcileBridgedReceives with a USDCx executor row', () => {
  const BURN_HASH = `0x${'6'.repeat(64)}`;
  const EXECUTE_HASH = `0x${'7'.repeat(64)}`;
  const IRIS = 'https://iris-api-sandbox.circle.com';
  const ATTESTATIONS = 'https://xreserve-api-testnet.circle.com';
  const executorRow = (cctp: Record<string, unknown>) => ({
    id: 'usdcx-executor-row',
    type: 'bridged-receive',
    accountId: 'miden-account',
    faucetId: 'usdcx-faucet',
    amount: 5_000_000n,
    initiatedAt: Math.floor(Date.now() / 1000),
    extraInputs: { provider: 'usdcx', phase: 'delivering', sourceChainId: 84532, evmTxHash: BURN_HASH, cctp }
  });

  it('asks Iris for the burn and keeps the attested message on the row', async () => {
    fetchAttestedMessage.mockResolvedValue({ message: '0x1234', attestation: '0xabcd' });
    rows.push(executorRow({ sourceDomain: 6 }));

    await reconcileBridgedReceives();

    expect(fetchAttestedMessage).toHaveBeenCalledWith(6, BURN_HASH, { baseUrl: IRIS });
    expect(fetchAttestations).not.toHaveBeenCalled();
    expect(updatePhase).toHaveBeenCalledTimes(1);
    expect(updatePhase).toHaveBeenCalledWith('usdcx-executor-row', 'delivering', {
      cctp: { sourceDomain: 6, message: '0x1234', attestation: '0xabcd' }
    });
  });

  it('writes nothing while Iris has not attested the burn', async () => {
    fetchAttestedMessage.mockResolvedValue(undefined);
    rows.push(executorRow({ sourceDomain: 6 }));

    await reconcileBridgedReceives();

    expect(updatePhase).not.toHaveBeenCalled();
  });

  it('waits for the user to execute once the message is held, asking Circle nothing', async () => {
    rows.push(executorRow({ sourceDomain: 6, message: '0x1234', attestation: '0xabcd' }));

    await reconcileBridgedReceives();

    expect(fetchAttestedMessage).not.toHaveBeenCalled();
    expect(fetchAttestations).not.toHaveBeenCalled();
    expect(updatePhase).not.toHaveBeenCalled();
  });

  it('asks xReserve for the execute transaction and moves the row to ready once attested', async () => {
    matchAttestation.mockReturnValue({ kind: 'attested' });
    rows.push(executorRow({ sourceDomain: 6, message: '0x1234', attestation: '0xabcd', executeTxHash: EXECUTE_HASH }));

    await reconcileBridgedReceives();

    expect(fetchAttestations).toHaveBeenCalledWith(EXECUTE_HASH, { baseUrl: ATTESTATIONS });
    expect(matchAttestation).toHaveBeenCalledWith([], {
      remoteRecipient: 'recipient-of:miden-account',
      remoteToken: 'token-of:usdcx-faucet',
      amount: 5_000_000n
    });
    expect(fetchAttestedMessage).not.toHaveBeenCalled();
    expect(readOutcome).not.toHaveBeenCalled();
    expect(updatePhase).toHaveBeenCalledWith('usdcx-executor-row', 'ready');
  });

  // The execute hash can be a forward Iris reported, so an attestation of something else fails nothing.
  it.each([
    ['attested to something else', { kind: 'mismatch', field: 'recipient' }],
    ['unreadable', { kind: 'unreadable' }]
  ])('writes nothing and warns once on an execute %s', async (_label, verdict) => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    matchAttestation.mockReturnValue(verdict);
    rows.push({
      ...executorRow({ sourceDomain: 6, message: '0x1234', attestation: '0xabcd', executeTxHash: EXECUTE_HASH }),
      id: `usdcx-executor-${verdict.kind}`
    });

    await reconcileBridgedReceives();
    await reconcileBridgedReceives();

    expect(updatePhase).not.toHaveBeenCalled();
    expect(readOutcome).not.toHaveBeenCalled();
    expect(warn.mock.calls.filter(([message]) => String(message).includes('execute attestation'))).toHaveLength(1);
    warn.mockRestore();
  });

  // The foreground hook sees a revert only while its screen is open: the reconciler reads the saved hash's Arc
  // receipt itself, so a revert seen later still gives the execute back.
  it('reopens the execute when the saved execute hash reverted on Arc', async () => {
    readOutcome.mockResolvedValue('reverted');
    rows.push(executorRow({ sourceDomain: 6, message: '0x1234', attestation: '0xabcd', executeTxHash: EXECUTE_HASH }));

    await reconcileBridgedReceives();

    expect(readOutcome).toHaveBeenCalledWith(EXECUTE_HASH, expect.objectContaining({ id: 5042002 }));
    expect(updatePhase).toHaveBeenCalledWith('usdcx-executor-row', 'delivering', {
      cctp: {
        sourceDomain: 6,
        executeTxHash: undefined,
        message: undefined,
        attestation: undefined,
        forwarded: false,
        revertedExecuteTxHash: EXECUTE_HASH
      }
    });
  });

  it('keeps a saved execute hash whose receipt has not arrived', async () => {
    rows.push(executorRow({ sourceDomain: 6, executeTxHash: EXECUTE_HASH }));

    await reconcileBridgedReceives();

    expect(readOutcome).toHaveBeenCalledTimes(1);
    expect(updatePhase).not.toHaveBeenCalled();
  });

  // A saved hash that never mines reads pending forever: past the stall window the Execute button comes back, with
  // the message the leg still holds, and xReserve is still asked about the stalled hash.
  describe('an execute that never mines', () => {
    const NOW_SEC = Math.floor(Date.now() / 1000);
    const held = { sourceDomain: 6, message: '0x1234', attestation: '0xabcd', executeTxHash: EXECUTE_HASH };
    const stalledLeg = {
      sourceDomain: 6,
      executeTxHash: undefined,
      executeSavedAt: undefined,
      stalledExecuteTxHash: EXECUTE_HASH
    };

    it('reopens the execute once the hash has been pending for the stall window', async () => {
      rows.push(executorRow({ ...held, executeSavedAt: NOW_SEC - 31 * 60 }));

      await reconcileBridgedReceives();

      expect(updatePhase).toHaveBeenCalledTimes(1);
      expect(updatePhase).toHaveBeenCalledWith('usdcx-executor-row', 'delivering', { cctp: stalledLeg });
    });

    it('waits while the hash is younger than the stall window', async () => {
      rows.push(executorRow({ ...held, executeSavedAt: NOW_SEC - 29 * 60 }));

      await reconcileBridgedReceives();

      expect(updatePhase).not.toHaveBeenCalled();
    });

    it('times a hash saved before the stamp from the deposit', async () => {
      rows.push({ ...executorRow(held), initiatedAt: NOW_SEC - 31 * 60 });

      await reconcileBridgedReceives();

      expect(updatePhase).toHaveBeenCalledWith('usdcx-executor-row', 'delivering', { cctp: stalledLeg });
    });

    it('never reopens a leg that holds no message to execute', async () => {
      rows.push(executorRow({ sourceDomain: 6, executeTxHash: EXECUTE_HASH, executeSavedAt: NOW_SEC - 31 * 60 }));

      await reconcileBridgedReceives();

      expect(updatePhase).not.toHaveBeenCalled();
    });

    it('lands the row when the stalled execute mines after all', async () => {
      matchAttestation.mockReturnValue({ kind: 'attested' });
      rows.push(
        executorRow({ sourceDomain: 6, message: '0x1234', attestation: '0xabcd', stalledExecuteTxHash: EXECUTE_HASH })
      );

      await reconcileBridgedReceives();

      expect(fetchAttestations).toHaveBeenCalledWith(EXECUTE_HASH, { baseUrl: ATTESTATIONS });
      expect(updatePhase).toHaveBeenCalledWith('usdcx-executor-row', 'ready');
    });

    it('never adopts a stalled forward again', async () => {
      fetchAttestedMessage.mockResolvedValue({
        message: '0x1234',
        attestation: '0xabcd',
        forwardState: 'COMPLETE',
        forwardTxHash: EXECUTE_HASH
      });
      rows.push(
        executorRow({
          sourceDomain: 6,
          forwarded: true,
          forwardState: 'FAILED',
          message: '0x1234',
          attestation: '0xabcd',
          stalledExecuteTxHash: EXECUTE_HASH
        })
      );

      await reconcileBridgedReceives();

      expect(updatePhase).toHaveBeenCalledTimes(1);
      expect(updatePhase).toHaveBeenCalledWith('usdcx-executor-row', 'delivering', {
        cctp: { sourceDomain: 6, forwardState: 'COMPLETE' }
      });
    });
  });

  // An attested message on Arc can be executed at any time: failing the row would hide the button that recovers it.
  it('never times out an executor row that holds a message to execute', async () => {
    rows.push({
      ...executorRow({ sourceDomain: 6, message: '0x1234', attestation: '0xabcd' }),
      initiatedAt: WEEK_AGO_SEC
    });

    await reconcileBridgedReceives();

    expect(updatePhase).not.toHaveBeenCalled();
  });

  it('still times out an executor row whose burn Circle never attested', async () => {
    rows.push({ ...executorRow({ sourceDomain: 6 }), initiatedAt: WEEK_AGO_SEC });

    await reconcileBridgedReceives();

    expect(updatePhase).toHaveBeenCalledWith('usdcx-executor-row', 'failed', {
      error: 'Bridge delivery timed out.',
      failure: { step: 'delivery_timed_out' }
    });
  });

  // An execute that mined but whose deposit Circle attests to something else never reopens: without a week from its
  // save, the row would stay delivering, and be polled, forever.
  it('times out an executor row a week after its execute hash was saved', async () => {
    readOutcome.mockResolvedValue('success');
    matchAttestation.mockReturnValue({ kind: 'mismatch', field: 'recipient' });
    rows.push({
      ...executorRow({
        sourceDomain: 6,
        message: '0x1234',
        attestation: '0xabcd',
        executeTxHash: EXECUTE_HASH,
        executeSavedAt: WEEK_AGO_SEC
      }),
      initiatedAt: WEEK_AGO_SEC
    });

    await reconcileBridgedReceives();

    expect(updatePhase).toHaveBeenCalledWith('usdcx-executor-row', 'failed', {
      error: 'Bridge delivery timed out.',
      failure: { step: 'delivery_timed_out' }
    });
  });

  it('keeps an old executor deposit whose execute hash was saved this week', async () => {
    rows.push({
      ...executorRow({
        sourceDomain: 6,
        message: '0x1234',
        attestation: '0xabcd',
        executeTxHash: EXECUTE_HASH,
        executeSavedAt: Math.floor(Date.now() / 1000) - 60
      }),
      initiatedAt: WEEK_AGO_SEC
    });

    await reconcileBridgedReceives();

    expect(updatePhase).not.toHaveBeenCalled();
  });

  // A revert drops the message for Iris to supply again, so the leg gets a week from the revert: an execute that
  // reverted late in the deposit's first week can still be retried.
  it('gives a leg a revert reopened a week of its own to read the message again', async () => {
    fetchAttestedMessage.mockResolvedValue({ message: '0x1234', attestation: '0xabcd' });
    rows.push({
      ...executorRow({
        sourceDomain: 6,
        forwarded: false,
        revertedExecuteTxHash: EXECUTE_HASH,
        revertedAt: Math.floor(Date.now() / 1000) - 60
      }),
      initiatedAt: WEEK_AGO_SEC
    });

    await reconcileBridgedReceives();

    expect(updatePhase).toHaveBeenCalledTimes(1);
    expect(updatePhase).toHaveBeenCalledWith('usdcx-executor-row', 'delivering', {
      cctp: { sourceDomain: 6, message: '0x1234', attestation: '0xabcd' }
    });
  });

  it('times out a leg a revert reopened a week ago whose message never came back', async () => {
    rows.push({
      ...executorRow({
        sourceDomain: 6,
        forwarded: false,
        revertedExecuteTxHash: EXECUTE_HASH,
        revertedAt: WEEK_AGO_SEC
      }),
      initiatedAt: WEEK_AGO_SEC
    });

    await reconcileBridgedReceives();

    expect(updatePhase).toHaveBeenCalledWith('usdcx-executor-row', 'failed', {
      error: 'Bridge delivery timed out.',
      failure: { step: 'delivery_timed_out' }
    });
  });

  it('never adopts a reverted forward again and offers the execute with the attested message', async () => {
    fetchAttestedMessage.mockResolvedValue({
      message: '0x1234',
      attestation: '0xabcd',
      forwardState: 'COMPLETE',
      forwardTxHash: EXECUTE_HASH
    });
    rows.push(executorRow({ sourceDomain: 6, forwarded: false, revertedExecuteTxHash: EXECUTE_HASH }));

    await reconcileBridgedReceives();

    expect(updatePhase).toHaveBeenCalledTimes(1);
    expect(updatePhase).toHaveBeenCalledWith('usdcx-executor-row', 'delivering', {
      cctp: { sourceDomain: 6, message: '0x1234', attestation: '0xabcd', forwardState: 'COMPLETE' }
    });
  });

  it('leaves the row for the next pass when Iris fails', async () => {
    fetchAttestedMessage.mockRejectedValue(new Error('HTTP 503'));
    rows.push(executorRow({ sourceDomain: 6 }));

    await expect(reconcileBridgedReceives()).resolves.toBeUndefined();

    expect(updatePhase).not.toHaveBeenCalled();
  });

  // A forwarded burn paid Circle to execute on Arc: the reconciler waits for Circle's transaction instead of
  // offering the execute, and records the forwarding state as it moves.
  it('records the forwarding state of a forwarded burn and never offers the execute while Circle works', async () => {
    fetchAttestedMessage.mockResolvedValue({ message: '0x1234', attestation: '0xabcd', forwardState: 'PENDING' });
    rows.push(executorRow({ sourceDomain: 6, forwarded: true }));

    await reconcileBridgedReceives();

    expect(updatePhase).toHaveBeenCalledTimes(1);
    expect(updatePhase).toHaveBeenCalledWith('usdcx-executor-row', 'delivering', {
      cctp: { sourceDomain: 6, forwardState: 'PENDING' }
    });
  });

  it('writes nothing while the forwarding state has not moved', async () => {
    fetchAttestedMessage.mockResolvedValue({ message: '0x1234', attestation: '0xabcd', forwardState: 'PENDING' });
    rows.push(executorRow({ sourceDomain: 6, forwarded: true, forwardState: 'PENDING' }));

    await reconcileBridgedReceives();

    expect(updatePhase).not.toHaveBeenCalled();
  });

  it("takes Circle's forward transaction as the execute hash", async () => {
    fetchAttestedMessage.mockResolvedValue({
      message: '0x1234',
      attestation: '0xabcd',
      forwardState: 'COMPLETE',
      forwardTxHash: EXECUTE_HASH
    });
    rows.push(executorRow({ sourceDomain: 6, forwarded: true, forwardState: 'PENDING' }));

    await reconcileBridgedReceives();

    // Only onto a leg that holds no execute hash: a manual execute saved meanwhile stands.
    expect(updatePhase).toHaveBeenCalledWith(
      'usdcx-executor-row',
      'delivering',
      { cctp: { sourceDomain: 6, executeTxHash: EXECUTE_HASH, forwardState: 'COMPLETE' } },
      undefined,
      { onlyIfNoExecuteHash: true }
    );
  });

  it('falls back to the manual execute when Circle gives up on the forward', async () => {
    fetchAttestedMessage.mockResolvedValue({ message: '0x1234', attestation: '0xabcd', forwardState: 'FAILED' });
    rows.push(executorRow({ sourceDomain: 6, forwarded: true, forwardState: 'PENDING' }));

    await reconcileBridgedReceives();

    expect(updatePhase).toHaveBeenCalledWith('usdcx-executor-row', 'delivering', {
      cctp: { sourceDomain: 6, message: '0x1234', attestation: '0xabcd', forwardState: 'FAILED' }
    });
  });
});

it.each(['epoch', 'agglayer', 'usdcx'])(
  'Task4C2 owners keeps an attempted %s source unresolved when no hash was returned',
  async provider => {
    rows.push({
      id: 'ambiguous-attempt',
      type: 'bridged-receive',
      accountId: 'miden-account',
      initiatedAt: Math.floor(Date.now() / 1000),
      extraInputs: { provider, phase: 'submitting', sourceSubmission: 'attempted' }
    });
    await reconcileBridgedReceives();
    expect(updatePhase).not.toHaveBeenCalled();
    expect(readOutcome).not.toHaveBeenCalled();
  }
);
it('Task4C2 owners still closes a proven never-started orphan without a source hash', async () => {
  rows.push({
    id: 'never-started',
    type: 'bridged-receive',
    accountId: 'miden-account',
    initiatedAt: Math.floor(Date.now() / 1000),
    extraInputs: { provider: 'agglayer', phase: 'submitting', sourceSubmission: 'not-started' }
  });
  await reconcileBridgedReceives();
  expect(updatePhase).toHaveBeenCalledWith(
    'never-started',
    'failed',
    expect.objectContaining({ failure: expect.objectContaining({ step: 'submission_interrupted' }) })
  );
});
