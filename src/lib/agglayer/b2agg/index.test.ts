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
 * id of the open token - so a hex id also drops the row out of that token's
 * history entirely.
 */
// Every `withExpirationDelta` the B2AGG build makes, in order (#1081).
const mockDeltas: number[] = [];
const mockIsGuardian = jest.fn(async (...args: unknown[]): Promise<boolean> => {
  void args;
  return false;
});

jest.mock('lib/miden/front/guardian-manager', () => ({
  isGuardianAccount: (...a: unknown[]) => mockIsGuardian(...a)
}));

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
// The builder `feeAwareTransactionRequestBuilder` hands back. Since protocol 0.17 it carries the
// three words of fee auth args a guarded (multisig) sender resolves, so the bridge note has to
// land on THIS object; a fresh `TransactionRequestBuilder` would drop them.
// A built request and the own notes it reports creating. The id is upper case to show the row records it as the
// summary decode spells it.
const mockOwnNote = (id = '0xB2A6') => ({ id: () => ({ toString: () => id }) });
const mockBuiltRequest = (notes = [mockOwnNote()]) => ({
  serialize: () => new Uint8Array([1, 2, 3]),
  expectedOutputOwnNotes: () => notes
});
const mockFeeAwareBuilder = {
  withOwnOutputNotes: jest.fn(),
  withExpirationDelta: jest.fn(),
  withFeeConversionSalt: jest.fn(),
  build: jest.fn(() => mockBuiltRequest())
};
const mockFeeAwareTransactionRequestBuilder = jest.fn(
  async (_account: string, _options: { feeConversionSalt: unknown }) => mockFeeAwareBuilder
);
const revokeWasmHold = () => {
  currentWasmHold = null;
};

