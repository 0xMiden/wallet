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
 * 1. SIGN. A `signingInputs` transaction summary is the full authorization,
 *    signed as that summary. `word` and Blind or Arbitrary `signingInputs` are
 *    signed under the domain tag and cannot authorize a transaction. The sheet
 *    used to carry only `Kind` and `Account`, so a page could have the user sign
 *    away the whole balance with nothing on screen about assets.
 *
 * 2. CUSTOM TRANSACTION. The sheet was four fixed strings plus `From` and a
 *    dApp-declared `Recipient`, none of it derived from `transactionRequest` —
 *    the bytes the wallet then executes, proves and submits.
 *
 * Every test drives `dapp.ts` with `isExtension()` forced false, which is the
 * only branch these rows reach; the extension renders `TransactionAssetView`
 * from the same decoders instead.
 */

import fs from 'fs';
import path from 'path';

import { MidenDAppErrorType, MidenDAppMessageType } from 'lib/adapter/types';
import { WasmClientPoisonedError } from 'lib/miden/sdk/wasm-client-poison';

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

/** The dry run itself is covered by `simulate-custom-tx.test.ts`; here it gives the view the sheet must show. */
const mockSimulate = jest.fn();
jest.mock('./simulate-custom-tx', () => ({
  simulateCustomTransaction: (...args: unknown[]) => mockSimulate(...args)
}));

// A custom summary's approval reads the chain fee before it decodes and refuses when that read is unknown.
jest.mock('lib/miden-chain/native-asset', () => ({
  ...jest.requireActual('lib/miden-chain/native-asset'),
  refreshVerificationBaseFee: async () => 2,
  isVerificationBaseFeeKnownAbsent: () => false
}));

/** The decoded view of the dry run. The real decoders stay in place for the sign tests. */
const mockSimulatedView = jest.fn();
jest.mock('app/confirm/decode', () => ({
  ...jest.requireActual('app/confirm/decode'),
  simulatedBytesToView: (result: { summaryBytes?: string }) =>
    result.summaryBytes === undefined ? undefined : mockSimulatedView(result.summaryBytes),
  simulatedOutputRecipients: (result: { summaryBytes?: string }) => (result.summaryBytes === undefined ? undefined : [])
}));

