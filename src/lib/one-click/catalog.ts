import { isRecord } from 'lib/update/guards';

import { requestOneClickJson } from './client';
import { normalizedNearIntentsContractAddress, sameNearIntentsContractAddress } from './identity';
import type {
  NearIntentsAddressKind,
  NearIntentsCatalog,
  NearIntentsCatalogChain,
  NearIntentsCatalogToken,
  NearIntentsConfig,
  NearIntentsMidenAssetConfig,
  NearIntentsTokenConfig,
  OneClickAsset,
  OneClickOnchainMetadataResolver
} from './types';

const MAX_LISTED_TOKENS = 5000;
const METADATA_READS_AT_ONCE = 4;
const BLOCKCHAIN = /^[a-z][a-z0-9-]{0,31}$/;

/** One entry of `GET /v0/tokens` that has the fields the catalog reads. */
interface ListedToken {
  assetId: string;
  blockchain: string;
  decimals: number;
  contractAddress?: string;
  coingeckoId?: string;
}

function isOptionalText(value: unknown, maxLength: number): boolean {
  return value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= maxLength);
}

// Read the live list. An entry with a bad shape is not used. When an asset id occurs two times, the first entry is
// used, as the live list gives it.
function listedTokens(raw: unknown): Map<string, ListedToken> {
  if (!Array.isArray(raw) || raw.length > MAX_LISTED_TOKENS) throw new Error('Invalid 1Click token response');
  const byId = new Map<string, ListedToken>();
  for (const item of raw) {
    if (
      !isRecord(item) ||
      typeof item.assetId !== 'string' ||
      item.assetId.length < 1 ||
      item.assetId.length > 256 ||
      typeof item.blockchain !== 'string' ||
      !BLOCKCHAIN.test(item.blockchain) ||
      typeof item.decimals !== 'number' ||
      !Number.isSafeInteger(item.decimals) ||
      item.decimals < 0 ||
      item.decimals > 38 ||
      !isOptionalText(item.contractAddress, 256) ||
      !isOptionalText(item.coingeckoId, 128) ||
      byId.has(item.assetId)
    )
      continue;
    byId.set(item.assetId, {
      assetId: item.assetId,
      blockchain: item.blockchain,
      decimals: item.decimals,
      ...(typeof item.contractAddress === 'string' ? { contractAddress: item.contractAddress } : {}),
      ...(typeof item.coingeckoId === 'string' ? { coingeckoId: item.coingeckoId } : {})
    });
  }
  return byId;
}

// A 1Click asset id of the form `1cs_v1:<chain>:<standard>:<address>`.
const ONE_CLICK_V1_ID = /^1cs_v1:([a-z][a-z0-9-]{0,31}):([a-z0-9-]{1,32}):([^:]{1,200})$/;

/**
 * Find the live entry of a configured asset id. An entry with the same id comes first. The live list can give an
 * older id for a token that the config names with its `1cs_v1` id. That id holds the chain and the contract address,
 * so the one entry with the same chain and contract address is the same token. The native coin of a chain
 * (`native:coin`) is the one entry of that chain with no contract address. When the result is not exactly one entry,
 * there is no match.
 */
function liveEntry(
  assetId: string,
  sameAddress: (left: string, right: string) => boolean,
  listed: ReadonlyMap<string, ListedToken>
): ListedToken | undefined {
  const exact = listed.get(assetId);
  if (exact) return exact;
  const parsed = ONE_CLICK_V1_ID.exec(assetId);
  if (!parsed) return undefined;
  const [, blockchain, standard, address] = parsed;
  if (address === undefined) return undefined;
  const native = standard === 'native' && address === 'coin';
  const matches = [...listed.values()].filter(entry => {
    if (entry.blockchain !== blockchain) return false;
    if (native) return entry.contractAddress === undefined;
    return entry.contractAddress !== undefined && sameAddress(address, entry.contractAddress);
  });
  return matches.length === 1 ? matches[0] : undefined;
}

// A Miden faucet id is hex, the same in upper and lower case.
const sameMidenFaucet = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

