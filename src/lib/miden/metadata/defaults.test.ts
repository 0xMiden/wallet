import { DEFAULT_TOKEN_METADATA, EMPTY_ASSET_METADATA, MIDEN_METADATA } from './defaults';

describe('static metadata constants', () => {
  it('MIDEN_METADATA has the right shape', () => {
    expect(MIDEN_METADATA.symbol).toBe('MIDEN');
    expect(MIDEN_METADATA.decimals).toBe(6);
  });

  it('EMPTY_ASSET_METADATA is fully blank', () => {
    expect(EMPTY_ASSET_METADATA).toEqual({
      decimals: 0,
      symbol: '',
      name: ''
    });
  });

  it('DEFAULT_TOKEN_METADATA has the Unknown defaults', () => {
    expect(DEFAULT_TOKEN_METADATA.symbol).toBe('Unknown');
    expect(DEFAULT_TOKEN_METADATA.name).toBe('Unknown');
    // Its 6 decimals are a placeholder, not a fact about any faucet. Every
    // display site asks `hasKnownScale` before converting by them.
    expect(DEFAULT_TOKEN_METADATA.scaleIsUnknown).toBe(true);
  });
});
