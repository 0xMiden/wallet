import { unauthorizedRequeueCooldownSec } from 'lib/miden/transaction';

describe('unauthorizedRequeueCooldownSec', () => {
  // Both ends matter and neither is arbitrary. The floor has to stay clear of
  // the processing loop's ~5s poll, or a requeued row is re-picked every cycle
  // and hammers the guardian this arm exists to give room to recover. The
  // ceiling is what decorrelates a fleet that all hit this at the same moment,
  // since the trigger is guardian latency under load. It does NOT clear the
  // guardian's candidate quarantine — that window is budgeted at 12 x 5s, wider
  // than any draw can reach — see UNAUTHORIZED_EXECUTION_JITTER_SEC's own
  // comment.
  //
  // Pinned on the pure function rather than through `generateTransaction`,
  // because pinning it there needs a constant `Math.random`, and a constant draw
  // held across a failing assertion makes jest's source-map sort degenerate: the
  // run dies with `RangeError: Maximum call stack size exceeded` and never
  // prints which expectation failed. These are the assertions that must survive
  // their own failure, so they take the draw as an argument instead.
  it('is 15s at the floor of the draw', () => {
    expect(unauthorizedRequeueCooldownSec(0)).toBe(15);
  });

  it('is 54s at the ceiling of the draw, never 55', () => {
    // `Math.random` is exclusive of 1, so 54 is the real maximum — the value the
    // CHANGELOG and the arm's comments quote. A draw of exactly 1 would produce
    // 55, which is why the floor is taken rather than rounded.
    expect(unauthorizedRequeueCooldownSec(0.999999)).toBe(54);
    expect(unauthorizedRequeueCooldownSec(0.5)).toBe(35);
  });

  it('never returns below the loop poll interval, for any draw in range', () => {
    for (let draw = 0; draw < 1; draw += 0.01) {
      const cooldown = unauthorizedRequeueCooldownSec(draw);
      expect(cooldown).toBeGreaterThanOrEqual(15);
      expect(cooldown).toBeLessThanOrEqual(54);
    }
  });
});
