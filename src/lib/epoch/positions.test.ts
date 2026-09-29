import { fetchEarnPositions, getEarnDepositEvmAddresses } from './positions';

jest.mock('./earn', () => ({
  EARN_DESTINATION_CHAIN_ID: 11155111,
  EARN_MARKET_UID: 'DUMMY_LENDING:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69'
}));
jest.mock('lib/miden/repo', () => ({
  transactions: { filter: jest.fn() }
}));

const OWNER = '0x1111111111111111111111111111111111111111';
const CATALOG_ACCOUNT = '0x0000000000000000000000000000000000000000';

function apiItem(deposits = '0', depositsUSD = 0) {
  return {
    lender: 'DUMMY_LENDING',
    chainId: '11155111',
    aprData: { apr: 2, depositApr: 2, borrowApr: 3 },
    lenderInfo: { lenderKey: 'DUMMY_LENDING', name: 'Dummy Lending', logoUri: '' },
    data: [
      {
        positions: [
          {
            marketUid: 'DUMMY_LENDING:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
            deposits,
            debt: '0',
            depositsUSD,
            withdrawable: deposits,
            collateralEnabled: false,
            underlyingInfo: {
              asset: {
                name: 'USD Coin',
                symbol: 'USDC',
                address: '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69',
                chainId: '11155111',
                logoURI: null,
                decimals: 6,
                assetGroup: 'USDC'
              },
              prices: { priceUsd: 1, priceChange24h: 0 }
            }
          }
        ]
      }
    ]
  };
}

