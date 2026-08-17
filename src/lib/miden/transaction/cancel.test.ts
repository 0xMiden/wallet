// Light mocks so importing cancel.ts (for the pure `isTransactionStuck`
// helper) doesn't pull in Dexie / the WASM client proxy.
import { isTransactionStuck } from './cancel';

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({ InputNoteState: {} }));
jest.mock('lib/miden/repo', () => ({ transactions: {} }));
jest.mock('lib/miden/back/miden-client-proxy', () => ({ midenClientProxy: {} }));
jest.mock('../back/background-notification', () => ({
  notifyBackgroundTransactionFailed: jest.fn(),
  showBackgroundNotification: jest.fn()
}));
jest.mock('lib/platform', () => ({ isMobile: jest.fn(() => true) }));
jest.mock('lib/mobile/background-time', () => ({ hiddenSecondsSince: jest.fn(() => 0) }));
jest.mock('./get', () => ({ getTransactionsInProgress: jest.fn() }));
jest.mock('./helper', () => ({ updateTransactionStatus: jest.fn() }));
jest.mock('../sdk/miden-client', () => ({ withWasmClientLock: jest.fn() }));

describe('isTransactionStuck', () => {
  const MAX = 120; // 2 min (mobile) in seconds

  it('treats a tx with no processingStartedAt as stuck (crashed mid-transition)', () => {
    expect(isTransactionStuck(undefined, 1000, 0, MAX)).toBe(true);
  });

  it('is NOT stuck when active (foreground) elapsed is under the threshold', () => {
    // wall-clock elapsed = 100s, hidden = 0 → active 100s < 120s
    expect(isTransactionStuck(1000, 1100, 0, MAX)).toBe(false);
  });

  it('is stuck when active elapsed exceeds the threshold', () => {
    // wall-clock elapsed = 200s, hidden = 0 → active 200s > 120s
    expect(isTransactionStuck(1000, 1200, 0, MAX)).toBe(true);
  });

  it('does NOT reap when most of the elapsed time was spent backgrounded (#473)', () => {
    // wall-clock elapsed = 300s but 250s of it was hidden → active 50s < 120s.
    // The old wall-clock-only check reaped this as a false REMOTE_PROVER_TIMEOUT.
    expect(isTransactionStuck(1000, 1300, 250, MAX)).toBe(false);
  });

  it('still reaps when active foreground time alone exceeds the threshold', () => {
    // wall-clock elapsed = 400s, hidden = 100s → active 300s > 120s
    expect(isTransactionStuck(1000, 1400, 100, MAX)).toBe(true);
  });
});
