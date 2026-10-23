import { isRecord } from 'lib/update/guards';

import type { OneClickAsset, OneClickEvmAssetConfig } from './types';

export const ONE_CLICK_EVM_CHAIN_IDS: Readonly<Record<string, number>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, number>, {
    eth: 1,
    base: 8453,
    arb: 42161,
    op: 10,
    arc: 5042
  })
);

const NATIVE_EVM_ASSETS: Readonly<
  Record<string, { blockchain: string; chainId: number; decimals: 18; symbol: 'ETH' }>
> = {
  'nep141:eth.omft.near': { blockchain: 'eth', chainId: 1, decimals: 18, symbol: 'ETH' },
  'nep141:arb.omft.near': { blockchain: 'arb', chainId: 42161, decimals: 18, symbol: 'ETH' },
  'nep141:base.omft.near': { blockchain: 'base', chainId: 8453, decimals: 18, symbol: 'ETH' },
  'nep245:v2_1.omni.hot.tg:10_11111111111111111111': {
    blockchain: 'op',
    chainId: 10,
    decimals: 18,
    symbol: 'ETH'
  }
};

const isSafeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

export function parseOneClickEvmAssets(
  value: unknown,
  midenAssetIds: ReadonlySet<string> = new Set()
): OneClickEvmAssetConfig[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) throw new Error('Invalid 1Click EVM asset configuration');
  const assetIds = new Set<string>();
  const contracts = new Set<string>();
  const assets = value.map(entry => {
    if (
      !isRecord(entry) ||
      typeof entry.assetId !== 'string' ||
      !entry.assetId.trim() ||
      entry.assetId.length > 256 ||
      hasControlCharacter(entry.assetId) ||
      typeof entry.blockchain !== 'string' ||
      !Object.prototype.hasOwnProperty.call(ONE_CLICK_EVM_CHAIN_IDS, entry.blockchain) ||
      !isSafeInteger(entry.chainId) ||
      entry.chainId !== ONE_CLICK_EVM_CHAIN_IDS[entry.blockchain] ||
      typeof entry.contractAddress !== 'string' ||
      !/^0x[0-9a-fA-F]{40}$/.test(entry.contractAddress) ||
      !isSafeInteger(entry.decimals) ||
      entry.decimals < 0 ||
      entry.decimals > 38 ||
      typeof entry.symbol !== 'string' ||
      !entry.symbol.trim() ||
      entry.symbol.length > 32 ||
      hasControlCharacter(entry.symbol)
    ) {
      throw new Error('Invalid 1Click EVM asset configuration');
    }
    const contractAddress = entry.contractAddress.toLowerCase();
    const contractKey = `${entry.chainId}:${contractAddress}`;
    if (
      assetIds.has(entry.assetId) ||
      midenAssetIds.has(entry.assetId) ||
      contracts.has(contractKey) ||
      Object.prototype.hasOwnProperty.call(NATIVE_EVM_ASSETS, entry.assetId)
    ) {
      throw new Error('Invalid 1Click EVM asset configuration');
    }
    assetIds.add(entry.assetId);
    contracts.add(contractKey);
    return {
      assetId: entry.assetId,
      blockchain: entry.blockchain,
      chainId: entry.chainId,
      contractAddress,
      decimals: entry.decimals,
      symbol: entry.symbol
    };
  });
  return assets;
}

export function assertOneClickAssetIdentity(
  asset: OneClickAsset,
  evmAssets: readonly OneClickEvmAssetConfig[] = []
): void {
  const native = NATIVE_EVM_ASSETS[asset.assetId];
  if (native) {
    if (
      asset.blockchain !== native.blockchain ||
      asset.chainId !== native.chainId ||
      asset.decimals !== native.decimals ||
      asset.symbol !== native.symbol ||
      (asset.contractAddress !== undefined && asset.contractAddress !== 'native')
    ) {
      throw new Error('1Click asset does not match its trusted identity');
    }
    return;
  }
  const configured = evmAssets.find(candidate => candidate.assetId === asset.assetId);
  if (configured) {
    if (
      asset.blockchain !== configured.blockchain ||
      asset.chainId !== configured.chainId ||
      asset.decimals !== configured.decimals ||
      asset.symbol !== configured.symbol ||
      asset.contractAddress?.toLowerCase() !== configured.contractAddress
    ) {
      throw new Error('1Click asset does not match its trusted identity');
    }
    return;
  }
  if (Object.prototype.hasOwnProperty.call(ONE_CLICK_EVM_CHAIN_IDS, asset.blockchain)) {
    throw new Error('1Click EVM asset has no trusted identity');
  }
}

export function isOneClickNativeAssetId(assetId: string): boolean {
  return Object.prototype.hasOwnProperty.call(NATIVE_EVM_ASSETS, assetId);
}
