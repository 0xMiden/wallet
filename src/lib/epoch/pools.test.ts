import { keccak256, toBytes } from 'viem';

import type { EarnVaultConfig } from 'lib/remote-config/schema';

import { EARN_LENDER_FAMILY_NAMES, earnLenderFamily, earnMarketForVault, earnVaultTakesDeposits } from './pools';
import {
  EARN_POOLS_MAX_PAGES,
  EARN_POOLS_PAGE_SIZE,
  type EarnVaultInfo,
  type EarnVaultRoute,
  readEarnVaults
} from './pools-read';
import {
  AAVE_V3_LISTING,
  AAVE_V3_USDC,
  BASE_CHAIN_ID,
  BASE_EARN_VAULTS,
  BASE_USDC,
  COMPOUND_V3_LISTING,
  COMPOUND_V3_USDC,
  EULER_V2_USDC,
  listingFor,
  MORPHO_UNIBTC_LISTING,
  MORPHO_UNIBTC_USDC,
  MORPHO_USDC_COLLATERAL,
  poolsPage
} from './testing/pools-fixtures';

const POSITIONS_URL = 'https://positions.test';
/** The Base route, with the document listing `listed`: the Aave V3 market alone unless a test names more. */
const route = (...listed: EarnVaultConfig[]) => ({
  positionsUrl: POSITIONS_URL,
  chainId: BASE_CHAIN_ID,
  underlying: BASE_USDC,
  listed: listed.length > 0 ? listed : [AAVE_V3_LISTING]
});
const ROUTE = route();
const ZERO_ACCOUNT = '0x0000000000000000000000000000000000000000';
// The dummy lender on the Base route, as the positions fallback names it.
const DUMMY_LISTING = listingFor(
  { marketUid: `DUMMY_LENDING:${BASE_CHAIN_ID}:${BASE_USDC}` },
  'dummy-lending-base-usdc',
  'Dummy Lending USDC',
  { protocol: 'dummy-lending' }
);

type Answer = { ok: boolean; status: number; json: () => Promise<unknown> };
const answer = (body: unknown, status = 200): Answer => ({ ok: status < 400, status, json: async () => body });
const notJson = (): Answer => ({
  ok: true,
  status: 200,
  json: async () => {
    throw new SyntaxError('Unexpected token < in JSON');
  }
});

/** Answers `/pools` with `pools(start)` and `/positions` with `positions`, by URL. */
function serve(pools: (start: number) => Answer, positions: () => Answer = () => answer(null, 404)) {
  const fetchMock = jest.fn();
  fetchMock.mockImplementation(async (url: string) => {
    const parsed = new URL(url);
    switch (parsed.pathname) {
      case '/pools':
        return pools(Number(parsed.searchParams.get('start')));
      case '/positions':
        return positions();
      default:
        return answer(null, 404);
    }
  });
  global.fetch = fetchMock;
  return fetchMock;
}

/** Makes every request run `run`. */
function serveEvery(run: (url: string, init?: { signal?: AbortSignal }) => Promise<Answer>) {
  const fetchMock = jest.fn();
  fetchMock.mockImplementation(run);
  global.fetch = fetchMock;
  return fetchMock;
}

const requestedUrls = (fetchMock: jest.Mock) => fetchMock.mock.calls.map(([url]) => String(url));

// The same bound as one positions request.
const REQUEST_TIMEOUT_MS = 15_000;

/** Reads the catalogue of `route` over the global fetch, as the bridge-config derivation does over its own. */
const readVaults = (route: EarnVaultRoute) =>
  readEarnVaults((url, init) => fetch(url, init), route, REQUEST_TIMEOUT_MS);

/** A read that served `vaults` from `source` and dropped nothing. */
const served = (vaults: EarnVaultInfo[], source: 'pools' | 'positions' = 'pools') => ({
  vaults,
  source,
  droppedMarketUids: [],
  droppedUnkeyed: false
});

// The zero account's positions answer on the testnet host, which has no /pools route.
const positionsCatalogItem = (lenderKey: string, chainId = String(BASE_CHAIN_ID), depositApr = 2) => ({
  lender: lenderKey,
  chainId,
  aprData: { apr: depositApr, depositApr, borrowApr: 0 },
  data: [{ positions: [] }],
  lenderInfo: { lenderKey, name: lenderKey === 'DUMMY_LENDING' ? 'Dummy Lending' : lenderKey, logoUri: '' }
});

