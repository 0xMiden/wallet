import { getEnvironmentConfig } from '../config/environments';
import { expect, test } from '../fixtures/two-wallets';
import { vaultBalance } from '../helpers/balance-truth';
import { readTransactionRows } from '../helpers/history';
import { FUNDING_MIDEN } from '../helpers/miden-cli';
import { PASSWORD } from '../helpers/wallet-page';

const GUARDIAN_URL = getEnvironmentConfig().guardianUrl;

/** The guardian job's `verification-base-fee`, and the kernel's cap on one transaction's fee multiple. */
const BASE_FEE = 10_000n;
const FEE_RESERVE_MULTIPLE = 30n;

/** The opening words of `TRANSACTION_VAULT_SHORTFALL_ERROR` (src/lib/miden/transaction/constants.ts). */
const VAULT_SHORTFALL_COPY =
  /^The transaction could not be completed because an asset it moves was not available in full/;

/**
 * "I lost my device, recovered from my seed phrase, and my account held no MIDEN" (#805).
 *
 * A seed-only recovery cannot recover the device-bound everyday key, so the recovered
 * wallet must rotate it, and the rotation is a transaction that pays its fee from the
 * account's own vault. On a fee-charging chain an unfunded account used to stay behind
 * the rotation gate for good. Every other guardian spec pre-funds with `ensureFeeFunded`;
 * this one deliberately does not, and funds the address the gate shows only after the
 * gate asks.
 *
 * Wallet A's context is closed before the recovery: a still-running old device claims
 * the funding note with its own everyday key first, which is a different flow.
 */
test.describe('Guardian recovery - unfunded account', () => {
  test('the rotation gate asks for MIDEN, claims it with the recovery key and finishes the rotation', async ({
    walletA,
    walletB,
    midenCli,
    steps
  }) => {
    test.setTimeout(15 * 60_000);

    let addressA = '';
    let seed = '';

    await steps.step('create_wallet_a', async () => {
      const created = await walletA.createGuardianWallet(GUARDIAN_URL, PASSWORD);
      addressA = created.address;
      seed = created.seedPhrase.join(' ');
      await midenCli.init();
      // On a chain that charges nothing the rotation cannot fall short, and this spec proves nothing.
      expect(await midenCli.chainCharges(), 'this spec needs a fee-charging chain').toBe(true);
    });

    await steps.step('lose_the_old_device', async () => {
      await walletA.page.context().close();
    });

    await steps.step(
      'recover_into_wallet_b',
      async () => {
        await walletB.recoverGuardianFromSeed(seed, { viaUI: true, rotation: 'await-funding' });
      },
      { screenshotWallets: [{ target: walletB.page, label: 'B' }] }
    );

    await steps.step('the_gate_asks_for_funding', async () => {
      const funding = await walletB.waitForHotKeyRotationFunding();
      expect(funding.address, 'the gate must show the recovered account address').toBe(addressA);

      const copy = walletB.page.getByTestId('hot-key-rotation-funding-copy');
      await copy.click();
      await expect(copy).toHaveAttribute('data-copied', 'true');

      await expect(walletB.page.getByTestId('hot-key-rotation-funding')).toHaveAttribute(
        'data-funding-reason',
        'rotation-shortfall',
        { timeout: 180_000 }
      );
      const rows = await readTransactionRows(walletB.page);
      const failed = rows.filter(r => r.type === 'replace-hot-key' && r.status === 3);
      expect(failed).toHaveLength(1);
      expect(failed[0]?.error ?? '').toMatch(VAULT_SHORTFALL_COPY);
      expect(rows.filter(r => r.type === 'consume')).toEqual([]);
    });

    await steps.step('fund_the_address', async () => {
      await midenCli.fundAccountForFees(addressA);
    });

    await steps.step(
      'the_gate_claims_and_rotates',
      async () => {
        await walletB.completeHotKeyRotation({ fundingExpected: true, timeoutMs: 240_000 });

        const rows = await readTransactionRows(walletB.page);
        const consumes = rows.filter(r => r.type === 'consume');
        expect(consumes, 'exactly one claim, and it is the gate funding claim').toHaveLength(1);
        const claim = consumes[0]!;
        expect(claim).toMatchObject({ rotationFunding: true, status: 2 });

        const rotations = rows
          .filter(r => r.type === 'replace-hot-key')
          .sort((a, b) => (a.processingStartedAt ?? 0) - (b.processingStartedAt ?? 0));
        expect(
          rotations.map(r => r.status),
          'one rotation fell short, the one after the claim landed'
        ).toEqual([3, 2]);
        const [shortRotation, rotation] = [rotations[0]!, rotations[1]!];
        // Never at the same time: the claim ran after the short rotation ended, the rotation after the claim.
        expect(claim.processingStartedAt!).toBeGreaterThanOrEqual(shortRotation.completedAt!);
        expect(rotation.processingStartedAt!).toBeGreaterThanOrEqual(claim.completedAt!);

        // The flag clearing is the rotation's authoritative "done" signal (HotKeyRotationGate.tsx).
        const flagged: unknown = await walletB.page.evaluate(
          'window.__TEST_STORE__?.getState().currentAccount?.requiresHotKeyRotation ?? null'
        );
        expect(flagged).toBe(false);

        // The funding note less two fees, each at most the kernel's cap: the claim's and the rotation's.
        const funded = BigInt(FUNDING_MIDEN);
        const floor = funded - 2n * FEE_RESERVE_MULTIPLE * BASE_FEE;
        await expect
          .poll(() => vaultBalance(walletB.page, 'MIDEN'), { timeout: 120_000 })
          .toBeGreaterThanOrEqual(floor);
        expect(await vaultBalance(walletB.page, 'MIDEN')).toBeLessThan(funded);
      },
      { screenshotWallets: [{ target: walletB.page, label: 'B' }] }
    );
  });
});
