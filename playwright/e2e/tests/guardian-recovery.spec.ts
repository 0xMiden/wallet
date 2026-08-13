import { getEnvironmentConfig } from '../config/environments';
import { expect, test } from '../fixtures/two-wallets';

// Primary guardian operator for the selected network (E2E_NETWORK): the local
// container on localhost, the real OpenZeppelin operator on testnet/devnet.
const A = getEnvironmentConfig().guardianUrl;

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
      await midenCli.mint(faucetId, addressA, 100_000_000_000, 'public');
      await midenCli.sync();
      await walletA.claimAllNotes(180_000);
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
        // walletA already claimed 100 MIDEN into, and getBalance sums unconsumed
        // notes regardless of symbol — so `> 0` was already true before this
        // step's mint existed, leaving claimAllNotes throwing as the step's only
        // real failure mode. Assert the balance actually GREW instead.
        const balanceBefore = await walletB.getBalance('TST');
        await midenCli.mint(faucetId!, addressB!, 25_000_000_000, 'public');
        await midenCli.sync();
        await walletB.claimAllNotes(120_000);
        const balance = await walletB.getBalance('TST');
        expect(
          balance,
          'the rotated [new-hot, cold] signer set must be able to co-sign a real consume'
        ).toBeGreaterThan(balanceBefore);
      },
      { screenshotWallets: [{ target: walletB.page, label: 'B' }] }
    );

    await steps.step('reopen_still_recovered_and_usable', async () => {
      await walletB.reopen(); // forces the extension's service worker to respawn
      await walletB.assertGuardianAuth(addressB!, { signerCount: 2, threshold: 2, guardianCommitment: commitmentA });
      const balanceAfterReopen = await walletB.getBalance('TST');
      expect(
        balanceAfterReopen,
        'the recovered rotation must be durably persisted, not an in-session artifact'
      ).toBeGreaterThan(0);
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
