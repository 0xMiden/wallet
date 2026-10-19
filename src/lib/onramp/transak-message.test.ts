import { buildChallengeMessage } from './transak-message';

const COMMON = {
  address: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
  midenAccountHex: '0x' + '0a'.repeat(15),
  nonce: '0123456789abcdef0123456789abcdef',
  expiresAt: 1790000000
};

const TAIL =
  'for Miden account 0x0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a via Transak. ' +
  'Nonce 0123456789abcdef0123456789abcdef, expires 2026-09-21T14:13:20.000Z.';

describe('buildChallengeMessage', () => {
  it('makes the exact buy text that the backend twin makes', () => {
    const message = buildChallengeMessage({ ...COMMON, side: 'buy', amount: '50.25' });
    expect(message).toBe(`Buy 50.25 USD of USDC on Ethereum to 0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed ${TAIL}`);
  });

  it('makes the exact sell text that the backend twin makes', () => {
    const message = buildChallengeMessage({ ...COMMON, side: 'sell', amount: '12.5' });
    expect(message).toBe(`Sell 12.5 USDCx as USDC on Ethereum from 0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed ${TAIL}`);
  });
});
