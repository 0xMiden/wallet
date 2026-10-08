import { buildChallengeMessage } from './transak-message';

describe('buildChallengeMessage', () => {
  it('makes the exact text that the backend twin makes', () => {
    const message = buildChallengeMessage({
      fiatAmount: '50.25',
      address: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
      midenAccountHex: '0x' + '0a'.repeat(15),
      nonce: '0123456789abcdef0123456789abcdef',
      expiresAt: 1790000000
    });

    expect(message).toBe(
      'Buy 50.25 USD of USDC on Ethereum to 0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed ' +
        'for Miden account 0x0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a via Transak. ' +
        'Nonce 0123456789abcdef0123456789abcdef, expires 2026-09-21T14:13:20.000Z.'
    );
  });
});
