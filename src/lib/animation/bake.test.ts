import { BAKE_PHASE_MS, BAKE_PHASES, bakeMotion, bakePhaseReached, nextBakePhase } from './bake';

describe('bake motion', () => {
  it('runs the phases in one order, from the dough coming in to the welcome', () => {
    expect(BAKE_PHASES).toEqual(['enter', 'open', 'load', 'close', 'bake', 'ding', 'serve', 'welcome']);
  });

  it('gives every phase but the last a timer, and the whole sequence stays under six seconds', () => {
    expect(Object.keys(BAKE_PHASE_MS)).toEqual(BAKE_PHASES.filter(phase => phase !== 'welcome'));
    const total = Object.values(BAKE_PHASE_MS).reduce((sum, ms) => sum + ms, 0);
    expect(total).toBeGreaterThan(3000);
    expect(total).toBeLessThan(6000);
  });

  it('bakes for longer than any other phase, so the change from dough to loaf can be seen', () => {
    const others = Object.entries(BAKE_PHASE_MS).filter(([phase]) => phase !== 'bake');
    for (const [, ms] of others) expect(BAKE_PHASE_MS.bake).toBeGreaterThan(ms);
    expect(bakeMotion.brown).toMatchObject({ type: 'tween', duration: BAKE_PHASE_MS.bake / 1000 });
  });

  it('steps to the subsequent phase, and stays on the welcome', () => {
    expect(nextBakePhase('enter')).toBe('open');
    expect(nextBakePhase('bake')).toBe('ding');
    expect(nextBakePhase('serve')).toBe('welcome');
    expect(nextBakePhase('welcome')).toBe('welcome');
  });

  it('tells when the sequence is at or after a phase', () => {
    expect(bakePhaseReached('close', 'bake')).toBe(false);
    expect(bakePhaseReached('bake', 'bake')).toBe(true);
    expect(bakePhaseReached('welcome', 'serve')).toBe(true);
  });

  it('loops the glow, the shake, the steam and the twinkle, and nothing else', () => {
    const loops = Object.entries(bakeMotion)
      .filter(([, transition]) => 'repeat' in transition && transition.repeat === Infinity)
      .map(([name]) => name);
    expect(loops.sort()).toEqual(['glow', 'steam', 'twinkle', 'wobble']);
  });
});
