import { RpcClient } from '@miden-sdk/miden-sdk/lazy';

import {
  GC_SALE_SCRIPT_ROOT,
  readPublicPswapNote,
  readPswapOrderLineage,
  readPswapOrderNote
} from './pswap-order-note';

const mockGetNotesById = jest.fn();
const mockGetNullifierCommitHeight = jest.fn();
const mockSyncNotes = jest.fn();
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  AccountId: {
    fromPrefixSuffix: (prefix: { asInt: () => bigint }, suffix: { asInt: () => bigint }) => ({
      toString: () => `acct:${prefix.asInt()}:${suffix.asInt()}`
    })
  },
  Note: {
    withAttachments: (
      _assets: unknown,
      _metadata: unknown,
      recipient: { idWith: (attachments: unknown[]) => string },
      attachments: unknown[]
    ) => ({ id: () => ({ toString: () => recipient.idWith(attachments) }) })
  },
  NoteAttachment: {
    fromWord: (scheme: { value: number }, word: unknown) => ({ scheme: scheme.value, toWords: () => [word] })
  },
  NoteAttachmentScheme: class {
    value: number;
    constructor(value: number) {
      this.value = value;
    }
  },
  NoteId: { fromHex: (id: string) => ({ id }) },
  NoteScript: {
    pswap: () => ({ root: () => ({ toHex: () => 'pswap-root' }) }),
    p2id: () => ({ root: () => ({ toHex: () => 'p2id-root' }) })
  },
  NoteTag: { withAccountTarget: (accountId: { toString: () => string }) => ({ accountTarget: accountId.toString() }) },
  RpcClient: jest.fn(() => ({
    getNotesById: mockGetNotesById,
    getNullifierCommitHeight: mockGetNullifierCommitHeight,
    syncNotes: mockSyncNotes,
    free: jest.fn()
  }))
}));
// The effective node: each read's client is built for it, and a read parked on it bounds only reads of that node.
let mockRpcUrl = 'https://node-a';
jest.mock('lib/miden-chain/constants', () => ({ getRpcEndpoint: () => mockRpcUrl }));
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveRpcUrl: () => mockRpcUrl }));
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
  nft?: boolean;
}

const ORDER_SERIAL = [1n, 42n, 3n, 7n];
const ORDER_STORAGE = [11n, 12n, 30n, 0n, 1n, 55n, 66n];

