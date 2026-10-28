import { getProviderReceiptBackend, installProviderReceiptBackend } from 'lib/miden/recovery/receipt-backend';
import { fromSerializable } from 'lib/miden/recovery/serialization';
import { projectRecoveryTransaction, validateRecoveryReceipt } from 'lib/miden/recovery/transaction-record';
import * as Repo from 'lib/miden/repo';
import { assertStorageHealthy } from 'lib/miden/storage-health';

import {
  adoptableNotesOf,
  adoptBridgeDeliveries,
  adoptLandedConsume,
  AdoptableNote,
  type PendingBridgeInIntent,
  resolveBridgeInNoteId,
  suppressedLinkedConsumeIds
} from './bridge-in';
import {
  IBridgedReceiveExtraInputs,
  IBridgedReceivePhase,
  IBridgeInInfo,
  IEarnWithdrawExtraInputs,
  ITransaction,
  ITransactionStatus
} from '../db/types';
// Loaded with the suite: the adopter reaches the real writer through a dynamic import, which on a cold module cache
// under load outlasts the first test's timeout.
import '../transaction/complete';

// Real store, real matchers and real writers: only the SDK's id parse, the discovered native asset (USDCx, read in
// hex as the wallet discovers it), the bridge config and the intent registry are stood in for.
const USDCX_FAUCET = 'mtst1usdcxfaucet000000000000000';
const ETH_FAUCET = 'mtst1ethfaucet00000000000000000';
const ACCOUNT = 'mtst1account000000000000000000_qruqqypuyph';
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  ...jest.requireActual('@miden-sdk/miden-sdk/lazy'),
  AccountId: { fromHex: (hex: string) => ({ toString: () => hex.toLowerCase() }) },
  Address: {
    fromBech32: (address: string) => {
      const known: Record<string, string> = {
        mtst1usdcxfaucet000000000000000: '0x4cbdcaffe75f0a317482224dae6436',
        mtst1ethfaucet00000000000000000: '0x0b372f2735e33e91216d995bf29b91',
        mtst1account000000000000000000: '0x8da911727d5b53916f2c221c00c091'
      };
      const hex = known[address];
      if (hex === undefined) throw new Error(`invalid bech32 address: ${address}`);
      return { accountId: () => ({ toString: () => hex }) };
    }
  }
}));
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetId: async () => '0x4cbdcaffe75f0a317482224dae6436'
}));
// Sepolia's registry names its native-ETH faucet (scale 10), so every note meets the AggLayer matcher before the USDCx
// one.
jest.mock('lib/remote-config/runtime', () => ({
  getBridgeConfigSnapshot: () => ({
    config: { supportedEvmChains: { sepolia: { chainId: 11155111, bridges: { agglayer: {} } } } },
    derived: {
      chains: {
        11155111: {
          agglayer: {
            tokens: {
              state: 'ok',
              value: [
                {
                  midenFaucetId: '0x0b372f2735e33e91216d995bf29b91',
                  originToken: '0x0000000000000000000000000000000000000000',
                  originNetwork: 0,
                  scale: 10
                }
              ]
            }
          }
        }
      }
    }
  }),
  initBridgeConfig: async () => ({})
}));
// The intent registry is empty unless a test names one; its writes are recorded, so a removal can be seen.
const mockFetchFromStorage = jest.fn();
const mockPutToStorage = jest.fn(async (_key: string, _value: unknown) => undefined);
jest.mock('../front/storage', () => ({
  inStorageTurn: jest.requireActual('../front/storage').inStorageTurn,
  fetchFromStorage: (key: string) => mockFetchFromStorage(key),
  putToStorage: (key: string, value: unknown) => mockPutToStorage(key, value)
}));
const REGISTRY_KEY = 'epoch_bridge_in_intents';

const DEPOSIT = 1_000_000n;

