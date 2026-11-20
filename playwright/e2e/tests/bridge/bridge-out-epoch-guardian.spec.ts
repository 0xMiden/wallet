import { expect, test as base } from '../../fixtures/hermetic-bridge';
import { waitForPendingNoteTotal, waitForVaultBalance } from '../../helpers/balance-truth';
import { inspectSentNote, readBridgedSendRows } from '../../helpers/bridge';
import { localnetEpochDocument } from '../../helpers/fake-bridge-config';
import { FakeEpochAllocator } from '../../helpers/fake-epoch-allocator';
import { readTransactionRows } from '../../helpers/history';
import { newEvmDestination } from '../../helpers/sepolia';
import { swOf } from '../../helpers/swap';
import { AnvilInstance } from '../../ios/helpers/anvil';
import { installMockCompact, installMockUsdc } from '../../ios/helpers/evm-doubles';

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
 *   - FakeEpochAllocator (:8548), the served document's `epoch.allocatorUrl`
 *     (quote via `/checkIfDepositNeeded`, collateral config via
 *     `/miden-recipient`, allocation ack via `/compact`, `/health`).
 *   - Anvil (:8545) + MockCompact + MockUsdc: the single EVM read `solveIntent`
 *     does (`getForcedWithdrawalStatus` on The Compact), and the wallet's config
 *     checks on the document's `epoch.evmUsdc`.
 * The guardian co-signer is the local stack's `--profile guardian` container.
 *
 * The hermetic-bridge fixture serves the document on :8550 (MIDEN_REMOTE_CONFIG_URL
 * at build time) and E2E_EVM_RPC_URL points EVM reads at :8545, so the ports here
 * MUST match the document and the CI job's build env. EVM settlement is
 * deliberately NOT asserted (there is no real solver), because the bug is
 * detectable at the note's mint-time type/structure, which is the layer this
 * test checks.
 */

const GUARDIAN_URL = process.env.GUARDIAN_URL ?? 'http://localhost:3000';

const ANVIL_PORT = 8545;
const ALLOCATOR_PORT = 8548;

/** ITransactionStatus.Completed — Queued(0) → GeneratingTransaction(1) → Completed(2) / Failed(3). */
const COMPLETED = 2;

const TOKEN_SYMBOL = 'GBRDG';
const BRIDGE_FUNDING = 1_000_000_000n;
const BRIDGE_AMOUNT = '1'; // small, 6dp — a ~1-USDC-equivalent solver fill

const test = base.extend<{ bridgeFaucetHex: string }>({
  bridgeFaucetHex: [
    async ({ midenCli, bridgeConfig }, use) => {
      await midenCli.init();
      const faucetHex = await midenCli.createFaucet(TOKEN_SYMBOL, 6);
      const document = localnetEpochDocument(faucetHex);
      document.version = 2;
      document.features.fastBridge = true;
      bridgeConfig.setDocument(document);
      await use(faucetHex);
    },
    // The config must name the generated faucet before either wallet starts.
    { auto: true }
  ]
});

