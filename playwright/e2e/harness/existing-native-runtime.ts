import { AndroidWalletPage } from '../android/helpers/android-wallet-page';
import { CdpBridge as AndroidBridge } from '../android/helpers/cdp-bridge';
import { EmulatorControl } from '../android/helpers/emulator-control';
import { CdpBridge as IosBridge } from '../ios/helpers/cdp-bridge';
import { IosWalletPage } from '../ios/helpers/ios-wallet-page';
import { SimulatorControl } from '../ios/helpers/simulator-control';

export type ExistingNativeSelection =
  | { platform: 'ios'; id: string }
  | { platform: 'android'; id: string; hostPort: number };

// Attach only: installation, onboarding and device selection belong to explicit QA setup.
export async function connectExistingNativeRuntime(selection: ExistingNativeSelection) {
  if (!selection.id.trim()) throw new Error('An explicit existing QA runtime is required');
  if (selection.platform === 'ios') {
    const cdp = await IosBridge.connect({ udid: selection.id, bundleId: 'com.miden.bread' });
    const page = new IosWalletPage({
      cdp,
      sim: new SimulatorControl(),
      udid: selection.id,
      bundleId: 'com.miden.bread'
    });
    return { cdp, page, close: () => cdp.close() };
  }
  const cdp = await AndroidBridge.connect({
    serial: selection.id,
    packageName: 'com.miden.wallet',
    hostPort: selection.hostPort
  });
  const page = new AndroidWalletPage({
    cdp,
    emulator: new EmulatorControl(),
    serial: selection.id,
    packageName: 'com.miden.wallet'
  });
  return { cdp, page, close: () => cdp.close() };
}

export async function openExistingRuntimeUrl(page: IosWalletPage | AndroidWalletPage, url: string): Promise<void> {
  await page.navigateTo('/browser');
  await page.waitFor('[data-testid="explore-launcher"]', { timeoutMs: 30000 });
  await page.evalJs(`
    window.__qaRetainedLauncher = document.querySelector('[data-testid="explore-launcher"]');
    if (!document.querySelector('[data-testid="dapp-hero-search"]'))
      document.querySelector('[data-testid="explore-search-toggle"]').click();
    return null;
  `);
  await page.waitFor('[data-testid="dapp-hero-search"]', { timeoutMs: 30000 });
  await page.evalJs(`
    var input = document.querySelector('[data-testid="dapp-hero-search"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(url)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return null;
  `);
  await page.evalJs(`
    document.querySelector('[data-testid="dapp-hero-search"]').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })
    );
    return null;
  `);
}
