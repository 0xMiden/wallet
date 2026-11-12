import { lineageFilledAmount, paybacksCoverFill } from './payback-fill';

describe('lineageFilledAmount', () => {
  it.each([
    [50n, { state: 0, remainingRequested: '20' }, 30n],
    [50n, { state: 1, remainingRequested: '0' }, 50n],
    ['50', { state: 0, remainingRequested: '20' }, 30n],
    [50n, { state: 2, remainingRequested: '0' }, undefined],
    [50n, { state: 0, remainingRequested: '60' }, undefined],
    [50n, { state: 0, remainingRequested: 'x' }, undefined]
  ])('ask %s with %j gives %s', (ask, lineage, expected) => {
    expect(lineageFilledAmount(ask, lineage)).toBe(expected);
  });
});

describe('paybacksCoverFill', () => {
  it('covers a fill the claimable paybacks pay in full', () => {
    expect(paybacksCoverFill(50n, new Map(), new Map([[1, 50n]]))).toBe(true);
  });

  it('covers an over-fill', () => {
    expect(paybacksCoverFill(50n, new Map(), new Map([[1, 60n]]))).toBe(true);
  });

  it('does not cover a fill a round paid elsewhere leaves short', () => {
    expect(
      paybacksCoverFill(
        30n,
        new Map(),
        new Map([
          [1, 1n],
          [2, 20n]
        ])
      )
    ).toBe(false);
  });

  it('counts a held round once, by the amount its claim recorded', () => {
    const claimable = new Map([
      [1, 10n],
      [2, 20n]
    ]);
    expect(paybacksCoverFill(30n, new Map([[1, 10n]]), claimable)).toBe(true);
    expect(paybacksCoverFill(30n, new Map([[1, 0n]]), new Map([[2, 20n]]))).toBe(false);
  });

  it('never covers an unknown or empty fill', () => {
    expect(paybacksCoverFill(undefined, new Map(), new Map([[1, 5n]]))).toBe(false);
    expect(paybacksCoverFill(0n, new Map(), new Map([[1, 5n]]))).toBe(false);
  });
});
