import { expect, test } from '../fixtures/two-wallets';
import { waitForPendingNoteTotal } from '../helpers/balance-truth';

// Endpoint of the guardian spawned by the CI job; see guardian-send-consume.spec.ts.
const GUARDIAN_URL = process.env.GUARDIAN_URL ?? 'http://localhost:3000';

const TOKEN = 'TST';
const TOKEN_DECIMALS = 8;
const MINT_BASE_UNITS = 100_000_000_000n;

/**
 * Abandoning a pushed-but-unexecuted candidate must release the account on whichever Guardian version this job runs:
 * by proposal id on 0.19, by nonce on an older one. The probe pushes the candidate, never executes it, and polls the
 * abandon to its end.
 */
test.describe('Guardian account - abandon', () => {
  test.describe.configure({ mode: 'serial' });

  test('abandon releases a pushed candidate on this Guardian', async ({ walletA, walletB, midenCli, steps }) => {
    test.setTimeout(600_000);

    let addressA: string;
    let addressB: string;
    let faucetId: string;

    await steps.step('create_wallets', async () => {
      const a = await walletA.createGuardianWallet(GUARDIAN_URL);
      const b = await walletB.createNewWallet();
      addressA = a.address;
      addressB = b.address;
    });

    await steps.step('deploy_and_fund', async () => {
      await midenCli.init();
      faucetId = await midenCli.createFaucet();
      await midenCli.mint(faucetId, addressA!, MINT_BASE_UNITS, 'public');
      await midenCli.sync();
      await waitForPendingNoteTotal(walletA.page, TOKEN, MINT_BASE_UNITS, {
        timeoutMs: 180_000,
        decimals: TOKEN_DECIMALS
      });
      await walletA.claimAllNotes(180_000);
    });

    await steps.step('abandon_pushed_candidate', async () => {
      const result = await walletA.guardianAbandonProbe(addressA!, addressB!, faucetId!);
      if ('error' in result) throw new Error(`guardian abandon probe failed: ${result.error}`);
      expect(result.status).toBe('abandoned');
      const { version } = await (await fetch(`${GUARDIAN_URL}/status`)).json();
      expect(result.legacy).toBe(Number(String(version).split('.')[1]) < 19);
    });
  });
});