test.describe('bridge-out Fast (Epoch) from a Guardian account', () => {
  test.describe.configure({ mode: 'serial' });

  let anvil: AnvilInstance;
  const allocator = new FakeEpochAllocator(ALLOCATOR_PORT);

  test.beforeAll(async () => {
    anvil = await AnvilInstance.start({ port: ANVIL_PORT });
    // The Compact stub: getForcedWithdrawalStatus → (Disabled, 0). The bridge-out
    // path does not broadcast an EVM tx (Miden collateral); MockUsdc is there for
    // the wallet's config checks on the document's `epoch.evmUsdc`.
    await installMockCompact(anvil.rpcUrl);
    await installMockUsdc(anvil.rpcUrl);
    await allocator.start();
  });

  test.afterAll(async () => {
    anvil?.stop();
    await allocator.stop();
  });

  test('guardian bridges a token out; the collateral note is a PUBLIC recallable P2IDE', async ({
    walletA,
    midenCli,
    bridgeFaucetHex
  }) => {
    // Guardian co-signed proposal + prove/submit on top of funding. 12 min.
    test.setTimeout(720_000);

    await walletA.createGuardianWallet(GUARDIAN_URL);
    await midenCli.mint(bridgeFaucetHex, await walletA.getAccountAddress(), BRIDGE_FUNDING, 'public');
    await midenCli.sync();
    await waitForPendingNoteTotal(walletA.page, TOKEN_SYMBOL, BRIDGE_FUNDING, {
      timeoutMs: 150_000,
      decimals: 6
    });
    await walletA.claimAllNotes(150_000);
    await walletA.refreshBalancesLanded(60_000);
    await waitForVaultBalance(walletA.page, TOKEN_SYMBOL, BRIDGE_FUNDING, { timeoutMs: 60_000, decimals: 6 });

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
    const destination = newEvmDestination();
    const commandUrl = `${walletA.page.url().split('#')[0]}#/bridge/deposit`;
    await walletA.page.goto(commandUrl, { waitUntil: 'domcontentloaded' });
    const shell = walletA.page.getByTestId('command-shell');
    const workbench = shell.getByTestId('command-workbench');
    const bridge = workbench.getByTestId('command-bridge');
    await expect(bridge).toBeVisible();
    await bridge.getByRole('radio', { name: 'Bridge in', exact: true }).click();
    await expect(
      bridge.getByText(
        'Epoch cannot quote a fixed source amount with the installed provider. Choose another provider to bridge in.'
      )
    ).toBeVisible();
    await expect(workbench.getByTestId('command-footer').getByRole('button', { name: 'Review Details' })).toBeDisabled();
    await bridge.getByRole('radio', { name: 'Bridge out', exact: true }).click();
    await bridge.getByRole('radio', { name: new RegExp(`${TOKEN_SYMBOL} to USDC`) }).click();
    const amount = bridge.getByRole('textbox', { name: 'Amount', exact: true });
    await amount.fill(BRIDGE_AMOUNT);
    await bridge.getByRole('textbox', { name: 'External account', exact: true }).fill(destination);
    const form = bridge.locator('form');
    await expect(form).toHaveCount(1);
    const formId = await form.getAttribute('id');
    if (!formId) throw new Error('Missing original Command Bridge form');
    const footer = workbench.getByTestId('command-footer');
    const review = footer.getByRole('button', { name: 'Review Details', exact: true });
    await expect(review).toHaveAttribute('type', 'submit');
    await expect(review).toHaveAttribute('form', formId);
    await expect(review).toBeEnabled();
    const beforeReview = await readTransactionRows(walletA.page);
    expect(await readBridgedSendRows(walletA.page)).toHaveLength(0);

    await amount.press('Enter');
    const confirm = footer.getByRole('button', { name: 'Confirm', exact: true });
    await expect(confirm).toBeEnabled();
    await expect(confirm).toHaveAttribute('type', 'submit');
    await expect(confirm).toHaveAttribute('form', formId);
    await expect(amount).toHaveCount(0);
    await expect(form.getByText(`${BRIDGE_AMOUNT} ${TOKEN_SYMBOL}`, { exact: true })).toBeVisible();
    await expect(form.getByText(destination, { exact: true })).toBeVisible();
    const details = workbench.getByTestId('command-details');
    await details.locator('summary').click();
    await expect(details.getByText('Epoch', { exact: true })).toBeVisible();
    expect((await readTransactionRows(walletA.page)).map(row => row.id)).toEqual(beforeReview.map(row => row.id));
    expect(await readBridgedSendRows(walletA.page)).toHaveLength(0);

    await confirm.focus();
    await expect(confirm).toBeFocused();
    await confirm.press('Enter');
    await walletA.page.keyboard.press('Enter');
    const status = footer.getByRole('button', { name: 'View transfer status', exact: true });
    await expect(status).toBeVisible({ timeout: 60_000 });
    await expect(status).toHaveAttribute('type', 'button');
    await expect(footer.locator('button[type="submit"]')).toHaveCount(0);
    await expect(bridge).toBeVisible();
    await expect(walletA.page).toHaveURL(commandUrl);
    const admittedRows = (await readTransactionRows(walletA.page)).filter(row => row.type === 'bridged-send');
    expect(admittedRows).toHaveLength(1);
    const admitted = admittedRows[0];
    if (!admitted) throw new Error('Missing original admitted Bridge row');
    const originalOperation = admitted.extraInputs?.bridgeOperation;
    expect(originalOperation).toMatchObject({
      version: 1,
      owner: 'wallet',
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      revision: expect.stringMatching(/^[0-9a-f-]{36}$/),
      walletScope: { network: 'localnet', rpcUrl: expect.stringMatching(/^http:\/\/(localhost|127\.0\.0\.1):/) },
      review: {
        amount: BRIDGE_AMOUNT,
        accounts: { midenAccount: admitted.accountId, evmAddress: destination },
        route: {
          provider: 'epoch',
          mode: 'send',
          source: { kind: 'miden', faucetId: bridgeFaucetHex },
          destination: { network: 'sepolia', symbol: 'USDC' }
        },
        quote: { kind: 'epoch' }
      }
    });
    expect(admitted.amount).toBe('1000000');

    // Miden leg: the guardian bridged-send row reaches Completed once the note
    // commits (guardian co-sign → prove → submit → completeBridgedSendTransaction).
    try {
      await expect
        .poll(async () => (await readBridgedSendRows(walletA.page)).find(r => r.status === COMPLETED)?.status ?? null, {
          timeout: 300_000,
          intervals: [3000]
        })
        .toBe(COMPLETED);
    } catch (pollError) {
      // "never reached Completed" is a symptom; the reason is on the row. Otherwise this reads
      // as `Expected 2, Received null` after a five-minute timeout, which says nothing about
      // why -- on a fee-charging chain that is usually an unpayable fee, and the kernel error
      // naming it is already persisted.
      const rows = await readTransactionRows(walletA.page).catch(() => []);
      const failed = rows
        .filter(r => r.status === 3)
        .map(
          r =>
            `\n    [${r.type ?? '?'} ${r.id.slice(0, 8)} stage=${r.stage ?? '?'}] ${r.error ?? '(no message)'}` +
            (r.rawError ? `\n      raw: ${r.rawError}` : '')
        )
        .join('');
      throw new Error(
        `${(pollError as Error).message}\n  bridged send never reached Completed.` +
          (failed.length > 0 ? `\n  failed rows:${failed}` : '\n  (no failed rows on this wallet)')
      );
    }

    const completedRows = await readBridgedSendRows(walletA.page);
    expect(completedRows).toHaveLength(1);
    const [row] = completedRows;
    expect(row?.id).toBe(admitted.id);
    expect(row?.transactionId, 'real original Miden source transaction').toMatch(/^0x[0-9a-fA-F]+$/);
    const originalRow = (await readTransactionRows(walletA.page)).find(item => item.id === admitted.id);
    expect(originalRow?.extraInputs?.bridgeOperation).toEqual(originalOperation);
    await expect(bridge).toBeVisible();
    await expect(walletA.page).toHaveURL(commandUrl);
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

    // A fullpage reload opens the original row, not a fresh source action. This fake has
    // acknowledged the Miden note but has never reported a Sepolia payout.
    await walletA.navigateTo(`/history-details/${admitted.id}`);
    const receipt = walletA.page.getByTestId('command-shell').getByTestId('command-workbench');
    await expect(receipt.getByTestId('history-status-pill')).toHaveText('Pending', { timeout: 30_000 });
    expect((await readBridgedSendRows(walletA.page)).map(item => item.id)).toEqual([admitted.id]);
    await expect(receipt.getByRole('button', { name: 'Confirm', exact: true })).toHaveCount(0);
  });
});
