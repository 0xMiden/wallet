import { MIDEN_DESTINATION_CHAIN_ID } from './config';

jest.mock('@epoch-protocol/epoch-intents-sdk', () => ({ MIDEN_VIRTUAL_CHAIN_ID: 4242 }));

describe('MIDEN_DESTINATION_CHAIN_ID', () => {
  // The SDK routes a Miden leg by its own constant; a copy here would drift silently if it changed.
  it('is the Epoch SDK virtual chain id', () => {
    expect(MIDEN_DESTINATION_CHAIN_ID).toBe(4242);
  });
});
