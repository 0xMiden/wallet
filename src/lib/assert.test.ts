import assert, { AssertionError } from './assert';

describe('AssertionError', () => {
  it('is a subclass of Error', () => {
    const err = new AssertionError();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AssertionError);
  });

  it('defaults message to empty string and actual to undefined', () => {
    const err = new AssertionError();
    expect(err.message).toBe('');
    expect(err.actual).toBeUndefined();
  });

  it('stores the provided message', () => {
    const err = new AssertionError('boom');
    expect(err.message).toBe('boom');
    expect(err.actual).toBeUndefined();
  });

  it('stores both message and actual value', () => {
    const err = new AssertionError('boom', 0);
    expect(err.message).toBe('boom');
    expect(err.actual).toBe(0);
  });

  it('preserves falsy actual values including null', () => {
    const err = new AssertionError('nope', null);
    expect(err.actual).toBeNull();
  });
});

describe('assert', () => {
  it('does not throw for truthy values', () => {
    expect(() => assert(true)).not.toThrow();
    expect(() => assert(1)).not.toThrow();
    expect(() => assert('non-empty')).not.toThrow();
    expect(() => assert({})).not.toThrow();
    expect(() => assert([])).not.toThrow();
  });

  it.each([
    ['false', false],
    ['zero', 0],
    ['empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['NaN', NaN]
  ])('throws AssertionError for falsy value: %s', (_label, value) => {
    expect(() => assert(value)).toThrow(AssertionError);
  });

  it('uses the default message that includes the value when none is provided', () => {
    let caught: AssertionError | undefined;
    try {
      assert(0);
    } catch (e) {
      caught = e as AssertionError;
    }
    expect(caught).toBeInstanceOf(AssertionError);
    expect(caught?.message).toBe('The value 0 is not truthy');
    expect(caught?.actual).toBe(0);
  });

  it('uses a custom error message when provided', () => {
    let caught: AssertionError | undefined;
    try {
      assert(null, 'value must be defined');
    } catch (e) {
      caught = e as AssertionError;
    }
    expect(caught).toBeInstanceOf(AssertionError);
    expect(caught?.message).toBe('value must be defined');
    expect(caught?.actual).toBeNull();
  });

  it('narrows the type so the value is usable after the assertion', () => {
    const maybe: string | undefined = 'ok';
    assert(maybe);
    // After the assertion `maybe` is narrowed to `string`.
    expect(maybe.length).toBe(2);
  });
});
