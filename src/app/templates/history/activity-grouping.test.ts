import { truncateAddress } from 'utils/string';

import { groupActivity, UNKNOWN_GROUP_ID } from './activity-grouping';
import { HistoryEntryType, IHistoryEntry } from './IHistoryEntry';

const ALICE = 'mtst1apfq9x7k2m4n6p8r0t2v4w6y8z1b3d5f7h9j';
const BOB = 'mtst1qzw3e5r7t9y1u3i5o7p9a1s3d5f7g9h1j3k5l';

const entry = (over: Partial<IHistoryEntry> & { key: string; timestamp: number }): IHistoryEntry =>
  ({
    address: 'mtst1self',
    message: 'msg',
    type: HistoryEntryType.CompletedTransaction,
    txType: 'send',
    ...over
  }) as IHistoryEntry;

describe('groupActivity — grouping', () => {
  it('groups entries by counterparty address', () => {
    const groups = groupActivity([
      entry({ key: 'a1', timestamp: 30, secondaryAddress: ALICE }),
      entry({ key: 'b1', timestamp: 20, secondaryAddress: BOB }),
      entry({ key: 'a2', timestamp: 10, secondaryAddress: ALICE })
    ]);

    expect(groups).toHaveLength(2);
    const alice = groups.find(g => g.address === ALICE)!;
    expect(alice.entries.map(e => e.key)).toEqual(['a1', 'a2']);
    expect(alice.kind).toBe('contact');
  });

  it('names a group from the address book when the address is saved', () => {
    const [group] = groupActivity([entry({ key: 'a1', timestamp: 1, secondaryAddress: ALICE })], {
      contacts: [{ address: ALICE, name: 'Alice' }]
    });

    expect(group!.name).toBe('Alice');
  });

  it('falls back to the address label, never to a name carried on the transaction', () => {
    // `truncateAddress` is stubbed to identity by __mocks__/utils/string.ts, so
    // assert against the helper rather than a hardcoded shortening — the
    // contract here is *which* source the name comes from, not how it is cut.
    const [group] = groupActivity([
      entry({ key: 'a1', timestamp: 1, secondaryAddress: ALICE, message: 'Totally Legit Exchange' })
    ]);

    expect(group!.name).toBe(truncateAddress(ALICE, true, 8));
    expect(group!.name).not.toBe('Totally Legit Exchange');
  });

  it('puts a transaction in exactly one group', () => {
    const groups = groupActivity([entry({ key: 'a1', timestamp: 1, secondaryAddress: ALICE })], {
      dappByEntryKey: { a1: { origin: 'https://dex.test', name: 'DEX' } },
      contacts: [{ address: ALICE, name: 'Alice' }]
    });

    expect(groups).toHaveLength(1);
    expect(groups.flatMap(g => g.entries.map(e => e.key))).toEqual(['a1']);
  });

  it('prefers the dApp over the contact when a transaction has both', () => {
    const [group] = groupActivity([entry({ key: 'a1', timestamp: 1, secondaryAddress: ALICE })], {
      dappByEntryKey: { a1: { origin: 'https://dex.test', name: 'DEX' } },
      contacts: [{ address: ALICE, name: 'Alice' }]
    });

    expect(group!.kind).toBe('dapp');
    expect(group!.name).toBe('DEX');
  });
});

describe('groupActivity — unknown counterparties', () => {
  it('keeps an entry with no counterparty visible in an explicit group', () => {
    const groups = groupActivity([entry({ key: 'x1', timestamp: 5 })]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.id).toBe(UNKNOWN_GROUP_ID);
    expect(groups[0]!.kind).toBe('unknown');
    expect(groups[0]!.entries.map(e => e.key)).toEqual(['x1']);
  });

  it('drops nothing: every entry lands in some group', () => {
    const entries = [
      entry({ key: 'a1', timestamp: 3, secondaryAddress: ALICE }),
      entry({ key: 'x1', timestamp: 2 }),
      entry({ key: 'b1', timestamp: 1, secondaryAddress: BOB })
    ];

    const grouped = groupActivity(entries).flatMap(g => g.entries.map(e => e.key));

    expect(grouped.sort()).toEqual(['a1', 'b1', 'x1']);
  });
});

describe('groupActivity — ordering', () => {
  it('orders groups by their newest entry', () => {
    const groups = groupActivity([
      entry({ key: 'b1', timestamp: 10, secondaryAddress: BOB }),
      entry({ key: 'a1', timestamp: 99, secondaryAddress: ALICE })
    ]);

    expect(groups.map(g => g.address)).toEqual([ALICE, BOB]);
  });

  it('orders entries inside a group newest first', () => {
    const [group] = groupActivity([
      entry({ key: 'old', timestamp: 1, secondaryAddress: ALICE }),
      entry({ key: 'new', timestamp: 9, secondaryAddress: ALICE })
    ]);

    expect(group!.entries.map(e => e.key)).toEqual(['new', 'old']);
  });
});

describe('groupActivity — pending claims', () => {
  it('counts a pending claim against its sender group', () => {
    const [group] = groupActivity([entry({ key: 'a1', timestamp: 1, secondaryAddress: ALICE })], {
      pendingClaims: [{ id: 'n1', senderAddress: ALICE }]
    });

    expect(group!.pendingCount).toBe(1);
  });

  it('creates a group for a claim from someone with no transaction history', () => {
    const groups = groupActivity([], { pendingClaims: [{ id: 'n1', senderAddress: BOB }] });

    expect(groups).toHaveLength(1);
    expect(groups[0]!.address).toBe(BOB);
    expect(groups[0]!.entries).toHaveLength(0);
    expect(groups[0]!.pendingCount).toBe(1);
  });

  it('files a claim with no sender under the unknown group', () => {
    const groups = groupActivity([], { pendingClaims: [{ id: 'n1' }] });

    expect(groups[0]!.id).toBe(UNKNOWN_GROUP_ID);
    expect(groups[0]!.pendingCount).toBe(1);
  });

  it('leaves groups with nothing to claim at zero', () => {
    const [group] = groupActivity([entry({ key: 'a1', timestamp: 1, secondaryAddress: ALICE })]);

    expect(group!.pendingCount).toBe(0);
  });
});

describe('groupActivity — empty state', () => {
  it('returns no groups for no activity', () => {
    expect(groupActivity([])).toEqual([]);
    expect(groupActivity([], { contacts: [{ address: ALICE, name: 'Alice' }] })).toEqual([]);
  });
});
