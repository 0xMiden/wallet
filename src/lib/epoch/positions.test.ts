import { getEarnVaults, getEpochPositionsUrl } from 'lib/remote-config/values';

import {
  carryForward,
  EARN_CATALOG_ERROR_OWNER,
  type EarnPosition,
  type EarnPositionsResult,
  type EarnVaultInfo,
  fetchEarnPositions,
  getEarnDepositEvmAddresses
} from './positions';
import { TEST_EARN_MARKET, TEST_EARN_VAULT, TEST_POSITIONS_URL } from './testing/bridge-config';
import { AAVE_V3_USDC, listingFor, poolsPage } from './testing/pools-fixtures';

jest.mock('lib/remote-config/values', () =>
  jest.requireActual<typeof import('./testing/bridge-config')>('./testing/bridge-config').remoteConfigValuesMock()
);
jest.mock('lib/miden/repo', () => ({
  transactions: { filter: jest.fn() }
}));

// The document lists the Aave V3 market of the test route first, then the dummy lender's.
const AAVE_LISTING = listingFor(
  { marketUid: 'AAVE_V3:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69' },
  'aave-v3-sepolia-usdc',
  'Aave V3 USDC'
);
beforeEach(() => {
  jest.mocked(getEarnVaults).mockReturnValue([AAVE_LISTING, TEST_EARN_VAULT]);
});

const OWNER = '0x1111111111111111111111111111111111111111';
const OTHER_OWNER = '0x2222222222222222222222222222222222222222';
const ZERO_ACCOUNT = '0x0000000000000000000000000000000000000000';
const SEPOLIA_USDC = '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69';
const DUMMY_UID = 'DUMMY_LENDING:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69';
const AAVE_UID = 'AAVE_V3:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69';

/** A `/pools` market of `lenderKey` on the test route (Sepolia USDC), shaped as the mainnet host serves one. */
function sepoliaPool(lenderKey: string, name: string, aprTotal: number) {
  const address = SEPOLIA_USDC.toLowerCase();
  return {
    ...AAVE_V3_USDC,
    marketUid: `${lenderKey}:11155111:${address}`,
    chainId: '11155111',
    lenderKey,
    name,
    depositRate: aprTotal,
    lenderInfo: { key: lenderKey, name, logoURI: '' },
    underlyingInfo: {
      ...AAVE_V3_USDC.underlyingInfo,
      asset: { ...AAVE_V3_USDC.underlyingInfo.asset, chainId: '11155111', address, decimals: 18 }
    },
    termSheet: { supply: { ...AAVE_V3_USDC.termSheet.supply, aprTotal } }
  };
}

/** One chain item of a positions answer: `lenderKey`'s positions in `marketUid`. */
function apiItem(deposits = '0', depositsUSD = 0, lenderKey = 'DUMMY_LENDING', marketUid = DUMMY_UID) {
  return {
    lender: lenderKey,
    chainId: '11155111',
    aprData: { apr: 2, depositApr: 2, borrowApr: 3 },
    lenderInfo: { lenderKey, name: lenderKey === 'DUMMY_LENDING' ? 'Dummy Lending' : lenderKey, logoUri: '' },
    data: [
      {
        positions: [
          {
            marketUid,
            deposits,
            debt: '0',
            depositsUSD,
            withdrawable: deposits,
            collateralEnabled: false,
            underlyingInfo: {
              asset: {
                name: 'USD Coin',
                symbol: 'USDC',
                address: SEPOLIA_USDC,
                chainId: '11155111',
                logoURI: null,
                decimals: 6,
                assetGroup: 'USDC'
              },
              prices: { priceUsd: 1 }
            }
          }
        ]
      }
    ]
  };
}

type Answer = { ok: boolean; status: number; json: () => Promise<unknown> };
const answer = (body: unknown, status = 200): Answer => ({ ok: status < 400, status, json: async () => body });
const positionsAnswer = (items: unknown) => answer({ success: true, data: { items } });

