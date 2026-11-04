import { withinDeliveryWindow } from './bridge-receive-window';
import type { IBridgedReceiveExtraInputs } from '../db/types';

jest.mock('lib/remote-config/runtime', () => ({ getBridgeConfigSnapshot: () => ({ config: null }) }));
jest.mock('lib/usdcx/constant', () => ({ isUsdcxExecutorSource: () => false }));

const epochRow = (overrides: Partial<IBridgedReceiveExtraInputs>): IBridgedReceiveExtraInputs => ({
  provider: 'epoch',
  phase: 'delivering',
  sourceAddress: '0x00000000000000000000000000000000000000aa',
  sourceAmount: '1',
  sourceSymbol: 'USDC',
  ...overrides
});

describe('withinDeliveryWindow for a retried locked Epoch deposit (#2120)', () => {
  const lock = {
    sponsorAddress: '0x00000000000000000000000000000000000000aa',
    chainId: 11155111,
    lockId: '42',
    tokenAddress: '0x0000000000000000000000000000000000000002',
    isNative: false,
    amount: '1',
    taskTypeString: 'task',
    intentData: {},
    lockedAt: 100
  };

  it('starts the week at the retry, not at the first deposit', () => {
    const row = { initiatedAt: 100 };
    expect(withinDeliveryWindow(row, epochRow({}), 500)).toBe(false);
    expect(withinDeliveryWindow(row, epochRow({ epochLockedDeposit: { ...lock, reallocatedAt: 600 } }), 500)).toBe(
      true
    );
  });
});
