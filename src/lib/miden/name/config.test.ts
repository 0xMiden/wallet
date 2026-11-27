import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';

import { MIDEN_NAME_REGISTER_SCRIPT_ROOT, getMidenNameConfig, isMidenNameSupported } from './config';

jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getEffectiveNetworkName: jest.fn()
}));

const mockNetwork = jest.mocked(getEffectiveNetworkName);

describe('getMidenNameConfig', () => {
  it('returns the testnet deployment', () => {
    expect(getMidenNameConfig(MIDEN_NETWORK_NAME.TESTNET)).toEqual({
      network: MIDEN_NETWORK_NAME.TESTNET,
      registryAccountIdHex: '0x16fb70069eed60110c6207189c8237',
      registryCreationBlock: 164837,
      paymentFaucetIdHex: '0x4cbdcaffe75f0a317482224dae6436'
    });
  });

  it.each([MIDEN_NETWORK_NAME.DEVNET, MIDEN_NETWORK_NAME.MAINNET, MIDEN_NETWORK_NAME.LOCALNET])(
    'returns undefined on %s',
    network => {
      expect(getMidenNameConfig(network)).toBeUndefined();
    }
  );

  it('uses the effective network by default', () => {
    mockNetwork.mockReturnValue(MIDEN_NETWORK_NAME.DEVNET);
    expect(getMidenNameConfig()).toBeUndefined();
    expect(isMidenNameSupported()).toBe(false);

    mockNetwork.mockReturnValue(MIDEN_NETWORK_NAME.TESTNET);
    expect(getMidenNameConfig()?.network).toBe(MIDEN_NETWORK_NAME.TESTNET);
    expect(isMidenNameSupported()).toBe(true);
  });

  it('exposes the register script root', () => {
    expect(MIDEN_NAME_REGISTER_SCRIPT_ROOT).toBe('0x626b1ff576354c8c971f9da5198ea280d581488946bdc42db50013da5546bced');
  });
});
