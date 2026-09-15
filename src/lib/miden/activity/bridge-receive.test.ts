import * as Repo from 'lib/miden/repo';

import { BridgeReceiveLockManager, createBridgeReceiveReconciler, reconcileBridgedReceives } from './bridge-receive';

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

    expect(Repo.transactions.filter).toHaveBeenCalledTimes(1);
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

    await reconcileBridgedReceives();

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

    expect(resolveNoteId).toHaveBeenCalledWith('0x1111111111111111111111111111111111111111', 'nonce-2', '0xnote-1');
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
      expect(updatePhase).toHaveBeenCalledWith(
        'live',
        'failed',
        expect.objectContaining({ error: expect.stringContaining('interrupted') })
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
    expect(updatePhase).not.toHaveBeenCalled();
    confirming.resolve();
  });

  it('keeps the same rule without Web Locks, including a submission that starts while the rows are read', async () => {
    const realm = createBridgeReceiveReconciler({ getLocks: () => undefined });
    const reading = deferred();
    jest
      .requireMock('lib/miden/repo')
      .transactions.filter.mockImplementationOnce((predicate: (row: any) => boolean) => ({
        toArray: async () => {
          await reading.promise;
          return rows.filter(predicate);
        }
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
    jest
      .requireMock('lib/miden/repo')
      .transactions.filter.mockImplementationOnce((predicate: (row: any) => boolean) => ({
        toArray: async () => {
          await beforeRead.promise;
          const snapshot = rows.filter(predicate).map(row => ({ ...row, extraInputs: { ...row.extraInputs } }));
          await afterRead.promise;
          return snapshot;
        }
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
