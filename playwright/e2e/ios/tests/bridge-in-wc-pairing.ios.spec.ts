import { expect, test } from '../fixtures/two-simulators';
import { WcCounterparty } from '../helpers/wc-counterparty';

/**
 * Bridge-IN WalletConnect pairing de-risk (REAL relay handshake, no EVM tx yet).
 *
 * Proves the app's native Reown plugin can pair with a headless WC counterparty:
 * the app creates a real pairing via the E2E `connectUri` hook (bypassing the QR
 * modal), the counterparty pairs off that `wc:` URI over the PUBLIC relay,
 * approves an `eip155:11155111` session for its viem account, and the app reports
 * `connected` with that account + chain. This is the make-or-break for the EVM
 * half of the harness; the deposit/signing flow builds on it.
 */
test.describe('Bridge-IN WalletConnect pairing (real relay handshake)', () => {
  test.describe.configure({ mode: 'serial' });

  test('the app pairs with a headless WC counterparty and reports connected', async ({ walletA, walletB, steps }) => {
    const cp = new WcCounterparty();

    await steps.step('create_wallet', async () => {
      await walletA.createNewWallet();
      await walletB.createNewWallet(); // fixture requires both sims up
    });

    try {
      await steps.step('connect', async () => {
        // Full WC handshake with retry — the public relay's subscribe can time out
        // mid-handshake on the shared free-tier projectId.
        await cp.connectWithRetry(
          () => walletA.reownConnectUri(),
          async () => (await walletA.reownState()).connected
        );
      });

      await steps.step('app_reports_connected', async () => {
        const state = await walletA.reownState();
        expect(state.connected, 'app reports connected').toBe(true);
        expect(state.address?.toLowerCase(), 'connected account').toBe(cp.address.toLowerCase());
        expect(state.chainId, 'connected chain').toBe(11155111);
      });
    } finally {
      await cp.stop();
    }
  });
});
