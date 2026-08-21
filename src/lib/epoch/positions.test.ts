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

    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining(`account=${CATALOG_ACCOUNT}`));
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
});

// This is a trust signal, like Recent recipients: whatever comes back for these
// addresses is rendered as the user's OWN position and folded into their total
// deposits. A restored row's `evmRecipient` is not this wallet's.
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
