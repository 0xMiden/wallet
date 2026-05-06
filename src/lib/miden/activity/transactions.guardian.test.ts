/**
 * Guardian-specific paths through lib/miden/activity/transactions.ts:
 *   - initiateSwitchGuardianTransaction — rejects non-Guardian accounts,
 *     otherwise enqueues a SwitchGuardianTransaction row.
 *   - completeSwitchGuardianTransaction — registers the post-switch state
 *     with the new guardian, flips the stored URL, evicts the cached
 *     MultisigService, and marks the tx Completed. Failure path marks
 *     Failed without touching storage.
 *   - generateTransaction — routes a Guardian-typed account through the
 *     Guardian flow (createSendProposal → signAndCreateTransactionRequest
 *     → submit → completeSendTransaction).
 */

import {
  completeSwitchGuardianTransaction,
  generateTransaction,
  initiateSwitchGuardianTransaction
} from './transactions';
import { ITransactionStatus, SwitchGuardianTransaction } from '../db/types';

const txStore: Array<Record<string, unknown>> = [];
const putToStorage = jest.fn(async (..._args: unknown[]) => {});

jest.mock('lib/miden/repo', () => ({
  db: { transaction: async (_mode: string, _t: unknown, cb: () => unknown) => cb() },
  transactions: {
    add: jest.fn(async (tx: Record<string, unknown>) => {
      txStore.push({ ...tx });
    }),
    where: jest.fn((query: { id: string }) => ({
      modify: jest.fn(async (fn: (tx: Record<string, unknown>) => void) => {
        const row = txStore.find(r => r.id === query.id);
        if (row) fn(row);
      }),
      first: jest.fn(async () => txStore.find(r => r.id === query.id))
    })),
    filter: jest.fn(() => ({ toArray: jest.fn(async () => []) }))
  }
}));

// transactions.ts imports putToStorage from '../front' (the barrel), not directly from './storage'.
jest.mock('../front', () => ({
  putToStorage: (...a: unknown[]) => putToStorage(...a),
  fetchFromStorage: jest.fn(),
  onStorageChanged: jest.fn()
}));

jest.mock('lib/settings/constants', () => ({
  GUARDIAN_URL_STORAGE_KEY: 'guardian_url_setting'
}));

const mockIsGuardianAccount = jest.fn();
const mockGetOrCreateMultisigService = jest.fn();
const mockClearGuardianServiceFor = jest.fn();
// transactions.ts imports via 'lib/miden/front/guardian-manager' (aliased).
jest.mock('lib/miden/front/guardian-manager', () => ({
  isGuardianAccount: (...a: unknown[]) => mockIsGuardianAccount(...a),
  getOrCreateMultisigService: (...a: unknown[]) => mockGetOrCreateMultisigService(...a),
  clearGuardianServiceFor: (...a: unknown[]) => mockClearGuardianServiceFor(...a)
}));

const mockWithWasmClientLock = jest.fn(async (fn: () => Promise<unknown>) => fn());
const mockGetMidenClient = jest.fn();
// Match the relative path used by transactions.ts so the mock intercepts.
jest.mock('../sdk/miden-client', () => ({
  withWasmClientLock: (...a: unknown[]) => mockWithWasmClientLock(...(a as [() => Promise<unknown>])),
  getMidenClient: (...a: unknown[]) => mockGetMidenClient(...a)
}));

jest.mock('lib/intercom', () => ({
  getIntercom: () => ({ broadcast: jest.fn(), request: jest.fn() })
}));

jest.mock('lib/store', () => ({
  useWalletStore: { getState: () => ({ accounts: [], setLastCompletedTxHash: jest.fn() }) }
}));

jest.mock('lib/miden/sdk/helpers', () => ({
  accountIdStringToSdk: (id: string) => ({ toString: () => `sdk-${id}` })
}));

jest.mock('@miden-sdk/miden-sdk/lazy', () => {
  const actual = jest.requireActual('../../../../__mocks__/wasmMock.js');
  return {
    ...actual,
    TransactionProver: { newLocalProver: jest.fn(() => 'local-prover') }
  };
});

jest.mock('shared/logger', () => ({
  logger: { warning: jest.fn(), error: jest.fn(), info: jest.fn() }
}));

const makeResult = () => ({
  executedTransaction: () => ({
    id: () => ({ toHex: () => 'exec-tx-hash' }),
    outputNotes: () => ({ notes: () => [] }),
    inputNotes: () => ({ notes: () => [] })
  }),
  serialize: () => new Uint8Array([9, 9, 9])
});

