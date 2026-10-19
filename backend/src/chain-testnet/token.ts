import { SEPOLIA_CHAIN_ID } from './calibur.js';
import type { OrderSide } from '../orders/states.js';
import { OFFRAMP_TOKENS, ONRAMP_TOKENS, type RelayToken } from '../tokens.js';

export const ONRAMP_TOKEN = ONRAMP_TOKENS[SEPOLIA_CHAIN_ID];
export const OFFRAMP_TOKEN = OFFRAMP_TOKENS[SEPOLIA_CHAIN_ID];

/** The token that the relay of an order moves: the bought token in, or the released token out. */
export function tokenOf(side: OrderSide): RelayToken {
  switch (side) {
    case 'buy':
      return ONRAMP_TOKEN;
    case 'sell':
      return OFFRAMP_TOKEN;
  }
}
