import { getEarnVaults, getEpochPositionsUrl } from 'lib/remote-config/values';

import { carryForward, type EarnPosition, type EarnPositionsResult } from './positions';
import { TEST_EARN_VAULT, TEST_POSITIONS_URL } from './testing/bridge-config';
import { AAVE_V3_USDC, listingFor, poolsPage } from './testing/pools-fixtures';

let readEarnVaults: typeof import('./pools-read').readEarnVaults;
let fetchEarnPositions: typeof import('./positions').fetchEarnPositions;
let readLoadEvidence: typeof import('lib/telemetry/ui-producer-diagnostics').snapshotUiProducer;

jest.mock('lib/remote-config/values', () =>
  jest.requireActual<typeof import('./testing/bridge-config')>('./testing/bridge-config').remoteConfigValuesMock()
);
jest.mock('lib/miden/repo', () => ({
  transactions: { where: jest.fn() }
}));

// The document lists the Aave V3 market of the test route first, then the dummy lender's.
const AAVE_LISTING = listingFor(
  { marketUid: 'AAVE_V3:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69' },
  'aave-v3-sepolia-usdc',
  'Aave V3 USDC'
);
/** The wallet's activity: the `earn-deposit` rows the market lookup reads. */
const withRows = (rows: unknown[]) => {
  const Repo = jest.requireMock('lib/miden/repo');
  Repo.transactions.where.mockImplementation(() => ({
    equals: (type: string) => ({
      toArray: async () =>
        rows.filter(row => typeof row === 'object' && row !== null && Reflect.get(row, 'type') === type)
    })
  }));
};

beforeEach(async () => {
  withRows([]);
  await jest.isolateModulesAsync(async () => {
    ({ fetchEarnPositions } = await import('./positions'));
    ({ snapshotUiProducer: readLoadEvidence } = await import('lib/telemetry/ui-producer-diagnostics'));
    ({ readEarnVaults } = await import('./pools-read'));
  });
  jest.mocked(getEarnVaults).mockReturnValue([AAVE_LISTING, TEST_EARN_VAULT]);
});

const OWNER = '0x1111111111111111111111111111111111111111';
const OTHER_OWNER = '0x2222222222222222222222222222222222222222';
const ZERO_ACCOUNT = '0x0000000000000000000000000000000000000000';
const SEPOLIA_USDC = '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69';
const DUMMY_UID = 'DUMMY_LENDING:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69';
const AAVE_UID = 'AAVE_V3:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69';

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

