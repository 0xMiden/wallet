import { BasicFungibleFaucetComponent, RpcClient } from '@miden-sdk/miden-sdk/lazy';

import { accountRefToSdk } from 'lib/miden/sdk/helpers';
import { normalizedFaucetId } from 'lib/miden/swap/tokens';
import { ensureSdkWasmReady, getRpcEndpoint } from 'lib/miden-chain/constants';
import { withRpcTimeout } from 'lib/miden-chain/rpc-timeout';

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
    const constituents: BasketConstituent[] = [];
    for (const id of listedConstituents) {
      const constituentSymbol = assets.get(normalizedFaucetId(id));
      const places = decimals?.get(id);
      if (constituentSymbol === undefined || places === undefined) break;
      constituents.push({ faucetId: id, priceSymbol: constituentSymbol, decimals: places });
    }
    if (constituents.length === listedConstituents.length) {
      sources.push({ faucetId: listedId, priceSymbol, constituents });
    }
  }
  return sources;
}

const VAULT_READ_TIMEOUT_MS = 10_000;

/** Reads a basket's public vault from the node: the faucet's supply and decimals, and each constituent's balance. */
export async function readBasketVault(source: BasketSource): Promise<BasketVault> {
  await ensureSdkWasmReady();
  const rpc = new RpcClient(getRpcEndpoint());
  try {
    const fetched = await withRpcTimeout(
      () => rpc.getAccountDetails(accountRefToSdk(source.faucetId)),
      'basket vault',
      { timeoutMs: VAULT_READ_TIMEOUT_MS }
    );
    const account = fetched.account();
    if (!account) throw new Error(`${source.faucetId} has no public state`);
    const faucet = BasicFungibleFaucetComponent.fromAccountStorage(account.storage());
    const vault = account.vault();
    return {
      supply: faucet.tokenSupply().asInt(),
      decimals: faucet.decimals(),
      balances: source.constituents.map(c => vault.getBalance(accountRefToSdk(c.faucetId)))
    };
  } finally {
    rpc.free();
  }
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
