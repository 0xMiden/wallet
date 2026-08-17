import {
  composeScreenKey,
  setRoutePart,
  setCardPart,
  pushOverlay,
  popOverlay,
  getCurrentScreen,
  __resetScreenKeyForTest,
  SCREEN_PUSH_DEBOUNCE_MS
} from './screen-key';

type PushMock = jest.Mock<void, [string, number]>;

function installPush(): PushMock {
  const fn = jest.fn() as PushMock;
  (window as typeof window & { __e2eScreenChanged?: (k: string, s: number) => void }).__e2eScreenChanged = fn;
  return fn;
}

beforeEach(() => {
  process.env.MIDEN_E2E_TEST = 'true';
  __resetScreenKeyForTest();
  delete (window as typeof window & { __e2eScreenChanged?: unknown }).__e2eScreenChanged;
  jest.useFakeTimers();
});
afterEach(() => jest.useRealTimers());

describe('composeScreenKey', () => {
  it('joins present parts with " > " and drops empties', () => {
    expect(composeScreenKey({ route: '/send', card: 'SelectAmount' })).toBe('/send > SelectAmount');
    expect(composeScreenKey({ route: '/send', card: null, overlay: 'drawer:token' })).toBe('/send > drawer:token');
    expect(composeScreenKey({})).toBe('');
  });
});

describe('publish', () => {
  it('bumps seq and updates __TEST_SCREEN__ immediately on a real change', () => {
    setRoutePart('/home');
    expect(getCurrentScreen()).toEqual({ key: '/home', seq: 1 });
    setCardPart('SelectAmount');
    expect(getCurrentScreen()).toEqual({ key: '/home > SelectAmount', seq: 2 });
  });

  it('does NOT bump seq when the composed key is unchanged', () => {
    setRoutePart('/home');
    setRoutePart('/home');
    expect(getCurrentScreen().seq).toBe(1);
  });

  it('overlay push then pop restores the base key (both are changes)', () => {
    setRoutePart('/send');
    pushOverlay('drawer:token');
    expect(getCurrentScreen().key).toBe('/send > drawer:token');
    popOverlay('drawer:token');
    expect(getCurrentScreen().key).toBe('/send');
    expect(getCurrentScreen().seq).toBe(3);
  });

  it('debounces the Chrome push and fires once with the latest key+seq', () => {
    const push = installPush();
    setRoutePart('/a');
    setRoutePart('/b');
    expect(push).not.toHaveBeenCalled();
    jest.advanceTimersByTime(SCREEN_PUSH_DEBOUNCE_MS);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith('/b', 2);
  });

  it('is a no-op when MIDEN_E2E_TEST !== "true"', () => {
    process.env.MIDEN_E2E_TEST = 'false';
    __resetScreenKeyForTest();
    setRoutePart('/home');
    expect(getCurrentScreen()).toEqual({ key: '', seq: 0 });
  });
});
