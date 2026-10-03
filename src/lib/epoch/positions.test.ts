import { requireEpochPositionsUrl } from 'lib/remote-config/values';

import {
  carryForward,
  type EarnPosition,
  type EarnPositionsResult,
  type EarnVaultInfo,
  fetchEarnPositions,
  getEarnDepositEvmAddresses
} from './positions';
import { TEST_POSITIONS_URL } from './testing/bridge-config';

jest.mock('lib/remote-config/values', () =>
  jest.requireActual<typeof import('./testing/bridge-config')>('./testing/bridge-config').remoteConfigValuesMock()
);
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

  it('reads the positions host and the market chain the config names', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { items: [] } })
    });

    await fetchEarnPositions({ owners: [OWNER] });

    expect(global.fetch).toHaveBeenCalledWith(`${TEST_POSITIONS_URL}/positions?account=${OWNER}&chains=11155111`, {
      signal: expect.any(AbortSignal)
    });
  });

  it('rejects before any request while the config names no positions host', async () => {
    jest.mocked(requireEpochPositionsUrl).mockRejectedValueOnce(new Error('no positions host'));

    await expect(fetchEarnPositions({ owners: [OWNER] })).rejects.toThrow('no positions host');
    expect(global.fetch).not.toHaveBeenCalled();
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
    const otherLender = { lenderKey: 'OTHER_LENDING', name: 'Other', logoUri: '' };
    const thirdLender = { ...apiItem('4', 4), lenderInfo: { lenderKey: 'THIRD_LENDING', name: 'Third', logoUri: '' } };
    const loadWith = (items: object[]) =>
      (global.fetch as jest.Mock).mockImplementation(async (url: string) => ({
        ok: true,
        json: async () => ({
          success: true,
          data: { items: url.includes(malformed) ? items : [apiItem('12.5', 12.5)] }
        })
      }));

    beforeEach(() => {
      jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('drops the vault of an unfunded item with no APRs and keeps the owner', async () => {
      loadWith([{ ...apiItem(), aprData: {}, lenderInfo: otherLender }, thirdLender]);

      const result = await fetchEarnPositions({ owners: [malformed, OWNER] });

      expect(result.errors).toEqual([]);
      expect(result.positions).toEqual([
        expect.objectContaining({ owner: malformed, lenderKey: 'THIRD_LENDING', deposits: '4' }),
        expect.objectContaining({ owner: OWNER, deposits: '12.5' })
      ]);
      expect(result.vaults).toEqual([
        expect.objectContaining({ lenderKey: 'THIRD_LENDING' }),
        expect.objectContaining({ lenderKey: 'DUMMY_LENDING' })
      ]);
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(malformed), expect.any(Error));
    });

    it("settles a funded position with no USD value as that owner's error", async () => {
      const funded = apiItem('3', 3);
      loadWith([
        {
          ...funded,
          data: funded.data.map(group => ({ positions: group.positions.map(pos => ({ ...pos, depositsUSD: null })) })),
          lenderInfo: otherLender
        }
      ]);

      const result = await fetchEarnPositions({ owners: [malformed, OWNER] });

      expect(result.errors).toEqual([{ owner: malformed, error: 'positions response unreadable' }]);
      expect(result.positions).toEqual([expect.objectContaining({ owner: OWNER, deposits: '12.5' })]);
      expect(result.vaults).toEqual([expect.objectContaining({ lenderKey: 'DUMMY_LENDING' })]);
      expect(result.totalDepositsUSD).toBe(12.5);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining(`positions response unreadable for ${malformed}`),
        expect.any(TypeError)
      );
    });

    it('keeps a funded item whose vault has no APR', async () => {
      loadWith([{ ...apiItem('3', 3), aprData: { depositApr: 2, borrowApr: 3 }, lenderInfo: otherLender }]);

      const result = await fetchEarnPositions({ owners: [malformed, OWNER] });

      expect(result.errors).toEqual([]);
      expect(result.positions).toEqual([
        expect.objectContaining({ owner: malformed, lenderKey: 'OTHER_LENDING', deposits: '3' }),
        expect.objectContaining({ owner: OWNER, deposits: '12.5' })
      ]);
      expect(result.vaults).toEqual([
        expect.objectContaining({ lenderKey: 'OTHER_LENDING' }),
        expect.objectContaining({ lenderKey: 'DUMMY_LENDING' })
      ]);
    });

    it('drops a vault whose chain id is not a string and keeps the owner', async () => {
      loadWith([{ ...apiItem(), chainId: 11155111 }, thirdLender]);

      const result = await fetchEarnPositions({ owners: [malformed, OWNER] });

      expect(result.errors).toEqual([]);
      expect(result.positions).toContainEqual(
        expect.objectContaining({ owner: malformed, lenderKey: 'THIRD_LENDING' })
      );
      expect(result.vaults).toEqual([
        expect.objectContaining({ lenderKey: 'THIRD_LENDING' }),
        expect.objectContaining({ lenderKey: 'DUMMY_LENDING', chainId: '11155111' })
      ]);
    });

    it('loads a vault whose lender has no logo, with an empty one', async () => {
      loadWith([{ ...apiItem(), lenderInfo: { lenderKey: 'OTHER_LENDING', name: 'Other' } }]);

      const result = await fetchEarnPositions({ owners: [malformed, OWNER] });

      expect(result.errors).toEqual([]);
      expect(result.vaults).toContainEqual(expect.objectContaining({ lenderKey: 'OTHER_LENDING', logoUri: '' }));
    });

    it('logs the fold, naming the owner', async () => {
      loadWith([{ ...apiItem(), aprData: {} }]);

      const result = await fetchEarnPositions({ owners: [malformed, OWNER] });

      expect(result.errors).toEqual([{ owner: malformed, error: 'positions response unreadable' }]);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining(`positions response unreadable for ${malformed}`),
        expect.any(Error)
      );
    });

    it('names each vault a read dropped, through an owner or the catalog, and says when one had no key', async () => {
      const unreadableVault = { ...apiItem(), aprData: {}, lenderInfo: otherLender };
      loadWith([unreadableVault, thirdLender]);
      const keyed = await fetchEarnPositions({ owners: [malformed, OWNER] });
      expect(keyed.droppedVaultKeys).toEqual(['OTHER_LENDING:11155111']);
      expect(keyed.vaultDroppedUnkeyed).toBeUndefined();

      loadWith([{ ...apiItem(), chainId: 11155111 }, thirdLender]);
      const unkeyed = await fetchEarnPositions({ owners: [malformed, OWNER] });
      expect(unkeyed.vaultDroppedUnkeyed).toBe(true);
      expect(unkeyed.droppedVaultKeys).toBeUndefined();

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, data: { items: [unreadableVault, apiItem()] } })
      });
      expect((await fetchEarnPositions({ owners: [] })).droppedVaultKeys).toEqual(['OTHER_LENDING:11155111']);

      loadWith([thirdLender]);
      const clean = await fetchEarnPositions({ owners: [malformed, OWNER] });
      expect(clean.droppedVaultKeys).toBeUndefined();
      expect(clean.vaultDroppedUnkeyed).toBeUndefined();
    });

    it('drops only the vault of an item with no lender info, as one whose key could not be read', async () => {
      loadWith([{ ...apiItem(), lenderInfo: undefined }, thirdLender]);

      const result = await fetchEarnPositions({ owners: [malformed, OWNER] });

      expect(result.errors).toEqual([]);
      expect(result.positions).toContainEqual(
        expect.objectContaining({ owner: malformed, lenderKey: 'THIRD_LENDING' })
      );
      expect(result.vaultDroppedUnkeyed).toBe(true);
    });

    it('drops only a null catalog item, as one whose key could not be read', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, data: { items: [null, apiItem()] } })
      });

      const result = await fetchEarnPositions({ owners: [] });

      expect(result.errors).toEqual([]);
      expect(result.vaults).toEqual([expect.objectContaining({ lenderKey: 'DUMMY_LENDING' })]);
      expect(result.vaultDroppedUnkeyed).toBe(true);
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

    it('keeps a catalog vault that reports only a deposit APR', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, data: { items: [{ ...apiItem(), aprData: { depositApr: 2 } }] } })
      });

      const result = await fetchEarnPositions({ owners: [] });

      expect(result.errors).toEqual([]);
      expect(result.vaults).toEqual([
        { lenderKey: 'DUMMY_LENDING', lenderName: 'Dummy Lending', logoUri: '', chainId: '11155111', depositApr: 2 }
      ]);
    });

    it("drops only a malformed catalog item's vault and loads the others", async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          data: { items: [{ ...apiItem(), aprData: {}, lenderInfo: otherLender }, apiItem()] }
        })
      });

      const result = await fetchEarnPositions({ owners: [] });

      expect(result.errors).toEqual([]);
      expect(result.vaults).toEqual([expect.objectContaining({ lenderKey: 'DUMMY_LENDING' })]);
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(CATALOG_ACCOUNT), expect.any(Error));
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

