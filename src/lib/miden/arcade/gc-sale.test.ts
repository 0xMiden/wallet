import type { PswapFields } from 'lib/miden/sdk/pswap-order-note';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';

import {
  DEFAULT_GC_PURCHASE_AMOUNT,
  GC_SALES,
  getGcSaleConfig,
  findLiveGcSale,
  findGcSales,
  pickGcSale,
  isGcSaleNote,
  pswapFillPayout,
  quoteGcPurchase,
  type GcSale,
  type GcSaleConfig
} from './gc-sale';

jest.mock('lib/miden/sdk/helpers', () => ({
  sameWalletAccountId: (a: string, b: string) => a.split('_')[0] === b.split('_')[0],
  walletAccountIdToSdk: (id: string) => id,
  getBech32AddressFromAccountId: (id: string) => id
}));
jest.mock('lib/miden/sdk/pswap-order-note', () => ({
  listCommittedNoteIdsByTag: jest.fn(),
  readPublicPswapNote: jest.fn(),
  readChainTip: jest.fn(async () => 1_000),
  pswapNoteTag: () => 123,
  GC_SALE_SCRIPT_ROOT: 'gc-sale-root'
}));
const mockDiscovery = jest.requireMock('lib/miden/sdk/pswap-order-note') as {
  listCommittedNoteIdsByTag: jest.Mock;
  readPublicPswapNote: jest.Mock;
  readChainTip: jest.Mock;
};
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getEffectiveNetworkName: () => 'mainnet',
  getEffectiveRpcUrl: () => mockRpcUrl
}));
jest.mock('lib/miden-chain/native-asset', () => ({ getNativeAssetIdSync: () => '0xusdcx' }));
let mockRpcUrl = 'https://node-a';
let mockSnapshot: Pick<BridgeConfigSnapshot, 'network' | 'config'> = { network: 'mainnet', config: null };
jest.mock('lib/remote-config/runtime', () => ({ getBridgeConfigSnapshot: () => mockSnapshot }));
jest.mock('lib/remote-config/values', () => ({
  selectGcSale: (s: Pick<BridgeConfigSnapshot, 'config'>) =>
    s.config?.features.arcadeGcPurchase === true ? (s.config.arcade?.sale ?? null) : null
}));

const config: GcSaleConfig = { gcFaucetId: '0xgc', sellerAccountId: '0xseller_suffix', fromBlock: 0 };

// The mainnet sale note as `scripts/dev/gc-sale/buy.mjs` read it: 49,850 GC against 49.85 USDCx, no fill floor.
const liveNote = (overrides: Partial<PswapFields> = {}): PswapFields => ({
  serial: [1n, 2n, 3n, 4n],
  storage: [0n, 0n, 49_850_000n, 0n, 1n, 0n, 0n],
  offeredFaucet: '0xgc',
  offeredAmount: 49_850_000_000n,
  requestedFaucet: '0xusdcx',
  creator: '0xseller',
  ...overrides
});

const sale = (overrides: Partial<GcSale> = {}): GcSale => ({
  saleNoteId: '0xnote',
  sellerAccountId: '0xseller_suffix',
  payFaucetId: '0xusdcx',
  gcFaucetId: 'gc-bech32',
  offeredAmount: 49_850_000_000n,
  requestedAmount: 49_850_000n,
  fillFloor: 0n,
  ...overrides
});

const documentWith = (features: Record<string, boolean>, arcade?: { sale: { seller: string } }) =>
  ({
    network: 'mainnet',
    config: {
      network: 'mainnet',
      version: 13,
      'bridge-providers': { epoch: {}, agglayer: {}, usdcx: {} },
      supportedEvmChains: {},
      features: { earn: false, nearIntents: false, ...features },
      mainnetCountdown: { enabled: false },
      swap: {},
      ...(arcade === undefined ? {} : { arcade })
    }
  }) satisfies Pick<BridgeConfigSnapshot, 'network' | 'config'>;

