import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/networks-config';
import { setNominalUnquotedPriceSetting } from 'lib/settings/nominal-price';

import { hasUnquotedDefaultPrice } from './unquoted-default';

jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getEffectiveNetworkName: jest.fn()
}));
const mockedNetwork = jest.mocked(getEffectiveNetworkName);

beforeEach(() => {
  localStorage.clear();
  mockedNetwork.mockReturnValue(MIDEN_NETWORK_NAME.TESTNET);
});

describe('hasUnquotedDefaultPrice', () => {
  it('is off by default, so an unquoted token shows no figure until a developer turns it on', () => {
    expect(hasUnquotedDefaultPrice()).toBe(false);
  });

  it('is on once the Developer Settings switch is on, on every network but mainnet', () => {
    setNominalUnquotedPriceSetting(true);
    for (const network of [MIDEN_NETWORK_NAME.TESTNET, MIDEN_NETWORK_NAME.DEVNET, MIDEN_NETWORK_NAME.LOCALNET]) {
      mockedNetwork.mockReturnValue(network);
      expect(hasUnquotedDefaultPrice()).toBe(true);
    }
  });

  it('stays off on mainnet whatever the switch says: a made-up figure there is a bug', () => {
    setNominalUnquotedPriceSetting(true);
    mockedNetwork.mockReturnValue(MIDEN_NETWORK_NAME.MAINNET);
    expect(hasUnquotedDefaultPrice()).toBe(false);
  });

  it('goes off again when the switch is turned off', () => {
    setNominalUnquotedPriceSetting(true);
    setNominalUnquotedPriceSetting(false);
    expect(hasUnquotedDefaultPrice()).toBe(false);
  });
});
