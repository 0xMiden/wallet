/**
 * Money-movement assertions for E2E specs.
 *
 * The rule these encode: a transfer assertion names a SYMBOL and an EXACT base-unit
 * AMOUNT, and checks BOTH sides — the recipient credited and the sender debited.
 * `expect(balance).toBeGreaterThan(0)` is not an assertion about a transfer; it is
 * an assertion that something, somewhere, is non-zero, and it stays true when the
 * wrong token moves, the wrong amount moves, or nothing moves at all because the
 * balance was already non-zero beforehand.
 *
 * `assertConservation` is lifted from the invariant already written in
 * stress.spec.ts ("total across wallets is unchanged by a transfer") — it is the
 * strongest cheap check available and it currently runs in no workflow.
 */
import { expect, type Page } from '@playwright/test';

import { fromBaseUnits, pendingNoteTotal, vaultBalance, waitForVaultBalance } from './balance-truth';

export interface Wallet {
  page: Page;
  label?: string;
}

export interface TransferSnapshot {
  symbol: string;
  decimals: number;
  fromVault: bigint;
  toVault: bigint;
  fromPending: bigint;
  toPending: bigint;
}

/** Capture both wallets' readings before a transfer so the delta can be asserted after. */
export async function snapshotTransfer(
  from: Wallet,
  to: Wallet,
  symbol: string,
  decimals: number
): Promise<TransferSnapshot> {
  const [fromVault, toVault, fromPending, toPending] = await Promise.all([
    vaultBalance(from.page, symbol),
    vaultBalance(to.page, symbol),
    pendingNoteTotal(from.page, symbol),
    pendingNoteTotal(to.page, symbol)
  ]);
  return { symbol, decimals, fromVault, toVault, fromPending, toPending };
}

/**
 * Assert that exactly `amountBaseUnits` of `symbol` moved from `from` to `to`.
 *
 * Waits for the recipient's vault to reach its expected total (so the caller does
 * not need its own sleep), then asserts the sender was debited by at least the
 * same amount. The sender side uses `toBeLessThanOrEqual` on the remaining balance
 * because a fee may also have left the account — but it must have dropped by AT
 * LEAST the transferred amount, which is what catches a "credited the recipient
 * without debiting the sender" bug.
 */
export async function assertTransfer(
  before: TransferSnapshot,
  from: Wallet,
  to: Wallet,
  amountBaseUnits: bigint,
  opts: { timeoutMs?: number } = {}
): Promise<void> {
  const { symbol, decimals } = before;
  const expectedTo = before.toVault + amountBaseUnits;

  await waitForVaultBalance(to.page, symbol, expectedTo, { timeoutMs: opts.timeoutMs, decimals });

  const fromAfter = await vaultBalance(from.page, symbol);
  const debited = before.fromVault - fromAfter;
  expect(
    debited >= amountBaseUnits,
    `sender (${from.label ?? 'A'}) must be debited by at least ${fromBaseUnits(amountBaseUnits, decimals)} ${symbol}; ` +
      `was ${fromBaseUnits(before.fromVault, decimals)} → ${fromBaseUnits(fromAfter, decimals)} ` +
      `(debited ${fromBaseUnits(debited, decimals)})`
  ).toBe(true);
}

/**
 * Assert the two wallets' combined holdings of `symbol` are unchanged.
 *
 * This is the invariant that catches minting-from-nowhere and silent burns — the
 * class of bug a per-wallet balance check cannot see. Fees leave the two-wallet
 * system, so `allowedLoss` exists for flows that pay one; pass 0n when the flow
 * should be fee-free and you want the strict form.
 */
export async function assertConservation(
  a: Wallet,
  b: Wallet,
  symbol: string,
  decimals: number,
  totalBefore: bigint,
  opts: { allowedLoss?: bigint } = {}
): Promise<void> {
  const allowedLoss = opts.allowedLoss ?? 0n;
  const [av, bv] = await Promise.all([vaultBalance(a.page, symbol), vaultBalance(b.page, symbol)]);
  const totalAfter = av + bv;
  const delta = totalBefore - totalAfter;
  expect(
    delta >= 0n && delta <= allowedLoss,
    `conservation violated for ${symbol}: total went ${fromBaseUnits(totalBefore, decimals)} → ` +
      `${fromBaseUnits(totalAfter, decimals)} (delta ${fromBaseUnits(delta, decimals)}, ` +
      `allowed loss ${fromBaseUnits(allowedLoss, decimals)}). ` +
      `A negative delta means tokens appeared from nowhere; a delta above the allowance means they vanished.`
  ).toBe(true);
}

/** Combined holdings of `symbol` across both wallets, for seeding `assertConservation`. */
export async function totalAcross(a: Wallet, b: Wallet, symbol: string): Promise<bigint> {
  const [av, bv] = await Promise.all([vaultBalance(a.page, symbol), vaultBalance(b.page, symbol)]);
  return av + bv;
}

/**
 * Assert a claim actually consumed notes: the vault gained exactly `amountBaseUnits`
 * AND the unconsumed-note total for that symbol dropped by the same amount.
 *
 * The second half is the part that matters. A claim that leaves the note pending
 * while the UI reports success still moves no spendable money, and a balance-only
 * check that sums vault+pending (as the old `getBalance` did) reads identically in
 * both cases.
 */
export async function assertClaimed(
  wallet: Wallet,
  symbol: string,
  decimals: number,
  before: { vault: bigint; pending: bigint },
  amountBaseUnits: bigint,
  opts: { timeoutMs?: number } = {}
): Promise<void> {
  await waitForVaultBalance(wallet.page, symbol, before.vault + amountBaseUnits, {
    timeoutMs: opts.timeoutMs,
    decimals
  });
  const pendingAfter = await pendingNoteTotal(wallet.page, symbol);
  expect(
    pendingAfter <= before.pending - amountBaseUnits,
    `claim must consume the note: unconsumed ${symbol} went ${fromBaseUnits(before.pending, decimals)} → ` +
      `${fromBaseUnits(pendingAfter, decimals)}, expected a drop of at least ` +
      `${fromBaseUnits(amountBaseUnits, decimals)}. Still-pending notes mean the money is not spendable.`
  ).toBe(true);
}