const makeGuardianProvider = (isGuardian: boolean) => {
  mockIsGuardianAccount.mockResolvedValue(isGuardian);
  return {
    getAccounts: async () => [],
    getPublicKeyForCommitment: async () => 'pk',
    signWord: async () => 'sig'
  };
};

describe('initiateSwitchGuardianTransaction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    txStore.length = 0;
  });

  it('queues a SwitchGuardianTransaction row when the account is Guardian', async () => {
    const provider = makeGuardianProvider(true);

    const id = await initiateSwitchGuardianTransaction('acc-1', 'https://new.guardian', false, provider);

    expect(id).toBeDefined();
    expect(txStore).toHaveLength(1);
    const row = txStore[0] as Record<string, unknown>;
    expect(row.accountId).toBe('acc-1');
    expect(row.type).toBe('switch-guardian');
    const extra = row.extraInputs as Record<string, unknown>;
    expect(extra.newGuardianEndpoint).toBe('https://new.guardian');
  });

  it('throws when the target account is not a Guardian account', async () => {
    const provider = makeGuardianProvider(false);

    await expect(initiateSwitchGuardianTransaction('acc-public', 'https://new', false, provider)).rejects.toThrow(
      'Switch guardian is only supported for Guardian accounts'
    );
    expect(txStore).toHaveLength(0);
  });
});

describe('completeSwitchGuardianTransaction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    txStore.length = 0;
  });

  it('registers state with the new guardian, persists the URL, and marks the row Completed', async () => {
    const tx = new SwitchGuardianTransaction('acc-1', 'https://new.guardian', false);
    txStore.push({ id: tx.id, status: ITransactionStatus.GeneratingTransaction });

    const multisigService = {
      finalizeGuardianSwitch: jest.fn(async () => {})
    };

    await completeSwitchGuardianTransaction(tx, makeResult() as never, multisigService as never);

    expect(multisigService.finalizeGuardianSwitch).toHaveBeenCalledWith('https://new.guardian');
    expect(putToStorage).toHaveBeenCalledWith('guardian_url_setting', 'https://new.guardian');
    expect(mockClearGuardianServiceFor).toHaveBeenCalledWith('acc-1');

    const row = txStore.find(r => r.id === tx.id) as Record<string, unknown>;
    expect(row.status).toBe(ITransactionStatus.Completed);
    expect(row.displayMessage).toBe('Guardian switched');
  });

  it('marks the row Failed and skips the storage flip when registration throws', async () => {
    const tx = new SwitchGuardianTransaction('acc-1', 'https://new.guardian', false);
    txStore.push({ id: tx.id, status: ITransactionStatus.GeneratingTransaction });

    const multisigService = {
      finalizeGuardianSwitch: jest.fn(async () => {
        throw new Error('register failed');
      })
    };

    await completeSwitchGuardianTransaction(tx, makeResult() as never, multisigService as never);

    // The URL was NOT persisted because the guardian rejected the new state.
    expect(putToStorage).not.toHaveBeenCalled();
    const row = txStore.find(r => r.id === tx.id) as Record<string, unknown>;
    expect(row.status).toBe(ITransactionStatus.Failed);
    expect(row.displayMessage).toBe('Failed to switch guardian');
    expect(row.error).toBe('register failed');
  });
});

