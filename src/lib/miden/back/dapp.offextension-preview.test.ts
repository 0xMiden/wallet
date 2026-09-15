/* eslint-disable import/first */
/**
 * What the MOBILE and DESKTOP approval sheets say about the thing they are
 * approving. Both platforms render `DAppConfirmationRequest.transactionMessages`
 * as a plain list of strings (`DappConfirmationModal`, and the desktop overlay's
 * `escapeHtml`ed rows), so whatever `dapp.ts` puts in that array IS the sheet —
 * there is no second decoder downstream, unlike the extension's `ConfirmPage`.
 *
 * Two blind-approval regressions are covered here:
 *
 * 1. SIGN. `signBytes(bytes, 'signingInputs')` is a full transaction
 *    authorization (`Vault.signData` → `secretKey.signData(SigningInputs…)`).
 *    The sheet used to carry only `Kind` and `Account`, so a page could have the
 *    user sign away the whole balance with nothing on screen about assets.
 *
 * 2. CUSTOM TRANSACTION. The sheet was four fixed strings plus `From` and a
 *    dApp-declared `Recipient`, none of it derived from `transactionRequest` —
 *    the bytes the wallet then executes, proves and submits.
 *
 * Every test drives `dapp.ts` with `isExtension()` forced false, which is the
 * only branch these rows reach; the extension renders `TransactionAssetView`
 * from the same decoders instead.
 */

import { MidenDAppErrorType, MidenDAppMessageType } from 'lib/adapter/types';

// ── Mocks ──────────────────────────────────────────────────────────
// Mirrors the scaffold in `dapp.send-preview.test.ts`; `dapp.ts` pulls in the
// vault, the transaction pipeline and the storage adapter at module scope.

const mockWithUnlocked = jest.fn(async (fn: (ctx: unknown) => unknown) => fn({ vault: {} }));

jest.mock('lib/miden/back/store', () => ({
  store: {
    getState: () => ({ currentAccount: { publicKey: 'miden-account-1' } })
  },
  withUnlocked: (fn: (ctx: unknown) => unknown) => mockWithUnlocked(fn)
}));

jest.mock('lib/miden/transaction', () => ({
  initiateSendTransaction: jest.fn(),
  requestCustomTransaction: jest.fn(),
  initiateConsumeTransactionFromId: jest.fn(),
  waitForTransactionCompletion: jest.fn()
}));

jest.mock('lib/miden/activity', () => ({
  queueNoteImport: jest.fn()
}));

jest.mock('lib/miden/back/transaction-processor', () => ({
  startTransactionProcessing: jest.fn()
}));

// The confirmation store is the mobile/desktop sheet; the extension popup path
// (`requestConfirm`) is a different renderer entirely.
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

const mockGetTokenMetadata = jest.fn();
jest.mock('lib/miden/metadata/utils', () => ({
  getTokenMetadata: (...args: unknown[]) => mockGetTokenMetadata(...args),
  // Faithful to the real one-liner (`metadata ? metadata.symbol : '???'`); the
  // real module is mocked wholesale only because `getTokenMetadata` reaches into
  // settings + the token-metadata store.
  getAssetSymbol: (metadata: { symbol: string } | undefined) => (metadata ? metadata.symbol : '???')
}));

/**
 * The bech32 derivation in the real helper runs `Address.fromAccountId` on a WASM
 * AccountId, which the SDK stub cannot produce — the faucet stubs below carry
 * their address directly. Everything else (notably `sameWalletAccountId`, which
 * gates the custom-transaction path) stays REAL.
 */