/** Serves an owner's positions with `owner`, and the catalogue routes, which a positions read must never ask for. */
function serve(
  owner?: (owner: string, init?: { signal?: AbortSignal }) => Answer | Promise<Answer>,
  poolsStatus = 200
) {
  const fetchMock = jest.fn();
  fetchMock.mockImplementation(async (url: string, init?: { signal?: AbortSignal }) => {
    const parsed = new URL(url);
    const account = parsed.searchParams.get('account') ?? '';
    switch (parsed.pathname) {
      case '/pools':
        return answer(poolsPage([AAVE_V3_USDC]), poolsStatus);
      case '/positions':
        if (account === ZERO_ACCOUNT) return positionsAnswer([apiItem()]);
        return owner?.(account, init) ?? positionsAnswer([]);
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
    // One listed lender, so each owner is one request; the per-lender split has its own tests below.
    jest.mocked(getEarnVaults).mockReturnValue([TEST_EARN_VAULT]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('makes no request for a wallet with no EVM owners', async () => {
    const fetchMock = serve();

    const result = await fetchEarnPositions({ owners: [] });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ positions: [], totalDepositsUSD: 0, owners: [], errors: [] });
  });

  it('takes no owner from the activity rows: with no owner given, it makes no request', async () => {
    withRows([
      { type: 'earn-deposit', accountId: 'acct-1', extraInputs: { evmRecipient: OWNER, marketUid: DUMMY_UID } }
    ]);
    const fetchMock = serve();

    const result = await fetchEarnPositions({ accountId: 'acct-1' });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ positions: [], totalDepositsUSD: 0, owners: [], errors: [] });
  });

  it("reads only the given owner, never another owner of the account's deposit rows", async () => {
    jest.mocked(getEarnVaults).mockReturnValue([]);
    // A legacy row of the account that names another owner, in a market the document does not list.
    withRows([
      { type: 'earn-deposit', accountId: 'acct-1', extraInputs: { evmRecipient: OWNER, marketUid: DUMMY_UID } },
      { type: 'earn-deposit', accountId: 'acct-1', extraInputs: { evmRecipient: OTHER_OWNER, marketUid: AAVE_UID } }
    ]);
    const fetchMock = serve();

    const result = await fetchEarnPositions({ accountId: 'acct-1', owners: [OWNER] });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${TEST_POSITIONS_URL}/positions?account=${OWNER}&chains=11155111&lenders=DUMMY_LENDING`
    ]);
    expect(result.owners).toEqual([OWNER]);
  });

  it('takes no market from a deposit row restored from a backup', async () => {
    jest.mocked(getEarnVaults).mockReturnValue([]);
    withRows([
      {
        type: 'earn-deposit',
        accountId: 'acct-1',
        restoredFromBackup: true,
        extraInputs: { evmRecipient: OWNER, marketUid: AAVE_UID }
      },
      { type: 'earn-deposit', accountId: 'acct-1', extraInputs: { evmRecipient: OWNER, marketUid: DUMMY_UID } }
    ]);
    const fetchMock = serve();

    await fetchEarnPositions({ accountId: 'acct-1', owners: [OWNER] });

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${TEST_POSITIONS_URL}/positions?account=${OWNER}&chains=11155111&lenders=DUMMY_LENDING`
    ]);
  });

  it('finishes an oversized owner read across rolling request windows', async () => {
    jest.useFakeTimers();
    try {
      const fetchMock = serve();
      const owners = Array.from({ length: 11 }, (_, index) => `0x${String(index + 1).padStart(40, '0')}`);
      let settled = false;
      const reading = fetchEarnPositions({ owners }).then(result => {
        settled = true;
        return result;
      });
      await jest.advanceTimersByTimeAsync(0);

      expect(fetchMock).toHaveBeenCalledTimes(7);
      expect(settled).toBe(false);

      await jest.advanceTimersByTimeAsync(60_000);
      expect((await reading).owners).toEqual(owners);
      expect(fetchMock).toHaveBeenCalledTimes(11);
    } finally {
      jest.useRealTimers();
    }
  });

  it.each(['owners first', 'catalog first'])(
    'shares the rolling endpoint budget with fallback catalog reads: %s',
    async order => {
      jest.useFakeTimers();
      try {
        const fetchMock = serve(undefined, 404);
        const owners = Array.from({ length: 7 }, (_, index) => `0x${String(index + 1).padStart(40, '0')}`);
        const readCatalog = () =>
          readEarnVaults(
            fetchMock,
            {
              positionsUrl: TEST_POSITIONS_URL,
              chainId: 11155111,
              underlying: SEPOLIA_USDC,
              listed: [TEST_EARN_VAULT]
            },
            10_000
          );
        let settled = false;
        const first = order === 'owners first' ? fetchEarnPositions({ owners }) : readCatalog();
        await first;
        const second = (order === 'owners first' ? readCatalog() : fetchEarnPositions({ owners })).then(result => {
          settled = true;
          return result;
        });
        await jest.advanceTimersByTimeAsync(0);

        expect(requestedPaths(fetchMock).filter(path => path.startsWith('/positions?'))).toHaveLength(7);
        expect(settled).toBe(false);
        await jest.advanceTimersByTimeAsync(60_000);
        await second;
        expect(requestedPaths(fetchMock).filter(path => path.startsWith('/positions?'))).toHaveLength(8);
      } finally {
        jest.useRealTimers();
      }
    }
  );

  it('reads only the positions of each owner on the host and chain the config names, never the catalogue', async () => {
    const fetchMock = serve();

    await fetchEarnPositions({ owners: [OWNER, OTHER_OWNER] });

    expect(fetchMock).toHaveBeenCalledWith(
      `${TEST_POSITIONS_URL}/positions?account=${OWNER}&chains=11155111&lenders=DUMMY_LENDING`,
      { signal: expect.any(AbortSignal) }
    );
    expect(requestedPaths(fetchMock).sort()).toEqual([
      `/positions?account=${OWNER}`,
      `/positions?account=${OTHER_OWNER}`
    ]);
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
    serve(() => positionsAnswer([apiItem('12.5', 12.5)]));

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

  it('keeps the funded positions of the listed and deposited markets, matching the uid in any case', async () => {
    const WETH = '0x7b79995e5f793a07bc00c21412e50ecae098e7f9';
    // The document lists the dummy lender's market; the owner deposited into the Aave one.
    withRows([
      { type: 'earn-deposit', accountId: 'acct-1', extraInputs: { evmRecipient: OWNER, marketUid: AAVE_UID } }
    ]);
    const items: Record<string, unknown[]> = {
      DUMMY_LENDING: [apiItem('12.5', 12.5), apiItem('4', 4, 'DUMMY_LENDING', `DUMMY_LENDING:11155111:${WETH}`)],
      AAVE_V3: [
        apiItem('3', 3, 'AAVE_V3', `AAVE_V3:11155111:${SEPOLIA_USDC}`),
        apiItem('5', 5, 'AAVE_V3', `AAVE_V3:11155111:${WETH}`),
        apiItem('6', 6, 'AAVE_V3', `AAVE_V3:84532:${SEPOLIA_USDC}`)
      ]
    };
    const fetchMock = jest.fn();
    fetchMock.mockImplementation(async (url: string) =>
      positionsAnswer(items[new URL(url).searchParams.get('lenders') ?? ''] ?? [])
    );
    global.fetch = fetchMock;

    const result = await fetchEarnPositions({ accountId: 'acct-1', owners: [OWNER] });

    // The WETH positions on the owner's address and the Aave position on another chain are in no known market.
    expect(result.positions.map(position => [position.marketUid, position.deposits])).toEqual([
      [DUMMY_UID, '12.5'],
      [`AAVE_V3:11155111:${SEPOLIA_USDC}`, '3']
    ]);
    expect(result.totalDepositsUSD).toBe(15.5);
  });

  it('leaves out a funded position in a market that the document does not list and the owner never deposited into', async () => {
    const unlisted =
      'MORPHO_BLUE_D7520AD198B497B6EB75BC690268F4597630DBC12E305E9D4105843BAB36E41D:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69';
    jest.mocked(getEarnVaults).mockReturnValue([TEST_EARN_VAULT]);
    serve(() =>
      positionsAnswer([
        apiItem('12.5', 12.5),
        apiItem('3', 3, 'AAVE_V3', AAVE_UID),
        apiItem('5', 5, 'MORPHO_BLUE_D7520AD198B497B6EB75BC690268F4597630DBC12E305E9D4105843BAB36E41D', unlisted)
      ])
    );

    const result = await fetchEarnPositions({ owners: [OWNER] });

    expect(result.positions.map(position => position.marketUid)).toEqual([DUMMY_UID]);
  });

  it('asks nothing for an owner the wallet knows no Earn market of', async () => {
    jest.mocked(getEarnVaults).mockReturnValue([]);
    const fetchMock = serve(() => positionsAnswer([apiItem('12.5', 12.5)]));

    const result = await fetchEarnPositions({ owners: [OWNER] });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ positions: [], totalDepositsUSD: 0, owners: [OWNER], errors: [] });
  });

  describe('one request per lender', () => {
    const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    const MAINNET_USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const aaveBase = `aave_v3:8453:${BASE_USDC}`;
    const aaveMainnet = `aave_v3:1:${MAINNET_USDC}`;
    const requestedUrls = (fetchMock: jest.Mock) => fetchMock.mock.calls.map(([url]) => String(url)).sort();

    it("asks each lender only on the chains of its known markets, upper-casing the lender's key", async () => {
      jest.mocked(getEarnVaults).mockReturnValue([
        { ...TEST_EARN_VAULT, id: 'aave-base', marketUid: aaveBase },
        { ...TEST_EARN_VAULT, id: 'aave-mainnet', marketUid: aaveMainnet }
      ]);
      const morphoBase = `morpho_blue_d752:8453:${BASE_USDC}`;
      // A deposit into a market the document no longer lists, and one into a market on a chain the document lists
      // no vault on. Both are known markets of the owner.
      withRows([
        { type: 'earn-deposit', accountId: 'acct-1', extraInputs: { evmRecipient: OWNER, marketUid: morphoBase } },
        {
          type: 'earn-deposit',
          accountId: 'acct-1',
          extraInputs: { evmRecipient: OWNER, marketUid: `euler_v2:10:${BASE_USDC}` }
        }
      ]);
      const fetchMock = serve();

      await fetchEarnPositions({ owners: [OWNER] });

      expect(requestedUrls(fetchMock)).toEqual([
        `${TEST_POSITIONS_URL}/positions?account=${OWNER}&chains=10&lenders=EULER_V2`,
        `${TEST_POSITIONS_URL}/positions?account=${OWNER}&chains=8453&lenders=MORPHO_BLUE_D752`,
        `${TEST_POSITIONS_URL}/positions?account=${OWNER}&chains=8453,1&lenders=AAVE_V3`
      ]);
    });

    it('orders the chains of a lender as the listed vaults, then the deposits, name them', async () => {
      jest.mocked(getEarnVaults).mockReturnValue([
        { ...TEST_EARN_VAULT, id: 'morpho-mainnet', marketUid: `morpho_blue_d752:1:${MAINNET_USDC}` },
        { ...TEST_EARN_VAULT, id: 'aave-base', marketUid: aaveBase }
      ]);
      withRows([
        { type: 'earn-deposit', accountId: 'acct-1', extraInputs: { evmRecipient: OWNER, marketUid: aaveMainnet } }
      ]);
      const fetchMock = serve();

      await fetchEarnPositions({ owners: [OWNER] });

      // Ethereum comes first: the first listed vault names it.
      expect(requestedUrls(fetchMock)).toEqual([
        `${TEST_POSITIONS_URL}/positions?account=${OWNER}&chains=1&lenders=MORPHO_BLUE_D752`,
        `${TEST_POSITIONS_URL}/positions?account=${OWNER}&chains=1,8453&lenders=AAVE_V3`
      ]);
    });

    it('reads no market whose chain segment is not a plain decimal id', async () => {
      jest.mocked(getEarnVaults).mockReturnValue([{ ...TEST_EARN_VAULT, id: 'aave-base', marketUid: aaveBase }]);
      // `Number('1e3')` is 1000 and `Number('0x10')` is 16: chains these uids do not name.
      withRows([
        {
          type: 'earn-deposit',
          accountId: 'acct-1',
          extraInputs: { evmRecipient: OWNER, marketUid: `aave_v3:1e3:${MAINNET_USDC}` }
        },
        {
          type: 'earn-deposit',
          accountId: 'acct-1',
          extraInputs: { evmRecipient: OWNER, marketUid: `euler_v2:0x10:${BASE_USDC}` }
        }
      ]);
      const fetchMock = serve();

      await fetchEarnPositions({ owners: [OWNER] });

      expect(requestedUrls(fetchMock)).toEqual([
        `${TEST_POSITIONS_URL}/positions?account=${OWNER}&chains=8453&lenders=AAVE_V3`
      ]);
    });

    it('reads only the given market for a check of one position', async () => {
      jest.mocked(getEarnVaults).mockReturnValue([{ ...TEST_EARN_VAULT, id: 'aave-base', marketUid: aaveBase }]);
      const fetchMock = serve();

      await fetchEarnPositions({ owners: [OWNER], markets: [aaveMainnet] });

      expect(requestedUrls(fetchMock)).toEqual([
        `${TEST_POSITIONS_URL}/positions?account=${OWNER}&chains=1&lenders=AAVE_V3`
      ]);
    });

    it('a review-scoped read is admitted while page reads have spent their allowance', async () => {
      jest.useFakeTimers();
      const fetchMock = serve();
      try {
        for (let i = 0; i < 7; i += 1) await fetchEarnPositions({ owners: [OWNER] });
        fetchMock.mockClear();

        const pageRead = fetchEarnPositions({ owners: [OWNER] });
        await jest.advanceTimersByTimeAsync(0);
        expect(fetchMock).not.toHaveBeenCalled();

        // A reviewed source retry reads three times: its own balance read, then the review's check before the
        // smart-account setup and again before execution. All three go out at once.
        await fetchEarnPositions({ owners: [OWNER], markets: [aaveMainnet] });
        await fetchEarnPositions({ owners: [OWNER], markets: [aaveMainnet] });
        await fetchEarnPositions({ owners: [OWNER], markets: [aaveMainnet] });
        expect(fetchMock).toHaveBeenCalledTimes(3);

        const reviewRead = fetchEarnPositions({ owners: [OWNER], markets: [aaveMainnet] });
        await jest.advanceTimersByTimeAsync(59_999);
        expect(fetchMock).toHaveBeenCalledTimes(3);

        await jest.advanceTimersByTimeAsync(1);
        await Promise.all([pageRead, reviewRead]);
        expect(fetchMock).toHaveBeenCalledTimes(5);
      } finally {
        jest.useRealTimers();
      }
    });

    it('keeps none of the positions of an owner whose other lender request failed, and reports it once', async () => {
      jest.mocked(getEarnVaults).mockReturnValue([
        { ...TEST_EARN_VAULT, id: 'aave-base', marketUid: aaveBase },
        { ...TEST_EARN_VAULT, id: 'moonwell-base', marketUid: `moonwell:8453:${BASE_USDC}` }
      ]);
      const fetchMock = jest.fn();
      fetchMock.mockImplementation(async (url: string) => {
        const lender = new URL(url).searchParams.get('lenders');
        if (lender === 'MOONWELL') return answer(null, 503);
        return positionsAnswer([{ ...apiItem('3', 3, 'AAVE_V3', aaveBase), chainId: '8453' }]);
      });
      global.fetch = fetchMock;

      const result = await fetchEarnPositions({ owners: [OWNER] });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.positions).toEqual([]);
      expect(result.errors).toEqual([{ owner: OWNER, error: 'positions request failed (503)', stage: 'request' }]);
    });
  });

  it('isolates malformed and failed API responses as per-owner errors', async () => {
    serve(owner => (owner === OTHER_OWNER ? answer(null, 429) : answer({ success: true, data: { items: null } })));

    const result = await fetchEarnPositions({ owners: [OWNER, OTHER_OWNER] });

    expect(result.positions).toEqual([]);
    expect(result.errors).toEqual([
      { owner: OWNER, error: 'positions request unsuccessful', stage: 'response_decode' },
      { owner: OTHER_OWNER, error: 'positions request failed (429)', stage: 'request' }
    ]);
  });

  it("settles an owner whose payload cannot be read as that owner's error, while the others load", async () => {
    // A readable item first, so keeping any of this owner's items would show here.
    const lackingLenderInfo = { ...apiItem('3', 3), lenderInfo: undefined };
    serve(owner =>
      positionsAnswer(owner === OTHER_OWNER ? [apiItem('7', 7), lackingLenderInfo] : [apiItem('12.5', 12.5)])
    );

    const result = await fetchEarnPositions({ owners: [OTHER_OWNER, OWNER] });

    expect(result.errors).toEqual([
      { owner: OTHER_OWNER, error: 'positions response unreadable', stage: 'position_decode' }
    ]);
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
    serve(owner => positionsAnswer(owner === OTHER_OWNER ? [noUsd] : [apiItem('12.5', 12.5)]));

    const result = await fetchEarnPositions({ owners: [OTHER_OWNER, OWNER] });

    expect(result.errors).toEqual([
      { owner: OTHER_OWNER, error: 'positions response unreadable', stage: 'position_decode' }
    ]);
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
    serve((owner, init) =>
      owner === OTHER_OWNER
        ? new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)))
        : positionsAnswer([apiItem('12.5', 12.5)])
    );
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
      expect(result.errors).toEqual([
        { owner: OTHER_OWNER, error: 'Request timed out after 15000 ms', stage: 'request' }
      ]);
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
  const read = (over: Partial<EarnPositionsResult>): EarnPositionsResult => ({
    positions: [],
    totalDepositsUSD: 0,
    owners: [OWNER, OTHER_OWNER],
    errors: [],
    ...over
  });

  it("brings back a failed owner's positions", () => {
    const previous = read({ positions: [position(OWNER, 5), position(OTHER_OWNER, 7)], totalDepositsUSD: 12 });
    const next = read({
      positions: [position(OWNER, 6)],
      totalDepositsUSD: 6,
      errors: [{ owner: OTHER_OWNER, error: 'positions request failed (429)' }]
    });

    const carried = carryForward(previous, next);

    // The owner that loaded shows this read's positions alone.
    expect(carried.positions).toEqual([position(OWNER, 6), position(OTHER_OWNER, 7)]);
    expect(carried.totalDepositsUSD).toBe(13);
    expect(carried.owners).toBe(next.owners);
    expect(carried.errors).toBe(next.errors);
  });

  it('returns the read as it is when nothing failed, or nothing was loaded before', () => {
    const previous = read({ positions: [position(OTHER_OWNER, 7)], totalDepositsUSD: 7 });
    const loaded = read({ positions: [position(OWNER, 6)], totalDepositsUSD: 6 });
    const failed = read({ errors: [{ owner: OWNER, error: 'positions request failed (429)' }] });

    expect(carryForward(previous, loaded)).toBe(loaded);
    expect(carryForward(undefined, failed)).toBe(failed);
  });
});