describe('generateTransaction — Guardian routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    txStore.length = 0;
  });

  it('Guardian send: builds a proposal, signs it, submits the request, and completes the row', async () => {
    const txId = 'send-guardian-1';
    const result = makeResult();
    txStore.push({
      id: txId,
      type: 'send',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      displayMessage: 'Queued',
      displayIcon: 'DEFAULT',
      secondaryAccountId: 'recipient',
      faucetId: 'faucet',
      amount: '1000',
      delegateTransaction: false,
      initiatedAt: Math.floor(Date.now() / 1000)
    });

    const multisigService = {
      createSendProposal: jest.fn(async () => ({ id: 'prop-1' })),
      signAndCreateTransactionRequest: jest.fn(async () => ({ serialize: () => new Uint8Array([1]) })),
      sync: jest.fn(async () => {})
    };
    mockGetOrCreateMultisigService.mockResolvedValue(multisigService);

    // The pre-guardian sync call uses midenClient.syncState() directly; the
    // post-proposal submit goes via midenClient.client.transactions.submit(..).
    mockGetMidenClient.mockResolvedValue({
      syncState: jest.fn(async () => {}),
      client: {
        transactions: {
          submit: jest.fn(async () => ({ result }))
        }
      }
    });

    const provider = makeGuardianProvider(true);
    const signCallback = jest.fn(async () => new Uint8Array([2]));

    await generateTransaction(
      {
        id: txId,
        type: 'send',
        accountId: 'guardian-acc',
        secondaryAccountId: 'recipient',
        faucetId: 'faucet',
        amount: '1000',
        delegateTransaction: false
      } as never,
      signCallback,
      false,
      provider
    );

    expect(multisigService.createSendProposal).toHaveBeenCalledWith('recipient', 'faucet', 1000n);
    expect(multisigService.signAndCreateTransactionRequest).toHaveBeenCalledWith('prop-1');
    expect(multisigService.sync).toHaveBeenCalled();
  });

  it('Guardian consume: builds a consume-notes proposal off the noteId', async () => {
    const txId = 'consume-guardian-1';
    const result = makeResult();
    const multisigService = {
      createConsumeNotesProposal: jest.fn(async () => ({ id: 'prop-consume' })),
      signAndCreateTransactionRequest: jest.fn(async () => ({ serialize: () => new Uint8Array([1]) })),
      sync: jest.fn(async () => {})
    };
    mockGetOrCreateMultisigService.mockResolvedValue(multisigService);
    mockGetMidenClient.mockResolvedValue({
      syncState: jest.fn(async () => {}),
      client: { transactions: { submit: jest.fn(async () => ({ result })) } }
    });
    txStore.push({
      id: txId,
      type: 'consume',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      noteId: 'note-xyz'
    });

    await generateTransaction(
      {
        id: txId,
        type: 'consume',
        accountId: 'guardian-acc',
        noteId: 'note-xyz',
        delegateTransaction: false
      } as never,
      jest.fn(async () => new Uint8Array([1])),
      false,
      makeGuardianProvider(true)
    );

    expect(multisigService.createConsumeNotesProposal).toHaveBeenCalledWith(['note-xyz']);
  });

  it('Guardian switch-guardian: waits for chain inclusion before finalizing the switch', async () => {
    const txId = 'switch-guardian-1';
    const result = makeResult();
    txStore.push({
      id: txId,
      type: 'switch-guardian',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued,
      extraInputs: { newGuardianEndpoint: 'https://new.guardian' }
    });

    const multisigService = {
      createSwitchGuardianProposal: jest.fn(async () => ({
        proposal: { id: 'prop-switch' },
        newEndpoint: 'https://new.guardian'
      })),
      signAndCreateTransactionRequest: jest.fn(async () => ({ serialize: () => new Uint8Array([1]) })),
      finalizeGuardianSwitch: jest.fn(async () => {}),
      sync: jest.fn(async () => {})
    };
    mockGetOrCreateMultisigService.mockResolvedValue(multisigService);

    const waitForTransactionCommit = jest.fn(async () => {});
    mockGetMidenClient.mockResolvedValue({
      syncState: jest.fn(async () => {}),
      waitForTransactionCommit,
      client: { transactions: { submit: jest.fn(async () => ({ result })) } }
    });

    await generateTransaction(
      {
        id: txId,
        type: 'switch-guardian',
        accountId: 'guardian-acc',
        extraInputs: { newGuardianEndpoint: 'https://new.guardian' },
        delegateTransaction: false
      } as never,
      jest.fn(async () => new Uint8Array([1])),
      false,
      makeGuardianProvider(true)
    );

    // The switch-guardian path must build the proposal via createSwitchGuardianProposal,
    // wait for on-chain inclusion, and then finalize the switch (registering post-switch state).
    expect(multisigService.createSwitchGuardianProposal).toHaveBeenCalledWith('https://new.guardian');
    expect(waitForTransactionCommit).toHaveBeenCalledWith('exec-tx-hash');
    expect(multisigService.finalizeGuardianSwitch).toHaveBeenCalledWith('https://new.guardian');
  });

  it('Guardian: unsupported transaction type cancels the transaction', async () => {
    const txId = 'unsupported-guardian';
    txStore.push({
      id: txId,
      type: 'execute',
      accountId: 'guardian-acc',
      status: ITransactionStatus.Queued
    });
    mockGetMidenClient.mockResolvedValue({
      syncState: jest.fn(async () => {}),
      client: { transactions: { submit: jest.fn() } }
    });
    mockGetOrCreateMultisigService.mockResolvedValue({});

    // generateGuardianTransaction throws on 'execute'; generateTransaction
    // swallows it via cancelTransaction and marks the row Failed.
    await generateTransaction(
      { id: txId, type: 'execute', accountId: 'guardian-acc', delegateTransaction: false } as never,
      jest.fn(),
      false,
      makeGuardianProvider(true)
    );

    const row = txStore.find(r => r.id === txId) as Record<string, unknown>;
    expect(row.status).toBe(ITransactionStatus.Failed);
  });
});
