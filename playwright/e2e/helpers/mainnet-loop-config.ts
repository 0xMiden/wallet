import { createServer, type Server } from 'node:http';

import { Address } from '@miden-sdk/miden-sdk';

import { parseTokenList } from '../../../src/lib/token-list/parse';
import { parseOneClickFeePolicy } from '../../../src/lib/one-click/fees';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;
const CHAINS = [
  { name: 'ethereum', blockchain: 'eth', chainId: 1 },
  { name: 'arbitrum', blockchain: 'arb', chainId: 42161 }
];

export function canonicalMainnetLoopFaucet(faucet: string): string {
  const ref = faucet.split('_')[0] ?? '';
  if (!/^mm1/.test(ref) && !/^0x[0-9a-f]{30}$/i.test(ref)) throw new Error('Invalid mainnet faucet identity');
  const hex = ref.startsWith('0x') ? ref.toLowerCase() : Address.fromBech32(ref).accountId().toString().toLowerCase();
  if (!/^0x[0-9a-f]{30}$/.test(hex)) throw new Error('Invalid canonical mainnet faucet');
  return hex;
}

export async function startMainnetLoopConfigServer(snapshot: unknown): Promise<Server> {
  if (
    !record(snapshot) ||
    snapshot.network !== 'mainnet' ||
    typeof snapshot.version !== 'number' ||
    !Number.isSafeInteger(snapshot.version) ||
    snapshot.version < 1
  )
    throw new Error('Only a versioned mainnet snapshot may be served');
  const body = JSON.stringify(snapshot);
  if (Buffer.byteLength(body) > 1_048_576) throw new Error('Mainnet configuration snapshot is too large');
  const server = createServer((request, response) => {
    const address = server.address();
    if (!address || typeof address === 'string' || request.headers.host !== `127.0.0.1:${address.port}`) {
      response.writeHead(400).end();
    } else if (request.url !== '/mainnet.json') {
      response.writeHead(404).end();
    } else if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET' }).end();
    } else {
      response
        .writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store'
        })
        .end(body);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}

export function qualifyMainnetLoopConfig(document: unknown, catalog: unknown, tokenList: unknown): unknown {
  if (
    !record(document) ||
    document.network !== 'mainnet' ||
    !Number.isSafeInteger(document.version) ||
    typeof document.version !== 'number' ||
    document.version < 1 ||
    !record(document.features) ||
    !record(document.swap) ||
    !record(document.supportedEvmChains) ||
    !Array.isArray(catalog) ||
    catalog.length > 1_000 ||
    !catalog.every(record) ||
    !record(tokenList) ||
    !Array.isArray(tokenList.tokens) ||
    !parseTokenList(tokenList, 'mainnet')
  ) {
    throw new Error('Invalid published mainnet configuration or live token catalog');
  }
  const ids = new Set<string>();
  for (const asset of catalog) {
    if (typeof asset.assetId !== 'string' || ids.has(asset.assetId)) throw new Error('Ambiguous live 1Click asset id');
    ids.add(asset.assetId);
  }
  const nativeEntries = tokenList.tokens
    .filter(record)
    .filter(token => token.network === 'mainnet' && token.symbol === 'USDCX');
  const native = nativeEntries[0];
  if (
    nativeEntries.length !== 1 ||
    !native ||
    typeof native.faucetId !== 'string' ||
    typeof native.decimals !== 'number' ||
    !Number.isSafeInteger(native.decimals) ||
    native.decimals < 0 ||
    native.decimals > 12
  ) {
    throw new Error('No unique verified mainnet USDCX faucet');
  }
  const hex = canonicalMainnetLoopFaucet(native.faucetId);
  const nativeAssetId = `nep141:miden-${hex}.omft.near`;
  const listedNative = catalog.find(asset => asset.assetId === nativeAssetId);
  if (
    !listedNative ||
    listedNative.blockchain !== 'miden' ||
    listedNative.symbol !== 'USDCX' ||
    listedNative.decimals !== native.decimals ||
    typeof listedNative.contractAddress !== 'string' ||
    listedNative.contractAddress.toLowerCase() !== hex
  ) {
    throw new Error('The live catalog does not bind the verified native Miden asset');
  }
  const evmAssets: {
    assetId: string;
    blockchain: string;
    chainId: number;
    contractAddress: string;
    decimals: number;
    symbol: string;
  }[] = [];
  const contracts = new Set<string>();
  for (const { name, blockchain, chainId } of CHAINS) {
    const chain = document.supportedEvmChains[name];
    if (chain === undefined) continue;
    if (!record(chain) || chain.chainId !== chainId || !record(chain.bridges))
      throw new Error('Invalid mainnet EVM chain binding');
    for (const bridge of Object.values(chain.bridges)) {
      if (!record(bridge) || !record(bridge.tokens)) continue;
      for (const symbol of ['USDC', 'USDT', 'USDT0']) {
        const token = bridge.tokens[symbol];
        if (token === undefined) continue;
        if (!record(token) || typeof token.contractAddress !== 'string') throw new Error('Invalid published EVM token');
        const contractAddress = token.contractAddress.toLowerCase();
        if (!EVM_ADDRESS.test(contractAddress) || /^0x0{40}$/.test(contractAddress))
          throw new Error('Invalid EVM stablecoin address');
        const key = `${chainId}:${contractAddress}`;
        if (contracts.has(key)) continue;
        const assetId = `nep141:${blockchain}-${contractAddress}.omft.near`;
        const listed = catalog.find(asset => asset.assetId === assetId);
        if (!listed) continue;
        if (
          listed.blockchain !== blockchain ||
          typeof listed.contractAddress !== 'string' ||
          listed.contractAddress.toLowerCase() !== contractAddress ||
          listed.decimals !== 6 ||
          typeof listed.symbol !== 'string' ||
          (listed.symbol !== symbol && !(symbol === 'USDT' && listed.symbol === 'USDT0'))
        ) {
          throw new Error('The live EVM asset disagrees with its published contract binding');
        }
        contracts.add(key);
        evmAssets.push({ assetId, blockchain, chainId, contractAddress, decimals: 6, symbol: listed.symbol });
      }
    }
  }
  if (!evmAssets.length) throw new Error('No published stablecoin route with supported all-in fee accounting');
  const previous = record(document.swap.oneClick) ? document.swap.oneClick : {};
  const serviceUrl = previous.serviceUrl ?? 'https://1click.chaindefuser.com';
  if (typeof serviceUrl !== 'string') throw new Error('Invalid real 1Click service');
  const url = new URL(serviceUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('Invalid real 1Click service');
  const configuredPolicy = parseOneClickFeePolicy(previous.feePolicy);
  const feePolicy =
    configuredPolicy ??
    (url.origin === 'https://1click.chaindefuser.com' && url.pathname.replace(/\/+$/, '') === ''
      ? {
          kind: 'partner',
          platformRecipient: '5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd',
          minimumPlatformFeeBps: 20
        }
      : undefined);
  return {
    ...document,
    features: { ...document.features, nearIntents: true },
    swap: {
      ...document.swap,
      oneClick: {
        ...previous,
        serviceUrl,
        ...(feePolicy === undefined ? {} : { feePolicy }),
        midenAssets: [{ assetId: nativeAssetId, faucetId: hex, decimals: native.decimals }],
        evmAssets
      }
    }
  };
}
