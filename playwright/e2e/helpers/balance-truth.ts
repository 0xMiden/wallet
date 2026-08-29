/**
 * Symbol-aware, base-unit balance primitives for E2E assertions.
 *
 * WHY THIS EXISTS
 *
 * `WalletPage.getBalance(_tokenSymbol?)` (wallet-page.ts) has two properties that
 * make it unusable as a correctness oracle, and 60+ assertions in this suite are
 * built on it:
 *
 *   1. It takes a token symbol and **discards it** (the parameter is `_`-prefixed).
 *      It sums every token of every faucet, so a send that credits the WRONG TOKEN
 *      still moves the number.
 *   2. It **adds unconsumed notes** to the balance. A note that was discovered but
 *      never successfully consumed counts as if it were spendable, so a broken
 *      consume still reads as a balance increase.
 *
 * Combined with `expect(balance).toBeGreaterThan(0)`, that is an assertion which
 * cannot fail for a wrong-amount, wrong-token, or never-actually-claimed bug.
 *
 * These helpers keep the two quantities strictly separate and work in **base units
 * as bigint** — no float division, so a 6-decimal and an 8-decimal token can't
 * silently compare equal after rounding.
 *
 *   vaultBalance()     — spendable, in the vault, for ONE symbol. What "I have it" means.
 *   pendingNoteTotal() — discovered but NOT yet consumed, for ONE symbol.
 *
 * Never add them together. If a test wants "the money arrived", it wants
 * `vaultBalance`; if it wants "the note showed up", it wants `pendingNoteTotal`.
 */
import type { Page } from '@playwright/test';

import { readTransactionRows } from './history';

/** A token's on-screen identity plus the raw amount, as the store reports it. */
export interface SymbolBalance {
  symbol: string;
  decimals: number;
  /** Spendable vault balance in base units. */
  baseUnits: bigint;
}

/**
 * Convert a human amount ("1.5") to base units for a given decimals, without
 * floating point. Test fixtures write human amounts; assertions compare bigints.
 */
export function toBaseUnits(amount: string | number, decimals: number): bigint {
  const s = typeof amount === 'number' ? String(amount) : amount.trim();
  if (!/^\d+(\.\d+)?$/.test(s))
    throw new Error(`toBaseUnits: not a positive decimal amount: ${JSON.stringify(amount)}`);
  const [whole = '0', frac = ''] = s.split('.');
  if (frac.length > decimals) {
    throw new Error(`toBaseUnits: ${s} has more precision than ${decimals} decimals — refusing to round silently`);
  }
  return BigInt(whole + frac.padEnd(decimals, '0'));
}

/** Format base units back to a human string, for readable assertion messages. */
export function fromBaseUnits(baseUnits: bigint, decimals: number): string {
  const neg = baseUnits < 0n;
  const v = neg ? -baseUnits : baseUnits;
  const s = v.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = decimals === 0 ? '' : `.${s.slice(s.length - decimals).replace(/0+$/, '')}`;
  return `${neg ? '-' : ''}${whole}${frac === '.' ? '' : frac}`;
}

/**
 * Spendable vault balance for exactly one token symbol, in base units.
 *
 * Reads ONLY the store's `balances` projection (consumed assets actually in the
 * vault) — never the pending-note cache. Symbol match is case-insensitive against
 * each token's own metadata, so it cannot silently pick up a different faucet.
 *
 * Returns 0n when the symbol is absent, which is a legitimate answer ("you hold
 * none of this"), not an error — assertions should compare against an expected
 * amount rather than against presence.
 */
