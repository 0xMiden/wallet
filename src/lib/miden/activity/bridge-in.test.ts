import {
  findPendingBridgeInByEarnWithdrawTxId,
  registerPendingBridgeIn,
  resolveBridgeInNoteId,
  suppressedLinkedConsumeIds,
  takeAgglayerBridgeInInfo,
  applyBridgeInInfoForNotes
} from './bridge-in';
import { IBridgeInInfo, ITransaction } from '../db/types';

const mockStore: Record<string, unknown> = {};

jest.mock('../front/storage', () => ({
  fetchFromStorage: jest.fn(async (key: string) => mockStore[key]),
  putToStorage: jest.fn(async (key: string, value: unknown) => {
    mockStore[key] = value;
  })
}));

const mockAnyOfToArray = jest.fn();
const mockTransactions: any[] = [];
// Rows `tagConsumeRow` searches by note id, kept apart from `mockTransactions`
// so the AggLayer suites above are unaffected.
const mockNoteIdRows: any[] = [];
const mockModify = jest.fn(async (mutate: (row: ITransaction) => void, index: unknown) => {
  const row =
    typeof index === 'object' && index !== null
      ? mockNoteIdRows.find(record => record.id === Reflect.get(index, 'id'))
      : undefined;
  if (row) mutate(row);
  return row ? 1 : 0;
});
jest.mock('lib/agglayer/constant', () => ({
  AGGLAYER_BRIDGE_NOTE_SENDER_ACCOUNT_ID: 'agg-sender',
  AGGLAYER_BRIDGE_NOTE_SOURCE_SYMBOL: 'ETH'
}));
jest.mock('lib/miden/repo', () => ({
  transactions: {
    where: jest.fn((index?: unknown) => ({
      anyOf: jest.fn(() => ({ toArray: mockAnyOfToArray })),
      anyOfIgnoreCase: jest.fn((...noteIds: string[]) => ({
        filter: jest.fn((predicate: (tx: ITransaction) => boolean) => ({
          first: jest.fn(async () =>
            mockNoteIdRows
              .filter(row => row.noteIds?.some((id: string) => noteIds.includes(id.toLowerCase())))
              .find(predicate)
          )
        }))
      })),
      // `where({ id })` for the modify path; `where('noteIds').equals(id)` for the lookup.
      modify: (mutate: (row: ITransaction) => void) => mockModify(mutate, index),
      equals: jest.fn((noteId: string) => ({
        filter: jest.fn((predicate: (tx: any) => boolean) => ({
          first: jest.fn(async () =>
            mockNoteIdRows.filter(row => row.noteIds?.includes(noteId)).find(row => predicate(row))
          )
        }))
      })),
      first: jest.fn(async () =>
        typeof index === 'object' && index !== null
          ? mockNoteIdRows.find(row => row.id === Reflect.get(index, 'id'))
          : undefined
      ),
      index
    })),
    filter: jest.fn((predicate: (tx: any) => boolean) => ({
      toArray: jest.fn(async () => mockTransactions.filter(predicate))
    }))
  }
}));

const REGISTRY_KEY = 'epoch_bridge_in_intents';
const EVM_OWNER = '0x1111111111111111111111111111111111111111';

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of Object.keys(mockStore)) delete mockStore[key];
  mockTransactions.splice(0);
  mockNoteIdRows.splice(0);
});

describe('resolveBridgeInNoteId', () => {
  const NOTE_ID = 'note-abc';
  const info: IBridgeInInfo = {
    provider: 'epoch',
    sourceAmount: '5',
    sourceSymbol: 'ETH',
    intentNonce: 'N1'
  };

  const consumeRow = (over: Record<string, unknown> = {}) => ({
    id: 'consume-1',
    type: 'consume',
    status: 2,
    noteIds: [NOTE_ID],
    amount: 5n,
    faucetId: 'faucet-a',
    ...over
  });

  it('tags the consume row that claimed the note, and drops the intent', async () => {
    mockNoteIdRows.push(consumeRow());
    await registerPendingBridgeIn(EVM_OWNER, 'N1', info);

    await resolveBridgeInNoteId(EVM_OWNER, 'N1', NOTE_ID);

    expect(mockModify).toHaveBeenCalled();
    expect(mockStore[REGISTRY_KEY]).toEqual([]);
  });

  // A restored row records someone else's claim. Adopting it would retitle it
  // "Bridged from EVM", file this intent's amounts against it, and — because a
  // hit drops the intent — leave the wallet's own consume untagged forever.
  it('refuses a row restored from a backup, and keeps the intent pending', async () => {
    mockNoteIdRows.push(consumeRow({ restoredFromBackup: true }));
    await registerPendingBridgeIn(EVM_OWNER, 'N1', info);

    await resolveBridgeInNoteId(EVM_OWNER, 'N1', NOTE_ID);

    expect(mockModify).not.toHaveBeenCalled();
    expect(mockStore[REGISTRY_KEY]).toHaveLength(1);
  });
});

