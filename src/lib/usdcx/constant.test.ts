import { arbitrum, arbitrumSepolia, arc, base, baseSepolia, sepolia } from 'viem/chains';

import { CIRCLE_DOMAIN, CIRCLE_USDC_ADDRESS, getUsdcxContracts, TOKEN_MESSENGER_WITH_FEES_ADDRESS } from './constant';

describe('USDCx per-chain contracts', () => {
  it('resolves Arc and Sepolia independently without silently falling back', () => {
    expect(getUsdcxContracts(5042002).usdc).toBe('0x3600000000000000000000000000000000000000');
    expect(getUsdcxContracts(sepolia.id).usdc).toBe('0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238');
    expect(() => getUsdcxContracts(999)).toThrow('not configured');
  });

  it.each([arbitrum, arbitrumSepolia, base, baseSepolia])('configures CCTP, not local xReserve, for $name', chain => {
    expect(CIRCLE_USDC_ADDRESS.has(chain.id)).toBe(true);
    expect(TOKEN_MESSENGER_WITH_FEES_ADDRESS.has(chain.id)).toBe(true);
    expect(CIRCLE_DOMAIN.get(chain.id)).toBe(chain.id === base.id || chain.id === baseSepolia.id ? 6 : 3);
    expect(() => getUsdcxContracts(chain.id)).toThrow('not configured');
  });

  it('keeps Arc mainnet direct deposits separate from its unconfirmed fee entry point', () => {
    expect(getUsdcxContracts(arc.id).xReserve).toBe('0x8888888199b2Df864bf678259607d6D5EBb4e3Ce');
    expect(CIRCLE_DOMAIN.get(arc.id)).toBe(26);
    expect(TOKEN_MESSENGER_WITH_FEES_ADDRESS.has(arc.id)).toBe(false);
  });
});