jest.mock('lib/miden/sdk/helpers', () => ({
  ...jest.requireActual('lib/miden/sdk/helpers'),
  getBech32AddressFromAccountId: (accountId: { __faucet: string }) => accountId.__faucet
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

jest.mock('lib/miden/sdk/miden-client', () => ({
  getMidenClient: async () => ({ getInputNoteDetails: async () => [], on: jest.fn() }),
  withWasmClientLock: async <T>(fn: () => Promise<T>) => fn(),
  runWhenClientIdle: () => {}
}));

jest.mock('lib/miden/back/vault', () => ({
  Vault: {
    getCurrentAccountPublicKey: jest.fn().mockResolvedValue('miden-account-1'),
    // Reached only if a test approves; these tests all decline at the sheet.
    signData: jest.fn()
  }
}));

/**
 * `formatBigInt` is what turns a base-unit bigint into the string the user reads,
 * so the amount rows below assert the REAL implementation, not the numbers mock.
 */
jest.unmock('lib/i18n/numbers');

// ── Imports under test ─────────────────────────────────────────────
import { requestSign, requestTransaction } from './dapp';

const DAPP_ORIGIN = 'https://miden.xyz';
const DECLINED = MidenDAppErrorType.NotGranted;

/**
 * The SDK stub every test reconfigures; `dapp.ts` and `app/confirm/decode` resolve
 * the same module instance, so mutating it here reaches both. (Same technique as
 * `dapp.extended.test.ts`; a `jest.mock` factory would have to restate every
 * export the module graph touches.)
 */
const sdk: Record<string, unknown> = require('@miden-sdk/miden-sdk/lazy');

const originalSdk = {
  SigningInputs: sdk.SigningInputs,
  SigningInputsType: sdk.SigningInputsType,
  TransactionRequest: sdk.TransactionRequest,
  Note: sdk.Note,
  NoteFile: sdk.NoteFile
};

/** A fungible asset as the SDK exposes it: an AccountId object plus a bigint. */
const fungibleAsset = (faucetId: string, amount: bigint) => ({
  faucetId: () => ({ __faucet: faucetId }),
  amount: () => amount
});

const noteCarrying = (assets: ReturnType<typeof fungibleAsset>[]) => ({
  assets: () => ({ fungibleAssets: () => assets })
});

/** The single `DAppConfirmationRequest` the wallet put in front of the user. */
const sheetRows = (): string[] => {
  expect(mockRequestConfirmation).toHaveBeenCalledTimes(1);
  return (mockRequestConfirmation.mock.calls[0]![0] as { transactionMessages?: string[] }).transactionMessages ?? [];
};

const OPAQUE_WARNING =
  'Warning, this site asked you to sign a value the wallet cannot decode. Only continue if you fully trust this site.';

beforeEach(() => {
  jest.clearAllMocks();
  mockWithUnlocked.mockImplementation(async (fn: (ctx: unknown) => unknown) => fn({ vault: {} }));
  // Declining short-circuits right after the sheet is built and shown, which is
  // the state every test here inspects.
  mockRequestConfirmation.mockResolvedValue({ confirmed: false });
  mockGetTokenMetadata.mockResolvedValue({ decimals: 6, symbol: 'USDC' });
  sdk.SigningInputsType = { TransactionSummary: 0, Arbitrary: 1, Blind: 2 };
  // Silence the decode-failure breadcrumbs the "cannot decode" cases emit.
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  Object.assign(sdk, originalSdk);
  jest.restoreAllMocks();
});

// ── 1. `signBytes(…, 'signingInputs')` is not blind-signed ─────────

describe('dApp sign approval names the assets the signature authorizes', () => {
  const signRequest = (kind: string, payload = 'c2lnbmluZy1pbnB1dHM=') =>
    ({
      type: MidenDAppMessageType.SignRequest,
      sourceAccountId: 'miden-account-1',
      sourcePublicKey: 'miden-account-1',
      payload,
      kind
    }) as unknown as Parameters<typeof requestSign>[1];

  /** A `SigningInputs` whose variant is a TransactionSummary moving `assets` out. */
  const summarySigningInputs = (outgoing: ReturnType<typeof fungibleAsset>[]) => ({
    variantType: 0,
    transactionSummaryPayload: () => ({
      accountDelta: () => ({
        id: () => ({ __faucet: 'miden-account-1' }),
        vault: () => ({ removedFungibleAssets: () => outgoing, addedFungibleAssets: () => [] }),
        storage: () => ({ isEmpty: () => true })
      }),
      inputNotes: () => ({ numNotes: () => 0 }),
      // `notes()` as well: summary output notes now go through the fee split, because
      // `fee::pay_fee` runs in auth BEFORE the summary is built.
      outputNotes: () => ({
        numNotes: () => 1,
        notes: () => [
          { assets: () => ({ fungibleAssets: () => [] }), metadata: () => ({ tag: () => ({ asU32: () => 0 }) }) }
        ]
      })
    })
  });

  it('renders the summary asset movement instead of only Kind + Account', async () => {
    sdk.SigningInputs = { deserialize: () => summarySigningInputs([fungibleAsset('faucet-usdc', 1500000n)]) };

    await expect(requestSign(DAPP_ORIGIN, signRequest('signingInputs'), 'session-1')).rejects.toThrow(DECLINED);

    const rows = sheetRows();
    // The whole point: an amount and a token, on screen, before Approve.
    expect(rows).toContain('Sending, -1.5 USDC');
    expect(rows).toContain('Notes, 0 consumed / 1 created');
    expect(rows).not.toContain(OPAQUE_WARNING);
    // The pre-existing rows stay.
    expect(rows).toContain('Kind, signingInputs');
  });

  it('scales the amount by the faucet decimals, not a fixed 6', async () => {
    mockGetTokenMetadata.mockResolvedValue({ decimals: 9, symbol: 'BTC' });
    sdk.SigningInputs = { deserialize: () => summarySigningInputs([fungibleAsset('faucet-btc', 1500000000n)]) };

    await expect(requestSign(DAPP_ORIGIN, signRequest('signingInputs'), 'session-1')).rejects.toThrow(DECLINED);

    expect(sheetRows()).toContain('Sending, -1.5 BTC');
  });

  it('says so when the summary moves no fungible assets, rather than showing an empty sheet', async () => {
    sdk.SigningInputs = { deserialize: () => summarySigningInputs([]) };

    await expect(requestSign(DAPP_ORIGIN, signRequest('signingInputs'), 'session-1')).rejects.toThrow(DECLINED);

    const rows = sheetRows();
    expect(rows).toContain('Assets, no fungible asset moves');
    expect(rows).toContain('Notes, 0 consumed / 1 created');
  });

  it('warns explicitly for an Arbitrary payload, which carries no readable summary', async () => {
    sdk.SigningInputs = { deserialize: () => ({ variantType: 1 }) };

    await expect(requestSign(DAPP_ORIGIN, signRequest('signingInputs'), 'session-1')).rejects.toThrow(DECLINED);

    const rows = sheetRows();
    expect(rows).toContain(OPAQUE_WARNING);
    expect(rows.some(row => row.startsWith('Sending, '))).toBe(false);
  });

  it('warns explicitly when the payload does not decode at all', async () => {
    sdk.SigningInputs = {
      deserialize: () => {
        throw new Error('not signing inputs');
      }
    };

    await expect(requestSign(DAPP_ORIGIN, signRequest('signingInputs'), 'session-1')).rejects.toThrow(DECLINED);

    expect(sheetRows()).toContain(OPAQUE_WARNING);
  });

  it('warns explicitly for a raw `word` digest', async () => {
    await expect(requestSign(DAPP_ORIGIN, signRequest('word'), 'session-1')).rejects.toThrow(DECLINED);

    expect(sheetRows()).toContain(OPAQUE_WARNING);
  });
});

// ── 2. The custom-transaction sheet shows what the request moves ───

describe('dApp custom-transaction approval shows the asset movement of the request itself', () => {
  const customRequest = (recipientAddress: string) =>
    ({
      type: MidenDAppMessageType.TransactionRequest,
      sourcePublicKey: 'miden-account-1',
      transaction: {
        type: 'custom',
        payload: {
          address: 'miden-account-1',
          transactionRequest: 'dHhieXRlcw==',
          recipientAddress,
          inputNoteIds: [],
          importNotes: []
        }
      }
    }) as unknown as Parameters<typeof requestTransaction>[1];

  it('decodes the request bytes and renders the outgoing assets', async () => {
    sdk.TransactionRequest = {
      deserialize: () => ({
        expectedOutputOwnNotes: () => [noteCarrying([fungibleAsset('faucet-usdc', 2500000n)])]
      })
    };

    await expect(
      requestTransaction(DAPP_ORIGIN, customRequest('mtst1qqqqqqqqqqqqqqqqqqqqqqqqqqqsavings'), 'session-1')
    ).rejects.toThrow(DECLINED);

    const rows = sheetRows();
    expect(rows).toContain('Sending, -2.5 USDC');
    expect(rows).toContain('Declared by the site, the wallet has not verified these amounts');
  });

  it('labels the dApp-declared recipient as declared instead of presenting it as the destination', async () => {
    sdk.TransactionRequest = {
      deserialize: () => ({
        expectedOutputOwnNotes: () => [noteCarrying([fungibleAsset('faucet-usdc', 2500000n)])]
      })
    };

    await expect(
      requestTransaction(DAPP_ORIGIN, customRequest('mtst1qqqqqqqqqqqqqqqqqqqqqqqqqqqsavings'), 'session-1')
    ).rejects.toThrow(DECLINED);

    const rows = sheetRows();
    // Nothing derives this address from the request bytes, so it must never be
    // rendered as a plain, wallet-vouched `Recipient` row.
    expect(rows.some(row => /^Recipient, /.test(row))).toBe(false);
    expect(rows.some(row => row.startsWith('Recipient (declared by the site), '))).toBe(true);
  });

  it('says so when the request bytes cannot be decoded, rather than showing an assetless sheet', async () => {
    sdk.TransactionRequest = {
      deserialize: () => {
        throw new Error('not a transaction request');
      }
    };

    await expect(
      requestTransaction(DAPP_ORIGIN, customRequest('mtst1qqqqqqqqqqqqqqqqqqqqqqqqqqqsavings'), 'session-1')
    ).rejects.toThrow(DECLINED);

    expect(sheetRows()).toContain(
      'Warning, the wallet could not decode this transaction request — it cannot show what it does'
    );
  });

  it('reports the incoming assets of the notes the request carries', async () => {
    sdk.TransactionRequest = { deserialize: () => ({ expectedOutputOwnNotes: () => [] }) };
    sdk.NoteFile = {
      deserialize: () => {
        throw new Error('bare Note, not a NoteFile');
      }
    };
    sdk.Note = { deserialize: () => noteCarrying([fungibleAsset('faucet-usdc', 4000000n)]) };

    const withImportedNote = {
      type: MidenDAppMessageType.TransactionRequest,
      sourcePublicKey: 'miden-account-1',
      transaction: {
        type: 'custom',
        payload: {
          address: 'miden-account-1',
          transactionRequest: 'dHhieXRlcw==',
          recipientAddress: '',
          inputNoteIds: [],
          importNotes: ['bm90ZQ==']
        }
      }
    } as unknown as Parameters<typeof requestTransaction>[1];

    await expect(requestTransaction(DAPP_ORIGIN, withImportedNote, 'session-1')).rejects.toThrow(DECLINED);

    expect(sheetRows()).toContain('Receiving, +4 USDC');
  });
});