describe('takeAgglayerBridgeInInfo', () => {
  it('matches sender, recipient and amount and selects the oldest pending row', async () => {
    mockTransactions.push(
      {
        id: 'newer',
        type: 'bridged-receive',
        accountId: 'miden-account_tag',
        amount: 5n,
        initiatedAt: 2,
        extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '5', sourceSymbol: 'ETH' }
      },
      {
        id: 'older',
        type: 'bridged-receive',
        accountId: 'miden-account',
        amount: 5n,
        initiatedAt: 1,
        extraInputs: { provider: 'agglayer', phase: 'submitting', sourceAmount: '5', sourceSymbol: 'ETH' }
      }
    );

    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'agg-sender', amount: 5n })
    ).resolves.toMatchObject({ provider: 'agglayer', bridgeReceiveTxId: 'older' });
  });

  // Matching rewrites the tracker row to `received` and makes the real consume
  // hide beneath it in history, so a restored tracker would adopt a genuine
  // incoming note and file the user's money under whatever the dump said.
  // The sender delivers bridged ETH, so an ERC-20 tracker must not adopt its note
  // even when it is older and its base-unit amount is the same.
  it('settles the ETH tracker, never an older ERC-20 tracker with the same amount', async () => {
    mockTransactions.push(
      {
        id: 'usdc',
        type: 'bridged-receive',
        accountId: 'miden-account',
        amount: 5n,
        initiatedAt: 1,
        extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '5', sourceSymbol: 'USDC' }
      },
      {
        id: 'eth',
        type: 'bridged-receive',
        accountId: 'miden-account',
        amount: 5n,
        initiatedAt: 2,
        extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '5', sourceSymbol: 'ETH' }
      }
    );

    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'agg-sender', amount: 5n })
    ).resolves.toMatchObject({ bridgeReceiveTxId: 'eth' });
  });

  it('never adopts a genuine note into a restored tracker', async () => {
    mockTransactions.push(
      {
        id: 'restored',
        type: 'bridged-receive',
        accountId: 'miden-account',
        amount: 5n,
        initiatedAt: 1,
        restoredFromBackup: true,
        extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '5', sourceSymbol: 'ETH' }
      },
      {
        id: 'mine',
        type: 'bridged-receive',
        accountId: 'miden-account',
        amount: 5n,
        initiatedAt: 2,
        extraInputs: { provider: 'agglayer', phase: 'delivering', sourceAmount: '5', sourceSymbol: 'ETH' }
      }
    );

    // `restored` is the older row and would otherwise win the oldest-first pick.
    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'agg-sender', amount: 5n })
    ).resolves.toMatchObject({ bridgeReceiveTxId: 'mine' });
  });

  it('does not match a different sender or amount', async () => {
    mockTransactions.push({
      id: 'row',
      type: 'bridged-receive',
      accountId: 'miden-account',
      amount: 5n,
      initiatedAt: 1,
      extraInputs: { provider: 'agglayer', phase: 'delivering' }
    });

    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'other', amount: 5n })
    ).resolves.toBeUndefined();
    await expect(
      takeAgglayerBridgeInInfo({ accountId: 'miden-account', senderAccountId: 'agg-sender', amount: 6n })
    ).resolves.toBeUndefined();
  });
});

