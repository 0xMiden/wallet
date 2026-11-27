import { expect, test } from '../../fixtures/multi-device';
import { toBaseUnits, vaultBalance, waitForVaultBalance } from '../../helpers/balance-truth';
import { TOKEN, TOKEN_DECIMALS } from '../../helpers/money-path';
import { expectNoFailedRows, setupSharedAccount, waitForSignerCount } from '../../helpers/multi-device';
import {
  CLAIM_STARTED_ELSEWHERE_WINDOW_MS,
  acceptAllNotes,
  attemptClaim,
  claimRowsNaming,
  claimWindowOf,
  completedClaimsPerNote,
  describeAttempt,
  describeClaimRows,
  namesNote,
  passedProposal,
  pollUntil,
  readClaimRows,
  readListedNotes,
  recordGuardianProposalTraffic,
  sameNoteId,
  toJsonText,
  waitForAcceptableCard,
  waitForCompletedClaim,
  waitForNotesListed,
  waitForNotesUnlisted,
  windowPosition,
  type ClaimAttempt,
  type ClaimWindow
} from '../../helpers/multi-device-claims';

/**
 * A proposal that its device abandons, and a gate read that the Guardian does not answer.
 *
 * The Guardian keeps a proposal that its device abandoned. The gate of the other device therefore looks only at a
 * pending claim proposal younger than `CLAIM_STARTED_ELSEWHERE_WINDOW_MS` (2 min, `isClaimStartedElsewhere` in
 * src/lib/miden/guardian/claims-elsewhere.ts), against its own clock and the proposal's Guardian timestamp.
 *
 * 1. A taps Accept All on two notes: one claim row, one `consume_notes` proposal that names both. The harness holds
 *    A's sign request (`PUT /delta/proposal`); once the proposal is on the Guardian (`signing-proposal`) and the sign
 *    request reached the hold, A's whole browser is killed. Nothing was signed or submitted.
 * 2. Inside the window, B taps Accept on the first note: the gate stops it, the row is removed (not failed), and the
 *    note is still claimable.
 * 3. Inside the window, with B's gate read (`GET /delta/proposal?account_id=…`, the only request of that shape in a
 *    claim) answered with HTTP 500 by the harness, B taps Accept on the second note. "No answer from the Guardian lets
 *    the claim go ahead" (`claimStartedElsewhere`): the claim makes its proposal although A's pending proposal names
 *    the note, and it lands.
 * 4. B taps Accept on the first note again until a claim goes ahead. Every attempt that ends before the window can end
 *    must be removed, every attempt that starts after it surely ended must go ahead, and the last one lands. The
 *    vault rises once per note.
 *
 * The window end is known to within the time between the `creating-proposal` and `signing-proposal` stamps of A's row
 * (the proposal is made between them), plus `WINDOW_MARGIN_MS` for clock skew and poll delay.
 *
 * Accounts: the shared account and the CLI faucet. Fee-paying transactions of the wallets: A's fee-funding claim,
 * B's add rotation, and B's two claims. A's abandoned claim and B's removed attempts make none.
 */

const FIRST = toBaseUnits('12', TOKEN_DECIMALS);
const SECOND = toBaseUnits('21', TOKEN_DECIMALS);

const LISTED_MS = 300_000;
const CARD_MS = 180_000;
const PROPOSAL_ON_GUARDIAN_MS = 240_000;
// Longer than the rest of A's life: A's browser is killed a moment after the hold starts. Not longer, so the
// harness timer of the held request ends soon after the browser it belonged to.
const A_SIGN_HOLD_MS = 120_000;
const GATE_OUTCOME_MS = 120_000;
const CLAIM_LANDS_MS = 360_000;
const BALANCE_MS = 240_000;
const UNLISTED_MS = 240_000;
const WINDOW_MARGIN_MS = 15_000;
// The pace of B's attempts after the gated ones: a removed attempt costs the Guardian one read, not a proposal.
const ATTEMPT_PACE_MS = 15_000;
const LATE_ATTEMPTS_MS = CLAIM_STARTED_ELSEWHERE_WINDOW_MS + 420_000;
const TEST_BUDGET_MS = 3_000_000;

