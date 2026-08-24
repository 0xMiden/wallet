/* eslint-disable import/first */
/**
 * What the mobile and desktop approval sheets say a custom transaction will do.
 *
 * A custom transaction is an opaque base64 `TransactionRequest`: it can do
 * anything the account can. The extension's approval page resolves that by
 * asking the background to dry-run it and rendering the asset movements that
 * come back. The confirmation-store sheets on mobile and desktop have no route
 * to that call, so they used to render `formatCustomTransactionPreview` alone —
 * a fixed "please ensure you know the details" plus a recipient — which is
 * consent to an unnamed transfer of an unnamed amount.
 *
 * These tests drive `dapp.ts` with `isExtension()` forced false, which is the
 * only branch that reaches `dappConfirmationStore`, and assert on the message
 * list the sheet renders. `playwright/tests/dapp-provider.spec.ts` is
 * Chromium/MV3-only and never enters this branch.
 */

import { MidenDAppErrorType, MidenDAppMessageType } from 'lib/adapter/types';

// ── Mocks ──────────────────────────────────────────────────────────
// Scaffold mirrors `dapp.send-preview.test.ts`: `dapp.ts` pulls in the vault,
// the transaction pipeline and the storage adapter at module scope.

jest.mock('lib/miden/back/store', () => ({
  store: {
    getState: () => ({ currentAccount: { publicKey: 'miden-account-1' } })
  },
  withUnlocked: (fn: (ctx: unknown) => unknown) => fn({ vault: {} })
}));

const mockRequestCustomTransaction = jest.fn(async () => 'tx-id-1');

jest.mock('lib/miden/transaction', () => ({
  initiateSendTransaction: jest.fn(),
  requestCustomTransaction: (...args: unknown[]) => mockRequestCustomTransaction(...(args as [])),
  initiateConsumeTransactionFromId: jest.fn(),
  waitForTransactionCompletion: jest.fn()
}));

jest.mock('lib/miden/activity', () => ({ queueNoteImport: jest.fn() }));

jest.mock('lib/miden/back/transaction-processor', () => ({
  startTransactionProcessing: jest.fn()
}));

jest.mock('lib/platform', () => ({
  isExtension: () => false,
  isDesktop: () => false,
  isMobile: () => true
}));

jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => ({
    get: async () => ({
      dapp_sessions: {
        'https://miden.xyz': [
          {
            network: 'testnet',
            appMeta: { name: 'Custom App', url: 'https://miden.xyz' },
            accountId: 'miden-account-1',
            privateDataPermission: 'None',
            allowedPrivateData: {},
            publicKey: 'miden-account-1'
          }
        ]
      }
    }),
    set: async () => undefined
  })
}));

const mockGetTokenMetadata = jest.fn();
jest.mock('lib/miden/metadata/utils', () => ({
  getTokenMetadata: (...args: unknown[]) => mockGetTokenMetadata(...args)
}));

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

jest.mock('lib/miden/back/defaults', () => ({ intercom: { broadcast: jest.fn() } }));

jest.mock('lib/miden/back/vault', () => ({
  Vault: { getCurrentAccountPublicKey: jest.fn().mockResolvedValue('miden-account-1') }
}));

/** The dry run itself is covered by `simulate-custom-tx.test.ts`. */
const mockSimulate = jest.fn();
jest.mock('./simulate-custom-tx', () => ({
  simulateCustomTransaction: (...args: unknown[]) => mockSimulate(...args)
}));

/**
 * Decoding a `TransactionSummary` is covered by `app/confirm/decode.test.ts`
 * against the SDK types; what is under test here is whether the decoded view
 * reaches the user, so the view is supplied directly.
 */
const mockSummaryBytesToView = jest.fn();
jest.mock('app/confirm/decode', () => ({
  summaryBytesToView: (...args: unknown[]) => mockSummaryBytesToView(...args)
}));

const mockReleaseNoteIds = jest.fn(async () => undefined);
jest.mock('lib/miden/note-quarantine', () => ({
  importedNoteIds: (notes: string[] | undefined) => (notes ?? []).map(n => `id:${n}`),
  quarantineNoteIds: jest.fn(),
  releaseNoteIds: (...args: unknown[]) => mockReleaseNoteIds(...(args as []))
}));

