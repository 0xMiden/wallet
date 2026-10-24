import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import { isAndroid, isIOS } from 'lib/platform';

import { resolveTelemetryContext } from './context';
import { TelemetryNetwork } from './types';
import packageJson from '../../../package.json';

jest.mock('lib/platform', () => ({
  isIOS: jest.fn(() => false),
  isAndroid: jest.fn(() => false)
}));

jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: jest.fn() }));

describe('resolveTelemetryContext', () => {
  afterEach(() => jest.resetAllMocks());

  it('reports the extension platform by default', () => {
    jest.mocked(isIOS).mockReturnValue(false);
    jest.mocked(isAndroid).mockReturnValue(false);
    expect(resolveTelemetryContext().platform).toBe('extension');
  });

  it('reports ios', () => {
    jest.mocked(isIOS).mockReturnValue(true);
    expect(resolveTelemetryContext().platform).toBe('ios');
  });

  it('reports android', () => {
    jest.mocked(isIOS).mockReturnValue(false);
    jest.mocked(isAndroid).mockReturnValue(true);
    expect(resolveTelemetryContext().platform).toBe('android');
  });

  it('reports the package version exactly, pre-release suffix included', () => {
    expect(resolveTelemetryContext().appVersion).toBe(packageJson.version);
  });

  // Read on every call: a Developer Settings save or the mainnet choice switches the network without a reload.
  it.each<[MIDEN_NETWORK_NAME, TelemetryNetwork]>([
    [MIDEN_NETWORK_NAME.MAINNET, 'mainnet'],
    [MIDEN_NETWORK_NAME.TESTNET, 'testnet'],
    [MIDEN_NETWORK_NAME.DEVNET, 'devnet'],
    [MIDEN_NETWORK_NAME.LOCALNET, 'localnet']
  ])('reports the effective network %s as %s', (effective, reported) => {
    jest.mocked(getEffectiveNetworkName).mockReturnValue(effective);
    expect(resolveTelemetryContext().network).toBe(reported);
  });
});
