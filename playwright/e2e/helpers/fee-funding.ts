import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

import { vaultBalance } from './balance-truth';

/** The chain's native asset, which is what `fee::pay_fee` withdraws. */
const NATIVE_SYMBOL = 'MIDEN';

/** Just enough of `MidenCli` for this helper, so specs can pass their fixture directly. */
interface FeeFunder {
  init: () => Promise<unknown>;
  fundAccountForFees: (accountId: string) => Promise<void>;
  chainCharges: () => Promise<boolean>;
}

/** Just enough of `WalletPage`. */
interface ClaimableWallet {
  page: Page;
  claimAllNotes: (timeoutMs?: number) => Promise<unknown>;
}

/**
 * Ensure an account holds spendable native asset, so its next transaction can pay its fee.
 *
 * Since protocol 0.16 the fee is withdrawn from the acting account's own vault inside the
 * auth procedure, so an account with an empty vault cannot transact at all — it fails with
 * "failed to remove the fungible asset from the vault since the amount of the asset in the
 * vault is less than the amount to remove", a kernel assertion that names nothing about
 * funding.
 *
 * Two things make this more than a one-liner, and both have bitten this suite:
 *
 *  - Funding sends a NOTE. The vault is empty until it is CLAIMED, so a spec that funds and
 *    immediately transacts still fails. Specs that deliberately leave notes pending (seed
 *    recovery of a pending note) leave the funding note pending too.
 *  - `claimAllNotes` returns once it sees an empty pending list twice, so calling it the
 *    instant after funding can drain nothing and look successful. Hence the retry loop.
 *
 * A no-op on a chain that charges nothing, so callers stay fast there.
 */
export async function ensureFeeFunded(
  midenCli: FeeFunder,
  wallet: ClaimableWallet,
  accountId: string,
  opts: { attempts?: number; claimTimeoutMs?: number } = {}
): Promise<bigint> {
  const attempts = opts.attempts ?? 12;
  await midenCli.init();
  await midenCli.fundAccountForFees(accountId);

  // Return before the claim loop, not just before the assertion. `fundAccountForFees`
  // is itself a no-op on a chain that charges nothing, so `balance` stays 0n for all 12
  // attempts and every one of them runs -- each a `claimAllNotes`, which reloads the
  // page and spends ~10s in fixed sleeps, plus a 5s spacer. That is roughly four silent
  // minutes per call against a chain where there is nothing to claim.
  if (!(await midenCli.chainCharges())) return 0n;

  let balance = await vaultBalance(wallet.page, NATIVE_SYMBOL);
  for (let attempt = 0; attempt < attempts && balance === 0n; attempt++) {
    await wallet.claimAllNotes(opts.claimTimeoutMs ?? 60_000).catch(() => {
      // Not visible yet; the poll below decides whether to keep waiting.
    });
    balance = await vaultBalance(wallet.page, NATIVE_SYMBOL);
    // A spacer BETWEEN polls, not a wait for a condition: the loop re-reads `balance` at the
    // top of each lap, so this bounds how hard we hammer `claimAllNotes` rather than standing
    // in for a web-first assertion. Shorter just means more page reloads per funding note.
    // eslint-disable-next-line no-long-bare-wait -- inter-poll spacer, loop re-checks the condition
    if (balance === 0n) await wallet.page.waitForTimeout(5_000);
  }

  // Assert rather than proceed hopefully: an unfunded account fails much later, at whatever
  // transaction first cannot pay, with an error that points nowhere near the cause. The
  // zero-fee case returned above, so reaching here means the chain charges.
  // A FIXTURE postcondition, and there is no exact amount to assert against: the funding
  // note's size is the funder's choice, and this helper's contract is only "the account can
  // now pay a fee". Asserting it here is what stops an unfunded account from failing much
  // later, at whatever transaction first cannot pay, pointing nowhere near the cause.
  // eslint-disable-next-line no-unfalsifiable-balance-assertion -- fixture postcondition, no exact target
  expect(balance, `account ${accountId} was never funded for fees; its next transaction cannot pay`).toBeGreaterThan(
    0n
  );
  return balance;
}
