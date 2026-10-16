import { expect, test } from '../../fixtures/two-wallets';
import { arcEndpoints, arcHost, readXReserveDomainState, type ArcReadDeps } from '../../helpers/arc-usdcx';
import {
  ARBITRUM_SEPOLIA_PAYOUT,
  ARC_READ_STEP_BUDGET_MS,
  BASE_SEPOLIA_PAYOUT,
  BURN_UNITS,
  PAYOUT_TIMEOUT_MS,
  USDCX_REMOTE_DOMAIN,
  WALLET_CONFIRM_TIMEOUT_MS,
  type PayoutChain
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
  submitBurn,
  walletConfirmsPayout
} from '../../helpers/usdcx-legs';
import {
  assertUsdcxLiveRun,
  namedSteps,
  newRunEvidence,
  takeRunArcKey,
  type StepContext
} from '../../helpers/usdcx-run';

/** Step budgets of spec section 5, steps 1 to 8b, as usdcx-burn.spec.ts and the round trip set them. */
const BUDGET = {
  wallet: 180_000,
  // Each read step outlasts a stall on every endpoint before the last one answers, on Arc and on each L2.
  arcState: ARC_READ_STEP_BUDGET_MS,
  fund: 180_000,
  settle: 240_000,
  keySnapshot: ARC_READ_STEP_BUDGET_MS,
  burnViaUi: 180_000,
  burnRowPoll: 180_000,
  burnConfirmed: 300_000,
  payout: PAYOUT_TIMEOUT_MS + 120_000,
  walletPayoutConfirmed: WALLET_CONFIRM_TIMEOUT_MS + 60_000
} as const;

const SETTLE_WAIT_MS = 120_000;
/** Ethereum Sepolia stays out: Circle never pays a burn out there, and payoutChainFor refuses it. */
const DESTINATIONS: readonly PayoutChain[] = [BASE_SEPOLIA_PAYOUT, ARBITRUM_SEPOLIA_PAYOUT];

/**
 * A burn through Send from a fresh Guardian wallet to the harness key's address on Base Sepolia, and one on Arbitrum
 * Sepolia, each funded by one public faucet grant. Run only through `yarn e2e:real --suite usdcx-burn-l2`. Each test
 * ends only once Circle has paid its own burn on that L2 (R22) and the wallet itself reads Confirmed.
 */
test.describe('USDCx L2 burn through the Send UI after a public faucet grant', () => {
  // The injected fee faucet masks the wallet's own native-asset discovery (two-wallets.ts:840).
  test.use({ injectFeeFaucet: false });
  // ~2 min setup + 35.5 min of step budgets (15.5 to the submit, 5 to confirm the burn, the 10 min gate and its 2 min
  // closing read, 3 for the wallet's confirmation) <= 38 min.
  test.describe.configure({ timeout: 2_280_000 });
  test.beforeAll(() => {
    assertUsdcxLiveRun(process.env);
    takeRunArcKey(process.env);
  });

  for (const chain of DESTINATIONS) {
    test(`Guardian wallet burns to ${chain.networkName}, the faucet consumes it, Circle pays it out and the wallet confirms it`, async ({
      walletA,
      envConfig,
      steps
    }) => {
      const step = namedSteps(steps);
      const arc: ArcReadDeps = { endpoints: arcEndpoints(process.env.E2E_ARC_RPC_URL) };
      const reads: ArcReadDeps = { endpoints: chain.rpcUrls, payoutChain: chain };
      const where = pageWhere(walletA);
      const evidence = newRunEvidence(`usdcx-burn-l2 ${chain.reviewNetwork}`);
      const secrets: string[] = [];
      let passed = false;
      try {
        const { identity, ids } = await step(
          'wallet',
          BUDGET.wallet,
          async () => {
            const identity = await guardianIdentity(envConfig.guardianUrl);
            const address = await createGuardianUsdcxWallet(walletA, envConfig.guardianUrl);
            return { identity, ids: await resolveUsdcxIds(walletA.page, address) };
          },
          async () => `guardian ${envConfig.guardianUrl}`
        );
        const onGuardian: StepContext = () => guardianFailureContext(identity);
        evidence.ids.address = ids.address;
        evidence.ids.native = ids.native;

        // On Arc for every destination: Miden's xReserve domain is what pays any burn out, and the depositor it names is
        // the source every L2 payout carries.
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
        evidence.settleMs.grant = await step(
          'settle_grant',
          BUDGET.settle,
          () => settleGuardian(walletA, SETTLE_WAIT_MS),
          onGuardian
        );

        // R21, R22 on the L2: the harness key's address there, read right before the burn on the harness's endpoints.
        const { key, snapshot, waitForPayout } = await harnessPayoutLeg(step, {
          env: process.env,
          arc,
          payoutReads: reads,
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
              screenshotDir: test.info().outputDir,
              payoutChain: chain
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
              guardian: true,
              timeoutMs: BUDGET.burnRowPoll,
              where,
              payoutChain: chain
            });
            await assertBurnDetails(walletA, burn.row.id, key.address, chain);
            await walletA.page.screenshot({ path: test.info().outputPath('usdcx-burn-confirmed.png') });
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

        const payout = await waitForPayout(burn, xreserve.depositor);
        const walletConfirmedAt = await step('wallet_payout_confirmed', BUDGET.walletPayoutConfirmed, () =>
          walletConfirmsPayout(walletA, burn, payout, key, reads, chain, where, evidence)
        );
        evidence.latenciesMs.payoutToWalletConfirmation =
          walletConfirmedAt - (burn.oracle.consumeTimestampSec * 1_000 + payout.latencyMs);
        passed = true;
      } finally {
        await attachEvidence(test.info(), 'usdcx-burn-l2-evidence.json', evidence, secrets).catch((error: unknown) => {
          if (passed) throw error;
        });
      }
    });
  }
});
