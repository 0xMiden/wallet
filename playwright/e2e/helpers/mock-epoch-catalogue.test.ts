import type { BrowserContext, Route } from '@playwright/test';

import { readEarnVaults } from '../../../src/lib/epoch/pools-read';
import { poolsPage } from '../../../src/lib/epoch/testing/pools-fixtures';
import TESTNET from '../../../src/lib/remote-config/testing/testnet.json';
import { parseBridgeConfig } from '../../../src/lib/remote-config/schema';
import { installMockEpochCatalogue, MOCK_SEPOLIA_POOL } from './mock-epoch-catalogue';

it('serves a valid listed Sepolia market through the real catalogue reader', async () => {
  const policy = parseBridgeConfig(TESTNET, 'testnet');
  expect(policy).not.toBeNull();
  const listed = policy?.earn?.vaults;
  expect(listed).toHaveLength(1);
  const read = await readEarnVaults(async () => ({ ok: true, status: 200, json: async () => poolsPage([MOCK_SEPOLIA_POOL]) }), {
    positionsUrl: 'https://positions-testnet-dev.epochprotocol.xyz',
    chainId: 11155111,
    underlying: MOCK_SEPOLIA_POOL.underlyingInfo.asset.address,
    listed: listed ?? []
  }, 1000);
  expect(read.source).toBe('pools');
  expect(read.droppedMarketUids).toEqual([]);
  expect(read.vaults).toHaveLength(1);
  expect(read.vaults[0]).toMatchObject({ lenderFamily: 'DUMMY_LENDING', chainId: '11155111' });
});

it('intercepts only the exact testnet catalogue and passes other requests through', async () => {
  let predicate!: (url: URL) => boolean;
  let handler!: (route: Route) => Promise<void>;
  const context = { route: async (match: unknown, callback: unknown) => {
    predicate = match as typeof predicate;
    handler = callback as typeof handler;
  } } as unknown as Pick<BrowserContext, 'route'>;
  await installMockEpochCatalogue(context);
  expect(predicate(new URL('https://positions-testnet-dev.epochprotocol.xyz/pools'))).toBe(true);
  expect(predicate(new URL('https://positions-testnet-dev.epochprotocol.xyz/positions'))).toBe(false);
  expect(predicate(new URL('https://other.invalid/pools'))).toBe(false);
  const fulfil = jest.fn();
  const pass = jest.fn();
  const route = (query: string, method = 'GET') => ({
    request: () => ({url: () => `https://positions-testnet-dev.epochprotocol.xyz/pools?${query}`, method: () => method}),
    fulfill: fulfil,
    continue: pass
  }) as unknown as Route;
  await handler(route(`chainId=11155111&underlyings=${MOCK_SEPOLIA_POOL.underlyingInfo.asset.address}`));
  expect(fulfil).toHaveBeenCalledWith(expect.objectContaining({status: 200, json: poolsPage([MOCK_SEPOLIA_POOL])}));
  await handler(route('chainId=8453'));
  await handler(route('chainId=11155111', 'POST'));
  expect(pass).toHaveBeenCalledTimes(2);
  expect(fulfil).toHaveBeenCalledTimes(1);
});
