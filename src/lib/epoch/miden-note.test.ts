/* eslint-disable import/first -- the jest.mock() factories above must be registered before the modules under test are imported. */
/**
 * Regression guard for the Epoch id-encoding seam.
 *
 * The Epoch SDK hands `createMidenP2IDNote` HEX account ids, and the wallet has to
 * store them in the SAME bech32 form every other producer of a transaction row uses
 * — otherwise `getTokenMetadata` misses (row renders as "Unknown" with the 6-decimal
 * fallback) and `matchesTokenId` drops the row out of that token's history. The
 * encoding must therefore follow the EFFECTIVE network (`getNetworkId()`), not a
 * hardcoded testnet HRP: on a localnet / devnet / mainnet build, or under a
 * dev-settings endpoint override, the same faucet is keyed under a different HRP.
 *
 * `getNetworkId` is stubbed to the localnet HRP so a hardcoded `NetworkId.testnet()`
 * shows up as an `mtst1…` id where an `mlcl1…` one is expected.
 */
const mockInitiateBridgedSendTransaction = jest.fn(async (...args: unknown[]): Promise<string> => {
  void args;
  return 'tx-bridge';
});
const mockInitiateEarnDepositTransaction = jest.fn(async (...args: unknown[]): Promise<string> => {
  void args;
  return 'tx-earn';
});

jest.mock('lib/miden/activity', () => ({
  initiateBridgedSendTransaction: (...args: unknown[]) => mockInitiateBridgedSendTransaction(...args),
  initiateEarnDepositTransaction: (...args: unknown[]) => mockInitiateEarnDepositTransaction(...args),
  requestSWTransactionProcessing: jest.fn(),
  startBackgroundTransactionProcessing: jest.fn(),
  waitForTransactionCompletion: jest.fn(async () => ({ txHash: '0xhash' }))
}));
jest.mock('lib/miden/repo', () => ({
  transactions: { where: () => ({ first: async () => ({ outputNoteIds: ['note-1'] }) }) }
}));
jest.mock('lib/platform', () => ({ isExtension: () => true }));
jest.mock('lib/miden/types', () => ({ NoteTypeEnum: { Public: 'public', Private: 'private' } }));
jest.mock('./chain', () => ({
  MIDEN_MIN_RECLAIM_BLOCKS: 1000,
  MIDEN_RECLAIM_BUFFER_BLOCKS: 200,
  getCurrentMidenBlock: jest.fn(async () => 1000)
}));

// The effective network is localnet here, so every id must come out `mlcl1…`.
jest.mock('lib/miden-chain/constants', () => ({ getNetworkId: () => 'mlcl' }));

// This suite is about ID ENCODING, not note construction. The collateral note is
// built by `buildEpochCollateralRequestBytes`, which reaches deep into the SDK
// (assets, note scripts, attachments) and has its own tests — stubbing it keeps
// these cases from drifting every time the builder gains a dependency.
jest.mock('./collateral-note', () => ({
  buildEpochCollateralRequestBytes: jest.fn(async () => new Uint8Array([1, 2, 3]))
}));

// Minimal SDK stand-in. `AccountId.fromHex(...).toBech32(net)` is kept working so a
// regression to the hardcoded `NetworkId.testnet()` encoding fails with a readable
// `mtst1…` vs `mlcl1…` diff rather than a TypeError.
jest.mock('@miden-sdk/miden-sdk', () => ({
  AccountId: {
    fromHex: (hex: string) => ({ hex, toBech32: (net: string) => `${net}1${hex.slice(2)}` })
  },
  Address: {
    fromBech32: (addr: string) => ({
      accountId: () => ({ hex: addr, toString: () => addr, toBech32: (net: string) => `${net}1${addr.slice(2)}` })
    }),
    fromAccountId: (accountId: { hex: string }) => ({ toBech32: (net: string) => `${net}1${accountId.hex.slice(2)}` })
  },
  NetworkId: { testnet: () => 'mtst', devnet: () => 'mdev', mainnet: () => 'mm', custom: (p: string) => p },
  AccountInterface: { BasicWallet: 'BasicWallet' }
}));

import { createEarnP2IDENote } from './earn-note';
import { createBridgeP2IDENote, ifHextoBech32 } from './miden-note';

const deps = { signTransaction: jest.fn(), guardianProvider: {} } as never;

describe('epoch id encoding (ifHextoBech32)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('encodes a hex id under the EFFECTIVE network HRP, not a hardcoded testnet one', () => {
    expect(ifHextoBech32('0xdeadbeef')).toBe('mlcl1deadbeef');
  });

  it('passes an already-bech32 id through untouched', () => {
    expect(ifHextoBech32('mlcl1alreadyencoded')).toBe('mlcl1alreadyencoded');
  });

  it('stores the effective-network faucet + allocator ids on the bridged-send row', async () => {
    const result = await createBridgeP2IDENote({
      senderAccountId: 'mlcl1sender',
      faucetId: '0xfaucet',
      amount: '250',
      allocatorId: '0xallocator',
      // Both SDK-supplied since #726; this suite only asserts id encoding, so
      // representative values are enough.
      recallBlocks: 5_000,
      bindingAttachmentFelts: [1n, 2n],
      destinationAddress: '0xevm',
      destinationNetwork: 8453,
      deps
    });

    expect(result).toEqual({ success: true, noteId: 'note-1', txId: 'tx-bridge' });
    const [senderArg, , faucetArg, , , , , , sendParams] = mockInitiateBridgedSendTransaction.mock.calls[0]!;
    expect(faucetArg).toBe('mlcl1faucet');
    expect(senderArg).toBe('mlcl1sender');
    expect(sendParams).toMatchObject({ recipientId: 'mlcl1allocator' });
  });

  it('stores the effective-network faucet + allocator ids on the earn-deposit row', async () => {
    // earn-note.ts shares the one helper rather than carrying its own copy, so the
    // same guard has to hold for the Earn leg.
    const result = await createEarnP2IDENote({
      senderAccountId: 'mlcl1sender',
      faucetId: '0xfaucet',
      amount: '250',
      allocatorId: '0xallocator',
      recallBlocks: 5_000,
      bindingAttachmentFelts: [1n, 2n],
      evmRecipient: '0xevm',
      marketUid: 'AAVE:11155111:USDC',
      deps
    });

    expect(result).toEqual({ success: true, noteId: 'note-1', txId: 'tx-earn' });
    const [senderArg, , , , faucetArg, sendParams] = mockInitiateEarnDepositTransaction.mock.calls[0]!;
    expect(faucetArg).toBe('mlcl1faucet');
    expect(senderArg).toBe('mlcl1sender');
    expect(sendParams).toMatchObject({ recipientId: 'mlcl1allocator' });
  });
});
