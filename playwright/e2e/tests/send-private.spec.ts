import { IS_LOCALNET } from '../config/environments';
import { expect, test } from '../fixtures/two-wallets';
import { LOCALNET_SDK_STORES } from '../harness/extension-network';
import { snapshotTransfer, type TransferSnapshot } from '../helpers/assertions';
import {
  fromBaseUnits,
  toBaseUnits,
  waitForPendingNoteTotal,
  waitForVaultBalance,
  waitForVaultDebit
} from '../helpers/balance-truth';

// The faucet the harness deploys (miden-cli.ts createFaucet defaults).
const TOKEN = 'TST';
const TOKEN_DECIMALS = 8;
// What `deploy_and_fund` mints to wallet A, in base units (the CLI takes base units).
const MINT_BASE_UNITS = 100_000_000_000n;
// What the send step transfers: the UI amount field takes a human amount.
const SEND_AMOUNT = '500';
const SEND_BASE_UNITS = toBaseUnits(SEND_AMOUNT, TOKEN_DECIMALS);

test.describe('Private Note Send', () => {
  test.describe.configure({ mode: 'serial' });

  test('wallet A sends tokens privately to wallet B via transport layer', async ({
    walletA,
    walletB,
    midenCli,
    envConfig,
    steps,
    timeline
  }) => {
    let addressA: string;
    let addressB: string;
    // Both wallets' readings taken immediately before the send, so the receipt
    // step asserts a DELTA rather than a bare non-zero number.
    let beforeSend: TransferSnapshot;

    await steps.step('create_wallets', async () => {
      const a = await walletA.createNewWallet();
      const b = await walletB.createNewWallet();
      addressA = a.address;
      addressB = b.address;
    });

    await steps.step('deploy_and_fund', async () => {
      await midenCli.init();
      const faucetId = await midenCli.createFaucet();
      await midenCli.mint(faucetId, addressA!, MINT_BASE_UNITS, 'public');
      await midenCli.sync();
    });

    await steps.step('sync_wallet_a', async () => {
      // Funding wait, made exact: the mint creates a NOTE, so its value is
      // UNCONSUMED until `claim_notes_wallet_a` runs — not spendable. Waiting
      // for exactly the minted amount fails if the wrong token, the wrong
      // amount, or nothing at all reached A; `> 0` on a vault+pending sum did not.
      await waitForPendingNoteTotal(walletA.page, TOKEN, MINT_BASE_UNITS, {
        timeoutMs: 120_000,
        decimals: TOKEN_DECIMALS
      });
      timeline.emit({
        category: 'blockchain_state',
        severity: 'info',
        message: `Wallet A funded: ${fromBaseUnits(MINT_BASE_UNITS, TOKEN_DECIMALS)} ${TOKEN} unconsumed`,
        data: { symbol: TOKEN, pendingBaseUnits: MINT_BASE_UNITS.toString() }
      });
    });

    await steps.step('claim_notes_wallet_a', async () => {
      await walletA.claimAllNotes(120_000);
      // The claim returns once the PENDING list reads empty twice — it does not wait
      // for the store's balances projection to catch up. Snapshotting before that
      // settles reads fromVault as 0n, making the sender-debit assertion below go
      // negative and fail a perfectly good run. Wait for the spendable vault to hold
      // the full claimed amount first. (Same guard send-public-local-prove uses.)
      await waitForVaultBalance(walletA.page, TOKEN, MINT_BASE_UNITS, {
        timeoutMs: 120_000,
        decimals: TOKEN_DECIMALS
      });
    });

    await steps.step(
      'send_private_note_a_to_b',
      async () => {
        // Snapshot both sides first — the receipt assertion below is expressed as
        // "B's pending went up by exactly the sent amount and A's vault went down
        // by at least it", which needs the pre-send readings.
        beforeSend = await snapshotTransfer(
          { page: walletA.page, label: 'A' },
          { page: walletB.page, label: 'B' },
          TOKEN,
          TOKEN_DECIMALS
        );

        await walletA.sendTokens({
          recipientAddress: addressB!,
          amount: SEND_AMOUNT,
          // Devnet's native MIDEN row (0 balance) now renders above the
          // CLI faucet's row — fee-asset discovery works on the 0.15 SDK —
          // so the default first-row click would pick the wrong token.
          tokenSymbol: TOKEN,
          isPrivate: true // Private payment toggle ON
        });
      },
      {
        screenshotWallets: [{ target: walletA.page, label: 'A' }]
      }
    );

    await steps.step(
      'verify_receipt_wallet_b_via_transport',
      async () => {
        // Private notes are delivered via the note transport layer.
        // Wallet B syncs and discovers the private note automatically.
        //
        // DISCOVERS — it does not claim it: auto-consume only covers native MIDEN
        // notes (Explore.tsx filters on `faucetId === midenFaucetId`), so a TST
        // note stays UNCONSUMED. The delivery is therefore an exact PENDING total,
        // not a vault balance; asserting the vault here would fail on a working
        // wallet, and the old `> 0` on vault+pending passed for any amount of any
        // token from any source.
        await waitForPendingNoteTotal(walletB.page, TOKEN, beforeSend.toPending + SEND_BASE_UNITS, {
          timeoutMs: 180_000,
          decimals: TOKEN_DECIMALS
        });
        timeline.emit({
          category: 'blockchain_state',
          severity: 'info',
          message: `Wallet B received private note: ${fromBaseUnits(SEND_BASE_UNITS, TOKEN_DECIMALS)} ${TOKEN} unconsumed`,
          data: { symbol: TOKEN, deliveredBaseUnits: SEND_BASE_UNITS.toString() }
        });

        // The other half of a transfer: A must actually have paid. "At least",
        // because a fee may also have left the account — but a credit to B with no
        // debit from A is a bug this now catches.
        // Waited, not read once — see the note in send-public.spec.ts: the recipient's
        // pending total and the sender's vault projection settle independently.
        // Pinned EXACTLY, not just "at least": a Miden fee is charged in the native
        // asset, never in TST, so the transfer is the only thing that can move this
        // balance. The `>=` this used to rely on passed for a send that debited 700
        // TST for a 500 TST transfer. It says nothing about the fee itself -- see
        // fee-accounting.spec.ts for that.
        const debited = await waitForVaultDebit(walletA.page, TOKEN, beforeSend.fromVault, SEND_BASE_UNITS, {
          timeoutMs: 120_000,
          decimals: TOKEN_DECIMALS
        });
        expect(debited, 'the transfer debit must be exactly the amount sent').toBe(SEND_BASE_UNITS);
      },
      {
        captureStateFrom: [
          { target: walletA.page, label: 'A', extensionId: walletA.extensionId },
          { target: walletB.page, label: 'B', extensionId: walletB.extensionId }
        ],
        screenshotWallets: [
          { target: walletA.page, label: 'A' },
          { target: walletB.page, label: 'B' }
        ]
      }
    );

    if (IS_LOCALNET) {
      await steps.step('rebuild_receiver_and_verify_private_note_after_browser_restart', async () => {
        expect(walletB.ownsProfile, 'IndexedDB loss must use an isolated test profile').toBe(true);
        const sdkStore = LOCALNET_SDK_STORES.get(envConfig.rpcUrl);
        if (!sdkStore) throw new Error('Localnet SDK database is unknown');
        const origin = `chrome-extension://${walletB.extensionId}`;
        const readIds = async (db: string, store: string, key: string): Promise<unknown[]> => {
          if (!(await walletB.listIndexedDBStores()).some(entry => entry.db === db && entry.store === store)) return [];
          const { json } = await walletB.dumpIndexedDBStore(db, store, 2);
          return (JSON.parse(json) as Record<string, unknown>[]).map(row => row[key]);
        };
        const accountIds = () => readIds(sdkStore, 'latestAccountHeaders', 'id');
        const noteIds = () => readIds(sdkStore, 'inputNotes', 'detailsCommitment');
        const generationIds = () => readIds('TridentMain', 'recovery', 'id');
        const journalHead = async () => (await walletB.dumpChromeStorage()).miden_recovery_v1_localnet_head;

        await expect.poll(journalHead).toBeGreaterThan(0);
        const accounts = await accountIds();
        const notes = await noteIds();
        expect(accounts).toEqual([expect.any(String)]);
        expect(notes).toEqual([expect.any(String)]);
        expect(await generationIds()).toEqual(['wallet']);

        // Keep the authoritative localhost node available while ruling out private-note refetch.
        await walletB.armNetworkFault({ target: 'transport', mode: 'connectionRefused' });
        try {
          await walletB.triggerSync(true);
          await expect.poll(() => walletB.networkFaultHits()).toBeGreaterThan(0);
          const protocol = await walletB.page.context().newCDPSession(walletB.page);
          try {
            await protocol.send('Storage.clearDataForOrigin', { origin, storageTypes: 'indexeddb' });
          } finally {
            await protocol.detach();
          }
          await expect.poll(accountIds).toEqual([]);
          await expect.poll(noteIds).toEqual([]);
          await expect.poll(generationIds).toEqual([]);
          await expect.poll(journalHead).toBeGreaterThan(0);

          await walletB.triggerSync(true);
          const rebuild = walletB.page.getByRole('button', { name: 'Rebuild from recovery data' });
          await expect(rebuild).toBeEnabled();
          await rebuild.click();
          await expect(walletB.page.getByRole('heading', { name: 'Wallet storage recovered' })).toBeVisible();
          await expect(walletB.page.getByRole('status')).toContainText('Verified 1 of 1 accounts and 1 of 1 notes.');
          expect(await accountIds()).toEqual(accounts);
          expect(await noteIds()).toEqual(notes);
          expect(await generationIds()).toEqual(['wallet']);
          await walletB.page.getByRole('button', { name: 'Continue', exact: true }).click();

          await walletB.killBrowser();
          expect(await walletB.reopen()).toBe(true);
          expect(await walletB.getAccountAddress()).toBe(addressB!);
          expect(await accountIds()).toEqual(accounts);
          expect(await noteIds()).toEqual(notes);
        } finally {
          await walletB.clearFaults();
        }

        await walletB.triggerSync(true);
        await waitForPendingNoteTotal(walletB.page, TOKEN, beforeSend.toPending + SEND_BASE_UNITS, {
          timeoutMs: 60_000,
          decimals: TOKEN_DECIMALS
        });
      });
    }
  });
});
