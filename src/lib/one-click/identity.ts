import type {
  NearIntentsAddressKind,
  NearIntentsChainConfig,
  NearIntentsConfig,
  NearIntentsMidenAssetConfig,
  NearIntentsTokenConfig,
  OneClickAsset
} from './types';

/** One configured origin token with the chain that names it. */
export interface NearIntentsOriginMatch {
  chain: NearIntentsChainConfig;
  token: NearIntentsTokenConfig;
}

/** A configured pair: one origin token and one Miden token that the origin token lists in `miden`. */
export interface NearIntentsRoute extends NearIntentsOriginMatch {
  midenAsset: NearIntentsMidenAssetConfig;
}

/**
 * Compare two contract addresses with the rule of the chain. An EVM address is the same in upper and lower case.
 * The other address formats are case-sensitive, so they must be equal.
 */
export function sameNearIntentsContractAddress(kind: NearIntentsAddressKind, left: string, right: string): boolean {
  switch (kind) {
    case 'evm':
      return left.toLowerCase() === right.toLowerCase();
    case 'solana':
    case 'bitcoin':
    case 'near':
      return left === right;
  }
}

/** Write a configured contract address in the form that the wallet keeps: lower case for an EVM address. */
export function normalizedNearIntentsContractAddress(kind: NearIntentsAddressKind, value: string): string {
  return kind === 'evm' ? value.toLowerCase() : value;
}

function chainsOf(config: NearIntentsConfig): readonly NearIntentsChainConfig[] {
  // A tracking row written before NEAR Intents moved to the Receive page keeps an older config with no `chains`.
  return Array.isArray(config.chains) ? config.chains : [];
}

/**
 * Find the configured origin token that `asset` is. The asset id, the chain, the decimals and, when the config
 * gives one, the contract address must agree.
 */
export function findNearIntentsOriginToken(
  config: NearIntentsConfig,
  asset: OneClickAsset
): NearIntentsOriginMatch | undefined {
  for (const chain of chainsOf(config)) {
    if (chain.id !== asset.blockchain) continue;
    const token = chain.tokens.find(candidate => candidate.assetId === asset.assetId);
    if (!token) continue;
    if (token.decimals !== asset.decimals) return undefined;
    if (token.contractAddress !== undefined) {
      if (
        typeof asset.contractAddress !== 'string' ||
        !sameNearIntentsContractAddress(chain.addressKind, token.contractAddress, asset.contractAddress)
      )
        return undefined;
    }
    return { chain, token };
  }
  return undefined;
}

/** Find the configured Miden token that `asset` is. The asset id and the decimals must agree, and the faucet when given. */
export function findNearIntentsMidenAsset(
  config: NearIntentsConfig,
  asset: OneClickAsset
): NearIntentsMidenAssetConfig | undefined {
  if (asset.blockchain !== 'miden') return undefined;
  const configured = config.midenAssets.find(candidate => candidate.assetId === asset.assetId);
  if (!configured || configured.decimals !== asset.decimals) return undefined;
  if (asset.faucetId !== undefined && asset.faucetId.toLowerCase() !== configured.faucetId.toLowerCase())
    return undefined;
  return configured;
}

/**
 * Make sure that the two assets of a quote are trusted and are a configured pair. Into Miden, the destination must
 * be one of the `miden` outputs of the origin token. The older Miden-to-chain start path uses the same pair in the
 * other direction.
 */
export function assertNearIntentsRoute(
  config: NearIntentsConfig,
  originAsset: OneClickAsset,
  destinationAsset: OneClickAsset
): NearIntentsRoute {
  const intoMiden = destinationAsset.blockchain === 'miden';
  const chainAsset = intoMiden ? originAsset : destinationAsset;
  const midenAsset = intoMiden ? destinationAsset : originAsset;
  if (chainAsset.blockchain === 'miden' || midenAsset.blockchain !== 'miden')
    throw new Error('1Click quote is not for a configured NEAR Intents pair');
  const origin = findNearIntentsOriginToken(config, chainAsset);
  const miden = findNearIntentsMidenAsset(config, midenAsset);
  if (!origin || !miden) throw new Error('1Click asset does not match its trusted identity');
  if (!origin.token.miden.includes(miden.id)) throw new Error('1Click quote is not for a configured NEAR Intents pair');
  return { ...origin, midenAsset: miden };
}
