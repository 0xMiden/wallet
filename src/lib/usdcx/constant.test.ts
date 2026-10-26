import { serialize } from 'v8';
import { arc } from 'viem/chains';

import { getBridgeConfigSnapshot } from 'lib/remote-config/runtime';
import { testBridgeSnapshot } from 'lib/remote-config/testing/fixture';

import {
  defaultUsdcxChainId,
  getUsdcxExecutorSource,
  getUsdcxRemoteDomain,
  listUsdcxDestinations,
  listUsdcxSourceChains,
  minimumUsdcxPayout,
  usdcxArrivalKey,
  usdcxPayoutFeeShortfall,
  usdcxSourceChains
} from './constant';

jest.mock('lib/remote-config/runtime', () => ({ getBridgeConfigSnapshot: jest.fn() }));
let mockNetworkName = 'testnet';
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: () => mockNetworkName }));
beforeEach(() => {
  mockNetworkName = 'testnet';
  jest.mocked(getBridgeConfigSnapshot).mockReturnValue(testBridgeSnapshot());
});

// The opening chain is keyed per Miden network as the RPC endpoints are: Ethereum on mainnet, Arc Testnet elsewhere.
it('opens USDCx on Arc Testnet on the test networks and on Ethereum on mainnet', () => {
  expect(defaultUsdcxChainId()).toBe(5042002);
  mockNetworkName = 'devnet';
  expect(defaultUsdcxChainId()).toBe(5042002);
  mockNetworkName = 'mainnet';
  expect(defaultUsdcxChainId()).toBe(1);
});

it('estimates a one-minute arrival from Arc on either network family', () => {
  expect(usdcxArrivalKey(5042002)).toBe('usdcxArrivalArc');
  expect(usdcxArrivalKey(5042)).toBe('usdcxArrivalArc');
  expect(usdcxArrivalKey(1)).toBe('usdcxArrival');
});

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
  expect(listUsdcxSourceChains().map(source => source.chain.id)).not.toContain(84532);
  expect(listUsdcxDestinations().map(source => source.chain.id)).toContain(84532);
  expect(getUsdcxExecutorSource(84532).target.chain.id).toBe(5042002);
});

it('offers no executor source whose target is a mainnet chain on the testnet network', () => {
  const snapshot = testBridgeSnapshot();
  const chains = snapshot.config?.supportedEvmChains;
  const arcRoute = chains?.['arc-testnet']?.bridges.usdcx;
  const deposit = chains?.['base-sepolia']?.bridges.usdcx?.deposit;
  if (!chains || !arcRoute || deposit?.route !== 'executor') throw new Error('The test route is missing');
  chains.arc = { chainId: arc.id, bridges: { usdcx: { ...arcRoute } } };
  deposit.executorChain = 'arc';
  jest.mocked(getBridgeConfigSnapshot).mockReturnValue(snapshot);
  expect(usdcxSourceChains().has(84532)).toBe(false);
  expect(usdcxSourceChains().has(arc.id)).toBe(false);
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

// Circle took 2.5635 USDC from a Sepolia payout, so the review promises no fee bound; the allowance only refuses a burn.
it('refuses a 1 USDCx burn to Sepolia and accepts one above the allowance', () => {
  expect(usdcxPayoutFeeShortfall(11155111, 1_000_000n)).toEqual({ amount: '1.5', network: 'Sepolia' });
  expect(usdcxPayoutFeeShortfall(11155111, 1_500_001n)).toBeUndefined();
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
