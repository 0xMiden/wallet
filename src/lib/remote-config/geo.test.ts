import { geoFeatureEnabled, hasGeoBlocks, parseGeoPhrase, placeBlocked, readGeoBlocks } from './geo';

const invalid = (): never => {
  throw new Error('invalid');
};

const callRetainedStartupRequestFailure = (reason: string, failure: unknown): unknown => {
  const geo = jest.requireActual<typeof import('./geo')>('./geo');
  const retained = Reflect.get(geo, 'retainedStartupRequestFailure');
  if (typeof retained !== 'function') throw new TypeError('retainedStartupRequestFailure is not a function');
  return Reflect.apply(retained, undefined, [reason, failure]);
};

const oneClick = {
  serviceUrl: 'https://intents.example/api',
  midenAssets: [{ assetId: 'miden:usdc', faucetId: `0x${'ab'.repeat(15)}`, decimals: 6 }]
};

describe('geoFeatureEnabled', () => {
  it('keeps DEX swap eligibility when its solver is configured', () => {
    expect(geoFeatureEnabled('swap', { features: { earn: false }, swap: { etaUrl: 'https://solver.example' } })).toBe(
      true
    );
  });

  it('enables OneClick swap capability only with the explicit switch and a usable mapping', () => {
    expect(geoFeatureEnabled('swap', { features: { earn: false, nearIntents: true }, swap: { oneClick } })).toBe(true);
    expect(geoFeatureEnabled('swap', { features: { earn: false, nearIntents: false }, swap: { oneClick } })).toBe(
      false
    );
    expect(geoFeatureEnabled('swap', { features: { earn: false }, swap: { oneClick } })).toBe(false);
    expect(geoFeatureEnabled('swap', { features: { earn: false, nearIntents: 'true' }, swap: { oneClick } })).toBe(
      false
    );
    expect(geoFeatureEnabled('swap', { features: { earn: false, nearIntents: true } })).toBe(false);
  });

  it('does not enable a OneClick configuration without any parsed Miden mappings', () => {
    expect(
      geoFeatureEnabled('swap', {
        features: { earn: false, nearIntents: true },
        swap: { oneClick: { ...oneClick, midenAssets: [] } }
      })
    ).toBe(false);
  });

  it('enables Earn only from its existing switch', () => {
    expect(geoFeatureEnabled('earn', { features: { earn: true } })).toBe(true);
    expect(geoFeatureEnabled('earn', { features: { earn: false, nearIntents: true }, swap: { oneClick } })).toBe(false);
  });
});

describe('parseGeoPhrase', () => {
  it.each([
    ['block NY state', { country: 'US', region: 'NY' }],
    ['  Block   New York ', { country: 'US', region: 'NY' }],
    ['block UK', { country: 'GB' }],
    ['block United Kingdom', { country: 'GB' }],
    ['block GB', { country: 'GB' }],
    ['block US-NY', { country: 'US', region: 'NY' }],
    ['block US-CA', { country: 'US', region: 'CA' }],
    ['block DE', { country: 'DE' }]
  ])('reads %s', (phrase, place) => {
    expect(parseGeoPhrase(phrase)).toEqual(place);
  });

  it.each([
    'NY state',
    'block',
    'block Narnia',
    'block USA',
    'block US-',
    'block constructor',
    'block __proto__',
    'block toString'
  ])('does not read %s', phrase => {
    expect(parseGeoPhrase(phrase)).toBeUndefined();
  });
});

describe('readGeoBlocks', () => {
  const rules = {
    earn: { 'block NY state': 'yes', 'block UK': 'yes', 'block US-CA': 'no' },
    swap: { 'block DE': 'yes' },
    bridgeIn: { 'block UK': 'yes' }
  };

  it('keeps the yes places for earn and swap, and skips a feature this build does not gate', () => {
    expect(readGeoBlocks(rules, invalid)).toEqual({
      earn: [{ country: 'US', region: 'NY' }, { country: 'GB' }],
      swap: [{ country: 'DE' }]
    });
    expect(hasGeoBlocks({ geo: readGeoBlocks(rules, invalid) })).toBe(true);
  });

  it('ignores inherited object property names instead of treating them as places', () => {
    expect(readGeoBlocks({ earn: { 'block constructor': 'yes', 'block __proto__': 'yes' } }, invalid)).toBeUndefined();
  });

  it('is absent when every answer is no or the section is missing', () => {
    expect(readGeoBlocks({ earn: { 'block UK': 'no' } }, invalid)).toBeUndefined();
    expect(readGeoBlocks(undefined, invalid)).toBeUndefined();
    expect(hasGeoBlocks({})).toBe(false);
  });

  it('skips a phrase it does not know and rejects a value that is not yes or no', () => {
    expect(readGeoBlocks({ earn: { 'block Narnia': 'yes', 'block UK': 'yes' } }, invalid)).toEqual({
      earn: [{ country: 'GB' }]
    });
    expect(() => readGeoBlocks({ earn: { 'block UK': true } }, invalid)).toThrow('invalid');
    expect(() => readGeoBlocks({ earn: ['block UK'] }, invalid)).toThrow('invalid');
    expect(() => readGeoBlocks([], invalid)).toThrow('invalid');
  });
});

describe('placeBlocked', () => {
  const blocks = [{ country: 'US', region: 'NY' }, { country: 'GB' }];

  it('blocks New York and the UK, and allows another US state', () => {
    expect(placeBlocked(blocks, { country: 'US', region: 'NY' })).toBe('block');
    expect(placeBlocked(blocks, { country: 'gb' })).toBe('block');
    expect(placeBlocked(blocks, { country: 'US', region: 'CA' })).toBe('allow');
    expect(placeBlocked(blocks, { country: 'DE', region: 'BE' })).toBe('allow');
  });

  it('stays unknown when a state rule covers the country and the lookup named no state', () => {
    expect(placeBlocked(blocks, { country: 'US' })).toBe('unknown');
    expect(placeBlocked([{ country: 'GB' }], { country: 'US' })).toBe('allow');
  });
});

describe('global wallet policy', () => {
  it('keeps wallet country and subdivision rules separately from new Earn rules', () => {
    expect(
      readGeoBlocks({ wallet: { 'block RU': 'yes', 'block UA-43': 'yes' }, earn: { 'block UK': 'yes' } }, invalid)
    ).toEqual({
      wallet: [{ country: 'RU' }, { country: 'UA', region: '43' }],
      earn: [{ country: 'GB' }]
    });
  });

  it('preserves explicit empty wallet policy so it differs from missing global policy', () => {
    expect(readGeoBlocks({ wallet: {} }, invalid)).toEqual({ wallet: [] });
  });

  it('rejects an unknown active global rule rather than silently allowing it', () => {
    expect(() => readGeoBlocks({ wallet: { 'block unknown territory': 'yes' } }, invalid)).toThrow();
  });
});

describe('retainedStartupRequestFailure', () => {
  it('retains a request_failed member and rejects version_mismatch and a non-member', () => {
    expect(callRetainedStartupRequestFailure('request_failed', 'http_error')).toBe('http_error');
    expect(callRetainedStartupRequestFailure('version_mismatch', 'http_error')).toBeUndefined();
    expect(callRetainedStartupRequestFailure('request_failed', 'https://private.example')).toBeUndefined();
  });
});
