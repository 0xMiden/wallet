import { spawnFaucetPowWorker } from './spawn-faucet-pow-worker';

it('constructs a bundled module worker from its sibling source file', () => {
  const original = globalThis.Worker;
  const constructed: Array<{ url: string; options?: WorkerOptions }> = [];
  class FakeWorker {
    constructor(url: string | URL, options?: WorkerOptions) {
      constructed.push({ url: String(url), options });
    }
  }
  try {
    Object.defineProperty(globalThis, 'Worker', { value: FakeWorker, configurable: true, writable: true });
    expect(spawnFaucetPowWorker()).toBeInstanceOf(FakeWorker);
    expect(constructed).toEqual([
      { url: expect.stringMatching(/\/src\/lib\/miden-chain\/faucet-pow-worker\.ts$/), options: { type: 'module' } }
    ]);
  } finally {
    globalThis.Worker = original;
  }
});