test.describe('Multi-device claims: an abandoned proposal and an unanswered gate read', () => {
  test('an abandoned claim proposal stops the other device for 2 min, and an unanswered gate read does not', async ({
    walletA,
    walletB,
    midenCli,
    steps,
    timeline,
    envConfig
  }) => {
    test.setTimeout(TEST_BUDGET_MS);
    let address = '';
    let first = '';
    let second = '';
    let window: ClaimWindow = { endLow: 0, endHigh: 0 };
    const trafficB = recordGuardianProposalTraffic(walletB, envConfig.guardianUrl);

    await steps.step('create_on_a_and_add_b', async () => {
      const shared = await setupSharedAccount({ creator: walletA, joiner: walletB, midenCli, role: 'add' });
      address = shared.address;
      await waitForSignerCount(walletB, address, 3);
    });

    await steps.step('mint_two_notes_to_the_shared_account', async () => {
      await midenCli.init();
      const faucetId = await midenCli.createFaucet();
      first = (await midenCli.mint(faucetId, address, FIRST, 'public')).noteId;
      second = (await midenCli.mint(faucetId, address, SECOND, 'public')).noteId;
      await midenCli.sync();
      await waitForNotesListed(walletA, [first, second], LISTED_MS);
      await waitForNotesListed(walletB, [first, second], LISTED_MS);
    });

    await steps.step(
      'a_proposes_a_claim_of_both_notes_and_is_killed_before_it_signs',
      async () => {
        // Accept All takes every listed note: the two notes must be all that A lists.
        const listed = await readListedNotes(walletA);
        expect(
          listed.filter(note => !sameNoteId(note.id, first) && !sameNoteId(note.id, second)).map(note => note.id),
          'A lists no other note'
        ).toEqual([]);
        const trafficA = recordGuardianProposalTraffic(walletA, envConfig.guardianUrl);
        walletA.armGuardianFault({ path: 'delta', method: 'PUT', mode: 'delay', delayMs: A_SIGN_HOLD_MS });
        await acceptAllNotes(walletA, [first, second], CARD_MS);
        const proposing = await pollUntil(
          walletA.page,
          async () => ({
            row: (await readClaimRows(walletA)).find(
              row =>
                row.type === 'consume' &&
                namesNote(row.noteIds, first) &&
                namesNote(row.noteIds, second) &&
                passedProposal(row)
            ),
            signHolds: walletA.guardianFaultHits()
          }),
          state => state.row !== undefined && state.row.status === 'GeneratingTransaction' && state.signHolds >= 1,
          {
            what: "A's one proposal of both notes is on the Guardian and its sign request is held",
            timeoutMs: PROPOSAL_ON_GUARDIAN_MS,
            intervalMs: 500
          }
        );
        if (proposing.row === undefined) throw new Error('unreachable: the poll returned without a proposing row');
        window = claimWindowOf(proposing.row);
        await trafficA.flush();
        trafficA.stop();
        await test.info().attach('a-abandoned-proposal.json', {
          body: toJsonText({ row: proposing.row, window, proposalPosts: trafficA.posts() }),
          contentType: 'application/json'
        });
        // The whole browser goes: the service worker that holds the sign request goes with it.
        await walletA.killBrowser();
        timeline.emit({
          category: 'test_lifecycle',
          severity: 'info',
          wallet: 'A',
          message:
            `A killed with its claim proposal pending; the gate window ends between ` +
            `${new Date(window.endLow).toISOString()} and ${new Date(window.endHigh).toISOString()}`
        });
      },
      { captureStateFrom: [{ target: walletB.page, label: 'B', extensionId: walletB.extensionId }] }
    );

    await steps.step(
      'inside_the_window_the_gate_stops_b',
      async () => {
        const attempt = await attemptClaim(walletB, first, {
          cardTimeoutMs: CARD_MS,
          outcomeTimeoutMs: GATE_OUTCOME_MS
        });
        timeline.emit({ category: 'ui_assertion', severity: 'info', wallet: 'B', message: describeAttempt(attempt) });
        expect(
          windowPosition({ from: attempt.clickedAt, to: attempt.settledAt }, window, WINDOW_MARGIN_MS),
          'harness timing: the first attempt must end before the window can end'
        ).toBe('inside');
        expect(attempt.outcome, `the gate stops B's claim: ${describeAttempt(attempt)}`).toBe('removed');
        // The note is still claimable, and B keeps no row for it.
        await waitForAcceptableCard(walletB, first, CARD_MS);
        const rowsB = await readClaimRows(walletB);
        expect(claimRowsNaming(rowsB, first), `removed, not failed:\n  ${describeClaimRows(rowsB)}`).toEqual([]);
        expect(await vaultBalance(walletB.page, TOKEN), 'nothing was claimed').toBe(0n);
      },
      { captureStateFrom: [{ target: walletB.page, label: 'B', extensionId: walletB.extensionId }] }
    );

    await steps.step(
      'an_unanswered_gate_read_lets_the_claim_go_ahead',
      async () => {
        // Only the gate's read: a GET with `account_id` right after `/delta/proposal`. The proposal post has no query.
        await walletB.armNetworkFault({ target: 'guardianA', path: '/delta/proposal?account_id=', mode: 'status500' });
        let attempt: ClaimAttempt;
        try {
          attempt = await attemptClaim(walletB, second, { cardTimeoutMs: CARD_MS, outcomeTimeoutMs: GATE_OUTCOME_MS });
          expect(await walletB.networkFaultHits(), "the fault answered B's gate read").toBeGreaterThanOrEqual(1);
        } finally {
          await walletB.clearFaults();
        }
        timeline.emit({ category: 'ui_assertion', severity: 'info', wallet: 'B', message: describeAttempt(attempt) });
        expect(attempt.outcome, `with no answer the claim goes ahead: ${describeAttempt(attempt)}`).toBe('proceeded');
        // The gate read came before the proposal, and both inside the window: an answered read would have stopped it.
        const proposedAt = attempt.lastRow?.stageStamps['signing-proposal'] ?? attempt.settledAt;
        expect(
          windowPosition({ from: attempt.clickedAt, to: proposedAt }, window, WINDOW_MARGIN_MS),
          'harness timing: the gate read of this attempt must fall inside the window'
        ).toBe('inside');

        await waitForCompletedClaim(walletB, second, CLAIM_LANDS_MS);
        await waitForVaultBalance(walletB.page, TOKEN, SECOND, { timeoutMs: BALANCE_MS, decimals: TOKEN_DECIMALS });
        await waitForNotesUnlisted(walletB, [second], UNLISTED_MS);
        // The next claim of B must not meet its own candidate on the Guardian.
        await walletB.waitForGuardianSettled();
      },
      { captureStateFrom: [{ target: walletB.page, label: 'B', extensionId: walletB.extensionId }] }
    );

    await steps.step(
      'after_the_window_b_claims_the_note',
      async () => {
        const attempts: ClaimAttempt[] = [];
        const deadline = window.endHigh + LATE_ATTEMPTS_MS;
        for (;;) {
          const attempt = await attemptClaim(walletB, first, {
            cardTimeoutMs: CARD_MS,
            outcomeTimeoutMs: GATE_OUTCOME_MS
          });
          attempts.push(attempt);
          timeline.emit({ category: 'ui_assertion', severity: 'info', wallet: 'B', message: describeAttempt(attempt) });
          if (attempt.outcome !== 'removed' || Date.now() >= deadline) break;
          // A removed attempt leaves the note claimable; wait for its card, then keep the pace of the attempts.
          await waitForAcceptableCard(walletB, first, CARD_MS);
          await walletB.page.waitForTimeout(Math.max(attempt.clickedAt + ATTEMPT_PACE_MS - Date.now(), 0));
        }
        await test.info().attach('b-attempts-on-the-abandoned-note.json', {
          body: toJsonText({ window, attempts }),
          contentType: 'application/json'
        });

        const position = (attempt: ClaimAttempt) =>
          windowPosition({ from: attempt.clickedAt, to: attempt.settledAt }, window, WINDOW_MARGIN_MS);
        const removedLate = attempts.filter(item => item.outcome === 'removed' && position(item) === 'outside');
        const passedEarly = attempts.filter(item => item.outcome !== 'removed' && position(item) === 'inside');
        expect(removedLate.map(describeAttempt), 'after the window the gate must not stop the claim').toEqual([]);
        expect(passedEarly.map(describeAttempt), 'inside the window the gate must stop the claim').toEqual([]);
        expect(attempts.map(attempt => attempt.outcome).at(-1), 'the last attempt goes ahead').toBe('proceeded');

        await waitForCompletedClaim(walletB, first, CLAIM_LANDS_MS);
        await waitForVaultBalance(walletB.page, TOKEN, FIRST + SECOND, {
          timeoutMs: BALANCE_MS,
          decimals: TOKEN_DECIMALS
        });
        await waitForNotesUnlisted(walletB, [first], UNLISTED_MS);
        const rowsB = await readClaimRows(walletB);
        expect(completedClaimsPerNote([rowsB], [first, second]), 'one Completed claim per note').toEqual({
          [first]: 1,
          [second]: 1
        });
        await expectNoFailedRows(walletB);
      },
      { captureStateFrom: [{ target: walletB.page, label: 'B', extensionId: walletB.extensionId }] }
    );

    await trafficB.flush();
    trafficB.stop();
    await test.info().attach('b-guardian-proposal-traffic.json', {
      body: toJsonText({ reads: trafficB.reads(), posts: trafficB.posts() }),
      contentType: 'application/json'
    });
  });
});
