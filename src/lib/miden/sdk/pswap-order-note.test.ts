import { readPswapOrderLineage, readPswapOrderNote } from './pswap-order-note';

const mockGetNotesById = jest.fn();
const mockGetNullifierCommitHeight = jest.fn();
const mockSyncNotes = jest.fn();
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  AccountId: {
    fromPrefixSuffix: (prefix: { asInt: () => bigint }, suffix: { asInt: () => bigint }) => ({
      toString: () => `acct:${prefix.asInt()}:${suffix.asInt()}`
    })
  },
  NoteId: { fromHex: (id: string) => ({ id }) },
  NoteScript: { pswap: () => ({ root: () => ({ toHex: () => 'pswap-root' }) }) },
  RpcClient: jest.fn(() => ({
    getNotesById: mockGetNotesById,
    getNullifierCommitHeight: mockGetNullifierCommitHeight,
    syncNotes: mockSyncNotes,
    free: jest.fn()
  }))
}));
jest.mock('lib/miden-chain/constants', () => ({ getRpcEndpoint: () => 'https://rpc.example' }));
jest.mock('./helpers', () => ({
  // The creator is the account whose id the PSWAP storage carries at items 6 (prefix) and 5 (suffix).
  walletAccountIdToSdk: (accountId: string) => ({ toString: () => (accountId === 'creator' ? 'acct:66:55' : 'other') })
}));

const felt = (value: bigint) => ({ asInt: () => value });

interface PswapShape {
  id: string;
  /** [s0, order id, s2, round] */
  serial?: bigint[];
  /** [requested faucet suffix, prefix, requested amount, min fill step, payback type, creator suffix, prefix] */
  storage?: bigint[];
  faucet?: string;
  amount?: bigint;
  root?: string;
}

const ORDER_SERIAL = [1n, 42n, 3n, 7n];
const ORDER_STORAGE = [11n, 12n, 30n, 0n, 1n, 55n, 66n];

const pswapNote = ({
  id,
  serial = ORDER_SERIAL,
  storage = ORDER_STORAGE,
  faucet = 'offered',
  amount = 70n,
  root = 'pswap-root'
}: PswapShape) => ({
  id: () => ({ toString: () => id }),
  script: () => ({ root: () => ({ toHex: () => root }) }),
  metadata: () => ({ tag: () => ({ tagOf: id }) }),
  nullifier: () => ({ nullifierOf: id }),
  recipient: () => ({
    serialNum: () => ({ toFelts: () => serial.map(felt) }),
    storage: () => ({ items: () => storage.map(felt) })
  }),
  assets: () => ({ fungibleAssets: () => [{ faucetId: () => ({ toString: () => faucet }), amount: () => amount }] })
});

/** A remainder of the order created in `round`, holding what is left on offer and asked for. */
const remainder = (
  id: string,
  round: bigint,
  offered: bigint,
  requested: bigint,
  overrides: Partial<PswapShape> = {}
) =>
  pswapNote({
    id,
    serial: [1n, 42n, 3n, 7n + round],
    storage: [11n, 12n, requested, 0n, 1n, 55n, 66n],
    amount: offered,
    ...overrides
  });

type NoteBody = ReturnType<typeof pswapNote>;
// The node as the tests describe it: note bodies with their inclusion block, spends, and tag-matched commits.
let chain: Map<string, { note: NoteBody | undefined; block: number }>;
let spentAt: Map<string, number>;

const commit = (note: NoteBody, block: number) => chain.set(note.id().toString(), { note, block });

