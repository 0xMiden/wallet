import { truncateAddress } from 'utils/string';

import { UNKNOWN_GROUP_ID, WALLET_GROUP_ID, groupActivity, groupIdForAddress } from './activity-grouping';
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

    expect(group!.kind).toBe('app');
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

describe('groupActivity — actions', () => {
  it('counts a pending claim against its sender group', () => {
    const [group] = groupActivity([entry({ key: 'a1', timestamp: 1, secondaryAddress: ALICE })], {
      actions: [{ groupId: `contact:${ALICE}` }]
    });

    expect(group!.pendingCount).toBe(1);
  });

  it('creates a group for a claim from someone with no transaction history', () => {
    const groups = groupActivity([], { actions: [{ groupId: `contact:${BOB}` }] });

    expect(groups).toHaveLength(1);
    expect(groups[0]!.address).toBe(BOB);
    expect(groups[0]!.entries).toHaveLength(0);
    expect(groups[0]!.pendingCount).toBe(1);
  });

  it('files a claim with no sender under the unknown group', () => {
    const groups = groupActivity([], { actions: [{ groupId: UNKNOWN_GROUP_ID }] });

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

describe('groupActivity — in-protocol flows', () => {
  const swap = (over: Partial<IHistoryEntry> & { key: string; timestamp: number }) =>
    entry({ txType: 'swap', ...over });

  it('groups swaps under the in-protocol DEX, flagged as a protocol group', () => {
    const [group] = groupActivity([swap({ key: 's1', timestamp: 1 })], { protocolNames: { swap: 'Swap' } });

    expect(group!.id).toBe('protocol:swap');
    expect(group!.kind).toBe('app');
    expect(group!.protocol).toBe('swap');
    expect(group!.name).toBe('Swap');
  });

  it('collects every swap into one group regardless of counterparty', () => {
    const groups = groupActivity([
      swap({ key: 's1', timestamp: 3, secondaryAddress: ALICE }),
      swap({ key: 's2', timestamp: 2, secondaryAddress: BOB }),
      swap({ key: 's3', timestamp: 1 })
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.entries.map(e => e.key)).toEqual(['s1', 's2', 's3']);
  });

  it('prefers the protocol over a saved contact', () => {
    // A swap's counterparty is the matching order, not a person — filing it
    // under Alice would invent a relationship the user never had.
    const [group] = groupActivity([swap({ key: 's1', timestamp: 1, secondaryAddress: ALICE })], {
      contacts: [{ address: ALICE, name: 'Alice' }],
      protocolNames: { swap: 'Swap' }
    });

    expect(group!.protocol).toBe('swap');
    expect(group!.name).toBe('Swap');
  });

  it('still yields to durable dApp attribution', () => {
    const [group] = groupActivity([swap({ key: 's1', timestamp: 1 })], {
      dappByEntryKey: { s1: { origin: 'https://dex.test', name: 'Some DEX' } },
      protocolNames: { swap: 'Swap' }
    });

    expect(group!.name).toBe('Some DEX');
    expect(group!.protocol).toBeUndefined();
  });

  it('leaves non-protocol transactions ungrouped by protocol', () => {
    const [group] = groupActivity([entry({ key: 'a1', timestamp: 1, secondaryAddress: ALICE })]);

    expect(group!.protocol).toBeUndefined();
    expect(group!.kind).toBe('contact');
  });

  it('falls back to the protocol id when no display name is supplied', () => {
    const [group] = groupActivity([swap({ key: 's1', timestamp: 1 })]);

    expect(group!.name).toBe('swap');
  });
});

describe('groupActivity — wallet-native flows are not people', () => {
  // Each of these used to be mis-filed: earn under the Epoch allocator address,
  // bridges under an EVM 0x address that can never match the address book, and
  // the self-maintenance types under `unknown`.
  const at = (over: Partial<IHistoryEntry> & { key: string; timestamp: number }) => entry(over);

  it('files an earn deposit under Earn, not under the allocator address', () => {
    const ALLOCATOR = 'mtst1allocatorxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    const [group] = groupActivity(
      [at({ key: 'e1', timestamp: 1, txType: 'earn-deposit', secondaryAddress: ALLOCATOR })],
      {
        protocolNames: { earn: 'Earn' }
      }
    );

    expect(group!.protocol).toBe('earn');
    expect(group!.address).toBeUndefined();
    expect(group!.name).toBe('Earn');
  });

  it('files an earn withdrawal alongside it rather than in unknown', () => {
    const groups = groupActivity([
      at({ key: 'e1', timestamp: 2, txType: 'earn-deposit' }),
      at({ key: 'e2', timestamp: 1, txType: 'earn-withdraw' })
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.protocol).toBe('earn');
  });

  it('files a bridge send under Bridge, not under its EVM address', () => {
    const [group] = groupActivity(
      [
        at({
          key: 'b1',
          timestamp: 1,
          txType: 'bridged-send',
          secondaryAddress: '0xabc0000000000000000000000000000000000000'
        })
      ],
      { protocolNames: { bridge: 'Bridge' } }
    );

    expect(group!.protocol).toBe('bridge');
    expect(group!.kind).toBe('app');
    expect(group!.address).toBeUndefined();
  });

  it('files a bridge receive with it rather than in unknown', () => {
    const groups = groupActivity([
      at({ key: 'b1', timestamp: 2, txType: 'bridged-send', secondaryAddress: '0xabc' }),
      at({ key: 'b2', timestamp: 1, txType: 'bridged-receive' })
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.protocol).toBe('bridge');
  });

  it('puts wallet self-maintenance in its own group, not unknown', () => {
    const groups = groupActivity([
      at({ key: 'g1', timestamp: 3, txType: 'switch-guardian' }),
      at({ key: 'g2', timestamp: 2, txType: 'replace-hot-key' }),
      at({ key: 'g3', timestamp: 1, txType: 'update-procedure-threshold' })
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.id).toBe(WALLET_GROUP_ID);
    expect(groups[0]!.kind).toBe('wallet');
    expect(groups[0]!.entries).toHaveLength(3);
  });

  it('leaves unknown holding only genuinely unattributable entries', () => {
    const groups = groupActivity([
      at({ key: 'g1', timestamp: 4, txType: 'switch-guardian' }),
      at({ key: 'e1', timestamp: 3, txType: 'earn-deposit' }),
      at({ key: 'b1', timestamp: 2, txType: 'bridged-receive' }),
      at({ key: 'x1', timestamp: 1 })
    ]);

    const unknown = groups.find(g => g.id === UNKNOWN_GROUP_ID)!;
    expect(unknown.entries.map(e => e.key)).toEqual(['x1']);
  });
});

describe('groupActivity — ranking by what needs doing', () => {
  it('puts a group with an action above a more recent settled one', () => {
    const groups = groupActivity([entry({ key: 'recent', timestamp: 9_999, secondaryAddress: BOB })], {
      actions: [{ groupId: `contact:${ALICE}` }]
    });

    expect(groups.map(g => g.address)).toEqual([ALICE, BOB]);
  });

  it('puts a deadline-bound action above an open-ended one, soonest first', () => {
    const groups = groupActivity([], {
      actions: [
        { groupId: `contact:${ALICE}` },
        { groupId: `contact:${BOB}`, deadlineAt: 5_000 },
        { groupId: UNKNOWN_GROUP_ID, deadlineAt: 1_000 }
      ]
    });

    expect(groups.map(g => g.id)).toEqual([UNKNOWN_GROUP_ID, `contact:${BOB}`, `contact:${ALICE}`]);
  });

  it('records the soonest deadline when a group has several', () => {
    const [group] = groupActivity([], {
      actions: [
        { groupId: `contact:${ALICE}`, deadlineAt: 900 },
        { groupId: `contact:${ALICE}`, deadlineAt: 100 }
      ]
    });

    expect(group!.pendingCount).toBe(2);
    expect(group!.nextDeadlineAt).toBe(100);
  });

  it('sorts wallet self-maintenance last', () => {
    const groups = groupActivity([
      entry({ key: 'g1', timestamp: 9_999, txType: 'switch-guardian' }),
      entry({ key: 'a1', timestamp: 1, secondaryAddress: ALICE })
    ]);

    expect(groups.map(g => g.id)).toEqual([`contact:${ALICE}`, WALLET_GROUP_ID]);
  });

  it('ranks an in-flight group above a settled one', () => {
    const groups = groupActivity([
      entry({ key: 'settled', timestamp: 9_999, secondaryAddress: BOB }),
      entry({ key: 'pending', timestamp: 1, secondaryAddress: ALICE, type: HistoryEntryType.PendingTransaction })
    ]);

    expect(groups.map(g => g.address)).toEqual([ALICE, BOB]);
  });
});

/**
 * `handleClaimActivityGroup` scopes its batch with exactly this mapping, so a
 * Claim tapped inside one conversation can only ever consume the notes that
 * conversation counted. These are the properties that has to rest on.
 */
describe('groupIdForAddress — the claim scope', () => {
  it('never puts two different senders in the same group', () => {
    expect(groupIdForAddress(ALICE)).not.toBe(groupIdForAddress(BOB));
  });

  it('files a sender-less note under the unattributed group rather than dropping it', () => {
    // Otherwise the one group that exists *because* we could not attribute it
    // would be the one group with no way to act.
    expect(groupIdForAddress(undefined)).toBe(UNKNOWN_GROUP_ID);
    expect(groupIdForAddress('')).toBe(UNKNOWN_GROUP_ID);
  });

  it('agrees with the id an entry from the same counterparty gets', () => {
    const [group] = groupActivity([entry({ key: 'a1', timestamp: 1, secondaryAddress: ALICE })]);

    expect(groupIdForAddress(ALICE)).toBe(group!.id);
  });
});
