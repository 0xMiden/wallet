import { serialize } from 'v8';

import { getBridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { testBridgeSnapshot } from 'lib/remote-config/testing/fixture';

import {
  getUsdcxExecutorSource,
  getUsdcxRemoteDomain,
  listUsdcxDestinations,
  listUsdcxSourceChains,
  minimumUsdcxPayout,
  usdcxSourceChains
} from './constant';

jest.mock('lib/remote-config/runtime', () => ({ getBridgeConfigSnapshot: jest.fn() }));
beforeEach(() => jest.mocked(getBridgeConfigSnapshot).mockReturnValue(testBridgeSnapshot()));

it('builds source routes and executor targets from the remote document', () => {
  expect([...usdcxSourceChains().keys()]).toEqual([5042002, 11155111, 84532, 421614]);
  const source = getUsdcxExecutorSource(84532);
  expect(source.target.chain.id).toBe(5042002);
  expect(source.target.executor).toBe('0xEdC81040756AcCfF070c21D37b265b9D0b5Ba45e');
  expect(source.usdc).toBe('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
  expect(getUsdcxRemoteDomain()).toBe(10007);
});

it('lists only the enabled direction while retaining recovery values', () => {
  const snapshot = testBridgeSnapshot();
  const route = snapshot.config?.supportedEvmChains['base-sepolia']?.bridges.usdcx;
  if (!route) throw new Error('The test route is missing');
  route.depositEnabled = false;
  jest.mocked(getBridgeConfigSnapshot).mockReturnValue(snapshot);
  expect(listUsdcxSourceChains(true).map(source => source.chain.id)).not.toContain(84532);
  expect(listUsdcxDestinations(true).map(source => source.chain.id)).toContain(84532);
  expect(getUsdcxExecutorSource(84532).target.chain.id).toBe(5042002);
});

it('has no compiled fallback when the remote document is missing', () => {
  jest.mocked(getBridgeConfigSnapshot).mockReturnValue({ ...testBridgeSnapshot(), config: null });
  expect(usdcxSourceChains().size).toBe(0);
  expect(() => getUsdcxRemoteDomain()).toThrow();
});

it('keeps the accepted destination payout fee allowance', () => {
  expect(minimumUsdcxPayout(11155111, 3_000_000n)).toBe(1_500_000n);
  expect(minimumUsdcxPayout(84532, 3_000_000n)).toBe(2_900_000n);
});

it('builds source snapshots that IndexedDB can store', () => {
  expect(() => serialize(getUsdcxExecutorSource(84532))).not.toThrow();
});

it('keeps the Miden domain on the saved executor target after a configuration change', () => {
  const source = getUsdcxExecutorSource(84532);
  const changed = testBridgeSnapshot();
  if (!changed.config) throw new Error('The test document is missing');
  changed.config['bridge-providers'].usdcx.midenDomain = 20007;
  jest.mocked(getBridgeConfigSnapshot).mockReturnValue(changed);
  expect(getUsdcxRemoteDomain()).toBe(20007);
  expect(source.midenDomain).toBe(10007);
  expect(source.target.midenDomain).toBe(10007);
});
