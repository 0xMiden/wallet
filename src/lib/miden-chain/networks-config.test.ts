import { GUARDIAN_OPTIONS } from './networks-config';

/**
 * #464 — Guardian provider display names must be spelled canonically and come
 * from the single GUARDIAN_OPTIONS source, so onboarding, Settings, Activity,
 * recovery and success/error copy all render the same brand name.
 */
describe('GUARDIAN_OPTIONS canonical provider names (#464)', () => {
  const byId = (id: string) => {
    const option = GUARDIAN_OPTIONS.find(o => o.id === id);
    if (!option) throw new Error(`no guardian option with id "${id}"`);
    return option;
  };

  it('spells OpenZeppelin as one word', () => {
    const oz = byId('open-zeppelin');
    expect(oz.name).toBe('OpenZeppelin');
    expect(oz.operatedBy).toBe('OpenZeppelin');
  });

  it('spells LambdaClass as one word', () => {
    const lc = byId('lambda-class');
    expect(lc.name).toBe('LambdaClass');
    expect(lc.operatedBy).toBe('LambdaClass');
  });

  it('keeps Gateway as the canonical operator brand', () => {
    expect(byId('gateway').operatedBy).toBe('Gateway');
  });

  it('never uses a non-canonical spelling for any provider', () => {
    const forbidden = ['Open Zeppelin', 'Open-Zeppelin', 'Lambda Class'];
    for (const option of GUARDIAN_OPTIONS) {
      for (const bad of forbidden) {
        expect(option.name).not.toContain(bad);
        expect(option.operatedBy).not.toContain(bad);
      }
    }
  });
});