interface Routes {
  /** The `/pools` answer. By default the Dummy and Aave markets of the test route. */
  pools?: () => Answer | Promise<Answer>;
  /** The zero account's positions, the catalogue fallback. */
  catalog?: () => Answer;
  /** One owner's positions. */
  owner?: (owner: string, init?: { signal?: AbortSignal }) => Answer | Promise<Answer>;
}

function serve(routes: Routes = {}) {
  const fetchMock = jest.fn();
  fetchMock.mockImplementation(async (url: string, init?: { signal?: AbortSignal }) => {
    const parsed = new URL(url);
    const account = parsed.searchParams.get('account') ?? '';
    switch (parsed.pathname) {
      case '/pools':
        return (
          routes.pools?.() ??
          answer(poolsPage([sepoliaPool('AAVE_V3', 'Aave V3', 5), sepoliaPool('DUMMY_LENDING', 'Dummy Lending', 2)]))
        );
      case '/positions':
        if (account === ZERO_ACCOUNT) return routes.catalog?.() ?? answer(null, 404);
        return routes.owner?.(account, init) ?? positionsAnswer([]);
      default:
        return answer(null, 404);
    }
  });
  global.fetch = fetchMock;
  return fetchMock;
}

const requestedPaths = (fetchMock: jest.Mock) =>
  fetchMock.mock.calls.map(([url]) => {
    const parsed = new URL(String(url));
    return `${parsed.pathname}${parsed.searchParams.has('account') ? `?account=${parsed.searchParams.get('account')}` : ''}`;
  });

