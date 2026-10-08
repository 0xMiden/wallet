import { getTestNetworkNameKey } from 'lib/miden-chain/effective-endpoints';

import { swapTokenInfo } from './token-info';
import { TOKEN_IETH, TOKEN_IMIDEN } from './tokens';

jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getTestNetworkNameKey: jest.fn()
}));

beforeEach(() => jest.mocked(getTestNetworkNameKey).mockReturnValue('testnet'));

describe('swapTokenInfo', () => {
  it('describes iETH on testnet', () => {
    expect(swapTokenInfo(TOKEN_IETH.faucetId)).toEqual({
      descriptionKey: 'testIethDescription',
      executionKey: 'testIethExecution'
    });
  });

  it('has nothing for another token, no faucet, or iETH off testnet', () => {
    expect(swapTokenInfo(TOKEN_IMIDEN.faucetId)).toBeNull();
    expect(swapTokenInfo(undefined)).toBeNull();
    jest.mocked(getTestNetworkNameKey).mockReturnValue('devnet');
    expect(swapTokenInfo(TOKEN_IETH.faucetId)).toBeNull();
    jest.mocked(getTestNetworkNameKey).mockReturnValue('localnet');
    expect(swapTokenInfo(TOKEN_IETH.faucetId)).toBeNull();
  });
});
