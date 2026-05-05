/* eslint-disable import/first */
/**
 * Coverage tests for `lib/miden/back/offscreen-prover.ts`.
 *
 * The module is a thin wrapper over the chrome.offscreen + chrome.runtime
 * APIs, which the standard webextension mock does not provide. We install
 * a hand-rolled mock that tracks lifecycle calls (create / close / has)
 * and the runtime message channel (sendMessage / onMessage), then re-import
 * the module under test per-suite via `jest.resetModules()` so the
 * module-scope `lifecycleQueue` and `nonSpeculativeProveCount` start clean.
 */

type OnMessageListener = (
  msg: any,
  sender: any,
  sendResponse: (response?: any) => void
) => boolean | undefined;

interface FakeChromeRuntime {
  sendMessage: jest.Mock;
  onMessage: {
    listeners: OnMessageListener[];
    addListener: jest.Mock;
    removeListener: jest.Mock;
  };
}

interface FakeOffscreen {
  createDocument: jest.Mock;
  closeDocument: jest.Mock;
  hasDocument: jest.Mock | undefined;
  Reason?: { WORKERS: 'WORKERS' };
}

interface FakeChrome {
  offscreen?: FakeOffscreen;
  runtime: FakeChromeRuntime;
}

let fakeChrome: FakeChrome;
let docExists = false;

function installChromeMock(opts: { withOffscreen?: boolean; withHasDocument?: boolean } = {}) {
  const { withOffscreen = true, withHasDocument = true } = opts;
  docExists = false;

  fakeChrome = {
    runtime: {
      sendMessage: jest.fn(),
      onMessage: {
        listeners: [],
        addListener: jest.fn((listener: OnMessageListener) => {
          fakeChrome.runtime.onMessage.listeners.push(listener);
        }),
        removeListener: jest.fn((listener: OnMessageListener) => {
          fakeChrome.runtime.onMessage.listeners = fakeChrome.runtime.onMessage.listeners.filter(
            l => l !== listener
          );
        })
      }
    }
  };

  if (withOffscreen) {
    fakeChrome.offscreen = {
      createDocument: jest.fn(async () => {
        docExists = true;
      }),
      closeDocument: jest.fn(async () => {
        docExists = false;
      }),
      hasDocument: withHasDocument ? jest.fn(async () => docExists) : undefined,
      Reason: { WORKERS: 'WORKERS' }
    };
  }

  (globalThis as any).chrome = fakeChrome;
}

function uninstallChromeMock() {
  delete (globalThis as any).chrome;
}

