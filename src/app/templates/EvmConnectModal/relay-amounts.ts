/**
 * The numbers of a relay deposit for the amount that the user types. The typed amount is what the user SENDS to the
 * deposit address (the mock-up's `fees()`: `recv = v - fee`): "You send" is that amount, "Bridge fee" is what each
 * route takes out of it, and "You receive" is the rest.
 *
 * - Agglayer and a direct Circle xReserve deposit are 1:1: no fee.
 * - Circle's executor route: the burn is the amount less the fee that Circle quoted for it (`executorSendSplit`).
 * - Epoch: the allocator quotes in reverse, so the screen searches for the largest amount to receive whose deposit is
 *   not above the typed amount (`searchEpochSendQuote`). Its fee is the typed amount less what arrives.
 *
 * These are module functions, not code in the screen: each branch in the screen's body counts against the hooks lint
 * rule (see `EvmBridgeDepositScreen.tsx`).
 */
import { formatUnits } from 'viem';

import { convertUnits } from 'lib/epoch/send-amount-search';
import { executorSendSplit } from 'lib/usdcx/executor-send';
import type { DepositRouteOption } from 'screens/deposit-flow/DepositRouteSheet';
import type { DepositAmountValue, DepositFee } from 'screens/deposit-flow/types';

import { rankRouteOptions } from './deposit-routes';
import type { RelayRoute } from './relay-deposit-record';

/** A fee that the receipt cannot show yet (no amount typed): the mock-up's rate slot, which a quote fills. */
const NO_FEE_YET = '–';

/** The Epoch search that the screen keeps for one typed amount. */
export interface EpochSendQuote {
  /** The typed send amount, trimmed, that the search ran for. */
  send: string;
  /** What arrives, in the Miden token's base units, or null when no quote fits. */
  receiveUnits: bigint | null;
}

/** What the screen knows of the routes of the typed amount. */
export interface RelayAmountsInput {
  /** The typed amount in source base units, or null when it is not a valid amount. */
  typedUnits: bigint | null;
  /** The typed amount as text, trimmed. */
  typedText: string;
  sourceDecimals: number;
  /** Circle's route on this chain is the executor route (a burn that Circle executes on Arc). */
  circleExecutor: boolean;
  /** Circle's fee quoted for the typed amount on the executor route, or undefined while there is none. */
  circleFee: bigint | undefined;
  /** Circle refused the quote of the typed amount. */
  circleQuoteFailed: boolean;
  /**
   * The Epoch search of the typed amount, while the Epoch route is chosen and its accepted quote is the one in the
   * store (`epochReceiveOf`), else null.
   */
  epochReceive: { units: bigint; decimals: number } | null;
  /** The last Epoch search, for its "no fit" answer. */
  epochSend: EpochSendQuote | null;
  /** The text of a fee that a quote is still computing ("Loading"). */
  loadingText: string;
}

/** What one route gives for the typed amount. */
export interface RelayRouteView {
  /** What the user sends (the typed amount) once the route's numbers are known, else null: Review waits. */
  sendUnits: bigint | null;
  /** What arrives, or undefined while it is not known. */
  received: DepositAmountValue | undefined;
  /** The bridge fee, taken out of the amount sent. */
  fee: DepositFee;
  /** The fee as a share of the amount sent, for the review's high-fee notice. */
  feeShare: number | undefined;
  /** No quote fits the typed amount: the fee takes all of it, or no Epoch quote fits in three tries. */
  noFit: boolean;
}

/**
 * The Epoch receive amount of the typed amount: the accepted search, while the Epoch route is chosen and its quote is
 * ready (`fastReady`, which holds the store's quote to the search). Else null.
 */
export function epochReceiveOf(
  route: RelayRoute,
  fastReady: boolean,
  send: EpochSendQuote | null,
  decimals: number | undefined
): { units: bigint; decimals: number } | null {
  if (route !== 'epoch' || !fastReady || send === null || send.receiveUnits === null || decimals === undefined) {
    return null;
  }
  return { units: send.receiveUnits, decimals };
}

/** What arrives and the fee in source base units, or null while not known. */
function receivedAndFee(
  route: RelayRoute,
  input: RelayAmountsInput,
  typedUnits: bigint
): { received: DepositAmountValue; feeUnits: bigint } | null {
  const oneToOne = { received: { amount: typedUnits, decimals: input.sourceDecimals }, feeUnits: 0n };
  switch (route) {
    case 'agglayer':
      return oneToOne;
    case 'usdcx': {
      if (!input.circleExecutor) return oneToOne;
      if (input.circleFee === undefined) return null;
      const split = executorSendSplit(typedUnits, input.circleFee);
      return split === null
        ? null
        : { received: { amount: split.burnUnits, decimals: input.sourceDecimals }, feeUnits: split.feeUnits };
    }
    case 'epoch': {
      const { epochReceive } = input;
      if (epochReceive === null) return null;
      const inSource = convertUnits(epochReceive.units, epochReceive.decimals, input.sourceDecimals, 'down');
      return {
        received: { amount: epochReceive.units, decimals: epochReceive.decimals },
        feeUnits: inSource < typedUnits ? typedUnits - inSource : 0n
      };
    }
  }
}