describe('getGcSaleConfig', () => {
  const bundled = GC_SALES[MIDEN_NETWORK_NAME.MAINNET];

  it('uses the bundled sale while no document is accepted, and none off mainnet', () => {
    mockSnapshot = { network: 'mainnet', config: null };
    expect(getGcSaleConfig(MIDEN_NETWORK_NAME.MAINNET)).toEqual(bundled);
    expect(getGcSaleConfig(MIDEN_NETWORK_NAME.TESTNET)).toBeUndefined();
  });

  it('takes the seller from a document that turns the purchase on, and turns off with one that does not', () => {
    mockSnapshot = documentWith({ arcadeGcPurchase: true }, { sale: { seller: '0xdocumentseller' } });
    expect(getGcSaleConfig(MIDEN_NETWORK_NAME.MAINNET)).toEqual({ ...bundled, sellerAccountId: '0xdocumentseller' });
    mockSnapshot = documentWith({ arcadeGcPurchase: false });
    expect(getGcSaleConfig(MIDEN_NETWORK_NAME.MAINNET)).toBeUndefined();
    mockSnapshot = documentWith({});
    expect(getGcSaleConfig(MIDEN_NETWORK_NAME.MAINNET)).toBeUndefined();
  });

  it('ignores a document of another network', () => {
    mockSnapshot = { ...documentWith({}), network: 'testnet' };
    expect(getGcSaleConfig(MIDEN_NETWORK_NAME.MAINNET)).toEqual(bundled);
  });
});

describe('pswapFillPayout', () => {
  it('pays floor(offered × fill ÷ requested), as the mainnet fill of 9,762 base units bought 9.762 GC', () => {
    expect(pswapFillPayout(liveNote(), 9_762n)).toBe(9_762_000n);
    expect(pswapFillPayout(liveNote(), 1_000_000n)).toBe(1_000_000_000n);
  });

  it('refuses a zero fill, an overfill and a fill under the floor, and pays the whole offer for a full fill', () => {
    expect(pswapFillPayout(liveNote(), 0n)).toBeUndefined();
    expect(pswapFillPayout(liveNote(), 49_850_001n)).toBeUndefined();
    expect(
      pswapFillPayout(liveNote({ storage: [0n, 0n, 49_850_000n, 2_000_000n, 1n, 0n, 0n] }), 1_000_000n)
    ).toBeUndefined();
    expect(pswapFillPayout(liveNote(), 49_850_000n)).toBe(49_850_000_000n);
  });

  it('treats a floor above the request as the request itself', () => {
    const tail = liveNote({ storage: [0n, 0n, 500n, 2_000n, 1n, 0n, 0n], offeredAmount: 500_000n });
    expect(pswapFillPayout(tail, 499n)).toBeUndefined();
    expect(pswapFillPayout(tail, 500n)).toBe(500_000n);
  });
});

describe('isGcSaleNote', () => {
  it('accepts any seller at the price limit and refuses a wrong pair or price', () => {
    expect(isGcSaleNote(liveNote(), config, '0xusdcx')).toBe(true);
    expect(isGcSaleNote(liveNote({ creator: '0xother' }), config, '0xusdcx')).toBe(true);
    expect(isGcSaleNote(liveNote({ storage: [0n, 0n, 49_850_001n] }), config, '0xusdcx')).toBe(false);
    expect(isGcSaleNote(liveNote({ offeredFaucet: '0xnotgc' }), config, '0xusdcx')).toBe(false);
    expect(isGcSaleNote(liveNote({ requestedFaucet: '0xother' }), config, '0xusdcx')).toBe(false);
  });
});

