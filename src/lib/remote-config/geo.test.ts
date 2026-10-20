import { hasGeoBlocks, parseGeoPhrase, placeBlocked, readGeoBlocks } from './geo';

const invalid = (): never => {
  throw new Error('invalid');
};

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

  it.each(['NY state', 'block', 'block Narnia', 'block USA', 'block US-'])('does not read %s', phrase => {
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
