/* eslint-disable no-empty-pattern -- Playwright parses the fixture function's source and requires
   the object destructuring pattern in its first argument; `async ({}, use)` is the required idiom. */
import { expect, test as base } from './two-wallets';
import { FakeBridgeConfig, localnetEpochDocument } from '../helpers/fake-bridge-config';

/**
 * The two-wallet fixture plus the served Epoch config document, for the hermetic suites that run
 * against the local fake allocator and positions service (Earn, Guardian Fast bridge-out). Worker
 * scoped and automatic, so the document is served before any wallet launches and reads it.
 */
export const test = base.extend<{}, { bridgeConfig: FakeBridgeConfig }>({
  bridgeConfig: [
    async ({}, use) => {
      const server = new FakeBridgeConfig();
      server.setDocument(localnetEpochDocument());
      await server.start();
      await use(server);
      await server.stop();
    },
    { scope: 'worker', auto: true }
  ]
});

export { expect };
