import { expect, test } from '../../fixtures/multi-device';
import { toBaseUnits, vaultBalance, waitForVaultBalance } from '../../helpers/balance-truth';
import { TOKEN, TOKEN_DECIMALS } from '../../helpers/money-path';
import { expectNoFailedRows, setupSharedAccount, waitForSignerCount } from '../../helpers/multi-device';
import {
  acceptNote,
  attemptClaim,
  claimRowsNaming,
  completedClaimsPerNote,
  describeAttempt,
  describeClaimRows,
  namesNote,
  passedProposal,
  pendingClaimsNaming,
  pollUntil,
  prepareAccept,
  readClaimRows,
  recordGuardianProposalTraffic,
  toJsonText,
  waitForAcceptableCard,
  waitForClaimsOfNoteSettled,
  waitForCompletedClaim,
  waitForNoPendingCard,
  waitForNotesListed,
  waitForNotesUnlisted,
  type ClaimRow
} from '../../helpers/multi-device-claims';

/**
 * One Guardian account on two devices (B was added with the role "Add this device"). Three notes of a fresh token
 * arrive, and each device lists each one. The notes are not the native asset, so auto-consume never takes them
 * (`isUnattendedNativeNote` in src/lib/miden/front/auto-managed-notes.ts and the same rule in `sync-manager.ts`): every
 * claim here is a tap on Accept, and the auto-consume setting is left as it is.
 *
 * 1. A claims the first note while B lists it. The vault rises once on both devices, B stops listing the note, and B
 *    has no row for it.
 * 2. A starts the claim of the second note and its sign request is held in the harness after its proposal is on the
 *    Guardian (`signing-proposal`, and A's `PUT /delta/proposal` reached the fault). B then taps Accept. The gate of B
 *    sees A's pending proposal and the row of B is removed, not failed; the note stays claimable on B. Then A's sign
 *    goes on and A's claim lands.
 * 3. Both devices tap Accept on the third note at the same time. Exactly one claim lands. When both read the
 *    proposals before either posted, the loser keeps a failed row (a known limit in CLAUDE.md, "One note, several
 *    devices"), so the loser's rows are recorded and attached, and not asserted.
 *
 * Accounts: the shared account and the CLI faucet. Fee-paying transactions of the wallets: A's fee-funding claim,
 * B's add rotation, and the three claims that land (a removed claim makes no transaction; a known-limit loser can
 * submit one that the node refuses).
 */

const FIRST = toBaseUnits('11', TOKEN_DECIMALS);
const SECOND = toBaseUnits('22', TOKEN_DECIMALS);
const THIRD = toBaseUnits('33', TOKEN_DECIMALS);

// Budgets. Testnet with the delegated prover: a Guardian claim lands in one to three minutes.
const LISTED_MS = 300_000;
const CARD_MS = 180_000;
const CLAIM_LANDS_MS = 360_000;
const BALANCE_MS = 240_000;
const UNLISTED_MS = 240_000;
const PROPOSAL_ON_GUARDIAN_MS = 240_000;
// How long the harness holds A's sign request (`PUT /delta/proposal`) in step 2. B's tap, the loop pickup, the
// service load and the gate read take some seconds; this leaves a wide margin and stays far below the five-minute
// watchdog of the WASM hold that the sign runs in.
const A_SIGN_HOLD_MS = 90_000;
const GATE_OUTCOME_MS = 75_000;
// A loser of step 3 can wait in the queue for the Guardian history (90 s), behind a backpressure requeue.
const SIMULTANEOUS_SETTLE_MS = 480_000;
const TEST_BUDGET_MS = 3_000_000;