jest.mock('lib/miden/sdk/miden-client', () => ({
  getCurrentWasmLockHold: () => currentWasmHold,
  // Re-implements the real comparison against the mock's current hold - a no-op
  // here would make the eviction test below vacuously green.
  assertWasmHoldCurrent: (hold: object | null, where: string) => {
    if (hold !== null && hold === currentWasmHold) return;
    throw new Error(`operation abandoned ${where}`);
  },
  getMidenClient: async () => ({
    client: { feeAwareTransactionRequestBuilder: mockFeeAwareTransactionRequestBuilder }
  }),
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
jest.mock('lib/platform', () => ({ ...jest.requireActual('lib/platform'), isExtension: () => true }));
// The bridge account and its L1 network id come from the remote config.
const mockGetBridgeOut = jest.fn();
jest.mock('lib/remote-config/values', () => ({
  ...jest.requireActual('lib/remote-config/values'),
  getAgglayerBridgeOut: () => mockGetBridgeOut()
}));

// The real exit hash needs the real SDK (exit-hash.real-sdk.test.ts); here it only has to reach the row.
const mockAgglayerExitTxHash = jest.fn((...args: unknown[]): string => {
  void args;
  return '0xexit';
});
jest.mock('./exit-hash', () => ({ agglayerExitTxHash: (...args: unknown[]) => mockAgglayerExitTxHash(...args) }));

jest.mock('lib/miden/back/miden-client-proxy', () => ({ midenClientProxy: {} }));
jest.mock('lib/miden/activity/notes', () => ({ queueNoteImport: jest.fn() }));
jest.mock('lib/miden/guardian/account', () => ({ resolveGuardianEndpoint: jest.fn() }));
jest.mock('lib/store', () => ({
  getIntercom: jest.fn(),
  useWalletStore: Object.assign(
    (select: (state: unknown) => unknown) =>
      select({ currentAccount: { publicKey: '0x387149ae66116cf114eebd60bb7381' } }),
    {
      getState: () => ({
        currentAccount: { publicKey: '0x387149ae66116cf114eebd60bb7381' },
        balances: {},
        balancesLoading: {},
        balanceReadFailed: {},
        tokenPricesStatus: 'ready',
        tokenPrices: {}
      })
    }
  )
}));
jest.mock('@reown/appkit/react', () => ({
  useAppKitNetwork: () => ({ chainId: 11155111 }),
  useDisconnect: () => ({ disconnect: jest.fn() })
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('app/hooks/useNativeFeeFaucetId', () => ({ __esModule: true, default: () => null }));
jest.mock('lib/miden/front', () => ({
  useMidenContext: () => ({ locked: false, signTransaction: jest.fn() }),
  useAllBalances: () => ({}),
  useAllTokensBaseMetadata: () => ({})
}));
jest.mock('lib/remote-config/use-feature-availability', () => ({
  useBridgeConfigSnapshot: () => jest.requireActual('lib/bridge/testing/fixtures').referenceSnapshot('testnet')
}));
jest.mock('lib/bridge/wallet-transport', () => ({
  quoteBridgeTransfer: async (request: unknown) => {
    const value = jest.requireActual('lib/bridge/core/quote');
    return value.bindTransferQuote(request, { kind: 'agglayer', received: '1', validity: { kind: 'provider' } });
  }
}));
jest.mock('lib/epoch/client', () => ({
  buildEpochWalletClient: jest.fn(),
  getEvmConnection: jest.fn(),
  switchWebWalletChain: jest.fn()
}));
jest.mock('lib/walletconnect/native', () => ({ ensureNativeSessionChain: jest.fn() }));
jest.mock('lib/walletconnect/useEvmWalletConnection', () => ({
  useEvmWalletConnection: () => ({
    address: '0x1111111111111111111111111111111111111111',
    connected: true,
    nativeReown: {},
    useNativeReownWallet: false
  })
}));
jest.mock('lib/miden/front/guardian-sync', () => ({
  zustandProvider: { getAccounts: async () => [], getPublicKeyForCommitment: async () => '', signWord: async () => '' }
}));
jest.mock('lib/woozie', () => ({
  navigate: jest.fn(),
  goBack: jest.fn(),
  createLocationState: () => ({ historyPosition: 1 }),
  listen: () => () => {}
}));
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getActiveOverride: () => null,
  getEffectiveNetworkName: () => 'testnet',
  getEffectiveRpcUrl: jest.fn(() => 'https://wallet-rpc.example/private')
}));
jest.mock('lib/remote-config/runtime', () => ({
  getBridgeConfigSnapshot: () =>
    jest
      .requireActual<typeof import('lib/bridge/testing/fixtures')>('lib/bridge/testing/fixtures')
      .referenceSnapshot('testnet')
}));

// Effective network is localnet, so a correctly-encoded row id starts `mlcl1`.
jest.mock('lib/miden-chain/constants', () => ({
  ...jest.requireActual('lib/miden-chain/networks-config'),
  getNetworkId: () => 'mlcl'
}));

class MockAccountId {
  hex: string;
  constructor(hex: string) {
    this.hex = hex;
  }
  toString() {
    return this.hex;
  }
}

const mockCreateB2AggNote = jest.fn((...args: unknown[]): unknown => {
  void args;
  return { note: true };
});

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  ...jest.requireActual('@miden-sdk/miden-sdk/lazy'),
  // `randomFeeSalt` builds the declared fee-conversion salt from these; it used to run
  // inside the (mocked-away) fee-auth helper, so the SDK mock never needed them.
  Felt: jest.fn((v: any) => ({ v })),
  Word: { newFromFelts: jest.fn((felts: any) => ({ kind: 'word', felts })) },
  // `toString` lives on the prototype so `toEqual({ hex })` still matches, while the id the
  // fee-aware builder is asked for reads as the hex it wraps.
  AccountId: { fromHex: (hex: string) => new MockAccountId(hex) },
  Address: {
    fromAccountId: (accountId: { hex: string }) => ({ toBech32: (net: string) => `${net}1${accountId.hex.slice(2)}` }),
    fromBech32: (address: string) => ({ accountId: () => new MockAccountId(`0x${address.slice(5)}`) })
  },
  EthAddress: { fromHex: (hex: string) => ({ hex }) },
  FungibleAsset: jest.fn((faucet: unknown, amount: unknown) => ({ faucet, amount })),
  Note: { createB2AggNote: (...args: unknown[]) => mockCreateB2AggNote(...args) },
  NoteArray: class {
    notes: unknown[];
    constructor(notes: unknown[]) {
      this.notes = notes;
    }
  },
  NoteAssets: jest.fn((assets: unknown) => ({ assets })),
  TransactionRequest: { deserialize: jest.fn() },
  // The request starts from the fee-aware builder; constructing this would drop the fee auth args.
  TransactionRequestBuilder: jest.fn()
}));

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TransactionRequest, TransactionRequestBuilder, Word } from '@miden-sdk/miden-sdk/lazy';
import { CommandBridge } from 'screens/command/bridge/CommandBridge';
import { CommandDraftProvider } from 'screens/command/command-drafts';
import { CommandWorkbench } from 'screens/command/CommandWorkbench';
import { FlowPresentationProvider, CommandFlowBackProvider } from 'components/flow/FlowPresentation';
import { navigate } from 'lib/woozie';
import { deriveBridgeRoutes } from 'lib/bridge/catalog';