jest.mock('app/confirm/note-flow', () => ({
  noteFlowFromSimulatedBytes: () => ({ inputCount: 0, inputs: [], outputs: [] })
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
  MidenClient: sdk.MidenClient,
  Note: sdk.Note,
  NoteFile: sdk.NoteFile
};

/** A fungible asset as the SDK exposes it: an AccountId object plus a bigint. */
const fungibleAsset = (faucetId: string, amount: bigint) => ({
  faucetId: () => ({ __faucet: faucetId }),
  amount: () => amount
});

/** The SDK's `NonFungibleAsset` reduced to what the sheet reads: its faucet and value word. */
const nftAsset = (faucetId: string, wordHex: string) => ({
  faucetId: () => ({ __faucet: faucetId }),
  intoWord: () => ({ toHex: () => wordHex })
});

const noteCarrying = (assets: ReturnType<typeof fungibleAsset>[], nfts: ReturnType<typeof nftAsset>[] = []) => ({
  assets: () => ({ fungibleAssets: () => assets, nonFungibleAssets: () => nfts })
});

/** The single `DAppConfirmationRequest` the wallet put in front of the user. */
const sheetRows = (): string[] => {
  expect(mockRequestConfirmation).toHaveBeenCalledTimes(1);
  return (mockRequestConfirmation.mock.calls[0]![0] as { transactionMessages?: string[] }).transactionMessages ?? [];
};

const OPAQUE_WARNING =
  'Warning, this site asked you to sign a value the wallet cannot decode. Only continue if you fully trust this site.';
const NOT_A_TRANSACTION = 'Note, this signature cannot authorize a transaction from your account.';

const expectWarningThenLine = (rows: string[]) => {
  expect(rows[rows.indexOf(OPAQUE_WARNING) + 1]).toBe(NOT_A_TRANSACTION);
};

beforeEach(() => {
  jest.clearAllMocks();
  mockWithUnlocked.mockImplementation(async (fn: (ctx: unknown) => unknown) => fn({ vault: {} }));
  // Declining short-circuits right after the sheet is built and shown, which is
  // the state every test here inspects.
  mockRequestConfirmation.mockResolvedValue({ confirmed: false });
  mockGetTokenMetadata.mockResolvedValue({ decimals: 6, symbol: 'USDC' });
  mockSimulate.mockResolvedValue({ summaryBytes: 'sumB64' });
  mockSimulatedView.mockReturnValue({
    account: 'miden-account-1',
    outgoing: [],
    incoming: [],
    outgoingNfts: [],
    incomingNfts: [],
    unlistedAssets: 0,
    inputNotesConsumed: 0,
    outputNotesCreated: 0,
    storageChanged: false,
    viewConsumedNotes: [],
    createdNotes: []
  });
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
  const summarySigningInputs = (
    outgoing: ReturnType<typeof fungibleAsset>[],
    unlisted = 0,
    inputs: { id: string; note: { assets: () => unknown } }[] = []
  ) => ({
    variantType: 0,
    transactionSummaryPayload: () => ({
      accountDelta: () => ({
        id: () => ({ __faucet: 'miden-account-1' }),
        vault: () => ({
          removedFungibleAssets: () => outgoing,
          addedFungibleAssets: () => [],
          numAssets: () => outgoing.length + unlisted
        }),
        storage: () => ({ isEmpty: () => true })
      }),
      inputNotes: () => ({
        numNotes: () => inputs.length,
        notes: () => inputs.map(input => ({ id: () => ({ toString: () => input.id }), note: () => input.note }))
      }),
      // `notes()` as well: summary output notes now go through the fee split, because
      // `fee::pay_fee` runs in auth BEFORE the summary is built.
      outputNotes: () => ({
        numNotes: () => 1,
        notes: () => [
          {
            id: () => ({ toString: () => 'stub-note-1' }),
            assets: () => ({ fungibleAssets: () => [], nonFungibleAssets: () => [] }),
            metadata: () => ({ tag: () => ({ asU32: () => 0 }) })
          }
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
    expect(rows).not.toContain(NOT_A_TRANSACTION);
    // The pre-existing rows stay.
    expect(rows).toContain('Kind, signingInputs');
  });

  it('counts a consumed note as leaving and names how many are still unclaimed', async () => {
    sdk.SigningInputs = {
      deserialize: () =>
        summarySigningInputs([], 0, [{ id: 'held-note', note: noteCarrying([fungibleAsset('faucet-usdc', 1500000n)]) }])
    };

    await expect(requestSign(DAPP_ORIGIN, signRequest('signingInputs'), 'session-1')).rejects.toThrow(DECLINED);

    const rows = sheetRows();
    expect(rows).toContain('Sending, -1.5 USDC');
    expect(rows).toContain('Includes notes you have not claimed yet, 1');
    expect(rows).not.toContain(OPAQUE_WARNING);
  });

  it('refuses before any prompt when a consumed note does not list its assets', async () => {
    sdk.SigningInputs = {
      deserialize: () => summarySigningInputs([], 0, [{ id: 'opaque-note', note: { assets: () => undefined } }])
    };

    await expect(requestSign(DAPP_ORIGIN, signRequest('signingInputs'), 'session-1')).rejects.toThrow(
      `${DECLINED}: a held note does not list its assets`
    );
    expect(mockRequestConfirmation).not.toHaveBeenCalled();
  });

  it('keeps a WASM startup failure as its own error and decodes nothing before it', async () => {
    const startupFailure = new Error('wasm failed to start');
    sdk.MidenClient = { ready: () => Promise.reject(startupFailure) };
    const deserialize = jest.fn(() => summarySigningInputs([]));
    sdk.SigningInputs = { deserialize };

    await expect(requestSign(DAPP_ORIGIN, signRequest('signingInputs'), 'session-1')).rejects.toBe(startupFailure);
    expect(deserialize).not.toHaveBeenCalled();
    expect(mockRequestConfirmation).not.toHaveBeenCalled();
  });

  it('refuses before any prompt when decoding the signing payload traps', async () => {
    sdk.SigningInputs = {
      deserialize: () => {
        throw new WebAssembly.RuntimeError('unreachable');
      }
    };

    await expect(requestSign(DAPP_ORIGIN, signRequest('signingInputs'), 'session-1')).rejects.toThrow(
      MidenDAppErrorType.InvalidParams
    );
    expect(mockRequestConfirmation).not.toHaveBeenCalled();
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

  it('warns when the summary changes the vault by an asset it cannot list, instead of saying none moves', async () => {
    sdk.SigningInputs = { deserialize: () => summarySigningInputs([], 1) };

    await expect(requestSign(DAPP_ORIGIN, signRequest('signingInputs'), 'session-1')).rejects.toThrow(DECLINED);

    const rows = sheetRows();
    expect(rows).toEqual(expect.arrayContaining([expect.stringMatching(/^Warning, .*cannot list.*NFT/)]));
    expect(rows).not.toContain('Assets, no fungible asset moves');
  });

  it('warns explicitly for an Arbitrary payload, which carries no readable summary', async () => {
    sdk.SigningInputs = { deserialize: () => ({ variantType: 1 }) };

    await expect(requestSign(DAPP_ORIGIN, signRequest('signingInputs'), 'session-1')).rejects.toThrow(DECLINED);

    const rows = sheetRows();
    expectWarningThenLine(rows);
    expect(rows.some(row => row.startsWith('Sending, '))).toBe(false);
  });

  it('warns explicitly when the payload does not decode at all', async () => {
    sdk.SigningInputs = {
      deserialize: () => {
        throw new Error('not signing inputs');
      }
    };

    await expect(requestSign(DAPP_ORIGIN, signRequest('signingInputs'), 'session-1')).rejects.toThrow(DECLINED);

    expectWarningThenLine(sheetRows());
  });

  it('warns explicitly for a raw `word` digest', async () => {
    await expect(requestSign(DAPP_ORIGIN, signRequest('word'), 'session-1')).rejects.toThrow(DECLINED);

    expectWarningThenLine(sheetRows());
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

  it('renders the simulated asset movement, never the movement the request declares', async () => {
    // The request declares 9 USDC; the dry run of the same bytes moves 2.5 USDC. The sheet shows only the dry run.
    sdk.TransactionRequest = {
      deserialize: () => ({
        expectedOutputOwnNotes: () => [noteCarrying([fungibleAsset('faucet-usdc', 9000000n)])]
      })
    };
    mockSimulatedView.mockReturnValue({
      account: 'miden-account-1',
      outgoing: [{ faucetId: 'faucet-usdc', amount: 2500000n }],
      incoming: [],
      outgoingNfts: [],
      incomingNfts: [],
      unlistedAssets: 0,
      inputNotesConsumed: 0,
      outputNotesCreated: 1,
      storageChanged: false,
      viewConsumedNotes: [],
      createdNotes: [{ id: '0xsent', amounts: [{ faucetId: 'faucet-usdc', amount: 2500000n }], nfts: [] }]
    });

    await expect(
      requestTransaction(DAPP_ORIGIN, customRequest('mtst1qqqqqqqqqqqqqqqqqqqqqqqqqqqsavings'), 'session-1')
    ).rejects.toThrow(DECLINED);

    const rows = sheetRows();
    expect(rows).toContain('Leaves this account, -2.5 USDC');
    expect(rows).not.toContain('Sending, -9 USDC');
    expect(rows).not.toContain('Declared by the site, the wallet has not verified these amounts');
  });

  it('refuses a request that cannot be simulated before showing a confirmation sheet', async () => {
    sdk.TransactionRequest = {
      deserialize: () => ({
        expectedOutputOwnNotes: () => [noteCarrying([fungibleAsset('faucet-usdc', 2500000n)])]
      })
    };
    mockSimulate.mockResolvedValue({ error: 'note not found' });

    await expect(
      requestTransaction(DAPP_ORIGIN, customRequest('mtst1qqqqqqqqqqqqqqqqqqqqqqqqqqqsavings'), 'session-1')
    ).rejects.toThrow(`${MidenDAppErrorType.NotGranted}: The transaction could not be simulated`);

    expect(mockRequestConfirmation).not.toHaveBeenCalled();
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

  it('rejects request bytes that cannot be deserialized before showing a confirmation sheet', async () => {
    sdk.TransactionRequest = {
      deserialize: () => {
        throw new Error('not a transaction request');
      }
    };

    await expect(
      requestTransaction(DAPP_ORIGIN, customRequest('mtst1qqqqqqqqqqqqqqqqqqqqqqqqqqqsavings'), 'session-1')
    ).rejects.toThrow(MidenDAppErrorType.InvalidParams);

    expect(mockRequestConfirmation).not.toHaveBeenCalled();
  });

  it('answers a kill during the request decode with the kill, not INVALID_PARAMS', async () => {
    const kill = new WasmClientPoisonedError('watchdog', new Error('decode parked'));
    sdk.TransactionRequest = {
      deserialize: () => {
        throw new Error('decode wrapper', { cause: kill });
      }
    };

    await expect(
      requestTransaction(DAPP_ORIGIN, customRequest('mtst1qqqqqqqqqqqqqqqqqqqqqqqqqqqsavings'), 'session-1')
    ).rejects.toBe(kill);

    expect(mockRequestConfirmation).not.toHaveBeenCalled();
  });

  it('waits for the SDK to load before decoding the request', async () => {
    let loaded = false;
    let finishLoading = (): void => undefined;
    const loading = new Promise<void>(resolve => {
      finishLoading = () => {
        loaded = true;
        resolve();
      };
    });
    const ready = jest.fn(() => loading);
    sdk.MidenClient = { ready };
    // A cold realm cannot decode until the SDK has loaded.
    const deserialize = jest.fn(() => {
      if (!loaded) throw new Error('the SDK has not loaded');
      return { expectedOutputOwnNotes: () => [] };
    });
    sdk.TransactionRequest = { deserialize };

    const answer = requestTransaction(
      DAPP_ORIGIN,
      customRequest('mtst1qqqqqqqqqqqqqqqqqqqqqqqqqqqsavings'),
      'session-1'
    );
    for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0));
    expect(ready).toHaveBeenCalled();
    expect(deserialize).not.toHaveBeenCalled();

    finishLoading();
    await expect(answer).rejects.toThrow(DECLINED);
    expect(mockRequestConfirmation).toHaveBeenCalledTimes(1);
  });

  it('answers a WASM startup failure with its own error, not INVALID_PARAMS', async () => {
    const startupFailure = new Error('wasm failed to start');
    sdk.MidenClient = { ready: () => Promise.reject(startupFailure) };
    const deserialize = jest.fn(() => ({ expectedOutputOwnNotes: () => [] }));
    sdk.TransactionRequest = { deserialize };

    await expect(
      requestTransaction(DAPP_ORIGIN, customRequest('mtst1qqqqqqqqqqqqqqqqqqqqqqqqqqqsavings'), 'session-1')
    ).rejects.toBe(startupFailure);

    expect(deserialize).not.toHaveBeenCalled();
    expect(mockRequestConfirmation).not.toHaveBeenCalled();
  });

  it('refuses a request whose request decode traps before showing a confirmation sheet (F-001)', async () => {
    sdk.TransactionRequest = {
      deserialize: () => {
        throw new WebAssembly.RuntimeError('unreachable');
      }
    };

    await expect(
      requestTransaction(DAPP_ORIGIN, customRequest('mtst1qqqqqqqqqqqqqqqqqqqqqqqqqqqsavings'), 'session-1')
    ).rejects.toThrow(MidenDAppErrorType.InvalidParams);

    expect(mockRequestConfirmation).not.toHaveBeenCalled();
  });

  it('lists an NFT the dry run moves by its faucet and short id', async () => {
    sdk.TransactionRequest = { deserialize: () => ({ expectedOutputOwnNotes: () => [] }) };
    // The request brings the note carrying the NFT, so the NFT enters the holdings.
    mockSimulate.mockResolvedValue({ summaryBytes: 'sumB64', introducedNoteIds: ['0xcarried'] });
    mockSimulatedView.mockReturnValue({
      account: 'miden-account-1',
      outgoing: [],
      incoming: [],
      outgoingNfts: [],
      incomingNfts: [{ faucetId: 'mtst1nftfaucetaaaaaaaaaaaaaaaaaa', assetId: '0xcdcdcdcd…cdcdcd' }],
      unlistedAssets: 0,
      inputNotesConsumed: 1,
      outputNotesCreated: 0,
      storageChanged: false,
      viewConsumedNotes: [
        {
          id: '0xcarried',
          amounts: [],
          nfts: [{ faucetId: 'mtst1nftfaucetaaaaaaaaaaaaaaaaaa', assetId: '0xcdcdcdcd…cdcdcd' }]
        }
      ],
      createdNotes: []
    });

    await expect(
      requestTransaction(DAPP_ORIGIN, customRequest('mtst1qqqqqqqqqqqqqqqqqqqqqqqqqqqsavings'), 'session-1')
    ).rejects.toThrow(DECLINED);

    expect(sheetRows()).toEqual(
      expect.arrayContaining([expect.stringMatching(/^Enters this account, NFT 0xcdcdcdcd\u2026cdcdcd from faucet /)])
    );
  });
});

describe('signBytes developer documentation', () => {
  it('says what the wallet signs for each kind and how to verify it', () => {
    const guide = fs.readFileSync(path.join(__dirname, '../../../../docs/developers/index.html'), 'utf8');
    const start = guide.indexOf('id="signing"');
    const end = guide.indexOf('id="login"');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const section = guide.slice(start, end);
    expect(section).toContain('signedCommitment');
    expect(section).toContain('publicKey.verify');
    expect(section).toContain('miden-wallet/sign-bytes/v1');

    const source = fs.readFileSync(__filename, 'utf8');
    const header = source.slice(0, source.indexOf('\nimport '));
    expect(header).not.toContain('secretKey.signData(SigningInputs');
    expect(header).toContain('cannot authorize');
  });
});