const addDeposit = async (
  id: string,
  phase: IBridgedReceivePhase,
  initiatedAt = Math.floor(Date.now() / 1000),
  extra: Partial<IBridgedReceiveExtraInputs> = {}
) => {
  await Repo.transactions.add({
    id,
    type: 'bridged-receive',
    accountId: ACCOUNT,
    amount: DEPOSIT,
    faucetId: USDCX_FAUCET,
    status: ITransactionStatus.Completed,
    displayIcon: 'RECEIVE',
    initiatedAt,
    extraInputs: {
      provider: 'usdcx',
      phase,
      sourceAddress: '0xsource',
      sourceAmount: '1',
      sourceSymbol: 'USDC',
      evmTxHash: `0x${'5'.repeat(64)}`,
      ...extra
    }
  });
};

const mint = (id: string, amount = DEPOSIT): AdoptableNote => ({
  id,
  senderAddress: USDCX_FAUCET,
  faucetId: USDCX_FAUCET,
  amount
});

// An AggLayer tracker is born with no faucet and the deposit in wei; the bridge delivers it at the faucet's scale.
const ETH_DELIVERED = 3_000_000n;
const addEthDeposit = async (id: string) => {
  await Repo.transactions.add({
    id,
    type: 'bridged-receive',
    accountId: ACCOUNT,
    amount: ETH_DELIVERED * 10n ** 10n,
    faucetId: '',
    status: ITransactionStatus.Completed,
    displayIcon: 'RECEIVE',
    initiatedAt: Math.floor(Date.now() / 1000),
    extraInputs: {
      provider: 'agglayer',
      phase: 'delivering',
      sourceAddress: '0xsource',
      sourceAmount: '0.03',
      sourceSymbol: 'ETH',
      evmTxHash: `0x${'6'.repeat(64)}`
    }
  });
};

const ethDelivery = (id: string): AdoptableNote => ({
  id,
  senderAddress: ETH_FAUCET,
  faucetId: ETH_FAUCET,
  amount: ETH_DELIVERED
});

const addConsume = async (overrides: Partial<ITransaction> = {}) => {
  await Repo.transactions.add({
    id: 'consume',
    type: 'consume',
    accountId: ACCOUNT,
    status: ITransactionStatus.Completed,
    transactionId: 'chain-tx',
    secondaryAccountId: USDCX_FAUCET,
    faucetId: USDCX_FAUCET,
    amount: DEPOSIT,
    displayIcon: 'RECEIVE',
    displayMessage: 'Received',
    initiatedAt: Math.floor(Date.now() / 1000),
    ...overrides
  });
};

const phaseOf = async (id: string) => (await Repo.transactions.get(id))?.extraInputs;

beforeEach(async () => {
  mockFetchFromStorage.mockReset();
  mockPutToStorage.mockClear();
  await Repo.transactions.clear();
});