describe('quoteGcPurchase', () => {
  it('prices the default 1 GC at 0.001 USDCx and delivers exactly what was asked', () => {
    expect(quoteGcPurchase(sale(), DEFAULT_GC_PURCHASE_AMOUNT)).toEqual({
      quote: {
        saleNoteId: '0xnote',
        sellerAccountId: '0xseller_suffix',
        payFaucetId: '0xusdcx',
        fillAmount: 1_000n,
        gcFaucetId: 'gc-bech32',
        expectedAmount: 1_000_000n
      }
    });
  });

  it('rounds the cost up so the script’s floor never delivers less than asked', () => {
    const awkward = sale({ offeredAmount: 3_000_000n, requestedAmount: 1_000n });
    const result = quoteGcPurchase(awkward, 1_000_000n);
    expect('quote' in result && result.quote.fillAmount).toBe(334n);
    expect('quote' in result && result.quote.expectedAmount >= 1_000_000n).toBe(true);
  });

  it('takes the whole offer for the whole inventory and refuses more, nothing, or a cost under the floor', () => {
    const all = quoteGcPurchase(sale(), 49_850_000_000n);
    expect('quote' in all && all.quote).toEqual(
      expect.objectContaining({ fillAmount: 49_850_000n, expectedAmount: 49_850_000_000n })
    );
    expect(quoteGcPurchase(sale(), 49_850_000_001n)).toEqual({ refusal: 'above_inventory' });
    expect(quoteGcPurchase(sale(), 0n)).toEqual({ refusal: 'zero' });
    expect(quoteGcPurchase(sale({ fillFloor: 5_000n }), DEFAULT_GC_PURCHASE_AMOUNT)).toEqual({
      refusal: 'below_fill_floor'
    });
  });
});

describe('pickGcSale', () => {
  it('uses exact integer prices and selects the cheapest sale from any seller', () => {
    const cheaper = sale({ saleNoteId: 'cheap', sellerAccountId: 'other', requestedAmount: 24_925_000n });
    expect(pickGcSale([sale(), cheaper], DEFAULT_GC_PURCHASE_AMOUNT)?.saleNoteId).toBe('cheap');
  });

  it('excludes the buyer and checks inventory and minimum fill before comparing prices', () => {
    const own = sale({ sellerAccountId: 'buyer', requestedAmount: 1n });
    const small = sale({ saleNoteId: 'small', offeredAmount: 500_000n, requestedAmount: 500n });
    const floor = sale({ saleNoteId: 'floor', requestedAmount: 1_000n, fillFloor: 1_000n });
    expect(pickGcSale([own, small, floor, sale()], DEFAULT_GC_PURCHASE_AMOUNT, 'buyer_suffix')?.saleNoteId).toBe(
      '0xnote'
    );
    expect(pickGcSale([own], DEFAULT_GC_PURCHASE_AMOUNT, 'buyer_suffix')).toBeNull();
  });

  it('uses the larger inventory at the same price and changes the choice for a larger buy', () => {
    const large = sale({ saleNoteId: 'large', offeredAmount: 100_000_000_000n, requestedAmount: 100_000_000n });
    const cheap = sale({ saleNoteId: 'cheap', requestedAmount: 24_925_000n });
    expect(pickGcSale([sale(), large], DEFAULT_GC_PURCHASE_AMOUNT)?.saleNoteId).toBe('large');
    expect(pickGcSale([cheap, large], 60_000_000_000n)?.saleNoteId).toBe('large');
  });
});

