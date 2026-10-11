import { expect, test } from '../../fixtures/two-wallets';
import { newArcKey, recordArcKey } from '../../helpers/arc-usdcx';
import { enText } from '../../helpers/bridge';
import { BURN_UNITS } from '../../helpers/usdcx-constants';
import { guardianFailureContext, guardianIdentity } from '../../helpers/usdcx-guardian';
import {
  assertBurnDetails,
  attachEvidence,
  confirmBurn,
  createGuardianUsdcxWallet,
  fundFromPublicFaucet,
  pageWhere,
  resolveUsdcxIds,
  settleGuardian,
  submitBurn
} from '../../helpers/usdcx-legs';
import { anyOf, assertUsdcxLiveRun, namedSteps, newRunEvidence, type StepContext } from '../../helpers/usdcx-run';

/** Step budgets of spec section 5, steps 1 and 3 to 7. */
const BUDGET = {
  wallet: 180_000,
  fund: 180_000,
  settle: 240_000,
  burnViaUi: 180_000,
  burnRowPoll: 180_000,
  burnConfirmed: 300_000
} as const;

/**
 * A burn through Send on a fresh standard wallet and a fresh Guardian wallet, each funded by one public faucet grant
 * (USDCx is the testnet fee asset). Run only through `yarn e2e:real --suite usdcx-burn`. Circle's payout is the `usdcx`
 * suite's gate; the burn's key is still kept in the ledger, so its USDC can be recovered.
 */
test.describe('USDCx burn through the Send UI after a public faucet grant', () => {
  // The injected fee faucet masks the wallet's own native-asset discovery (two-wallets.ts:840).
  test.use({ injectFeeFaucet: false });
  test.describe.configure({ timeout: 1_500_000 });
  test.beforeAll(() => assertUsdcxLiveRun(process.env, { needsArcKey: false }));

  for (const guardian of [false, true]) {
    test(`${guardian ? 'Guardian' : 'standard'} wallet publishes a burn and the faucet consumes it`, async ({
      walletA,
      envConfig,
      steps
    }) => {
      const step = namedSteps(steps);
      const where = pageWhere(walletA);
      const evidence = newRunEvidence(`usdcx-burn ${guardian ? 'guardian' : 'standard'}`);
      const secrets: string[] = [];
      let passed = false;
      try {
        const { ids, onGuardian } = await step(
          'wallet',
          BUDGET.wallet,
          async () => {
            const identity = guardian ? await guardianIdentity(envConfig.guardianUrl) : null;
            const address = guardian
              ? await createGuardianUsdcxWallet(walletA, envConfig.guardianUrl)
              : (await walletA.createNewWallet()).address;
            const context: StepContext | undefined = identity ? () => guardianFailureContext(identity) : undefined;
            return { ids: await resolveUsdcxIds(walletA.page, address), onGuardian: context };
          },
          async () => (guardian ? `guardian ${envConfig.guardianUrl}` : '')
        );
        evidence.ids.address = ids.address;
        evidence.ids.native = ids.native;

        const funding = await step(
          'fund',
          BUDGET.fund,
          () => fundFromPublicFaucet(walletA.page, ids, envConfig.rpcUrl, where),
          onGuardian
        );
        evidence.fees.push(funding.f0);
        evidence.ids.grantNote = funding.grantNoteId;
        // A Guardian burn is not requeued on a pending-delta 409 (transaction/index.ts:196-202): the grant settles first.
        evidence.settleMs.grant = guardian
          ? await step('settle_grant', BUDGET.settle, () => settleGuardian(walletA, 120_000), onGuardian)
          : 0;

        const key = newArcKey();
        secrets.push(key.privateKey);
        evidence.ids.ledgerPath = recordArcKey(key, ids.address);
        evidence.ids.arcKey = key.address;

        const priorBurns = await step(
          'burn_via_ui',
          BUDGET.burnViaUi,
          () =>
            submitBurn(walletA, ids, {
              destination: key.address,
              units: BURN_UNITS,
              screenshotDir: test.info().outputDir
            }),
          onGuardian
        );
        const burn = await step(
          'burn_confirmed',
          BUDGET.burnConfirmed,
          async () => {
            const burn = await confirmBurn(walletA, ids, {
              priorRowIds: priorBurns,
              destination: key.address,
              units: BURN_UNITS,
              vaultBefore: funding.vault,
              rpcUrl: envConfig.rpcUrl,
              guardian,
              timeoutMs: BUDGET.burnRowPoll,
              where
            });
            await assertBurnDetails(walletA, burn.row.id, key.address);
            await walletA.page.screenshot({ path: test.info().outputPath('usdcx-burn-confirmed.png') });
            // The row, not page state, drives the pill, so a reload of the details page reads the same.
            await walletA.page.reload();
            await expect(walletA.page.getByTestId('history-status-pill')).toHaveText(
              anyOf([enText('usdcxBurnConfirmed'), enText('confirmed')])
            );
            await walletA.navigateHome();
            return burn;
          },
          onGuardian
        );
        evidence.ids.burnRow = burn.row.id;
        evidence.ids.burnNote = burn.burnNoteId;
        evidence.hashes.burnTransaction = burn.row.transactionId ?? 'none';
        evidence.fees.push(burn.fee, { name: 's', amount: burn.sponsorship, kind: 'exact' });
        evidence.phases.burn = burn.phases.samples();
        passed = true;
      } finally {
        await attachEvidence(test.info(), 'usdcx-burn-evidence.json', evidence, secrets).catch((error: unknown) => {
          if (passed) throw error;
        });
      }
    });
  }
});
