import { getEnvironmentConfig } from '../config/environments';
import { expect, test } from '../fixtures/two-wallets';
import { snapshotTransfer } from '../helpers/assertions';
import { toBaseUnits, waitForPendingNoteTotal, waitForVaultBalance } from '../helpers/balance-truth';

// The faucet the harness deploys (miden-cli.ts createFaucet defaults: TST / 8dp).
const TOKEN = 'TST';
const TOKEN_DECIMALS = 8;

// Every amount this spec moves, in base units, derived from what it actually
// mints/sends below — the mint calls take these constants directly and the send
// calls take the human strings, so an assertion can never drift from the action.
const INITIAL_MINT_BASE_UNITS = 100_000_000_000n; // 1000 TST funded on A before the switch
const POST_SWITCH_MINT_BASE_UNITS = 50_000_000_000n; // 500 TST minted again AFTER the switch
const USABLE_SEND_AMOUNT = '10'; // TST, sent A -> B on guardian B
const FAULTED_SEND_AMOUNT = '1'; // TST, sent A -> B with guardian A faulted

// Guardian operators for the selected network (E2E_NETWORK): the two local
// containers on localhost, real operators on testnet (OpenZeppelin A -> Koda B).
const envConfig = getEnvironmentConfig();
const A = envConfig.guardianUrl;
if (!envConfig.guardianUrlB) {
  throw new Error(`E2E_NETWORK=${envConfig.name} has no second guardian (guardianUrlB) configured for switch tests`);
}
const B = envConfig.guardianUrlB;

/**
 * Guardian commitment (the on-chain `GUARDIAN_SLOT_NAMES.PUBLIC_KEY` value)
 * for a given guardian operator, read straight from its own `GET
 * /pubkey?scheme=ecdsa` endpoint -- the same source `assertGuardianAuth`'s
 * `guardianCommitment` expectation is compared against (see the doc comment
 * on `assertGuardianAuth` in `helpers/wallet-page.ts`).
 */
async function guardianCommitment(endpoint: string): Promise<string> {
  const res = await fetch(`${endpoint}/pubkey?scheme=ecdsa`);
  if (!res.ok) {
    throw new Error(`guardianCommitment: GET ${endpoint}/pubkey?scheme=ecdsa failed with HTTP ${res.status}`);
  }
  const body = (await res.json()) as { commitment: string };
  return body.commitment;
}

/**
 * Guardian switch happy path: an existing Guardian account (created + funded
 * against guardian A) switches its guardian to B, stays usable on B (both a
 * post-switch consume AND a send to a third wallet require B's
 * co-signature), and the switch survives a wallet close/reopen (extension
 * SW respawn) -- proving the new guardian is durably persisted per-account,
 * not just an in-memory artifact of the session that performed the switch.
 *
 * The design plan's naive assertion -- `assertGuardianAuth(pk, {signerCount:
 * 2, threshold: 2})` alone -- can NOT actually prove a switch happened:
 * signerCount/threshold describe the multisig's `[hot, cold]` signer set and
 * its `update_guardian` procedure threshold, and a guardian switch never
 * touches either -- only the SEPARATE guardian-commitment storage slot
 * changes. Every assertion below therefore also pins `guardianCommitment` to
 * the target guardian's real `/pubkey` commitment (asserted against A's
 * BEFORE the switch, and against B's after the switch and after reopen).
 *
 * The plan's "usable on B" step also called for a SELF-send, but the wallet
 * deliberately blocks that (`SendManager.tsx`'s `cannotSendToSelf` guard -- a
 * P2IDE-to-self doesn't consume cleanly through the note-script kernel), so
 * a self-send can never reach the send-review submit button. Sending to a
 * second, independent wallet (mirroring `guardian-send-consume.spec.ts`) is
 * both the only flow the product allows AND a strictly better usability
 * proof -- it's a real value transfer to a third party, not a same-account
 * round-trip.
 */