export async function vaultBalance(page: Page, symbol: string): Promise<bigint> {
  const raw = await page.evaluate(
    ({ wanted }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const state = (window as any).__TEST_STORE__?.getState?.();
      const out: Array<{ symbol: string; decimals: number; balance: number }> = [];
      for (const tokenList of Object.values(state?.balances ?? {}) as unknown[]) {
        if (!Array.isArray(tokenList)) continue;
        for (const token of tokenList) {
          const symbolOf = String(token?.metadata?.symbol ?? '');
          if (symbolOf.toLowerCase() !== wanted) continue;
          out.push({
            symbol: symbolOf,
            decimals: Number(token?.metadata?.decimals ?? 0),
            balance: Number(token?.balance ?? 0)
          });
        }
      }
      return out;
    },
    { wanted: symbol.toLowerCase() }
  );

  // `balance` is a display float; recover base units via the token's own decimals.
  // Rounding here is safe because we round a value the product itself derived from
  // base units, and we assert the round-trip is exact.
  let total = 0n;
  for (const t of raw) {
    const scaled = t.balance * Math.pow(10, t.decimals);
    const rounded = Math.round(scaled);
    if (Math.abs(scaled - rounded) > 1e-6) {
      throw new Error(
        `vaultBalance(${symbol}): store balance ${t.balance} does not round-trip at ${t.decimals} decimals ` +
          `(scaled=${scaled}). Refusing to assert on a lossy value.`
      );
    }
    total += BigInt(rounded);
  }
  return total;
}

/**
 * Total of DISCOVERED-BUT-UNCONSUMED notes for one symbol, in base units.
 *
 * This is deliberately a separate reading from `vaultBalance`. A test asserting a
 * claim succeeded must see this go DOWN and the vault go UP; a test that adds them
 * together cannot tell a successful claim from a failed one.
 */
