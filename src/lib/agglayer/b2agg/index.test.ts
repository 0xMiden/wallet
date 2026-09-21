/* eslint-disable import/first -- the jest.mock() factories above must be registered before the modules under test are imported. */
/**
 * Regression guard for the Agglayer (Slow) bridge-out row's `faucetId`.
 *
 * The caller may pass the faucet as a HEX account id, the form
 * `AccountId.fromHex` needs to build the B2AGG note's asset. But the transaction
 * ROW must carry the bech32 id, because that is what every other producer writes
 * and every consumer matches on: `getTokenMetadata` looks the row's `faucetId` up
 * in a store keyed by the bech32 ids `fetchBalances` produces (a miss silently
 * yields "Unknown" + the 6-decimal fallback, it never triggers a fetch), and
 * `matchesTokenId` compares `tx.faucetId === tokenId` verbatim against the bech32
 * id of the open token — so a hex id also drops the row out of that token's
 * history entirely.
 */
const mockInitiateBridgedSendTransaction = jest.fn(async (...args: unknown[]): Promise<string> => {
  void args;
  return 'tx-agglayer';
});

jest.mock('lib/miden/activity', () => ({
  initiateBridgedSendTransaction: (...args: unknown[]) => mockInitiateBridgedSendTransaction(...args),
  requestSWTransactionProcessing: jest.fn(),
  startBackgroundTransactionProcessing: jest.fn(),
  waitForTransactionCompletion: jest.fn(async () => ({ txHash: '0xhash' }))
}));
// The lock hands its callback a HOLD, and the request build re-checks ownership
// after the awaited note build (#788 follow-up). Model both here: a hold-less
// pass-through would make `assertWasmHoldCurrent` throw on the happy path, and a
// mock with no way to revoke ownership could not exercise the eviction guard.
let currentWasmHold: object | null = null;
const revokeWasmHold = () => {
  currentWasmHold = null;
};

jest.mock('lib/miden/sdk/miden-client', () => ({
  getCurrentWasmLockHold: () => currentWasmHold,
  // Re-implements the real comparison against the mock's current hold — a no-op
  // here would make the eviction test below vacuously green.
  assertWasmHoldCurrent: (hold: object | null, where: string) => {
    if (hold !== null && hold === currentWasmHold) return;
    throw new Error(`operation abandoned ${where}`);
  },
  withWasmClientLock: async (fn: (hold: object) => unknown) => {
    const hold = { mock: 'wasm-lock-hold' };
    currentWasmHold = hold;
    try {
      return await fn(hold);
    } finally {
      if (currentWasmHold === hold) currentWasmHold = null;
    }
  }
}));
jest.mock('lib/platform', () => ({ isExtension: () => true }));

// Effective network is localnet, so a correctly-encoded row id starts `mlcl1`.
jest.mock('lib/miden-chain/constants', () => ({ getNetworkId: () => 'mlcl' }));

const mockCreateB2AggNote = jest.fn((...args: unknown[]): unknown => {
  void args;
  return { note: true };
});

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  // `randomFeeSalt` builds the declared fee-conversion salt from these; it used to run
  // inside the (mocked-away) fee-auth helper, so the SDK mock never needed them.
  Felt: jest.fn((v: any) => ({ v })),
  Word: { newFromFelts: jest.fn((felts: any) => ({ kind: 'word', felts })) },
  AccountId: { fromHex: (hex: string) => ({ hex }) },
  Address: {
    fromAccountId: (accountId: { hex: string }) => ({ toBech32: (net: string) => `${net}1${accountId.hex.slice(2)}` }),
    fromBech32: (address: string) => ({ accountId: () => ({ hex: `0x${address.slice(5)}` }) })
  },
  EthAddress: { fromHex: (hex: string) => ({ hex }) },
  FungibleAsset: jest.fn((faucet: unknown, amount: unknown) => ({ faucet, amount })),
  Note: { createB2AggNote: (...args: unknown[]) => mockCreateB2AggNote(...args) },
  NoteArray: class {},
  NoteAssets: jest.fn((assets: unknown) => ({ assets })),
  TransactionRequest: { deserialize: jest.fn() },
  TransactionRequestBuilder: class {
    withOwnOutputNotes() {
      return this;
    }
    withFeeConversionSalt() {
      return this;
    }
    build() {
      return { serialize: () => new Uint8Array([1, 2, 3]) };
    }
  }
}));

import { TransactionRequest } from '@miden-sdk/miden-sdk/lazy';

import { MIDEN_AGGLAYER_FAUCET_ID } from './constant';
import { initiateB2AggBridge } from './index';

