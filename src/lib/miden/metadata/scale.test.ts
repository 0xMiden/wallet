import { DEFAULT_TOKEN_METADATA, EMPTY_ASSET_METADATA, MIDEN_METADATA } from './defaults';
import { hasKnownScale } from './scale';

describe('hasKnownScale', () => {
  it('trusts a faucet that reported its own decimals', () => {
    expect(hasKnownScale({ decimals: 18, symbol: 'WETH', name: 'Wrapped Ether' })).toBe(true);
  });

  it('trusts the native asset', () => {
    expect(hasKnownScale(MIDEN_METADATA)).toBe(true);
  });

  it('refuses the unknown-token placeholder', () => {
    expect(hasKnownScale(DEFAULT_TOKEN_METADATA)).toBe(false);
  });

  // The placeholder is cached under `tokens_base_metadata`, so a wallet that met
  // an unresolvable faucet before the marker existed holds a copy without it,
  // and nothing rewrites that record. Recognising the shape is what carries the
  // fix to the users who have already seen the wrong number.
  it('refuses a cached placeholder written before the marker existed', () => {
    expect(hasKnownScale({ decimals: 6, symbol: 'Unknown', name: 'Unknown', thumbnailUri: '/default.svg' })).toBe(
      false
    );
  });

  // Every hop that rebuilds metadata field by field — the service worker's sync
  // DTO, the balance reducer — is an opportunity to drop the marker. The shape
  // test is the backstop for a copy that does.
  it('refuses a placeholder copy that lost the marker', () => {
    const { scaleIsUnknown, ...laundered } = DEFAULT_TOKEN_METADATA;
    expect(scaleIsUnknown).toBe(true);
    expect(hasKnownScale(laundered)).toBe(false);
  });

  // Absent metadata is not a false claim about scale; the callers' own MIDEN
  // fallback covers it, and treating it as unknown would withhold the amount on
  // every native-asset row whose faucet id has not been discovered yet.
  it('permits absent metadata, which states no scale to be wrong about', () => {
    expect(hasKnownScale(undefined)).toBe(true);
  });

  // Same symbol, real decimals: a faucet genuinely called "Unknown" that
  // reported 18 decimals is not the placeholder and must keep its number.
  it('trusts a faucet whose symbol happens to be Unknown', () => {
    expect(hasKnownScale({ decimals: 18, symbol: 'Unknown', name: 'Unknown' })).toBe(true);
  });

  it('trusts the empty placeholder, which states 0 decimals rather than guessing', () => {
    expect(hasKnownScale(EMPTY_ASSET_METADATA)).toBe(true);
  });
});
