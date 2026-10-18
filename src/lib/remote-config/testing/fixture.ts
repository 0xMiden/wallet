import type { BridgeConfigSnapshot } from '../runtime';
import { parseBridgeConfig } from '../schema';
import testnet from './testnet.json';

export function testBridgeSnapshot(): BridgeConfigSnapshot {
  const config = parseBridgeConfig(testnet, 'testnet');
  if (!config) throw new Error('The test configuration is invalid');
  return { network: 'testnet', status: 'ready', config, derived: null, lastFetch: null };
}
