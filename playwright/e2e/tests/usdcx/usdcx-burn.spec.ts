import { expect, test } from '../../fixtures/two-wallets';
import { arcEndpoints, arcHost, readXReserveDomainState, type ArcReadDeps } from '../../helpers/arc-usdcx';
import { enText } from '../../helpers/bridge';
import {
  ARC_READ_STEP_BUDGET_MS,
  BURN_UNITS,
  PAYOUT_TIMEOUT_MS,
  USDCX_REMOTE_DOMAIN
} from '../../helpers/usdcx-constants';
import { guardianFailureContext, guardianIdentity } from '../../helpers/usdcx-guardian';
import {
  assertBurnDetails,
  attachEvidence,
  confirmBurn,
  createGuardianUsdcxWallet,
  fundFromPublicFaucet,
  harnessPayoutLeg,
  pageWhere,
  resolveUsdcxIds,
  settleGuardian,
  submitBurn
} from '../../helpers/usdcx-legs';
import {
  anyOf,
  assertUsdcxLiveRun,
  namedSteps,
  newRunEvidence,
  takeRunArcKey,
  type StepContext
} from '../../helpers/usdcx-run';

/** Step budgets of spec section 5, steps 1 to 8. */
const BUDGET = {
  wallet: 180_000,
  // Each Arc read step outlasts a stall on every endpoint before the last one answers.
  arcState: ARC_READ_STEP_BUDGET_MS,
  fund: 180_000,
  settle: 240_000,
  keySnapshot: ARC_READ_STEP_BUDGET_MS,
  burnViaUi: 180_000,
  burnRowPoll: 180_000,
  burnConfirmed: 300_000,
  payout: PAYOUT_TIMEOUT_MS + 120_000
} as const;

/**
 * A burn through Send on a fresh standard wallet and a fresh Guardian wallet, each funded by one public faucet grant
 * (USDCx is the testnet fee asset). Run only through `yarn e2e:real --suite usdcx-burn`. Both burns pay the harness Arc
 * key (R21), and each test ends only once Circle has paid its own burn (R22), so no payout is left to land in a later
 * run's payout window.
 */
test.describe('USDCx burn through the Send UI after a public faucet grant', () => {
  // The injected fee faucet masks the wallet's own native-asset discovery (two-wallets.ts:840).
  test.use({ injectFeeFaucet: false });
  // ~2 min setup + 32.5 min of Guardian step budgets (15.5 to the submit, 5 to confirm the burn, the 10 min gate and
  // its 2 min closing read) <= 35 min.
  test.describe.configure({ timeout: 2_100_000 });
  test.beforeAll(() => {
    assertUsdcxLiveRun(process.env);
    takeRunArcKey(process.env);
  });

  for (const guardian of [false, true]) {
    const kind = guardian ? 'Guardian' : 'standard';
    test(`${kind} wallet publishes a burn, the faucet consumes it and Circle pays it out`, async ({
      walletA,
      envConfig,
      steps
    }) => {
      const step = namedSteps(steps);
      const arc: ArcReadDeps = { endpoints: arcEndpoints(process.env.E2E_ARC_RPC_URL) };
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

        // Before the grant, so a bridge that cannot pay this burn out costs no grant and leaves no deferred payout.
        const xreserve = await step('arc_state', BUDGET.arcState, async () => {
          const state = await readXReserveDomainState(arc);
          expect(
            { registered: state.registered, paused: state.paused, withdrawalsPaused: state.withdrawalsPaused },
            `xReserve domain ${USDCX_REMOTE_DOMAIN} read on ${arcHost(state.endpoint)}`
          ).toEqual({ registered: true, paused: false, withdrawalsPaused: false });
          return state;
        });

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

        // R21, R22: the harness key, read right before the burn; this test's payout must be exactly the rise above it.
        const { key, snapshot, waitForPayout } = await harnessPayoutLeg(step, {
          env: process.env,
          arc,
          budget: BUDGET,
          evidence,
          secrets
        });

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
              keySnapshot: snapshot,
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

        await waitForPayout(burn, xreserve.depositor);
        passed = true;
      } finally {
        await attachEvidence(test.info(), 'usdcx-burn-evidence.json', evidence, secrets).catch((error: unknown) => {
          if (passed) throw error;
        });
      }
    });
  }
});
