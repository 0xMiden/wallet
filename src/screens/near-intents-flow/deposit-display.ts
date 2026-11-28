import BigNumber from 'bignumber.js';

import { formatUsdDisplay } from 'lib/i18n/amount-display';
import type { IOneClickTrackingData } from 'lib/miden/db/types';
import type { DepositAmountValue, DepositFee } from 'screens/deposit-flow/types';

const BASE_UNITS = /^[0-9]{1,78}$/;
const MAX_DECIMALS = 38;

/**
 * An amount of the saved quote for the deposit views: base units with the token's decimals when both are valid, else
 * the decimal text that 1Click formatted. Display only.
 */
export function quoteAmountValue(units: string | undefined, decimals: number, formatted: string): DepositAmountValue {
  const valid =
    units !== undefined &&
    BASE_UNITS.test(units) &&
    Number.isInteger(decimals) &&
    decimals >= 0 &&
    decimals <= MAX_DECIMALS;
  return valid ? { amount: BigInt(units), decimals } : { amount: formatted };
}

/** What the user must send: the quote's input amount in the origin token. */
export function nearIntentsSentValue(tracking: IOneClickTrackingData): DepositAmountValue {
  const { quote } = tracking.quote;
  return quoteAmountValue(quote.amountIn, tracking.originAsset.decimals, quote.amountInFormatted);
}

/**
 * What arrives in the wallet: the row's amount in the destination token. It is the quote's output amount, and the
 * amount that 1Click delivered once it reports the delivery.
 */
export function nearIntentsReceivedValue(tracking: IOneClickTrackingData): DepositAmountValue {
  return quoteAmountValue(tracking.amount, tracking.destinationAsset.decimals, tracking.quote.quote.amountOutFormatted);
}

/**
 * The amount that reached the deposit address of an incomplete deposit, from the last 1Click status. Undefined when
 * 1Click did not report it.
 */
export function nearIntentsDepositedValue(tracking: IOneClickTrackingData): DepositAmountValue | undefined {
  const deposited = tracking.statusResponse?.swapDetails.depositedAmount;
  if (deposited === undefined) return undefined;
  const value = quoteAmountValue(deposited, tracking.originAsset.decimals, '');
  return value.amount === '' ? undefined : value;
}

/**
 * The bridge fee of the quote in USD: the USD value that goes in less the USD value that comes out, rounded up.
 * Undefined when 1Click gave no valid USD values.
 */
export function nearIntentsBridgeFee(tracking: IOneClickTrackingData): DepositFee | undefined {
  const { amountInUsd, amountOutUsd } = tracking.quote.quote;
  // Decimal arithmetic: a float difference such as 45.99 - 45.91 is a little over 0.08 and rounds up to 0.09.
  const usdIn = new BigNumber(amountInUsd);
  const usdOut = new BigNumber(amountOutUsd);
  if (!usdIn.isFinite() || !usdOut.isFinite()) return undefined;
  return { kind: 'rate', text: formatUsdDisplay(BigNumber.max(0, usdIn.minus(usdOut)), { rounding: 'up' }) };
}

/** The name of the origin chain from the config the row keeps. A row from before the chain list shows the 1Click id. */
export function nearIntentsChainName(tracking: IOneClickTrackingData): string {
  const origin = tracking.originAsset.blockchain;
  return tracking.config.chains?.find(chain => chain.id === origin)?.name ?? origin;
}
