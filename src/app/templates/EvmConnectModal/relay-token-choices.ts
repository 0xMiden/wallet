import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { evmUsdcLabel } from 'lib/remote-config/token-labels';
import {
  selectAgglayerChain,
  selectAgglayerDepositTokens,
  selectEpochDepositTokens,
  selectNativeEthFaucet
} from 'lib/remote-config/values';
import { CIRCLE_USDC_SYMBOL, isUsdcxRouteEnabled, USDCX_SYMBOL, usdcxSourceChains } from 'lib/usdcx/constant';
import type { DepositTokenOption } from 'screens/deposit-flow/DepositTokenSheet';
import type { BridgeNetwork } from 'screens/send-flow/bridge-networks';

import { type DepositToken, depositTokenKey } from './deposit-token';

/** The zero address: the native coin, on an AggLayer and on an Epoch route alike. */
const NATIVE_TOKEN_ADDRESS = '0x0000000000000000000000000000000000000000';
const ETH_SYMBOL = 'ETH';

/** One row of the relay token sheet: what it shows, and the chain and token that a pick selects. */
export interface RelayTokenChoice {
  option: DepositTokenOption;
  chainId: number;
  token: DepositToken;
}

/** The sheet id of a token on a chain. */
export function relayTokenChoiceId(chainId: number, token: DepositToken): string {
  return `${chainId}:${depositTokenKey(token)}`;
}

/**
 * The tokens that a relay source can deposit, on each of `networks` (the chains that the relay serves, in order), as
 * the deposit screen offers them: Circle USDC where the chain's Circle route (`bridges.usdcx`) takes deposits, native
 * ETH where the chain has an AggLayer route, each token of the chain's Epoch route, and each ERC-20 that the document
 * lists for the AggLayer route. An Epoch token at Circle USDC's address is the Circle USDC row there, an Epoch token at
 * the native address is the ETH row, and an ERC-20 that an Epoch token names is that Epoch row. `usdcxFaucetId` is the
 * Miden faucet that Circle USDC arrives in (USDCx), which keys its logo.
 */
export function relayTokenChoices(
  snapshot: BridgeConfigSnapshot,
  networks: readonly BridgeNetwork[],
  usdcxFaucetId?: string
): RelayTokenChoice[] {
  const circleSources = usdcxSourceChains(snapshot);
  return networks.flatMap(network => {
    const { chainId } = network;
    const circleUsdc = isUsdcxRouteEnabled(chainId, 'deposit') ? circleSources.get(chainId)?.usdc : undefined;
    const display = { id: network.id, name: network.name };
    const choice = (
      token: DepositToken,
      symbol: string,
      receivedSymbol: string,
      logoFaucetId: string | undefined
    ): RelayTokenChoice => ({
      option: { id: relayTokenChoiceId(chainId, token), symbol, receivedSymbol, logoFaucetId, network: display },
      chainId,
      token
    });
    const agglayer = selectAgglayerChain(snapshot, chainId) !== null;
    const epochTokens = selectEpochDepositTokens(snapshot, chainId);
    const epochAddresses = new Set(epochTokens.map(token => token.address.toLowerCase()));
    const choices: RelayTokenChoice[] = [];
    if (circleUsdc !== undefined) {
      choices.push(choice('CIRCLE_USDC', CIRCLE_USDC_SYMBOL, USDCX_SYMBOL, usdcxFaucetId));
    }
    if (agglayer) {
      choices.push(choice('ETH', ETH_SYMBOL, ETH_SYMBOL, selectNativeEthFaucet(snapshot, chainId) ?? undefined));
    }
    for (const token of epochTokens) {
      if (circleUsdc !== undefined && token.address.toLowerCase() === circleUsdc.toLowerCase()) continue;
      if (agglayer && token.address.toLowerCase() === NATIVE_TOKEN_ADDRESS) continue;
      const symbol = token.key === 'USDC' ? evmUsdcLabel(snapshot, token.symbol) : token.symbol;
      choices.push(choice({ kind: 'epoch', key: token.key }, symbol, token.midenSymbol, token.midenFaucetId));
    }
    if (agglayer) {
      for (const token of selectAgglayerDepositTokens(snapshot, chainId) ?? []) {
        if (epochAddresses.has(token.contractAddress.toLowerCase())) continue;
        choices.push(
          choice(
            { kind: 'erc20', contractAddress: token.contractAddress },
            token.symbol,
            token.symbol,
            token.midenFaucetId
          )
        );
      }
    }
    return choices;
  });
}
