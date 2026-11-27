/**
 * Global teardown of the multi-device E2E suite (`playwright.multi-device.config.ts`).
 *
 * It stops the local wallet-api Worker that global setup started, makes sure that its port is free, and removes its
 * temporary directory. The Worker log in `test-results/wallet-api/` stays for the artifact upload. With an external
 * Worker, global setup writes no state file, and this does nothing.
 */
import { stopWalletApiDevServerFromState } from './wallet-api-dev-server';

export default async function multiDeviceGlobalTeardown(): Promise<void> {
  const statePath = process.env.E2E_WALLET_API_STATE_FILE;
  if (statePath === undefined || statePath === '') return;
  await stopWalletApiDevServerFromState(statePath);
  delete process.env.E2E_WALLET_API_STATE_FILE;
}
