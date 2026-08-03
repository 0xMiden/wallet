import { expect, test } from '../fixtures/two-wallets';

/**
 * Proves the guardian fault-injection layer actually reaches guardian HTTP
 * calls made from the extension's SERVICE WORKER (not just page-level
 * fetches). `createGuardianWallet` derives the account's guardian pubkey via
 * `guardianClient.getPubkey('ecdsa')` (`GET /pubkey`), which runs inside the
 * background service worker -- the fixture's `context.route` MUST intercept
 * that SW-originated request for this to fail fast instead of hanging.
 */
test.describe('Guardian fault injection', () => {
  test('armed guardian fault surfaces to the wallet', async ({ walletA }) => {
    walletA.armGuardianFault({ path: 'pubkey', mode: 'status500', target: 'B' });

    // Creating a guardian wallet against B fetches B's /pubkey -> should fail
    // fast (surfaced as a rejected promise), not hang.
    await expect(walletA.createGuardianWallet('http://localhost:3001')).rejects.toBeTruthy();

    walletA.clearFaults();
  });
});
