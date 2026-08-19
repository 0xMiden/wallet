import { getEnvironmentConfig } from '../config/environments';
import { expect, test } from '../fixtures/two-wallets';
import { assertClaimed } from '../helpers/assertions';
import { pendingNoteTotal, vaultBalance, waitForPendingNoteTotal, waitForVaultBalance } from '../helpers/balance-truth';

// Primary guardian operator for the selected network (E2E_NETWORK): the local
// container on localhost, the real OpenZeppelin operator on testnet/devnet.
const A = getEnvironmentConfig().guardianUrl;

// The faucet the harness deploys (miden-cli.ts createFaucet defaults).
const TOKEN = 'TST';
const TOKEN_DECIMALS = 8;
// Minted to the account on walletA and claimed there, BEFORE the recovery.
const FUND_BASE_UNITS = 100_000_000_000n;
// Minted to the SAME account after it has been recovered on walletB, and
// claimed with the rotated [new-hot, cold] signer set -- the money movement
// this test actually exists to prove.
const RECOVERY_MINT_BASE_UNITS = 25_000_000_000n;
// Both claims land in the same account's vault, so this is what the recovered
// wallet must still hold after a service-worker respawn.
const RECOVERED_VAULT_BASE_UNITS = FUND_BASE_UNITS + RECOVERY_MINT_BASE_UNITS;

/**
 * Guardian commitment (the on-chain `GUARDIAN_SLOT_NAMES.PUBLIC_KEY` value)
 * for a given guardian operator, read straight from its own `GET
 * /pubkey?scheme=ecdsa` endpoint -- same helper as guardian-switch.spec.ts,
 * duplicated per that file's own precedent (no shared module between spec
 * files for this one helper).
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
 * Canonical BIP-39 test vector (11x "abandon" + "about") -- checksum-valid,
 * used throughout this repo's own test suites (e.g.
 * src/lib/miden/back/vault.test.ts, src/screens/onboarding/import-wallet-flow/
 * ImportSeedPhrase.test.tsx). Only used by the seed-entry-validation tests
 * below, which probe the ImportSeedPhrase screen in isolation and never carry
 * this mnemonic through an actual account recovery.
 */
const CANONICAL_VALID_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/**
 * Guardian recovery journey: an existing Guardian account (created + funded
 * against guardian A) is recovered on a completely SEPARATE, clean wallet
 * profile by walking the real onboarding screens with its seed phrase --
 * seed grid -> password -> guardian auto-detection probe -> confirmation ->
 * device-key rotation gate (`completeHotKeyRotation`) -- then proven usable
 * and durable across a reopen.
 *
 * Why a CONSUME (mint -> claim), not a SEND, proves "usable" here: the
 * product blocks a self-send (`SendManager.tsx`'s `cannotSendToSelf` guard,
 * see guardian-switch.spec.ts's own describe-level doc comment for the same
 * constraint) -- and recovering a seed on walletB derives the IDENTICAL
 * account id walletA already holds (asserted below), so walletB can never
 * send to a genuinely independent recipient the way guardian-switch.spec.ts's
 * walletB (an untouched plain wallet) can. A fresh consume exercises the
 * exact same rotated `[new-hot, cold]` signer set through
 * `createConsumeNotesProposal` -- an equally real proof the rotated key can
 * generate and co-sign a transaction, without spinning up a third wallet
 * instance purely to receive a token nobody needs to check arrived.
 *
 * `assertGuardianAuth`'s `guardianCommitment` pin is asserted against A's
 * commitment both before AND after recovery: a seed-only recovery replaces
 * the device-bound HOT key (there is nothing device-bound to recover) but
 * never touches the guardian or the cold key, so the auth shape (2 signers,
 * `update_guardian` threshold 2, guardian commitment = A's) must be identical
 * on both sides of the rotation -- unlike a guardian SWITCH (see
 * guardian-switch.spec.ts), nothing here is expected to change the
 * commitment.
 */
