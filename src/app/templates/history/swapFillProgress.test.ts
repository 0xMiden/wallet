import { swapFillProgress } from './swapFillProgress';

describe('swapFillProgress', () => {
  it.each([
    [0n, 1000n, '0'],
    [400n, 1000n, '40'],
    [1000n, 1000n, '100'],
    [1500n, 1000n, '100'],
    [1n, 10000000n, '<0.1'],
    [9999n, 10000n, '99.9'],
    [41590n, 100000n, '41.5'],
    [415900000000000n, 1000000000000000n, '41.5']
  ])('formats %s / %s base units without overstating a partial fill', (filled, total, expected) => {
    expect(swapFillProgress(filled, total)?.text).toBe(expected);
  });

  it.each([
    [undefined, 1000n],
    [400n, undefined],
    [400n, 0n],
    [-1n, 1000n],
    [400n, -1n]
  ])('withholds unknown or invalid progress (%s / %s)', (filled, total) => {
    expect(swapFillProgress(filled, total)).toBeUndefined();
  });
});
