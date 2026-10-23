export const MAINNET_ONE_CLICK_CAP_MICRO_USD = 2_000_000n;
export const MAINNET_ONE_CLICK_PRICE_SOURCE = 'CoinGecko simple price API';
export const MAINNET_ONE_CLICK_MAX_CANDIDATES = 4;
export const MAINNET_ONE_CLICK_DRY_PROBES_PER_CANDIDATE = 8;

export function usdToMicroDollarsCeil(value: string): bigint {
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
  if (!match) throw new Error('USD amount must be a non-negative decimal without exponent notation');
  const whole = BigInt(match[1] ?? '0');
  const fraction = match[2] ?? '';
  const firstSix = fraction.slice(0, 6).padEnd(6, '0');
  const rounded = BigInt(firstSix);
  const remainder = fraction.slice(6);
  return whole * 1_000_000n + rounded + (/[1-9]/.test(remainder) ? 1n : 0n);
}

export function tokenValueUsdMicro(amountBaseUnits: bigint, decimals: number, priceUsdMicros: bigint, roundUp: boolean): bigint {
  if (amountBaseUnits < 0n || priceUsdMicros < 0n || !Number.isSafeInteger(decimals) || decimals < 0 || decimals > 38) {
    throw new Error('Invalid token USD valuation input');
  }
  const numerator = amountBaseUnits * priceUsdMicros;
  const denominator = 10n ** BigInt(decimals);
  const quotient = numerator / denominator;
  return roundUp && numerator % denominator > 0n ? quotient + 1n : quotient;
}

export async function searchSmallestViableAmount<T>(options: {
  firstAmount: bigint;
  maximumAmount: bigint;
  attempts: number;
  quote: (amount: bigint) => Promise<T | undefined>;
}): Promise<{ amount: bigint; quote: T }> {
  if (options.firstAmount <= 0n || options.maximumAmount < options.firstAmount ||
      !Number.isSafeInteger(options.attempts) || options.attempts < 1 || options.attempts > 8) {
    throw new Error('Invalid bounded 1Click amount search');
  }
  const digits = options.maximumAmount.toString().length - options.firstAmount.toString().length;
  const steps = Math.max(options.attempts - 1, 1);
  const decimalPower = Math.max(1, Math.ceil(Math.max(digits, 0) / steps));
  const multiplier = 10n ** BigInt(decimalPower);
  const amounts: bigint[] = [options.firstAmount];
  while (amounts.length < options.attempts - 1) {
    const next = (amounts[amounts.length - 1] ?? options.firstAmount) * multiplier;
    if (next >= options.maximumAmount) break;
    amounts.push(next);
  }
  if (amounts.length < options.attempts && amounts[amounts.length - 1] !== options.maximumAmount) {
    amounts.push(options.maximumAmount);
  }
  for (const amount of amounts) {
    const quote = await options.quote(amount);
    if (quote !== undefined) return { amount, quote };
  }
  throw new Error('No viable 1Click quote found within the bounded dry-quote search; the smallest viable amount was not established');
}

export interface OneClickLegBound {
  inputUsdMicros: bigint;
  minimumOutputUsdMicros: bigint;
  nativeFeeUsdMicros: bigint;
}

export interface OneClickRoundTripCandidate {
  routeId: string;
  symbol: string;
  amountBaseUnits: bigint;
  availableBaseUnits: bigint;
  forward: OneClickLegBound;
  reverse: OneClickLegBound;
  providerFeesUsdMicros?: bigint;
}

export interface OneClickRoundTripPlan extends OneClickRoundTripCandidate {
  quoteLossUsdMicros: bigint;
  providerFeesUsdMicros: bigint;
  nativeFeesUsdMicros: bigint;
  worstCaseCostUsdMicros: bigint;
}

function nonNegative(label: string, value: bigint): void {
  if (value < 0n) throw new Error(`${label} cannot be negative`);
}

function legLossUsdMicros(leg: OneClickLegBound): bigint {
  nonNegative('input USD value', leg.inputUsdMicros);
  nonNegative('minimum output USD value', leg.minimumOutputUsdMicros);
  nonNegative('native fee USD value', leg.nativeFeeUsdMicros);
  return leg.inputUsdMicros > leg.minimumOutputUsdMicros
    ? leg.inputUsdMicros - leg.minimumOutputUsdMicros
    : 0n;
}

export function planOneClickRoundTrip(candidate: OneClickRoundTripCandidate): OneClickRoundTripPlan {
  if (candidate.amountBaseUnits <= 0n || candidate.availableBaseUnits < 0n) {
    throw new Error(`Invalid principal for route ${candidate.routeId}`);
  }
  if (candidate.availableBaseUnits < candidate.amountBaseUnits) {
    throw new Error(`The existing holding cannot cover route ${candidate.routeId}`);
  }
  const quoteLossUsdMicros = legLossUsdMicros(candidate.forward) + legLossUsdMicros(candidate.reverse);
  const providerFeesUsdMicros = candidate.providerFeesUsdMicros ?? 0n;
  nonNegative('provider fees USD value', providerFeesUsdMicros);
  const nativeFeesUsdMicros = candidate.forward.nativeFeeUsdMicros + candidate.reverse.nativeFeeUsdMicros;
  const plan = {
    ...candidate,
    quoteLossUsdMicros,
    providerFeesUsdMicros,
    nativeFeesUsdMicros,
    worstCaseCostUsdMicros: quoteLossUsdMicros + providerFeesUsdMicros + nativeFeesUsdMicros
  };
  if (plan.worstCaseCostUsdMicros > MAINNET_ONE_CLICK_CAP_MICRO_USD) {
    throw new Error('No funded 1Click route fits the $2.00 round-trip safety cap');
  }
  return plan;
}

export function chooseCheapestOneClickRoute<T extends { plan: OneClickRoundTripPlan; chainPriority: number }>(
  candidates: readonly T[]
): T | undefined {
  return [...candidates].sort((left, right) => {
    if (left.plan.worstCaseCostUsdMicros !== right.plan.worstCaseCostUsdMicros) {
      return left.plan.worstCaseCostUsdMicros < right.plan.worstCaseCostUsdMicros ? -1 : 1;
    }
    return left.chainPriority - right.chainPriority;
  })[0];
}

export function remainingOneClickCostBudget(
  realizedCostUsdMicros: bigint,
  remainingWorstCaseUsdMicros: bigint
): bigint {
  nonNegative('realized cost', realizedCostUsdMicros);
  nonNegative('remaining worst-case cost', remainingWorstCaseUsdMicros);
  const total = realizedCostUsdMicros + remainingWorstCaseUsdMicros;
  if (total > MAINNET_ONE_CLICK_CAP_MICRO_USD) {
    throw new Error('The remaining 1Click leg exceeds the $2.00 round-trip safety cap');
  }
  return MAINNET_ONE_CLICK_CAP_MICRO_USD - realizedCostUsdMicros;
}
