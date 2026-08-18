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
jest.mock('lib/miden/sdk/miden-client', () => ({
  withWasmClientLock: (fn: () => unknown) => fn()
}));
jest.mock('lib/platform', () => ({ isExtension: () => true }));

// Effective network is localnet, so a correctly-encoded row id starts `mlcl1`.
jest.mock('lib/miden-chain/constants', () => ({ getNetworkId: () => 'mlcl' }));

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  AccountId: { fromHex: (hex: string) => ({ hex }) },
  Address: {
    fromAccountId: (accountId: { hex: string }) => ({ toBech32: (net: string) => `${net}1${accountId.hex.slice(2)}` }),
    fromBech32: (address: string) => ({ accountId: () => ({ hex: `0x${address.slice(5)}` }) })
  },
  EthAddress: { fromHex: (hex: string) => ({ hex }) },
  FungibleAsset: class {},
  Note: { createB2AggNote: () => ({ note: true }) },
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
});