beforeEach(() => {
  jest.clearAllMocks();
  chain = new Map();
  spentAt = new Map();
  mockGetNotesById.mockImplementation(async (ids: Array<{ id: string }>) =>
    ids.flatMap(({ id }) => {
      const entry = chain.get(id);
      return entry
        ? [
            {
              noteId: { toString: () => id },
              note: entry.note,
              inclusionProof: { location: () => ({ blockNum: () => entry.block }) }
            }
          ]
        : [];
    })
  );
  mockGetNullifierCommitHeight.mockImplementation(async (nullifier: { nullifierOf: string }) =>
    spentAt.get(nullifier.nullifierOf)
  );
  mockSyncNotes.mockImplementation(async (from: number, to: number) => ({
    notes: () =>
      [...chain]
        .filter(([, entry]) => entry.block >= from && entry.block <= to)
        .map(([id, entry]) => ({
          noteId: () => ({ toString: () => id }),
          inclusionProof: () => ({ location: () => ({ blockNum: () => entry.block }) })
        }))
  }));
});

describe('readPswapOrderNote', () => {
  it('answers open with the full note when its nullifier is unspent since its inclusion block', async () => {
    const note = pswapNote({ id: 'order-note' });
    commit(note, 120);

    await expect(readPswapOrderNote('order-note', 'creator')).resolves.toEqual({ kind: 'open', note });
    expect(mockGetNotesById).toHaveBeenCalledWith([{ id: 'order-note' }]);
    expect(mockGetNullifierCommitHeight).toHaveBeenCalledWith({ nullifierOf: 'order-note' }, 120);
  });

  // A remainder's sender is the solver that filled the order; what makes it this account's to cancel is the creator
  // its PSWAP storage names (#1487).
  it("reads a remainder the solver sent as this account's own, by the creator its storage names", async () => {
    const note = remainder('remainder-1', 1n, 40n, 10n);
    commit(note, 130);

    await expect(readPswapOrderNote('remainder-1', 'creator')).resolves.toEqual({ kind: 'open', note });
  });

  it('answers spent once the node holds the nullifier', async () => {
    commit(pswapNote({ id: 'order-note' }), 120);
    spentAt.set('order-note', 131);

    await expect(readPswapOrderNote('order-note', 'creator')).resolves.toEqual({ kind: 'spent' });
  });

  it.each([
    ['the node knows no note under the id', () => undefined],
    ['the note has no public body', () => chain.set('order-note', { note: undefined, block: 120 })],
    ['the body reconstructs to another id', () => chain.set('order-note', { note: pswapNote({ id: 'x' }), block: 1 })],
    ['the note is not a PSWAP note', () => commit(pswapNote({ id: 'order-note', root: 'p2id-root' }), 120)],
    [
      'another account created the order',
      () => commit(pswapNote({ id: 'order-note', storage: [11n, 12n, 30n, 0n, 1n, 77n, 66n] }), 120)
    ]
  ])('answers absent when %s, without reading a nullifier', async (_label, arrange) => {
    arrange();

    await expect(readPswapOrderNote('order-note', 'creator')).resolves.toEqual({ kind: 'absent' });
    expect(mockGetNullifierCommitHeight).not.toHaveBeenCalled();
  });

  it('rejects a failed read rather than answering for the node', async () => {
    mockGetNotesById.mockRejectedValueOnce(new Error('node unreachable'));

    await expect(readPswapOrderNote('order-note', 'creator')).rejects.toThrow('node unreachable');
  });
});

