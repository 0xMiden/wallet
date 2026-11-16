import type { DerivedBridgeConfig } from 'lib/remote-config/derive';
import type { BridgeConfig } from 'lib/remote-config/schema';

import type { BridgeAsset } from './assets';
import type { BridgeProvider, FlowMode } from './models';

export interface BridgeRecoveryConfig {
  network: string;
  config: BridgeConfig;
  derived: DerivedBridgeConfig;
  nativeAsset?: { faucetId: string; symbol: string; decimals: number; scope: string; revision: number };
}
export interface BridgeRoute {
  id: string;
  provider: BridgeProvider;
  mode: FlowMode;
  source: BridgeAsset;
  destination: BridgeAsset;
  disabled?: boolean;
  recovery: BridgeRecoveryConfig;
}
