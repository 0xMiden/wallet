import { expect, test } from '../../fixtures/multi-device';
import {
  vaultBalanceByFaucetId,
  waitForVaultBalanceByFaucetId,
  walletDiscoveredNativeFaucetId
} from '../../helpers/balance-truth';
import { expectNoFailedRows, setupSharedAccount, waitForSignerCount } from '../../helpers/multi-device';
import {
  completedClaimsPerNote,
  describeClaimRows,
  expectedBalanceAfterClaims,
  feesOf,
  grantNativeNote,
  isLiveStatus,
  isOwnRow,
  namesNote,
  pollUntil,
  publicFaucetGrant,
  readClaimRows,
  readListedNotes,
  setAutoConsume,
  toJsonText,
  unexplainedFailedClaims,
  type ClaimRow
} from '../../helpers/multi-device-claims';

/**
 * Auto-consume on both devices of one Guardian account, several notes. Auto-consume takes only native standard
 * payments (`isUnattendedNativeNote` in src/lib/miden/front/auto-managed-notes.ts, and the copy of that rule in the
 * service worker, `sync-manager.ts`), so the notes are grants of the native asset from the public faucet, not CLI
 * mints of a test token.
 *
 * Each device sees each note at about the same time and queues its own claim. The gate stops a claim when the
 * other device's proposal is already on the Guardian. When both devices read the proposals before either one posted,
 * both propose and one loses with another error and keeps a Failed row: a known limit (repo CLAUDE.md, "One note,
 * several devices", Known limits). Two auto-consumers that see the same note within seconds are exactly that race, so
 * this spec allows a Failed claim row only when the other device completed every note it names, records each such
 * row, and fails on any other Failed row.
 *
 * Asserted: every note is claimed exactly once over both devices (one Completed row of the device that made it), no
 * claim row stays in progress, neither device lists a note, and the native vault on both devices equals the
 * baseline plus the grants minus the fees that the Completed claims recorded.
 *
 * Accounts: the shared account. Fee-paying transactions: A's fee-funding claim, B's add rotation, and one to three
 * claims (the auto-consumers batch the notes they see in one lap).
 */

const GRANTS = 3;
const SETTLE_BEFORE_MS = 240_000;
const BALANCE_AGREE_MS = 180_000;
const CLAIMS_DONE_MS = 900_000;
const BALANCE_MS = 240_000;
const TEST_BUDGET_MS = 2_400_000;

