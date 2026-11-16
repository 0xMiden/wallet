import { deriveBridgeRoutes } from './catalog';
import type { BridgeRoute } from './core/routes';
import { connections, native, referenceSnapshot } from './testing/fixtures';

jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: jest.fn(() => 'testnet') }));
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetIdSync: jest.fn(() => native.faucetId),
  getNativeAssetMetadataSync: jest.fn(() => ({ symbol: 'USDCx', decimals: 6 })),
  captureNativeAssetSnapshot: jest.fn(() => ({ scope: native.scope, revision: native.revision }))
}));

import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import {
  captureNativeAssetSnapshot,
  getNativeAssetIdSync,
  getNativeAssetMetadataSync
} from 'lib/miden-chain/native-asset';

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getEffectiveNetworkName).mockReturnValue('testnet');
  jest.mocked(getNativeAssetIdSync).mockReturnValue(native.faucetId);
  jest.mocked(getNativeAssetMetadataSync).mockReturnValue({ symbol: 'USDCx', decimals: 6 });
  jest.mocked(captureNativeAssetSnapshot).mockReturnValue({ scope: native.scope, revision: native.revision });
});
afterEach(() => jest.restoreAllMocks());

function matches(route: BridgeRoute, connection: (typeof connections.testnet)[number], mode: string): boolean {
  const evm = mode === 'receive' ? route.source : route.destination;
  const miden = mode === 'receive' ? route.destination : route.source;
  return (
    route.provider === connection.provider &&
    route.mode === mode &&
    evm.network === connection.evm.network &&
    evm.kind === connection.evm.kind &&
    (!('address' in connection.evm) ||
      (evm.kind === 'erc20' && evm.address.toLowerCase() === connection.evm.address.toLowerCase())) &&
    miden.kind === 'miden' &&
    miden.faucetId === connection.miden.faucetId &&
    evm.decimals === connection.evm.decimals &&
    miden.decimals === connection.miden.decimals
  );
}

it.each(['testnet', 'mainnet'] satisfies Array<'testnet' | 'mainnet'>)(
  'accounts for every pinned %s connection without installing reference contracts as authority',
  network => {
    const snapshot = referenceSnapshot(network);
    jest.mocked(getEffectiveNetworkName).mockReturnValue(network);
    const circle = connections[network].find(pair => pair.provider === 'xreserve');
    if (!circle) throw new Error('Missing reference Circle pair');
    jest.mocked(getNativeAssetIdSync).mockReturnValue(circle.miden.faucetId);
    const routes = deriveBridgeRoutes(snapshot);
    expect(connections[network].filter(pair => !pair.disabled)).toHaveLength(network === 'mainnet' ? 24 : 11);
    expect(routes).toHaveLength(network === 'mainnet' ? 48 : 20);
    for (const pair of connections[network]) {
      for (const mode of Object.keys(pair.routes)) {
        // The accepted wallet schema resolves one faucet per Epoch token. This legacy send-only USDCx
        // connection has no separately verified directional output and must stay blocked, not fabricated.
        const blocked = pair.disabled || (pair.provider === 'epoch' && !pair.routes.receive);
        expect(routes.some(route => matches(route, pair, mode))).toBe(!blocked);
      }
    }
    expect(new Set(routes.map(route => route.id)).size).toBe(routes.length);
  }
);

it('excludes directions switched off, missing metadata, retired faucets and nonmatching derivations', () => {
  const snapshot = referenceSnapshot('testnet');
  expect(snapshot.config).not.toBeNull();
  if (!snapshot.config || !snapshot.derived) throw new Error('Missing fixture');
  snapshot.config.features.bridgeIn = false;
  snapshot.config.features.bridgeOut = false;
  snapshot.config.features.fastBridge = false;
  expect(deriveBridgeRoutes(snapshot).every(route => route.provider === 'xreserve')).toBe(true);
  snapshot.config.supportedEvmChains['arc-testnet'].bridges.usdcx!.withdrawalEnabled = false;
  expect(
    deriveBridgeRoutes(snapshot).some(route => route.mode === 'send' && route.destination.network === 'arc-testnet')
  ).toBe(false);
  snapshot.derived.version++;
  expect(deriveBridgeRoutes(snapshot)).toEqual([]);
  expect(deriveBridgeRoutes({ ...snapshot, config: null })).toEqual([]);
  expect(deriveBridgeRoutes({ ...snapshot, status: 'loading' })).toEqual([]);
});

it('blocks Epoch without its allocator and omits only tokens whose verified metadata is missing', () => {
  const snapshot = referenceSnapshot('testnet');
  if (!snapshot.derived) throw new Error('Missing fixture');
  snapshot.derived.epoch.allocator = { state: 'error', message: 'unavailable' };
  expect(deriveBridgeRoutes(snapshot).some(route => route.provider === 'epoch')).toBe(false);
  snapshot.derived.epoch.allocator = { state: 'ok', value: true };
  delete snapshot.derived.chains[11155111].epoch.tokens.DAI;
  expect(deriveBridgeRoutes(snapshot).filter(route => route.provider === 'epoch')).toHaveLength(6);
});

it.each([
  [null, null],
  [native.faucetId, { symbol: 'USDCx', decimals: 6, scaleIsUnknown: true }],
  [native.faucetId, { symbol: 'ETH', decimals: 6 }],
  ['not-a-faucet', { symbol: 'USDCx', decimals: 6 }],
  [native.faucetId, { symbol: 'USDCx', decimals: 8 }]
])('never manufactures a Circle destination from missing or incompatible native authority', (id, metadata) => {
  jest.mocked(getNativeAssetIdSync).mockReturnValue(id);
  jest.mocked(getNativeAssetMetadataSync).mockReturnValue(metadata);
  expect(deriveBridgeRoutes(referenceSnapshot('testnet')).some(route => route.provider === 'xreserve')).toBe(false);
});

it('observes late readiness and same-network RPC/identity replacement without snapshot-only memoization', () => {
  const snapshot = referenceSnapshot('testnet');
  jest.mocked(getEffectiveNetworkName).mockReturnValue('testnet');
  jest.mocked(getNativeAssetIdSync).mockReturnValue(null);
  expect(deriveBridgeRoutes(snapshot).some(route => route.provider === 'xreserve')).toBe(false);
  jest.mocked(getNativeAssetIdSync).mockReturnValue(native.faucetId);
  jest.mocked(getNativeAssetMetadataSync).mockReturnValue({ symbol: 'USDCx', decimals: 6 });
  const before = deriveBridgeRoutes(snapshot).find(route => route.provider === 'xreserve');
  expect(before?.recovery.nativeAsset).toMatchObject({ faucetId: native.faucetId, scope: native.scope });
  jest.mocked(captureNativeAssetSnapshot).mockReturnValue({ scope: 'other-rpc|testnet', revision: 2 });
  jest.mocked(getNativeAssetIdSync).mockReturnValue('0x222222222222222222222222222222');
  const after = deriveBridgeRoutes(snapshot).find(route => route.provider === 'xreserve');
  expect(after?.recovery.nativeAsset).toMatchObject({
    faucetId: '0x222222222222222222222222222222',
    scope: 'other-rpc|testnet'
  });
  expect(before?.recovery.nativeAsset?.faucetId).toBe(native.faucetId);
  jest.mocked(getEffectiveNetworkName).mockReturnValue('mainnet');
  expect(deriveBridgeRoutes(snapshot).some(route => route.provider === 'xreserve')).toBe(false);
});
