import { detectArrivals } from './detect';
import { DEPOSIT_TOKENS } from './tokens';
import { watermarkKey, type DepositWatermarkStore } from './watermarks';

const ADDRESS = '0x1111111111111111111111111111111111111111';

const ONE_ETH = 1_000_000_000_000_000_000n;

function storeWith(entries: Array<{ token: 'ETH' | 'USDC'; acknowledged: bigint; drawerShown?: bigint }>) {
  const store: DepositWatermarkStore = {};
  for (const entry of entries) {
    store[watermarkKey(ADDRESS, entry.token)] = {
      acknowledged: entry.acknowledged.toString(),
      drawerShown: (entry.drawerShown ?? entry.acknowledged).toString(),
      updatedAt: 1
    };
  }
  return store;
}

describe('detectArrivals', () => {
  it('seeds a missing record at the current balance instead of prompting', () => {
    const { arrivals, corrections } = detectArrivals({
      address: ADDRESS,
      balances: { ETH: ONE_ETH, USDC: null },
      store: {}
    });

    expect(arrivals).toEqual([]);
    expect(corrections).toEqual([{ token: 'ETH', acknowledged: ONE_ETH, drawerShown: ONE_ETH }]);
  });

  it('reports the delta over the acknowledged watermark', () => {
    const { arrivals, corrections } = detectArrivals({
      address: ADDRESS,
      balances: { ETH: 3n * ONE_ETH },
      store: storeWith([{ token: 'ETH', acknowledged: ONE_ETH }])
    });

    expect(corrections).toEqual([]);
    expect(arrivals).toEqual([
      {
        key: watermarkKey(ADDRESS, 'ETH'),
        address: ADDRESS,
        token: 'ETH',
        amount: 2n * ONE_ETH,
        balance: 3n * ONE_ETH,
        drawerShown: false
      }
    ]);
  });

  it('clamps the watermarks down after a spend so a smaller later deposit still prompts', () => {
    // Post-bridge: balance dropped well below the acknowledged mark.
    const spent = detectArrivals({
      address: ADDRESS,
      balances: { ETH: 0n },
      store: storeWith([{ token: 'ETH', acknowledged: 10n * ONE_ETH, drawerShown: 10n * ONE_ETH }])
    });
    expect(spent.arrivals).toEqual([]);
    expect(spent.corrections).toEqual([{ token: 'ETH', acknowledged: 0n, drawerShown: 0n }]);

    // With the clamp applied, a deposit far smaller than the old balance prompts.
    const reprompt = detectArrivals({
      address: ADDRESS,
      balances: { ETH: ONE_ETH },
      store: storeWith([{ token: 'ETH', acknowledged: 0n, drawerShown: 0n }])
    });
    expect(reprompt.arrivals).toHaveLength(1);
    expect(reprompt.arrivals[0]?.amount).toBe(ONE_ETH);

    // Without the clamp the same deposit would be invisible.
    const unclamped = detectArrivals({
      address: ADDRESS,
      balances: { ETH: ONE_ETH },
      store: storeWith([{ token: 'ETH', acknowledged: 10n * ONE_ETH }])
    });
    expect(unclamped.arrivals).toEqual([]);
  });

  it('ignores deltas below the per-token dust floor without seeding them away', () => {
    const dust = DEPOSIT_TOKENS.ETH.dustFloor - 1n;
    const belowFloor = detectArrivals({
      address: ADDRESS,
      balances: { ETH: dust },
      store: storeWith([{ token: 'ETH', acknowledged: 0n }])
    });
    expect(belowFloor.arrivals).toEqual([]);
    expect(belowFloor.corrections).toEqual([]);

    // A later top-up crossing the floor reports the CUMULATIVE delta.
    const topUp = detectArrivals({
      address: ADDRESS,
      balances: { ETH: DEPOSIT_TOKENS.ETH.dustFloor + 1n },
      store: storeWith([{ token: 'ETH', acknowledged: 0n }])
    });
    expect(topUp.arrivals[0]?.amount).toBe(DEPOSIT_TOKENS.ETH.dustFloor + 1n);

    // USDC has its own, larger floor.
    const usdcDust = detectArrivals({
      address: ADDRESS,
      balances: { USDC: DEPOSIT_TOKENS.USDC.dustFloor - 1n },
      store: storeWith([{ token: 'USDC', acknowledged: 0n }])
    });
    expect(usdcDust.arrivals).toEqual([]);
  });

  it('gates the drawer on the drawerShown watermark, per balance value', () => {
    const alreadyShown = detectArrivals({
      address: ADDRESS,
      balances: { ETH: 2n * ONE_ETH },
      store: storeWith([{ token: 'ETH', acknowledged: ONE_ETH, drawerShown: 2n * ONE_ETH }])
    });
    expect(alreadyShown.arrivals[0]?.drawerShown).toBe(true);

    // A LARGER deposit lands afterwards — the drawer is due again.
    const larger = detectArrivals({
      address: ADDRESS,
      balances: { ETH: 5n * ONE_ETH },
      store: storeWith([{ token: 'ETH', acknowledged: ONE_ETH, drawerShown: 2n * ONE_ETH }])
    });
    expect(larger.arrivals[0]?.drawerShown).toBe(false);
  });

  it('skips tokens whose balance read failed and handles both tokens independently', () => {
    const { arrivals } = detectArrivals({
      address: ADDRESS,
      balances: { ETH: null, USDC: 5n * ONE_ETH },
      store: storeWith([
        { token: 'ETH', acknowledged: 0n },
        { token: 'USDC', acknowledged: ONE_ETH }
      ])
    });

    expect(arrivals).toHaveLength(1);
    expect(arrivals[0]?.token).toBe('USDC');
    expect(arrivals[0]?.amount).toBe(4n * ONE_ETH);
  });

  it('treats an unparseable stored mark as zero rather than throwing', () => {
    const store: DepositWatermarkStore = {
      [watermarkKey(ADDRESS, 'ETH')]: { acknowledged: 'not-a-number', drawerShown: 'nope', updatedAt: 1 }
    };

    const { arrivals } = detectArrivals({ address: ADDRESS, balances: { ETH: ONE_ETH }, store });
    expect(arrivals[0]?.amount).toBe(ONE_ETH);
  });
});