test.describe('Guardian recovery - real UI journey', () => {
  test('recover guardian account from seed via real UI, usable after rotation, survives reopen', async ({
    walletA,
    walletB,
    midenCli,
    steps
  }) => {
    // A guardian account creation + registration, a consume before recovery,
    // the full real-UI recovery journey (seed grid, password, probe,
    // confirmation, hot-key rotation), a post-recovery consume, and a reopen
    // -- each leg carries its own multi-second canonicalization wait against
    // the local guardian. Comfortable headroom, mirroring guardian-switch.spec.ts's
    // budget for a similarly guardian-heavy flow.
    test.setTimeout(600_000);

    const commitmentA = await guardianCommitment(A);

    let addressA: string;
    let seed = '';
    let faucetId: string;

    await steps.step('create_and_fund_on_a_capture_seed', async () => {
      const created = await walletA.createGuardianWallet(A);
      addressA = created.address;
      seed = created.seedPhrase.join(' ');
      expect(
        created.seedPhrase.length,
        'createGuardianWallet must return a usable 12-word mnemonic to recover from -- ' +
          'without it there is nothing to drive the real recovery screens with'
      ).toBe(12);

      await midenCli.init();
      faucetId = await midenCli.createFaucet();
      await midenCli.mint(faucetId, addressA, FUND_BASE_UNITS, 'public');
      await midenCli.sync();
      await walletA.claimAllNotes(180_000);

      // claimAllNotes only drains the pending-note list; it does not prove the
      // money became SPENDABLE. Pin the exact funded vault balance here, in
      // setup, so a claim that silently no-oped fails at its own step instead of
      // surfacing later as a confusing recovery failure -- and so the recovered
      // wallet's post-recovery expectations below have a known starting point.
      // Fees are paid in native MIDEN, not TST, so the note lands in full.
      await waitForVaultBalance(walletA.page, TOKEN, FUND_BASE_UNITS, {
        timeoutMs: 120_000,
        decimals: TOKEN_DECIMALS
      });
    });

    await steps.step('verify_baseline_on_a', async () => {
      await walletA.assertGuardianAuth(addressA!, { signerCount: 2, threshold: 2, guardianCommitment: commitmentA });
    });

    await steps.step(
      'recover_in_clean_wallet_via_real_screens',
      async () => {
        // Walks Welcome -> "Recover your account" -> 12-word seed grid ->
        // submit -> full password step -> ImportRecoveryMethod (guardian
        // auto-detection probe) -> Confirmation -> submit -> the device-key
        // rotation gate, to its cleared state.
        await walletB.recoverGuardianFromSeed(seed, { viaUI: true });
      },
      { screenshotWallets: [{ target: walletB.page, label: 'B' }] }
    );

    let addressB: string;
    await steps.step('rotated_same_guardian_and_cold_key', async () => {
      addressB = await walletB.getAccountAddress();
      expect(addressB, 'recovering the SAME seed on a clean profile must derive the SAME account id as A').toBe(
        addressA!
      );

      // Rotation replaces the HOT key but keeps the same guardian + cold key
      // + threshold -- so the auth shape is identical to A's baseline (see
      // the describe-level doc comment).
      await walletB.assertGuardianAuth(addressB, { signerCount: 2, threshold: 2, guardianCommitment: commitmentA });
    });

    await steps.step(
      'recovered_wallet_is_usable',
      async () => {
        // Baseline BEFORE the mint. walletB recovered the SAME account id that
        // walletA already claimed FUND_BASE_UNITS into, so the recovered wallet
        // must open on exactly that spendable balance -- a recovery that lost
        // (or invented) funds fails right here.
        await waitForVaultBalance(walletB.page, TOKEN, FUND_BASE_UNITS, {
          timeoutMs: 120_000,
          decimals: TOKEN_DECIMALS
        });

        await midenCli.mint(faucetId!, addressB!, RECOVERY_MINT_BASE_UNITS, 'public');
        await midenCli.sync();

        // The mint has to be DISCOVERED as an unconsumed note before a claim can
        // prove anything -- this is the half of the old `getBalance` sum that
        // moved on its own, with no signer involved.
        await waitForPendingNoteTotal(walletB.page, TOKEN, RECOVERY_MINT_BASE_UNITS, {
          timeoutMs: 120_000,
          decimals: TOKEN_DECIMALS
        });
        const beforeClaim = {
          vault: await vaultBalance(walletB.page, TOKEN),
          pending: await pendingNoteTotal(walletB.page, TOKEN)
        };

        await walletB.claimAllNotes(120_000);
        await walletB.refreshBalances();

        // The consume must move the note's value into the VAULT and out of the
        // pending list: the rotated [new-hot, cold] signer set actually co-signed
        // a transaction that committed. The old `> balanceBefore` on a
        // vault+pending sum went up the moment the note was discovered, so it
        // stayed green for a consume that never signed, never committed, or
        // consumed a different faucet's note.
        await assertClaimed(
          { page: walletB.page, label: 'B' },
          TOKEN,
          TOKEN_DECIMALS,
          beforeClaim,
          RECOVERY_MINT_BASE_UNITS,
          { timeoutMs: 120_000 }
        );
      },
      { screenshotWallets: [{ target: walletB.page, label: 'B' }] }
    );

    await steps.step('reopen_still_recovered_and_usable', async () => {
      await walletB.reopen(); // forces the extension's service worker to respawn
      await walletB.assertGuardianAuth(addressB!, { signerCount: 2, threshold: 2, guardianCommitment: commitmentA });
      // Durability means the exact spendable holdings survive the respawn:
      // walletA's funding plus this test's own claim, all in the vault. `> 0`
      // survived a reopen that dropped the claimed balance back to a merely
      // pending note, which is precisely the "in-session artifact" failure this
      // step is here to catch.
      await waitForVaultBalance(walletB.page, TOKEN, RECOVERED_VAULT_BASE_UNITS, {
        timeoutMs: 120_000,
        decimals: TOKEN_DECIMALS
      });
    });
  });
});