describe('carryForward', () => {
  const OTHER = '0x2222222222222222222222222222222222222222';
  const position = (owner: string, depositsUSD: number): EarnPosition => ({
    owner,
    marketUid: 'DUMMY_LENDING:11155111:0xasset',
    lenderKey: 'DUMMY_LENDING',
    lenderName: 'Dummy Lending',
    chainId: '11155111',
    deposits: String(depositsUSD),
    withdrawable: String(depositsUSD),
    depositsUSD,
    depositApr: 2,
    symbol: 'USDC',
    underlyingAddress: '0xasset',
    decimals: 6,
    priceUsd: 1
  });
  const vault = (lenderKey: string, depositApr = 2): EarnVaultInfo => ({
    lenderKey,
    lenderName: lenderKey,
    logoUri: '',
    chainId: '11155111',
    depositApr
  });
  const read = (over: Partial<EarnPositionsResult>): EarnPositionsResult => ({
    positions: [],
    vaults: [],
    totalDepositsUSD: 0,
    owners: [OWNER, OTHER],
    errors: [],
    ...over
  });

  it("brings back a failed owner's positions and the vaults the read lacks, from what was loaded before", () => {
    const previous = read({
      positions: [position(OWNER, 5), position(OTHER, 7)],
      vaults: [vault('DUMMY_LENDING', 1), vault('OTHER_LENDING')],
      totalDepositsUSD: 12
    });
    const next = read({
      positions: [position(OWNER, 6)],
      vaults: [vault('DUMMY_LENDING')],
      totalDepositsUSD: 6,
      errors: [{ owner: OTHER, error: 'positions request failed (429)' }]
    });

    const carried = carryForward(previous, next);

    // The owner that loaded shows this read's positions and vaults alone.
    expect(carried.positions).toEqual([position(OWNER, 6), position(OTHER, 7)]);
    expect(carried.vaults).toEqual([vault('DUMMY_LENDING'), vault('OTHER_LENDING')]);
    expect(carried.totalDepositsUSD).toBe(13);
    expect(carried.owners).toBe(next.owners);
    expect(carried.errors).toBe(next.errors);
  });

  it('returns the read as it is when no owner failed, or nothing was loaded before', () => {
    const previous = read({ positions: [position(OTHER, 7)], vaults: [vault('OTHER_LENDING')], totalDepositsUSD: 7 });
    const loaded = read({ positions: [position(OWNER, 6)], vaults: [vault('DUMMY_LENDING')], totalDepositsUSD: 6 });
    const failed = read({ errors: [{ owner: OWNER, error: 'positions request failed (429)' }] });

    expect(carryForward(previous, loaded)).toBe(loaded);
    expect(carryForward(undefined, failed)).toBe(failed);
  });

  it('brings back the vault a read dropped, with no owner failed, and no positions', () => {
    const previous = read({ positions: [position(OTHER, 7)], vaults: [vault('OTHER_LENDING')], totalDepositsUSD: 7 });
    const loaded = read({ positions: [position(OWNER, 6)], vaults: [vault('DUMMY_LENDING')], totalDepositsUSD: 6 });

    const carried = carryForward(previous, { ...loaded, droppedVaultKeys: ['OTHER_LENDING:11155111'] });

    expect(carried.vaults).toEqual([vault('DUMMY_LENDING'), vault('OTHER_LENDING')]);
    expect(carried.positions).toEqual([position(OWNER, 6)]);
    expect(carried.totalDepositsUSD).toBe(6);
    expect(carryForward(previous, loaded).vaults).toEqual([vault('DUMMY_LENDING')]);
  });

  describe('when a read that keeps one of three vaults dropped the second', () => {
    const [first, second, third] = [vault('DUMMY_LENDING'), vault('OTHER_LENDING'), vault('THIRD_LENDING')];
    const previous = read({ vaults: [first, second, third] });
    const dropped = read({ vaults: [first], droppedVaultKeys: ['OTHER_LENDING:11155111'] });

    it('brings back that vault alone', () => {
      expect(carryForward(previous, dropped).vaults).toEqual([first, second]);
    });

    it('brings back every vault the read lacks when a dropped vault had no key', () => {
      expect(carryForward(previous, { ...dropped, vaultDroppedUnkeyed: true }).vaults).toEqual([first, second, third]);
    });

    it('brings back every vault the read lacks when an owner failed', () => {
      const failed = { ...dropped, errors: [{ owner: OTHER, error: 'positions request failed (429)' }] };

      expect(carryForward(previous, failed).vaults).toEqual([first, second, third]);
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
