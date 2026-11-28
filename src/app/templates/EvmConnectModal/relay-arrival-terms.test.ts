import { arrivalTermsHold, RELAY_ARRIVAL_TOLERANCE_BPS, reviewedReceiveUnits } from './relay-arrival-terms';

describe('arrivalTermsHold', () => {
  const reviewed = 1_000_000n;

  it('is 0.5 %', () => {
    expect(RELAY_ARRIVAL_TOLERANCE_BPS).toBe(50n);
  });

  it.each<[string, bigint, boolean]>([
    ['better than the review', 1_000_100n, true],
    ['equal to the review', 1_000_000n, true],
    ['within the tolerance', 995_000n, true],
    ['one unit past the tolerance', 994_999n, false],
    ['much worse', 900_000n, false]
  ])('takes an arrival quote %s: %s', (_name, receive, holds) => {
    expect(arrivalTermsHold(receive, reviewed)).toBe(holds);
  });
});

describe('reviewedReceiveUnits', () => {
  it('reads the reviewed amount at the decimals of what arrives', () => {
    expect(reviewedReceiveUnits({ outputAmount: '1.498' }, 6)).toBe(1_498_000n);
  });

  it('gives null with no record or no reviewed amount', () => {
    expect(reviewedReceiveUnits(null, 6)).toBeNull();
    expect(reviewedReceiveUnits({ outputAmount: undefined }, 6)).toBeNull();
  });

  it('gives null for an amount that does not parse', () => {
    expect(reviewedReceiveUnits({ outputAmount: 'one' }, 6)).toBeNull();
  });
});
