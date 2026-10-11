import { expect, test } from '../../fixtures/two-wallets';
import {
  arcEndpoints,
  readArcUsdcSnapshot,
  readXReserveDomainState,
  waitForGatewayPayout,
  type ArcReadDeps
} from '../../helpers/arc-usdcx';
import { enText } from '../../helpers/bridge';
import {
  ARC_CHAIN_ID,
  ARC_CIRCLE_DOMAIN,
  BURN_UNITS,
  minimumUsdcxPayout,
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
  pageWhere,
  payoutContext,
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
  arcState: 30_000,
  fund: 180_000,
  settle: 240_000,
  keySnapshot: 30_000,
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
  // At the worst, ~2 min of fixture setup, 14 min of steps up to the burn's submit, the 3 min row poll that sees the
  // faucet consume it, then the payout gate's 10 min from that consume and its closing read: about 30 min a test, so
  // the two stay within the usdcx config's hour.
  test.describe.configure({ timeout: 1_800_000 });
  test.beforeAll(() => {
    assertUsdcxLiveRun(process.env);
    takeRunArcKey(process.env);
  });

  for (const guardian of [false, true]) {
    test(`${guardian ? 'Guardian' : 'standard'} wallet publishes a burn and the faucet consumes it`, async ({
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
            `xReserve domain ${USDCX_REMOTE_DOMAIN} read on ${state.endpoint}`
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
        const { key, snapshot } = await step('key_snapshot', BUDGET.keySnapshot, async () => {
          const { key, role } = takeRunArcKey(process.env);
          secrets.push(key.privateKey);
          expect(role, 'usdcx-burn burns to the harness key').toBe('harness');
          return { key, snapshot: await readArcUsdcSnapshot(key.address, arc) };
        });
        evidence.ids.arcKey = key.address;
        evidence.ids.arcKeyRole = 'harness';
        evidence.ids.arcBalanceBefore = String(snapshot.balance);
        evidence.ids.arcSnapshotBlock = String(snapshot.blockNumber);

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

        const consumeTsMs = burn.oracle.consumeTimestampSec * 1_000;
        // D3 in delta mode (R22): one AttestationUsed log whose mint calldata carries the burn note id and whose value is
        // the key's whole rise above the pre-burn read. Red after 10 min means a user was not paid in time.
        const payout = await step(
          'payout',
          BUDGET.payout,
          () =>
            waitForGatewayPayout(
              {
                recipient: key.address,
                burnNoteId: burn.burnNoteId,
                burnUnits: BURN_UNITS,
                fromBlock: snapshot.blockNumber,
                balanceBefore: snapshot.balance,
                consumeTsMs,
                deadlineMs: consumeTsMs + PAYOUT_TIMEOUT_MS,
                depositor: xreserve.depositor,
                minimumValue: minimumUsdcxPayout(ARC_CHAIN_ID, BURN_UNITS)
              },
              arc
            ),
          payoutContext(arc, key, snapshot, burn)
        );
        expect({ domain: payout.sourceDomain, total: payout.value + payout.fee }).toEqual({
          domain: ARC_CIRCLE_DOMAIN,
          total: BURN_UNITS
        });
        evidence.hashes.payout = payout.transactionHash;
        evidence.fees.push({ name: 'circle payout fee', amount: payout.fee, kind: 'exact' });
        evidence.latenciesMs.consumeToPayout = payout.latencyMs;
        passed = true;
      } finally {
        await attachEvidence(test.info(), 'usdcx-burn-evidence.json', evidence, secrets).catch((error: unknown) => {
          if (passed) throw error;
        });
      }
    });
  }
});