beforeEach(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('earnLenderFamily', () => {
  it.each([
    ['AAVE_V3', 'AAVE_V3'],
    ['COMPOUND_V3_USDC', 'COMPOUND_V3'],
    [MORPHO_UNIBTC_USDC.lenderKey, 'MORPHO_BLUE'],
    ['DUMMY_LENDING', 'DUMMY_LENDING']
  ])('reads %s as %s', (lenderKey, family) => {
    expect(earnLenderFamily(lenderKey)).toBe(family);
  });

  it.each(['EULER_V2', 'AAVE_V4_17905DB0E4A3514467539956C084180616AE7B8D', 'AAVE_V30', 'dummy-lending', 'VENUS', ''])(
    'reads %p as no family',
    lenderKey => {
      expect(earnLenderFamily(lenderKey)).toBeUndefined();
    }
  );

  it('names every family', () => {
    expect(EARN_LENDER_FAMILY_NAMES).toEqual({
      AAVE_V3: 'Aave V3',
      COMPOUND_V3: 'Compound V3',
      MORPHO_BLUE: 'Morpho',
      DUMMY_LENDING: 'Dummy Lending'
    });
  });
});

describe('readEarnVaults from /pools', () => {
  it('requests the route chain and token, and maps a market with every field', async () => {
    const fetchMock = serve(() => answer(poolsPage([AAVE_V3_USDC])));

    const result = await readVaults(ROUTE);

    const [url] = requestedUrls(fetchMock);
    const query = new URL(url ?? '').searchParams;
    expect(url?.startsWith(`${POSITIONS_URL}/pools?`)).toBe(true);
    expect(Object.fromEntries(query)).toEqual({
      chainId: '8453',
      underlyings: BASE_USDC,
      count: String(EARN_POOLS_PAGE_SIZE),
      start: '0',
      sortBy: 'depositRate',
      sortDir: 'DESC'
    });
    expect(result).toEqual({
      source: 'pools',
      droppedMarketUids: [],
      droppedUnkeyed: false,
      vaults: [
        {
          marketUid: 'AAVE_V3:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
          lenderKey: 'AAVE_V3',
          lenderFamily: 'AAVE_V3',
          lenderName: 'Aave V3',
          marketName: 'Aave V3 USDC',
          logoUri: 'https://raw.githubusercontent.com/1delta-DAO/protocol-icons/main/lender/aave_v3.webp',
          chainId: '8453',
          underlying: { address: BASE_USDC, symbol: 'USDC', decimals: 6 },
          depositApr: 3.75454844,
          aprTotal: 5.201192000000001,
          totalDepositsUsd: 195048766.62868062,
          totalLiquidityUsd: 21638659.032707438,
          utilization: 0.8890630186278784,
          risk: { score: 2, label: 'low' },
          canOpen: true,
          about: AAVE_V3_USDC.termSheet.supply.description,
          listing: AAVE_V3_LISTING
        }
      ]
    });
  });

  it("keeps only the listed markets, in the list's order, whatever their rate", async () => {
    serve(() =>
      answer(poolsPage([MORPHO_UNIBTC_USDC, EULER_V2_USDC, MORPHO_USDC_COLLATERAL, COMPOUND_V3_USDC, AAVE_V3_USDC]))
    );

    const { vaults } = await readVaults(route(...BASE_EARN_VAULTS));

    // The list decides, so a market that pays nothing is offered when it is listed, and Euler is not.
    expect(vaults.map(vault => [vault.listing.id, vault.lenderFamily, vault.aprTotal])).toEqual([
      ['aave-v3-base-usdc', 'AAVE_V3', 5.201192000000001],
      ['compound-v3-base-usdc', 'COMPOUND_V3', 5.38416446],
      ['morpho-unibtc-base-usdc', 'MORPHO_BLUE', 38.08331468],
      ['morpho-mxnb-base-usdc', 'MORPHO_BLUE', 0]
    ]);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('offers a listed market of a lender outside the known families', async () => {
    // Euler's uid names its vault, not the token, so it is listed and read only as a market of that token.
    const eulerOnUsdc = {
      ...EULER_V2_USDC,
      marketUid: `${EULER_V2_USDC.lenderKey}:${BASE_CHAIN_ID}:${BASE_USDC.toLowerCase()}`
    };
    serve(() => answer(poolsPage([eulerOnUsdc])));

    const { vaults } = await readVaults(route(listingFor(eulerOnUsdc, 'euler-v2-base-usdc', 'Euler USDC')));

    expect(vaults).toHaveLength(1);
    expect(vaults[0]?.lenderKey).toBe('EULER_V2');
    expect(vaults[0]).not.toHaveProperty('lenderFamily');
  });

  it('drops and logs a listed vault the catalogue does not serve', async () => {
    serve(() => answer(poolsPage([AAVE_V3_USDC, EULER_V2_USDC])));

    const result = await readVaults(route(AAVE_V3_LISTING, COMPOUND_V3_LISTING));

    expect(result.vaults.map(vault => vault.listing.id)).toEqual(['aave-v3-base-usdc']);
    expect(result.droppedMarketUids).toEqual([COMPOUND_V3_LISTING.marketUid]);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('makes no request and gives no vault when the document lists none on the route', async () => {
    const fetchMock = serve(() => answer(poolsPage([AAVE_V3_USDC])));
    const otherChain = listingFor({ marketUid: `AAVE_V3:1:${BASE_USDC}` }, 'aave-v3-ethereum-usdc', 'Aave V3 USDC');

    expect(await readVaults(route(otherChain))).toEqual(served([]));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips a market of another chain or token, and keeps one listed twice once', async () => {
    const otherChain = {
      ...COMPOUND_V3_USDC,
      chainId: '1',
      marketUid: `COMPOUND_V3_USDC:1:${BASE_USDC.toLowerCase()}`
    };
    const otherToken = {
      ...COMPOUND_V3_USDC,
      marketUid: 'COMPOUND_V3_USDC:8453:0x4200000000000000000000000000000000000006',
      underlyingInfo: {
        ...COMPOUND_V3_USDC.underlyingInfo,
        asset: { ...COMPOUND_V3_USDC.underlyingInfo.asset, address: '0x4200000000000000000000000000000000000006' }
      }
    };
    serve(() => answer(poolsPage([otherChain, otherToken, AAVE_V3_USDC, AAVE_V3_USDC])));

    const result = await readVaults(ROUTE);

    expect(result.vaults.map(vault => vault.lenderKey)).toEqual(['AAVE_V3']);
    expect(result.droppedMarketUids).toEqual([]);
  });

  it('matches the route token in any case', async () => {
    serve(() => answer(poolsPage([AAVE_V3_USDC])));

    const { vaults } = await readVaults({ ...ROUTE, underlying: BASE_USDC.toLowerCase() });

    expect(vaults).toHaveLength(1);
  });

  it('takes the deposit rate as the total APR when the term sheet has none', async () => {
    const { termSheet: _termSheet, ...noTermSheet } = COMPOUND_V3_USDC;
    const noAprTotal = {
      ...AAVE_V3_USDC,
      termSheet: { supply: { ...AAVE_V3_USDC.termSheet.supply, aprTotal: '5.2' } }
    };
    serve(() => answer(poolsPage([noTermSheet, noAprTotal])));

    const { vaults } = await readVaults(route(AAVE_V3_LISTING, COMPOUND_V3_LISTING));

    expect(vaults.map(vault => [vault.lenderKey, vault.aprTotal, vault.canOpen, vault.about])).toEqual([
      ['AAVE_V3', 3.75454844, true, AAVE_V3_USDC.termSheet.supply.description],
      ['COMPOUND_V3_USDC', 5.38416446, true, undefined]
    ]);
  });

  it.each([
    ['inactive', { flags: { ...AAVE_V3_USDC.flags, isActive: false } }],
    ['frozen', { flags: { ...AAVE_V3_USDC.flags, isFrozen: true } }],
    ['closed to deposits', { flags: { ...AAVE_V3_USDC.flags, depositsEnabled: false } }],
    ['without flags', { flags: null }],
    ['closed by its term sheet', { termSheet: { supply: { ...AAVE_V3_USDC.termSheet.supply, canOpen: false } } }]
  ])('reads a market that is %s as one that takes no deposit', async (_label, change) => {
    serve(() => answer(poolsPage([{ ...AAVE_V3_USDC, ...change }])));

    const { vaults } = await readVaults(ROUTE);

    expect(vaults).toEqual([expect.objectContaining({ lenderKey: 'AAVE_V3', canOpen: false })]);
  });

  it('leaves out the optional figures it cannot read, and a logo that is not a string', async () => {
    serve(() =>
      answer(
        poolsPage([
          {
            ...AAVE_V3_USDC,
            totalDepositsUsd: '195048766.6',
            totalLiquidityUsd: null,
            utilization: undefined,
            risk: { score: 2 },
            lenderInfo: { ...AAVE_V3_USDC.lenderInfo, logoURI: null },
            name: null
          }
        ])
      )
    );

    const [vault] = (await readVaults(ROUTE)).vaults;

    expect(vault).toBeDefined();
    expect(vault).not.toHaveProperty('totalDepositsUsd');
    expect(vault).not.toHaveProperty('totalLiquidityUsd');
    expect(vault).not.toHaveProperty('utilization');
    expect(vault).not.toHaveProperty('risk');
    expect(vault?.logoUri).toBe('');
    expect(vault?.marketName).toBe('Aave V3');
  });

  it('drops and logs a malformed market, keeps the others and names the dropped uids', async () => {
    const stringRate = { ...COMPOUND_V3_USDC, depositRate: '5.38' };
    const noLenderName = { ...MORPHO_UNIBTC_USDC, lenderInfo: { key: MORPHO_UNIBTC_USDC.lenderKey } };
    const fractionalDecimals = {
      ...MORPHO_USDC_COLLATERAL,
      underlyingInfo: {
        ...MORPHO_USDC_COLLATERAL.underlyingInfo,
        asset: { ...MORPHO_USDC_COLLATERAL.underlyingInfo.asset, decimals: 6.5 }
      }
    };
    serve(() => answer(poolsPage([stringRate, noLenderName, fractionalDecimals, AAVE_V3_USDC])));

    const result = await readVaults(route(...BASE_EARN_VAULTS));

    expect(result.vaults.map(vault => vault.lenderKey)).toEqual(['AAVE_V3']);
    expect(result.droppedMarketUids).toEqual(
      [COMPOUND_V3_USDC, MORPHO_UNIBTC_USDC, MORPHO_USDC_COLLATERAL].map(item => item.marketUid.toLowerCase())
    );
    expect(result.droppedUnkeyed).toBe(false);
    expect(console.warn).toHaveBeenCalledTimes(3);
  });

  it('drops a market whose uid names another market, and says when a dropped item had no uid', async () => {
    const wrongUid = { ...COMPOUND_V3_USDC, marketUid: `AAVE_V3:8453:${BASE_USDC.toLowerCase()}` };
    const { marketUid: _marketUid, ...noUid } = MORPHO_UNIBTC_USDC;
    serve(() => answer(poolsPage([wrongUid, null, noUid])));

    const result = await readVaults(route(AAVE_V3_LISTING, MORPHO_UNIBTC_LISTING));

    expect(result.vaults).toEqual([]);
    // An item with no uid of its own is listed by the market its lender, chain and token make.
    expect(result.droppedMarketUids).toEqual([AAVE_V3_LISTING.marketUid, MORPHO_UNIBTC_LISTING.marketUid]);
    expect(result.droppedUnkeyed).toBe(true);
  });

  it('reads a uid that another item of the same market misnamed as a vault the read has', async () => {
    const wrongUid = { ...COMPOUND_V3_USDC, marketUid: `AAVE_V3:8453:${BASE_USDC.toLowerCase()}` };
    serve(() => answer(poolsPage([wrongUid, AAVE_V3_USDC])));

    const result = await readVaults(ROUTE);

    expect(result.vaults.map(vault => vault.lenderKey)).toEqual(['AAVE_V3']);
    expect(result.droppedMarketUids).toEqual([]);
  });

  it('reads the next page while a page is full, and stops after a short page', async () => {
    const fullPage = Array.from({ length: EARN_POOLS_PAGE_SIZE }, () => EULER_V2_USDC);
    const fetchMock = serve(start => answer(poolsPage(start === 0 ? fullPage : [AAVE_V3_USDC], start)));

    const { vaults } = await readVaults(ROUTE);

    expect(requestedUrls(fetchMock).map(url => new URL(url).searchParams.get('start'))).toEqual(['0', '200']);
    expect(vaults.map(vault => vault.lenderKey)).toEqual(['AAVE_V3']);
  });

  it(`reads at most ${EARN_POOLS_MAX_PAGES} pages`, async () => {
    const fullPage = Array.from({ length: EARN_POOLS_PAGE_SIZE }, () => AAVE_V3_USDC);
    const fetchMock = serve(start => answer(poolsPage(fullPage, start)));

    const { vaults } = await readVaults(ROUTE);

    expect(fetchMock).toHaveBeenCalledTimes(EARN_POOLS_MAX_PAGES);
    expect(requestedUrls(fetchMock).map(url => new URL(url).searchParams.get('start'))).toEqual([
      '0',
      '200',
      '400',
      '600',
      '800'
    ]);
    expect(vaults).toHaveLength(1);
  });

  it('fails the read when a later page fails, with no fallback', async () => {
    const fullPage = Array.from({ length: EARN_POOLS_PAGE_SIZE }, () => AAVE_V3_USDC);
    const fetchMock = serve(start => (start === 0 ? answer(poolsPage(fullPage)) : answer(null, 502)));

    await expect(readVaults(ROUTE)).rejects.toThrow('Epoch pools page 2 failed');
    expect(requestedUrls(fetchMock).map(url => new URL(url).pathname)).toEqual(['/pools', '/pools']);
  });

  it('fails the read on a network error, with no fallback', async () => {
    const fetchMock = serveEvery(async () => {
      throw new TypeError('Failed to fetch');
    });

    await expect(readVaults(ROUTE)).rejects.toThrow('Failed to fetch');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails a page that stalls at 15 s', async () => {
    jest.useFakeTimers();
    serveEvery(
      (_url, init) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)))
    );
    try {
      let failure: unknown;
      const read = readVaults(ROUTE).catch((error: unknown) => {
        failure = error;
      });

      await jest.advanceTimersByTimeAsync(14_999);
      expect(failure).toBeUndefined();
      await jest.advanceTimersByTimeAsync(1);
      await read;

      expect(failure).toEqual(new Error('Request timed out after 15000 ms'));
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('readEarnVaults on a host with no /pools route', () => {
  it("reads the zero account's positions after a 404", async () => {
    const pools = () => answer('Cannot GET /pools', 404);
    const fetchMock = serve(pools, () =>
      answer({
        success: true,
        data: {
          items: [
            positionsCatalogItem('DUMMY_LENDING'),
            positionsCatalogItem('EULER_V2'),
            positionsCatalogItem('AAVE_V3', '1')
          ]
        }
      })
    );

    const result = await readVaults(route(DUMMY_LISTING));

    expect(requestedUrls(fetchMock)).toEqual([
      expect.stringContaining(`${POSITIONS_URL}/pools?`),
      `${POSITIONS_URL}/positions?account=${ZERO_ACCOUNT}&chains=${BASE_CHAIN_ID}`
    ]);
    const expected: EarnVaultInfo = {
      marketUid: `DUMMY_LENDING:8453:${BASE_USDC.toLowerCase()}`,
      lenderKey: 'DUMMY_LENDING',
      lenderFamily: 'DUMMY_LENDING',
      lenderName: 'Dummy Lending',
      marketName: 'Dummy Lending',
      logoUri: '',
      chainId: '8453',
      underlying: { address: BASE_USDC, symbol: 'USDC', decimals: 6 },
      depositApr: 2,
      aprTotal: 2,
      canOpen: true,
      listing: DUMMY_LISTING
    };
    expect(result).toEqual(served([expected], 'positions'));
  });

  it.each([
    ['a 503 response', () => answer(null, 503)],
    ['a body that is not JSON', notJson],
    ['an unsuccessful envelope', () => answer({ success: false, error: 'unknown route' })],
    ['an envelope with no items', () => answer({ success: true, data: { items: null } })]
  ])('does not fall back after %s', async (_label, pools) => {
    const fetchMock = serve(pools, () =>
      answer({ success: true, data: { items: [positionsCatalogItem('DUMMY_LENDING')] } })
    );

    await expect(readVaults(route(DUMMY_LISTING))).rejects.toThrow();
    expect(requestedUrls(fetchMock)).toEqual([expect.stringContaining(`${POSITIONS_URL}/pools?`)]);
  });

  it('gives the underlying the symbol and decimals the caller names', async () => {
    serve(
      () => answer(null, 404),
      () => answer({ success: true, data: { items: [positionsCatalogItem('DUMMY_LENDING')] } })
    );

    const { vaults } = await readVaults({
      ...route(DUMMY_LISTING),
      fallbackUnderlying: { symbol: 'USDC', decimals: 18 }
    });

    expect(vaults[0]?.underlying).toEqual({ address: BASE_USDC, symbol: 'USDC', decimals: 18 });
  });

  it('drops a positions item it cannot read and keeps the others', async () => {
    serve(
      () => answer(null, 404),
      () =>
        answer({
          success: true,
          data: {
            items: [
              { ...positionsCatalogItem('AAVE_V3'), aprData: {} },
              null,
              positionsCatalogItem('DUMMY_LENDING', String(BASE_CHAIN_ID), 1)
            ]
          }
        })
    );

    const result = await readVaults(route(AAVE_V3_LISTING, DUMMY_LISTING));

    expect(result.vaults.map(vault => vault.lenderKey)).toEqual(['DUMMY_LENDING']);
    expect(result.droppedMarketUids).toEqual([`aave_v3:8453:${BASE_USDC.toLowerCase()}`]);
    expect(result.droppedUnkeyed).toBe(true);
  });

  it('fails the read when the fallback fails too', async () => {
    serve(
      () => answer(null, 404),
      () => answer(null, 503)
    );

    await expect(readVaults(ROUTE)).rejects.toThrow('Remote JSON request failed with HTTP 503');
  });

  it('fails the read when the fallback answers no envelope', async () => {
    serve(
      () => answer(null, 404),
      () => answer({ success: true })
    );

    await expect(readVaults(ROUTE)).rejects.toThrow('Epoch positions catalogue response is invalid');
  });
});

describe('earnMarketForVault', () => {
  it("names the vault's uid, its listed protocol's hash, the checksummed token and the numeric chain", async () => {
    serve(() => answer(poolsPage([MORPHO_UNIBTC_USDC])));
    const [vault] = (await readVaults(route(MORPHO_UNIBTC_LISTING))).vaults;
    if (!vault) throw new Error('no vault');
    const lowercaseUsdc: `0x${string}` = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

    expect(earnMarketForVault({ ...vault, underlying: { ...vault.underlying, address: lowercaseUsdc } })).toEqual({
      marketUid: `${MORPHO_UNIBTC_USDC.lenderKey}:8453:${lowercaseUsdc}`,
      protocolHash: keccak256(toBytes('1delta')),
      underlying: BASE_USDC,
      chainId: 8453
    });
  });

  it('keeps the testnet hash for the dummy lender', () => {
    const market = earnMarketForVault({
      marketUid: 'DUMMY_LENDING:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
      lenderKey: 'DUMMY_LENDING',
      lenderFamily: 'DUMMY_LENDING',
      lenderName: 'Dummy Lending',
      marketName: 'Dummy Lending',
      logoUri: '',
      chainId: '11155111',
      underlying: { address: '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69', symbol: 'USDC', decimals: 18 },
      depositApr: 2,
      aprTotal: 2,
      canOpen: true,
      listing: { ...DUMMY_LISTING, marketUid: 'dummy_lending:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69' }
    });

    expect(market).toEqual({
      marketUid: 'DUMMY_LENDING:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
      protocolHash: '0x7a2ccf6fa10307c054284131a341a8d8cbd10ec7d3cc469fbf369c40fd86d0f9',
      underlying: '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69',
      chainId: 11155111
    });
  });
});

describe('earnVaultTakesDeposits', () => {
  it('takes a deposit only while the catalogue opens the vault and the document keeps its deposits on', async () => {
    serve(() => answer(poolsPage([AAVE_V3_USDC])));
    const [vault] = (await readVaults(ROUTE)).vaults;
    if (!vault) throw new Error('no vault');

    expect(earnVaultTakesDeposits(vault)).toBe(true);
    expect(earnVaultTakesDeposits({ ...vault, canOpen: false })).toBe(false);
    expect(earnVaultTakesDeposits({ ...vault, listing: { ...vault.listing, depositsEnabled: false } })).toBe(false);
  });
});
