/**
 * Symbol-aware, base-unit balance primitives for E2E assertions.
 *
 * WHY THIS EXISTS
 *
 * `WalletPage.getBalance(tokenSymbol?)` (wallet-page.ts) has a property that makes
 * it unusable as a correctness oracle, and 60+ assertions in this suite are built
 * on it: it **adds unconsumed notes** to the balance. A note that was discovered but
 * never successfully consumed counts as if it were spendable, so a broken consume
 * still reads as a balance increase.
 *
 * Combined with `expect(balance).toBeGreaterThan(0)`, that is an assertion which
 * cannot fail for a wrong-amount or never-actually-claimed bug.
 *
 * These helpers keep the two quantities strictly separate and work in **base units
 * as bigint** - no float division, so a 6-decimal and an 8-decimal token can't
 * silently compare equal after rounding.
 *
 *   vaultBalance()     - spendable, in the vault, for ONE symbol. What "I have it" means.
 *   pendingNoteTotal() - discovered but NOT yet consumed, for ONE symbol.
 *
 * Never add them together. If a test wants "the money arrived", it wants
 * `vaultBalance`; if it wants "the note showed up", it wants `pendingNoteTotal`.
 */
import type { Page } from '@playwright/test';

import type { TokenBalanceData } from 'lib/miden/front/balance';
import type { AssetMetadata } from 'lib/miden/metadata';

