/** @jest-environment jsdom */
import { runInNewContext } from 'vm';

import { AndroidWalletPage } from './android-wallet-page';
import type { CdpSession } from './cdp-bridge';
import type { EmulatorControl } from './emulator-control';

describe('AndroidWalletPage.unlockWallet', () => {
  afterEach(() => {
    jest.useRealTimers();
    document.body.innerHTML = '';
  });

  function lockedPage(acceptPasscode: boolean) {
    const digits: string[] = [];
    const state = { status: 1, currentAccount: { publicKey: 'mtst1fixture' } };
    document.body.innerHTML = '<div data-testid="unlock-passcode"></div>';
    const surface = document.querySelector('[data-testid="unlock-passcode"]')!;
    for (let digit = 0; digit <= 9; digit++) {
      const button = document.createElement('button');
      button.dataset.testid = `numpad-${digit}`;
      button.onclick = () => {
        digits.push(String(digit));
        if (acceptPasscode && digits.join('') === '123456') {
          state.status = 2;
          surface.remove();
        }
      };
      surface.appendChild(button);
    }
    Object.assign(window, { __TEST_STORE__: { getState: () => state } });
    const page = new AndroidWalletPage({
      cdp: {
        eval: async (script: string) => runInNewContext(`(function () { ${script} })()`, { window, document })
      } as unknown as CdpSession,
      emulator: {} as EmulatorControl,
      serial: 'emulator-5554',
      packageName: 'com.miden.wallet'
    });
    return { page, digits, state };
  }

  it('enters the default mobile passcode and waits for Ready', async () => {
    const { page, digits, state } = lockedPage(true);
    jest.useFakeTimers();
    const unlocked = page.unlockWallet();
    await jest.advanceTimersByTimeAsync(35_000);
    await expect(unlocked).resolves.toBeUndefined();
    expect(digits.join('')).toBe('123456');
    expect(state.status).toBe(2);
    expect(document.querySelector('[data-testid="unlock-passcode"]')).toBeNull();
  });

  it('does not report success while the lock surface remains with a populated account', async () => {
    const { page, state } = lockedPage(false);
    jest.useFakeTimers();
    const outcome = page.unlockWallet().then(
      () => 'unexpected success',
      (error: unknown) => (error instanceof Error ? error.message : String(error))
    );
    await jest.advanceTimersByTimeAsync(35_000);
    expect(await outcome).toContain('pollForCondition: condition not met');
    expect(state.status).toBe(1);
    expect(document.querySelector('[data-testid="unlock-passcode"]')).not.toBeNull();
  });
});