jest.unmock('lib/i18n/numbers');

// ── Imports under test ─────────────────────────────────────────────
import { requestTransaction } from './dapp';

const DAPP_ORIGIN = 'https://miden.xyz';

/** A view with nothing in it, so each test states only the part it is about. */
const emptyView = {
  account: 'miden-account-1',
  outgoing: [],
  incoming: [],
  inputNotesConsumed: 0,
  outputNotesCreated: 0,
  storageChanged: false
};

const customRequest = (overrides: Record<string, unknown> = {}) =>
  ({
    type: MidenDAppMessageType.TransactionRequest,
    sourcePublicKey: 'miden-account-1',
    transaction: {
      payload: {
        // The session's own account: the custom path is bound to it, so a
        // foreign address never reaches a sheet at all.
        address: 'miden-account-1',
        transactionRequest: 'reqB64',
        recipientAddress: 'mtst1recipient',
        inputNoteIds: [],
        importNotes: ['noteB64'],
        ...overrides
      }
    }
  }) as unknown as Parameters<typeof requestTransaction>[1];

/**
 * The message list the wallet put in front of the user. The exactly-once check
 * is load-bearing: a request that rejected before reaching the sheet declines
 * with the same error a user's Deny does.
 */
const sheetMessages = (): string[] => {
  expect(mockRequestConfirmation).toHaveBeenCalledTimes(1);
  return (mockRequestConfirmation.mock.calls[0]![0] as { transactionMessages: string[] }).transactionMessages;
};

/** Drives one request through to the user's decision. */
const raiseSheet = async (confirmed: boolean, overrides: Record<string, unknown> = {}) => {
  mockRequestConfirmation.mockResolvedValueOnce({ confirmed });
  const call = requestTransaction(DAPP_ORIGIN, customRequest(overrides), 'session-1');
  if (confirmed) {
    await call;
  } else {
    await expect(call).rejects.toThrow(MidenDAppErrorType.NotGranted);
  }
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetTokenMetadata.mockResolvedValue({ decimals: 6, symbol: 'MIDEN' });
  mockSimulate.mockResolvedValue({ summaryBytes: 'sumB64' });
  mockSummaryBytesToView.mockReturnValue(emptyView);
  mockRequestCustomTransaction.mockResolvedValue('tx-id-1' as never);
});

describe('the mobile/desktop custom-transaction sheet states the simulated effects', () => {
  it('dry-runs the request the user is being asked about, on the bound account', async () => {
    await raiseSheet(false);

    expect(mockSimulate).toHaveBeenCalledWith({
      address: 'miden-account-1',
      transactionRequest: 'reqB64',
      importNotes: ['noteB64']
    });
    expect(mockSummaryBytesToView).toHaveBeenCalledWith('sumB64');
  });

  // The point of the fix: what the transaction MOVES, named and quantified.
  it('names each asset leaving the account, in the faucet\u2019s own decimals', async () => {
    mockGetTokenMetadata.mockResolvedValue({ decimals: 8, symbol: 'BTC' });
    mockSummaryBytesToView.mockReturnValue({ ...emptyView, outgoing: [{ faucetId: 'faucet-btc', amount: 5000000n }] });

    await raiseSheet(false);

    expect(mockGetTokenMetadata).toHaveBeenCalledWith('faucet-btc');
    expect(sheetMessages()).toContain('Leaves this account, -0.05 BTC');
  });

  it('names what enters the account too, so a swap is not read as a one-way loss', async () => {
    mockSummaryBytesToView.mockReturnValue({
      ...emptyView,
      outgoing: [{ faucetId: 'faucet-a', amount: 1500000n }],
      incoming: [{ faucetId: 'faucet-b', amount: 2000000n }]
    });

    const messages = (await raiseSheet(false), sheetMessages());

    expect(messages).toContain('Leaves this account, -1.5 MIDEN');
    expect(messages).toContain('Enters this account, +2 MIDEN');
  });

  it('counts the notes consumed and created', async () => {
    mockSummaryBytesToView.mockReturnValue({ ...emptyView, inputNotesConsumed: 2, outputNotesCreated: 3 });

    await raiseSheet(false);

    expect(sheetMessages()).toEqual(expect.arrayContaining(['Notes consumed, 2', 'Notes created, 3']));
  });

  // A custom request can rewrite account storage without moving an asset, which
  // no amount line would ever reveal.
  it('says when the account\u2019s stored data changes', async () => {
    mockSummaryBytesToView.mockReturnValue({ ...emptyView, storageChanged: true });

    await raiseSheet(false);

    expect(sheetMessages()).toContain('Changes this account\u2019s stored data');
  });

  it('says so explicitly when nothing moves, rather than leaving a silence to read', async () => {
    await raiseSheet(false);

    expect(sheetMessages()).toContain('No assets move');
  });

  it('keeps the existing preview lines, so the recipient is still named', async () => {
    await raiseSheet(false);

    expect(sheetMessages()[0]).toBe('This dApp is requesting a custom transaction,');
    // Qualified, not bare: the request could not be decoded here, so the recipient
    // is only what the SITE claims and the sheet says so rather than presenting it
    // as verified. Still named, which is what this case is about.
    expect(sheetMessages()).toContain('Recipient (declared by the site), mtst1recipient');
  });
});

