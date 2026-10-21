import { useMemo } from 'react';

import { useAllBalances, useAllTokensBaseMetadata } from 'lib/miden/front';
import { valuedBalanceTotal } from 'lib/miden/front/fiat-total';
import { priceSymbolFor } from 'lib/miden/swap/tokens';
import { pricesLoaded } from 'lib/prices';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';
import { selectBridgeInMaxBalanceUsd } from 'lib/remote-config/values';
import { useWalletStore } from 'lib/store';

/**
 * Where a bridge-in stands against the document's balance ceiling (`limits.bridgeInMaxBalanceUsd`).
 *
 * - `none`: the document sets no ceiling, so nothing is held.
 * - `loading`: a ceiling is set and the account's holdings or the price feed are not in yet; Continue waits.
 * - `unpriced`: a ceiling is set and the deposit token has no feed price, so the deposit cannot be weighed against
 *   it; the deposit is refused rather than let through unvalued.
 * - `clear`: the account's valued holdings plus this deposit stay at or under the ceiling.
 * - `exceeded`: they would pass it; the deposit is refused.
 */
export type BridgeInBalanceCapVerdict =
  | { state: 'none' }
  | { state: 'loading' }
  | { state: 'unpriced'; capUsd: number }
  | { state: 'clear'; capUsd: number; heldUsd: number; depositUsd: number }
  | { state: 'exceeded'; capUsd: number; heldUsd: number; depositUsd: number };

export interface BridgeInBalanceCapInput {
  /** The ceiling, or null when the document sets none. */
  capUsd: number | null;
  /** The receiving account's valued holdings in US dollars, or null while they are not in yet. */
  heldUsd: number | null;
  /** The deposit as typed, in whole tokens, or null while no valid amount is typed. */
  depositAmount: number | null;
  /** The deposit token's price in US dollars per whole token, or undefined when the feed has none. */
  depositPriceUsd: number | undefined;
}

/** Pure: the verdict for one set of inputs. Decimal money is compared after rounding to the cent. */
export function bridgeInBalanceCapVerdict({
  capUsd,
  heldUsd,
  depositAmount,
  depositPriceUsd
}: BridgeInBalanceCapInput): BridgeInBalanceCapVerdict {
  if (capUsd === null) return { state: 'none' };
  if (heldUsd === null || depositAmount === null) return { state: 'loading' };
  if (depositPriceUsd === undefined || !(depositPriceUsd > 0)) return { state: 'unpriced', capUsd };
  const depositUsd = depositAmount * depositPriceUsd;
  const verdict = { capUsd, heldUsd, depositUsd };
  // Two floats summed can land a hair over an exact ceiling; the cent is the unit the figures are shown in.
  const cents = (usd: number) => Math.round(usd * 100);
  return cents(heldUsd) + cents(depositUsd) > cents(capUsd)
    ? { state: 'exceeded', ...verdict }
    : { state: 'clear', ...verdict };
}

export interface UseBridgeInBalanceCapOptions {
  /** The Miden account the deposit lands in. */
  accountPublicKey: string;
  /** The deposit as typed, in whole tokens, or null while no valid amount is typed. */
  depositAmount: number | null;
  /** The deposit token's price in US dollars per whole token, or undefined when the feed has none. */
  depositPriceUsd: number | undefined;
}

/**
 * The bridge-in ceiling verdict for a deposit into `accountPublicKey`, from the document's ceiling, the account's
 * holdings as the Home card values them (`valuedBalanceTotal`) and the store's price feed. The holdings read is the
 * same polled read Home makes, so a cap-less document pays for one more reader of balances already in the store.
 */
export function useBridgeInBalanceCap({
  accountPublicKey,
  depositAmount,
  depositPriceUsd
}: UseBridgeInBalanceCapOptions): BridgeInBalanceCapVerdict {
  const bridgeConfig = useBridgeConfigSnapshot();
  const capUsd = selectBridgeInMaxBalanceUsd(bridgeConfig);
  const allTokensBaseMetadata = useAllTokensBaseMetadata();
  const { data: balances = [], isLoading } = useAllBalances(accountPublicKey, allTokensBaseMetadata);
  const tokenPrices = useWalletStore(s => s.tokenPrices);

  return useMemo(() => {
    if (capUsd === null) return { state: 'none' };
    // A total summed before the feed's first quote counts a priced token at nothing, which would wave a deposit through
    // against a balance the next render values; so the holdings wait for the feed where a held token needs it.
    const symbols = balances.map(token => priceSymbolFor(token.tokenId, token.metadata.symbol));
    const heldUsd =
      isLoading || !pricesLoaded(tokenPrices, symbols) ? null : valuedBalanceTotal(balances, tokenPrices).totalFiat;
    return bridgeInBalanceCapVerdict({ capUsd, heldUsd, depositAmount, depositPriceUsd });
  }, [capUsd, balances, isLoading, tokenPrices, depositAmount, depositPriceUsd]);
}