describe('applyBridgeInInfoForNotes', () => {
  it('returns the parked info with the resolved note id and bridge-receive link', async () => {
    const info: IBridgeInInfo = {
      provider: 'epoch',
      sourceSymbol: 'USDC',
      sourceAmount: '10',
      intentNonce: 'NONCE1',
      bridgeReceiveTxId: 'TX1'
    };
    await registerPendingBridgeIn(EVM_OWNER, 'NONCE1', info);
    // Simulate the delivery poll having already learned the note id.
    (mockStore[REGISTRY_KEY] as Array<{ midenNoteId?: string }>)[0]!.midenNoteId = 'note-abc';

    let result: IBridgeInInfo | undefined;
    expect(
      await applyBridgeInInfoForNotes(['note-abc'], async info => {
        result = info;
      })
    ).toBe(true);

    expect(result).toMatchObject({ bridgeReceiveTxId: 'TX1', midenNoteId: 'note-abc', sourceSymbol: 'USDC' });
    // Matched intent leaves the registry.
    expect(mockStore[REGISTRY_KEY]).toEqual([]);
  });

  it('matches despite 0x-prefix / casing drift between allocator and SDK note ids', async () => {
    await registerPendingBridgeIn(EVM_OWNER, 'NONCE1', { provider: 'epoch', bridgeReceiveTxId: 'TX1' });
    // Allocator reports an uppercase, 0x-prefixed id...
    (mockStore[REGISTRY_KEY] as Array<{ midenNoteId?: string }>)[0]!.midenNoteId = '0xABCDEF';

    // ...while the consumed note id from the SDK is bare lowercase hex.
    let result: IBridgeInInfo | undefined;
    expect(
      await applyBridgeInInfoForNotes(['abcdef'], async info => {
        result = info;
      })
    ).toBe(true);

    expect(result).toMatchObject({ bridgeReceiveTxId: 'TX1' });
  });

  it('returns undefined when no consumed note matches a pending intent', async () => {
    await registerPendingBridgeIn(EVM_OWNER, 'NONCE1', { provider: 'epoch' });
    (mockStore[REGISTRY_KEY] as Array<{ midenNoteId?: string }>)[0]!.midenNoteId = 'note-abc';

    expect(await applyBridgeInInfoForNotes(['note-other'], async () => {})).toBe(false);
  });
});

describe('findPendingBridgeInByEarnWithdrawTxId', () => {
  it('returns the NEWEST matching intent when a resubmit left a stale entry for the same row', async () => {
    // Registry after a fail+retry on the same earn-withdraw row: the dead N1 (older,
    // first in the array as it was appended first) and the live N2 (newer). The lookup
    // must return N2 — returning the first match (N1) would re-strand the row on a dead
    // nonce, which is exactly the bug this ordering guards against.
    const now = Date.now();
    mockStore[REGISTRY_KEY] = [
      {
        userAddress: EVM_OWNER,
        intentNonce: 'N1',
        registeredAt: now - 2000,
        info: { provider: 'epoch', earnWithdrawTxId: 'T' }
      },
      {
        userAddress: EVM_OWNER,
        intentNonce: 'N2',
        registeredAt: now - 1000,
        info: { provider: 'epoch', earnWithdrawTxId: 'T' }
      }
    ];

    expect(await findPendingBridgeInByEarnWithdrawTxId('T', 'T')).toEqual({
      intentNonce: 'N2',
      userAddress: EVM_OWNER
    });
  });

  it('returns undefined when no pending intent references the row', async () => {
    const now = Date.now();
    mockStore[REGISTRY_KEY] = [
      {
        userAddress: EVM_OWNER,
        intentNonce: 'N1',
        registeredAt: now - 1000,
        info: { provider: 'epoch', earnWithdrawTxId: 'OTHER' }
      }
    ];

    expect(await findPendingBridgeInByEarnWithdrawTxId('T', 'T')).toBeUndefined();
  });
});

describe('suppressedLinkedConsumeIds', () => {
  it('suppresses existing linked primaries but NOT a terminal-failed earn-withdraw row', async () => {
    // A live withdraw row is the single trace (suppress its consume). A FAILED withdraw
    // row is not — its delivered note must fall through to a visible receive — so it is
    // excluded even though it exists. Non-earn-withdraw primaries suppress on existence.
    // 'MISSING' has no row (the query returns only existing rows) so it is absent.
    mockAnyOfToArray.mockResolvedValue([
      { id: 'LIVE', type: 'earn-withdraw', extraInputs: { phase: 'delivering', evmOwner: EVM_OWNER } },
      { id: 'FAILED', type: 'earn-withdraw', extraInputs: { phase: 'failed' } },
      { id: 'SWAP', type: 'swap', extraInputs: {} }
    ]);

    const consumes: ITransaction[] = ['LIVE', 'FAILED', 'SWAP', 'MISSING'].map(id => ({
      id: `consume-${id}`,
      type: 'consume',
      accountId: 'account',
      status: 2,
      displayIcon: 'RECEIVE',
      initiatedAt: 1,
      extraInputs: id === 'SWAP' ? { swapOrderTxId: id } : { bridgeIn: { provider: 'epoch', earnWithdrawTxId: id } }
    }));
    const result = await suppressedLinkedConsumeIds(consumes);

    expect(result).toEqual(new Set(['consume-LIVE', 'consume-SWAP']));
  });

  it('short-circuits on an empty id list', async () => {
    const result = await suppressedLinkedConsumeIds([]);
    expect(result).toEqual(new Set());
    expect(mockAnyOfToArray).not.toHaveBeenCalled();
  });
});
