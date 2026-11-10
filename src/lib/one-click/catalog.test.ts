/** @jest-environment node */

import { fetchNearIntentsCatalog } from './catalog';
import type { NearIntentsConfig, OneClickAsset } from './types';

const usdcFaucet = `0x${'1'.repeat(30)}`;
const ethFaucet = `0x${'2'.repeat(30)}`;
const solanaMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const config: NearIntentsConfig = {
  serviceUrl: 'https://proxy.example',
  chains: [
    {
      id: 'eth',
      name: 'Ethereum',
      addressKind: 'evm',
      tokens: [
        {
          symbol: 'USDC',
          assetId: 'nep141:eth-usdc.omft.near',
          decimals: 6,
          contractAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          miden: ['usdc']
        },
        { symbol: 'ETH', assetId: 'nep141:eth.omft.near', decimals: 18, miden: ['eth', 'usdc'] }
      ]
    },
    {
      id: 'sol',
      name: 'Solana',
      addressKind: 'solana',
      tokens: [
        {
          symbol: 'USDC',
          assetId: 'nep141:sol-usdc.omft.near',
          decimals: 6,
          contractAddress: solanaMint,
          miden: ['usdc']
        }
      ]
    },
    {
      id: 'btc',
      name: 'Bitcoin',
      addressKind: 'bitcoin',
      tokens: [{ symbol: 'BTC', assetId: 'nep141:btc.omft.near', decimals: 8, miden: ['eth'] }]
    }
  ],
  midenAssets: [
    { id: 'usdc', assetId: 'miden:usdc', faucetId: usdcFaucet, decimals: 6 },
    { id: 'eth', assetId: 'miden:eth', faucetId: ethFaucet, decimals: 18 }
  ]
};

const liveTokens = [
  {
    assetId: 'nep141:eth-usdc.omft.near',
    blockchain: 'eth',
    symbol: 'USDC',
    decimals: 6,
    contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
  },
  { assetId: 'nep141:eth.omft.near', blockchain: 'eth', symbol: 'ETH', decimals: 18, coingeckoId: 'ethereum' },
  { assetId: 'nep141:sol-usdc.omft.near', blockchain: 'sol', symbol: 'USDC', decimals: 6, contractAddress: solanaMint },
  { assetId: 'nep141:btc.omft.near', blockchain: 'btc', symbol: 'BTC', decimals: 8 },
  { assetId: 'miden:usdc', blockchain: 'miden', symbol: 'USDC', decimals: 6 },
  { assetId: 'miden:eth', blockchain: 'miden', symbol: 'ETH', decimals: 18 }
];

const metadataByFaucet: Record<string, { decimals: number; symbol?: string }> = {
  [usdcFaucet]: { decimals: 6, symbol: 'USDC' },
  [ethFaucet]: { decimals: 18, symbol: 'ETH' }
};

function resolver(overrides: Record<string, { decimals: number; symbol?: string } | Error> = {}) {
  return jest.fn(async (asset: OneClickAsset) => {
    const faucetId = asset.faucetId ?? '';
    const override = overrides[faucetId];
    if (override instanceof Error) throw override;
    return override ?? metadataByFaucet[faucetId] ?? { decimals: 0 };
  });
}

function fetcherFor(body: unknown) {
  return jest.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(body));
}

const tokenIds = (catalog: Awaited<ReturnType<typeof fetchNearIntentsCatalog>>) =>
  catalog.chains.map(chain => [chain.id, chain.tokens.map(token => token.asset.assetId)]);

