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
      registryAccountIdHex: '0xead81800958e7a112d45bdcf852fa6',
      paymentFaucetIdHex: '0x18101fa522c174b165efd4f70a0385'
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
    expect(MIDEN_NAME_REGISTER_SCRIPT_ROOT).toBe('0xdbac2a368df5d0b87e94f46f7e8a82323fde81c585a2e30d56c3fda8782cb6a2');
  });
});
