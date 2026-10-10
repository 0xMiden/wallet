import { FakeBridgeConfig, fetchPublishedDocument, testnetBridgeInDocument } from '../helpers/fake-bridge-config';

/** Serve the bridge-in config document before mobile fixtures launch either wallet. */
export default async function bridgeInGlobalSetup(): Promise<() => Promise<void>> {
  const server = new FakeBridgeConfig();
  server.setDocument(testnetBridgeInDocument(await fetchPublishedDocument('testnet')));
  await server.start();
  // eslint-disable-next-line no-console
  console.log(`[bridge-in-globalSetup] serving the bridge-in config document at ${server.baseUrl}/testnet.json`);
  return () => server.stop();
}
