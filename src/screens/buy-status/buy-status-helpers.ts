import { BUY_PHASES, IBuyExtraInputs, IBuyPhase, ITransaction } from 'lib/miden/db/types';
import { formatAmount } from 'lib/shared/format';
import type { TransactionStepState } from 'screens/generating-transaction/types';

/** The Sepolia explorer page of a relay transaction. */
export const sepoliaTxUrl = (hash: string): string => `https://sepolia.etherscan.io/tx/${hash}`;

/** The i18n key of the step row for a phase. `failed` has no row of its own. */
export const buyStepLabelKey = (phase: IBuyPhase): string => {
  switch (phase) {
    case 'payment':
      return 'buyStepPayment';
    case 'funds-arriving':
      return 'buyStepFundsArriving';
    case 'bridge-sent':
      return 'buyStepBridgeSent';
    case 'bridging':
      return 'buyStepBridging';
    case 'consuming':
      return 'buyStepConsuming';
    case 'completed':
    case 'failed':
      return 'buyStepCompleted';
  }
};

const isBuyPhase = (value: string): value is IBuyPhase => value === 'failed' || BUY_PHASES.some(p => p === value);

/**
 * Get the buy inputs of a row. Return `undefined` when the row is not a `buy` row or when its
 * `extraInputs` do not have the fields this screen reads.
 *
 * `extraInputs` has no static type on `ITransaction`, so this function makes the checks at
 * runtime. It does not cast.
 */
export const buyInputsOf = (row: ITransaction | undefined): IBuyExtraInputs | undefined => {
  if (row?.type !== 'buy') return undefined;
  const extra: IBuyExtraInputs | undefined = row.extraInputs;
  if (!extra || typeof extra !== 'object') return undefined;
  if (typeof extra.orderId !== 'string' || typeof extra.fiatAmount !== 'string') return undefined;
  if (typeof extra.phase !== 'string' || !isBuyPhase(extra.phase)) return undefined;
  return extra;
};

/**
 * Get the index in `BUY_PHASES` of the step that shows as active.
 *
 * A failed order has no index of its own. Its step is the last phase that has a timestamp, because
 * that phase is where the order stopped.
 */
export const buyActiveIndex = (inputs: IBuyExtraInputs): number => {
  switch (inputs.phase) {
    case 'failed': {
      let last = 0;
      BUY_PHASES.forEach((phase, index) => {
        if (inputs.phaseTimestamps?.[phase] !== undefined) last = index;
      });
      return last;
    }
    default:
      return Math.max(0, BUY_PHASES.indexOf(inputs.phase));
  }
};

/**
 * Get the filled part of the progress bar, from 0 to 1.
 *
 * A step that is in progress fills half of its segment. The completed order fills the full bar.
 */
export const buyProgressFraction = (inputs: IBuyExtraInputs): number => {
  const index = buyActiveIndex(inputs);
  const segment = inputs.phase === 'completed' ? 1 : 0.5;
  return Math.min(1, (index + segment) / BUY_PHASES.length);
};

/** Get the state of the step at `index`. */
export const buyStepState = (inputs: IBuyExtraInputs, index: number): TransactionStepState => {
  const active = buyActiveIndex(inputs);
  if (index < active) return 'complete';
  if (index > active) return 'pending';
  switch (inputs.phase) {
    case 'completed':
      return 'complete';
    case 'failed':
      return 'failed';
    default:
      return 'active';
  }
};

/**
 * Get the duration of each step in milliseconds, or `undefined` when it is not known.
 *
 * A step starts at its own timestamp. It stops at the next timestamp of a later phase, or at the
 * `failed` timestamp. The active step stops at `now`, so its value increases while the screen is
 * open. The last step (`completed`) has no duration.
 */
export const buyStepDurationsMs = (inputs: IBuyExtraInputs, now: number): (number | undefined)[] => {
  const stamps = inputs.phaseTimestamps ?? {};
  const active = buyActiveIndex(inputs);
  return BUY_PHASES.map((phase, index) => {
    if (phase === 'completed') return undefined;
    const start = stamps[phase];
    if (start === undefined) return undefined;
    const nextStamp = BUY_PHASES.slice(index + 1)
      .map(later => stamps[later])
      .find(stamp => stamp !== undefined);
    const inProgress = index === active && inputs.phase !== 'failed' && inputs.phase !== 'completed';
    const end = nextStamp ?? stamps.failed ?? (inProgress ? now : undefined);
    if (end === undefined || end < start) return undefined;
    return end - start;
  });
};

/**
 * Get the token part of the summary, for example "19.8 USDC". When the token amount is not known,
 * show the symbol only.
 */
export const buyTokenLabel = (inputs: IBuyExtraInputs): string => {
  const amount = formatBuyTokenAmount(inputs);
  return amount === undefined ? inputs.tokenSymbol : `${amount} ${inputs.tokenSymbol}`;
};

/**
 * Format the token amount (base units) with the token decimals. Return `undefined` when either is
 * not known, because a number with a guessed scale can be wrong by many orders of magnitude.
 */
export const formatBuyTokenAmount = (inputs: IBuyExtraInputs): string | undefined => {
  const { tokenAmount, tokenDecimals } = inputs;
  if (tokenAmount === undefined || tokenDecimals === undefined || !/^\d+$/.test(tokenAmount)) return undefined;
  return formatAmount(BigInt(tokenAmount), tokenDecimals);
};

/** True when the order cannot change any more. */
export const isBuyTerminal = (phase: IBuyPhase): boolean => {
  switch (phase) {
    case 'completed':
    case 'failed':
      return true;
    default:
      return false;
  }
};