describe('adoptBridgeDeliveries', () => {
  // USDCx is the native asset and its mints are auto-claimed together: two same-amount mints in one consume must
  // land two deposits, one each.
  it('lands two same-amount mints of one batch in two deposits', async () => {
    await addDeposit('deposit-a', 'ready');
    await addDeposit('deposit-b', 'ready');
    await addConsume({ noteIds: ['note-1', 'note-2'] });

    await adoptBridgeDeliveries('consume', [mint('note-1'), mint('note-2')]);

    expect(await phaseOf('deposit-a')).toMatchObject({ phase: 'received', midenNoteId: expect.any(String) });
    expect(await phaseOf('deposit-b')).toMatchObject({ phase: 'received', midenNoteId: expect.any(String) });
    const noteIds = [(await phaseOf('deposit-a'))?.midenNoteId, (await phaseOf('deposit-b'))?.midenNoteId];
    expect(noteIds.sort()).toEqual(['note-1', 'note-2']);
    expect((await Repo.transactions.get('deposit-b'))?.transactionId).toBe('chain-tx');
    // Only the deposits move: the batch keeps its own label.
    const consume = await Repo.transactions.get('consume');
    expect(consume?.displayMessage).toBe('Received');
    expect(consume?.extraInputs?.bridgeIn).toBeUndefined();
  });

  it('tags a single-mint consume as the receipt of its deposit', async () => {
    await addDeposit('deposit', 'ready');
    await addConsume({ noteIds: ['note-1'] });

    await adoptBridgeDeliveries('consume', [mint('note-1')]);

    expect(await phaseOf('deposit')).toMatchObject({ phase: 'received', midenNoteId: 'note-1' });
    const consume = await Repo.transactions.get('consume');
    expect(consume?.displayMessage).toBe('Bridged from EVM');
    expect(consume?.extraInputs?.bridgeIn).toMatchObject({ provider: 'usdcx', bridgeReceiveTxId: 'deposit' });
  });

  // Every landing path calls the adopter, so a second call for a note already landed must not take another deposit
  // of the same amount.
  it.each([
    ['a single-mint consume', ['note-1']],
    ['a batch', ['note-1', 'note-2']]
  ])('adopts each note once when called again for %s', async (_label, noteIds) => {
    await addDeposit('deposit-a', 'ready');
    await addDeposit('deposit-b', 'ready');
    await addDeposit('deposit-c', 'delivering');
    await addConsume({ noteIds });
    const notes = noteIds.map(id => mint(id));

    await adoptBridgeDeliveries('consume', notes);
    await Repo.transactions.update('consume', { extraInputs: undefined });
    await adoptBridgeDeliveries('consume', notes);

    const phases = await Promise.all(['deposit-a', 'deposit-b', 'deposit-c'].map(phaseOf));
    expect(phases.filter(inputs => inputs?.phase === 'received')).toHaveLength(noteIds.length);
  });

  it('tags a single AggLayer delivery as the receipt of its ETH deposit', async () => {
    await addEthDeposit('eth-deposit');
    await addConsume({
      noteIds: ['note-eth'],
      secondaryAccountId: ETH_FAUCET,
      faucetId: ETH_FAUCET,
      amount: ETH_DELIVERED
    });

    await adoptBridgeDeliveries('consume', [ethDelivery('note-eth')]);

    expect(await phaseOf('eth-deposit')).toMatchObject({ phase: 'received', midenNoteId: 'note-eth' });
    expect(await Repo.transactions.get('eth-deposit')).toMatchObject({ amount: ETH_DELIVERED, faucetId: ETH_FAUCET });
    const consume = await Repo.transactions.get('consume');
    expect(consume?.displayMessage).toBe('Bridged from EVM');
    expect(consume?.extraInputs?.bridgeIn).toMatchObject({ provider: 'agglayer', bridgeReceiveTxId: 'eth-deposit' });
  });

  // Each deposit takes its own note's amount and faucet, never the batch row's.
  it('lands an AggLayer delivery and a USDCx mint of one batch at their own amounts and faucets', async () => {
    await addEthDeposit('eth-deposit');
    await addDeposit('usdcx-deposit', 'ready');
    await addConsume({ noteIds: ['note-eth', 'note-usdcx'] });

    await adoptBridgeDeliveries('consume', [ethDelivery('note-eth'), mint('note-usdcx')]);

    expect(await phaseOf('eth-deposit')).toMatchObject({ phase: 'received', midenNoteId: 'note-eth' });
    expect(await Repo.transactions.get('eth-deposit')).toMatchObject({
      amount: ETH_DELIVERED,
      faucetId: ETH_FAUCET,
      transactionId: 'chain-tx'
    });
    expect(await phaseOf('usdcx-deposit')).toMatchObject({ phase: 'received', midenNoteId: 'note-usdcx' });
    expect(await Repo.transactions.get('usdcx-deposit')).toMatchObject({ amount: DEPOSIT, faucetId: USDCX_FAUCET });
  });

  it('pairs a batch note by its own amount, never by the batch total', async () => {
    await addDeposit('deposit', 'ready');
    await addConsume({ noteIds: ['note-1', 'note-2'] });

    await adoptBridgeDeliveries('consume', [mint('note-1', DEPOSIT / 2n), mint('note-2', DEPOSIT / 2n)]);

    expect(await phaseOf('deposit')).toMatchObject({ phase: 'ready' });
  });

  it('lands a late mint in a deposit that timed out after Circle attested it', async () => {
    const now = Math.floor(Date.now() / 1000);
    await addDeposit('deposit', 'failed', now - 9 * 24 * 60 * 60, {
      readyAt: now - 8 * 24 * 60 * 60,
      error: 'Bridge delivery timed out.'
    });
    await addConsume({ noteIds: ['note-1'] });

    await adoptBridgeDeliveries('consume', [mint('note-1')]);

    expect(await phaseOf('deposit')).toMatchObject({ phase: 'received', midenNoteId: 'note-1' });
  });

  // The reconciler counts a ready deposit's week from its attestation, so its mint lands however old the deposit is.
  it('lands a mint in a deposit that became ready this week, however old its deposit', async () => {
    const now = Math.floor(Date.now() / 1000);
    await addDeposit('deposit', 'ready', now - 10 * 24 * 60 * 60, { readyAt: now - 60 });
    await addConsume({ noteIds: ['note-1'] });

    await adoptBridgeDeliveries('consume', [mint('note-1')]);

    expect(await phaseOf('deposit')).toMatchObject({ phase: 'received', midenNoteId: 'note-1' });
  });

  it('never throws, whatever the store does', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const where = jest.spyOn(Repo.transactions, 'where').mockImplementation(() => {
      throw new Error('store closed');
    });

    await expect(adoptBridgeDeliveries('consume', [mint('note-1')])).resolves.toBeUndefined();

    where.mockRestore();
    warn.mockRestore();
  });
});