describe('fetchEarnPositions', () => {
  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('loads the vault catalogue for a wallet with no EVM owners, with no positions request', async () => {
    const fetchMock = serve();

    const result = await fetchEarnPositions({ owners: [] });

    expect(requestedPaths(fetchMock)).toEqual(['/pools']);
    const query = new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams;
    expect(query.get('chainId')).toBe('11155111');
    expect(query.get('underlyings')).toBe(TEST_EARN_MARKET.underlying);
    expect(result.owners).toEqual([]);
    expect(result.positions).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.vaults.map(vault => [vault.marketUid, vault.aprTotal])).toEqual([
      [AAVE_UID, 5],
      [DUMMY_UID, 2]
    ]);
  });

  it('reads the positions host and the market chain the config names', async () => {
    const fetchMock = serve();

    await fetchEarnPositions({ owners: [OWNER] });

    expect(fetchMock).toHaveBeenCalledWith(`${TEST_POSITIONS_URL}/positions?account=${OWNER}&chains=11155111`, {
      signal: expect.any(AbortSignal)
    });
    expect(requestedPaths(fetchMock).sort()).toEqual(['/pools', `/positions?account=${OWNER}`]);
  });

  it('rejects before any request while the config names no positions host', async () => {
    const fetchMock = serve();
    jest.mocked(getEpochPositionsUrl).mockImplementationOnce(() => {
      throw new Error('no positions host');
    });

    await expect(fetchEarnPositions({ owners: [OWNER] })).rejects.toThrow('no positions host');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps funded positions and preserves withdrawal inputs', async () => {
    serve({ owner: () => positionsAnswer([apiItem('12.5', 12.5)]) });

    const result = await fetchEarnPositions({ owners: [OWNER] });

    expect(result.totalDepositsUSD).toBe(12.5);
    expect(result.positions).toEqual([
      {
        owner: OWNER,
        marketUid: DUMMY_UID,
        lenderKey: 'DUMMY_LENDING',
        lenderName: 'Dummy Lending',
        chainId: '11155111',
        deposits: '12.5',
        withdrawable: '12.5',
        depositsUSD: 12.5,
        depositApr: 2,
        symbol: 'USDC',
        underlyingAddress: SEPOLIA_USDC,
        decimals: 6,
        priceUsd: 1
      }
    ]);
  });

  it('keeps the funded positions of every catalogue market, matching the uid in any case', async () => {
    serve({
      owner: () =>
        positionsAnswer([
          apiItem('12.5', 12.5),
          apiItem('3', 3, 'AAVE_V3', `AAVE_V3:11155111:${SEPOLIA_USDC}`),
          apiItem('0', 0, 'AAVE_V3', AAVE_UID)
        ])
    });

    const result = await fetchEarnPositions({ owners: [OWNER] });

    expect(result.positions.map(position => [position.marketUid, position.deposits])).toEqual([
      [DUMMY_UID, '12.5'],
      [`AAVE_V3:11155111:${SEPOLIA_USDC}`, '3']
    ]);
    expect(result.totalDepositsUSD).toBe(15.5);
  });

  it('leaves out a position in a market the catalogue does not list', async () => {
    serve({
      pools: () => answer(poolsPage([sepoliaPool('DUMMY_LENDING', 'Dummy Lending', 2)])),
      owner: () =>
        positionsAnswer([
          apiItem('12.5', 12.5),
          apiItem('3', 3, 'AAVE_V3', AAVE_UID),
          apiItem('4', 4, 'EULER_V2', 'EULER_V2:11155111:0x4c1aeda9b43efcf1da1d1755b18802aabe90f61e')
        ])
    });

    const result = await fetchEarnPositions({ owners: [OWNER] });

    expect(result.positions.map(position => position.marketUid)).toEqual([DUMMY_UID]);
  });

  it("reads the testnet catalogue from the zero account's positions, where the host has no /pools route", async () => {
    const fetchMock = serve({
      pools: () => answer('Cannot GET /pools', 404),
      catalog: () => positionsAnswer([apiItem()]),
      owner: () => positionsAnswer([apiItem('12.5', 12.5)])
    });

    const result = await fetchEarnPositions({ owners: [OWNER] });

    expect(requestedPaths(fetchMock).sort()).toEqual([
      '/pools',
      `/positions?account=${ZERO_ACCOUNT}`,
      `/positions?account=${OWNER}`
    ]);
    expect(result.errors).toEqual([]);
    expect(result.vaults).toEqual([
      {
        marketUid: DUMMY_UID,
        lenderKey: 'DUMMY_LENDING',
        lenderFamily: 'DUMMY_LENDING',
        lenderName: 'Dummy Lending',
        marketName: 'Dummy Lending',
        logoUri: '',
        chainId: '11155111',
        // The symbol and decimals the config's read of the token gives.
        underlying: { address: SEPOLIA_USDC, symbol: 'USDC', decimals: 18 },
        depositApr: 2,
        aprTotal: 2,
        canOpen: true,
        listing: TEST_EARN_VAULT
      }
    ]);
    // The listed Aave market the fallback does not serve is reported, so an earlier read's copy is kept.
    expect(result.droppedVaultKeys).toEqual([AAVE_UID.toLowerCase()]);
    expect(result.positions).toEqual([expect.objectContaining({ owner: OWNER, marketUid: DUMMY_UID })]);
  });

  it('reports a failed catalogue read under its own label, and keeps the positions of supported markets', async () => {
    const fetchMock = serve({
      pools: () => answer(null, 503),
      catalog: () => answer(null, 503),
      owner: () =>
        positionsAnswer([
          apiItem('12.5', 12.5),
          apiItem('3', 3, 'AAVE_V3', AAVE_UID),
          apiItem('4', 4, 'EULER_V2', 'EULER_V2:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69'),
          apiItem('5', 5, 'AAVE_V3', 'AAVE_V3:84532:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69')
        ])
    });

    const result = await fetchEarnPositions({ owners: [OWNER] });

    expect(result.errors).toEqual([
      { owner: EARN_CATALOG_ERROR_OWNER, error: 'Remote JSON request failed with HTTP 503' }
    ]);
    expect(result.vaults).toEqual([]);
    expect(result.positions.map(position => position.marketUid)).toEqual([DUMMY_UID, AAVE_UID]);
    expect(requestedPaths(fetchMock)).toEqual(['/pools', `/positions?account=${OWNER}`]);
  });

  it('reads no catalogue when told to skip it, and keeps the positions of supported markets', async () => {
    const fetchMock = serve({
      owner: () => positionsAnswer([apiItem('12.5', 12.5), apiItem('3', 3, 'AAVE_V3', AAVE_UID)])
    });

    const result = await fetchEarnPositions({ owners: [OWNER], skipCatalog: true });

    expect(requestedPaths(fetchMock)).toEqual([`/positions?account=${OWNER}`]);
    expect(result.errors).toEqual([]);
    expect(result.vaults).toEqual([]);
    expect(result.positions.map(position => position.marketUid)).toEqual([DUMMY_UID, AAVE_UID]);
  });

  it('names the catalogue vaults a read dropped, and says when one had no uid', async () => {
    const malformed = { ...sepoliaPool('AAVE_V3', 'Aave V3', 5), depositRate: '5' };
    serve({ pools: () => answer(poolsPage([malformed, sepoliaPool('DUMMY_LENDING', 'Dummy Lending', 2)])) });
    const keyed = await fetchEarnPositions({ owners: [] });
    expect(keyed.vaults.map(vault => vault.marketUid)).toEqual([DUMMY_UID]);
    expect(keyed.droppedVaultKeys).toEqual([AAVE_UID.toLowerCase()]);
    expect(keyed.vaultDroppedUnkeyed).toBeUndefined();
    expect(keyed.errors).toEqual([]);

    serve({ pools: () => answer(poolsPage([null, sepoliaPool('DUMMY_LENDING', 'Dummy Lending', 2)])) });
    const unkeyed = await fetchEarnPositions({ owners: [] });
    expect(unkeyed.vaultDroppedUnkeyed).toBe(true);
    // No item served the listed Aave market.
    expect(unkeyed.droppedVaultKeys).toEqual([AAVE_UID.toLowerCase()]);

    serve();
    const clean = await fetchEarnPositions({ owners: [] });
    expect(clean.droppedVaultKeys).toBeUndefined();
    expect(clean.vaultDroppedUnkeyed).toBeUndefined();
  });

  it('isolates malformed and failed API responses as per-owner errors', async () => {
    serve({
      owner: owner => (owner === OTHER_OWNER ? answer(null, 429) : answer({ success: true, data: { items: null } }))
    });

    const result = await fetchEarnPositions({ owners: [OWNER, OTHER_OWNER] });

    expect(result.positions).toEqual([]);
    expect(result.errors).toEqual([
      { owner: OWNER, error: 'positions request unsuccessful' },
      { owner: OTHER_OWNER, error: 'positions request failed (429)' }
    ]);
    expect(result.vaults).toHaveLength(2);
  });

  it("settles an owner whose payload cannot be read as that owner's error, while the others load", async () => {
    // A readable item first, so keeping any of this owner's items would show here.
    const lackingLenderInfo = { ...apiItem('3', 3), lenderInfo: undefined };
    serve({
      owner: owner =>
        positionsAnswer(owner === OTHER_OWNER ? [apiItem('7', 7), lackingLenderInfo] : [apiItem('12.5', 12.5)])
    });

    const result = await fetchEarnPositions({ owners: [OTHER_OWNER, OWNER] });

    expect(result.errors).toEqual([{ owner: OTHER_OWNER, error: 'positions response unreadable' }]);
    expect(result.positions).toEqual([expect.objectContaining({ owner: OWNER, deposits: '12.5' })]);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining(`positions response unreadable for ${OTHER_OWNER}`),
      expect.any(Error)
    );
  });

  it("settles a funded position with no USD value as that owner's error", async () => {
    const funded = apiItem('3', 3);
    const noUsd = {
      ...funded,
      data: funded.data.map(group => ({ positions: group.positions.map(pos => ({ ...pos, depositsUSD: null })) }))
    };
    serve({ owner: owner => positionsAnswer(owner === OTHER_OWNER ? [noUsd] : [apiItem('12.5', 12.5)]) });

    const result = await fetchEarnPositions({ owners: [OTHER_OWNER, OWNER] });

    expect(result.errors).toEqual([{ owner: OTHER_OWNER, error: 'positions response unreadable' }]);
    expect(result.positions).toEqual([expect.objectContaining({ owner: OWNER, deposits: '12.5' })]);
    expect(result.totalDepositsUSD).toBe(12.5);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining(`positions response unreadable for ${OTHER_OWNER}`),
      expect.any(TypeError)
    );
  });

  it("settles an owner whose request stalls as that owner's error at 15 s, while the others load", async () => {
    jest.useFakeTimers();
    // A stalled request ends only when its signal aborts, as a real fetch does.
    serve({
      owner: (owner, init) =>
        owner === OTHER_OWNER
          ? new Promise((_resolve, reject) =>
              init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
            )
          : positionsAnswer([apiItem('12.5', 12.5)])
    });
    try {
      let settled = false;
      const read = fetchEarnPositions({ owners: [OWNER, OTHER_OWNER] }).finally(() => {
        settled = true;
      });

      await jest.advanceTimersByTimeAsync(14_999);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);

      const result = await read;
      expect(result.positions).toEqual([expect.objectContaining({ owner: OWNER, deposits: '12.5' })]);
      expect(result.errors).toEqual([{ owner: OTHER_OWNER, error: 'Request timed out after 15000 ms' }]);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('carryForward', () => {
  const position = (owner: string, depositsUSD: number): EarnPosition => ({
    owner,
    marketUid: DUMMY_UID,
    lenderKey: 'DUMMY_LENDING',
    lenderName: 'Dummy Lending',
    chainId: '11155111',
    deposits: String(depositsUSD),
    withdrawable: String(depositsUSD),
    depositsUSD,
    depositApr: 2,
    symbol: 'USDC',
    underlyingAddress: SEPOLIA_USDC,
    decimals: 6,
    priceUsd: 1
  });
  const vault = (lenderKey: string, aprTotal = 2): EarnVaultInfo => ({
    marketUid: `${lenderKey}:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69`,
    lenderKey,
    lenderFamily: 'MORPHO_BLUE',
    lenderName: lenderKey,
    marketName: 'Loan USDC',
    logoUri: '',
    chainId: '11155111',
    underlying: { address: SEPOLIA_USDC, symbol: 'USDC', decimals: 18 },
    depositApr: aprTotal,
    aprTotal,
    canOpen: true,
    listing: listingFor(
      { marketUid: `${lenderKey}:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69` },
      lenderKey.toLowerCase().replaceAll('_', '-'),
      lenderKey
    )
  });
  const uid = (lenderKey: string) => vault(lenderKey).marketUid.toLowerCase();
  const read = (over: Partial<EarnPositionsResult>): EarnPositionsResult => ({
    positions: [],
    vaults: [],
    totalDepositsUSD: 0,
    owners: [OWNER, OTHER_OWNER],
    errors: [],
    ...over
  });
  const catalogFailure = { owner: EARN_CATALOG_ERROR_OWNER, error: 'Remote JSON request failed with HTTP 503' };

  it("brings back a failed owner's positions, and no vault while the catalogue loaded", () => {
    const previous = read({
      positions: [position(OWNER, 5), position(OTHER_OWNER, 7)],
      vaults: [vault('MORPHO_BLUE_A', 1), vault('MORPHO_BLUE_B')],
      totalDepositsUSD: 12
    });
    const next = read({
      positions: [position(OWNER, 6)],
      vaults: [vault('MORPHO_BLUE_A')],
      totalDepositsUSD: 6,
      errors: [{ owner: OTHER_OWNER, error: 'positions request failed (429)' }]
    });

    const carried = carryForward(previous, next);

    // The owner that loaded shows this read's positions alone.
    expect(carried.positions).toEqual([position(OWNER, 6), position(OTHER_OWNER, 7)]);
    expect(carried.vaults).toEqual([vault('MORPHO_BLUE_A')]);
    expect(carried.totalDepositsUSD).toBe(13);
    expect(carried.owners).toBe(next.owners);
    expect(carried.errors).toBe(next.errors);
  });

  it('brings back every vault shown before when the catalogue read failed, in their earlier order', () => {
    const previous = read({
      positions: [position(OWNER, 5)],
      vaults: [vault('MORPHO_BLUE_A', 9), vault('MORPHO_BLUE_B', 3)],
      totalDepositsUSD: 5
    });
    const next = read({ positions: [position(OWNER, 6)], totalDepositsUSD: 6, errors: [catalogFailure] });

    const carried = carryForward(previous, next);

    expect(carried.vaults).toEqual([vault('MORPHO_BLUE_A', 9), vault('MORPHO_BLUE_B', 3)]);
    // The catalogue failure hides no position: this read's positions stand.
    expect(carried.positions).toEqual([position(OWNER, 6)]);
    expect(carried.totalDepositsUSD).toBe(6);
    expect(carried.errors).toBe(next.errors);
  });

  it('returns the read as it is when nothing failed, or nothing was loaded before', () => {
    const previous = read({ positions: [position(OTHER_OWNER, 7)], vaults: [vault('MORPHO_BLUE_B')] });
    const loaded = read({ positions: [position(OWNER, 6)], vaults: [vault('MORPHO_BLUE_A')], totalDepositsUSD: 6 });
    const failed = read({ errors: [catalogFailure] });

    expect(carryForward(previous, loaded)).toBe(loaded);
    expect(carryForward(undefined, failed)).toBe(failed);
  });

  describe('when a read that keeps one of three vaults dropped the second', () => {
    const [first, second, third] = [vault('MORPHO_BLUE_A', 9), vault('MORPHO_BLUE_B', 5), vault('MORPHO_BLUE_C', 1)];
    const previous = read({ vaults: [first, second, third] });
    const dropped = read({ vaults: [first], droppedVaultKeys: [uid('MORPHO_BLUE_B')] });

    it('brings back that vault alone, with no positions', () => {
      const carried = carryForward(previous, dropped);

      expect(carried.vaults).toEqual([first, second]);
      expect(carried.positions).toEqual([]);
    });

    it('brings back every vault the read lacks when a dropped vault had no key', () => {
      expect(carryForward(previous, { ...dropped, vaultDroppedUnkeyed: true }).vaults).toEqual([first, second, third]);
    });

    it('brings back only that vault when an owner failed', () => {
      const failed = { ...dropped, errors: [{ owner: OTHER_OWNER, error: 'positions request failed (429)' }] };

      expect(carryForward(previous, failed).vaults).toEqual([first, second]);
    });

    it('puts a vault it brings back at its earlier place in the list', () => {
      const loadedThird = read({ vaults: [third], droppedVaultKeys: [uid('MORPHO_BLUE_A')] });

      expect(carryForward(previous, loadedThird).vaults).toEqual([first, third]);
    });

    it('keeps the list order, not the rate order', () => {
      const [low, high] = [vault('MORPHO_BLUE_A', 1), vault('MORPHO_BLUE_B', 9)];
      const before = read({ vaults: [low, high] });
      const loadedHigh = read({ vaults: [high], droppedVaultKeys: [uid('MORPHO_BLUE_A')] });

      expect(carryForward(before, loadedHigh).vaults).toEqual([low, high]);
    });
  });
});

// Whatever comes back for these addresses is rendered as the user's OWN position
// and folded into their total deposits, so only a genuine deposit's recipient
// belongs in this list.
describe('getEarnDepositEvmAddresses', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    type: 'earn-deposit',
    accountId: 'acct-1',
    extraInputs: { evmRecipient: OWNER },
    ...over
  });

  const withRows = (rows: unknown[]) => {
    const Repo = jest.requireMock('lib/miden/repo');
    (Repo.transactions.filter as jest.Mock).mockImplementation((predicate: (r: unknown) => boolean) => ({
      toArray: async () => rows.filter(predicate)
    }));
  };

  it('collects the recipient of a genuine deposit', async () => {
    withRows([row()]);

    expect(await getEarnDepositEvmAddresses('acct-1')).toEqual([OWNER]);
  });

  it('excludes a deposit restored from a backup', async () => {
    const attacker = '0x2222222222222222222222222222222222222222';
    withRows([row({ restoredFromBackup: true, extraInputs: { evmRecipient: attacker } }), row()]);

    expect(await getEarnDepositEvmAddresses('acct-1')).toEqual([OWNER]);
  });
});