test.describe('Multi-device claims: auto-consume on two devices', () => {
  test('several native notes are each claimed once when both devices auto-consume', async ({
    walletA,
    walletB,
    midenCli,
    steps,
    timeline,
    envConfig
  }) => {
    test.setTimeout(TEST_BUDGET_MS);
    let address = '';
    let nativeFaucetId = '';
    let baseline = 0n;
    let baselineSec = 0;
    const grantNotes: string[] = [];
    let grantAmount = 0n;

    await steps.step('create_on_a_and_add_b', async () => {
      const shared = await setupSharedAccount({ creator: walletA, joiner: walletB, midenCli, role: 'add' });
      address = shared.address;
      await waitForSignerCount(walletB, address, 3);
    });

    await steps.step('auto_consume_on_for_both_devices', async () => {
      await setAutoConsume(walletA, true);
      await setAutoConsume(walletB, true);
    });

    await steps.step('baseline_native_balance', async () => {
      await walletA.waitForQueueDrained(SETTLE_BEFORE_MS);
      await walletB.waitForQueueDrained(SETTLE_BEFORE_MS);
      const nativeA = await walletDiscoveredNativeFaucetId(walletA.page);
      const nativeB = await walletDiscoveredNativeFaucetId(walletB.page);
      expect(nativeA, 'A must know the native faucet').not.toBeNull();
      expect(nativeB, 'both devices read the same native faucet').toBe(nativeA);
      nativeFaucetId = nativeA ?? '';
      // Both devices read the same vault. Wait until they agree, twice in a row, so neither shows an old sync.
      let previous: bigint | null = null;
      const agreed = await pollUntil(
        walletA.page,
        async () => {
          const a = await vaultBalanceByFaucetId(walletA.page, nativeFaucetId);
          const b = await vaultBalanceByFaucetId(walletB.page, nativeFaucetId);
          const stable = a === b && previous === a;
          previous = a === b ? a : null;
          return { a, b, stable };
        },
        reading => reading.stable,
        { what: 'A and B read the same native balance twice in a row', timeoutMs: BALANCE_AGREE_MS, intervalMs: 3_000 }
      );
      baseline = agreed.a;
      baselineSec = Math.floor(Date.now() / 1000);
    });

    await steps.step('grant_native_notes_to_the_shared_account', async () => {
      const grant = await publicFaucetGrant(envConfig.name);
      grantAmount = grant.amount;
      for (let index = 0; index < GRANTS; index++) {
        grantNotes.push(await grantNativeNote(grant, address, envConfig.rpcUrl));
      }
      timeline.emit({
        category: 'blockchain_state',
        severity: 'info',
        message: `Granted ${GRANTS} native notes of ${grantAmount} base units to ${address}`,
        data: { grantNotes, grantAmount: grantAmount.toString() }
      });
    });

    await steps.step(
      'every_note_is_claimed_once',
      async () => {
        const settled = await pollUntil(
          walletA.page,
          async () => {
            const rowsA = await readClaimRows(walletA);
            const rowsB = await readClaimRows(walletB);
            const listedA = await readListedNotes(walletA);
            const listedB = await readListedNotes(walletB);
            return { rowsA, rowsB, listedA, listedB };
          },
          ({ rowsA, rowsB, listedA, listedB }) => {
            const counts = completedClaimsPerNote([rowsA, rowsB], grantNotes);
            const namesAGrant = (row: ClaimRow): boolean => grantNotes.some(n => namesNote(row.noteIds, n));
            const live = [...rowsA, ...rowsB].some(
              row => row.type === 'consume' && isLiveStatus(row.status) && namesAGrant(row)
            );
            const listed = [...listedA, ...listedB].some(note => grantNotes.some(n => namesNote([note.id], n)));
            return !live && !listed && grantNotes.every(noteId => (counts[noteId] ?? 0) >= 1);
          },
          {
            what: 'every granted note is claimed, no claim of one is in progress, and no device lists one',
            timeoutMs: CLAIMS_DONE_MS,
            intervalMs: 5_000,
            describe: ({ rowsA, rowsB, listedA, listedB }) =>
              `A rows:\n  ${describeClaimRows(rowsA)}\nB rows:\n  ${describeClaimRows(rowsB)}\n` +
              `A lists: ${listedA.map(note => note.id).join(', ') || '(none)'}\n` +
              `B lists: ${listedB.map(note => note.id).join(', ') || '(none)'}`
          }
        );

        const { rowsA, rowsB } = settled;
        const counts = completedClaimsPerNote([rowsA, rowsB], grantNotes);
        expect(counts, 'each note has exactly one Completed claim over both devices').toEqual(
          Object.fromEntries(grantNotes.map(noteId => [noteId, 1]))
        );

        // Failed claims: only the known-limit shape is allowed, and each one is recorded.
        const sinceBaseline = (row: ClaimRow): boolean => (row.initiatedAt ?? 0) >= baselineSec;
        const failedA = rowsA.filter(row => row.status === 'Failed' && sinceBaseline(row));
        const failedB = rowsB.filter(row => row.status === 'Failed' && sinceBaseline(row));
        expect(
          [...unexplainedFailedClaims(failedA, [rowsB]), ...unexplainedFailedClaims(failedB, [rowsA])],
          'a Failed claim is allowed only when the other device completed every note it names (known limit)'
        ).toEqual([]);
        await test.info().attach('known-limit-failed-claims.json', {
          body: toJsonText({ failedA, failedB }),
          contentType: 'application/json'
        });
        timeline.emit({
          category: 'ui_assertion',
          severity: failedA.length + failedB.length > 0 ? 'warn' : 'info',
          message: `Auto-consume race: ${failedA.length} Failed claim row(s) on A, ${failedB.length} on B (known limit)`
        });
        // No other row fails.
        await expectNoFailedRows(walletA, row => row.type !== 'consume');
        await expectNoFailedRows(walletB, row => row.type !== 'consume');

        // The money: each grant credited once, less the fees the Completed claims paid.
        const completed = [...rowsA, ...rowsB].filter(
          row => row.type === 'consume' && isOwnRow(row) && row.status === 'Completed' && sinceBaseline(row)
        );
        expect(
          completed.filter(row => !row.noteIds.every(noteId => grantNotes.some(n => namesNote([noteId], n)))),
          'after the baseline, the only completed claims are claims of the granted notes'
        ).toEqual([]);
        const { fees, withoutFee } = feesOf(completed, nativeFaucetId);
        expect(
          withoutFee,
          `each completed claim records the fee it paid in the native asset:\n  ${describeClaimRows(withoutFee)}`
        ).toEqual([]);
        const expected = expectedBalanceAfterClaims(
          baseline,
          grantNotes.map(() => grantAmount),
          fees
        );
        await waitForVaultBalanceByFaucetId(walletA.page, nativeFaucetId, expected, { timeoutMs: BALANCE_MS });
        await waitForVaultBalanceByFaucetId(walletB.page, nativeFaucetId, expected, { timeoutMs: BALANCE_MS });
        timeline.emit({
          category: 'blockchain_state',
          severity: 'info',
          message: `Native vault ${baseline} + ${GRANTS} x ${grantAmount} - fees ${fees.join(' + ')} = ${expected}`,
          data: { baseline: baseline.toString(), expected: expected.toString(), fees: fees.map(String) }
        });
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
