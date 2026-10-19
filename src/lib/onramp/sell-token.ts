/**
 * Find the Miden token that a Transak sale bridges out, and the exact amount of it.
 *
 * Transak asks for a decimal amount of the token it receives on Ethereum (TRNSK on Sepolia, 18 decimals). The wallet
 * pays that amount from the Agglayer-bridged TRNSK faucet on Miden. That faucet has its own decimals, and the bridge
 * multiplies an exit by `10^scale` to get the Ethereum amount. This module makes sure of three things before a sale
 * can start:
 * - exactly one faucet is the token to sell, and the bridge registry accepts it;
 * - the registry says that this faucet came from the relay token on Ethereum, so the exit releases that token;
 * - the faucet amount times `10^scale` is exactly the amount the backend relays, so no unit is lost or left behind.
 */
import { parseUnits } from 'viem';

import { isAgglayerFaucetAllowed } from 'lib/agglayer/allowed-faucets';
import { AGGLAYER_TRNSK_FAUCET_ID } from 'lib/agglayer/constant';
import { compareAccountIds } from 'lib/miden/activity/utils';
import type { TokenBalanceData } from 'lib/miden/front/balance';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { accountRefToSdk } from 'lib/miden/sdk/helpers';
import { ensureSdkWasmReady } from 'lib/miden-chain/constants';
import { getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import type { BridgeToken } from 'lib/remote-config/derive';
import { initBridgeConfig } from 'lib/remote-config/runtime';
import { findAgglayerTokens, getAgglayerEvmNetworkId } from 'lib/remote-config/values';

import { SELL_RELAY_TOKEN, sellRelayTokenAmount } from './sell-signer';

/**
 * Why a sale cannot start.
 *   - no-token             : the account holds no token to sell
 *   - ambiguous-token      : more than one faucet can be the token, so the wallet does not choose
 *   - unknown-scale        : the decimals of the faucet are not known
 *   - not-registered       : the bridge registry does not map the faucet to the relay token on Ethereum
 *   - amount               : the faucet cannot hold the amount exactly, or the bridge would release another amount
 *   - insufficient-balance : the balance is less than the amount
 *   - unavailable          : the bridge registry or its config could not be read
 */
export type SellTokenBlock =
  | 'no-token'
  | 'ambiguous-token'
  | 'unknown-scale'
  | 'not-registered'
  | 'amount'
  | 'insufficient-balance'
  | 'unavailable';

/** The token of a sale and the amount of it, ready for the bridge-out. */
export interface SellToken {
  /** Miden faucet of the token, as the balances give it (bech32). */
  faucetId: string;
  symbol: string;
  decimals: number;
  /** The amount in the base units of the faucet. */
  amount: bigint;
  /** The amount that the exit releases on Ethereum, in the base units of the relay token. */
  evmAmount: bigint;
}

export type SellTokenResolution =
  | { kind: 'ready'; token: SellToken }
  | { kind: 'blocked'; reason: SellTokenBlock; symbol: string };

const blocked = (reason: SellTokenBlock, symbol: string = SELL_RELAY_TOKEN.symbol): SellTokenResolution => ({
  kind: 'blocked',
  reason,
  symbol
});

/** The balance rows that can be the token to sell, before the registry check. */
function candidatesOf(balances: readonly TokenBalanceData[]): TokenBalanceData[] {
  const pinned = AGGLAYER_TRNSK_FAUCET_ID;
  if (pinned !== undefined) return balances.filter(row => compareAccountIds(row.tokenId, pinned));
  return balances.filter(row => row.metadata.symbol === SELL_RELAY_TOKEN.symbol);
}

/** The base units of `cryptoAmount` at `decimals`, or null when the amount has more fraction digits than that. */
function exactUnits(cryptoAmount: string, decimals: number): bigint | null {
  const match = /^\d+(?:\.(\d+))?$/.exec(cryptoAmount);
  if (match === null || (match[1]?.length ?? 0) > decimals) return null;
  return parseUnits(cryptoAmount, decimals);
}

/** The registry entry of `faucetId`. The ids are compared through the SDK, because the two sides differ in form. */
function registryEntryOf(tokens: readonly BridgeToken[], faucetId: string): BridgeToken | undefined {
  const wanted = accountRefToSdk(faucetId).toString();
  return tokens.find(token => accountRefToSdk(token.midenFaucetId).toString() === wanted);
}

/**
 * Resolve the token and the amount of a sale from the balances of the account. A result of `ready` means that the
 * bridge-out of `token.amount` releases exactly the amount that the backend relays to Transak.
 *
 * `isAllowed` is the registry check. Tests replace it; the default asks the bridge account on the node.
 */
export async function resolveSellToken(input: {
  /** The amount that Transak asked for, as a decimal string. */
  cryptoAmount: string;
  balances: readonly TokenBalanceData[];
  isAllowed?: (faucetId: string) => Promise<boolean>;
}): Promise<SellTokenResolution> {
  const { cryptoAmount, balances } = input;
  const isAllowed = input.isAllowed ?? ((faucetId: string) => isAgglayerFaucetAllowed(faucetId, getEffectiveRpcUrl()));

  let accepted: TokenBalanceData[];
  let tokens: BridgeToken[] | null;
  let evmNetworkId: number;
  try {
    await initBridgeConfig();
    await ensureSdkWasmReady();
    const candidates = candidatesOf(balances);
    const verdicts = await Promise.all(candidates.map(row => isAllowed(row.tokenId)));
    accepted = candidates.filter((_row, index) => verdicts[index] === true);
    tokens = findAgglayerTokens();
    evmNetworkId = getAgglayerEvmNetworkId();
  } catch (error) {
    console.warn('[sell]', 'cannot read the bridge registry', error);
    return blocked('unavailable');
  }

  const [row, ...others] = accepted;
  if (row === undefined) return blocked('no-token');
  if (others.length > 0) return blocked('ambiguous-token');
  const { symbol, decimals } = row.metadata;
  if (!hasKnownScale(row.metadata)) return blocked('unknown-scale', symbol);
  if (tokens === null) return blocked('unavailable', symbol);

  const entry = registryEntryOf(tokens, row.tokenId);
  if (
    entry === undefined ||
    entry.originToken.toLowerCase() !== SELL_RELAY_TOKEN.address.toLowerCase() ||
    entry.originNetwork !== evmNetworkId
  ) {
    return blocked('not-registered', symbol);
  }

  let relayAmount: bigint;
  try {
    relayAmount = sellRelayTokenAmount(cryptoAmount);
  } catch {
    return blocked('amount', symbol);
  }
  const amount = exactUnits(cryptoAmount, decimals);
  if (amount === null || amount <= 0n) return blocked('amount', symbol);
  const evmAmount = amount * 10n ** BigInt(entry.scale);
  // The exit must release what the backend relays, to the last unit. A faucet whose decimals plus the registry
  // scale is not the decimals of the relay token fails here.
  if (evmAmount !== relayAmount) return blocked('amount', symbol);

  // The balance is a display number. This check stops the usual case early; the transaction itself is the proof.
  if (!(row.balance >= Number(cryptoAmount))) return blocked('insufficient-balance', symbol);

  return { kind: 'ready', token: { faucetId: row.tokenId, symbol, decimals, amount, evmAmount } };
}