/** True for a 1:1 route, which takes no bridge fee: Agglayer, and a direct Circle xReserve deposit. */
function takesNoFee(route: RelayRoute, input: RelayAmountsInput): boolean {
  return route === 'agglayer' || (route === 'usdcx' && !input.circleExecutor);
}

/** True when the route has an answer for the typed amount that no deposit fits. */
function noFitOf(route: RelayRoute, input: RelayAmountsInput): boolean {
  if (input.typedUnits === null) return false;
  switch (route) {
    case 'agglayer':
      return false;
    case 'usdcx':
      return (
        input.circleExecutor &&
        input.circleFee !== undefined &&
        executorSendSplit(input.typedUnits, input.circleFee) === null
      );
    case 'epoch':
      return (
        input.epochSend !== null && input.epochSend.send === input.typedText && input.epochSend.receiveUnits === null
      );
  }
}

/** The numbers of one route for the typed amount. */
export function relayRouteView(route: RelayRoute, input: RelayAmountsInput): RelayRouteView {
  const noFit = noFitOf(route, input);
  const known = input.typedUnits === null ? null : receivedAndFee(route, input, input.typedUnits);
  if (known === null || input.typedUnits === null) {
    const quoteFailed = route === 'usdcx' && input.circleQuoteFailed;
    const waiting = input.typedUnits !== null && !noFit && !quoteFailed;
    // With no amount the receipt shows the route's rate (the mock-up's `quote()`): "None" for a 1:1 route.
    const fee: DepositFee = takesNoFee(route, input)
      ? { kind: 'none' }
      : { kind: 'rate', text: waiting ? input.loadingText : NO_FEE_YET };
    return { sendUnits: null, received: undefined, fee, feeShare: undefined, noFit };
  }
  const sendUnits = input.typedUnits;
  const fee: DepositFee =
    known.feeUnits > 0n
      ? { kind: 'amount', value: { amount: known.feeUnits, decimals: input.sourceDecimals } }
      : { kind: 'none' };
  return {
    sendUnits,
    received: known.received,
    fee,
    feeShare: sendUnits > 0n ? Number(known.feeUnits) / Number(sendUnits) : undefined,
    noFit
  };
}

/** The exact decimal text of an amount value. */
export function amountValueText(value: DepositAmountValue): string {
  return value.decimals === undefined ? value.amount : formatUnits(value.amount, value.decimals);
}

/** An amount value in USD at `priceUsd`, or undefined with no amount or no price. */
export function amountValueUsd(
  value: DepositAmountValue | undefined,
  priceUsd: number | undefined
): number | undefined {
  if (value === undefined || priceUsd === undefined) return undefined;
  return Number(amountValueText(value)) * priceUsd;
}

/** Base units with their decimals, or undefined for null units. */
export function unitsValue(units: bigint | null, decimals: number): DepositAmountValue | undefined {
  return units === null ? undefined : { amount: units, decimals };
}

export interface RelayRouteRowsInput {
  /** The routes that the pair can take, in the order of cost (`RELAY_ROUTES_BY_COST`). */
  routes: readonly RelayRoute[];
  selected: RelayRoute;
  chainId: number;
  amounts: RelayAmountsInput;
  nameOf: (route: RelayRoute) => string;
  arrivesInOf: (route: RelayRoute, chainId: number) => string;
}

/**
 * The relay rows of the route sheet: what each route receives for the typed send amount and its fee, ranked by what
 * arrives (`rankRouteOptions`: "Most received" and "Fastest" by the real numbers). A route whose numbers are not known
 * yet (the Epoch route while another route is chosen) has no amount and no fee line, but the chosen route always shows
 * its fee.
 */
export function relayRouteRows({
  routes,
  selected,
  chainId,
  amounts,
  nameOf,
  arrivesInOf
}: RelayRouteRowsInput): DepositRouteOption[] {
  const rows = routes.map((route): DepositRouteOption => {
    const view = relayRouteView(route, amounts);
    const isSelected = route === selected;
    return {
      id: route,
      name: nameOf(route),
      arrivesIn: arrivesInOf(route, chainId),
      received: view.received,
      fee: isSelected || view.received !== undefined ? view.fee : undefined,
      best: false,
      fastest: false,
      selected: isSelected
    };
  });
  return rankRouteOptions(rows, chainId);
}