describe('adoptableNotesOf', () => {
  it('reads the per-note facts a consume kept, a note with no amount included', () => {
    expect(
      adoptableNotesOf({
        consumedNotes: [
          { id: 'note-1', senderAddress: USDCX_FAUCET, faucetId: USDCX_FAUCET, amount: DEPOSIT },
          { id: 'note-2', senderAddress: USDCX_FAUCET, faucetId: USDCX_FAUCET }
        ]
      })
    ).toEqual([mint('note-1'), { id: 'note-2', senderAddress: USDCX_FAUCET, faucetId: USDCX_FAUCET }]);
  });

  it('falls back to the one note a legacy single-note consume names', () => {
    expect(
      adoptableNotesOf({
        noteId: 'note-1',
        noteIds: ['note-1'],
        secondaryAccountId: USDCX_FAUCET,
        faucetId: USDCX_FAUCET,
        amount: DEPOSIT
      })
    ).toEqual([mint('note-1')]);
  });

  it('has nothing for a legacy batch, which kept no per-note facts', () => {
    expect(adoptableNotesOf({ noteId: 'note-1', noteIds: ['note-1', 'note-2'], amount: DEPOSIT })).toBeUndefined();
  });
});

describe('adoptLandedConsume', () => {
  it('lands a deposit from the facts a consume kept when it completed with no transaction result', async () => {
    await addDeposit('deposit', 'ready');
    await addConsume({ noteIds: ['note-1'], consumedNotes: [mint('note-1')] });

    await adoptLandedConsume('consume');

    expect(await phaseOf('deposit')).toMatchObject({ phase: 'received', midenNoteId: 'note-1' });
  });

  it('lands a deposit for a consume queued before the per-note facts existed', async () => {
    await addDeposit('deposit', 'ready');
    await addConsume({ noteId: 'note-1', noteIds: ['note-1'] });

    await adoptLandedConsume('consume');

    expect(await phaseOf('deposit')).toMatchObject({ phase: 'received', midenNoteId: 'note-1' });
  });

  // The intent registry pairs by note id alone, so a claimed note with no readable amount still reaches it.
  it('lands a registry delivery whose note carried no amount', async () => {
    mockFetchFromStorage.mockResolvedValue([
      {
        userAddress: 'not-an-evm-address',
        intentNonce: '7',
        info: { provider: 'epoch', sourceSymbol: 'USDC' },
        midenNoteId: 'note-1',
        registeredAt: Date.now()
      }
    ]);
    await addConsume({
      noteIds: ['note-1'],
      consumedNotes: [{ id: 'note-1', senderAddress: 'epoch-solver', faucetId: USDCX_FAUCET }]
    });

    await adoptLandedConsume('consume');

    const consume = await Repo.transactions.get('consume');
    expect(consume?.displayMessage).toBe('Bridged from EVM');
    expect(consume?.extraInputs?.bridgeIn).toMatchObject({ provider: 'epoch', midenNoteId: 'note-1' });
  });

  it('warns and adopts nothing for a legacy batch', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await addDeposit('deposit', 'ready');
    await addConsume({ noteId: 'note-1', noteIds: ['note-1', 'note-2'] });

    await adoptLandedConsume('consume');

    expect(await phaseOf('deposit')).toMatchObject({ phase: 'ready' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('kept no per-note facts'), 'consume');
    warn.mockRestore();
  });

  it.each<[string, Partial<ITransaction>]>([
    ['still generating', { status: ITransactionStatus.GeneratingTransaction }],
    ['failed', { status: ITransactionStatus.Failed }],
    ['restored from a backup', { restoredFromBackup: true }]
  ])('adopts nothing for a consume %s', async (_label, overrides) => {
    await addDeposit('deposit', 'ready');
    await addConsume({ noteIds: ['note-1'], consumedNotes: [mint('note-1')], ...overrides });

    await adoptLandedConsume('consume');

    expect(await phaseOf('deposit')).toMatchObject({ phase: 'ready' });
  });

  // A batch moves its deposits through the tracking-row writer, which never reads the consume, so only the guard
  // above holds them; a single note is refused again by the receipt writer.
  it.each<[string, Partial<ITransaction>]>([
    ['still generating', { status: ITransactionStatus.GeneratingTransaction }],
    ['failed', { status: ITransactionStatus.Failed }],
    ['restored from a backup', { restoredFromBackup: true }]
  ])('adopts nothing for a batch consume %s', async (_label, overrides) => {
    await addDeposit('deposit-a', 'ready');
    await addDeposit('deposit-b', 'ready');
    await addConsume({ noteIds: ['note-1', 'note-2'], consumedNotes: [mint('note-1'), mint('note-2')], ...overrides });

    await adoptLandedConsume('consume');

    expect(await phaseOf('deposit-a')).toMatchObject({ phase: 'ready' });
    expect(await phaseOf('deposit-b')).toMatchObject({ phase: 'ready' });
  });
});

