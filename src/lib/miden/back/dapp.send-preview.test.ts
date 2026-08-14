/* eslint-disable import/first */
/**
 * The two approval-screen fixes that ship with the dApp E2E suite, covered
 * where they are actually falsifiable.
 *
 * WHY HERE AND NOT IN THE E2E SPEC. `playwright/tests/dapp-provider.spec.ts`
 * drives the real journey but runs chainless, where every faucet resolves to
 * `DEFAULT_TOKEN_METADATA` — 6 decimals, the same number the removed hardcoded
 * `10 ** 6` used. So the E2E amount assertion cannot fail on the decimals logic;
 * it only proves the preview string reaches the screen intact. And the spec is
 * Chromium/MV3-only, so it never touches the mobile/desktop confirmation-store
 * branch at all. Both gaps are closed below by driving `dapp.ts` directly with
 * `isExtension()` forced false.
 *
 * 1. AMOUNT DECIMALS. `formatSendTransactionPreview` used to emit the raw base
 *    units and let the extension's ConfirmPage divide by a hardcoded `10 ** 6`.
 *    Any faucet with different decimals rendered a wrong number, mobile and
 *    desktop printed the raw base units verbatim, and the division routed
 *    through `Number()` so amounts above 2^53 lost precision.
 *
 * 2. REQUESTING ORIGIN. The mobile/desktop confirmation-store call sites passed
 *    `origin: dApp.appMeta.name` — a display name the PAGE supplies (it is set
 *    from `window.location.hostname` in `midenWindowObject.ts` /
 *    `injection-script.ts`), never the origin the wallet itself verified. The
 *    approval sheet renders that field as "who is asking", so a phishing page
 *    could name itself anything. All three non-connect sites now pass the real
 *    `origin`, matching what the connect sheet already did.
 */

import { MidenDAppErrorType, MidenDAppMessageType } from 'lib/adapter/types';

// ── Mocks ──────────────────────────────────────────────────────────
// Mirrors the scaffold in `dapp.preview-error.test.ts`; `dapp.ts` pulls in the
// vault, the transaction pipeline and the storage adapter at module scope.

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

jest.mock('lib/miden/transaction', () => ({
  initiateSendTransaction: (...args: unknown[]) => mockInitiateSendTransaction(...args),
  requestCustomTransaction: (...args: unknown[]) => mockRequestCustomTransaction(...args),
  initiateConsumeTransactionFromId: (...args: unknown[]) => mockInitiateConsumeTransactionFromId(...args),
  waitForTransactionCompletion: (...args: unknown[]) => mockWaitForTransactionCompletion(...args)
}));

jest.mock('lib/miden/activity', () => ({
  queueNoteImport: jest.fn()
}));

jest.mock('lib/miden/back/transaction-processor', () => ({
  startTransactionProcessing: jest.fn()
}));

// The mobile/desktop branch is where the confirmation store lives, and it is
// the branch the E2E spec cannot reach.
jest.mock('lib/platform', () => ({
  isExtension: () => false,
  isDesktop: () => false,
  isMobile: () => true
}));

/**
 * `STORAGE_KEY` in `dapp.ts` is the literal `dapp_sessions`, and the storage
 * provider's `get([key])` returns `{ [key]: value }`, so pre-seeding under that
 * exact key is what makes `getDApp('https://miden.xyz', …)` find a session.
 *
 * Every value is inlined: a `jest.mock` factory is hoisted above the module's
 * own `const`s, so referencing one from in here reads it in its temporal dead
 * zone and the factory throws at require time.
 *
 * The stored `appMeta.name` is deliberately NOT a hostname, so an assertion on
 * the confirmation request's `origin` cannot pass by coincidence if the wallet
 * regresses to rendering the dApp-supplied display name.
 */
