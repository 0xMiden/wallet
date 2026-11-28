import {
  appendPositionEvents,
  foldPositionEvents,
  readPositionEvents,
  readTrackingSince,
  type PositionEvent
} from './position-events';
import { db, Table } from './repo';

const T = 1_800_000_000_000;
const DOLLAR = 1_000_000n;
// Two dollars per whole token of 6 decimals, retrieved 60 s before each event.
const market = (at: number) => ({ priceMicro: 2n * DOLLAR, kind: 'market' as const, observedAt: at - 60_000 });

let n = 0;
const event = (changes: Partial<PositionEvent>): PositionEvent => {
  n += 1;
  return {
    key: `tx${n}:faucet`,
    txId: `tx${n}`,
    accountId: 'account-a',
    network: 'mainnet',
    faucetId: 'faucet',
    eventAt: T + n * 1000,
    arrived: 0n,
    departed: 0n,
    heldAfter: null,
    decimals: 6,
    quote: null,
    ...changes
  };
};
const arrival = (amount: bigint, heldAfter: bigint | null, at = T + 10_000) =>
  event({ arrived: amount, heldAfter, eventAt: at, quote: market(at) });

beforeEach(async () => {
  await db.table(Table.PositionEvents).clear();
});

describe('foldPositionEvents', () => {
  it('costs a first arrival into an empty vault at its arrival price', () => {
    expect(foldPositionEvents([arrival(5n * DOLLAR, 5n * DOLLAR)])).toEqual({
      quantity: 5n * DOLLAR,
      costMicro: 10n * DOLLAR
    });
  });

  it('keeps tokens held before tracking unknown until they are sold out, then tracks the next arrival', () => {
    const rows = [
      // 3 tokens were already there: 3 + 5 = 8 after the first recorded arrival.
      arrival(5n * DOLLAR, 8n * DOLLAR),
      event({ departed: 8n * DOLLAR, heldAfter: 0n }),
      arrival(1n * DOLLAR, 1n * DOLLAR)
    ];
    expect(foldPositionEvents(rows.slice(0, 1))).toEqual({ quantity: 8n * DOLLAR, costMicro: undefined });
    expect(foldPositionEvents(rows.slice(0, 2))).toEqual({ quantity: 0n, costMicro: 0n });
    expect(foldPositionEvents(rows)).toEqual({ quantity: 1n * DOLLAR, costMicro: 2n * DOLLAR });
  });

  it('restarts at an unknown cost when the vault moved between two recorded events', () => {
    const rows = [arrival(5n * DOLLAR, 5n * DOLLAR), arrival(1n * DOLLAR, 9n * DOLLAR)];
    expect(foldPositionEvents(rows)).toEqual({ quantity: 9n * DOLLAR, costMicro: undefined });
  });

  it('knows nothing about holdings before its first vault reading', () => {
    expect(foldPositionEvents([arrival(5n * DOLLAR, null)])).toEqual({ quantity: 5n * DOLLAR, costMicro: undefined });
  });

  it('applies an unanchored event to an anchored position', () => {
    const rows = [arrival(4n * DOLLAR, 4n * DOLLAR), event({ departed: 1n * DOLLAR, heldAfter: null })];
    expect(foldPositionEvents(rows)).toEqual({ quantity: 3n * DOLLAR, costMicro: 6n * DOLLAR });
  });

  it('removes a fee at average cost, as a departure of the fee asset', () => {
    const rows = [arrival(4n * DOLLAR, 4n * DOLLAR), event({ departed: DOLLAR / 2n, heldAfter: 35n * (DOLLAR / 10n) })];
    expect(foldPositionEvents(rows)).toEqual({ quantity: 35n * (DOLLAR / 10n), costMicro: 7n * DOLLAR });
  });

  it('nets an arrival and a departure of one token in one transaction', () => {
    const at = T + 20_000;
    const rows = [
      arrival(4n * DOLLAR, 4n * DOLLAR),
      event({ arrived: 2n * DOLLAR, departed: DOLLAR, heldAfter: 5n * DOLLAR, eventAt: at, quote: market(at) })
    ];
    // 8 + 4 for 6 tokens, then one leaves at 2 each.
    expect(foldPositionEvents(rows)).toEqual({ quantity: 5n * DOLLAR, costMicro: 10n * DOLLAR });
  });

  it('leaves an arrival priced after it, or more than 600 s before it, unpriced', () => {
    const at = T + 10_000;
    const after = event({
      arrived: DOLLAR,
      heldAfter: DOLLAR,
      eventAt: at,
      quote: { ...market(at), observedAt: at + 1 }
    });
    const stale = event({
      arrived: DOLLAR,
      heldAfter: DOLLAR,
      eventAt: at,
      quote: { ...market(at), observedAt: at - 600_001 }
    });
    expect(foldPositionEvents([after]).costMicro).toBeUndefined();
    expect(foldPositionEvents([stale]).costMicro).toBeUndefined();
  });

  it('prices a fixed quote whatever its age', () => {
    const fixed = event({ arrived: DOLLAR, heldAfter: DOLLAR, quote: { priceMicro: DOLLAR, kind: 'fixed' } });
    expect(foldPositionEvents([fixed])).toEqual({ quantity: DOLLAR, costMicro: DOLLAR });
  });

  it('trusts the vault quantity over amounts that cannot explain it', () => {
    expect(foldPositionEvents([event({ arrived: 5n * DOLLAR, heldAfter: DOLLAR })])).toEqual({
      quantity: DOLLAR,
      costMicro: undefined
    });
  });
});

describe('position event storage', () => {
  it('records a transaction once and reads one token in recording order', async () => {
    const first = arrival(DOLLAR, DOLLAR);
    const second = event({ departed: DOLLAR, heldAfter: 0n, eventAt: T - 5_000 });
    const other = event({ arrived: DOLLAR, faucetId: 'other', key: 'tx-other:other', txId: 'tx-other' });
    const where = jest.spyOn(db.table(Table.PositionEvents), 'where');
    expect(await appendPositionEvents(first.txId, [first])).toBe(true);
    expect(await appendPositionEvents(first.txId, [{ ...first, arrived: 7n }])).toBe(false);
    expect(await appendPositionEvents(second.txId, [second])).toBe(true);
    expect(await appendPositionEvents(other.txId, [other])).toBe(true);
    expect(await appendPositionEvents('empty', [])).toBe(false);

    const read = await readPositionEvents('account-a', 'mainnet', 'faucet');
    expect(read.map(row => [row.txId, row.arrived])).toEqual([
      [first.txId, DOLLAR],
      [second.txId, 0n]
    ]);
    expect(await readPositionEvents('account-a', 'testnet', 'faucet')).toEqual([]);
    expect(await readTrackingSince('account-a', 'mainnet')).toBe(T - 5_000);
    expect(await readTrackingSince('account-b', 'mainnet')).toBeUndefined();
    expect(where).toHaveBeenCalledWith('[accountId+network+eventAt]');
    where.mockRestore();
  });
});
