import { settledRoundTripBalance } from './mainnet-roundtrip-balance';

it('does not charge a previous claim to the next send when the vault projection lags Pending', async () => {
  let vault = 1_000n;
  let projection = vault;
  const refresh = async () => {
    projection = vault;
  };
  const read = async () => projection;

  // A one-unit note is claimed for 133 units. Pending is empty before balances refreshes.
  vault += 1n - 133n;
  const beforeSend = await settledRoundTripBalance(refresh, read);
  vault -= 1n + 133n;
  projection = vault;
  const afterSend = await settledRoundTripBalance(refresh, read);

  expect((beforeSend - afterSend).toString()).toBe('134');
  expect(beforeSend - afterSend <= 1n + 30n * 7n).toBe(true);
});

it('refreshes the post-send snapshot before measuring its debit', async () => {
  let projection = 1_000n;
  const actual = 866n;
  const measured = await settledRoundTripBalance(
    async () => {
      projection = actual;
    },
    async () => projection
  );
  expect(measured.toString()).toBe('866');
});

it('does not use a cached balance when the refresh fails to land', async () => {
  let reads = 0;
  await expect(
    settledRoundTripBalance(
      async () => {
        throw new Error('refreshBalances did not land');
      },
      async () => {
        reads += 1;
        return 1_000n;
      }
    )
  ).rejects.toThrow('refreshBalances did not land');
  expect(reads).toBe(0);
});
