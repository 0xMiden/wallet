/* eslint-disable import/first */
/**
 * C1 regression test — the single most important safety-critical test
 * in the whole PR.
 *
 * Round-1 review found that all three preview formatters in dapp.ts
 * (`generatePromisifyTransaction`, `generatePromisifySendTransaction`,
 * `generatePromisifyConsumeTransaction`) called `reject(new Error(…))`
 * inside their preview-error catch blocks BUT did not `return;`
 * afterwards. Execution then flowed into the confirmation modal and,
 * on user approve, the wallet **signed and broadcast a transaction
 * whose preview had failed**, while the dApp's own promise had already
 * been marked rejected.
 *
 * The fix was a one-line `return;` after each `reject(...)`. This
 * file locks that behavior down: we force each preview to throw and
 * assert the signing function is NEVER called.
 *
 * We do the forcing by controlling `withUnlocked` — the first call (the
 * preview wrapper) throws on demand, and we then assert that the
 * signing callback (a second `withUnlocked(async () => initiate…)`) is
 * never reached.
 */

import { MidenDAppMessageType, MidenDAppErrorType } from 'lib/adapter/types';

// ── Mocks ──────────────────────────────────────────────────────────

const mockWithUnlocked = jest.fn(async (fn: (ctx: unknown) => unknown) => fn({ vault: {} }));

jest.mock('lib/miden/back/store', () => ({
  store: {
    getState: () => ({ currentAccount: { publicKey: 'miden-account-1' } })
  },
  withUnlocked: (fn: (ctx: unknown) => unknown) => mockWithUnlocked(fn)
}));

const mockInitiateSendTransaction = jest.fn();
const mockRequestCustomTransaction = jest.fn();
const mockInitiateConsumeTransactionFromId = jest.fn();
const mockWaitForTransactionCompletion = jest.fn();

jest.mock('lib/miden/activity/transactions', () => ({
  initiateSendTransaction: (...args: unknown[]) => mockInitiateSendTransaction(...args),
  requestCustomTransaction: (...args: unknown[]) => mockRequestCustomTransaction(...args),
  initiateConsumeTransactionFromId: (...args: unknown[]) => mockInitiateConsumeTransactionFromId(...args),
  waitForTransactionCompletion: (...args: unknown[]) => mockWaitForTransactionCompletion(...args)
}));

const mockQueueNoteImport = jest.fn();
jest.mock('lib/miden/activity', () => ({
  queueNoteImport: (...args: unknown[]) => mockQueueNoteImport(...args)
}));

const mockStartTransactionProcessing = jest.fn();
jest.mock('lib/miden/back/transaction-processor', () => ({
  startTransactionProcessing: () => mockStartTransactionProcessing()
}));

// The mobile/desktop branch is the one the fix lives on. Force
// isExtension() to return false so every test exercises that path.
jest.mock('lib/platform', () => ({
  isExtension: () => false,
  isDesktop: () => false,
  isMobile: () => true
}));

// Pre-seed the dApp session store so getDApp returns a matching entry.
const STORED_SESSION = {
  network: 'testnet',
  appMeta: { name: 'Miden Test', url: 'https://miden.xyz' },
  accountId: 'miden-account-1',
  privateDataPermission: 'None',
  allowedPrivateData: {},
  publicKey: 'miden-account-1'
};

// STORAGE_KEY in dapp.ts is the literal 'dapp_sessions'. The storage
// provider's `get([key])` returns `{ [key]: value }`, so we pre-seed
// the dApp sessions map under that exact key so getDApp() finds our
// STORED_SESSION for https://miden.xyz during the test path.
jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => ({
    get: async () => ({
      dapp_sessions: {
        'https://miden.xyz': [STORED_SESSION]
      }
    }),
    set: async () => undefined
  })
}));

// getTokenMetadata is consulted by formatConsumeTransactionPreview.
// Default: return undefined so the formatter runs clean. Individual
// tests can override it to throw for the consume preview-error case.
const mockGetTokenMetadata = jest.fn();
jest.mock('lib/miden/metadata/utils', () => ({
  getTokenMetadata: (...args: unknown[]) => mockGetTokenMetadata(...args)
}));

// The confirmation store — we capture its requestConfirmation so we
// can assert that user-approval logic is never even reached on the
// preview-error path. If these assertions fire, the fix regressed.
const mockRequestConfirmation = jest.fn();
jest.mock('lib/dapp-browser/confirmation-store', () => ({
  dappConfirmationStore: {
    requestConfirmation: (...args: unknown[]) => mockRequestConfirmation(...args),
    resolveConfirmation: jest.fn(),
    hasPendingRequest: jest.fn(() => false),
    getPendingRequest: jest.fn(() => null),
    getAllPendingRequests: jest.fn(() => []),
    subscribe: jest.fn(() => () => undefined),
    getInstanceId: () => 'test-store'
  }
}));

jest.mock('lib/miden/back/defaults', () => ({
  intercom: { broadcast: jest.fn() }
}));

jest.mock('lib/miden/back/vault', () => ({
  Vault: {
    getCurrentAccountPublicKey: jest.fn().mockResolvedValue('miden-account-1')
  }
}));

// ── Imports under test ─────────────────────────────────────────────
// Imported AFTER the mocks so dapp.ts uses the mocked modules.
import { requestSendTransaction, requestTransaction, requestConsumeTransaction } from './dapp';