const pswapNote = ({
  id,
  serial = ORDER_SERIAL,
  storage = ORDER_STORAGE,
  faucet = 'offered',
  amount = 70n,
  root = 'pswap-root',
  nft = false
}: PswapShape) => ({
  id: () => ({ toString: () => id }),
  script: () => ({ root: () => ({ toHex: () => root }) }),
  metadata: () => ({ tag: () => ({ tagOf: id }) }),
  nullifier: () => ({ nullifierOf: id }),
  recipient: () => ({
    serialNum: () => ({ toFelts: () => serial.map(felt) }),
    storage: () => ({ items: () => storage.map(felt) })
  }),
  assets: () => ({
    fungibleAssets: () => [{ faucetId: () => ({ toString: () => faucet }), amount: () => amount }],
    nonFungibleAssets: () => (nft ? [{}] : [])
  })
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

type MockAttachment = { scheme: number; toWords: () => Array<{ toU64s: () => BigUint64Array }> };

const wordsOf = (attachment: MockAttachment) =>
  attachment
    .toWords()
    .map(word => word.toU64s().join())
    .join();
const sameAttachment = (left: MockAttachment, right: MockAttachment | undefined) =>
  right !== undefined && left.scheme === right.scheme && wordsOf(left) === wordsOf(right);

interface PaybackShape {
  id: string;
  /** The PSWAP attachment's word is [fill, order id, depth, 0]. */
  fill: bigint;
  depth: bigint;
  orderId?: bigint;
  scheme?: number;
  root?: string;
}

// A fill's P2ID payback to the creator with the PSWAP attachment (scheme 3) `create_p2id_note` gives it. Its id commits
// to its attachments, so `Note.withAttachments` rebuilds it to its own id only with the ones it carries.
const payback = ({ id, fill, depth, orderId = 42n, scheme = 3, root = 'p2id-root' }: PaybackShape) => {
  const attachments = (): MockAttachment[] => [
    { scheme, toWords: () => [{ toU64s: () => BigUint64Array.from([fill, orderId, depth, 0n]) }] }
  ];
  return {
    id: () => ({ toString: () => id }),
    script: () => ({ root: () => ({ toHex: () => root }) }),
    assets: () => ({}),
    metadata: () => ({}),
    recipient: () => ({
      idWith: (rebuilt: MockAttachment[]) => {
        const own = attachments();
        const same = rebuilt.length === own.length && rebuilt.every((item, index) => sameAttachment(item, own[index]));
        return same ? id : `${id}:rebuilt`;
      }
    }),
    attachments
  };
};

type NoteBody = ReturnType<typeof pswapNote> | ReturnType<typeof payback>;
// The node as the tests describe it: note bodies with their inclusion block, spends, and tag-matched commits. A note
// under the creator's account-target tag is found only by a search for that tag, every other one by any other search.
let chain: Map<string, { note: NoteBody | undefined; block: number; creatorTag?: boolean }>;
let spentAt: Map<string, number>;

const commit = (note: NoteBody, block: number) => chain.set(note.id().toString(), { note, block });
const commitPayback = (note: ReturnType<typeof payback>) =>
  chain.set(note.id().toString(), { note, block: 125, creatorTag: true });

beforeEach(() => {
  jest.clearAllMocks();
  mockRpcUrl = 'https://node-a';
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
  mockSyncNotes.mockImplementation(async (from: number, to: number, tags: Array<{ accountTarget?: string }>) => ({
    notes: () =>
      [...chain]
        .filter(([, entry]) => entry.block >= from && entry.block <= to)
        .filter(([, entry]) => Boolean(entry.creatorTag) === tags.some(tag => tag.accountTarget === 'acct:66:55'))
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

  // A read parked on a silent node bounds the reads of that node only: once the endpoint moves, the note is read on the
  // new node at once, not after the parked read settles, which may be never (#1487).
  it('reads a note on the new node after an endpoint change while a read is still parked on the old one', async () => {
    jest.useFakeTimers();
    try {
      mockGetNotesById.mockImplementationOnce(() => new Promise(() => undefined));
      const parked = readPswapOrderNote('hung-note', 'creator').catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(5_000);
      expect(await parked).toBeInstanceOf(Error);
      await expect(readPswapOrderNote('hung-note', 'creator')).rejects.toThrow();
      expect(mockGetNotesById).toHaveBeenCalledTimes(1);

      mockRpcUrl = 'https://node-b';
      const note = pswapNote({ id: 'hung-note' });
      commit(note, 120);
      await expect(readPswapOrderNote('hung-note', 'creator')).resolves.toEqual({ kind: 'open', note });
      expect(RpcClient).toHaveBeenLastCalledWith('https://node-b');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('readPswapOrderLineage', () => {
  const read = (start?: { noteId: string; depth: number }) =>
    readPswapOrderLineage('order-note', '42', 'creator', start);

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
  // round; reading that as a finished order closed an open one for good (#1487). The fills' paybacks rebuild the jump:
  // 20 of 30 leaves 24 or 25 for 10, and 5 of those 10 leaves 12 to 14 for 5.
  it('continues the walk at a later round when the spending block holds only it', async () => {
    commit(pswapNote({ id: 'order-note' }), 120);
    spentAt.set('order-note', 125);
    commit(remainder('remainder-2', 2n, 12n, 5n), 125);
    commitPayback(payback({ id: 'payback-1', fill: 20n, depth: 1n }));
    commitPayback(payback({ id: 'payback-2', fill: 5n, depth: 2n }));

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

  // A fill below the note's fill floor is refused unless it takes the whole request, so a note asking no more than the
  // floor is only ever filled whole: after a first fill of at least 20 of 30, no second fill leaves a remainder.
  it('does not take a later round that no partial fills above the fill floor reach', async () => {
    commit(pswapNote({ id: 'order-note', storage: [11n, 12n, 30n, 20n, 1n, 55n, 66n] }), 120);
    spentAt.set('order-note', 125);
    commit(remainder('look-alike', 2n, 3n, 1n, { storage: [11n, 12n, 1n, 20n, 1n, 55n, 66n] }), 125);

    await expect(read()).rejects.toThrow();
  });

  // Two fills of 10 at a fill floor of 10: 70 for 30 leaves 47 or 48 for 20, and either leaves 24 or 25 for 10. Only a
  // fill split between the account and note legs, each leg's payout rounded down, leaves 25.
  it.each([24n, 25n])(
    'follows two fills at the fill floor inside one block to the later round offering %s',
    async offered => {
      commit(pswapNote({ id: 'order-note', storage: [11n, 12n, 30n, 10n, 1n, 55n, 66n] }), 120);
      spentAt.set('order-note', 125);
      commit(remainder('remainder-2', 2n, offered, 10n, { storage: [11n, 12n, 10n, 10n, 1n, 55n, 66n] }), 125);
      commitPayback(payback({ id: 'payback-1', fill: 10n, depth: 1n }));
      commitPayback(payback({ id: 'payback-2', fill: 10n, depth: 2n }));

      await expect(read()).resolves.toEqual({
        kind: 'open',
        noteId: 'remainder-2',
        depth: 2,
        offeredAmount: offered,
        requestedAmount: 10n
      });
    }
  );

  // A partial fill below the fill floor is refused, so paybacks of 5 and 15 at a floor of 10 rebuild no chain, though
  // without the floor they would land on 24 for 10.
  it('leaves a jump unresolved when a payback reports a fill below the fill floor', async () => {
    commit(pswapNote({ id: 'order-note', storage: [11n, 12n, 30n, 10n, 1n, 55n, 66n] }), 120);
    spentAt.set('order-note', 125);
    commit(remainder('remainder-2', 2n, 24n, 10n, { storage: [11n, 12n, 10n, 10n, 1n, 55n, 66n] }), 125);
    commitPayback(payback({ id: 'payback-1', fill: 5n, depth: 1n }));
    commitPayback(payback({ id: 'payback-2', fill: 15n, depth: 2n }));

    await expect(read()).rejects.toThrow();
  });

  describe('a jump from 7 offered for 10 with no fill floor', () => {
    // Two fills of 1 pay floor(7 / 10) = 0 and floor(7 / 9) = 0, so the one chain to asking 8 keeps all 7 on offer;
    // the aggregate bound over two rounds also holds 6.
    const placeOrder = (offered: bigint) => {
      commit(pswapNote({ id: 'order-note', storage: [11n, 12n, 10n, 0n, 1n, 55n, 66n], amount: 7n }), 120);
      spentAt.set('order-note', 125);
      commit(remainder('remainder-2', 2n, offered, 8n), 125);
    };
    const fillsOfOne = () => {
      commitPayback(payback({ id: 'payback-1', fill: 1n, depth: 1n }));
      commitPayback(payback({ id: 'payback-2', fill: 1n, depth: 2n }));
    };
    const tip = { kind: 'open', noteId: 'remainder-2', depth: 2, offeredAmount: 7n, requestedAmount: 8n };

    it('is taken at the offer its paybacks rebuild, read under the creator tag in the spending block', async () => {
      placeOrder(7n);
      fillsOfOne();

      await expect(read()).resolves.toEqual(tip);
      expect(mockSyncNotes).toHaveBeenCalledWith(124, 125, [{ accountTarget: 'acct:66:55' }]);
    });

    it('is taken past a bodiless note and another order payback under the creator tag', async () => {
      placeOrder(7n);
      fillsOfOne();
      chain.set('bodiless', { note: undefined, block: 125, creatorTag: true });
      commitPayback(payback({ id: 'other-order-payback', fill: 1n, depth: 1n, orderId: 99n }));

      await expect(read()).resolves.toEqual(tip);
    });

    it('is refused at an offer no chain of its paybacks reaches', async () => {
      placeOrder(6n);
      fillsOfOne();

      await expect(read()).rejects.toThrow();
    });

    it.each([
      ['a payback missing for one round', () => commitPayback(payback({ id: 'payback-1', fill: 1n, depth: 1n }))],
      [
        'two paybacks for one round',
        () => {
          fillsOfOne();
          commitPayback(payback({ id: 'payback-1b', fill: 1n, depth: 1n }));
        }
      ],
      [
        "only another order's paybacks",
        () => {
          commitPayback(payback({ id: 'other-1', fill: 1n, depth: 1n, orderId: 99n }));
          commitPayback(payback({ id: 'other-2', fill: 1n, depth: 2n, orderId: 99n }));
        }
      ],
      [
        'a private payback for one round',
        () => {
          chain.set('payback-1', { note: undefined, block: 125, creatorTag: true });
          commitPayback(payback({ id: 'payback-2', fill: 1n, depth: 2n }));
        }
      ],
      [
        'a payback for one round that is not a P2ID note',
        () => {
          commitPayback(payback({ id: 'payback-1', fill: 1n, depth: 1n, root: 'other-root' }));
          commitPayback(payback({ id: 'payback-2', fill: 1n, depth: 2n }));
        }
      ],
      [
        'a payback for one round under another attachment scheme',
        () => {
          commitPayback(payback({ id: 'payback-1', fill: 1n, depth: 1n, scheme: 2 }));
          commitPayback(payback({ id: 'payback-2', fill: 1n, depth: 2n }));
        }
      ],
      [
        'paybacks whose fills do not add up to the drop in the request',
        () => {
          commitPayback(payback({ id: 'payback-1', fill: 1n, depth: 1n }));
          commitPayback(payback({ id: 'payback-2', fill: 2n, depth: 2n }));
        }
      ]
    ])('stays unresolved with %s', async (_label, arrange) => {
      placeOrder(7n);
      arrange();

      await expect(read()).rejects.toThrow();
    });
  });

  it('reads no paybacks for a one-round step', async () => {
    commit(pswapNote({ id: 'order-note' }), 120);
    spentAt.set('order-note', 125);
    commit(remainder('remainder-1', 1n, 24n, 10n), 125);
    commitPayback(payback({ id: 'payback-1', fill: 20n, depth: 1n }));

    await expect(read()).resolves.toEqual(expect.objectContaining({ kind: 'open', noteId: 'remainder-1' }));
    expect(mockSyncNotes).toHaveBeenCalledTimes(1);
    expect(mockSyncNotes).toHaveBeenCalledWith(124, 125, [{ tagOf: 'order-note' }]);
  });

  const placeLongLineage = (rounds: number, orderBlock = 120) => {
    commit(pswapNote({ id: 'order-note', amount: 1n }), orderBlock);
    for (let depth = 1; depth <= rounds; depth++) {
      const parent = depth === 1 ? 'order-note' : `remainder-${depth - 1}`;
      spentAt.set(parent, orderBlock + depth);
      commit(remainder(`remainder-${depth}`, BigInt(depth), 1n, 30n - BigInt(depth)), orderBlock + depth);
    }
  };

  it('resumes a 20-round lineage at its spent round-16 checkpoint and reads the open round-20 remainder', async () => {
    placeLongLineage(20);

    const first = await read();

    expect(first).toEqual({ kind: 'unresolved', checkpoint: { noteId: 'remainder-16', depth: 16 } });
    expect(mockGetNullifierCommitHeight).toHaveBeenCalledTimes(17);
    expect(mockSyncNotes).toHaveBeenCalledTimes(16);
    if (first.kind !== 'unresolved') throw new Error('Missing lineage checkpoint');
    mockGetNullifierCommitHeight.mockClear();
    mockSyncNotes.mockClear();

    await expect(read(first.checkpoint)).resolves.toEqual({
      kind: 'open',
      noteId: 'remainder-20',
      depth: 20,
      offeredAmount: 1n,
      requestedAmount: 10n
    });
    expect(mockGetNullifierCommitHeight).toHaveBeenNthCalledWith(1, { nullifierOf: 'remainder-16' }, 136);
    expect(mockGetNullifierCommitHeight).toHaveBeenCalledTimes(5);
    expect(mockSyncNotes).toHaveBeenCalledTimes(4);
  });

  it('counts the 16-round bound from a validated start rather than the order note', async () => {
    placeLongLineage(20);

    await expect(read({ noteId: 'remainder-2', depth: 2 })).resolves.toEqual({
      kind: 'unresolved',
      checkpoint: { noteId: 'remainder-18', depth: 18 }
    });
    expect(mockSyncNotes).toHaveBeenCalledTimes(16);
    expect(mockGetNullifierCommitHeight).toHaveBeenNthCalledWith(1, { nullifierOf: 'remainder-2' }, 122);
    expect(mockGetNullifierCommitHeight).toHaveBeenLastCalledWith({ nullifierOf: 'remainder-18' }, 138);
  });

  it.each([
    ['another note id', remainder('different-id', 16n, 70n, 14n), 16],
    ['another order', remainder('start', 16n, 70n, 14n, { serial: [1n, 99n, 3n, 23n] }), 16],
    ['another serial', remainder('start', 16n, 70n, 14n, { serial: [2n, 42n, 3n, 23n] }), 16],
    ['another creator', remainder('start', 16n, 70n, 14n, { storage: [11n, 12n, 14n, 0n, 1n, 77n, 66n] }), 16],
    ['another script', remainder('start', 16n, 70n, 14n, { root: 'p2id-root' }), 16],
    ['another requested token', remainder('start', 16n, 70n, 14n, { storage: [13n, 12n, 14n, 0n, 1n, 55n, 66n] }), 16],
    ['another offered token', remainder('start', 16n, 70n, 14n, { faucet: 'elsewhere' }), 16],
    ['another fill floor', remainder('start', 16n, 70n, 14n, { storage: [11n, 12n, 14n, 1n, 1n, 55n, 66n] }), 16],
    ['another payback type', remainder('start', 16n, 70n, 14n, { storage: [11n, 12n, 14n, 0n, 2n, 55n, 66n] }), 16],
    ['a mismatched depth', remainder('start', 16n, 70n, 14n), 15],
    ['an unsafe depth', remainder('start', 16n, 70n, 14n), Number.MAX_SAFE_INTEGER + 1],
    ['no public body', undefined, 16]
  ])('ignores a start with %s and begins at the order note', async (_label, startNote, depth) => {
    placeLongLineage(20);
    chain.set('start', { note: startNote, block: 100 });

    await expect(read({ noteId: 'start', depth })).resolves.toEqual({
      kind: 'unresolved',
      checkpoint: { noteId: 'remainder-16', depth: 16 }
    });
    expect(mockGetNullifierCommitHeight).toHaveBeenNthCalledWith(1, { nullifierOf: 'order-note' }, 120);
    expect(mockGetNullifierCommitHeight).not.toHaveBeenCalledWith({ nullifierOf: 'start' }, 100);
    await expect(read({ noteId: 'remainder-16', depth: 16 })).resolves.toEqual({
      kind: 'open',
      noteId: 'remainder-20',
      depth: 20,
      offeredAmount: 1n,
      requestedAmount: 10n
    });
  });

  describe('a jump after single fills to depth 10', () => {
    beforeEach(() => {
      placeLongLineage(10, 100);
      spentAt.set('remainder-10', 125);
      commit(remainder('remainder-20', 20n, 1n, 10n), 125);
      for (let depth = 11; depth <= 20; depth++) {
        commitPayback(payback({ id: `payback-${depth}`, fill: 1n, depth: BigInt(depth) }));
      }
    });

    it('checkpoints the last spent tip before a jump past the read budget and resumes from it', async () => {
      const first = await read();

      expect(first).toEqual({ kind: 'unresolved', checkpoint: { noteId: 'remainder-10', depth: 10 } });
      if (first.kind !== 'unresolved') throw new Error('Missing lineage checkpoint');

      await expect(read(first.checkpoint)).resolves.toEqual({
        kind: 'open',
        noteId: 'remainder-20',
        depth: 20,
        offeredAmount: 1n,
        requestedAmount: 10n
      });
    });

    it('keeps progress from a resumed start before a jump past that read budget', async () => {
      await expect(read({ noteId: 'remainder-2', depth: 2 })).resolves.toEqual({
        kind: 'unresolved',
        checkpoint: { noteId: 'remainder-10', depth: 10 }
      });
      expect(mockGetNullifierCommitHeight).toHaveBeenNthCalledWith(1, { nullifierOf: 'remainder-2' }, 102);
    });
  });

  it('leaves a jump beyond the resumed read bound unresolved without advancing the checkpoint', async () => {
    commit(pswapNote({ id: 'order-note', amount: 1n }), 120);
    commit(remainder('remainder-2', 2n, 1n, 28n), 122);
    spentAt.set('remainder-2', 125);
    commit(remainder('remainder-19', 19n, 1n, 11n), 125);

    await expect(read({ noteId: 'remainder-2', depth: 2 })).resolves.toEqual({
      kind: 'unresolved',
      checkpoint: { noteId: 'remainder-2', depth: 2 }
    });
    expect(mockSyncNotes).toHaveBeenCalledTimes(1);
  });

  // The depth is the serial round over the order note's, and one read follows at most 16 of them.
  it('leaves an order deeper than one read follows unresolved', async () => {
    commit(pswapNote({ id: 'order-note' }), 120);
    spentAt.set('order-note', 125);
    commit(remainder('remainder-17', 17n, 12n, 5n), 125);

    await expect(read()).resolves.toEqual({ kind: 'unresolved', checkpoint: { noteId: 'order-note', depth: 0 } });
    expect(mockSyncNotes).toHaveBeenCalledTimes(1);
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

describe('overlapping public sale note reads', () => {
  it('accepts the custom sale root only when requested and keeps standard PSWAP reads separate', async () => {
    const note = pswapNote({ id: 'custom-sale', root: GC_SALE_SCRIPT_ROOT });
    commit(note, 120);
    await expect(readPublicPswapNote('custom-sale')).resolves.toEqual({ kind: 'absent' });
    await expect(readPublicPswapNote('custom-sale', GC_SALE_SCRIPT_ROOT)).resolves.toMatchObject({
      kind: 'open',
      note
    });
    commit(pswapNote({ id: 'standard-sale' }), 120);
    await expect(readPublicPswapNote('standard-sale', GC_SALE_SCRIPT_ROOT)).resolves.toEqual({ kind: 'absent' });
  });

  it('rejects a custom sale that also carries an NFT', async () => {
    commit(pswapNote({ id: 'sale-with-nft', root: GC_SALE_SCRIPT_ROOT, nft: true }), 120);
    await expect(readPublicPswapNote('sale-with-nft', GC_SALE_SCRIPT_ROOT)).resolves.toEqual({ kind: 'absent' });
  });

  it('lets a quote and request build share the same pending note read', async () => {
    const note = pswapNote({ id: 'concurrent-sale' });
    let release!: (value: unknown[]) => void;
    mockGetNotesById.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = resolve;
        })
    );
    const quote = readPublicPswapNote('concurrent-sale');
    const build = readPublicPswapNote('concurrent-sale');
    const together = Promise.all([quote, build]);
    void together.catch(() => undefined);
    await Promise.resolve();
    release([
      {
        noteId: { toString: () => 'concurrent-sale' },
        note,
        inclusionProof: { location: () => ({ blockNum: () => 120 }) }
      }
    ]);
    await expect(together).resolves.toEqual([
      expect.objectContaining({ kind: 'open', note }),
      expect.objectContaining({ kind: 'open', note })
    ]);
    expect(mockGetNotesById).toHaveBeenCalledTimes(1);
    expect(mockGetNullifierCommitHeight).toHaveBeenCalledTimes(1);
  });

  it('shares the logical read while its nullifier step is pending', async () => {
    const note = pswapNote({ id: 'pending-nullifier-sale' });
    commit(note, 120);
    let release!: (value: undefined) => void;
    let started!: () => void;
    const nullifierStarted = new Promise<void>(resolve => {
      started = resolve;
    });
    mockGetNullifierCommitHeight.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = resolve;
          started();
        })
    );
    const quote = readPublicPswapNote('pending-nullifier-sale');
    await nullifierStarted;
    const build = readPublicPswapNote('pending-nullifier-sale');
    release(undefined);

    await expect(Promise.all([quote, build])).resolves.toEqual([
      expect.objectContaining({ kind: 'open', note }),
      expect.objectContaining({ kind: 'open', note })
    ]);
    expect(mockGetNotesById).toHaveBeenCalledTimes(1);
    expect(mockGetNullifierCommitHeight).toHaveBeenCalledTimes(1);
  });

  it('makes a fresh read after the previous logical read fulfilled', async () => {
    const note = pswapNote({ id: 'settled-public-sale' });
    commit(note, 120);
    await expect(readPublicPswapNote('settled-public-sale')).resolves.toMatchObject({ kind: 'open', note });
    spentAt.set('settled-public-sale', 125);

    await expect(readPublicPswapNote('settled-public-sale')).resolves.toEqual({ kind: 'spent' });
    expect(mockGetNotesById).toHaveBeenCalledTimes(2);
    expect(mockGetNullifierCommitHeight).toHaveBeenCalledTimes(2);
  });

  it('makes a fresh read after the previous logical read rejected', async () => {
    const note = pswapNote({ id: 'failed-public-sale' });
    commit(note, 120);
    mockGetNotesById.mockRejectedValueOnce(new Error('node unreachable'));
    const quote = readPublicPswapNote('failed-public-sale');
    const build = readPublicPswapNote('failed-public-sale');
    await expect(Promise.all([quote, build])).rejects.toThrow('node unreachable');

    await expect(readPublicPswapNote('failed-public-sale')).resolves.toMatchObject({ kind: 'open', note });
    expect(mockGetNotesById).toHaveBeenCalledTimes(2);
  });

  it('keeps a timed-out underlying RPC bounded and permits a changed node', async () => {
    jest.useFakeTimers();
    try {
      mockGetNotesById.mockImplementationOnce(() => new Promise(() => undefined));
      const parked = readPublicPswapNote('hung-public-sale').catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(5_000);
      expect(await parked).toBeInstanceOf(Error);
      await expect(readPublicPswapNote('hung-public-sale')).rejects.toThrow('previous node read has not settled');
      expect(mockGetNotesById).toHaveBeenCalledTimes(1);
      expect(RpcClient).toHaveBeenCalledTimes(1);
      mockRpcUrl = 'https://node-b';
      const note = pswapNote({ id: 'hung-public-sale' });
      commit(note, 120);
      await expect(readPublicPswapNote('hung-public-sale')).resolves.toMatchObject({ kind: 'open', note });
      expect(RpcClient).toHaveBeenLastCalledWith('https://node-b');
    } finally {
      jest.useRealTimers();
    }
  });
});
