import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

import { vaultBalanceByFaucetId, walletDiscoveredNativeFaucetId } from './balance-truth';

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
 * auth procedure, so an account with an empty vault cannot transact at all - it fails with
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

  // A zero-fee chain has no funding note to claim or fee balance to discover.
  if (!(await midenCli.chainCharges())) return 0n;

  let feeFaucetId = await walletDiscoveredNativeFaucetId(wallet.page);
  for (let attempt = 0; attempt < attempts && !feeFaucetId; attempt++) {
    await wallet.page.waitForTimeout(2_000);
    feeFaucetId = await walletDiscoveredNativeFaucetId(wallet.page);
  }
  if (!feeFaucetId) {
    throw new Error(`account ${accountId}: the wallet fee faucet was never discovered; fee funding cannot be checked`);
  }

  let balance = await vaultBalanceByFaucetId(wallet.page, feeFaucetId);
  for (let attempt = 0; attempt < attempts && balance === 0n; attempt++) {
    await wallet.claimAllNotes(opts.claimTimeoutMs ?? 60_000).catch(() => {
      // Not visible yet; the poll below decides whether to keep waiting.
    });
    balance = await vaultBalanceByFaucetId(wallet.page, feeFaucetId);
    // eslint-disable-next-line no-long-bare-wait -- inter-poll spacer, loop re-checks the condition
    if (balance === 0n) await wallet.page.waitForTimeout(5_000);
  }

  // The fixture's funding amount is not fixed; require spendable fee assets before the next transaction.
  // eslint-disable-next-line no-unfalsifiable-balance-assertion -- fixture postcondition, no exact target
  expect(balance, `account ${accountId} was never funded for fees; its next transaction cannot pay`).toBeGreaterThan(
    0n
  );
  return balance;
}