describe('findLiveGcSale', () => {
  const seller = '0xseller';
  const fields = () => liveNote({ offeredFaucet: GC_SALES.mainnet!.gcFaucetId });
  const open = (noteId: string, creator = seller) => ({
    kind: 'open',
    note: { id: () => ({ toString: () => noteId }) },
    noteId,
    block: 100,
    fields: { ...fields(), creator }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockDiscovery.readChainTip.mockResolvedValue(1_000);
    mockRpcUrl += '/next';
    mockSnapshot = documentWith({ arcadeGcPurchase: true }, { sale: { seller } });
  });

  it('makes progress past nine unrelated tagged notes to the valid sale', async () => {
    const unrelated = Array.from({ length: 9 }, (_, index) => ({
      noteId: `unrelated-${index}`,
      block: 200 + index
    }));
    mockDiscovery.listCommittedNoteIdsByTag.mockResolvedValue([...unrelated, { noteId: 'real-origin', block: 100 }]);
    mockDiscovery.readPublicPswapNote.mockImplementation(async (id: string) =>
      id.startsWith('unrelated') ? { kind: 'absent' } : open(id)
    );

    let discovered = await findLiveGcSale(MIDEN_NETWORK_NAME.MAINNET);
    if (discovered === null) discovered = await findLiveGcSale(MIDEN_NETWORK_NAME.MAINNET);
    expect(discovered).toMatchObject({ saleNoteId: 'real-origin' });
  });

  it('keeps a buyer-created note with valid seller terms eligible', async () => {
    mockDiscovery.listCommittedNoteIdsByTag.mockResolvedValue([
      { noteId: 'buyer-remainder', block: 150 },
      { noteId: 'seller-origin', block: 100 }
    ]);
    mockDiscovery.readPublicPswapNote.mockImplementation(async (id: string) =>
      id === 'seller-origin' ? { kind: 'spent' } : open(id)
    );

    await expect(findLiveGcSale(MIDEN_NETWORK_NAME.MAINNET)).resolves.toMatchObject({ saleNoteId: 'buyer-remainder' });
  });
  it('revalidates a found sale while making progress through newer unrelated notes', async () => {
    mockDiscovery.listCommittedNoteIdsByTag.mockResolvedValue([{ noteId: 'live', block: 100 }]);
    mockDiscovery.readPublicPswapNote.mockImplementation(async (id: string) => open(id));
    expect(await findLiveGcSale()).toMatchObject({ saleNoteId: 'live' });
    mockDiscovery.readChainTip.mockResolvedValue(1_001);
    mockDiscovery.listCommittedNoteIdsByTag.mockResolvedValue([
      ...Array.from({ length: 20 }, (_, i) => ({ noteId: `noise-${i}`, block: 1_001 })),
      { noteId: 'live', block: 100 }
    ]);
    mockDiscovery.readPublicPswapNote.mockClear();
    mockDiscovery.readPublicPswapNote.mockImplementation(async (id: string) =>
      id === 'live' ? open(id) : { kind: 'absent' }
    );
    expect(await findLiveGcSale()).toMatchObject({ saleNoteId: 'live' });
    expect(mockDiscovery.readPublicPswapNote.mock.calls.length).toBeLessThanOrEqual(8);
    expect(mockDiscovery.readPublicPswapNote).toHaveBeenCalledWith('live', 'gc-sale-root');
  });

  it('finds a spent sale successor while historical noise remains', async () => {
    mockDiscovery.listCommittedNoteIdsByTag.mockResolvedValue([
      { noteId: 'live', block: 1_000 },
      ...Array.from({ length: 100 }, (_, i) => ({ noteId: `old-${i}`, block: 900 - i }))
    ]);
    mockDiscovery.readPublicPswapNote.mockImplementation(async (id: string) =>
      id === 'live' ? open(id) : { kind: 'absent' }
    );
    await findLiveGcSale();
    mockDiscovery.readChainTip.mockResolvedValue(1_002);
    mockDiscovery.listCommittedNoteIdsByTag.mockResolvedValue([
      { noteId: 'successor', block: 1_002 },
      { noteId: 'live', block: 1_000 }
    ]);
    mockDiscovery.readPublicPswapNote.mockImplementation(async (id: string) =>
      id === 'live' ? { kind: 'spent' } : open(id)
    );
    expect(await findLiveGcSale()).toMatchObject({ saleNoteId: 'successor' });
  });

  it('shares concurrent discovery and retries a rejected candidate without skipping it', async () => {
    mockDiscovery.listCommittedNoteIdsByTag.mockResolvedValue([{ noteId: 'live', block: 100 }]);
    mockDiscovery.readPublicPswapNote.mockRejectedValueOnce(new Error('node unavailable'));
    const first = findGcSales();
    expect(findGcSales()).toBe(first);
    await expect(first).rejects.toThrow('node unavailable');
    mockDiscovery.readPublicPswapNote.mockResolvedValue(open('live'));
    expect(await findLiveGcSale()).toMatchObject({ saleNoteId: 'live' });
  });

  it('does not publish a result after the sale is disabled during an RPC', async () => {
    let release!: (value: { noteId: string; block: number }[]) => void;
    mockDiscovery.listCommittedNoteIdsByTag.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = resolve;
        })
    );
    const finding = findLiveGcSale();
    await Promise.resolve();
    mockSnapshot = documentWith({ arcadeGcPurchase: false });
    release([{ noteId: 'old-sale', block: 100 }]);
    expect(await finding).toBeNull();
    expect(mockDiscovery.readPublicPswapNote).not.toHaveBeenCalled();
  });
});
