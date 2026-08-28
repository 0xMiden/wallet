/* eslint-disable import/first -- the jest.mock() factories above must be registered before the modules under test are imported. */
/**
 * Regression guard for the Agglayer (Slow) bridge-out row's `faucetId`.
 *
 * `getAgglayerFaucetId()` is a HEX account id — that is the form
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
  AccountId: { fromHex: (hex: string) => ({ hex }) },
  Address: {
    fromAccountId: (accountId: { hex: string }) => ({ toBech32: (net: string) => `${net}1${accountId.hex.slice(2)}` }),
    fromBech32: (address: string) => ({ accountId: () => ({ hex: `0x${address.slice(5)}` }) })
  },
  EthAddress: { fromHex: (hex: string) => ({ hex }) },
  FungibleAsset: class {},
  Note: { createB2AggNote: (...args: unknown[]) => mockCreateB2AggNote(...args) },
  NoteArray: class {},
  NoteAssets: class {},
  TransactionRequest: { deserialize: jest.fn() },
  TransactionRequestBuilder: class {
    withOwnOutputNotes() {
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

  it('still queues the row as an agglayer bridged-send with the pre-built request bytes', async () => {
    await initiateB2AggBridge({
      amount: 250n,
      destinationAddress: '0x1111111111111111111111111111111111111111',
      senderPublicKey: 'mlcl1sender',
      destinationNetwork: 0
    });

    const call = mockInitiateBridgedSendTransaction.mock.calls[0]!;
    expect(call[0]).toBe('mlcl1sender');
    expect(call[1]).toBe(250n);
    expect(call[5]).toBe('agglayer');
    expect(call[6]).toEqual(new Uint8Array([1, 2, 3]));
    expect(call[7]).toBe(true);
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