import { runAgglayerSend } from 'lib/bridge/providers/agglayer/flows';
import { accounts, now, referenceSnapshot } from 'lib/bridge/testing/fixtures';
import { reviewedErc20Transfer } from 'lib/bridge/testing/operation-fixtures';
import { submitReviewedBridge } from 'lib/bridge/wallet-submit';
import { TEST_NATIVE_ETH_FAUCET as MIDEN_AGGLAYER_FAUCET_ID } from 'lib/epoch/testing/bridge-config';
import type { GuardianAccountProvider } from 'lib/miden/front/guardian-manager';
import * as Repo from 'lib/miden/repo';
import { initiateBridgedSendTransaction } from 'lib/miden/transaction/initiate';
import { getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { selectAgglayerRecoveryConfig } from 'lib/remote-config/values';

import { initiateB2AggBridge } from './index';

// Never reached: `isGuardianAccount` is mocked, so only its identity crosses.
const guardianProvider: GuardianAccountProvider = {
  getAccounts: async () => [],
  getPublicKeyForCommitment: async () => '',
  signWord: async () => ''
};

describe('initiateB2AggBridge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDeltas.length = 0;
    mockIsGuardian.mockResolvedValue(false);
    mockFeeAwareBuilder.withOwnOutputNotes.mockReturnValue(mockFeeAwareBuilder);
    mockFeeAwareBuilder.withExpirationDelta.mockImplementation((delta: number) => {
      mockDeltas.push(delta);
      return mockFeeAwareBuilder;
    });
    mockGetBridgeOut.mockReturnValue({ midenBridge: '0x3b66e20b5088f25133b69216484652', evmNetworkId: 0 });
  });

  it('records the faucet id on the row in BECH32 form, never the raw hex constant', async () => {
    const txId = await initiateB2AggBridge({
      amount: 250n,
      faucetId: MIDEN_AGGLAYER_FAUCET_ID,
      destinationAddress: '0x1111111111111111111111111111111111111111',
      senderPublicKey: 'mlcl1sender',
      guardianProvider
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
      guardianProvider
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
      guardianProvider
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
      guardianProvider
    });

    const call = mockInitiateBridgedSendTransaction.mock.calls[0]!;
    expect(call[0]).toBe('mlcl1sender');
    expect(call[1]).toBe(250n);
    expect(call[2]).toBe(`mlcl1${MIDEN_AGGLAYER_FAUCET_ID.slice(2)}`);
    expect(call[5]).toBe('agglayer');
    expect(call[6]).toBe('0xb2a6');
    expect(call[7]).toEqual(new Uint8Array([1, 2, 3]));
    expect(call[8]).toBe(true);
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
      guardianProvider,
      spendingLimitAuthorization
    });

    expect(mockInitiateBridgedSendTransaction.mock.calls[0]![10]).toBe(spendingLimitAuthorization);
  });

  // Since protocol 0.17 a guarded (multisig) sender needs three words of fee auth args, and
  // `withFeeConversionSalt` committed two (`advice stack read failed` at the proposal). The
  // request therefore starts from the fee-aware builder for the account that executes it.
  it('builds the request from the fee-aware builder of the sending account, with the declared salt', async () => {
    await initiateB2AggBridge({
      amount: 250n,
      faucetId: MIDEN_AGGLAYER_FAUCET_ID,
      destinationAddress: '0x1111111111111111111111111111111111111111',
      senderPublicKey: 'mlcl1sender_qr7qqq9wr6w',
      guardianProvider
    });

    // The sender's account id, wallet suffix stripped; the salt is the one drawn for this build.
    expect(mockFeeAwareTransactionRequestBuilder).toHaveBeenCalledTimes(1);
    expect(mockFeeAwareTransactionRequestBuilder).toHaveBeenCalledWith('0xsender', {
      feeConversionSalt: (Word.newFromFelts as jest.Mock).mock.results[0]!.value
    });
    expect(Word.newFromFelts).toHaveBeenCalledTimes(1);
    const [notes] = mockFeeAwareBuilder.withOwnOutputNotes.mock.calls[0];
    expect(notes).toEqual({ notes: [mockCreateB2AggNote.mock.results[0]!.value] });
    expect(mockFeeAwareBuilder.build).toHaveBeenCalledTimes(1);
    expect(mockFeeAwareBuilder.withFeeConversionSalt).not.toHaveBeenCalled();
    expect(TransactionRequestBuilder).not.toHaveBeenCalled();
    expect(mockInitiateBridgedSendTransaction.mock.calls[0]![7]).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('abandons the initiation when the WASM lock hold is evicted while the fee-aware builder resolves', async () => {
    mockFeeAwareTransactionRequestBuilder.mockImplementationOnce(async () => {
      revokeWasmHold();
      return mockFeeAwareBuilder;
    });

    await expect(
      initiateB2AggBridge({
        amount: 250n,
        faucetId: MIDEN_AGGLAYER_FAUCET_ID,
        destinationAddress: '0x1111111111111111111111111111111111111111',
        senderPublicKey: 'mlcl1sender',
        guardianProvider
      })
    ).rejects.toThrow('operation abandoned after the fee-aware bridge builder');

    expect(mockFeeAwareBuilder.withOwnOutputNotes).not.toHaveBeenCalled();
    expect(mockInitiateBridgedSendTransaction).not.toHaveBeenCalled();
  });

  // #788 follow-up: the awaited note build parks (the lazy SDK load), and an
  // eviction during it hands the mutex to a successor without stopping this
  // callback. Everything in the hold is write PREP - the request is only built
  // and serialized, submission happens later in the pipeline - so aborting is
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
        guardianProvider
      })
    ).rejects.toThrow('operation abandoned before the bridge request build');

    // Nothing past the guard ran: no exit hash, no request round-trip, no queued row.
    expect(mockAgglayerExitTxHash).not.toHaveBeenCalled();
    expect(TransactionRequest.deserialize).not.toHaveBeenCalled();
    expect(mockInitiateBridgedSendTransaction).not.toHaveBeenCalled();
  });

  it.each([
    [false, 600],
    [true, 180]
  ])(
    'builds the B2AGG request with the delta its route needs (Guardian: %s -> %s blocks) (#1081)',
    async (guardian, delta) => {
      mockIsGuardian.mockResolvedValue(guardian);
      await initiateB2AggBridge({
        amount: 1n,
        faucetId: MIDEN_AGGLAYER_FAUCET_ID,
        destinationAddress: '0x1111111111111111111111111111111111111111',
        senderPublicKey: 'mlcl1sender',
        guardianProvider
      });
      expect(mockIsGuardian).toHaveBeenCalledWith('mlcl1sender', guardianProvider);
      expect(mockDeltas).toEqual([delta]);
    }
  );

  // The indexer files the exit under this hash, and the row needs it to find its own deposit (#1325).
  it('hands the row the exit hash of the note it built', async () => {
    await initiateB2AggBridge({
      amount: 250n,
      faucetId: MIDEN_AGGLAYER_FAUCET_ID,
      destinationAddress: '0x1111111111111111111111111111111111111111',
      senderPublicKey: 'mlcl1sender',
      guardianProvider
    });

    expect(mockAgglayerExitTxHash).toHaveBeenCalledWith({ note: true });
    expect(mockInitiateBridgedSendTransaction.mock.calls[0]![11]).toBe('0xexit');
  });

  // Signing may create only this note, so the row records the one note the request it queues creates.
  it('records the id of the note the built request creates on the row', async () => {
    await initiateB2AggBridge({
      amount: 250n,
      faucetId: MIDEN_AGGLAYER_FAUCET_ID,
      destinationAddress: '0x1111111111111111111111111111111111111111',
      senderPublicKey: 'mlcl1sender',
      guardianProvider
    });

    expect(mockInitiateBridgedSendTransaction.mock.calls[0]![6]).toBe('0xb2a6');
  });

  it.each([
    ['no note', []],
    ['two notes', [mockOwnNote('0xB2A6'), mockOwnNote('0xOTHER')]]
  ])('queues no row when the built request creates %s rather than one', async (_count, notes) => {
    mockFeeAwareBuilder.build.mockReturnValueOnce(mockBuiltRequest(notes));

    await expect(
      initiateB2AggBridge({
        amount: 250n,
        faucetId: MIDEN_AGGLAYER_FAUCET_ID,
        destinationAddress: '0x1111111111111111111111111111111111111111',
        senderPublicKey: 'mlcl1sender',
        guardianProvider
      })
    ).rejects.toThrow(`the request creates ${notes.length} own output notes, not one`);
    expect(mockInitiateBridgedSendTransaction).not.toHaveBeenCalled();
  });

  it('queues no row when the exit hash cannot be computed, since that row could never settle', async () => {
    mockAgglayerExitTxHash.mockImplementationOnce(() => {
      throw new Error('A B2AGG note carries at least one fungible asset');
    });

    await expect(
      initiateB2AggBridge({
        amount: 250n,
        faucetId: MIDEN_AGGLAYER_FAUCET_ID,
        destinationAddress: '0x1111111111111111111111111111111111111111',
        senderPublicKey: 'mlcl1sender',
        guardianProvider
      })
    ).rejects.toThrow('A B2AGG note carries at least one fungible asset');
    expect(mockInitiateBridgedSendTransaction).not.toHaveBeenCalled();
  });

  it('addresses the note to the configured bridge and network, and records that network on the row', async () => {
    mockGetBridgeOut.mockReturnValue({ midenBridge: '0x0123456789abcdef0123456789abcd', evmNetworkId: 7 });

    await initiateB2AggBridge({
      amount: 250n,
      faucetId: MIDEN_AGGLAYER_FAUCET_ID,
      destinationAddress: '0x1111111111111111111111111111111111111111',
      senderPublicKey: 'mlcl1sender',
      guardianProvider
    });

    const [, bridge, , destinationNetwork] = mockCreateB2AggNote.mock.calls[0]!;
    expect(bridge).toEqual({ hex: '0x0123456789abcdef0123456789abcd' });
    expect(destinationNetwork).toBe(7);
    expect(mockInitiateBridgedSendTransaction.mock.calls[0]![4]).toBe(7);
  });

  it('builds and queues nothing while the bridge config cannot name the bridge-out values', async () => {
    mockGetBridgeOut.mockImplementation(() => {
      throw new Error('bridge out unavailable');
    });

    await expect(
      initiateB2AggBridge({
        amount: 250n,
        faucetId: MIDEN_AGGLAYER_FAUCET_ID,
        destinationAddress: '0x1111111111111111111111111111111111111111',
        senderPublicKey: 'mlcl1sender',
        guardianProvider
      })
    ).rejects.toThrow('bridge out unavailable');

    expect(mockCreateB2AggNote).not.toHaveBeenCalled();
    expect(mockInitiateBridgedSendTransaction).not.toHaveBeenCalled();
  });
});