test.describe('Multi-device claims: manual claims of one note on two devices', () => {
  test('a note listed on both devices is claimed once: on one device, after a visible proposal, and at once', async ({
    walletA,
    walletB,
    midenCli,
    steps,
    timeline,
    envConfig
  }) => {
    test.setTimeout(TEST_BUDGET_MS);
    let address = '';
    const notes = { first: '', second: '', third: '' };

    await steps.step('create_on_a_and_add_b', async () => {
      const shared = await setupSharedAccount({ creator: walletA, joiner: walletB, midenCli, role: 'add' });
      address = shared.address;
      await waitForSignerCount(walletB, address, 3);
    });

    await steps.step('mint_three_notes_to_the_shared_account', async () => {
      await midenCli.init();
      const faucetId = await midenCli.createFaucet();
      notes.first = (await midenCli.mint(faucetId, address, FIRST, 'public')).noteId;
      notes.second = (await midenCli.mint(faucetId, address, SECOND, 'public')).noteId;
      notes.third = (await midenCli.mint(faucetId, address, THIRD, 'public')).noteId;
      await midenCli.sync();
    });

    await steps.step('both_devices_list_every_note', async () => {
      const all = [notes.first, notes.second, notes.third];
      await waitForNotesListed(walletA, all, LISTED_MS);
      await waitForNotesListed(walletB, all, LISTED_MS);
      // The token is new to the account: the vault holds none of it before a claim.
      expect(await vaultBalance(walletA.page, TOKEN), 'A holds no TST before a claim').toBe(0n);
      expect(await vaultBalance(walletB.page, TOKEN), 'B holds no TST before a claim').toBe(0n);
    });

    await steps.step(
      'a_claims_while_b_lists_the_note',
      async () => {
        await waitForAcceptableCard(walletB, notes.first, CARD_MS);
        await acceptNote(walletA, notes.first, CARD_MS);
        await waitForCompletedClaim(walletA, notes.first, CLAIM_LANDS_MS);

        // The vault rises by the note amount, once, on both devices.
        await waitForVaultBalance(walletA.page, TOKEN, FIRST, { timeoutMs: BALANCE_MS, decimals: TOKEN_DECIMALS });
        await waitForVaultBalance(walletB.page, TOKEN, FIRST, { timeoutMs: BALANCE_MS, decimals: TOKEN_DECIMALS });

        // B stops listing the note, in its service worker and on its screen.
        await waitForNotesUnlisted(walletB, [notes.first], UNLISTED_MS);
        await waitForNoPendingCard(walletB, notes.first, UNLISTED_MS);

        const rowsA = await readClaimRows(walletA);
        const rowsB = await readClaimRows(walletB);
        expect(
          claimRowsNaming(rowsB, notes.first),
          `B never claimed the note, so it has no claim row for it:\n  ${describeClaimRows(rowsB)}`
        ).toEqual([]);
        expect(completedClaimsPerNote([rowsA, rowsB], [notes.first])).toEqual({ [notes.first]: 1 });
        await expectNoFailedRows(walletA);
        await expectNoFailedRows(walletB);
        await walletA.waitForGuardianSettled();
      },
      {
        captureStateFrom: [
          { target: walletA.page, label: 'A', extensionId: walletA.extensionId },
          { target: walletB.page, label: 'B', extensionId: walletB.extensionId }
        ]
      }
    );

    await steps.step(
      'b_claim_after_a_proposal_is_on_the_guardian_is_removed',
      async () => {
        const trafficB = recordGuardianProposalTraffic(walletB, envConfig.guardianUrl);
        try {
          // Hold A's sign request: A's proposal is on the Guardian, A has not signed, and nothing is submitted.
          walletA.armGuardianFault({ path: 'delta', method: 'PUT', mode: 'delay', delayMs: A_SIGN_HOLD_MS });
          await acceptNote(walletA, notes.second, CARD_MS);
          const proposingRow = await pollUntil(
            walletA.page,
            async () => ({
              row: claimRowsNaming(await readClaimRows(walletA), notes.second).find(passedProposal),
              signHolds: walletA.guardianFaultHits()
            }),
            state => state.row !== undefined && state.row.status === 'GeneratingTransaction' && state.signHolds >= 1,
            {
              what: "A's proposal of the second note is on the Guardian and its sign request is held",
              timeoutMs: PROPOSAL_ON_GUARDIAN_MS,
              intervalMs: 500
            }
          );
          const holdStartedAt = walletA.guardianFaultHitTimes()[0] ?? Date.now();

          const attempt = await attemptClaim(walletB, notes.second, {
            cardTimeoutMs: CARD_MS,
            outcomeTimeoutMs: GATE_OUTCOME_MS
          });
          timeline.emit({
            category: 'ui_assertion',
            severity: 'info',
            wallet: 'B',
            message: `B claim while A's proposal is pending: ${describeAttempt(attempt)}`
          });
          expect(attempt.outcome, `B's claim must stop at the gate: ${describeAttempt(attempt)}`).toBe('removed');
          // A's proposal was pending for the whole attempt: A's sign request was still held when B's row left.
          expect(
            attempt.settledAt,
            `B's attempt must end while A's sign is held (from ${new Date(holdStartedAt).toISOString()})`
          ).toBeLessThan(holdStartedAt + A_SIGN_HOLD_MS);

          // The note stays claimable on B, and B keeps no row for it: removed, not failed.
          await waitForAcceptableCard(walletB, notes.second, CARD_MS);
          const rowsB = await readClaimRows(walletB);
          expect(
            claimRowsNaming(rowsB, notes.second),
            `the gate removes B's row; it must not stay or fail:\n  ${describeClaimRows(rowsB)}`
          ).toEqual([]);

          // Evidence for the report: what B's gate read on the Guardian during the attempt.
          await trafficB.flush();
          const gateReads = trafficB
            .reads()
            .filter(read => read.at >= attempt.clickedAt && read.at <= attempt.settledAt + 5_000);
          await test.info().attach('b-gate-reads-during-the-attempt.json', {
            body: toJsonText({
              proposingRowOfA: proposingRow.row,
              attempt,
              gateReads,
              readsNamingTheNote: gateReads.map(read => pendingClaimsNaming(read.pending, notes.second).length)
            }),
            contentType: 'application/json'
          });
        } finally {
          trafficB.stop();
          await walletA.clearFaults();
        }

        // A's held sign goes on, and A's claim lands.
        await waitForCompletedClaim(walletA, notes.second, CLAIM_LANDS_MS);
        const total = FIRST + SECOND;
        await waitForVaultBalance(walletA.page, TOKEN, total, { timeoutMs: BALANCE_MS, decimals: TOKEN_DECIMALS });
        await waitForVaultBalance(walletB.page, TOKEN, total, { timeoutMs: BALANCE_MS, decimals: TOKEN_DECIMALS });
        await waitForNotesUnlisted(walletB, [notes.second], UNLISTED_MS);
        await waitForNoPendingCard(walletB, notes.second, UNLISTED_MS);

        const rowsA = await readClaimRows(walletA);
        const rowsB = await readClaimRows(walletB);
        expect(completedClaimsPerNote([rowsA, rowsB], [notes.second])).toEqual({ [notes.second]: 1 });
        expect(claimRowsNaming(rowsB, notes.second), 'B has no row for the second note').toEqual([]);
        await expectNoFailedRows(walletA);
        await expectNoFailedRows(walletB);
        await walletA.waitForGuardianSettled();
      },
      {
        captureStateFrom: [
          { target: walletA.page, label: 'A', extensionId: walletA.extensionId },
          { target: walletB.page, label: 'B', extensionId: walletB.extensionId }
        ]
      }
    );

    await steps.step(
      'both_devices_claim_the_same_note_at_once',
      async () => {
        const tapA = await prepareAccept(walletA, notes.third, CARD_MS);
        const tapB = await prepareAccept(walletB, notes.third, CARD_MS);
        const [tappedA, tappedB] = await Promise.all([tapA(), tapB()]);

        const [rowsA, rowsB] = await waitForClaimsOfNoteSettled(
          [walletA, walletB],
          notes.third,
          SIMULTANEOUS_SETTLE_MS
        );
        const total = FIRST + SECOND + THIRD;
        // The money facts: one claim landed, and the vault rose by the note amount once.
        await waitForVaultBalance(walletA.page, TOKEN, total, { timeoutMs: BALANCE_MS, decimals: TOKEN_DECIMALS });
        await waitForVaultBalance(walletB.page, TOKEN, total, { timeoutMs: BALANCE_MS, decimals: TOKEN_DECIMALS });
        await waitForNotesUnlisted(walletA, [notes.third], UNLISTED_MS);
        await waitForNotesUnlisted(walletB, [notes.third], UNLISTED_MS);
        const seen = `A: ${describeClaimRows(rowsA ?? [])}\n  B: ${describeClaimRows(rowsB ?? [])}`;
        expect(
          completedClaimsPerNote([rowsA ?? [], rowsB ?? []], [notes.third]),
          `exactly one device completes the claim:\n  ${seen}`
        ).toEqual({ [notes.third]: 1 });

        // The loser's state is a known limit when both read the proposals before either posted: record it only.
        const record = (label: 'A' | 'B', rows: readonly ClaimRow[]) => ({
          device: label,
          rows: rows.map(row => ({
            id: row.id,
            status: row.status,
            stage: row.stage,
            error: row.error,
            rawError: row.rawError,
            claimedElsewhereCheckUntil: row.claimedElsewhereCheckUntil
          }))
        });
        const outcome = {
          tappedA,
          tappedB,
          tapGapMs: Math.abs(tappedA - tappedB),
          devices: [record('A', rowsA ?? []), record('B', rowsB ?? [])]
        };
        const loserFailed = [...(rowsA ?? []), ...(rowsB ?? [])].some(row => row.status === 'Failed');
        timeline.emit({
          category: 'ui_assertion',
          severity: loserFailed ? 'warn' : 'info',
          message: loserFailed
            ? 'Simultaneous claim: the losing device kept a Failed row (known limit, both read before either posted)'
            : 'Simultaneous claim: the losing device has no Failed row',
          data: outcome
        });
        await test.info().attach('simultaneous-claim-outcome.json', {
          body: toJsonText(outcome),
          contentType: 'application/json'
        });

        // No other row may fail on either device.
        await expectNoFailedRows(walletA, row => !namesNote(row.noteIds, notes.third));
        await expectNoFailedRows(walletB, row => !namesNote(row.noteIds, notes.third));
      },
      {
        captureStateFrom: [
          { target: walletA.page, label: 'A', extensionId: walletA.extensionId },
          { target: walletB.page, label: 'B', extensionId: walletB.extensionId }
        ]
      }
    );
  });
});
