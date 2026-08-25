import { expect, test } from '../../fixtures/two-wallets';
import { bridgeOutFast, fundBridgeToken, inspectSentNote, readBridgedSendRows } from '../../helpers/bridge';
import { FakeEpochAllocator } from '../../helpers/fake-epoch-allocator';
import { newEvmDestination } from '../../helpers/sepolia';
import { swOf } from '../../helpers/swap';
import { AnvilInstance } from '../../ios/helpers/anvil';
import { installMockCompact } from '../../ios/helpers/evm-doubles';

/**
 * Bridge-OUT Fast (Epoch) from a GUARDIAN (multisig) account — hermetic, local.
 *
 * WHY THIS SPEC EXISTS: the standard-account `bridge-out-epoch.spec.ts` runs the
 * NON-guardian send path (`sendTransaction`), which always built a public P2IDE.
 * A guardian account instead routes through `generateGuardianTransaction`, whose
 * bridged-send branch once minted a plain PRIVATE P2ID (the multisig send proposal
 * is P2ID-only). The Epoch allocator rejected that — first "Miden note not found
 * on-chain" (private), then, once made public, "P2IDE reclaim window too small"
 * (a plain P2ID has no recall window). No E2E exercised that guardian branch, so
 * the bug shipped (#439). This test drives the guardian branch against hermetic
 * Epoch doubles and asserts the minted collateral note is exactly what the
 * allocator needs: a PUBLIC, recallable P2IDE. A regression to a private P2ID (or
 * any plain P2ID) fails the note-shape assertion at the end.
 *
 * Hermetic doubles (same wiring as earn-deposit.spec.ts — the earn deposit path
 * mints the same kind of Miden→allocator P2IDE note):
 *   - FakeEpochAllocator (:8548) — EPOCH_ALLOCATOR_URL (quote via
 *     `/checkIfDepositNeeded`, collateral config via `/miden-recipient`,
 *     allocation ack via `/compact`).
 *   - Anvil (:8545) + MockCompact — the single EVM read `solveIntent` does
 *     (`getForcedWithdrawalStatus` on The Compact).
 * The guardian co-signer is the local stack's `--profile guardian` container.
 *
 * These URLs are baked in at BUILD time (vite defines), so the ports here MUST
 * match the build-time env the CI job sets (EPOCH_ALLOCATOR_URL=…:8548,
 * E2E_EVM_RPC_URL=…:8545). EVM settlement is deliberately NOT asserted — there is
 * no real solver — because the bug is detectable at the note's mint-time
 * type/structure, which is the layer this test checks.
 */

const GUARDIAN_URL = process.env.GUARDIAN_URL ?? 'http://localhost:3000';

const ANVIL_PORT = 8545;
const ALLOCATOR_PORT = 8548;

/** ITransactionStatus.Completed — Queued(0) → GeneratingTransaction(1) → Completed(2) / Failed(3). */
const COMPLETED = 2;

const TOKEN_SYMBOL = 'GBRDG';
const BRIDGE_AMOUNT = '1'; // small, 6dp — a ~1-USDC-equivalent solver fill

test.describe('bridge-out Fast (Epoch) from a Guardian account', () => {
  test.describe.configure({ mode: 'serial' });

  let anvil: AnvilInstance;
  const allocator = new FakeEpochAllocator(ALLOCATOR_PORT);

  test.beforeAll(async () => {
    anvil = await AnvilInstance.start({ port: ANVIL_PORT });
    // The Compact stub: getForcedWithdrawalStatus → (Disabled, 0). The bridge-out
    // path does not broadcast an EVM tx (Miden collateral), so the USDC/AggLayer
    // doubles the bridge-in harness installs are not needed here.
    await installMockCompact(anvil.rpcUrl);
    await allocator.start();
  });

  test.afterAll(async () => {
    anvil?.stop();
    await allocator.stop();
  });

  test('guardian bridges a token out; the collateral note is a PUBLIC recallable P2IDE', async ({
    walletA,
    midenCli,
    timeline
  }) => {
    // Guardian co-signed proposal + prove/submit on top of funding. 12 min.
    test.setTimeout(720_000);

    await walletA.createGuardianWallet(GUARDIAN_URL);
    // Well above the helper's default: claiming the funding note on a Guardian
    // account is a MULTISIG consume, whose proof verifies several signatures and
    // so takes substantially longer than the single-signature consume the default
    // was sized for. Too small a budget abandons a consume that is still running
    // and reports it as a note that never claimed.
    await fundBridgeToken(midenCli, walletA, { symbol: TOKEN_SYMBOL, decimals: 6, balanceTimeoutMs: 420_000 }, timeline);

    // Arm smallocator PR #38 binding validation on POST /compact: the fake reads
    // the submitted collateral note's attachment felts from the wallet SW (the
    // persisted request bytes the guardian pipeline proves + submits) and 400s —
    // failing the bridge below — unless the attachment commits to the mandate.
    allocator.setNoteInspector(noteId =>
      swOf(walletA).evaluate(
        (id: string) =>
          (
            globalThis as unknown as { __TEST_NOTE_ATTACHMENT_FELTS__: (noteId: string) => Promise<string[] | null> }
          ).__TEST_NOTE_ATTACHMENT_FELTS__(id),
        noteId
      )
    );

    // The Sepolia leg isn't settled by the fake, so a fresh 0x recipient is fine.
    await bridgeOutFast(walletA, {
      destAddress: newEvmDestination(),
      tokenSymbol: TOKEN_SYMBOL,
      amount: BRIDGE_AMOUNT
    });

    // Miden leg: the guardian bridged-send row reaches Completed once the note
    // commits (guardian co-sign → prove → submit → completeBridgedSendTransaction).
    await expect
      .poll(async () => (await readBridgedSendRows(walletA.page)).find(r => r.status === COMPLETED)?.status ?? null, {
        timeout: 300_000,
        intervals: [3000]
      })
      .toBe(COMPLETED);

    const [row] = await readBridgedSendRows(walletA.page);
    expect(row?.extraInputs?.provider, 'Fast route uses the epoch provider').toBe('epoch');
    const noteId = row?.outputNoteIds?.[0];
    expect(noteId, 'committed collateral note id').toBeTruthy();

    // THE CRUX: the minted note must be a PUBLIC recallable P2IDE. The pre-fix
    // guardian path minted a private P2ID here, which fails every assertion below.
    const note = await inspectSentNote(walletA, noteId!);
    expect(note.ok, `note inspect failed: ${note.error}`).toBe(true);
    expect(note.isPublic, 'collateral note is public (the allocator must read it on-chain)').toBe(true);
    expect(note.isP2ide, 'collateral note is a recallable P2IDE (the allocator validates the recall window)').toBe(
      true
    );
    expect(note.isP2id, 'collateral note is NOT a plain P2ID').toBe(false);
  });
});
