import { deriveBridgeConfig, type DeriveDeps } from './derive';
import { testBridgeSnapshot } from './testing/fixture';

function dependencies(): Partial<DeriveDeps> {
  return {
    now: () => 100,
    midenRpcUrl: () => 'https://miden.test',
    readBridgeRegistry: async () => ({
      rollupId: 86,
      tokens: [
        {
          midenFaucetId: '0x5b043dcb48d5721106f7a1ceb2b804',
          originToken: '0x0000000000000000000000000000000000000000',
          originNetwork: 0,
          scale: 10
        }
      ]
    }),
    readMidenFaucet: async () => ({ symbol: 'USDC', decimals: 6 }),
    evm: () => ({
      hasCode: async () => true,
      networkId: async () => 0,
      erc20: async () => ({ symbol: 'USDC', decimals: 18 })
    }),
    fetch: async url => ({
      ok: true,
      json: async () => {
        if (url.includes('/positions?'))
          return {
            success: true,
            data: {
              items: [
                {
                  lender: 'DUMMY_LENDING',
                  chainId: '11155111',
                  aprData: { apr: 2, depositApr: 2, borrowApr: 0 },
                  data: [{ positions: [] }],
                  lenderInfo: { lenderKey: 'DUMMY_LENDING', name: 'Dummy Lending', logoUri: '' }
                }
              ]
            }
          };
        return url.endsWith('/healthz') ? { status: 'SERVING' } : { status: 'healthy' };
      }
    })
  };
}

it('reads each bridge from its listed chain and discovers the Earn market from Epoch', async () => {
  const config = testBridgeSnapshot().config;
  if (!config) throw new Error('The test document is missing');
  const evm = jest.fn(dependencies().evm);
  const result = await deriveBridgeConfig(config, { ...dependencies(), evm });
  expect(result.derivedAt).toBe(100);
  expect(result.chains?.[11155111]?.agglayer.rollupId).toEqual({ state: 'ok', value: 86 });
  expect(result.chains?.[84532]?.epoch.evmUsdc).toEqual({ state: 'skipped' });
  expect(result.epoch.market).toMatchObject({
    state: 'ok',
    value: {
      marketUid: 'DUMMY_LENDING:11155111:0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69',
      underlying: '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69',
      chainId: 11155111
    }
  });
  expect(evm).toHaveBeenCalledWith(11155111);
});

it('keeps independent chain probes when one RPC fails', async () => {
  const config = testBridgeSnapshot().config;
  if (!config) throw new Error('The test document is missing');
  const result = await deriveBridgeConfig(config, {
    ...dependencies(),
    evm: () => ({
      hasCode: async () => {
        throw new Error('offline');
      },
      networkId: async () => 0,
      erc20: async () => ({ symbol: 'USDC', decimals: 18 })
    })
  });
  expect(result.chains?.[11155111]?.epoch.evmUsdc).toMatchObject({ state: 'error' });
  expect(result.epoch.allocator).toEqual({ state: 'ok', value: true });
});