export async function pendingNoteTotal(page: Page, symbol: string): Promise<bigint> {
  return BigInt(
    await page.evaluate(
      async ({ wanted }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const storage = await new Promise<any>(resolve => {
          chrome.storage.local.get(['miden_sync_data'], resolve);
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const state = (window as any).__TEST_STORE__?.getState?.();
        const meta = state?.assetsMetadata ?? {};
        let total = 0n;
        for (const note of storage?.miden_sync_data?.notes ?? []) {
          const faucetId = String(note?.faucetId ?? '');
          const symbolOf = String(note?.metadata?.symbol ?? meta?.[faucetId]?.symbol ?? '');
          if (symbolOf.toLowerCase() !== wanted) continue;
          total += BigInt(String(note?.amountBaseUnits ?? '0'));
        }
        return total.toString();
      },
      { wanted: symbol.toLowerCase() }
    )
  );
}

/**
 * The LARGEST unconsumed-note total observed for `symbol` over `forMs`.
 *
 * For assertions whose subject is an ABSENCE. A single `pendingNoteTotal` read is
 * one sample of a projection the service worker rewrites every sync cycle, so
 * "the note is not listed" at one instant can mean "the cycle that would have
 * listed it has not run yet". Sampling across several cycles and asserting the
 * MAXIMUM turns that into "no cycle in this window listed it", which is the
 * statement an absence assertion actually wants to make.
 *
 * Returns the max rather than throwing so the caller owns the comparison — an
 * `expect` in the spec names the product breakage; a throw in here would not.
 */
export async function maxPendingNoteTotal(
  page: Page,
  symbol: string,
  opts: { forMs: number; pollMs?: number }
): Promise<bigint> {
  const pollMs = opts.pollMs ?? 2_000;
  const deadline = Date.now() + opts.forMs;
  let max = await pendingNoteTotal(page, symbol);
  while (Date.now() < deadline) {
    await page.waitForTimeout(pollMs);
    const sample = await pendingNoteTotal(page, symbol);
    if (sample > max) max = sample;
  }
  return max;
}

/**
 * Poll until the UNCONSUMED-note total for `symbol` equals `expected` exactly.
 *
 * This is the right assertion for "the mint arrived" — a minted note is discovered
 * before it is consumed, so its value is pending, not spendable. Asserting the
 * VAULT here would be wrong (it stays 0 until a claim) and asserting vault+pending
 * summed together — what the old `getBalance` did — cannot tell the two apart at
 * all, which is how a broken claim used to read as a successful one.
 */
export async function waitForPendingNoteTotal(
  page: Page,
  symbol: string,
  expected: bigint,
  opts: { timeoutMs?: number; decimals?: number; diagnoseFrom?: Page } = {}
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;
  let last = -1n;
  while (Date.now() < deadline) {
    last = await pendingNoteTotal(page, symbol);
    if (last === expected) return;
    await page.waitForTimeout(2_000);
  }
  const d = opts.decimals;
  const fmt = (v: bigint) => (d == null ? `${v} base units` : `${fromBaseUnits(v, d)} (${v} base units)`);
  const vault = await vaultBalance(page, symbol).catch(() => -1n);
  // A note that never arrives is almost always a SENDER-side failure, but this
  // helper only watches the receiver -- so on its own it reports "nothing showed
  // up" and names no cause. Callers that know the sender pass `diagnoseFrom` and
  // get the sender's failed rows, including the raw kernel error the friendly
  // message replaced, in the same throw.
  const senderFailures = opts.diagnoseFrom ? await failedRowSummary(opts.diagnoseFrom) : '';
  throw new Error(
    `waitForPendingNoteTotal(${symbol}) timed out after ${timeoutMs}ms.\n` +
      `  expected unconsumed: ${fmt(expected)}\n` +
      `  actual unconsumed:   ${fmt(last)}\n` +
      `  vault balance for ${symbol}: ${vault === -1n ? 'unreadable' : vault.toString()} base units\n` +
      `  (a vault total matching the expectation means the note was already consumed)` +
      senderFailures
  );
}

/**
 * Poll until the sender's vault has dropped by at least `atLeast` from `before`,
 * and return the observed debit.
 *
 * "At least", not "exactly", because a fee may leave the account alongside the
 * transfer. The wait is the load-bearing part: the recipient seeing the note only
 * proves it is on-chain, and the SENDER's balances projection updates on its own
 * schedule. A bare read right after the recipient's wait therefore samples a
 * balance that has not moved yet and reports `debited 0` — a green send scored as
 * a failure, which is exactly how this helper came to exist.
 */
export async function waitForVaultDebit(
  page: Page,
  symbol: string,
  before: bigint,
  atLeast: bigint,
  opts: { timeoutMs?: number; decimals?: number } = {}
): Promise<bigint> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;
  let last = -1n;
  while (Date.now() < deadline) {
    last = await vaultBalance(page, symbol);
    const debited = before - last;
    if (debited >= atLeast) return debited;
    await page.waitForTimeout(2_000);
  }
  const d = opts.decimals;
  const fmt = (v: bigint) => (d == null ? `${v} base units` : `${fromBaseUnits(v, d)} (${v} base units)`);
  const pending = await pendingNoteTotal(page, symbol).catch(() => -1n);
  throw new Error(
    `waitForVaultDebit(${symbol}) timed out after ${timeoutMs}ms.\n` +
      `  expected debit of at least: ${fmt(atLeast)}\n` +
      `  vault before: ${fmt(before)}\n` +
      `  vault now:    ${fmt(last)}\n` +
      `  observed debit: ${fmt(before - last)}\n` +
      `  unconsumed notes for ${symbol}: ${pending === -1n ? 'unreadable' : pending.toString()} base units\n` +
      `  (an unchanged vault here means the send never debited the sender, not that it is slow —\n` +
      `   this waited the full timeout for the projection to move)`
  );
}

/** Poll until the vault balance for `symbol` equals `expected` exactly, or throw with both readings. */
export async function waitForVaultBalance(
  page: Page,
  symbol: string,
  expected: bigint,
  opts: { timeoutMs?: number; decimals?: number } = {}
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;
  let last = -1n;
  while (Date.now() < deadline) {
    last = await vaultBalance(page, symbol);
    if (last === expected) return;
    await page.waitForTimeout(2_000);
  }
  const d = opts.decimals;
  const fmt = (v: bigint) => (d == null ? v.toString() : `${fromBaseUnits(v, d)} (${v} base units)`);
  const pending = await pendingNoteTotal(page, symbol).catch(() => -1n);
  throw new Error(
    `waitForVaultBalance(${symbol}) timed out after ${timeoutMs}ms.\n` +
      `  expected vault: ${fmt(expected)}\n` +
      `  actual vault:   ${fmt(last)}\n` +
      `  unconsumed notes for ${symbol}: ${pending === -1n ? 'unreadable' : pending.toString()} base units\n` +
      `  (a non-zero pending total with a short vault means the note was discovered but never consumed)`
  );
}

/**
 * The sender's failed transactions, formatted for a receiver-side timeout message.
 * Returns '' when there are none -- an empty section would imply the sender is fine
 * when it may simply not have started.
 */
async function failedRowSummary(sender: Page): Promise<string> {
  const rows = await readTransactionRows(sender).catch(() => []);
  const failed = rows.filter(r => r.status === 3);
  if (failed.length === 0) return '\n  sender has no failed transactions (it may never have started one)';
  return (
    `\n  sender-side failures (${failed.length}):` +
    failed
      .map(
        r =>
          `\n    [${r.type ?? '?'} ${r.id.slice(0, 8)} stage=${r.stage ?? '?'}]` +
          `\n      ${r.error ?? '(no message)'}` +
          (r.rawError ? `\n      raw: ${r.rawError}` : '')
      )
      .join('')
  );
}

/**
 * The faucet id backing a symbol in the wallet's own balances projection.
 *
 * Needed to assert WHICH asset a fee was paid in. Protocol 0.16 does not force a
 * fee to be paid in the native asset: `fee::pay_fee` takes the faucet id and the
 * conversion rate from caller-supplied auth args, and only `no_auth` and
 * `network_account` read them from the reference block. So "the wallet paid its
 * fee in the native asset at the native rate" is a property of the WALLET, not of
 * the chain, and it has to be asserted rather than assumed.
 */
export async function faucetIdForSymbol(page: Page, symbol: string): Promise<string | undefined> {
  return page.evaluate(
    ({ wanted }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const state = (window as any).__TEST_STORE__?.getState?.();
      for (const tokenList of Object.values(state?.balances ?? {}) as unknown[]) {
        if (!Array.isArray(tokenList)) continue;
        for (const token of tokenList) {
          if (String(token?.metadata?.symbol ?? '').toLowerCase() === wanted) {
            return token?.faucetId === undefined ? undefined : String(token.faucetId);
          }
        }
      }
      return undefined;
    },
    { wanted: symbol.toLowerCase() }
  );
}

/**
 * The chain's `verification_base_fee` as the WALLET discovered it, or `null` if the
 * wallet has not discovered it.
 *
 * Read from the extension's own cache (`native_asset_fee:v1:<scope>`, written by
 * `lib/miden-chain/native-asset`) rather than from the harness's knowledge of how
 * the node was genesised. That makes a spec self-describing -- it can require a fee
 * on a fee-charging chain and say so on a fee-free one -- and it doubles as an
 * assertion that the wallet's fee discovery works at all.
 *
 * `null` and `0` are different answers: `0` is a chain that charges nothing,
 * `null` is a wallet that does not know. Callers must not collapse them.
 */
export async function walletDiscoveredBaseFee(page: Page): Promise<number | null> {
  return page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = (globalThis as any).chrome;
    if (!c?.storage?.local) return null;
    const all = await c.storage.local.get(null);
    const key = Object.keys(all).find(k => k.startsWith('native_asset_fee:'));
    const v = key === undefined ? null : all[key];
    return typeof v === 'number' ? v : null;
  });
}