/** Fire the OFFSCREEN_READY signal so ensureOffscreenDocument resolves. */
function fireReady() {
  for (const listener of fakeChrome.runtime.onMessage.listeners) {
    listener({ type: 'OFFSCREEN_READY' }, undefined, () => {});
  }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('offscreen-prover', () => {
  beforeEach(() => {
    jest.resetModules();
    installChromeMock();
  });

  afterEach(() => {
    uninstallChromeMock();
  });

  describe('isOffscreenAvailable', () => {
    it('returns true when chrome.offscreen.createDocument exists', async () => {
      const mod = await import('./offscreen-prover');
      expect(mod.isOffscreenAvailable()).toBe(true);
    });

    it('returns false when chrome is undefined', async () => {
      uninstallChromeMock();
      const mod = await import('./offscreen-prover');
      expect(mod.isOffscreenAvailable()).toBe(false);
    });

    it('returns false when chrome.offscreen is undefined', async () => {
      installChromeMock({ withOffscreen: false });
      const mod = await import('./offscreen-prover');
      expect(mod.isOffscreenAvailable()).toBe(false);
    });

    it('returns false when createDocument is not a function', async () => {
      installChromeMock();
      // @ts-expect-error — intentionally clobber for this test
      fakeChrome.offscreen!.createDocument = undefined;
      const mod = await import('./offscreen-prover');
      expect(mod.isOffscreenAvailable()).toBe(false);
    });
  });

  describe('ensureOffscreenDocument', () => {
    it('is a no-op when a document already exists', async () => {
      const mod = await import('./offscreen-prover');
      docExists = true;
      await mod.ensureOffscreenDocument();
      expect(fakeChrome.offscreen!.createDocument).not.toHaveBeenCalled();
    });

    it('creates the document and waits for the OFFSCREEN_READY signal', async () => {
      const mod = await import('./offscreen-prover');

      const ensurePromise = mod.ensureOffscreenDocument();
      // Give the async function a tick to start.
      await flush();
      // Doc was created; createDocument resolved synchronously in the mock,
      // so docExists=true now. The function is now waiting for ready.
      expect(fakeChrome.offscreen!.createDocument).toHaveBeenCalledTimes(1);
      expect(fakeChrome.offscreen!.createDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'offscreen.html',
          reasons: ['WORKERS'],
          justification: expect.stringContaining('Multi-threaded WASM')
        })
      );
      // Ready signal not yet fired. The promise should still be pending.
      let resolved = false;
      void ensurePromise.then(() => {
        resolved = true;
      });
      await flush();
      expect(resolved).toBe(false);

      fireReady();
      await ensurePromise;
    });

    it('coalesces concurrent calls through the lifecycle queue', async () => {
      const mod = await import('./offscreen-prover');
      const a = mod.ensureOffscreenDocument();
      const b = mod.ensureOffscreenDocument();
      const c = mod.ensureOffscreenDocument();
      await flush();
      // Only ONE create call across three concurrent ensures.
      expect(fakeChrome.offscreen!.createDocument).toHaveBeenCalledTimes(1);
      fireReady();
      await Promise.all([a, b, c]);
    });

    it('falls back to clients.matchAll when chrome.offscreen.hasDocument is absent', async () => {
      installChromeMock({ withHasDocument: false });
      // Stub the SW global self.clients.matchAll.
      const matchAll = jest.fn(async () => [{ url: 'http://example.test/offscreen.html' }]);
      (globalThis as any).self = { clients: { matchAll } };

      const mod = await import('./offscreen-prover');
      // matchAll will report a doc with url ending in offscreen.html → no-op.
      await mod.ensureOffscreenDocument();
      expect(matchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true });
      expect(fakeChrome.offscreen!.createDocument).not.toHaveBeenCalled();

      delete (globalThis as any).self;
    });

    it('rejects with timeout when ready signal never arrives', async () => {
      jest.useFakeTimers();
      const mod = await import('./offscreen-prover');

      // Capture rejection eagerly so async promise expectations don't race
      // the fake-timer manipulation.
      const ensurePromise = mod.ensureOffscreenDocument().catch((e: Error) => e);
      // Drive ALL pending timers + microtasks. runAllTimersAsync flushes
      // both, which is what we need: the setTimeout(..., 30_000) registers
      // after a microtask chain through withLifecycleLock; just advancing
      // time without flushing promises misses it.
      await jest.runAllTimersAsync();
      jest.useRealTimers();

      const result = await ensurePromise;
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toMatch(/ready signal timed out/);
    });
  });

  describe('abortSpeculativeProve', () => {
    it('returns false when no document exists', async () => {
      const mod = await import('./offscreen-prover');
      const ok = await mod.abortSpeculativeProve();
      expect(ok).toBe(false);
      expect(fakeChrome.offscreen!.closeDocument).not.toHaveBeenCalled();
    });

    it('closes the document and returns true when one exists', async () => {
      const mod = await import('./offscreen-prover');
      docExists = true;
      const ok = await mod.abortSpeculativeProve();
      expect(ok).toBe(true);
      expect(fakeChrome.offscreen!.closeDocument).toHaveBeenCalledTimes(1);
      expect(docExists).toBe(false);
    });

    it('bails when a non-speculative prove is in flight', async () => {
      const mod = await import('./offscreen-prover');

      // Start a non-speculative prove. It'll await ensureOffscreenDocument
      // which we'll let resolve, then sit on sendMessage forever.
      let resolveSend: (value: any) => void = () => {};
      fakeChrome.runtime.sendMessage.mockReturnValueOnce(
        new Promise(r => {
          resolveSend = r;
        })
      );
      const provePromise = mod.proveViaOffscreen(new Uint8Array([1, 2, 3]), null);
      await flush();
      fireReady();
      await flush();

      // Now non-speculative prove is in flight — abort should bail.
      const ok = await mod.abortSpeculativeProve();
      expect(ok).toBe(false);
      expect(fakeChrome.offscreen!.closeDocument).not.toHaveBeenCalled();

      // Resolve the prove so the test exits cleanly.
      resolveSend({ ok: true, provenB64: '', durationMs: 0 });
      await provePromise;
    });
  });

  describe('proveViaOffscreen', () => {
    it('returns provenBytes + durationMs on success', async () => {
      const mod = await import('./offscreen-prover');
      // Stub sendMessage with a successful response.
      const provenBytes = new Uint8Array([7, 8, 9]);
      const provenB64 = Buffer.from(provenBytes).toString('base64');
      fakeChrome.runtime.sendMessage.mockResolvedValueOnce({
        ok: true,
        provenB64,
        durationMs: 1234
      });

      const promise = mod.proveViaOffscreen(new Uint8Array([1, 2, 3]), null);
      await flush();
      fireReady();
      const result = await promise;

      expect(result.durationMs).toBe(1234);
      expect(new Uint8Array(result.provenBytes)).toEqual(provenBytes);
      expect(fakeChrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          target: 'offscreen',
          type: 'OFFSCREEN_PROVE',
          proverDescriptor: null,
          txResultB64: expect.any(String)
        })
      );
    });

    it('passes the proverDescriptor through to the offscreen doc', async () => {
      const mod = await import('./offscreen-prover');
      fakeChrome.runtime.sendMessage.mockResolvedValueOnce({
        ok: true,
        provenB64: '',
        durationMs: 0
      });
      const promise = mod.proveViaOffscreen(new Uint8Array([1]), 'remote|http://x|5000');
      await flush();
      fireReady();
      await promise;

      expect(fakeChrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ proverDescriptor: 'remote|http://x|5000' })
      );
    });

    it('throws on undefined response (doc reaped or closed)', async () => {
      const mod = await import('./offscreen-prover');
      fakeChrome.runtime.sendMessage.mockResolvedValueOnce(undefined);
      const promise = mod.proveViaOffscreen(new Uint8Array([1]), null);
      await flush();
      fireReady();
      await expect(promise).rejects.toThrow(/no response/);
    });

    it('throws with the offscreen-side error message when ok=false', async () => {
      const mod = await import('./offscreen-prover');
      fakeChrome.runtime.sendMessage.mockResolvedValueOnce({
        ok: false,
        error: 'WASM exploded'
      });
      const promise = mod.proveViaOffscreen(new Uint8Array([1]), null);
      await flush();
      fireReady();
      await expect(promise).rejects.toThrow(/WASM exploded/);
    });

    it('decrements nonSpeculativeProveCount even when sendMessage rejects', async () => {
      const mod = await import('./offscreen-prover');
      fakeChrome.runtime.sendMessage.mockRejectedValueOnce(new Error('chrome boom'));
      const promise = mod.proveViaOffscreen(new Uint8Array([1]), null);
      await flush();
      fireReady();
      await expect(promise).rejects.toThrow(/chrome boom/);

      // Counter should have decremented; abort should now be free to close.
      docExists = true;
      const ok = await mod.abortSpeculativeProve();
      expect(ok).toBe(true);
    });

    it('speculative=true does not increment the non-speculative counter', async () => {
      const mod = await import('./offscreen-prover');

      // Hold the speculative prove open with a never-resolving sendMessage.
      let resolveSend: (value: any) => void = () => {};
      fakeChrome.runtime.sendMessage.mockReturnValueOnce(
        new Promise(r => {
          resolveSend = r;
        })
      );
      const provePromise = mod.proveViaOffscreen(new Uint8Array([1]), null, { speculative: true });
      await flush();
      fireReady();
      await flush();

      // Speculative prove is in flight — abort should NOT bail (counter is 0).
      docExists = true;
      const ok = await mod.abortSpeculativeProve();
      expect(ok).toBe(true);

      // Resolve to clean up.
      resolveSend({ ok: true, provenB64: '', durationMs: 0 });
      try {
        await provePromise;
      } catch {
        /* may throw if the test environment closed the doc — that's fine */
      }
    });

    it('chunked base64 encode handles arrays larger than 0x8000', async () => {
      const mod = await import('./offscreen-prover');
      // 0x9000 bytes — exercises the chunked-encode loop in bytesToB64.
      const big = new Uint8Array(0x9000).fill(0x42);
      let captured: string | undefined;
      fakeChrome.runtime.sendMessage.mockImplementationOnce(async (msg: any) => {
        captured = msg.txResultB64;
        return { ok: true, provenB64: '', durationMs: 0 };
      });
      const promise = mod.proveViaOffscreen(big, null);
      await flush();
      fireReady();
      await promise;

      expect(captured).toBeDefined();
      const decoded = Buffer.from(captured!, 'base64');
      expect(decoded.length).toBe(0x9000);
      expect(decoded[0]).toBe(0x42);
      expect(decoded[0x9000 - 1]).toBe(0x42);
    });
  });
});
