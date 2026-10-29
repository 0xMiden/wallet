import { setEligibilityFixtureState } from '../../helpers/feature-eligibility';
import { expect, test } from '../fixtures/two-emulators';

const EARN_SERVICE_DOWN =
  '[data-testid="earn-page"] [data-testid="earn-unavailable-notice"][data-reason="service-down"]';
const SWAP_SERVICE_DOWN =
  '[data-testid="swap-flow"] [data-testid="swap-unavailable-notice"][data-reason="service-down"]';

// Devnet's published document turns Earn off and names no swap solver, so neither notice can render there.
test.skip((process.env.E2E_NETWORK ?? 'testnet') !== 'testnet', 'Earn and Swap are configured on testnet only');

test.afterEach(async () => {
  await setEligibilityFixtureState('allowed');
});

test('opens the wallet with Earn and Swap unavailable when the eligibility lookup fails', async ({
  walletA,
  steps
}) => {
  await walletA.createNewWallet();
  await setEligibilityFixtureState('unavailable');
  // The decision is made once per page realm, so the reload is what makes the wallet ask again.
  await walletA.lockWallet();

  await steps.step(
    'wallet_opens_without_access_gate',
    async () => {
      await walletA.waitFor('[data-testid="unlock-passcode"]', { timeoutMs: 30_000 });
      expect(await walletA.evaluate(() => document.querySelector('[data-testid="wallet-access-gate"]') === null)).toBe(
        true
      );
    },
    { screenshotWallets: [{ target: walletA, label: 'A' }] }
  );

  await walletA.unlockWallet();

  await steps.step(
    'earn_reads_service_down',
    async () => {
      await walletA.navigateTo('/earn');
      await walletA.waitFor(EARN_SERVICE_DOWN, { timeoutMs: 30_000 });
    },
    { screenshotWallets: [{ target: walletA, label: 'A' }] }
  );

  await steps.step(
    'swap_reads_service_down',
    async () => {
      await walletA.navigateTo('/swap');
      await walletA.waitFor(SWAP_SERVICE_DOWN, { timeoutMs: 30_000 });
      expect(await walletA.evaluate(() => document.querySelector('[data-testid="wallet-access-gate"]') === null)).toBe(
        true
      );
    },
    { screenshotWallets: [{ target: walletA, label: 'A' }] }
  );
});
