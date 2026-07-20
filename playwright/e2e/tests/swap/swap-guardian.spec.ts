import { expect, test } from '../../fixtures/two-wallets';
import {
  createSwapOrder,
  fillSwapOrder,
  fundSwapPair,
  readLineage,
  readMakerTags,
  tokenBalance
} from '../../helpers/swap';

// Endpoint of the guardian spawned by the CI job / local stack (--profile
// guardian). Matches guardian-send-consume.spec.ts.
const GUARDIAN_URL = process.env.GUARDIAN_URL ?? 'http://localhost:3000';

/**
 * Scenario 3.9 — swap from a Guardian (multisig) maker account.
 *
 * A is a Guardian-backed account (3-key auth, wallet signs + guardian co-signs
 * + multisig verifies on-chain); B is a standard taker. A offers 10 SWPA for 9
 * SWPB and B fills fully. This exercises the two guardian-co-signed legs the
 * standard-account scenarios can't: the `pswapCreate` that mints the maker note
 * and the P2ID payback claim. B's fill is a normal vault-signed consume.
 *
 * KNOWN-FAILING (test.fixme) — a guardian maker's public PSWAP note is never
 * discoverable by the taker. Root-caused end-to-end on the local stack:
 *   - Guardian account create, funding, and the guardian-cosigned `pswapCreate`
 *     all succeed: the guardian canonicalizes A's account DELTA on-chain (the
 *     offered asset leaves A's vault; guardian log: "Canonicalizing delta
 *     (commitment matches on-chain)").
 *   - But B never receives the note. B subscribes to the maker's real, sole
 *     sent-note tag and syncs for 120s, yet `notes.list()` stays at just B's own
 *     note (`list=1`).
 *   - Mechanism: the guardian submits account STATE DELTAS, not full txs, so the
 *     public output note is never registered in the node's tag-indexed note
 *     store. The offered asset is locked in a note no taker can find — the order
 *     is un-fillable.
 * This is a guardian/node/SDK-side gap, not a harness issue (standard-account
 * makers work — see swap-full-fill*.spec.ts). The test is written and ready:
 * drop `.fixme` and re-add the guardian bring-up to pr-e2e-swap.yml once guardian
 * makers publish discoverable notes. See docs/superpowers/plans/notes/R0-findings.md.
 */
test.describe('swap: guardian maker full fill', () => {
  test.describe.configure({ mode: 'serial' });

  const OFFER_BASE = '1000000000'; // 10 SWPA
  const REQUEST_BASE = '900000000'; // 9 SWPB

  test.fixme('guardian A offers 10 SWPA for 9 SWPB, B fills fully; both sides settle', async ({
    walletA,
    walletB,
    midenCli,
    timeline
  }) => {
    // Guardian flows make many HTTP round-trips (create + co-signed pswapCreate +
    // co-signed payback claim) on top of funding + settlement polls. 12 min.
    test.setTimeout(720_000);

    const a = await walletA.createGuardianWallet(GUARDIAN_URL);
    const b = await walletB.createNewWallet();

    const pair = await fundSwapPair(
      midenCli,
      walletA,
      walletB,
      { offerSymbol: 'SWPA', requestSymbol: 'SWPB', balanceTimeoutMs: 220_000 },
      timeline
    );

    const orderId = await createSwapOrder(walletA, {
      offerSymbol: 'SWPA',
      requestSymbol: 'SWPB',
      payAmount: '10',
      receiveAmount: '9'
    });
    expect(orderId, 'guardian maker order id').not.toBe('');

    // A guardian maker can have several sent notes; subscribe B to every tag so
    // the swap note is among the synced notes regardless of ordering.
    const tagsU32 = await readMakerTags(walletA);
    console.log(`[guardian] maker sent tags: ${JSON.stringify(tagsU32)}`);

    const fill = await fillSwapOrder({
      taker: walletB,
      takerAddress: b.address,
      orderId,
      offer: pair.offer,
      request: pair.request,
      offerAmount: OFFER_BASE,
      requestAmount: REQUEST_BASE,
      fillAmount: REQUEST_BASE,
      tagsU32
    });
    expect(fill.ok, `taker fill failed: ${fill.error}`).toBe(true);

    // Settlement 1: the guardian maker's order lineage is fully filled on-chain.
    await expect
      .poll(async () => (await readLineage(walletA, orderId)).state, { timeout: 120_000, intervals: [4000] })
      .toBe('filled');

    // Settlement 2: taker received the full offered SWPA.
    await expect
      .poll(async () => (await tokenBalance(walletB, b.address, pair.offer.faucetId)).toString(), {
        timeout: 90_000,
        intervals: [3000]
      })
      .toBe(OFFER_BASE);

    // Settlement 3: guardian maker claims the P2ID payback (guardian co-signs the
    // consume) and receives the full requested SWPB.
    await walletA.claimAllNotes(220_000);
    await expect
      .poll(async () => (await tokenBalance(walletA, a.address, pair.request.faucetId)).toString(), {
        timeout: 120_000,
        intervals: [4000]
      })
      .toBe(REQUEST_BASE);
  });
});