test.describe('Guardian switch - happy path + usability', () => {
  test('switch A to B completes, usable on B, survives reopen', async ({ walletA, walletB, midenCli, steps }) => {
    // Guardian round-trips (create, switch, consume, send) each carry their
    // own multi-second canonicalization wait against the local guardian --
    // comfortable headroom over the base config's 300s default, mirroring
    // guardian-send-consume.spec.ts's budget for a similarly guardian-heavy
    // flow.
    test.setTimeout(600_000);

    const commitmentA = await guardianCommitment(A);
    const commitmentB = await guardianCommitment(B);
    expect(commitmentA, 'guardian A and B must be distinct operators for this test to mean anything').not.toBe(
      commitmentB
    );

    let addressA: string;
    let addressB: string;
    let faucetId: string;

    await steps.step('create_on_a_and_fund', async () => {
      const createdA = await walletA.createGuardianWallet(A);
      addressA = createdA.address;
      const createdB = await walletB.createNewWallet();
      addressB = createdB.address;

      await midenCli.init();
      faucetId = await midenCli.createFaucet();
      await midenCli.mint(faucetId, addressA, INITIAL_MINT_BASE_UNITS, 'public');
      await midenCli.sync();

      await walletA.claimAllNotes(180_000);
      // Funding gate, not the assertion under test — but exact: the claim must
      // have moved the WHOLE mint into A's spendable vault before the switch
      // steps run. `claimAllNotes` returns on its own deadline whether or not
      // the guardian-co-signed consume actually landed, so without this a
      // silently-failed consume would only surface much later as a confusing
      // send failure.
      await waitForVaultBalance(walletA.page, TOKEN, INITIAL_MINT_BASE_UNITS, {
        timeoutMs: 120_000,
        decimals: TOKEN_DECIMALS
      });
    });

    await steps.step('verify_on_a_before_switch', async () => {
      // Baseline: freshly created, still on guardian A.
      await walletA.assertGuardianAuth(addressA!, { signerCount: 2, threshold: 2, guardianCommitment: commitmentA });
    });

    await steps.step(
      'switch_to_b',
      async () => {
        await walletA.switchGuardian(B);
        // The switch changes the guardian commitment while the signer set /
        // update_guardian threshold stay [hot,cold] / 2 -- this is the
        // assertion that actually proves the switch landed (see the
        // describe-level doc comment).
        await walletA.assertGuardianAuth(addressA!, { signerCount: 2, threshold: 2, guardianCommitment: commitmentB });
      },
      {
        screenshotWallets: [{ target: walletA.page, label: 'A' }]
      }
    );

    await steps.step(
      'usable_on_b',
      async () => {
        // Consume-under-B: mint a fresh note AFTER the switch and drain it,
        // exercising createConsumeNotesProposal against the NEW guardian.
        await midenCli.mint(faucetId!, addressA!, POST_SWITCH_MINT_BASE_UNITS, 'public');
        await midenCli.sync();
        await walletA.claimAllNotes(120_000);
        // The consume-under-B half of "usable on B": A's spendable TST must now
        // be the pre-switch funding PLUS the whole post-switch mint. A consume
        // that the new guardian never co-signed leaves the note unconsumed and
        // the vault short, which this catches and `> 0` on a vault+pending sum
        // could not (the unconsumed note kept that number identical).
        await waitForVaultBalance(walletA.page, TOKEN, INITIAL_MINT_BASE_UNITS + POST_SWITCH_MINT_BASE_UNITS, {
          timeoutMs: 120_000,
          decimals: TOKEN_DECIMALS
        });

        // Send-under-B: exercises createSendProposal against the NEW
        // guardian, and lands a real value transfer on a third wallet.
        const sent = toBaseUnits(USABLE_SEND_AMOUNT, TOKEN_DECIMALS);
        const before = await snapshotTransfer(
          { page: walletA.page, label: 'A' },
          { page: walletB.page, label: 'B' },
          TOKEN,
          TOKEN_DECIMALS
        );
        await walletA.sendTokens({
          recipientAddress: addressB!,
          amount: USABLE_SEND_AMOUNT,
          isPrivate: false,
          tokenSymbol: TOKEN
        });
        // Recipient side: B is credited EXACTLY 10 TST. It lands as an
        // UNCONSUMED note — the wallet only auto-consumes native-faucet notes
        // (sync-manager.ts / Explore.tsx) and B never claims — so "the transfer
        // arrived" is a pending-note credit here, asserted on its own rather
        // than summed into a balance.
        await waitForPendingNoteTotal(walletB.page, TOKEN, before.toPending + sent, {
          timeoutMs: 120_000,
          decimals: TOKEN_DECIMALS
        });
        // Sender side: A is debited by exactly the same amount (Miden fees are
        // paid in the native asset, never in TST). This is the half that catches
        // a "recipient credited without the sender being debited" bug.
        await waitForVaultBalance(walletA.page, TOKEN, before.fromVault - sent, {
          timeoutMs: 120_000,
          decimals: TOKEN_DECIMALS
        });
      },
      {
        screenshotWallets: [
          { target: walletA.page, label: 'A' },
          { target: walletB.page, label: 'B' }
        ]
      }
    );

    await steps.step('close_and_reopen_still_on_b', async () => {
      await walletA.reopen(); // forces the extension's service worker to respawn
      await walletA.assertGuardianAuth(addressA!, { signerCount: 2, threshold: 2, guardianCommitment: commitmentB });
      await expect(walletA.currentGuardianEndpoint()).resolves.toBe(B);
    });
  });
});