describe('fetchEarnPositions', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('loads the supported vault catalog for a wallet with no EVM owners', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { items: [apiItem()] } })
    });

    const result = await fetchEarnPositions({ owners: [] });

    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining(`account=${CATALOG_ACCOUNT}`), {
      signal: expect.any(AbortSignal)
    });
    expect(result.owners).toEqual([]);
    expect(result.positions).toEqual([]);
    expect(result.vaults).toHaveLength(1);
    expect(result.vaults[0]).toMatchObject({ lenderKey: 'DUMMY_LENDING', chainId: '11155111', depositApr: 2 });
  });

  it('maps funded positions and preserves withdrawal inputs', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { items: [apiItem('12.5', 12.5)] } })
    });

    const result = await fetchEarnPositions({ owners: [OWNER] });

    expect(result.totalDepositsUSD).toBe(12.5);
    expect(result.positions[0]).toMatchObject({
      owner: OWNER,
      deposits: '12.5',
      withdrawable: '12.5',
      underlyingAddress: '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69'
    });
  });

  it('isolates malformed and failed API responses as per-owner errors', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { items: null } })
    });

    const result = await fetchEarnPositions({ owners: [OWNER] });

    expect(result.positions).toEqual([]);
    expect(result.errors).toEqual([{ owner: OWNER, error: 'positions request unsuccessful' }]);
  });

  it("settles an owner whose payload cannot be read as that owner's error, while the others load", async () => {
    const unreadable = '0x2222222222222222222222222222222222222222';
    // A readable item first, so keeping any of this owner's items would show here.
    const readable = { ...apiItem('7', 7), lenderInfo: { lenderKey: 'OTHER_LENDING', name: 'Other', logoUri: '' } };
    const lackingLenderInfo = { ...apiItem('3', 3), lenderInfo: undefined };
    (global.fetch as jest.Mock).mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => ({
        success: true,
        data: { items: url.includes(unreadable) ? [readable, lackingLenderInfo] : [apiItem('12.5', 12.5)] }
      })
    }));

    const result = await fetchEarnPositions({ owners: [unreadable, OWNER] });

    expect(result.errors).toEqual([{ owner: unreadable, error: 'positions response unreadable' }]);
    expect(result.positions).toEqual([expect.objectContaining({ owner: OWNER, deposits: '12.5' })]);
    expect(result.vaults).toEqual([expect.objectContaining({ lenderKey: 'DUMMY_LENDING' })]);
  });

  describe('an owner whose payload has a field of the wrong type', () => {
    const malformed = '0x2222222222222222222222222222222222222222';
    const loadWith = (bad: object) =>
      (global.fetch as jest.Mock).mockImplementation(async (url: string) => ({
        ok: true,
        json: async () => ({
          success: true,
          data: { items: url.includes(malformed) ? [bad] : [apiItem('12.5', 12.5)] }
        })
      }));

    beforeEach(() => {
      jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it("settles an unfunded item with no APRs, which only its vault reads, as that owner's error", async () => {
      loadWith({
        ...apiItem(),
        aprData: {},
        lenderInfo: { lenderKey: 'OTHER_LENDING', name: 'Other', logoUri: '' }
      });

      const result = await fetchEarnPositions({ owners: [malformed, OWNER] });

      expect(result.errors).toEqual([{ owner: malformed, error: 'positions response unreadable' }]);
      expect(result.positions).toEqual([expect.objectContaining({ owner: OWNER, deposits: '12.5' })]);
      expect(result.vaults).toEqual([expect.objectContaining({ lenderKey: 'DUMMY_LENDING' })]);
    });

    it("settles a funded position with no USD value as that owner's error", async () => {
      const funded = apiItem('3', 3);
      loadWith({
        ...funded,
        data: funded.data.map(group => ({ positions: group.positions.map(pos => ({ ...pos, depositsUSD: null })) })),
        lenderInfo: { lenderKey: 'OTHER_LENDING', name: 'Other', logoUri: '' }
      });

      const result = await fetchEarnPositions({ owners: [malformed, OWNER] });

      expect(result.errors).toEqual([{ owner: malformed, error: 'positions response unreadable' }]);
      expect(result.positions).toEqual([expect.objectContaining({ owner: OWNER, deposits: '12.5' })]);
      expect(result.vaults).toEqual([expect.objectContaining({ lenderKey: 'DUMMY_LENDING' })]);
      expect(result.totalDepositsUSD).toBe(12.5);
    });

    it("settles a vault whose chain id is not a string as that owner's error", async () => {
      loadWith({ ...apiItem(), chainId: 11155111 });

      const result = await fetchEarnPositions({ owners: [malformed, OWNER] });

      expect(result.errors).toEqual([{ owner: malformed, error: 'positions response unreadable' }]);
    });

    it('loads a vault whose lender has no logo, with an empty one', async () => {
      loadWith({ ...apiItem(), lenderInfo: { lenderKey: 'OTHER_LENDING', name: 'Other' } });

      const result = await fetchEarnPositions({ owners: [malformed, OWNER] });

      expect(result.errors).toEqual([]);
      expect(result.vaults).toContainEqual(expect.objectContaining({ lenderKey: 'OTHER_LENDING', logoUri: '' }));
    });

    it('logs the fold, naming the owner', async () => {
      loadWith({ ...apiItem(), aprData: {} });

      await fetchEarnPositions({ owners: [malformed, OWNER] });

      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(malformed), expect.any(Error));
    });

    it("settles the catalog query's item with no APRs as the catalog's error, with no vaults", async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, data: { items: [{ ...apiItem(), aprData: {} }] } })
      });

      const result = await fetchEarnPositions({ owners: [] });

      expect(result.errors).toEqual([{ owner: CATALOG_ACCOUNT, error: 'positions response unreadable' }]);
      expect(result.vaults).toEqual([]);
    });
  });

  it("settles an owner whose request stalls as that owner's error at 15 s, while the others load", async () => {
    jest.useFakeTimers();
    const stalled = '0x2222222222222222222222222222222222222222';
    // A stalled request ends only when its signal aborts, as a real fetch does.
    (global.fetch as jest.Mock).mockImplementation((url: string, init?: { signal?: AbortSignal }) =>
      url.includes(stalled)
        ? new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)))
        : Promise.resolve({ ok: true, json: async () => ({ success: true, data: { items: [apiItem('12.5', 12.5)] } }) })
    );
    try {
      let settled = false;
      const read = fetchEarnPositions({ owners: [OWNER, stalled] }).finally(() => {
        settled = true;
      });

      await jest.advanceTimersByTimeAsync(14_999);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);

      const result = await read;
      expect(result.positions).toEqual([expect.objectContaining({ owner: OWNER, deposits: '12.5' })]);
      expect(result.errors).toEqual([{ owner: stalled, error: 'Request timed out after 15000 ms' }]);
    } finally {
      jest.useRealTimers();
    }
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
