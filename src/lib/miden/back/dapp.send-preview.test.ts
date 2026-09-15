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

// The consume approval preview resolves the note the wallet will actually consume
// (rather than trusting the dApp's declared faucet/amount/type), so the consume
// case needs a client whose store contains it.
jest.mock('lib/miden/sdk/miden-client', () => ({
  getMidenClient: async () => ({
    getInputNoteDetails: async () => [
      {
        noteId: 'note-1',
        noteType: 0,
        senderAccountId: 's1',
        nullifier: 'nf1',
        state: 0,
        assets: [{ faucetId: 'faucet-6dp', amount: '1500000' }]
      }
    ],
    on: jest.fn()
  }),
  withWasmClientLock: async <T>(fn: () => Promise<T>) => fn(),
  runWhenClientIdle: () => {}
}));

/**
 * The custom path now dry-runs the request before raising the sheet, to state
 * its effects there (see `dapp.custom-consent.test.ts`). Stubbed so this file's
 * assertions do not depend on a real client, and cannot wait on its timeout.
 */
jest.mock('./simulate-custom-tx', () => ({
  simulateCustomTransaction: jest.fn(async () => ({ error: 'no client in this suite' }))
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

/**
 * The shared wasm mock stubs `NoteType` as the STRINGS 'Private'/'Public', but
 * the real SDK enum is NUMERIC with `Private = 0`. Note-type validation is the
 * subject of one of the describes below, and under the string stub two of its
 * cases are wrong: a miscased `'Private'` would compare equal to the enum and be
 * accepted, and the numeric `0` a page can actually send would not be
 * recognized at all. Override with the real values so the boundary is tested
 * against what production sees — the same thing `lib/miden/helpers.test.ts`
 * does, and for the same reason.
 */
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  ...jest.requireActual('../../../../__mocks__/wasmMock.js'),
  NoteType: { Private: 0, Public: 1 }
}));

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

/** Distinguishes "caller omitted it" from "caller passed undefined on purpose". */
const OMITTED = Symbol('omitted');

