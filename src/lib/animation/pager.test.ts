import { pagerMotion, pagerTapDurationMs } from './pager';

describe('pager motion', () => {
  it('scales the tap duration by pages moved and caps it', () => {
    expect(pagerTapDurationMs(1)).toBe(380);
    expect(pagerTapDurationMs(2)).toBe(420);
    expect(pagerTapDurationMs(4)).toBe(500);
    expect(pagerTapDurationMs(10)).toBe(500);
  });

  it('treats fewer than one page as one page', () => {
    expect(pagerTapDurationMs(0)).toBe(380);
  });

  it('exposes the tunables', () => {
    expect(pagerMotion).toEqual({
      tapEasing: 'cubic-bezier(0.35, 0.6, 0.25, 1)',
      tapBaseMs: 380,
      tapPerExtraPageMs: 40,
      tapMaxMs: 500,
      settleIdleMs: 120,
      alignTolerancePx: 1,
      interactionDeferCapMs: 1500
    });
  });
});
