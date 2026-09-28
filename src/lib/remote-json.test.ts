import { withRequestTimeout } from './remote-json';

/** Runs `body` as on iOS 15 WebKit and Safari before 16, which have no AbortSignal.timeout. */
const withoutAbortSignalTimeout = async (body: () => Promise<void>) => {
  const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
  Reflect.deleteProperty(AbortSignal, 'timeout');
  try {
    expect('timeout' in AbortSignal).toBe(false);
    await body();
  } finally {
    if (descriptor) Object.defineProperty(AbortSignal, 'timeout', descriptor);
  }
};

describe('withRequestTimeout', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('aborts the signal once the time runs out, not before', async () => {
    let signal: AbortSignal | undefined;
    const settled = withRequestTimeout(
      10_000,
      given =>
        new Promise<never>((_resolve, reject) => {
          signal = given;
          given.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    const outcome = settled.catch((error: unknown) => error);

    await jest.advanceTimersByTimeAsync(9_999);
    expect(signal?.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    await expect(outcome).resolves.toEqual(new Error('aborted'));
  });

  it.each([
    ['resolves', () => Promise.resolve('body')],
    ['rejects', () => Promise.reject(new Error('offline'))]
  ])('leaves no timer behind when the request %s', async (_label, run) => {
    await withRequestTimeout(10_000, run).catch(() => undefined);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('leaves no timer behind when the request throws before it starts', async () => {
    const run = (): Promise<string> => {
      throw new TypeError('bad options');
    };
    await expect(withRequestTimeout(10_000, run)).rejects.toThrow('bad options');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('works where AbortSignal.timeout does not exist', () =>
    withoutAbortSignalTimeout(async () => {
      await expect(withRequestTimeout(10_000, async signal => signal.aborted)).resolves.toBe(false);
    }));
});
