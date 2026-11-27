/**
 * The contract between the relay deposit screen (`EvmBridgeDepositScreen` with a relay source), the NEAR Intents
 * deposit flow (`NearDepositFlow`) and the flow that holds both (`DepositFlow`). Each screen keeps its own state; a
 * hand-over passes the selection (the pair and the typed amount) and, from a route sheet, the route that was picked.
 */
import type { DepositTokenOption } from 'screens/deposit-flow/DepositTokenSheet';
import type { DepositNetworkDisplay } from 'screens/deposit-flow/types';

import type { DepositToken } from './deposit-token';
import type { RelayRoute } from './relay-deposit-record';
import type { RelayTokenChoice } from './relay-token-choices';

/** The chain, token, amount and (optional) route that the relay screen opens on. */
export interface RelayOpeningForm {
  chainId: number;
  token: DepositToken;
  /** The typed amount, decimal text. */
  amount: string;
  /** The route to open on. Absent: the token's own route. */
  route?: RelayRoute;
}

/** The steps of the relay screen's deposit-address flow. */
export type RelayFormStep = 'restoring' | 'amount' | 'review' | 'address' | 'processing';

/** What the relay screen reports when its selection changes. */
export interface RelayFormReport {
  chainId: number;
  token: DepositToken;
  /** The typed amount, decimal text. */
  amount: string;
  step: RelayFormStep;
}

/** The network chips and rows of the token sheet, when another flow adds rows to the relay's. */
export interface DepositTokenSheetRows {
  networks: readonly DepositNetworkDisplay[];
  tokens: readonly DepositTokenOption[];
}

/** A hand-over from the NEAR Intents flow to the relay screen. */
export interface RelayHandover {
  /** The token sheet id of a pair that the relay serves. */
  pairId: string;
  /** The typed amount, decimal text. */
  amount: string;
  /** The relay route that the user picked in the route sheet. Absent: the pair's own route. */
  route?: RelayRoute;
}

/** The token sheet of the relay screen: the rows that `rows` gives, else the relay's own. */
export function depositSheetOf(
  rows: DepositTokenSheetRows | undefined,
  relayNetworks: readonly DepositNetworkDisplay[],
  relayChoices: readonly RelayTokenChoice[]
): DepositTokenSheetRows {
  return rows ?? { networks: relayNetworks, tokens: relayChoices.map(choice => choice.option) };
}