describe('initiateB2AggBridge', () => {
  beforeEach(() => jest.clearAllMocks());

  it('records the faucet id on the row in BECH32 form, never the raw hex constant', async () => {
    const txId = await initiateB2AggBridge({
      amount: 250n,
      faucetId: MIDEN_AGGLAYER_FAUCET_ID,
      destinationAddress: '0x1111111111111111111111111111111111111111',
      senderPublicKey: 'mlcl1sender',
      destinationNetwork: 0
    });

    expect(txId).toBe('tx-agglayer');
    const faucetArg = mockInitiateBridgedSendTransaction.mock.calls[0]![2];
    expect(faucetArg).toBe(`mlcl1${MIDEN_AGGLAYER_FAUCET_ID.slice(2)}`);
    expect(faucetArg).not.toBe(MIDEN_AGGLAYER_FAUCET_ID);
    expect(String(faucetArg).startsWith('0x')).toBe(false);
  });

  it('hands the SDK account ids, not addresses: a hex faucet and a composite wallet publicKey both resolve', async () => {
    await initiateB2AggBridge({
      amount: 250n,
      faucetId: MIDEN_AGGLAYER_FAUCET_ID,
      destinationAddress: '0x1111111111111111111111111111111111111111',
      senderPublicKey: 'mlcl1sender_qr7qqq9wr6w',
      destinationNetwork: 0
    });

    const [sender, bridge] = mockCreateB2AggNote.mock.calls[0]!;
    // The wallet suffix is stripped before the bech32 parse, and the hex faucet
    // goes through `AccountId.fromHex`; both land as account ids.
    expect(sender).toEqual({ hex: '0xsender' });
    expect(bridge).toEqual({ hex: '0x3b66e20b5088f25133b69216484652' });
    const faucetArg = mockInitiateBridgedSendTransaction.mock.calls[0]![2];
    expect(faucetArg).toBe(`mlcl1${MIDEN_AGGLAYER_FAUCET_ID.slice(2)}`);
  });

  // Any asset bridges, so the note and the row must carry the faucet the caller
  // picked. Each case uses a faucet other than the dedicated bridge faucet, so a
  // build that ignored the argument cannot pass by coincidence.
  it.each([
    ['hex', '0x0123456789abcdef0123456789abcd', '0x0123456789abcdef0123456789abcd'],
    ['bech32', 'mlcl1fedcba9876543210fedcba987654_qr7qqq9wr6w', '0xfedcba9876543210fedcba987654']
  ])('builds the note asset and the row from a %s faucet id the caller passes', async (_form, faucetId, faucetHex) => {
    expect(faucetHex).not.toBe(MIDEN_AGGLAYER_FAUCET_ID);

    await initiateB2AggBridge({
      amount: 250n,
      faucetId,
      destinationAddress: '0x1111111111111111111111111111111111111111',
      senderPublicKey: 'mlcl1sender',
      destinationNetwork: 0
    });

    const assets = mockCreateB2AggNote.mock.calls[0]![2];
    expect(assets).toEqual({ assets: [{ faucet: { hex: faucetHex }, amount: 250n }] });
    expect(mockInitiateBridgedSendTransaction.mock.calls[0]![2]).toBe(`mlcl1${faucetHex.slice(2)}`);
  });

  it('still queues the row as an agglayer bridged-send with the pre-built request bytes', async () => {
    await initiateB2AggBridge({
      amount: 250n,
      faucetId: MIDEN_AGGLAYER_FAUCET_ID,
      destinationAddress: '0x1111111111111111111111111111111111111111',
      senderPublicKey: 'mlcl1sender',
      destinationNetwork: 0
    });

    const call = mockInitiateBridgedSendTransaction.mock.calls[0]!;
    expect(call[0]).toBe('mlcl1sender');
    expect(call[1]).toBe(250n);
    expect(call[2]).toBe(`mlcl1${MIDEN_AGGLAYER_FAUCET_ID.slice(2)}`);
    expect(call[5]).toBe('agglayer');
    expect(call[6]).toEqual(new Uint8Array([1, 2, 3]));
    expect(call[7]).toBe(true);
  });

  it('threads the exact spending-limit authorization to atomic row insertion', async () => {
    const spendingLimitAuthorization = {
      kind: 'usd' as const,
      id: 'authorization-1',
      accountId: 'mlcl1sender',
      usdAmount: 250n,
      spendsDigest: 'digest-1',
      revision: 'revision-1',
      issuedAt: 100,
      expiresAt: 220
    };

    await initiateB2AggBridge({
      amount: 250n,
      faucetId: MIDEN_AGGLAYER_FAUCET_ID,
      destinationAddress: '0x1111111111111111111111111111111111111111',
      senderPublicKey: 'mlcl1sender',
      destinationNetwork: 0,
      spendingLimitAuthorization
    });

    expect(mockInitiateBridgedSendTransaction.mock.calls[0]![9]).toBe(spendingLimitAuthorization);
  });

  // #788 follow-up: the awaited note build parks (the lazy SDK load), and an
  // eviction during it hands the mutex to a successor without stopping this
  // callback. Everything in the hold is write PREP — the request is only built
  // and serialized, submission happens later in the pipeline — so aborting is
  // always safe, and it must abort BEFORE a row is queued: a queued row would
  // hand the abandoned request to the processor as a fresh write.
  it('abandons the initiation when the WASM lock hold is evicted during the note build', async () => {
    mockCreateB2AggNote.mockImplementationOnce(() => {
      revokeWasmHold();
      return { note: true };
    });

    await expect(
      initiateB2AggBridge({
        amount: 250n,
        faucetId: MIDEN_AGGLAYER_FAUCET_ID,
        destinationAddress: '0x1111111111111111111111111111111111111111',
        senderPublicKey: 'mlcl1sender',
        destinationNetwork: 0
      })
    ).rejects.toThrow('operation abandoned before the bridge request build');

    // Nothing past the guard ran: no request round-trip, no queued row.
    expect(TransactionRequest.deserialize).not.toHaveBeenCalled();
    expect(mockInitiateBridgedSendTransaction).not.toHaveBeenCalled();
  });
});
