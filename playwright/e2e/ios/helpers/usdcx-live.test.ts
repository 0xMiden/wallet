/** @jest-environment node */
import type { IosNativeAsset } from './ios-wallet-page';
import { settleLedger } from './usdcx-live';

it('charges recorded burn sponsorship once and reports verification separately', async () => {
  const homeVaultBaseUnits = jest.fn(async (_token: string, matches: (balance: bigint) => boolean) => {
    expect(matches(999_748n)).toBe(true);
    expect(matches(999_629n)).toBe(false);
    return 999_748n;
  });
  const wallet = {
    homeVaultBaseUnits,
    navigateHome: jest.fn(async () => {
      throw new Error('unexpected landed path');
    }),
    readVaultBaseUnits: jest.fn(async () => {
      throw new Error('unexpected landed path');
    })
  };
  const native: IosNativeAsset = { tokenId: 'native', symbol: 'USDCX', decimals: 6, baseFee: 7 };
  const term = {
    name: 'f1',
    before: 7_000_000n,
    credit: 0n,
    debits: 6_000_119n,
    recordedSponsorship: 119n,
    row: { id: 'burn', feeAmount: '252' }
  };

  await expect(settleLedger(wallet, native, term)).resolves.toEqual({
    vault: 999_748n,
    fee: { name: 'f1', amount: 133n, kind: 'exact' }
  });
  expect(homeVaultBaseUnits).toHaveBeenCalledTimes(1);
});
