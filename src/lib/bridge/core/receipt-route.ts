import { parseStoredDerived } from 'lib/remote-config/derived-snapshot';
import { parseBridgeConfig } from 'lib/remote-config/schema';
import { isRecord } from 'lib/update/guards';

import type { BridgeAsset } from './assets';
import { routeMatchesRecovery, type BridgeRecoveryConfig, type BridgeRoute } from './routes';

function asset(value: unknown): BridgeAsset | undefined {
  if (
    !isRecord(value) ||
    typeof value.network !== 'string' ||
    typeof value.symbol !== 'string' ||
    !value.symbol ||
    value.symbol.length > 32 ||
    typeof value.decimals !== 'number' ||
    !Number.isInteger(value.decimals) ||
    value.decimals < 0 ||
    value.decimals > 255
  )
    return undefined;
  const metadata = { network: value.network, symbol: value.symbol, decimals: value.decimals };
  if (value.kind === 'native') return { ...metadata, kind: 'native' };
  if (value.kind === 'erc20' && typeof value.address === 'string' && /^0x[\da-f]{40}$/i.test(value.address)) {
    return { ...metadata, kind: 'erc20', address: value.address };
  }
  if (
    value.kind === 'miden' &&
    typeof value.faucetId === 'string' &&
    /^0x[\da-f]{30}$/.test(value.faucetId) &&
    value.decimals <= 18
  ) {
    return { ...metadata, kind: 'miden', faucetId: value.faucetId };
  }
  return undefined;
}

/** Read untrusted persisted terms without consulting today's starts, native identity or catalog. */
export function parseReceiptRoute(value: unknown): BridgeRoute | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !value.id ||
    value.id.length > 512 ||
    (value.provider !== 'agglayer' && value.provider !== 'epoch' && value.provider !== 'xreserve') ||
    (value.mode !== 'receive' && value.mode !== 'send') ||
    (value.disabled !== undefined && typeof value.disabled !== 'boolean') ||
    !isRecord(value.recovery)
  )
    return undefined;
  const { network } = value.recovery;
  if (typeof network !== 'string') return undefined;
  const config = parseBridgeConfig(value.recovery.config, network);
  if (!config) return undefined;
  const derived = parseStoredDerived(value.recovery.derived, network, config.version);
  const source = asset(value.source);
  const destination = asset(value.destination);
  if (!derived || !source || !destination) return undefined;
  const recovery: BridgeRecoveryConfig = { network, config, derived };
  const native = value.recovery.nativeAsset;
  if (native !== undefined) {
    if (
      !isRecord(native) ||
      typeof native.faucetId !== 'string' ||
      !/^0x[\da-f]{30}$/.test(native.faucetId) ||
      native.symbol !== 'USDCx' ||
      native.decimals !== 6 ||
      typeof native.scope !== 'string' ||
      !native.scope ||
      typeof native.revision !== 'number' ||
      !Number.isSafeInteger(native.revision) ||
      native.revision < 0
    )
      return undefined;
    recovery.nativeAsset = {
      faucetId: native.faucetId,
      symbol: native.symbol,
      decimals: native.decimals,
      scope: native.scope,
      revision: native.revision
    };
  }
  const route: BridgeRoute = {
    id: value.id,
    provider: value.provider,
    mode: value.mode,
    source,
    destination,
    recovery,
    ...(value.disabled === undefined ? {} : { disabled: value.disabled })
  };
  return routeMatchesRecovery(route) ? route : undefined;
}