const sendRequest = (faucetId: string, amount: string, noteType: unknown = OMITTED) =>
  ({
    type: MidenDAppMessageType.SendTransactionRequest,
    sourcePublicKey: 'miden-account-1',
    transaction: {
      // Must be the connected account — the wallet now rejects a send that names
      // any other account as the payer (`executingAccountError`).
      senderAddress: 'miden-account-1',
      recipientAddress: 'mtst1recipient',
      faucetId,
      noteType: noteType === OMITTED ? 'private' : noteType,
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

  // The previous fallback was the NATIVE decimals, which is a statement about
  // MIDEN and not about this faucet. On the screen where a user approves a
  // dApp's transfer, that renders an authoritative quantity derived from a
  // token the request is not denominated in.
  it('withholds the amount when the faucet has no metadata at all', async () => {
    mockGetTokenMetadata.mockResolvedValue(undefined);

    await expect(
      requestSendTransaction(DAPP_ORIGIN, sendRequest('faucet-unknown', '1500000'), 'session-1')
    ).rejects.toThrow(DECLINED);

    expect(amountRow(capturedConfirmation())).toBe('Amount, -?');
  });

  it('withholds the amount when the faucet resolved only to the unknown-token placeholder', async () => {
    mockGetTokenMetadata.mockResolvedValue({ symbol: 'Unknown', name: 'Unknown', decimals: 6, scaleIsUnknown: true });

    await expect(
      requestSendTransaction(DAPP_ORIGIN, sendRequest('faucet-unresolved', '1500000'), 'session-1')
    ).rejects.toThrow(DECLINED);

    expect(amountRow(capturedConfirmation())).toBe('Amount, -?');
  });

  it('withholds a consume amount on the same terms', async () => {
    mockGetTokenMetadata.mockResolvedValue(undefined);

    const consumeReq = {
      type: MidenDAppMessageType.ConsumeRequest,
      sourcePublicKey: 'miden-account-1',
      transaction: { noteId: 'note-1', faucetId: 'faucet-unknown', amount: '1500000', noteType: 'Public' }
    } as unknown as Parameters<typeof requestConsumeTransaction>[1];

    await expect(requestConsumeTransaction(DAPP_ORIGIN, consumeReq, 'session-1')).rejects.toThrow(DECLINED);

    expect(amountRow(capturedConfirmation())).toBe('Amount, +?');
  });
});

// ── 1b. The executing account must be the connected one ────────────

describe('dApp transactions execute ONLY as the connected account', () => {
  const sendRequestFrom = (senderAddress: string) =>
    ({
      type: MidenDAppMessageType.SendTransactionRequest,
      // Authorized against the connected account …
      sourcePublicKey: 'miden-account-1',
      transaction: {
        // … but asked to execute as this one.
        senderAddress,
        recipientAddress: 'mtst1attacker',
        faucetId: 'faucet-6dp',
        noteType: 'private',
        amount: '5000000',
        recallBlocks: 0
      }
    }) as unknown as Parameters<typeof requestSendTransaction>[1];

  const customRequestFrom = (address: string) =>
    ({
      type: MidenDAppMessageType.TransactionRequest,
      sourcePublicKey: 'miden-account-1',
      transaction: {
        payload: { address, transactionRequest: 'tx', recipientAddress: 'mtst1attacker', inputNoteIds: [] }
      }
    }) as unknown as Parameters<typeof requestTransaction>[1];

  beforeEach(() => {
    mockGetTokenMetadata.mockResolvedValue({ decimals: 6 });
  });

  it('rejects a send whose senderAddress is an account the origin is not connected to', async () => {
    await expect(requestSendTransaction(DAPP_ORIGIN, sendRequestFrom('miden-account-2'), 'session-1')).rejects.toThrow(
      'NOT_GRANTED'
    );
    // Rejected BEFORE any approval sheet: the user is never shown a prompt that
    // looks like the connected account's own transfer.
    expect(mockRequestConfirmation).not.toHaveBeenCalled();
  });

  it('rejects a custom transaction whose address is an account the origin is not connected to', async () => {
    await expect(requestTransaction(DAPP_ORIGIN, customRequestFrom('miden-account-2'), 'session-1')).rejects.toThrow(
      'NOT_GRANTED'
    );
    expect(mockRequestConfirmation).not.toHaveBeenCalled();
  });

  it('accepts the composite `<address>_<suffix>` publicKey form for the same account', async () => {
    // Guardian accounts store a composite publicKey; the dApp side sends the bare
    // address. A raw `===` would reject this legitimate request.
    await expect(
      requestSendTransaction(DAPP_ORIGIN, sendRequestFrom('miden-account-1_qr7qqq9wr6w'), 'session-1')
    ).rejects.toThrow(DECLINED);
    expect(mockRequestConfirmation).toHaveBeenCalledTimes(1);
  });

  it('names the paying account on the send approval sheet', async () => {
    await expect(
      requestSendTransaction(DAPP_ORIGIN, sendRequest('faucet-6dp', '1500000'), 'session-1')
    ).rejects.toThrow(DECLINED);

    expect(capturedConfirmation().transactionMessages).toContain('From, miden-account-1');
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
          // Must be the session's own account: the custom path is bound to it,
          // so a foreign address never reaches a sheet to inspect.
          address: 'miden-account-1',
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

// ── 3. The note type is resolved before the user is asked ──────────

/**
 * `noteType` is required by the SendTransaction contract, but it crosses
 * postMessage from an untrusted page, so the type is a claim rather than a
 * guarantee. The wallet now builds the note itself, and its resolver treats a
 * missing type as PUBLIC — so an omitted one would have rendered "Note Type,
 * undefined" on the sheet and then gone out as a public note. Reject before the
 * sheet is ever raised.
 */
describe('dApp send approval: the note type must resolve before the user is asked', () => {
  beforeEach(() => {
    mockGetTokenMetadata.mockResolvedValue({ decimals: 6 });
  });

  const noteTypeRow = (confirmation: CapturedConfirmation): string | undefined =>
    confirmation.transactionMessages?.find(message => message.startsWith('Note Type, '));

  // The numeric cases are the SDK enum a page may legitimately send. They must
  // normalize to the persisted STRING before the row is written: everything
  // downstream compares the string, including the private-note relay in
  // `completeSendTransaction`, so a stored `0` would build a private note and
  // then silently skip delivering it to the recipient.
  it.each([
    ['private', 'Note Type, Private'],
    ['public', 'Note Type, Public'],
    [0, 'Note Type, Private'],
    [1, 'Note Type, Public']
  ])('renders the resolved label for %p', async (noteType, expected) => {
    await expect(
      requestSendTransaction(DAPP_ORIGIN, sendRequest('faucet-6dp', '1500000', noteType), 'session-1')
    ).rejects.toThrow(DECLINED);

    expect(noteTypeRow(capturedConfirmation())).toBe(expected);
  });

  it.each([
    [0, 'private'],
    [1, 'public'],
    ['private', 'private']
  ])('normalizes %p to the persisted string %p before initiating', async (noteType, persisted) => {
    mockRequestConfirmation.mockResolvedValue({ confirmed: true });
    mockInitiateSendTransaction.mockResolvedValue('tx-1');

    await requestSendTransaction(DAPP_ORIGIN, sendRequest('faucet-6dp', '1500000', noteType), 'session-1');

    // initiateSendTransaction(sender, recipient, faucet, noteType, amount, …)
    expect(mockInitiateSendTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      persisted,
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
  });

  // Built inline rather than through `sendRequest`: a default parameter fires
  // for an explicitly-passed `undefined` too, which would silently substitute a
  // valid note type and make this assertion vacuous.
  const requestWithNoteType = (noteType: unknown) =>
    ({
      type: MidenDAppMessageType.SendTransactionRequest,
      sourcePublicKey: 'miden-account-1',
      transaction: {
        senderAddress: 'miden-account-1',
        recipientAddress: 'mtst1recipient',
        faucetId: 'faucet-6dp',
        noteType,
        amount: '1500000',
        recallBlocks: 0
      }
    }) as unknown as Parameters<typeof requestSendTransaction>[1];

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['absent', OMITTED]
  ])('rejects a %s note type without prompting', async (_label, noteType) => {
    const request =
      noteType === OMITTED
        ? ({
            type: MidenDAppMessageType.SendTransactionRequest,
            sourcePublicKey: 'miden-account-1',
            transaction: {
              senderAddress: 'miden-account-1',
              recipientAddress: 'mtst1recipient',
              faucetId: 'faucet-6dp',
              amount: '1500000',
              recallBlocks: 0
            }
          } as unknown as Parameters<typeof requestSendTransaction>[1])
        : requestWithNoteType(noteType);

    await expect(requestSendTransaction(DAPP_ORIGIN, request, 'session-1')).rejects.toThrow(
      MidenDAppErrorType.InvalidParams
    );

    expect(mockRequestConfirmation).not.toHaveBeenCalled();
    expect(mockInitiateSendTransaction).not.toHaveBeenCalled();
  });

  // An unrecognized value must not quietly become public either — that is the
  // silent privacy downgrade `isPrivateNoteType` exists to stop. 'Private' is
  // included because a miscased string is the likeliest real mistake, and it is
  // only distinguishable from the enum once `NoteType` carries its real numeric
  // values (see the override at the top of this file).
  it.each(['Private', 'PRIVATE', 'secret', '', 2, -1])('rejects the unrecognized note type %p', async noteType => {
    await expect(
      requestSendTransaction(DAPP_ORIGIN, sendRequest('faucet-6dp', '1500000', noteType), 'session-1')
    ).rejects.toThrow(MidenDAppErrorType.InvalidParams);

    expect(mockRequestConfirmation).not.toHaveBeenCalled();
  });
});

// ── 4. The recall window must survive the u32 it is stored in ──────

// `recallBlocks` becomes `syncHeight + recallBlocks` and is handed to the SDK as
// a u32 block height. wasm-bindgen truncates at that boundary instead of
// throwing, so an out-of-range offset does not fail — it silently becomes a
// DIFFERENT recall window than the one rendered on the sheet the user approved.
describe('dApp send approval: the recall window must be representable', () => {
  const requestWithRecall = (recallBlocks: unknown) =>
    ({
      type: MidenDAppMessageType.SendTransactionRequest,
      sourcePublicKey: 'miden-account-1',
      transaction: {
        senderAddress: 'miden-account-1',
        recipientAddress: 'mtst1recipient',
        faucetId: 'faucet-6dp',
        noteType: 'private',
        amount: '1500000',
        recallBlocks
      }
    }) as unknown as Parameters<typeof requestSendTransaction>[1];

  it.each([
    ['wraps to an instant recall', 2 ** 32],
    ['wraps past the u32 ceiling', 0x8000_0000],
    ['strands the recall for ~4 billion blocks', -1],
    ['truncates to a shorter window', 100.5],
    ['is not a number at all', Infinity],
    ['is NaN', NaN]
  ])('rejects an offset that %s, without prompting', async (_label, recallBlocks) => {
    await expect(requestSendTransaction(DAPP_ORIGIN, requestWithRecall(recallBlocks), 'session-1')).rejects.toThrow(
      MidenDAppErrorType.InvalidParams
    );

    expect(mockRequestConfirmation).not.toHaveBeenCalled();
    expect(mockInitiateSendTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['a real window', 2016],
    ['zero, meaning not recallable', 0],
    ['omitted, meaning not recallable', undefined]
  ])('still prompts for %s', async (_label, recallBlocks) => {
    mockGetTokenMetadata.mockResolvedValue({ decimals: 6 });

    await expect(requestSendTransaction(DAPP_ORIGIN, requestWithRecall(recallBlocks), 'session-1')).rejects.toThrow(
      DECLINED
    );

    expect(mockRequestConfirmation).toHaveBeenCalled();
  });
});

// ── 5. The sender must be the account the session authorized ───────

// A session authorizes exactly one account. `senderAddress` rides in the request
// body, and the approval sheet renders amount, recipient, faucet and note type
// but NOT the sender — so a page connected to account A naming account B as the
// sender would debit B with nothing on screen to give it away.
describe('dApp send approval: the sender is bound to the connected account', () => {
  const requestFrom = (senderAddress: string) =>
    ({
      type: MidenDAppMessageType.SendTransactionRequest,
      sourcePublicKey: 'miden-account-1',
      transaction: {
        senderAddress,
        recipientAddress: 'mtst1recipient',
        faucetId: 'faucet-6dp',
        noteType: 'private',
        amount: '1500000',
        recallBlocks: 0
      }
    }) as unknown as Parameters<typeof requestSendTransaction>[1];

  it('refuses a send drawn on an account the session does not cover', async () => {
    await expect(requestSendTransaction(DAPP_ORIGIN, requestFrom('miden-account-2'), 'session-1')).rejects.toThrow(
      MidenDAppErrorType.NotGranted
    );

    // Rejected before the user is asked: an approval sheet that does not name
    // the sender cannot be the place this is caught.
    expect(mockRequestConfirmation).not.toHaveBeenCalled();
    expect(mockInitiateSendTransaction).not.toHaveBeenCalled();
  });

  it('allows the session account through', async () => {
    mockGetTokenMetadata.mockResolvedValue({ decimals: 6 });

    await expect(requestSendTransaction(DAPP_ORIGIN, requestFrom('miden-account-1'), 'session-1')).rejects.toThrow(
      DECLINED
    );

    expect(mockRequestConfirmation).toHaveBeenCalled();
  });
});