describe('source-owned Earn load diagnostics', () => {
  const canary = 'private-owner 0xabcdef1234567890 amount 1234.56';
  it.each([
    ['request rejection', 'request', () => Promise.reject(new Error(canary))],
    ['HTTP refusal', 'request', () => answer({ message: canary }, 503)],
    [
      'JSON rejection',
      'response_decode',
      () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error(canary);
        }
      })
    ],
    ['unsuccessful envelope', 'response_decode', () => answer({ success: false, error: canary })],
    ['malformed funded position', 'position_decode', () => positionsAnswer([{ ...apiItem('1', 1), data: null }])]
  ] as const)('retains the owned stage for %s without copying its private cause', async (_name, stage, response) => {
    serve(response);
    const result = await fetchEarnPositions({ owners: [OWNER] });
    expect(result.positions).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ owner: OWNER, stage });
    expect(JSON.stringify({ stage: Reflect.get(result.errors[0] ?? {}, 'stage') })).not.toContain(canary);
  });

  it.each(['request', 'response_decode'])(
    'keeps the timed-out %s boundary without changing the deadline',
    async stage => {
      jest.useFakeTimers();
      try {
        serve((_owner, init) => {
          const stalled = () =>
            new Promise<never>((_resolve, reject) =>
              init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
            );
          return stage === 'request' ? stalled() : { ok: true, status: 200, json: stalled };
        });
        const reading = fetchEarnPositions({ owners: [OWNER] });
        await jest.advanceTimersByTimeAsync(15_000);
        expect((await reading).errors).toEqual([{ owner: OWNER, error: 'Request timed out after 15000 ms', stage }]);
      } finally {
        jest.useRealTimers();
      }
    }
  );

  it('keeps a configuration failure on its exact root and preserves its rejection', async () => {
    const failure = new Error(canary);
    jest.mocked(getEpochPositionsUrl).mockImplementationOnce(() => {
      throw failure;
    });
    await expect(fetchEarnPositions({ owners: [OWNER] })).rejects.toBe(failure);
    expect(readLoadEvidence(failure, 'earnPositionsLoadError', 'notice')).toEqual({
      earnPositionsLoadStage: 'configuration',
      earnPositionsLoadOutcome: 'complete_failure'
    });
    expect(
      readLoadEvidence(new Error('wrapper', { cause: failure }), 'earnPositionsLoadError', 'notice')
    ).toBeUndefined();
  });

  it('keeps a failure of the activity market lookup on its exact root', async () => {
    const failure = new Error(canary);
    const Repo = jest.requireMock('lib/miden/repo');
    Repo.transactions.where.mockReturnValueOnce({
      equals: () => ({
        toArray: async () => {
          throw failure;
        }
      })
    });
    await expect(fetchEarnPositions({ owners: [OWNER] })).rejects.toBe(failure);
    expect(readLoadEvidence(failure, 'earnPositionsLoadError', 'notice')).toEqual({
      earnPositionsLoadStage: 'owner_lookup',
      earnPositionsLoadOutcome: 'complete_failure'
    });
  });
});