// Epoch and Earn deliver through the intent registry, which pairs by note id alone, and native auto-consume claims such
// a delivery together with every other native note.
describe('a registry delivery claimed in a batch', () => {
  const EVM_OWNER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const EPOCH_LINK: Partial<IBridgeInInfo> = { bridgeReceiveTxId: 'epoch-deposit' };
  const EARN_LINK: Partial<IBridgeInInfo> = { earnWithdrawTxId: 'withdraw', earnWithdrawAttemptId: 'attempt-1' };

  const registryHolds = (midenNoteId: string, link: Partial<IBridgeInInfo>) => {
    const intent: PendingBridgeInIntent = {
      userAddress: EVM_OWNER,
      intentNonce: '7',
      info: { provider: 'epoch', sourceAmount: '2', sourceSymbol: 'USDC', ...link },
      midenNoteId,
      registeredAt: Date.now()
    };
    mockFetchFromStorage.mockResolvedValue([intent]);
  };

  const addEpochDeposit = async () => {
    const extraInputs: IBridgedReceiveExtraInputs = {
      provider: 'epoch',
      phase: 'delivering',
      sourceAddress: EVM_OWNER,
      sourceAmount: '2',
      sourceSymbol: 'USDC',
      intentNonce: '7'
    };
    await Repo.transactions.add({
      id: 'epoch-deposit',
      type: 'bridged-receive',
      accountId: ACCOUNT,
      status: ITransactionStatus.Completed,
      displayIcon: 'RECEIVE',
      initiatedAt: Math.floor(Date.now() / 1000),
      extraInputs
    });
  };

  const addWithdrawal = async () => {
    const extraInputs: IEarnWithdrawExtraInputs = {
      evmOwner: EVM_OWNER,
      marketUid: 'market',
      destinationFaucetId: USDCX_FAUCET,
      sourceAmount: '10',
      sourceSymbol: 'USDC',
      phase: 'delivering',
      submissionAttemptId: 'attempt-1',
      withdrawIntentNonce: '7'
    };
    await Repo.transactions.add({
      id: 'withdraw',
      type: 'earn-withdraw',
      accountId: ACCOUNT,
      amount: 10n,
      faucetId: USDCX_FAUCET,
      status: ITransactionStatus.Completed,
      displayIcon: 'DEFAULT',
      initiatedAt: Math.floor(Date.now() / 1000),
      extraInputs
    });
  };

  // Epoch's solver sends the delivery, so only the registry pairs it. `amount` is absent for a note with no readable
  // amount.
  const solverDelivery = (amount?: bigint): AdoptableNote => ({
    id: 'note-b',
    senderAddress: 'epoch-solver',
    faucetId: USDCX_FAUCET,
    ...(amount === undefined ? {} : { amount })
  });
  // A note with no fungible asset, as completeConsumeTransaction hands it over.
  const assetless = (id: string): AdoptableNote => ({ id, senderAddress: '', faucetId: '' });

  it('records an Epoch delivery claimed with another token at its own amount and token', async () => {
    await addEpochDeposit();
    registryHolds('0xNOTE-B', EPOCH_LINK);
    await addConsume({
      noteIds: ['note-a', 'note-b'],
      secondaryAccountId: ETH_FAUCET,
      faucetId: ETH_FAUCET,
      amount: 1n
    });

    await adoptBridgeDeliveries('consume', [
      { id: 'note-a', senderAddress: ETH_FAUCET, faucetId: ETH_FAUCET, amount: 1n },
      solverDelivery(2n)
    ]);

    expect(await Repo.transactions.get('epoch-deposit')).toMatchObject({
      amount: 2n,
      faucetId: USDCX_FAUCET,
      transactionId: 'chain-tx',
      extraInputs: expect.objectContaining({ phase: 'received', midenNoteId: '0xNOTE-B' })
    });
    expect(mockPutToStorage).toHaveBeenCalledWith(REGISTRY_KEY, []);
  });

  it('records an Earn withdrawal delivered in a native batch at its own amount, never the batch total', async () => {
    await addWithdrawal();
    registryHolds('note-b', EARN_LINK);
    await addConsume({ noteIds: ['note-a', 'note-b'], amount: 3n });

    await adoptBridgeDeliveries('consume', [mint('note-a', 1n), solverDelivery(2n)]);

    expect(await Repo.transactions.get('withdraw')).toMatchObject({
      amount: 2n,
      faucetId: USDCX_FAUCET,
      extraInputs: expect.objectContaining({ phase: 'received', midenNoteId: 'note-b', outputSymbol: 'USDC' })
    });
    expect(mockPutToStorage).toHaveBeenCalledWith(REGISTRY_KEY, []);
  });

  it.each<[string, Partial<IBridgeInInfo>]>([
    ['an Epoch deposit', EPOCH_LINK],
    ['an Earn withdrawal', EARN_LINK]
  ])("leaves the batch row's label, tag and Activity visibility as they were for %s", async (_label, link) => {
    await addEpochDeposit();
    await addWithdrawal();
    registryHolds('note-b', link);
    await addConsume({ noteIds: ['note-a', 'note-b'], amount: 3n });

    await adoptBridgeDeliveries('consume', [mint('note-a', 1n), solverDelivery(2n)]);

    const consume = await Repo.transactions.get('consume');
    if (!consume) throw new Error('missing consume');
    expect(consume.displayMessage).toBe('Received');
    expect(consume.extraInputs?.bridgeIn).toBeUndefined();
    expect(await suppressedLinkedConsumeIds([consume])).toEqual(new Set());
  });

  // The stored row keeps the same facts, so no retry could ever settle it.
  it('releases the intent and moves no tracker when the batch note carried no asset', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await addEpochDeposit();
    registryHolds('note-b', EPOCH_LINK);
    await addConsume({ noteIds: ['note-a', 'note-b'], amount: 3n });

    await adoptBridgeDeliveries('consume', [mint('note-a', 1n), assetless('note-b')]);

    expect(await phaseOf('epoch-deposit')).toMatchObject({ phase: 'delivering' });
    expect(mockPutToStorage).toHaveBeenCalledWith(REGISTRY_KEY, []);
    const consume = await Repo.transactions.get('consume');
    expect(consume?.displayMessage).toBe('Received');
    expect(consume?.extraInputs?.bridgeIn).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('released'), 'consume', 'epoch-deposit');
    warn.mockRestore();
  });

  it('lands an Earn withdrawal whose batch note carried no amount at its requested amount', async () => {
    await addWithdrawal();
    registryHolds('note-b', EARN_LINK);
    await addConsume({ noteIds: ['note-a', 'note-b'], amount: 3n });

    await adoptBridgeDeliveries('consume', [mint('note-a', 1n), solverDelivery()]);

    expect(await Repo.transactions.get('withdraw')).toMatchObject({
      amount: 10n,
      extraInputs: expect.objectContaining({ phase: 'received', midenNoteId: 'note-b' })
    });
    expect(mockPutToStorage).toHaveBeenCalledWith(REGISTRY_KEY, []);
  });

  it('still pairs every other note of the batch when the registry delivery cannot be settled', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await addDeposit('deposit-a', 'ready');
    await addEpochDeposit();
    registryHolds('note-2', EPOCH_LINK);
    await addConsume({ noteIds: ['note-1', 'note-2'] });

    await adoptBridgeDeliveries('consume', [mint('note-1'), assetless('note-2')]);

    expect(await phaseOf('deposit-a')).toMatchObject({ phase: 'received', midenNoteId: 'note-1' });
    expect(await phaseOf('epoch-deposit')).toMatchObject({ phase: 'delivering' });
    warn.mockRestore();
  });

  it("lands a batch's registry delivery from the facts a landed consume kept", async () => {
    await addEpochDeposit();
    registryHolds('note-b', EPOCH_LINK);
    await addConsume({
      noteIds: ['note-a', 'note-b'],
      amount: 3n,
      consumedNotes: [mint('note-a', 1n), solverDelivery(2n)]
    });

    await adoptLandedConsume('consume');

    expect(await Repo.transactions.get('epoch-deposit')).toMatchObject({
      amount: 2n,
      faucetId: USDCX_FAUCET,
      extraInputs: expect.objectContaining({ phase: 'received', midenNoteId: 'note-b' })
    });
    expect((await Repo.transactions.get('consume'))?.extraInputs?.bridgeIn).toBeUndefined();
  });

  // Six landing paths call the adopter, and a batch row is never tagged, so nothing short-circuits a second call.
  it('takes no other deposit when a landing path adopts the batch again', async () => {
    await addDeposit('deposit-a', 'ready');
    await addDeposit('deposit-b', 'ready');
    await addWithdrawal();
    registryHolds('note-b', EARN_LINK);
    await addConsume({ noteIds: ['note-a', 'note-b'], amount: DEPOSIT + 2n });
    const notes = [mint('note-a'), solverDelivery(2n)];

    await adoptBridgeDeliveries('consume', notes);
    // The first call removed the intent; this stand-in does not keep removals.
    mockFetchFromStorage.mockReset();
    await adoptBridgeDeliveries('consume', notes);

    const phases = await Promise.all(['deposit-a', 'deposit-b'].map(phaseOf));
    expect(phases.filter(inputs => inputs?.phase === 'received')).toHaveLength(1);
    expect(await Repo.transactions.get('withdraw')).toMatchObject({
      amount: 2n,
      extraInputs: expect.objectContaining({ phase: 'received' })
    });
  });

  it("never pairs a batch's registry note by sender when its settlement fails", async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await addDeposit('deposit-a', 'ready');
    await addDeposit('deposit-b', 'ready');
    await addEpochDeposit();
    registryHolds('note-2', EPOCH_LINK);
    await addConsume({ noteIds: ['note-1', 'note-2'] });
    const failTracker = (_changes: object, key: unknown) => {
      if (key === 'epoch-deposit') throw new Error('database unavailable');
    };
    Repo.transactions.hook('updating', failTracker);
    try {
      await adoptBridgeDeliveries('consume', [mint('note-1'), mint('note-2')]);
    } finally {
      Repo.transactions.hook('updating').unsubscribe(failTracker);
      warn.mockRestore();
    }

    const phases = await Promise.all(['deposit-a', 'deposit-b'].map(phaseOf));
    expect(phases.map(inputs => inputs?.phase).sort()).toEqual(['ready', 'received']);
    expect(await phaseOf('epoch-deposit')).toMatchObject({ phase: 'delivering' });
    expect(mockPutToStorage).not.toHaveBeenCalledWith(REGISTRY_KEY, expect.anything());
  });

  describe('for a batch that kept no per-note facts', () => {
    // Queued before the per-note facts, the row names its notes and nothing else about them.
    const addLegacyBatch = () => addConsume({ noteIds: ['note-a', 'note-b'], amount: 3n });

    it.each<[string, () => Promise<unknown>]>([
      ['a landed consume', () => adoptLandedConsume('consume')],
      ['a late note id', () => resolveBridgeInNoteId(EVM_OWNER, '7', 'note-b')]
    ])('releases an Epoch delivery it cannot settle, through %s', async (_label, settle) => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      await addEpochDeposit();
      registryHolds('note-b', EPOCH_LINK);
      await addLegacyBatch();

      await expect(settle()).resolves.toBeUndefined();

      expect(mockPutToStorage).toHaveBeenCalledWith(REGISTRY_KEY, []);
      expect(await phaseOf('epoch-deposit')).toMatchObject({ phase: 'delivering' });
      expect((await Repo.transactions.get('epoch-deposit'))?.amount).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('released'), 'consume', 'epoch-deposit');
      warn.mockRestore();
    });

    it.each<[string, () => Promise<unknown>]>([
      ['a landed consume', () => adoptLandedConsume('consume')],
      ['a late note id', () => resolveBridgeInNoteId(EVM_OWNER, '7', 'note-b')]
    ])('settles an Earn withdrawal at its requested amount, through %s', async (_label, settle) => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      await addWithdrawal();
      registryHolds('note-b', EARN_LINK);
      await addLegacyBatch();

      await expect(settle()).resolves.toBeUndefined();

      expect(mockPutToStorage).toHaveBeenCalledWith(REGISTRY_KEY, []);
      expect(await Repo.transactions.get('withdraw')).toMatchObject({
        amount: 10n,
        extraInputs: expect.objectContaining({ phase: 'received', midenNoteId: 'note-b' })
      });
      warn.mockRestore();
    });
  });

  // A failure the note's facts do not explain may pass on a retry.
  it.each<[string, () => Promise<unknown>]>([
    ['a landed consume', () => adoptLandedConsume('consume')],
    [
      'a late note id',
      () => expect(resolveBridgeInNoteId(EVM_OWNER, '7', 'note-b')).rejects.toThrow('database unavailable')
    ]
  ])(
    'keeps the intent of a batch delivery with its facts whose settlement fails, through %s',
    async (_label, settle) => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      await addEpochDeposit();
      registryHolds('note-b', EPOCH_LINK);
      await addConsume({
        noteIds: ['note-a', 'note-b'],
        amount: 3n,
        consumedNotes: [mint('note-a', 1n), solverDelivery(2n)]
      });
      const failTracker = (_changes: object, key: unknown) => {
        if (key === 'epoch-deposit') throw new Error('database unavailable');
      };
      Repo.transactions.hook('updating', failTracker);
      try {
        await settle();
      } finally {
        Repo.transactions.hook('updating').unsubscribe(failTracker);
        warn.mockRestore();
      }

      expect(mockPutToStorage).not.toHaveBeenCalledWith(REGISTRY_KEY, expect.anything());
      expect(await phaseOf('epoch-deposit')).toMatchObject({ phase: 'delivering' });
    }
  );
});

let previousReceiptBackend: ReturnType<typeof getProviderReceiptBackend>;
const retainedReceipts = new Map<string, ReturnType<typeof validateRecoveryReceipt>>();

async function acknowledgeSyntheticReceipt(value: unknown, expectedEpoch: number): Promise<void> {
  assertStorageHealthy(expectedEpoch);
  const row = validateRecoveryReceipt(fromSerializable(value));
  const persisted = await Repo.transactions.get(row.id);
  if (!persisted) throw new Error('Synthetic receipt owner requires a persisted row');
  expect(projectRecoveryTransaction(persisted)).toMatchObject(row);
  assertStorageHealthy(expectedEpoch);
  retainedReceipts.set(row.id, row);
}

beforeEach(() => {
  previousReceiptBackend = getProviderReceiptBackend();
  retainedReceipts.clear();
  installProviderReceiptBackend(acknowledgeSyntheticReceipt);
});

afterEach(() => {
  installProviderReceiptBackend(previousReceiptBackend);
});
