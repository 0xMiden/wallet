import { spawnProveWorker } from './spawn-prove-worker';

describe('spawnProveWorker', () => {
  const realWorker = globalThis.Worker;
  afterEach(() => {
    globalThis.Worker = realWorker;
  });

  it('starts the prove worker as a module worker from its sibling source file', () => {
    const constructed: Array<{ url: string; options: WorkerOptions | undefined }> = [];
    class FakeWorker extends EventTarget {
      constructor(url: string | URL, options?: WorkerOptions) {
        super();
        constructed.push({ url: String(url), options });
      }
    }
    Object.defineProperty(globalThis, 'Worker', { value: FakeWorker, configurable: true, writable: true });

    const worker = spawnProveWorker();

    expect(worker).toBeInstanceOf(FakeWorker);
    expect(constructed).toHaveLength(1);
    expect(constructed[0]?.url).toMatch(/\/src\/offscreen\/prove-worker\.ts$/);
    expect(constructed[0]?.options).toEqual({ type: 'module' });
  });
});