beforeEach(() => {
  jest.clearAllMocks();
  mockGetTokenMetadata.mockResolvedValue(undefined);
  // Default: withUnlocked calls the callback; tests that want to
  // force a preview error override the first call via mockImplementationOnce.
  mockWithUnlocked.mockImplementation(async (fn: (ctx: unknown) => unknown) => fn({ vault: {} }));
});

// ── Send transaction path ──────────────────────────────────────────

describe('C1 regression: requestSendTransaction preview error', () => {
  const sendReq = {
    type: MidenDAppMessageType.SendTransactionRequest,
    sourcePublicKey: 'miden-account-1',
    transaction: {
      senderAddress: 'sender',
      recipientAddress: 'recipient',
      faucetId: 'faucet',
      noteType: 'Public',
      amount: 100,
      recallBlocks: 0
    }
  } as unknown as Parameters<typeof requestSendTransaction>[1];

  it('rejects the dApp promise when the preview formatter throws', async () => {
    // First withUnlocked call is the preview wrapper — make it throw.
    mockWithUnlocked.mockImplementationOnce(async () => {
      throw new Error('preview formatter blew up');
    });

    await expect(requestSendTransaction('https://miden.xyz', sendReq, 'session-1')).rejects.toThrow(
      new RegExp(MidenDAppErrorType.InvalidParams)
    );
  });

  it('does NOT call initiateSendTransaction when the preview formatter throws', async () => {
    mockWithUnlocked.mockImplementationOnce(async () => {
      throw new Error('preview formatter blew up');
    });
    try {
      await requestSendTransaction('https://miden.xyz', sendReq, 'session-1');
    } catch {
      // Expected — the promise rejects. Ignore.
    }
    expect(mockInitiateSendTransaction).not.toHaveBeenCalled();
    expect(mockStartTransactionProcessing).not.toHaveBeenCalled();
  });

  it('does NOT show the user a confirmation modal when the preview formatter throws', async () => {
    // The confirmation modal would be bogus (no preview strings to show).
    mockWithUnlocked.mockImplementationOnce(async () => {
      throw new Error('preview formatter blew up');
    });
    try {
      await requestSendTransaction('https://miden.xyz', sendReq, 'session-1');
    } catch {
      /* expected */
    }
    expect(mockRequestConfirmation).not.toHaveBeenCalled();
  });
});

// ── Custom transaction path ────────────────────────────────────────

describe('C1 regression: requestTransaction (custom) preview error', () => {
  const customReq = {
    type: MidenDAppMessageType.TransactionRequest,
    sourcePublicKey: 'miden-account-1',
    transaction: {
      payload: {
        address: 'sender',
        transactionRequest: 'tx',
        recipientAddress: 'recipient',
        inputNoteIds: [],
        importNotes: []
      }
    }
  } as unknown as Parameters<typeof requestTransaction>[1];

  it('does NOT call requestCustomTransaction when the preview formatter throws', async () => {
    mockWithUnlocked.mockImplementationOnce(async () => {
      throw new Error('preview formatter blew up');
    });
    try {
      await requestTransaction('https://miden.xyz', customReq, 'session-1');
    } catch {
      /* expected */
    }
    expect(mockRequestCustomTransaction).not.toHaveBeenCalled();
    expect(mockRequestConfirmation).not.toHaveBeenCalled();
  });

  it('does NOT call requestCustomTransaction when the nested validator throws on missing address', async () => {
    // Second C1 sub-case: the `if (!customTransaction.address ||
    // !customTransaction.transactionRequest) throw ...` validator
    // was converted from `reject(...)` to `throw` as part of the C1
    // fix. This test guards that path: a payload missing `address`
    // should trigger the nested throw → outer catch → reject →
    // RETURN without reaching the signing call.
    const invalidReq = {
      type: MidenDAppMessageType.TransactionRequest,
      sourcePublicKey: 'miden-account-1',
      transaction: {
        payload: {
          // address intentionally omitted
          transactionRequest: 'tx'
        }
      }
    } as unknown as Parameters<typeof requestTransaction>[1];

    // Let withUnlocked run its callback normally so the nested
    // validator (which sits INSIDE the callback) can throw.
    try {
      await requestTransaction('https://miden.xyz', invalidReq, 'session-1');
    } catch {
      /* expected */
    }
    expect(mockRequestCustomTransaction).not.toHaveBeenCalled();
    expect(mockRequestConfirmation).not.toHaveBeenCalled();
  });
});

// ── Consume transaction path ───────────────────────────────────────

describe('C1 regression: requestConsumeTransaction preview error', () => {
  const consumeReq = {
    type: MidenDAppMessageType.ConsumeRequest,
    sourcePublicKey: 'miden-account-1',
    transaction: {
      noteId: 'note-1',
      faucetId: 'faucet-1',
      amount: 100,
      noteType: 'Public'
    }
  } as unknown as Parameters<typeof requestConsumeTransaction>[1];

  it('does NOT call initiateConsumeTransactionFromId when the preview formatter throws', async () => {
    mockWithUnlocked.mockImplementationOnce(async () => {
      throw new Error('preview formatter blew up');
    });
    try {
      await requestConsumeTransaction('https://miden.xyz', consumeReq, 'session-1');
    } catch {
      /* expected */
    }
    expect(mockInitiateConsumeTransactionFromId).not.toHaveBeenCalled();
    expect(mockRequestConfirmation).not.toHaveBeenCalled();
  });
});
