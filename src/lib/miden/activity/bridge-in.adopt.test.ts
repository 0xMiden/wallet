import * as Repo from 'lib/miden/repo';

import { adoptableNotesOf, adoptBridgeDeliveries, adoptLandedConsume, AdoptableNote } from './bridge-in';
import { IBridgedReceiveExtraInputs, IBridgedReceivePhase, ITransaction, ITransactionStatus } from '../db/types';
// Loaded with the suite: the adopter reaches the real writer through a dynamic import, which on a cold module cache
// under load outlasts the first test's timeout.
import '../transaction/complete';

// Real store, real matchers and real writers: only the SDK's id parse, the discovered native asset (USDCx, read in
// hex as the wallet discovers it), the bridge config and the intent registry are stood in for.
const USDCX_FAUCET = 'mtst1usdcxfaucet000000000000000';
const ACCOUNT = 'mtst1account000000000000000000_qruqqypuyph';
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  ...jest.requireActual('@miden-sdk/miden-sdk/lazy'),
  AccountId: { fromHex: (hex: string) => ({ toString: () => hex.toLowerCase() }) },
  Address: {
    fromBech32: (address: string) => {
      const known: Record<string, string> = {
        mtst1usdcxfaucet000000000000000: '0x4cbdcaffe75f0a317482224dae6436',
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
jest.mock('lib/remote-config/runtime', () => ({
  getBridgeConfigSnapshot: () => ({}),
  initBridgeConfig: async () => ({})
}));
// The intent registry is empty unless a test names one.
const mockFetchFromStorage = jest.fn();
jest.mock('../front/storage', () => ({
  inStorageTurn: jest.requireActual('../front/storage').inStorageTurn,
  fetchFromStorage: (key: string) => mockFetchFromStorage(key),
  putToStorage: async () => undefined
}));

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