/**
 * Cross-guardian correctness: after a switch A -> B, the wallet must route
 * every subsequent co-sign exclusively through B and never contact A again.
 * "Usable on B" (the happy-path describe above) only proves a send SUCCEEDS
 * post-switch -- it doesn't rule out the wallet still consulting the OLD
 * guardian alongside (or instead of) the new one. This test tells the two
 * apart by making A actively hostile post-switch (an armed HTTP fault) and
 * asserting the send still lands: if the wallet were still routing to A,
 * the fault would surface as a send failure / hang; a routing-correct
 * wallet never calls A at all, so the fault is inert and the send via B
 * succeeds.
 *
 * Scope boundary (per the design doc / Product-Fix Protocol): this asserts
 * WALLET-observable behavior only -- which guardian the wallet contacts and
 * whether the tx completes. It does NOT assert `released_at` or any other
 * old-guardian server-side state; that split-brain gap is tracked
 * server-side as `OpenZeppelin/guardian#369` and is out of scope here.
 */
test.describe('Guardian switch - cross-guardian correctness', () => {
  test('after switch, wallet co-signs only with B (A no longer authoritative for new txs)', async ({
    walletA,
    walletB,
    midenCli,
    steps
  }) => {
    test.setTimeout(600_000);

    const commitmentB = await guardianCommitment(B);

    let addressA: string;
    let addressB: string;
    let faucetId: string;

    await steps.step('create_on_a_and_fund', async () => {
      const createdA = await walletA.createGuardianWallet(A);
      addressA = createdA.address;
      const createdB = await walletB.createNewWallet();
      addressB = createdB.address;

      await midenCli.init();
      faucetId = await midenCli.createFaucet();
      await midenCli.mint(faucetId, addressA, INITIAL_MINT_BASE_UNITS, 'public');
      await midenCli.sync();

      await walletA.claimAllNotes(180_000);
      // Same exact funding gate as the happy-path test: the whole mint must be
      // spendable on A before the fault-injection step, so a later send failure
      // can only be attributed to routing, never to A being unfunded.
      await waitForVaultBalance(walletA.page, TOKEN, INITIAL_MINT_BASE_UNITS, {
        timeoutMs: 120_000,
        decimals: TOKEN_DECIMALS
      });
    });

    await steps.step(
      'switch_to_b',
      async () => {
        await walletA.switchGuardian(B);
        // Precondition for the fault-injection step below to mean anything:
        // confirm the switch actually landed (guardian commitment now B's)
        // BEFORE arming a fault on A, so a subsequent send failure can only
        // be attributed to mis-routing, not an incomplete switch.
        await walletA.assertGuardianAuth(addressA!, { signerCount: 2, threshold: 2, guardianCommitment: commitmentB });
      },
      {
        screenshotWallets: [{ target: walletA.page, label: 'A' }]
      }
    );

    await steps.step(
      'post_switch_send_with_a_faulted',
      async () => {
        // Fault every call to A. The guardian propose/sign round-trip lives
        // under `/delta/proposal` -- there is no distinct `/proposals` or
        // `/sign` endpoint on the wire (see guardian-fault.ts's
        // GuardianFaultPath doc comment), so faulting propose/sign is done
        // via `path: 'delta'`, which matches every `/delta*` sub-route.
        walletA.armGuardianFault({ target: 'A', path: 'delta', mode: 'abort' });

        // A real value transfer to a second, independent wallet -- must
        // succeed via B alone. If the wallet still contacted A for this
        // tx's co-sign, A's aborted /delta calls would surface as a send
        // failure or hang and the recipient balance would never arrive.
        const sent = toBaseUnits(FAULTED_SEND_AMOUNT, TOKEN_DECIMALS);
        const before = await snapshotTransfer(
          { page: walletA.page, label: 'A' },
          { page: walletB.page, label: 'B' },
          TOKEN,
          TOKEN_DECIMALS
        );
        await walletA.sendTokens({
          recipientAddress: addressB!,
          amount: FAULTED_SEND_AMOUNT,
          isPrivate: false,
          tokenSymbol: TOKEN
        });
        // Exactly 1 TST reaches B as an unconsumed note (B never claims, and
        // only native-faucet notes auto-consume), and exactly 1 TST leaves A's
        // vault. Both halves are what make "the send went through on B alone"
        // falsifiable: a `> 0` recipient check stayed green for the wrong
        // amount, the wrong token, or a note that was already there.
        await waitForPendingNoteTotal(walletB.page, TOKEN, before.toPending + sent, {
          timeoutMs: 120_000,
          decimals: TOKEN_DECIMALS
        });
        await waitForVaultBalance(walletA.page, TOKEN, before.fromVault - sent, {
          timeoutMs: 120_000,
          decimals: TOKEN_DECIMALS
        });

        walletA.clearFaults();

        // Still authoritatively on B after the faulted send (not knocked
        // back to A, not left in some half-switched state).
        await walletA.assertGuardianAuth(addressA!, { signerCount: 2, threshold: 2, guardianCommitment: commitmentB });
      },
      {
        screenshotWallets: [
          { target: walletA.page, label: 'A' },
          { target: walletB.page, label: 'B' }
        ]
      }
    );
  });
});
