import { HistoryEntryType, IHistoryEntry } from './IHistoryEntry';
import {
  activityGroupKeyOf,
  activityGroupMatcher,
  activityGroupPath,
  groupActivityEntries,
  isActivityGroupKind,
  isPendingActivityEntry
} from './activityGroups';

const FAUCET = 'miden-native-faucet';

// `isFaucetRequest` reads the chain's native asset id synchronously; nothing else in this module
// touches the chain.
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetIdSync: () => FAUCET
}));

let nextKey = 0;
const entry = (over: Partial<IHistoryEntry> = {}): IHistoryEntry => ({
  key: `entry-${++nextKey}`,
  address: 'me',
  timestamp: 1_000,
  message: 'Sent',
  type: HistoryEntryType.CompletedTransaction,
  txType: 'send',
  ...over
});

describe('activityGroupKeyOf', () => {
  it('keys a send and a receive by their counterparty', () => {
    expect(activityGroupKeyOf(entry({ txType: 'send', secondaryAddress: 'mtst1alice' }))).toEqual({
      kind: 'address',
      id: 'mtst1alice'
    });
    expect(activityGroupKeyOf(entry({ txType: 'consume', secondaryAddress: 'mtst1bob' }))).toEqual({
      kind: 'address',
      id: 'mtst1bob'
    });
  });

  it('keys every swap into one group, whatever the pair', () => {
    const usdc = activityGroupKeyOf(entry({ txType: 'swap', token: 'MIDEN', requestedToken: 'USDC' }));
    const eth = activityGroupKeyOf(entry({ txType: 'swap', token: 'USDC', requestedToken: 'ETH' }));
    expect(usdc).toEqual({ kind: 'swap', id: 'swap' });
    expect(eth).toEqual(usdc);
  });

  it('keys a faucet claim as faucet rather than as its faucet address', () => {
    const faucetClaim = entry({
      txType: 'consume',
      transactionIcon: 'RECEIVE',
      faucetId: FAUCET,
      secondaryAddress: FAUCET
    });
    expect(activityGroupKeyOf(faucetClaim)).toEqual({ kind: 'faucet', id: 'faucet' });
  });

  it('keys both guardian operations into the system group', () => {
    expect(activityGroupKeyOf(entry({ txType: 'switch-guardian' }))).toEqual({ kind: 'guardian', id: 'guardian' });
    expect(activityGroupKeyOf(entry({ txType: 'replace-hot-key' }))).toEqual({ kind: 'guardian', id: 'guardian' });
  });

  it('keeps a guardian switch out of the address group even though it carries one', () => {
    expect(activityGroupKeyOf(entry({ txType: 'switch-guardian', secondaryAddress: 'mtst1guardian' })).kind).toBe(
      'guardian'
    );
  });

  it('falls back to `other` for an entry with no counterparty at all', () => {
    expect(activityGroupKeyOf(entry({ txType: 'execute' }))).toEqual({ kind: 'other', id: 'other' });
    expect(activityGroupKeyOf(entry({ txType: 'send', secondaryAddress: '   ' }))).toEqual({
      kind: 'other',
      id: 'other'
    });
  });
});

