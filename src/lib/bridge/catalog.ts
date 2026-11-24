import { canonicalWalletAccountId } from 'lib/miden/sdk/helpers';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import {
  captureNativeAssetSnapshot,
  getNativeAssetIdSync,
  getNativeAssetMetadataSync
} from 'lib/miden-chain/native-asset';
import type { getBridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { selectAgglayerDepositTokens, selectEpochTokens } from 'lib/remote-config/values';

import { assetKey, type EvmAsset, type MidenAsset } from './core/assets';
import type { BridgeProvider, FlowMode } from './core/models';
import { isBridgeRouteAvailable } from './core/provider';
import { routeMatchesRecovery, type BridgeRecoveryConfig, type BridgeRoute } from './core/routes';

/** Current starts only. Reference deployments never supply missing contracts, metadata or feature permission. */
export function deriveBridgeRoutes(snapshot: ReturnType<typeof getBridgeConfigSnapshot>): readonly BridgeRoute[] {
  const { config, derived, network } = snapshot;
  if (
    snapshot.status !== 'ready' ||
    !config ||
    !derived ||
    config.network !== network ||
    derived.network !== network ||
    derived.version !== config.version
  )
    return [];
  const recovery: BridgeRecoveryConfig = structuredClone({ network, config, derived });
  if (network === getEffectiveNetworkName()) {
    const before = captureNativeAssetSnapshot();
    const nativeId = getNativeAssetIdSync();
    const faucetId = nativeId ? canonicalWalletAccountId(nativeId) : null;
    const metadata = getNativeAssetMetadataSync();
    const after = captureNativeAssetSnapshot();
    if (
      before.scope === after.scope &&
      before.revision === after.revision &&
      faucetId &&
      /^0x[\da-f]{30}$/.test(faucetId) &&
      metadata?.symbol === 'USDCx' &&
      metadata.decimals === 6 &&
      metadata.scaleIsUnknown !== true
    ) {
      recovery.nativeAsset = { ...after, faucetId, symbol: metadata.symbol, decimals: metadata.decimals };
    }
  }
  const routes: BridgeRoute[] = [];
  for (const [slug, chain] of Object.entries(config.supportedEvmChains)) {
    const midenNetwork = `miden-${network}`;
    const add = (provider: BridgeProvider, evm: EvmAsset, miden: MidenAsset): void => {
      for (const mode of ['receive', 'send'] satisfies FlowMode[]) {
        const route: BridgeRoute = {
          id: `${network}:${provider}:${assetKey(evm)}:${miden.faucetId}:${mode}`,
          provider,
          mode,
          source: mode === 'receive' ? evm : miden,
          destination: mode === 'receive' ? miden : evm,
          recovery
        };
        if (isBridgeRouteAvailable(route) && routeMatchesRecovery(route)) routes.push(route);
      }
    };
    for (const token of selectEpochTokens(snapshot, chain.chainId)) {
      if (token.midenFaucetId === undefined || token.midenDecimals === undefined || token.midenSymbol === undefined)
        continue;
      const evm: EvmAsset =
        token.address.toLowerCase() === '0x0000000000000000000000000000000000000000'
          ? { kind: 'native', network: slug, symbol: token.symbol, decimals: token.decimals }
          : { kind: 'erc20', network: slug, symbol: token.symbol, decimals: token.decimals, address: token.address };
      add('epoch', evm, {
        kind: 'miden',
        network: midenNetwork,
        faucetId: token.midenFaucetId,
        symbol: token.midenSymbol,
        decimals: token.midenDecimals
      });
    }
    const reads = derived.chains[chain.chainId]?.agglayer;
    const native =
      reads?.tokens.state === 'ok'
        ? reads.tokens.value.find(
            token =>
              token.originToken === '0x0000000000000000000000000000000000000000' &&
              reads.evmNetworkId.state === 'ok' &&
              token.originNetwork === reads.evmNetworkId.value
          )
        : undefined;
    if (native && Number.isInteger(native.scale) && native.scale >= 0 && native.scale <= 18) {
      add(
        'agglayer',
        { kind: 'native', network: slug, symbol: 'ETH', decimals: 18 },
        {
          kind: 'miden',
          network: midenNetwork,
          symbol: 'ETH',
          decimals: 18 - native.scale,
          faucetId: native.midenFaucetId
        }
      );
    }
    for (const token of selectAgglayerDepositTokens(snapshot, chain.chainId) ?? []) {
      add(
        'agglayer',
        {
          kind: 'erc20',
          network: slug,
          symbol: token.symbol,
          decimals: token.decimals,
          address: token.contractAddress
        },
        {
          kind: 'miden',
          network: midenNetwork,
          symbol: token.symbol,
          decimals: token.decimals - token.scale,
          faucetId: token.midenFaucetId
        }
      );
    }
    const circle = chain.bridges.usdcx?.tokens.USDC;
    if (circle && recovery.nativeAsset) {
      add(
        'xreserve',
        { kind: 'erc20', network: slug, symbol: 'USDC', decimals: 6, address: circle.contractAddress },
        {
          kind: 'miden',
          network: midenNetwork,
          symbol: 'USDCx',
          decimals: 6,
          faucetId: recovery.nativeAsset.faucetId
        }
      );
    }
  }
  return routes;
}