describe('reviewed Agglayer native admission uses the existing queue', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://wallet-rpc.example/private');
    await Repo.transactions.clear();
    mockFeeAwareBuilder.withOwnOutputNotes.mockReturnValue(mockFeeAwareBuilder);
    mockFeeAwareBuilder.withExpirationDelta.mockReturnValue(mockFeeAwareBuilder);
    mockFeeAwareBuilder.build.mockImplementation(() => mockBuiltRequest());
    mockCreateB2AggNote.mockReturnValue({ note: true });
    mockAgglayerExitTxHash.mockReturnValue(`0x${'c'.repeat(64)}`);
    const recovery = selectAgglayerRecoveryConfig(referenceSnapshot('testnet'), 11155111);
    if (!recovery) throw new Error('Missing accepted native route');
    mockGetBridgeOut.mockReturnValue({
      midenBridge: recovery.midenBridgeId,
      evmNetworkId: recovery.evmNetworkId,
      recovery
    });
    mockInitiateBridgedSendTransaction.mockImplementation((...args: unknown[]) =>
      Reflect.apply(initiateBridgedSendTransaction, undefined, args)
    );
  });
  afterEach(() => {
    cleanup();
    jest.restoreAllMocks();
  });

  function input() {
    const review = reviewedErc20Transfer('agglayer', 'send');
    if (review.route.source.kind !== 'miden') throw new Error('Missing native asset');
    return {
      amount: 100000000n,
      faucetId: review.route.source.faucetId,
      destinationAddress: `0x${accounts.evmAddress.slice(2)}` satisfies `0x${string}`,
      senderPublicKey: accounts.midenAccount,
      guardianProvider,
      destinationChainId: 11155111,
      operation: { operationId: 'native-agglayer-operation', review }
    };
  }

  it.each([false, true])(
    'coalesces the original reviewed operation through real native admission (Guardian=%s)',
    async guardian => {
      mockIsGuardian.mockResolvedValue(guardian);
      const first = await initiateB2AggBridge(input());
      const second = await initiateB2AggBridge(input());
      const row = await Repo.transactions.get(first);
      expect(row?.extraInputs.bridgeOperation?.operationId).toBe('native-agglayer-operation');
      expect(second).toBe(first);
      expect(await Repo.transactions.count()).toBe(1);
      expect(row?.extraInputs.agglayerExitTxHash).toBe(`0x${'c'.repeat(64)}`);
      expect(row?.extraInputs.bridgeOperation?.sourceAttempt).toBeUndefined();
    }
  );

  it('adapts the reviewed provider send into the native queue with its exact Miden source scale', async () => {
    mockIsGuardian.mockResolvedValue(false);
    const id = await runAgglayerSend(input().operation, { guardianProvider });
    const row = await Repo.transactions.get(id);
    expect(row?.amount).toBe(100000000n);
    expect(row?.extraInputs.bridgeOperation?.operationId).toBe('native-agglayer-operation');
    expect(row?.extraInputs.agglayerExitTxHash).toBe(`0x${'c'.repeat(64)}`);
    expect(row?.extraInputs.bridgeOperation?.sourceAttempt).toBeUndefined();
    expect(await Repo.transactions.count()).toBe(1);
  });

  it.each([false, true])(
    'actual Command form Enter admits once, stays visible and opens only the original row (Guardian=%s)',
    async guardian => {
      mockIsGuardian.mockResolvedValue(guardian);
      render(
        React.createElement(CommandDraftProvider, {
          scope: { accountId: accounts.midenAccount, network: 'testnet', rpcUrl: 'https://wallet-rpc.example/private' },
          children: React.createElement(FlowPresentationProvider, {
            value: 'command',
            children: React.createElement(CommandFlowBackProvider, {
              children: React.createElement(CommandWorkbench, {
                route: { kind: 'flow', action: 'bridge' },
                container: null,
                children: React.createElement(CommandBridge)
              })
            })
          })
        })
      );
      fireEvent.click(screen.getByRole('radio', { name: 'commandBridgeOut' }));
      const route = deriveBridgeRoutes(referenceSnapshot('testnet')).find(
        item => item.mode === 'send' && item.provider === 'agglayer' && item.source.symbol === 'USDC'
      );
      if (!route) throw new Error('Missing real catalog route');
      fireEvent.click(screen.getByTestId(`command-bridge-route-${route.id}`));
      fireEvent.change(screen.getByRole('textbox', { name: 'commandBridgeExternalAccount' }), {
        target: { value: accounts.evmAddress }
      });
      fireEvent.change(screen.getByRole('textbox', { name: 'amount' }), { target: { value: '1.00000000' } });
      const form = screen.getByRole('textbox', { name: 'amount' }).closest('form');
      if (!form) throw new Error('Missing actual form');
      await waitFor(() => expect(screen.getByRole('button', { name: 'reviewDetails' })).toBeEnabled());
      fireEvent.submit(form);
      expect(screen.queryByRole('textbox', { name: 'amount' })).toBeNull();
      fireEvent.submit(form);
      await waitFor(async () => expect(await Repo.transactions.count()).toBe(1));
      expect(screen.getByTestId('command-bridge')).toBeVisible();
      expect(navigate).not.toHaveBeenCalled();
      fireEvent.submit(form);
      expect(await Repo.transactions.count()).toBe(1);
      const row = (await Repo.transactions.toArray())[0];
      fireEvent.click(screen.getByRole('button', { name: 'commandBridgeViewStatus' }));
      expect(navigate).toHaveBeenCalledWith(`/history-details/${row.id}`);
      expect(await Repo.transactions.count()).toBe(1);
    }
  );

  it.each([false, true])(
    'public Command admission returns the original row, not its correlation, across same-consent calls (Guardian=%s)',
    async guardian => {
      mockIsGuardian.mockResolvedValue(guardian);
      const review = input().operation.review;
      const observed = jest.fn();
      const deps = {
        guardianProvider,
        signTransaction: async () => new Uint8Array(),
        getContext: () => review,
        getEvmWallet: async () => undefined,
        onOperation: observed
      };
      const results = await Promise.all([submitReviewedBridge(review, deps), submitReviewedBridge(review, deps)]);
      const rows = await Repo.transactions.toArray();
      expect(rows).toHaveLength(1);
      expect(results).toEqual([
        { kind: 'started', operationId: rows[0].id },
        { kind: 'started', operationId: rows[0].id }
      ]);
      expect(rows[0].extraInputs.bridgeOperation?.operationId).not.toBe(rows[0].id);
      expect(observed).toHaveBeenCalledWith(rows[0].id);
      const before = rows[0];
      const builds = mockCreateB2AggNote.mock.calls.length;
      await submitReviewedBridge(review, deps);
      expect(await Repo.transactions.get(before.id)).toEqual(before);
      expect(mockCreateB2AggNote).toHaveBeenCalledTimes(builds);
    }
  );

  it.each([false, true])('refuses revoked live consent after request build (Guardian=%s)', async guardian => {
    mockIsGuardian.mockResolvedValue(guardian);
    let revoked = false;
    const original = input();
    const checks = {
      readCurrent: async () => {
        if (revoked) throw new Error('Review invalidated');
        return original.operation.review;
      },
      now: () => now
    };
    mockFeeAwareTransactionRequestBuilder.mockImplementationOnce(async () => {
      revoked = true;
      return mockFeeAwareBuilder;
    });
    await expect(runAgglayerSend(original.operation, { guardianProvider, ...{ checks } })).rejects.toThrow();
    expect(await Repo.transactions.count()).toBe(0);
  });

  it('does not disclose serialized bridge request bytes in actual admission diagnostics', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await initiateB2AggBridge(input());
    expect(log.mock.calls.flat().some(value => value instanceof Uint8Array)).toBe(false);
    expect(await Repo.transactions.count()).toBe(1);
  });

  it('returns the original admitted row after quote expiry and RPC departure without building another note', async () => {
    mockIsGuardian.mockResolvedValue(false);
    const original = input();
    const id = await initiateB2AggBridge(original);
    const before = await Repo.transactions.get(id);
    const built = mockCreateB2AggNote.mock.calls.length;
    jest.spyOn(Date, 'now').mockReturnValue(now + 120000);
    jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://other-rpc.example/private');
    await expect(initiateB2AggBridge(original)).resolves.toBe(id);
    expect(mockCreateB2AggNote).toHaveBeenCalledTimes(built);
    expect(await Repo.transactions.get(id)).toEqual(before);
  });

  it('refuses RPC departure during the native note build instead of admitting under the new RPC', async () => {
    mockIsGuardian.mockImplementationOnce(async () => {
      jest.mocked(getEffectiveRpcUrl).mockReturnValue('https://other-rpc.example/private');
      return false;
    });
    await expect(initiateB2AggBridge(input())).rejects.toThrow();
    expect(await Repo.transactions.count()).toBe(0);
  });
});