describe('groupActivityEntries', () => {
  it('returns one group per counterparty or category, with its count', () => {
    const groups = groupActivityEntries([
      entry({ timestamp: 500, secondaryAddress: 'mtst1alice' }),
      entry({ timestamp: 400, txType: 'consume', secondaryAddress: 'mtst1alice' }),
      entry({ timestamp: 300, txType: 'swap' })
    ]);

    expect(groups.map(g => [g.kind, g.id, g.count])).toEqual([
      ['address', 'mtst1alice', 2],
      ['swap', 'swap', 1]
    ]);
  });

  it('sorts the groups by their latest entry, newest first', () => {
    const groups = groupActivityEntries([
      entry({ timestamp: 100, secondaryAddress: 'mtst1old' }),
      entry({ timestamp: 900, txType: 'swap' }),
      entry({ timestamp: 500, secondaryAddress: 'mtst1mid' })
    ]);

    expect(groups.map(g => g.id)).toEqual(['swap', 'mtst1mid', 'mtst1old']);
  });

  it('breaks a tie on the latest timestamp by id, so a lap that loads nothing new never reshuffles', () => {
    const groups = groupActivityEntries([
      entry({ timestamp: 100, secondaryAddress: 'mtst1zed' }),
      entry({ timestamp: 100, secondaryAddress: 'mtst1amy' })
    ]);

    expect(groups.map(g => g.id)).toEqual(['mtst1amy', 'mtst1zed']);
  });

  it("names the latest entry as the group's own, not whichever arrived last", () => {
    const newest = entry({ timestamp: 900, message: 'Sent', secondaryAddress: 'mtst1alice' });
    const groups = groupActivityEntries([
      newest,
      entry({ timestamp: 100, message: 'Received', secondaryAddress: 'mtst1alice' })
    ]);

    expect(groups[0]?.latest).toBe(newest);
    expect(groups[0]?.latestTimestamp).toBe(900);
  });

  it('keeps the feed order inside a group, so the first entry at one timestamp stays newest', () => {
    const first = entry({ timestamp: 100, message: 'Sent', secondaryAddress: 'mtst1alice' });
    const second = entry({ timestamp: 100, message: 'Received', secondaryAddress: 'mtst1alice' });
    const groups = groupActivityEntries([first, second]);

    expect(groups[0]?.entries).toEqual([first, second]);
    expect(groups[0]?.latest).toBe(first);
  });

  it('counts the in-flight rows rather than hiding them', () => {
    const groups = groupActivityEntries([
      entry({ timestamp: 900, type: HistoryEntryType.PendingTransaction, secondaryAddress: 'mtst1alice' }),
      entry({ timestamp: 800, type: HistoryEntryType.ProcessingTransaction, secondaryAddress: 'mtst1alice' }),
      entry({ timestamp: 700, secondaryAddress: 'mtst1alice' })
    ]);

    expect(groups[0]?.count).toBe(3);
    expect(groups[0]?.pendingCount).toBe(2);
  });

  it('reports no pending badge for a group that has settled', () => {
    const groups = groupActivityEntries([entry({ secondaryAddress: 'mtst1alice' })]);
    expect(groups[0]?.pendingCount).toBe(0);
  });

  it('names a counterparty that matches a contact and leaves an unknown address unnamed', () => {
    const groups = groupActivityEntries(
      [
        entry({ timestamp: 900, secondaryAddress: 'mtst1alice' }),
        entry({ timestamp: 800, secondaryAddress: '0xf00d' })
      ],
      address => (address === 'mtst1alice' ? 'Alice' : undefined)
    );

    expect(groups.map(g => [g.id, g.name])).toEqual([
      ['mtst1alice', 'Alice'],
      ['0xf00d', undefined]
    ]);
  });

  it('never names a category group', () => {
    const groups = groupActivityEntries([entry({ txType: 'swap' })], () => 'Should not be used');
    expect(groups[0]?.name).toBeUndefined();
  });

  it('treats two spellings of one `0x` address as one counterparty', () => {
    const groups = groupActivityEntries([
      entry({ timestamp: 900, secondaryAddress: '0xABCD' }),
      entry({ timestamp: 800, secondaryAddress: '0xabcd' })
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.count).toBe(2);
    // The first spelling seen wins the id, so the row reads as the newest entry wrote it.
    expect(groups[0]?.id).toBe('0xABCD');
  });

  it('sorts a group whose entries carry no usable timestamp last instead of first', () => {
    const groups = groupActivityEntries([
      entry({ timestamp: Number.NaN, secondaryAddress: 'mtst1broken' }),
      entry({ timestamp: 10, secondaryAddress: 'mtst1fine' })
    ]);

    expect(groups.map(g => g.id)).toEqual(['mtst1fine', 'mtst1broken']);
    expect(groups[1]?.latestTimestamp).toBe(-Infinity);
    // The row is still listed and still has an entry to describe itself with.
    expect(groups[1]?.latest).toBeDefined();
  });

  it('groups nothing into nothing', () => {
    expect(groupActivityEntries([])).toEqual([]);
  });
});

describe('isPendingActivityEntry', () => {
  it.each([
    [HistoryEntryType.PendingTransaction, true],
    [HistoryEntryType.ProcessingTransaction, true],
    [HistoryEntryType.CompletedTransaction, false]
  ])('reads %s as pending: %s', (type, expected) => {
    expect(isPendingActivityEntry(entry({ type }))).toBe(expected);
  });
});

describe('activityGroupMatcher', () => {
  it('keeps only the named counterparty, whatever the case of the address', () => {
    const matches = activityGroupMatcher('address', '0xABCD');

    expect(matches(entry({ secondaryAddress: '0xabcd' }))).toBe(true);
    expect(matches(entry({ secondaryAddress: '0xbeef' }))).toBe(false);
    expect(matches(entry({ txType: 'swap' }))).toBe(false);
  });

  it('keeps every entry of a category group', () => {
    const matches = activityGroupMatcher('swap');

    expect(matches(entry({ txType: 'swap' }))).toBe(true);
    expect(matches(entry({ secondaryAddress: 'mtst1alice' }))).toBe(false);
  });

  it('matches both guardian operations', () => {
    const matches = activityGroupMatcher('guardian');

    expect(matches(entry({ txType: 'switch-guardian' }))).toBe(true);
    expect(matches(entry({ txType: 'replace-hot-key' }))).toBe(true);
  });

  it('matches nothing when an address group is asked for without an address', () => {
    expect(activityGroupMatcher('address')(entry({ secondaryAddress: 'mtst1alice' }))).toBe(false);
  });
});

describe('activityGroupPath', () => {
  it('encodes an address into the route', () => {
    expect(activityGroupPath({ kind: 'address', id: 'mtst1alice' })).toBe('/activity/group/address/mtst1alice');
    expect(activityGroupPath({ kind: 'address', id: 'a/b' })).toBe('/activity/group/address/a%2Fb');
  });

  it('leaves a category group without an id segment', () => {
    expect(activityGroupPath({ kind: 'swap', id: 'swap' })).toBe('/activity/group/swap');
    expect(activityGroupPath({ kind: 'guardian', id: 'guardian' })).toBe('/activity/group/guardian');
  });
});

describe('isActivityGroupKind', () => {
  it('accepts the five kinds and nothing else', () => {
    for (const kind of ['address', 'swap', 'faucet', 'guardian', 'other']) {
      expect(isActivityGroupKind(kind)).toBe(true);
    }
    expect(isActivityGroupKind('bridges')).toBe(false);
    expect(isActivityGroupKind(undefined)).toBe(false);
  });
});
