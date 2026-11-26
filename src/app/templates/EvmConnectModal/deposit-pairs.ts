/**
 * The token sheet of the Deposit flow: the union of the tokens that the relay deposits (`relayTokenChoices`) and the
 * pairs of the NEAR Intents catalogue, as the mock-up's `NETS` lists them. One row for each source token on each network
 * and each Miden token it arrives as; a pair that both serve is one row.
 */
import { normalizedFaucetId } from 'lib/miden/swap/faucet-ids';
import { nearIntentsEvmChainId } from 'lib/one-click/chains';
import type { NearIntentsCatalog, NearIntentsCatalogChain } from 'lib/one-click/types';
import type { DepositTokenOption } from 'screens/deposit-flow/DepositTokenSheet';
import type { DepositNetworkDisplay } from 'screens/deposit-flow/types';
import { chainLogoNetwork, type NearIntentsSelection } from 'screens/near-intents-flow/chains';
import { getBridgeNetworkByChainId } from 'screens/send-flow/bridge-networks';

import { NATIVE_TOKEN_ADDRESS, type RelayTokenChoice } from './relay-token-choices';

/** One NEAR Intents pair: the 1Click origin chain, the origin token and the Miden output. */
export type NearPairRef = Required<NearIntentsSelection>;

/** One row of the token sheet, and the routes that serve it. */
export interface DepositPair {
  option: DepositTokenOption;
  /** The relay token of the row, when the relay serves it. */
  relay?: RelayTokenChoice;
  /** The NEAR Intents pair of the row, when NEAR Intents serves it. */
  near?: NearPairRef;
}

export interface DepositPairs {
  /** The network chips, in order: the relay's chains, then the other chains of NEAR Intents in the document's order. */
  networks: DepositNetworkDisplay[];
  /** Every row, grouped by network in the order of `networks`. */
  pairs: DepositPair[];
}

/** The sheet id of a pair that only NEAR Intents serves. */
export function nearPairId(ref: NearPairRef): string {
  return `near:${ref.chainId}:${ref.tokenAssetId}:${ref.outputAssetId}`;
}

/** The chip of a NEAR Intents chain: the relay's chip of the same EVM chain, else the chain's own. */
function nearNetworkOf(
  chain: NearIntentsCatalogChain,
  networks: readonly DepositNetworkDisplay[]
): DepositNetworkDisplay {
  const evmChainId = chain.addressKind === 'evm' ? nearIntentsEvmChainId(chain.id) : undefined;
  const bridge = evmChainId === undefined ? undefined : getBridgeNetworkByChainId(evmChainId);
  const id = bridge?.id ?? chainLogoNetwork(chain.id);
  return networks.find(network => network.id === id) ?? { id, name: chain.name };
}

/** True when two Miden tokens are the same: the same faucet, else (a faucet not known) the same symbol. */
function sameMidenToken(
  faucetA: string | undefined,
  symbolA: string,
  faucetB: string | undefined,
  symbolB: string
): boolean {
  if (faucetA !== undefined && faucetB !== undefined) {
    return normalizedFaucetId(faucetA) === normalizedFaucetId(faucetB);
  }
  return symbolA.toUpperCase() === symbolB.toUpperCase();
}

/**
 * The rows of the token sheet. `relayChoices` and `relayNetworks` are the relay's (empty when the relay is off), and
 * `catalog` is the NEAR Intents catalogue (undefined while it loads or when NEAR Intents is off). A NEAR Intents pair
 * on an EVM chain is the relay's row when the relay deposits the same token (contract, or the native coin) on that chain
 * and it arrives as the same Miden token.
 */
export function depositPairs(
  relayChoices: readonly RelayTokenChoice[],
  relayNetworks: readonly DepositNetworkDisplay[],
  catalog: NearIntentsCatalog | undefined
): DepositPairs {
  const networks: DepositNetworkDisplay[] = [...relayNetworks];
  const pairs: DepositPair[] = relayChoices.map(choice => ({ option: choice.option, relay: choice }));
  for (const chain of catalog?.chains ?? []) {
    const network = nearNetworkOf(chain, networks);
    const evmChainId = chain.addressKind === 'evm' ? nearIntentsEvmChainId(chain.id) : undefined;
    for (const token of chain.tokens) {
      const address = (token.asset.contractAddress ?? NATIVE_TOKEN_ADDRESS).toLowerCase();
      for (const output of token.outputs) {
        const ref: NearPairRef = {
          chainId: chain.id,
          tokenAssetId: token.asset.assetId,
          outputAssetId: output.assetId
        };
        const shared = pairs.find(
          pair =>
            pair.relay !== undefined &&
            pair.near === undefined &&
            pair.relay.chainId === evmChainId &&
            pair.relay.address === address &&
            sameMidenToken(pair.relay.option.logoFaucetId, pair.option.receivedSymbol, output.faucetId, output.symbol)
        );
        if (shared !== undefined) {
          shared.near = ref;
          continue;
        }
        if (!networks.some(entry => entry.id === network.id)) networks.push(network);
        pairs.push({
          option: {
            id: nearPairId(ref),
            symbol: token.symbol,
            receivedSymbol: output.symbol,
            logoFaucetId: output.faucetId,
            network
          },
          near: ref
        });
      }
    }
  }
  const order = (pair: DepositPair) => networks.findIndex(network => network.id === pair.option.network.id);
  // A stable sort: the rows of one network keep their order, the relay's first.
  return { networks, pairs: [...pairs].sort((a, b) => order(a) - order(b)) };
}

/** The row of a relay token on a chain, when the sheet has it. */
export function pairOfRelay(pairs: DepositPairs, choiceId: string): DepositPair | undefined {
  return pairs.pairs.find(pair => pair.relay !== undefined && pair.option.id === choiceId);
}

/** The first row that NEAR Intents serves. */
export function firstNearPair(pairs: DepositPairs): DepositPair | undefined {
  return pairs.pairs.find(pair => pair.near !== undefined);
}