describe('fetchNearIntentsCatalog', () => {
  it('keeps the configured pairs that the live list confirms, in the order of the config', async () => {
    const fetcher = fetcherFor(liveTokens);
    const catalog = await fetchNearIntentsCatalog(config, resolver(), fetcher);

    expect(fetcher).toHaveBeenCalledWith('https://proxy.example/v0/tokens', expect.anything());
    expect(catalog.chains.map(chain => chain.id)).toEqual(['eth', 'sol', 'btc']);
    const ethereum = catalog.chains[0];
    expect(ethereum).toMatchObject({ id: 'eth', name: 'Ethereum', addressKind: 'evm' });
    expect(ethereum?.tokens[0]).toEqual({
      symbol: 'USDC',
      asset: {
        assetId: 'nep141:eth-usdc.omft.near',
        blockchain: 'eth',
        symbol: 'USDC',
        decimals: 6,
        contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
      },
      outputs: [{ assetId: 'miden:usdc', blockchain: 'miden', symbol: 'USDC', decimals: 6, faucetId: usdcFaucet }]
    });
    expect(ethereum?.tokens[1]?.asset.coingeckoId).toBe('ethereum');
    expect(ethereum?.tokens[1]?.outputs.map(output => output.assetId)).toEqual(['miden:eth', 'miden:usdc']);
  });

  it.each([
    ['another chain', { blockchain: 'arb' }],
    ['other decimals', { decimals: 18 }],
    ['another contract address', { contractAddress: `0x${'b'.repeat(40)}` }],
    ['no contract address', { contractAddress: undefined }]
  ])('drops an origin token that the live list gives with %s', async (_label, override) => {
    const live = liveTokens.map(token =>
      token.assetId === 'nep141:eth-usdc.omft.near' ? { ...token, ...override } : token
    );
    const catalog = await fetchNearIntentsCatalog(config, resolver(), fetcherFor(live));

    expect(tokenIds(catalog)).toEqual([
      ['eth', ['nep141:eth.omft.near']],
      ['sol', ['nep141:sol-usdc.omft.near']],
      ['btc', ['nep141:btc.omft.near']]
    ]);
  });

  it('compares a non-EVM contract address exactly', async () => {
    const live = liveTokens.map(token =>
      token.assetId === 'nep141:sol-usdc.omft.near' ? { ...token, contractAddress: solanaMint.toLowerCase() } : token
    );
    const catalog = await fetchNearIntentsCatalog(config, resolver(), fetcherFor(live));

    expect(catalog.chains.map(chain => chain.id)).toEqual(['eth', 'btc']);
  });

  it('drops a token that the live list does not have, and a chain with no token left', async () => {
    const live = liveTokens.filter(token => token.assetId !== 'nep141:btc.omft.near');
    const catalog = await fetchNearIntentsCatalog(config, resolver(), fetcherFor(live));

    expect(catalog.chains.map(chain => chain.id)).toEqual(['eth', 'sol']);
  });

  it.each([
    ['the live list does not have it', { list: liveTokens.filter(token => token.assetId !== 'miden:eth') }],
    [
      'the live list gives it on another chain',
      { list: liveTokens.map(token => (token.assetId === 'miden:eth' ? { ...token, blockchain: 'eth' } : token)) }
    ],
    [
      'the live list gives other decimals',
      { list: liveTokens.map(token => (token.assetId === 'miden:eth' ? { ...token, decimals: 8 } : token)) }
    ],
    ['the faucet has other decimals', { metadata: { decimals: 8, symbol: 'ETH' } }],
    ['the faucet has no symbol', { metadata: { decimals: 18, symbol: '  ' } }],
    ['the faucet read fails', { metadata: new Error('faucet read failed') }]
  ])('drops a Miden output when %s', async (_label, setup) => {
    const read = resolver('metadata' in setup && setup.metadata !== undefined ? { [ethFaucet]: setup.metadata } : {});
    const live = 'list' in setup && setup.list !== undefined ? setup.list : liveTokens;
    const catalog = await fetchNearIntentsCatalog(config, read, fetcherFor(live));

    const eth = catalog.chains.find(chain => chain.id === 'eth');
    // ETH keeps its other output, USDC.
    expect(eth?.tokens[1]?.outputs.map(output => output.assetId)).toEqual(['miden:usdc']);
    // BTC has no output left, so the token and its chain are dropped.
    expect(catalog.chains.map(chain => chain.id)).toEqual(['eth', 'sol']);
  });

  it('reads each needed faucet once, at most four at a time', async () => {
    const midenAssets = Array.from({ length: 6 }, (_, index) => ({
      id: `m${index}`,
      assetId: `miden:asset-${index}`,
      faucetId: `0x${String(index + 1).repeat(30)}`,
      decimals: 6
    }));
    const manyConfig: NearIntentsConfig = {
      serviceUrl: 'https://proxy.example',
      chains: [
        {
          id: 'near',
          name: 'NEAR',
          addressKind: 'near',
          tokens: [
            { symbol: 'A', assetId: 'nep141:a', decimals: 6, miden: ['m0', 'm1', 'm2'] },
            { symbol: 'B', assetId: 'nep141:b', decimals: 6, miden: ['m2', 'm3', 'm4', 'm5'] }
          ]
        }
      ],
      midenAssets
    };
    const live = [
      { assetId: 'nep141:a', blockchain: 'near', symbol: 'A', decimals: 6 },
      { assetId: 'nep141:b', blockchain: 'near', symbol: 'B', decimals: 6 },
      ...midenAssets.map(asset => ({ assetId: asset.assetId, blockchain: 'miden', symbol: 'M', decimals: 6 }))
    ];
    let active = 0;
    let peak = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const read = jest.fn(async (_asset: OneClickAsset) => {
      active += 1;
      peak = Math.max(peak, active);
      await gate;
      active -= 1;
      return { decimals: 6, symbol: 'M' };
    });
    const pending = fetchNearIntentsCatalog(manyConfig, read, fetcherFor(live));
    let startedBeforeRelease = 0;
    try {
      for (let attempt = 0; attempt < 50 && read.mock.calls.length < 4; attempt += 1) await Promise.resolve();
      startedBeforeRelease = read.mock.calls.length;
    } finally {
      release?.();
    }
    const catalog = await pending;

    expect(startedBeforeRelease).toBe(4);
    expect(peak).toBe(4);
    expect(read).toHaveBeenCalledTimes(6);
    expect(catalog.chains[0]?.tokens.map(token => token.outputs.length)).toEqual([3, 4]);
  });

  it('does not read a faucet that no confirmed origin token needs', async () => {
    const live = liveTokens.filter(token => token.assetId !== 'nep141:btc.omft.near' && token.blockchain !== 'eth');
    const read = resolver();
    await fetchNearIntentsCatalog(config, read, fetcherFor(live));

    expect(read.mock.calls.map(([asset]) => asset.faucetId)).toEqual([usdcFaucet]);
  });

  it('uses the first entry when the live list repeats an asset id', async () => {
    const live = [{ ...liveTokens[0], decimals: 18 }, ...liveTokens];
    const catalog = await fetchNearIntentsCatalog(config, resolver(), fetcherFor(live));

    expect(catalog.chains[0]?.tokens.map(token => token.asset.assetId)).toEqual(['nep141:eth.omft.near']);
  });

  it('fails closed when the live list has an invalid top-level shape', async () => {
    await expect(fetchNearIntentsCatalog(config, resolver(), fetcherFor({ tokens: [] }))).rejects.toThrow(
      'Invalid 1Click token response'
    );
  });
});
