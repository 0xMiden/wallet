import { arbitrumSepolia, arc, baseSepolia, mainnet, sepolia } from 'viem/chains';

import { usdcxArrivalKey } from './constant';

const ARC_TESTNET_ID = 5042002;

describe('USDCx deposit arrival estimate', () => {
  // Circle attests an Arc deposit in seconds and the relayer mints within a minute.
  it('reads about a minute for a deposit from Arc Testnet', () => {
    expect(usdcxArrivalKey(ARC_TESTNET_ID)).toBe('usdcxArrivalArc');
  });

  it.each([sepolia.id, baseSepolia.id, arbitrumSepolia.id, arc.id, mainnet.id])(
    'reads ~20 min for a deposit from chain %i',
    chainId => {
      expect(usdcxArrivalKey(chainId)).toBe('usdcxArrival');
    }
  );
});
