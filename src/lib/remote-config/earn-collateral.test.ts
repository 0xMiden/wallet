import { selectEarnCollateral } from 'lib/epoch/earn-collateral';
import { TEST_BRIDGE_CONFIG_SNAPSHOT, TEST_MIDEN_USDC } from 'lib/epoch/testing/bridge-config';
import { getNativeAssetIdSync, getNativeAssetMetadataSync } from 'lib/miden-chain/native-asset';

import { selectMidenUsdc } from './values';

jest.mock('./runtime', () => ({ getBridgeConfigSnapshot: jest.fn() }));
jest.mock('lib/miden-chain/native-asset', () => ({
  getNativeAssetIdSync: jest.fn(),
  getNativeAssetMetadataSync: jest.fn()
}));

const NATIVE = '0x4cbdcaffe75f0a317482224dae6436';

beforeEach(() => {
  jest.mocked(getNativeAssetIdSync).mockReturnValue(NATIVE);
  jest.mocked(getNativeAssetMetadataSync).mockReturnValue({ symbol: 'USDCX', decimals: 6 });
});

it('funds new Testnet Earn deposits with native USDCx while preserving the legacy bridge token', () => {
  expect(selectEarnCollateral(TEST_BRIDGE_CONFIG_SNAPSHOT)).toEqual({
    faucetId: NATIVE,
    symbol: 'USDCx',
    decimals: 6
  });
  expect(selectMidenUsdc(TEST_BRIDGE_CONFIG_SNAPSHOT)).toEqual(TEST_MIDEN_USDC);
});

it('never falls back to Epoch USDC while native identity or verified metadata is missing', () => {
  jest.mocked(getNativeAssetIdSync).mockReturnValue(null);
  expect(selectEarnCollateral(TEST_BRIDGE_CONFIG_SNAPSHOT)).toBeNull();
  jest.mocked(getNativeAssetIdSync).mockReturnValue(NATIVE);
  jest.mocked(getNativeAssetMetadataSync).mockReturnValue(null);
  expect(selectEarnCollateral(TEST_BRIDGE_CONFIG_SNAPSHOT)).toBeNull();
  jest.mocked(getNativeAssetMetadataSync).mockReturnValue({ symbol: 'USDCX', decimals: 6, scaleIsUnknown: true });
  expect(selectEarnCollateral(TEST_BRIDGE_CONFIG_SNAPSHOT)).toBeNull();
});

it('does not treat another native asset as Testnet USDCx', () => {
  jest.mocked(getNativeAssetMetadataSync).mockReturnValue({ symbol: 'OTHER', decimals: 6 });
  expect(selectEarnCollateral(TEST_BRIDGE_CONFIG_SNAPSHOT)).toBeNull();
});

it('keeps the configured collateral off Testnet', () => {
  expect(selectEarnCollateral({ ...TEST_BRIDGE_CONFIG_SNAPSHOT, network: 'devnet' })).toEqual(TEST_MIDEN_USDC);
});