import { readTransactionRows } from './history';
import { NATIVE_ASSET_FEE_CACHE, NATIVE_ASSET_ID_CACHE } from '../../../src/lib/miden-chain/native-asset-cache-keys';

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
    throw new Error(`toBaseUnits: ${s} has more precision than ${decimals} decimals - refusing to round silently`);
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
 * vault) - never the pending-note cache. Symbol match is case-insensitive.
 *
 * The symbol resolves from the row's own metadata, falling back to `assetsMetadata`, because a row
 * carries `metadata` only when `fetchTokenMetadata` succeeded. This MUST agree with
 * `pendingNoteTotal` below, which already falls back: while they disagreed, a faucet known only to
 * `assetsMetadata` counted as pending and then vanished from the vault once consumed, so a claim
 * read as lost value in the very check written to detect lost value.
 *
 * Returns 0n when the symbol is absent, which is a legitimate answer ("you hold
 * none of this"), not an error - assertions should compare against an expected
 * amount rather than against presence.
 */
export async function vaultBalance(page: Page, symbol: string): Promise<bigint> {
  const raw = await page.evaluate(
    ({ wanted }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const state = (window as any).__TEST_STORE__?.getState?.();
      const meta = state?.assetsMetadata ?? {};
      const out: Array<{ symbol: string; decimals: number; balance: number }> = [];
      for (const tokenList of Object.values(state?.balances ?? {}) as unknown[]) {
        if (!Array.isArray(tokenList)) continue;
        for (const token of tokenList) {
          const cached = meta?.[String(token?.tokenId ?? '')];
          const symbolOf = String(token?.metadata?.symbol ?? cached?.symbol ?? '');
          if (symbolOf.toLowerCase() !== wanted) continue;
          out.push({
            symbol: symbolOf,
            decimals: Number(token?.metadata?.decimals ?? cached?.decimals ?? 0),
            balance: Number(token?.balance ?? 0)
          });
        }
      }
      return out;
    },
    { wanted: symbol.toLowerCase() }
  );

  let total = 0n;
  for (const t of raw) total += rowBaseUnits(`vaultBalance(${symbol})`, t.balance, t.decimals);
  return total;
}

/**
 * Base units of one store row. `balance` is a display float; recover base units via the
 * token's own decimals. Rounding here is safe because we round a value the product itself
 * derived from base units, and we assert the round-trip is exact.
 */
function rowBaseUnits(label: string, balance: number, decimals: number): bigint {
  const scaled = balance * Math.pow(10, decimals);
  const rounded = Math.round(scaled);
  if (!Number.isSafeInteger(rounded)) {
    throw new Error(`${label}: base-unit balance is not a safe integer`);
  }
  if (Math.abs(scaled - rounded) > 1e-6) {
    throw new Error(
      `${label}: store balance ${balance} does not round-trip at ${decimals} decimals ` +
        `(scaled=${scaled}). Refusing to assert on a lossy value.`
    );
  }
  return BigInt(rounded);
}

/** Spendable base units for one full, canonical bech32 faucet id, independent of its symbol. */
export async function vaultBalanceByFaucetId(page: Page, faucetId: string): Promise<bigint> {
  const raw = await page.evaluate(wanted => {
    const store:
      | {
          getState?: () => {
            balances?: Record<string, TokenBalanceData[]>;
            assetsMetadata?: Record<string, AssetMetadata>;
          };
        }
      | undefined = Reflect.get(window, '__TEST_STORE__');
    const state = store?.getState?.();
    const out: Array<{ decimals: number; balance: number }> = [];
    for (const tokenList of Object.values(state?.balances ?? {})) {
      if (!Array.isArray(tokenList)) continue;
      for (const token of tokenList) {
        if (token?.tokenId !== wanted) continue;
        const cached = state?.assetsMetadata?.[wanted];
        out.push({
          decimals: Number(token?.metadata?.decimals ?? cached?.decimals),
          balance: Number(token?.balance ?? 0)
        });
      }
    }
    return out;
  }, faucetId);

  let total = 0n;
  for (const token of raw) {
    if (!Number.isInteger(token.decimals) || token.decimals < 0) {
      throw new Error(`vaultBalanceByFaucetId(${faucetId}): missing or invalid token decimals`);
    }
    total += rowBaseUnits(`vaultBalanceByFaucetId(${faucetId})`, token.balance, token.decimals);
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
 * Returns the max rather than throwing so the caller owns the comparison - an
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
 * This is the right assertion for "the mint arrived" - a minted note is discovered
 * before it is consumed, so its value is pending, not spendable. Asserting the
 * VAULT here would be wrong (it stays 0 until a claim) and asserting vault+pending
 * summed together - what the old `getBalance` did - cannot tell the two apart at
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
 * balance that has not moved yet and reports `debited 0` - a green send scored as
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
      `  (an unchanged vault here means the send never debited the sender, not that it is slow -\n` +
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
  return pollVaultBalance(
    page,
    `waitForVaultBalance(${symbol})`,
    () => vaultBalance(page, symbol),
    expected,
    opts,
    async () => {
      const pending = await pendingNoteTotal(page, symbol).catch(() => -1n);
      return (
        `  unconsumed notes for ${symbol}: ${pending === -1n ? 'unreadable' : pending.toString()} base units\n` +
        `  (a non-zero pending total with a short vault means the note was discovered but never consumed)`
      );
    }
  );
}

/** Wait for an exact spendable balance of one canonical faucet, or report expected and actual units. */
export async function waitForVaultBalanceByFaucetId(
  page: Page,
  faucetId: string,
  expected: bigint,
  opts: { timeoutMs?: number } = {}
): Promise<void> {
  return pollVaultBalance(
    page,
    `waitForVaultBalanceByFaucetId(${faucetId})`,
    () => vaultBalanceByFaucetId(page, faucetId),
    expected,
    opts
  );
}

interface CurrentAccountRows {
  account: string | null;
  rows: Array<{ tokenId: string; decimals: number; balance: number }>;
}

// The store keys `balances` by the account's public key, the same key `currentAccount` carries (withLandedBalances in
// src/lib/store/index.ts), so the current account's rows are one lookup and no other account's rows can leak in.
async function currentAccountRows(page: Page): Promise<CurrentAccountRows> {
  return page.evaluate(() => {
    const store:
      | {
          getState?: () => {
            currentAccount?: { publicKey?: string } | null;
            balances?: Record<string, TokenBalanceData[]>;
            assetsMetadata?: Record<string, AssetMetadata>;
          };
        }
      | undefined = Reflect.get(window, '__TEST_STORE__');
    const state = store?.getState?.();
    const account = state?.currentAccount?.publicKey;
    const rows = account === undefined ? [] : (state?.balances?.[account] ?? []);
    return {
      account: account ?? null,
      rows: rows.map(token => ({
        tokenId: String(token?.tokenId ?? ''),
        decimals: Number(token?.metadata?.decimals ?? state?.assetsMetadata?.[String(token?.tokenId ?? '')]?.decimals),
        balance: Number(token?.balance ?? 0)
      }))
    };
  });
}

function rowsToBaseUnits(label: string, rows: CurrentAccountRows['rows']): bigint {
  let total = 0n;
  for (const row of rows) {
    if (!Number.isInteger(row.decimals) || row.decimals < 0)
      throw new Error(`${label}: missing or invalid token decimals`);
    total += rowBaseUnits(label, row.balance, row.decimals);
  }
  return total;
}

/**
 * Spendable base units of one faucet in the CURRENT account only. `vaultBalance` and `vaultBalanceByFaucetId` sum
 * every account's rows, so with a second account in the wallet a debit on one hides behind the other's balance.
 */
export async function vaultBalanceOfCurrentAccount(page: Page, faucetId: string): Promise<bigint> {
  const { account, rows } = await currentAccountRows(page);
  if (account === null) throw new Error('vaultBalanceOfCurrentAccount: the store has no current account');
  return rowsToBaseUnits(
    `vaultBalanceOfCurrentAccount(${faucetId})`,
    rows.filter(row => row.tokenId === faucetId)
  );
}

/** Wait for an exact spendable balance of one faucet in the current account, or report expected and actual units. */
export async function waitForVaultBalanceOfCurrentAccount(
  page: Page,
  faucetId: string,
  expected: bigint,
  opts: { timeoutMs?: number } = {}
): Promise<void> {
  return pollVaultBalance(
    page,
    `waitForVaultBalanceOfCurrentAccount(${faucetId})`,
    () => vaultBalanceOfCurrentAccount(page, faucetId),
    expected,
    opts
  );
}

/** Nonzero assets of the current account as faucet id to base units, the shape `assetMap` gives a dApp's view. */
export async function vaultAssetsOfCurrentAccount(page: Page): Promise<Record<string, string>> {
  const { account, rows } = await currentAccountRows(page);
  if (account === null) throw new Error('vaultAssetsOfCurrentAccount: the store has no current account');
  const ids = [...new Set(rows.map(row => row.tokenId))];
  const entries = ids.map(
    id =>
      [
        id,
        rowsToBaseUnits(
          `vaultAssetsOfCurrentAccount(${id})`,
          rows.filter(row => row.tokenId === id)
        )
      ] as const
  );
  return Object.fromEntries(
    entries.filter(([, amount]) => amount !== 0n).map(([id, amount]) => [id, amount.toString()])
  );
}

/** Re-read `read` every 2s until it equals `expected`, or throw with both amounts and `diagnose`'s lines. */
async function pollVaultBalance(
  page: Page,
  label: string,
  read: () => Promise<bigint>,
  expected: bigint,
  opts: { timeoutMs?: number; decimals?: number },
  diagnose: () => Promise<string> = async () => ''
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;
  let last = -1n;
  while (Date.now() < deadline) {
    last = await read();
    if (last === expected) return;
    await page.waitForTimeout(2_000);
  }
  const d = opts.decimals;
  const fmt = (v: bigint) => (d == null ? v.toString() : `${fromBaseUnits(v, d)} (${v} base units)`);
  throw new Error(
    `${label} timed out after ${timeoutMs}ms.\n` +
      `  expected vault: ${fmt(expected)}\n` +
      `  actual vault:   ${fmt(last)}\n` +
      (await diagnose())
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
 * The value the wallet cached under `prefix` (a cache name and its current version), or `null`.
 *
 * The wallet writes one entry per (RPC URL, network) scope and keeps the others, so two current-version
 * entries mean the profile has seen two chains: refuse rather than let key order pick one. Entries under an
 * older version are ignored.
 */
async function walletCacheEntry(page: Page, prefix: string): Promise<unknown> {
  return page.evaluate(async wanted => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = (globalThis as any).chrome;
    if (!c?.storage?.local) return null;
    const all = await c.storage.local.get(null);
    const keys = Object.keys(all).filter(k => k.startsWith(wanted));
    if (keys.length > 1) throw new Error(`ambiguous wallet cache, one entry per profile expected: ${keys.join(', ')}`);
    return keys.length === 0 ? null : all[keys[0]!];
  }, prefix);
}

/**
 * The chain's `verification_base_fee` as the WALLET discovered it, or `null` if the
 * wallet has not discovered it.
 *
 * Read from the extension's own cache (the NATIVE_ASSET_FEE_CACHE entry written by
 * `lib/miden-chain/native-asset`) rather than from the harness's knowledge of how
 * the node was genesised. That makes a spec self-describing -- it can require a fee
 * on a fee-charging chain and say so on a fee-free one -- and it doubles as an
 * assertion that the wallet's fee discovery works at all.
 *
 * `null` and `0` are different answers: `0` is a chain that charges nothing,
 * `null` is a wallet that does not know. Callers must not collapse them.
 */
export async function walletDiscoveredBaseFee(page: Page): Promise<number | null> {
  const v = await walletCacheEntry(page, `${NATIVE_ASSET_FEE_CACHE}:`);
  if (!v || typeof v !== 'object' || !('faucetId' in v) || !('baseFee' in v)) return null;
  const { faucetId, baseFee } = v;
  if (typeof baseFee !== 'number' || !Number.isFinite(baseFee) || !Number.isInteger(baseFee) || baseFee < 0)
    return null;
  return faucetId === (await walletDiscoveredNativeFaucetId(page)) ? baseFee : null;
}

/**
 * The chain's native (fee) faucet id as the WALLET discovered it, or `null`.
 *
 * Read from the extension's own cache (the NATIVE_ASSET_ID_CACHE entry). Preferred
 * over looking the row up by symbol: the native asset's symbol comes from chain
 * metadata that a local chain need not supply, so a symbol lookup can miss on a
 * wallet that knows the faucet perfectly well.
 */
export async function walletDiscoveredNativeFaucetId(page: Page): Promise<string | null> {
  const v = await walletCacheEntry(page, `${NATIVE_ASSET_ID_CACHE}:`);
  return typeof v === 'string' ? v : null;
}

/**
 * Every asset row the store holds, for diagnostics when a lookup finds nothing.
 *
 * Field names match `TokenBalanceData` (`src/lib/miden/front/balance.ts`) deliberately.
 * This previously read `token.faucetId` and `token.amountBaseUnits`, neither of which
 * exists on that type, so every row printed `faucetId: '(none)'` and fell through to
 * `balance` - a DECIMAL display number - under a key named `amount`. This output is
 * what a failing fee assertion prints, so it was actively misdescribing the store at
 * the one moment someone reads it.
 */
export async function listVaultAssets(
  page: Page
): Promise<Array<{ tokenId: string; symbol: string; balanceDecimal: string }>> {
  return page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const state = (window as any).__TEST_STORE__?.getState?.();
    const out: Array<{ tokenId: string; symbol: string; balanceDecimal: string }> = [];
    for (const tokenList of Object.values(state?.balances ?? {}) as unknown[]) {
      if (!Array.isArray(tokenList)) continue;
      for (const token of tokenList) {
        out.push({
          tokenId: String(token?.tokenId ?? '(none)'),
          symbol: String(token?.metadata?.symbol ?? '(none)'),
          balanceDecimal: String(token?.balance ?? '(none)')
        });
      }
    }
    return out;
  });
}
