import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { addressFields, autoExpiresAtOf, findDepositAddress } from './deposit-address.js';

const SELLER = '0x1111111111111111111111111111111111111111';
const DEPOSIT = '0x5A3a5f32490d24Cc420d8A5F9c64F9ccd38F06bB';
const TOKEN = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';

describe('addressFields', () => {
  it('lists each address with its path', () => {
    const fields = addressFields({
      walletAddress: SELLER.toLowerCase(),
      cryptoPaymentData: { walletAddress: DEPOSIT },
      paymentDetails: [{ fields: [{ name: 'Address', value: DEPOSIT }] }],
      tokenContractAddress: TOKEN,
      fiatAmount: 12.4,
      note: 'not an address'
    });
    assert.deepEqual(fields, {
      walletAddress: SELLER,
      'cryptoPaymentData.walletAddress': DEPOSIT,
      'paymentDetails[0].fields[0].value': DEPOSIT,
      tokenContractAddress: TOKEN
    });
  });
});

describe('findDepositAddress', () => {
  it('prefers the payment address of a staging sell order', () => {
    // The shape of a staging sell order on 2026-10-09: no walletAddress, the deposit under cryptoPaymentData.
    const raw = { tokenContractAddress: TOKEN, cryptoPaymentData: { paymentAddress: DEPOSIT } };
    assert.deepEqual(findDepositAddress(raw, SELLER), { path: 'cryptoPaymentData.paymentAddress', address: DEPOSIT });
    const documented = { walletAddress: SELLER, cryptoPaymentData: { walletAddress: DEPOSIT }, other: TOKEN };
    assert.deepEqual(findDepositAddress(documented, SELLER), {
      path: 'cryptoPaymentData.walletAddress',
      address: DEPOSIT
    });
  });

  it('falls back to any address that is not the source wallet or the token', () => {
    const raw = { walletAddress: SELLER, tokenContractAddress: TOKEN, paymentDetails: [{ value: DEPOSIT }] };
    assert.deepEqual(findDepositAddress(raw, SELLER), { path: 'paymentDetails[0].value', address: DEPOSIT });
  });

  it('gives null when the order names only the source wallet', () => {
    assert.equal(findDepositAddress({ walletAddress: SELLER, tokenContractAddress: TOKEN }, SELLER), null);
    assert.equal(findDepositAddress(null, SELLER), null);
  });
});

describe('autoExpiresAtOf', () => {
  it('reads the expiry as unix seconds, and null when absent or not a date', () => {
    assert.equal(autoExpiresAtOf({ autoExpiresAt: '2026-10-09T11:03:22+00:00' }), 1791543802);
    assert.equal(autoExpiresAtOf({ autoExpiresAt: 'soon' }), null);
    assert.equal(autoExpiresAtOf({}), null);
    assert.equal(autoExpiresAtOf(null), null);
  });
});
