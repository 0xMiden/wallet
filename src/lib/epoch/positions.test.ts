import { getEarnVaults, getEpochPositionsUrl, getEpochRoutes } from 'lib/remote-config/values';

import { carryForward, type EarnPosition, type EarnPositionsResult, getEarnDepositEvmAddresses } from './positions';
import { TEST_EARN_VAULT, TEST_POSITIONS_URL } from './testing/bridge-config';
import { AAVE_V3_USDC, listingFor, poolsPage } from './testing/pools-fixtures';

let readEarnVaults: typeof import('./pools-read').readEarnVaults;
let fetchEarnPositions: typeof import('./positions').fetchEarnPositions;
let readLoadEvidence: typeof import('lib/telemetry/ui-producer-diagnostics').snapshotUiProducer;

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
beforeEach(async () => {
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

      expect(fetchMock).toHaveBeenCalledTimes(10);
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
        const owners = Array.from({ length: 10 }, (_, index) => `0x${String(index + 1).padStart(40, '0')}`);
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

        expect(requestedPaths(fetchMock).filter(path => path.startsWith('/positions?'))).toHaveLength(10);
        expect(settled).toBe(false);
        await jest.advanceTimersByTimeAsync(60_000);
        await second;
        expect(requestedPaths(fetchMock).filter(path => path.startsWith('/positions?'))).toHaveLength(11);
      } finally {
        jest.useRealTimers();
      }
    }
  );

  it('reads only the positions of each owner on the host and chain the config names, never the catalogue', async () => {
    const fetchMock = serve();

    await fetchEarnPositions({ owners: [OWNER, OTHER_OWNER] });

    expect(fetchMock).toHaveBeenCalledWith(`${TEST_POSITIONS_URL}/positions?account=${OWNER}&chains=11155111`, {
      signal: expect.any(AbortSignal)
    });
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

  it('rejects before any request while the config names no Epoch route', async () => {
    const fetchMock = serve();
    jest.mocked(getEpochRoutes).mockReturnValueOnce([]);

    await expect(fetchEarnPositions({ owners: [OWNER] })).rejects.toThrow('The bridge config names no Epoch route');
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

  it('keeps the funded positions of every market of the route, matching the uid in any case', async () => {
    serve(() =>
      positionsAnswer([
        apiItem('12.5', 12.5),
        apiItem('3', 3, 'AAVE_V3', `AAVE_V3:11155111:${SEPOLIA_USDC}`),
        apiItem('0', 0, 'AAVE_V3', AAVE_UID)
      ])
    );

    const result = await fetchEarnPositions({ owners: [OWNER] });

    expect(result.positions.map(position => [position.marketUid, position.deposits])).toEqual([
      [DUMMY_UID, '12.5'],
      [`AAVE_V3:11155111:${SEPOLIA_USDC}`, '3']
    ]);
    expect(result.totalDepositsUSD).toBe(15.5);
  });

  it("keeps a position in any market of a route's USDC, listed or not, and leaves out one in another token or chain", async () => {
    const unlisted =
      'MORPHO_BLUE_D7520AD198B497B6EB75BC690268F4597630DBC12E305E9D4105843BAB36E41D:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69';
    jest.mocked(getEarnVaults).mockReturnValue([TEST_EARN_VAULT]);
    serve(() =>
      positionsAnswer([
        apiItem('12.5', 12.5),
        apiItem('3', 3, 'AAVE_V3', AAVE_UID),
        apiItem('5', 5, 'MORPHO_BLUE_D7520AD198B497B6EB75BC690268F4597630DBC12E305E9D4105843BAB36E41D', unlisted),
        apiItem('4', 4, 'EULER_V2', 'EULER_V2:11155111:0x4c1aeda9b43efcf1da1d1755b18802aabe90f61e'),
        apiItem('6', 6, 'AAVE_V3', 'AAVE_V3:84532:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69')
      ])
    );

    const result = await fetchEarnPositions({ owners: [OWNER] });

    // The list gates deposits only: the unlisted Aave and Morpho positions stay withdrawable; the Euler one is in
    // another token, and the last one is on a chain no Epoch route names.
    expect(result.positions.map(position => position.marketUid)).toEqual([DUMMY_UID, AAVE_UID, unlisted]);
  });

  it('asks for the positions of every Epoch route in one request per owner, and keeps each route in its USDC', async () => {
    const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    const baseUid = `AAVE_V3:8453:${BASE_USDC.toLowerCase()}`;
    jest.mocked(getEpochRoutes).mockReturnValue([
      { chainId: 11155111, usdc: SEPOLIA_USDC },
      { chainId: 8453, usdc: BASE_USDC }
    ]);
    const fetchMock = serve(() =>
      positionsAnswer([
        apiItem('12.5', 12.5),
        { ...apiItem('3', 3, 'AAVE_V3', baseUid), chainId: '8453' },
        { ...apiItem('4', 4, 'AAVE_V3', `AAVE_V3:8453:${SEPOLIA_USDC.toLowerCase()}`), chainId: '8453' }
      ])
    );

    const result = await fetchEarnPositions({ owners: [OWNER] });

    expect(fetchMock).toHaveBeenCalledWith(`${TEST_POSITIONS_URL}/positions?account=${OWNER}&chains=11155111,8453`, {
      signal: expect.any(AbortSignal)
    });
    expect(requestedPaths(fetchMock)).toEqual([`/positions?account=${OWNER}`]);
    expect(result.positions.map(position => position.marketUid)).toEqual([DUMMY_UID, baseUid]);
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

  it('keeps an activity owner lookup failure on its exact root', async () => {
    const failure = new Error(canary);
    const Repo = jest.requireMock('lib/miden/repo');
    Repo.transactions.filter.mockReturnValueOnce({
      toArray: async () => {
        throw failure;
      }
    });
    await expect(fetchEarnPositions()).rejects.toBe(failure);
    expect(readLoadEvidence(failure, 'earnPositionsLoadError', 'notice')).toEqual({
      earnPositionsLoadStage: 'owner_lookup',
      earnPositionsLoadOutcome: 'complete_failure'
    });
  });
});
