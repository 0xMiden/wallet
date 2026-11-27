import { act, renderHook, waitFor } from '@testing-library/react';

import { useTrackedPosition } from './use-tracked-position';
import { appendPositionEvents, type PositionEvent } from '../position-events';
import { db, Table } from '../repo';

const at = 1_800_000_000_000;
const arrival: PositionEvent = {
  key: 'tx:faucet',
  txId: 'tx',
  accountId: 'acct',
  network: 'mainnet',
  faucetId: 'faucet',
  eventAt: at,
  arrived: 1_000_000n,
  departed: 0n,
  heldAfter: 1_000_000n,
  decimals: 6,
  quote: { priceMicro: 3_000_000n, kind: 'fixed' }
};

beforeEach(async () => {
  await db.table(Table.PositionEvents).clear();
});

it('follows the recorded events live and reads nothing while disabled', async () => {
  const { result, rerender } = renderHook(({ enabled }) => useTrackedPosition('acct', 'mainnet', 'faucet', enabled), {
    initialProps: { enabled: true }
  });
  await waitFor(() =>
    expect(result.current).toEqual({ position: { quantity: 0n, costMicro: undefined }, trackingSince: undefined })
  );

  await act(async () => {
    await appendPositionEvents('tx', [arrival]);
  });
  await waitFor(() =>
    expect(result.current).toEqual({ position: { quantity: 1_000_000n, costMicro: 3_000_000n }, trackingSince: at })
  );

  rerender({ enabled: false });
  expect(result.current).toBeUndefined();
});
