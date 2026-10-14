import { TEST_BRIDGE_CONFIG_SNAPSHOT } from 'lib/epoch/testing/bridge-config';

import { featureAvailability } from './availability';
import { testBridgeSnapshot } from './testing/fixture';

it('keeps Earn available when the Epoch bridge directions are off', () => {
  const snapshot = cloneSnapshot();
  const epoch = snapshot.config?.supportedEvmChains.sepolia?.bridges.epoch;
  if (!epoch) throw new Error('The test route is missing');
  epoch.depositEnabled = false;
  epoch.withdrawalEnabled = false;
  expect(featureAvailability('earnDeposit', snapshot)).toEqual({ state: 'available' });
  expect(featureAvailability('fastBridgeIn', snapshot)).toMatchObject({ state: 'unavailable', reason: 'off' });
  expect(featureAvailability('fastBridgeOut', snapshot)).toMatchObject({ state: 'unavailable', reason: 'off' });
});

it('applies the Earn switch only to new Earn deposits', () => {
  const snapshot = cloneSnapshot();
  if (!snapshot.config) throw new Error('The test document is missing');
  snapshot.config.features.earn = false;
  expect(featureAvailability('earnDeposit', snapshot)).toMatchObject({ reason: 'off' });
  expect(featureAvailability('fastBridgeIn', snapshot)).toEqual({ state: 'available' });
});

it('checks USDCx directions on the selected chain', () => {
  const snapshot = testBridgeSnapshot();
  const route = snapshot.config?.supportedEvmChains['base-sepolia']?.bridges.usdcx;
  if (!route) throw new Error('The test route is missing');
  route.depositEnabled = false;
  expect(featureAvailability('usdcxDeposit', snapshot, undefined, 84532)).toMatchObject({ reason: 'off' });
  expect(featureAvailability('usdcxWithdrawal', snapshot, undefined, 84532)).toEqual({ state: 'available' });
  expect(featureAvailability('usdcxDeposit', snapshot)).toEqual({ state: 'available' });
});

it('does not enable unlisted routes from the compiled registry', () => {
  const snapshot = testBridgeSnapshot();
  expect(featureAvailability('usdcxDeposit', snapshot, undefined, 1)).toMatchObject({ reason: 'not-configured' });
  expect(featureAvailability('fastBridgeIn', snapshot, undefined, 5042002)).toMatchObject({ reason: 'off' });
});

it('reports a service error on a route before unrelated disabled routes', () => {
  const snapshot = cloneSnapshot();
  if (!snapshot.config || !snapshot.derived) throw new Error('The test snapshot is missing');
  snapshot.config.supportedEvmChains = {
    'arc-testnet': { chainId: 5042002, bridges: {} },
    ...snapshot.config.supportedEvmChains
  };
  snapshot.derived.epoch.allocator = { state: 'error', message: 'offline' };
  expect(featureAvailability('fastBridgeOut', snapshot)).toMatchObject({ reason: 'service-down' });
});

it('waits for a loading document and refuses a missing document', () => {
  const snapshot = testBridgeSnapshot();
  expect(featureAvailability('bridgeIn', { ...snapshot, status: 'loading' })).toEqual({ state: 'loading' });
  expect(featureAvailability('bridgeIn', { ...snapshot, config: null })).toMatchObject({ reason: 'not-configured' });
});

function cloneSnapshot(): import('./runtime').BridgeConfigSnapshot {
  return JSON.parse(JSON.stringify(TEST_BRIDGE_CONFIG_SNAPSHOT));
}