/**
 * Seed-entry validation on the real ImportSeedPhrase screen: BIP-39 word
 * matching (and the mnemonic checksum) must not depend on case, since a real
 * user's password manager, notes app, or OS-level auto-capitalization
 * frequently reformats typed or pasted text.
 *
 * These tests are a regression guard for the case-insensitivity fix in
 * `src/screens/onboarding/import-wallet-flow/ImportSeedPhrase.tsx`: `onChange`
 * (typed path) and `onInputPaste` (pasted path) now normalize input to
 * lowercase before it reaches `allWordsKnown` / `validateMnemonic`, which
 * compare against the lowercase-only bip39 wordlist. Before the fix, a
 * mixed-/upper-case mnemonic failed validation even with a valid checksum.
 *
 * Each test drives its own fresh wallet fixture instance straight to the
 * ImportSeedPhrase screen (`openImportSeedPhraseScreen`) rather than
 * completing a full recovery -- this only needs to observe the submit
 * button's enabled state, not a real account.
 */
test.describe('Guardian recovery - seed entry validation (real UI probe)', () => {
  test('seed phrase validates when typed in uppercase', async ({ walletA }) => {
    await walletA.openImportSeedPhraseScreen();

    const words = CANONICAL_VALID_MNEMONIC.toUpperCase().split(' ');
    for (let i = 0; i < words.length; i++) {
      // `id="seed-phrase-input-N"` is the component's own stable per-word id
      // (see ImportSeedPhrase.tsx) -- same selector `recoverGuardianFromSeed`
      // uses internally.
      await walletA.page.locator(`#seed-phrase-input-${i}`).fill(words[i]!);
    }

    const submit = walletA.page.getByTestId('import-seed-submit');
    await expect(
      submit,
      'an uppercase mnemonic with a valid BIP-39 checksum must validate -- word matching should be case-insensitive'
    ).toBeEnabled({ timeout: 10_000 });

    await submit.click();
    await expect(walletA.page.getByTestId('import-seed-phrase')).toHaveCount(0);
  });

  test('seed phrase validates when pasted with mixed case', async ({ walletB }) => {
    await walletB.openImportSeedPhraseScreen();

    const pasted = CANONICAL_VALID_MNEMONIC.split(' ')
      .map((word, i) => (i % 2 === 0 ? word.toUpperCase() : word))
      .join(' ');

    // Simulate a real paste (not `.fill()`, which sets the input value
    // directly and never fires a `paste` event) -- dispatches a synthetic
    // ClipboardEvent on the first word input, mirroring how
    // ImportSeedPhrase.tsx's `onInputPaste` reads `event.clipboardData` and
    // splits the WHOLE clipboard text into all 12 words at once regardless
    // of which input received the event.
    await walletB.page.locator('#seed-phrase-input-0').evaluate((el, text) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.setData('text/plain', text);
      const event = new ClipboardEvent('paste', { clipboardData: dataTransfer, bubbles: true, cancelable: true });
      el.dispatchEvent(event);
    }, pasted);

    const submit = walletB.page.getByTestId('import-seed-submit');
    await expect(
      submit,
      'a pasted mixed-case mnemonic with a valid BIP-39 checksum must validate -- the paste handler must not depend on case either'
    ).toBeEnabled({ timeout: 10_000 });

    await submit.click();
    await expect(walletB.page.getByTestId('import-seed-phrase')).toHaveCount(0);
  });
});