// A dry run that could not be produced must not look like a transaction that
// moves nothing: that is the reading most likely to get an approval.
describe('a dry run that could not be produced is stated, not omitted', () => {
  it('reports the failure and its reason when the simulation errors', async () => {
    mockSimulate.mockResolvedValue({ error: 'note not found' });

    await raiseSheet(false);

    const messages = sheetMessages();
    expect(messages).toContain('This transaction could not be simulated, so its effects are unknown.');
    expect(messages).toContain('Reason, note not found');
    expect(messages).not.toContain('No assets move');
  });

  it('reports it when the summary comes back undecodable', async () => {
    mockSummaryBytesToView.mockImplementation(() => {
      throw new Error('bad summary bytes');
    });
    const errSpy = jest.spyOn(console, 'error').mockImplementation();

    try {
      await raiseSheet(false);
    } finally {
      errSpy.mockRestore();
    }

    expect(sheetMessages()).toContain('Reason, bad summary bytes');
  });

  // The user can still decline, and that is the whole point of the sheet: a
  // preview that throws must not take the request down with it.
  it('still raises the sheet, and still executes on approval', async () => {
    mockSimulate.mockRejectedValue(new Error('client unavailable'));
    const errSpy = jest.spyOn(console, 'error').mockImplementation();

    try {
      await raiseSheet(true);
    } finally {
      errSpy.mockRestore();
    }

    expect(sheetMessages()).toContain('Reason, client unavailable');
    expect(mockRequestCustomTransaction).toHaveBeenCalledTimes(1);
  });
});

/**
 * The dry run imports the request's carried notes into the real client store so
 * execution can resolve them, and quarantines them first because nothing has
 * been approved yet. The extension branch releases that quarantine once the
 * transaction is queued; this branch had no dry run and so no release, and now
 * needs the same one or an approved note stays hidden from the claimable UI
 * forever.
 */
describe('the quarantine the dry run placed is lifted on approval only', () => {
  it('releases the carried notes once the transaction is queued', async () => {
    await raiseSheet(true);

    expect(mockReleaseNoteIds).toHaveBeenCalledWith(['id:noteB64']);
  });

  it('leaves them hidden when the user declines', async () => {
    await raiseSheet(false);

    expect(mockReleaseNoteIds).not.toHaveBeenCalled();
  });

  it('leaves them hidden when queueing the approved transaction fails', async () => {
    mockRequestCustomTransaction.mockRejectedValue(new Error('queue failed') as never);
    mockRequestConfirmation.mockResolvedValueOnce({ confirmed: true });

    await expect(requestTransaction(DAPP_ORIGIN, customRequest(), 'session-1')).rejects.toThrow(
      MidenDAppErrorType.InvalidParams
    );

    expect(mockReleaseNoteIds).not.toHaveBeenCalled();
  });
});
