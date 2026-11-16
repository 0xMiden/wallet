import { Word, type AccountProof } from '@miden-sdk/miden-sdk/lazy';

import { readFaucetProofTokenConfig } from 'lib/miden/metadata/faucet-proof';
import { accountRefToSdk } from 'lib/miden/sdk/helpers';
import { normalizedFaucetId } from 'lib/miden/swap/tokens';
import { ensureSdkWasmReady } from 'lib/miden-chain/constants';
import { getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { withRpcTimeout } from 'lib/miden-chain/rpc-timeout';
import { readWithOwnRpcClient } from 'lib/usdcx/rpc-client';

import { isNominalQuote, quotedPrice, type TokenPriceInfo, type TokenPrices } from './binance';

/** One token a basket holds, as the token list names it. */
export interface BasketConstituent {
  /** As the token list spells it, which is what the vault read is given. */
  faucetId: string;
  priceSymbol: string;
  decimals: number;
}

export interface BasketSource {
  /** As the token list spells it. The basket's faucet account is also its vault. */
  faucetId: string;
  priceSymbol: string;
  constituents: BasketConstituent[];
}

/** What a basket's vault holds and how many shares it has issued, read from chain. */
export interface BasketVault {
  /** Total issuance of the basket token, in its base units. */
  supply: bigint;
  /** The basket token's decimals, from its faucet. */
  decimals: number;
  /** The vault's balance of each constituent, in the constituent's base units, in `constituents` order. */
  balances: bigint[];
}

export type BasketVaultRead = (source: BasketSource) => Promise<BasketVault>;

/**
 * The verified baskets to price from their vault (the token list's `basket`): only a basket whose price asset no
 * exchange lists (`unmarketed`, a verdict from both providers, so a failed lookup never counts) and that no other priced
 * faucet shares, since a quote is keyed by price asset and must not reach another token.
 */
export function basketPriceSources(
  baskets: ReadonlyMap<string, readonly string[]> | null | undefined,
  assets: ReadonlyMap<string, string>,
  decimals: ReadonlyMap<string, number> | null | undefined,
  unmarketed: (symbol: string) => boolean
): BasketSource[] {
  const sources: BasketSource[] = [];
  for (const [listedId, listedConstituents] of baskets ?? []) {
    const priceSymbol = assets.get(normalizedFaucetId(listedId));
    if (priceSymbol === undefined || !unmarketed(priceSymbol)) continue;
    if (Array.from(assets.values()).filter(symbol => symbol === priceSymbol).length > 1) continue;
    // Compared canonically: two spellings of one faucet would count its holding twice.
    const seen = new Set([normalizedFaucetId(listedId)]);
    const constituents: BasketConstituent[] = [];
    for (const id of listedConstituents) {
      const canonical = normalizedFaucetId(id);
      const constituentSymbol = assets.get(canonical);
      const places = decimals?.get(id);
      if (seen.has(canonical) || constituentSymbol === undefined || places === undefined) break;
      seen.add(canonical);
      constituents.push({ faucetId: id, priceSymbol: constituentSymbol, decimals: places });
    }
    if (constituents.length === listedConstituents.length) {
      sources.push({ faucetId: listedId, priceSymbol, constituents });
    }
  }
  return sources;
}

const VAULT_READ_TIMEOUT_MS = 10_000;

/** Decodes one proof into plain values, then frees the proof. */
function readVaultProof(source: BasketSource, proof: AccountProof): BasketVault {
  try {
    if (!proof.accountHeader()) throw new Error(`${source.faucetId} has no public state`);
    const { supply, decimals } = readFaucetProofTokenConfig(proof);
    const assets = proof.vaultFungibleAssets();
    if (!assets) throw new Error(`${source.faucetId} has no vault data`);
    const balances = new Map(assets.map(asset => [asset.faucetId().toString(), asset.amount()]));
    return {
      supply,
      decimals,
      balances: source.constituents.map(c => balances.get(accountRefToSdk(c.faucetId).toString()) ?? 0n)
    };
  } finally {
    proof.free();
  }
}

/**
 * Node and basket pairs with a vault read still unsettled in this realm. The timeout ends the caller's wait, not the
 * read, and a read's client and proof are freed only once it settles, so against a node that accepts and never answers
 * every refresh would park one more client: a basket with a read out on a node refuses the next read of it there until
 * it settles. The same rule as the PSWAP note reads (`pswap-order-note.ts`, #1487).
 */
const unsettledVaultReads = new Set<string>();

/**
 * Reads supply and holdings from one account proof without loading unrelated storage maps. One attempt with its own
 * client: the next price refresh is the retry. The proof is decoded and freed inside the read, so a read the timeout
 * gave up on frees its client and its proof when it ends.
 */
export async function readBasketVault(source: BasketSource): Promise<BasketVault> {
  await ensureSdkWasmReady();
  // The node `readWithOwnRpcClient` builds its client for, read in the same synchronous turn.
  const slot = `${getEffectiveRpcUrl()} ${normalizedFaucetId(source.faucetId)}`;
  if (unsettledVaultReads.has(slot)) {
    throw new Error(`basket vault ${source.faucetId}: the previous read has not settled`);
  }
  unsettledVaultReads.add(slot);
  const settled = () => {
    unsettledVaultReads.delete(slot);
  };
  let pending: Promise<BasketVault>;
  try {
    pending = readWithOwnRpcClient(async rpc => {
      // A zero commitment requests vault data. The SDK consumes these arguments.
      const proof = await rpc.getAccountProof(
        accountRefToSdk(source.faucetId),
        undefined,
        undefined,
        new Word(new BigUint64Array(4))
      );
      return readVaultProof(source, proof);
    });
  } catch (error) {
    settled();
    throw error;
  }
  pending.then(settled, settled);
  return withRpcTimeout(() => pending, 'basket vault', { timeoutMs: VAULT_READ_TIMEOUT_MS, retries: 0 });
}

/** A quote that comes from a market (an exchange, or a fixed $1 stablecoin), never a nominal rate or another basket. */
function marketQuote(prices: TokenPrices, priceSymbol: string): TokenPriceInfo | undefined {
  const quote = quotedPrice(prices, priceSymbol);
  return quote && !isNominalQuote(quote) && quote.source !== 'basket' ? quote : undefined;
}

const asUnits = (amount: bigint, decimals: number): number => Number(amount) / 10 ** decimals;

/**
 * Each constituent's USD value in the vault, in `constituents` order, or undefined while any constituent has no market
 * quote (a value missing a part would be a wrong number, not a smaller one).
 */
export function basketHoldingValues(
  source: BasketSource,
  vault: BasketVault,
  prices: TokenPrices
): number[] | undefined {
  const values: number[] = [];
  for (const [i, c] of source.constituents.entries()) {
    const quote = marketQuote(prices, c.priceSymbol);
    const balance = vault.balances[i];
    if (!quote || balance === undefined) return undefined;
    values.push(asUnits(balance, c.decimals) * quote.price);
  }
  return values;
}

/**
 * The basket's net asset value per token: the value of its vault's constituents divided by its supply. Assets the
 * vault holds besides its constituents (a fee float, a donation) are not counted. Undefined with no supply or no price.
 */
export function basketNav(source: BasketSource, vault: BasketVault, prices: TokenPrices): number | undefined {
  const values = basketHoldingValues(source, vault, prices);
  const supply = asUnits(vault.supply, vault.decimals);
  if (!values || !(supply > 0)) return undefined;
  const nav = values.reduce((sum, value) => sum + value, 0) / supply;
  return Number.isFinite(nav) && nav > 0 ? nav : undefined;
}

/**
 * One quote per basket whose vault was read and whose constituents are all priced, keyed by price asset. A quote
 * carries no 24h move. A basket that fails is left out, so its token stays unpriced as before.
 */
export async function fetchBasketPrices(
  sources: readonly BasketSource[],
  prices: TokenPrices,
  readVault: BasketVaultRead = readBasketVault,
  now: () => number = Date.now
): Promise<TokenPrices> {
  const quotes: TokenPrices = {};
  await Promise.all(
    sources.map(async source => {
      try {
        const vault = await readVault(source);
        const price = basketNav(source, vault, prices);
        if (price !== undefined) {
          quotes[source.priceSymbol] = {
            price,
            change24h: 0,
            percentageChange24h: 0,
            observedAt: now(),
            source: 'basket'
          };
        }
      } catch {
        // Unpriced until the next refresh.
      }
    })
  );
  return quotes;
}

export function isBasketQuote(quote: TokenPriceInfo | undefined): boolean {
  return quote?.source === 'basket';
}
