import { pagerMotion } from './pager';

describe('pager motion', () => {
  it('exposes the tunables', () => {
    expect(pagerMotion).toEqual({
      switchExitMs: 90,
      switchEnterMs: 170,
      switchNudgePx: 12,
      switchEnterEasing: 'cubic-bezier(0.05, 0.7, 0.1, 1)',
      switchHoldMs: 360,
      interactionDeferCapMs: 1500
    });
  });
});