// Keep a configured origin token only when the live list has it on the same chain, with the same decimals and, when
// the config gives one, the same contract address.
function confirmedOriginAsset(
  chainId: string,
  addressKind: NearIntentsAddressKind,
  token: NearIntentsTokenConfig,
  listed: ReadonlyMap<string, ListedToken>
): OneClickAsset | undefined {
  const live = liveEntry(
    token.assetId,
    (left, right) => sameNearIntentsContractAddress(addressKind, left, right),
    listed
  );
  if (!live || live.blockchain !== chainId || live.decimals !== token.decimals) return undefined;
  if (token.contractAddress !== undefined) {
    if (
      live.contractAddress === undefined ||
      !sameNearIntentsContractAddress(addressKind, token.contractAddress, live.contractAddress)
    )
      return undefined;
  }
  return {
    assetId: token.assetId,
    blockchain: chainId,
    symbol: token.symbol,
    decimals: token.decimals,
    ...(token.contractAddress === undefined
      ? {}
      : { contractAddress: normalizedNearIntentsContractAddress(addressKind, token.contractAddress) }),
    ...(live.coingeckoId === undefined ? {} : { coingeckoId: live.coingeckoId })
  };
}

// Keep a configured Miden token only when the live list has it on Miden with the same decimals, and the faucet on
// chain has the same decimals and a symbol. A failed faucet read drops the token.
async function confirmedMidenAsset(
  configured: NearIntentsMidenAssetConfig,
  listed: ReadonlyMap<string, ListedToken>,
  resolveMetadata: OneClickOnchainMetadataResolver
): Promise<OneClickAsset | undefined> {
  const live = liveEntry(configured.assetId, sameMidenFaucet, listed);
  if (!live || live.blockchain !== 'miden' || live.decimals !== configured.decimals) return undefined;
  const candidate: OneClickAsset = {
    assetId: configured.assetId,
    blockchain: 'miden',
    symbol: '',
    decimals: configured.decimals,
    faucetId: configured.faucetId,
    ...(live.coingeckoId === undefined ? {} : { coingeckoId: live.coingeckoId })
  };
  try {
    const metadata = await resolveMetadata(candidate);
    if (
      !Number.isSafeInteger(metadata.decimals) ||
      metadata.decimals !== configured.decimals ||
      typeof metadata.symbol !== 'string' ||
      !metadata.symbol.trim()
    )
      return undefined;
    return { ...candidate, symbol: metadata.symbol };
  } catch {
    return undefined;
  }
}

/**
 * Read `GET /v0/tokens` and keep only the configured pairs that the live list confirms. A token whose every Miden
 * output failed is dropped, and a chain with no token left is dropped. The order follows the config.
 */
export async function fetchNearIntentsCatalog(
  config: NearIntentsConfig,
  resolveMetadata: OneClickOnchainMetadataResolver,
  fetcher: typeof fetch = fetch
): Promise<NearIntentsCatalog> {
  const listed = listedTokens(await requestOneClickJson(config, '/v0/tokens', undefined, fetcher));

  const origins = config.chains.map(chain => ({
    chain,
    tokens: chain.tokens.flatMap(token => {
      const asset = confirmedOriginAsset(chain.id, chain.addressKind, token, listed);
      return asset === undefined ? [] : [{ token, asset }];
    })
  }));

  // Read the faucet of each Miden token that a confirmed origin token names, at most four at a time.
  const wanted = new Set(origins.flatMap(origin => origin.tokens.flatMap(({ token }) => token.miden)));
  const midenToRead = config.midenAssets.filter(asset => wanted.has(asset.id));
  const confirmedMiden = new Map<string, OneClickAsset>();
  for (let start = 0; start < midenToRead.length; start += METADATA_READS_AT_ONCE) {
    const batch = midenToRead.slice(start, start + METADATA_READS_AT_ONCE);
    const results = await Promise.all(batch.map(asset => confirmedMidenAsset(asset, listed, resolveMetadata)));
    batch.forEach((asset, index) => {
      const confirmed = results[index];
      if (confirmed !== undefined) confirmedMiden.set(asset.id, confirmed);
    });
  }

  const chains: NearIntentsCatalogChain[] = origins.flatMap(({ chain, tokens }) => {
    const catalogTokens: NearIntentsCatalogToken[] = tokens.flatMap(({ token, asset }) => {
      const outputs = token.miden.flatMap(id => {
        const output = confirmedMiden.get(id);
        return output === undefined ? [] : [output];
      });
      return outputs.length === 0 ? [] : [{ symbol: token.symbol, asset, outputs }];
    });
    return catalogTokens.length === 0
      ? []
      : [{ id: chain.id, name: chain.name, addressKind: chain.addressKind, tokens: catalogTokens }];
  });
  return { chains };
}