describe('readPswapOrderLineage', () => {
  const read = () => readPswapOrderLineage('order-note', '42', 'creator');

  it('reads an unspent order note as the open order at depth 0', async () => {
    commit(pswapNote({ id: 'order-note' }), 120);

    await expect(read()).resolves.toEqual({
      kind: 'open',
      noteId: 'order-note',
      depth: 0,
      offeredAmount: 70n,
      requestedAmount: 30n
    });
    expect(mockSyncNotes).not.toHaveBeenCalled();
  });

  // A partial fill spends the order note and creates the remainder in the same transaction, so in the spending block,
  // under the order note's own tag (a PSWAP remainder carries its parent's tag over unchanged). The amounts follow the
  // PSWAP script: a fill of 20 of the 30 asked pays floor(70 * 20 / 30) = 46, leaving 24 offered for 10.
  it('follows a partial fill to the remainder the spending block holds', async () => {
    commit(pswapNote({ id: 'order-note' }), 120);
    spentAt.set('order-note', 125);
    commit(remainder('remainder-1', 1n, 24n, 10n), 125);
    commit(pswapNote({ id: 'other-order', serial: [9n, 99n, 9n, 1n] }), 125);

    await expect(read()).resolves.toEqual({
      kind: 'open',
      noteId: 'remainder-1',
      depth: 1,
      offeredAmount: 24n,
      requestedAmount: 10n
    });
    expect(mockSyncNotes).toHaveBeenCalledWith(124, 125, [{ tagOf: 'order-note' }]);
  });

  it('follows the lineage round by round to its open tip', async () => {
    commit(pswapNote({ id: 'order-note' }), 120);
    spentAt.set('order-note', 125);
    commit(remainder('remainder-1', 1n, 24n, 10n), 125);
    spentAt.set('remainder-1', 140);
    // A fill of 5 of the 10 asked pays floor(24 * 5 / 10) = 12.
    commit(remainder('remainder-2', 2n, 12n, 5n), 140);

    await expect(read()).resolves.toEqual({
      kind: 'open',
      noteId: 'remainder-2',
      depth: 2,
      offeredAmount: 12n,
      requestedAmount: 5n
    });
  });

  // Two fills of one order in one batch erase the remainder between them, so the spending block holds only the later
  // round; reading that as a finished order closed an open one for good (#1487).
  it('continues the walk at a later round when the spending block holds only it', async () => {
    commit(pswapNote({ id: 'order-note' }), 120);
    spentAt.set('order-note', 125);
    commit(remainder('remainder-2', 2n, 12n, 5n), 125);

    await expect(read()).resolves.toEqual({
      kind: 'open',
      noteId: 'remainder-2',
      depth: 2,
      offeredAmount: 12n,
      requestedAmount: 5n
    });
  });

  it('reads a spend that left no remainder as a finished order', async () => {
    commit(pswapNote({ id: 'order-note' }), 120);
    spentAt.set('order-note', 125);

    await expect(read()).resolves.toEqual({ kind: 'finished' });
  });

  it('reads a remainder spent with nothing after it as a finished order', async () => {
    commit(pswapNote({ id: 'order-note' }), 120);
    spentAt.set('order-note', 125);
    commit(remainder('remainder-1', 1n, 24n, 10n), 125);
    spentAt.set('remainder-1', 140);

    await expect(read()).resolves.toEqual({ kind: 'finished' });
  });

  // A block where only other notes share the pair's tag holds nothing of this order.
  it.each([
    ['a note of another order', remainder('other', 1n, 24n, 10n, { serial: [1n, 43n, 3n, 8n] })],
    [
      'a note another account created',
      remainder('other', 1n, 24n, 10n, { storage: [11n, 12n, 10n, 0n, 1n, 77n, 66n] })
    ],
    ['a note with another script', remainder('other', 1n, 24n, 10n, { root: 'p2id-root' })]
  ])('reads a spend whose block holds only %s as a finished order', async (_label, other) => {
    commit(pswapNote({ id: 'order-note' }), 120);
    spentAt.set('order-note', 125);
    commit(other, 125);

    await expect(read()).resolves.toEqual({ kind: 'finished' });
  });

  // A note that claims this order's serial but is not its lineage is not taken as the tip, and since the block then
  // holds a note of this order the walk cannot prove finished: it leaves the order to the next read.
  it.each([
    // Inside the old bounds (no more offered, no more asked), but a fill of 20 leaves 24 or 25 offered, not 40.
    ['a note whose amounts no fill allows', remainder('look-alike', 1n, 40n, 10n)],
    ['a note two rounds on whose amounts no two fills allow', remainder('look-alike', 2n, 40n, 10n)],
    [
      'a note asking for another token',
      remainder('look-alike', 1n, 24n, 10n, { storage: [13n, 12n, 10n, 0n, 1n, 55n, 66n] })
    ],
    ['a note offering another token', remainder('look-alike', 1n, 24n, 10n, { faucet: 'elsewhere' })],
    ['a note offering more than was left', remainder('look-alike', 1n, 71n, 10n)],
    ['a note asking for more than was left', remainder('look-alike', 1n, 24n, 31n)],
    ['a note of the same round as its parent', remainder('look-alike', 0n, 24n, 10n)]
  ])('does not take %s for the remainder, and leaves the order unresolved', async (_label, lookAlike) => {
    commit(pswapNote({ id: 'order-note' }), 120);
    spentAt.set('order-note', 125);
    commit(lookAlike, 125);

    await expect(read()).rejects.toThrow();
  });

  it('leaves the order unresolved when a look-alike sits beside the real remainder', async () => {
    commit(pswapNote({ id: 'order-note' }), 120);
    spentAt.set('order-note', 125);
    commit(remainder('remainder-1', 1n, 24n, 10n), 125);
    commit(remainder('look-alike', 1n, 40n, 10n), 125);

    await expect(read()).rejects.toThrow();
  });

  it('refuses to choose between two remainders of the same round', async () => {
    commit(pswapNote({ id: 'order-note' }), 120);
    spentAt.set('order-note', 125);
    commit(remainder('remainder-a', 1n, 24n, 10n), 125);
    commit(remainder('remainder-b', 1n, 25n, 10n), 125);

    await expect(read()).rejects.toThrow();
  });

  // Whether a note the node shows under the tag but serves no body for is this order's, nothing can tell.
  it('leaves the order unresolved when the spending block holds a note under its tag with no body', async () => {
    commit(pswapNote({ id: 'order-note' }), 120);
    spentAt.set('order-note', 125);
    chain.set('bodiless', { note: undefined, block: 125 });

    await expect(read()).rejects.toThrow();
  });

  // The depth is the serial round over the order note's, and one read follows at most 16 of them.
  it('leaves an order deeper than one read follows unresolved', async () => {
    commit(pswapNote({ id: 'order-note' }), 120);
    spentAt.set('order-note', 125);
    commit(remainder('remainder-17', 17n, 12n, 5n), 125);

    await expect(read()).rejects.toThrow();
  });

  it.each([
    ['the node knows no such note', () => undefined],
    [
      'another account created it',
      () => commit(pswapNote({ id: 'order-note', storage: [11n, 12n, 30n, 0n, 1n, 77n, 66n] }), 120)
    ],
    ['it belongs to another order', () => commit(pswapNote({ id: 'order-note', serial: [1n, 43n, 3n, 7n] }), 120)]
  ])('answers absent when %s', async (_label, arrange) => {
    arrange();

    await expect(read()).resolves.toEqual({ kind: 'absent' });
  });

  // A node that accepts and never answers leaves each read's client parked until the read settles: a poll that
  // started another read every 30 s parked one more each time (#1487).
  it('starts no second node read for an order while its previous read is still unsettled', async () => {
    jest.useFakeTimers();
    try {
      mockGetNotesById.mockImplementationOnce(() => new Promise(() => undefined));
      const first = read().catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(5_000);
      expect(await first).toBeInstanceOf(Error);

      await expect(read()).rejects.toThrow();
      expect(mockGetNotesById).toHaveBeenCalledTimes(1);

      commit(pswapNote({ id: 'other-order-note', serial: [5n, 50n, 5n, 5n] }), 120);
      await expect(readPswapOrderLineage('other-order-note', '50', 'creator')).resolves.toEqual(
        expect.objectContaining({ kind: 'open', noteId: 'other-order-note' })
      );
    } finally {
      jest.useRealTimers();
    }
  });
});