jest.mock('lib/platform/storage-adapter', () => ({
  getStorageProvider: () => ({
    get: async () => ({
      dapp_sessions: {
        'https://miden.xyz': [
          {
            network: 'testnet',
            appMeta: { name: 'Totally Legitimate Miden App', url: 'https://miden.xyz' },
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

const DAPP_ORIGIN = 'https://miden.xyz';

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

jest.mock('lib/miden/back/defaults', () => ({
  intercom: { broadcast: jest.fn() }
}));

jest.mock('lib/miden/back/vault', () => ({
  Vault: {
    getCurrentAccountPublicKey: jest.fn().mockResolvedValue('miden-account-1')
  }
}));

/**
 * `__mocks__/lib/i18n/numbers.ts` is applied automatically to every
 * non-relative `lib/i18n/numbers` import, and it does not export
 * `formatBigInt`. The REAL one is the subject of half this file — asserting
 * against a hand-written mirror of it would test the mirror, not the wallet —
 * so it is unmocked here.
 */
jest.unmock('lib/i18n/numbers');

// ── Imports under test ─────────────────────────────────────────────
import { requestSendTransaction, requestConsumeTransaction, requestTransaction } from './dapp';

/**
 * What every call below must reject with once the user declines. `NOT_GRANTED`
 * is also what a request that never reached the sheet rejects with (no stored
 * session, for one), so this assertion alone does not prove the sheet was
 * built — {@link capturedConfirmation} is what does that.
 */
const DECLINED = MidenDAppErrorType.NotGranted;

/** The single `DAppConfirmationRequest` the wallet put in front of the user. */
type CapturedConfirmation = { origin: string; transactionMessages?: string[] };

/**
 * The confirmation the wallet actually raised. The exactly-one check is the
 * load-bearing part: it fails loudly if the request rejected before ever
 * reaching the sheet, which is otherwise indistinguishable from a decline.
 */
const capturedConfirmation = (): CapturedConfirmation => {
  expect(mockRequestConfirmation).toHaveBeenCalledTimes(1);
  return mockRequestConfirmation.mock.calls[0]![0] as CapturedConfirmation;
};

/** The `Amount, …` row of the approval sheet, as the user would read it. */
const amountRow = (confirmation: CapturedConfirmation): string | undefined =>
  confirmation.transactionMessages?.find(message => message.startsWith('Amount, '));

const sendRequest = (faucetId: string, amount: string) =>
  ({
    type: MidenDAppMessageType.SendTransactionRequest,
    sourcePublicKey: 'miden-account-1',
    transaction: {
      senderAddress: 'mtst1sender',
      recipientAddress: 'mtst1recipient',
      faucetId,
      noteType: 'private',
      amount,
      recallBlocks: 0
    }
  }) as unknown as Parameters<typeof requestSendTransaction>[1];

beforeEach(() => {
  jest.clearAllMocks();
  mockWithUnlocked.mockImplementation(async (fn: (ctx: unknown) => unknown) => fn({ vault: {} }));
  // Declining short-circuits every path right after the preview is built and
  // shown, which is exactly the state these tests inspect. Approving would run
  // the transaction pipeline, which is a different test's subject.
  mockRequestConfirmation.mockResolvedValue({ confirmed: false });
});

// ── 1. The amount uses the faucet's own decimals ───────────────────

describe('dApp send approval: the amount is scaled by the faucet decimals', () => {
  it('renders 1.5 for a 9-decimal faucet (a hardcoded 6 would render 1500)', async () => {
    mockGetTokenMetadata.mockResolvedValue({ decimals: 9 });

    await expect(
      requestSendTransaction(DAPP_ORIGIN, sendRequest('faucet-9dp', '1500000000'), 'session-1')
    ).rejects.toThrow(DECLINED);

    expect(amountRow(capturedConfirmation())).toBe('Amount, -1.5');
  });

  it('renders 1.5 for an 18-decimal faucet', async () => {
    mockGetTokenMetadata.mockResolvedValue({ decimals: 18 });

    await expect(
      requestSendTransaction(DAPP_ORIGIN, sendRequest('faucet-18dp', '1500000000000000000'), 'session-1')
    ).rejects.toThrow(DECLINED);

    expect(amountRow(capturedConfirmation())).toBe('Amount, -1.5');
  });

  it('renders 1.5 for a 6-decimal faucet, unchanged from before the fix', async () => {
    mockGetTokenMetadata.mockResolvedValue({ decimals: 6 });

    await expect(
      requestSendTransaction(DAPP_ORIGIN, sendRequest('faucet-6dp', '1500000'), 'session-1')
    ).rejects.toThrow(DECLINED);

    expect(amountRow(capturedConfirmation())).toBe('Amount, -1.5');
  });

  it('keeps every digit of an amount past 2^53', async () => {
    mockGetTokenMetadata.mockResolvedValue({ decimals: 6 });

    // 9007199254740993 is 2^53 + 1. The old ConfirmPage path computed
    // `Number('9007199254740993') / 10 ** 6` and produced …740992 — the last
    // digit of the user's balance, silently wrong on the approval screen.
    await expect(
      requestSendTransaction(DAPP_ORIGIN, sendRequest('faucet-6dp', '9007199254740993'), 'session-1')
    ).rejects.toThrow(DECLINED);

    expect(amountRow(capturedConfirmation())).toBe('Amount, -9007199254.740993');
  });

  it('falls back to the native decimals when the faucet has no metadata', async () => {
    mockGetTokenMetadata.mockResolvedValue(undefined);

    await expect(
      requestSendTransaction(DAPP_ORIGIN, sendRequest('faucet-unknown', '1500000'), 'session-1')
    ).rejects.toThrow(DECLINED);

    expect(amountRow(capturedConfirmation())).toBe('Amount, -1.5');
  });
});

// ── 2. The approval sheet names the verified origin ────────────────

describe('dApp approval sheets name the verified origin, not the dApp-supplied name', () => {
  beforeEach(() => {
    mockGetTokenMetadata.mockResolvedValue({ decimals: 6 });
  });

  it('send', async () => {
    await expect(
      requestSendTransaction(DAPP_ORIGIN, sendRequest('faucet-6dp', '1500000'), 'session-1')
    ).rejects.toThrow(DECLINED);

    expect(capturedConfirmation().origin).toBe(DAPP_ORIGIN);
  });

  it('consume', async () => {
    const consumeReq = {
      type: MidenDAppMessageType.ConsumeRequest,
      sourcePublicKey: 'miden-account-1',
      transaction: { noteId: 'note-1', faucetId: 'faucet-6dp', amount: '1500000', noteType: 'Public' }
    } as unknown as Parameters<typeof requestConsumeTransaction>[1];

    await expect(requestConsumeTransaction(DAPP_ORIGIN, consumeReq, 'session-1')).rejects.toThrow(DECLINED);

    expect(capturedConfirmation().origin).toBe(DAPP_ORIGIN);
  });

  it('custom transaction', async () => {
    const customReq = {
      type: MidenDAppMessageType.TransactionRequest,
      sourcePublicKey: 'miden-account-1',
      transaction: {
        payload: {
          address: 'mtst1sender',
          transactionRequest: 'tx',
          recipientAddress: 'mtst1recipient',
          inputNoteIds: [],
          importNotes: []
        }
      }
    } as unknown as Parameters<typeof requestTransaction>[1];

    await expect(requestTransaction(DAPP_ORIGIN, customReq, 'session-1')).rejects.toThrow(DECLINED);

    expect(capturedConfirmation().origin).toBe(DAPP_ORIGIN);
  });
});