/**
 * The chain's native (fee) faucet id as the WALLET discovered it, or `null`.
 *
 * Read from the extension's own cache (`native_asset_id:v4:<scope>`). Preferred
 * over looking the row up by symbol: the native asset's symbol comes from chain
 * metadata that a local chain need not supply, so a symbol lookup can miss on a
 * wallet that knows the faucet perfectly well.
 */
export async function walletDiscoveredNativeFaucetId(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = (globalThis as any).chrome;
    if (!c?.storage?.local) return null;
    const all = await c.storage.local.get(null);
    const key = Object.keys(all).find(k => k.startsWith('native_asset_id:'));
    const v = key === undefined ? null : all[key];
    return typeof v === 'string' ? v : null;
  });
}

/** Every asset row the store holds, for diagnostics when a lookup finds nothing. */
export async function listVaultAssets(
  page: Page
): Promise<Array<{ faucetId: string; symbol: string; amount: string }>> {
  return page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = (window as any).__TEST_STORE__?.getState?.();
    const out: Array<{ faucetId: string; symbol: string; amount: string }> = [];
    for (const tokenList of Object.values(state?.balances ?? {}) as unknown[]) {
      if (!Array.isArray(tokenList)) continue;
      for (const token of tokenList) {
        out.push({
          faucetId: String(token?.faucetId ?? '(none)'),
          symbol: String(token?.metadata?.symbol ?? '(none)'),
          amount: String(token?.amountBaseUnits ?? token?.balance ?? '(none)')
        });
      }
    }
    return out;
  });
}
