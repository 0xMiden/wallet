/**
 * @jest-environment node
 */
import { AndroidWalletPage } from './android-wallet-page';
import type { CdpSession } from './cdp-bridge';
import type { EmulatorControl } from './emulator-control';
import { fakeConfirmationApp, type CreateAttemptOutcome } from '../../helpers/confirmation-app-fake';

// A create whose first sync failed sat on Confirmation's failure screen until the Ready wait ran out, as on iOS.
describe('AndroidWalletPage.waitForCreatedWalletReady', () => {
  afterEach(() => jest.useRealTimers());

  async function outcomeOf(outcomes: CreateAttemptOutcome[]): Promise<{ outcome: string; clicks: number[] }> {
    const { evalJs, clicks } = fakeConfirmationApp(outcomes);
    const page = new AndroidWalletPage({
      cdp: { eval: evalJs } as unknown as CdpSession,
      emulator: {} as EmulatorControl,
      serial: 'emulator-5554',
      packageName: 'com.miden.bread'
    });
    jest.useFakeTimers();
    let settled = false;
    const outcome = (page as unknown as { waitForCreatedWalletReady(label: string, timeoutMs: number): Promise<void> })
      .waitForCreatedWalletReady('create(guardian)', 120_000)
      .then(
        () => 'ready',
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      )
      .finally(() => (settled = true));
    await jest.advanceTimersByTimeAsync(10_000);
    return { outcome: settled ? await outcome : 'pending', clicks };
  }

  it("is the wait a create runs after pressing Confirmation's button", async () => {
    // The address read answers the account; the consent dismissal sees the home surface already up.
    const evalJs = jest.fn(async (js: string) =>
      js.includes('publicKey') ? 'mtst1qcreated' : js.includes('explore-page')
    );
    const page = new AndroidWalletPage({
      cdp: { eval: evalJs } as unknown as CdpSession,
      emulator: {} as EmulatorControl,
      serial: 'emulator-5554',
      packageName: 'com.miden.bread'
    });
    const waitForCreatedWalletReady = jest.fn(async () => undefined);
    const click = jest.fn(async () => undefined);
    Object.assign(page as unknown as Record<string, unknown>, {
      pollForSelector: jest.fn(async () => undefined),
      click,
      waitForCreatedWalletReady
    });
    jest.useFakeTimers();

    const created = page.createGuardianWallet('Password123!');
    await jest.advanceTimersByTimeAsync(3_000);

    await expect(created).resolves.toEqual({ address: 'mtst1qcreated', seedPhrase: [] });
    expect(click).toHaveBeenCalledWith('[data-testid="onboarding-confirmation-submit"]');
    expect(waitForCreatedWalletReady).toHaveBeenCalledWith(
      'AndroidWalletPage.createWalletViaBypass(guardian)',
      180_000
    );
  });

  it('waits for Ready without pressing anything when the create succeeds', async () => {
    await expect(outcomeOf(['ready'])).resolves.toEqual({ outcome: 'ready', clicks: [] });
  });

  it("presses the app's Retry once on the first failure screen and keeps waiting for Ready", async () => {
    await expect(outcomeOf(['fails', 'ready'])).resolves.toEqual({ outcome: 'ready', clicks: [0] });
  });

  it('fails at once, with the screen text, when the Retry fails too', async () => {
    await expect(outcomeOf(['fails', 'fails', 'ready'])).resolves.toEqual({
      outcome:
        'create(guardian): wallet creation failed again after one Retry: ' +
        'Something went wrong Failed to sync state: RPC deadline exceeded Retry',
      clicks: [0]
    });
  });
});
