import { isAgglayerDepositReady } from './status';

const deposit = (overrides: Record<string, unknown>) =>
  ({ tx_hash: '0x1', ready_for_claim: false, ...overrides }) as any;

describe('isAgglayerDepositReady', () => {
  it.each([
    { ready_for_claim: true },
    { ready_to_claim: true },
    { finalized: true },
    { finalised: true },
    { status: 'READY_TO_CLAIM' },
    { status: 'finalised' }
  ])('accepts a terminal AggLayer signal: %p', signal => {
    expect(isAgglayerDepositReady(deposit(signal))).toBe(true);
  });

  it('keeps a merely indexed deposit pending', () => {
    expect(isAgglayerDepositReady(deposit({ status: 'BRIDGED' }))).toBe(false);
  });
});
