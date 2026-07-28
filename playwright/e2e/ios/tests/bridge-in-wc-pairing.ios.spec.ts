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
    let uri: string;

    await steps.step('create_wallet', async () => {
      await walletA.createNewWallet();
      await walletB.createNewWallet(); // fixture requires both sims up
    });

    try {
      await steps.step('start_counterparty', async () => {
        await cp.start();
      });

      await steps.step('app_creates_pairing', async () => {
        uri = await walletA.reownConnectUri();
        expect(uri, 'wc: pairing URI').toContain('wc:');
      });

      await steps.step('counterparty_pairs_and_approves', async () => {
        await cp.pair(uri!);
        await cp.connected; // resolves once the session is approved
      });

      await steps.step('app_reports_connected', async () => {
        await expect
          .poll(async () => (await walletA.reownState()).connected, { timeout: 60_000, intervals: [2000] })
          .toBe(true);
        const state = await walletA.reownState();
        expect(state.address?.toLowerCase(), 'connected account').toBe(cp.address.toLowerCase());
        expect(state.chainId, 'connected chain').toBe(11155111);
      });
    } finally {
      await cp.stop();
    }
  });
});
