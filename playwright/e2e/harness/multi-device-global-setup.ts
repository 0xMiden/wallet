/**
 * Global setup of the multi-device E2E suite (`playwright.multi-device.config.ts`).
 *
 * When this returns, the wallet-api Worker answers at `E2E_WALLET_API_URL` (default `http://127.0.0.1:8787`) and
 * allows the origin of the extension build that the fixture loads. With `E2E_WALLET_API_EXTERNAL=true`, it starts
 * nothing and only checks the Worker at that URL, which must be a loopback http URL (the wallet ignores any other).
 *
 * Playwright gives the `process.env` values that global setup writes to the workers and to global teardown:
 *   - `E2E_WALLET_API_EXTENSION_ID`: the id that this setup allowed. The fixture's cross-check names it in an error.
 *   - `E2E_WALLET_API_LOG`: the Worker log, in `test-results/wallet-api/`.
 *   - `E2E_WALLET_API_STATE_FILE`: the process data that global teardown stops.
 */
import { startWalletApiDevServer } from './wallet-api-dev-server';

export default async function multiDeviceGlobalSetup(): Promise<void> {
  const server = await startWalletApiDevServer();
  process.env.E2E_WALLET_API_EXTENSION_ID = server.extensionId;
  if (server.logPath !== null) process.env.E2E_WALLET_API_LOG = server.logPath;
  if (server.statePath !== null) process.env.E2E_WALLET_API_STATE_FILE = server.statePath;
  const where = server.logPath === null ? '' : ` Log: ${server.logPath}`;
  console.log(
    `[wallet-api] ${server.external ? 'Using' : 'Started'} the Worker at ${server.baseUrl}. ` +
      `It allows ${server.origin}.${where}`
  );
}
