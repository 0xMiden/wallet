import { radioGroupKeyTarget } from './radio-group-keys';

describe('radioGroupKeyTarget', () => {
  it('lands either walk on the first enabled option when there is no origin', () => {
    expect(radioGroupKeyTarget('ArrowDown', 4, -1)).toBe(0);
    expect(radioGroupKeyTarget('ArrowUp', 4, -1)).toBe(0);
  });

  it('wraps NEXT from the last position to the first, and PREV from the first to the last', () => {
    expect(radioGroupKeyTarget('ArrowRight', 4, 3)).toBe(0);
    expect(radioGroupKeyTarget('ArrowLeft', 4, 0)).toBe(3);
  });

  it('Home and End are absolute, from any origin', () => {
    expect(radioGroupKeyTarget('Home', 4, 2)).toBe(0);
    expect(radioGroupKeyTarget('End', 4, 2)).toBe(3);
    expect(radioGroupKeyTarget('Home', 4, -1)).toBe(0);
    expect(radioGroupKeyTarget('End', 4, -1)).toBe(3);
  });

  it('returns null for an unhandled key, also with no origin', () => {
    expect(radioGroupKeyTarget('a', 4, 2)).toBeNull();
    expect(radioGroupKeyTarget('Enter', 4, -1)).toBeNull();
  });

  it('returns null when there is nothing enabled', () => {
    expect(radioGroupKeyTarget('ArrowDown', 0, -1)).toBeNull();
  });
});
