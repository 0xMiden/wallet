import { FakeBridgeConfig, fetchPublishedDocument, testnetBridgeInDocument } from '../../helpers/fake-bridge-config';

/**
 * Serves the bridge-in suite's config document for the whole run. The app reads it from
 * `MIDEN_REMOTE_CONFIG_URL` (baked in by e2e-bridge-in.yml) as soon as it launches, so it has to be
 * up before any simulator starts the app. Its Miden side is the published testnet document's.
 */
export default async function bridgeInGlobalSetup(): Promise<() => Promise<void>> {
  const server = new FakeBridgeConfig();
  server.setDocument(testnetBridgeInDocument(await fetchPublishedDocument('testnet')));
  await server.start();
  // eslint-disable-next-line no-console
  console.log(`[ios-globalSetup] serving the bridge-in config document at ${server.baseUrl}/testnet.json`);
  return () => server.stop();
}
