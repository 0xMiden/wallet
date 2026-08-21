import { DEFAULT_TOKEN_METADATA, EMPTY_ASSET_METADATA, MIDEN_METADATA } from './defaults';
import { hasKnownScale, resolveDisplayMetadata } from './scale';
import { AssetMetadata } from './types';

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

  // Absent is unknown. The MIDEN fallback callers used to lean on for this case
  // supplies the same invented 6 decimals the placeholder does, just sourced
  // from the native token — so a faucet the store has not resolved would still
  // render an 18-decimal balance a trillion times too large. Callers decide
  // deliberately via `resolveDisplayMetadata`, which maps "no faucet" and "the
  // native faucet" to MIDEN and everything else to the placeholder.
  it('refuses absent metadata, which resolves nothing to trust', () => {
    expect(hasKnownScale(undefined)).toBe(false);
  });

  // Same symbol, real decimals: a faucet genuinely called "Unknown" that
  // reported 18 decimals is not the placeholder and must keep its number.
  it('trusts a faucet whose symbol happens to be Unknown', () => {
    expect(hasKnownScale({ decimals: 18, symbol: 'Unknown', name: 'Unknown' })).toBe(true);
  });

  // The genuine collision: a faucet named "Unknown" that really does have 6
  // decimals is byte-for-byte the placeholder. `fetchTokenMetadata` stamps
  // `scaleIsUnknown: false` on anything the chain answered for, and that word
  // has to beat the shape test — otherwise this token can never be quantified.
  it('trusts a real faucet indistinguishable from the placeholder by shape', () => {
    expect(hasKnownScale({ decimals: 6, symbol: 'Unknown', name: 'Unknown', scaleIsUnknown: false })).toBe(true);
  });

  it('trusts the empty placeholder, which states 0 decimals rather than guessing', () => {
    expect(hasKnownScale(EMPTY_ASSET_METADATA)).toBe(true);
  });
});

describe('resolveDisplayMetadata', () => {
  const NATIVE = 'mtst1native';
  const OTHER = 'mtst1other';
  const RESOLVED: AssetMetadata = { symbol: 'DAI', name: 'Dai', decimals: 18 };

  it('treats a row with no faucet as the native asset', () => {
    expect(resolveDisplayMetadata(undefined, {}, NATIVE)).toBe(MIDEN_METADATA);
  });

  it('returns the stored record for a resolved faucet', () => {
    expect(resolveDisplayMetadata(OTHER, { [OTHER]: RESOLVED }, NATIVE)).toBe(RESOLVED);
  });

  // MIDEN's scale is fixed, so an empty store is no reason to withhold it.
  it('resolves the native faucet to MIDEN even before the store has it', () => {
    expect(resolveDisplayMetadata(NATIVE, {}, NATIVE)).toBe(MIDEN_METADATA);
  });

  // The case the whole predicate exists for: an unresolved foreign faucet must
  // come back declaring its scale unknown, not silently borrowing MIDEN's.
  it('resolves an unknown foreign faucet to the placeholder', () => {
    const resolved = resolveDisplayMetadata(OTHER, {}, NATIVE);

    expect(resolved).toBe(DEFAULT_TOKEN_METADATA);
    expect(hasKnownScale(resolved)).toBe(false);
  });

  // Before `useMidenFaucetId` resolves there is no way to tell the native
  // faucet from any other, and guessing MIDEN would reinstate the bug.
  it('treats a named faucet as unknown while the native id is still loading', () => {
    expect(hasKnownScale(resolveDisplayMetadata(OTHER, {}, null))).toBe(false);
  });
});
