/**
 * Unit coverage for `buildNativeProverCallback` and its base64 helpers.
 *
 * Production caller paths (in `miden-client-interface.ts`) hand the
 * resulting closure to `TransactionProver.newCallbackProver(jsFn)`; the
 * SDK then calls the closure with serialized `TransactionInputs` bytes.
 * These tests stub the `@miden/native-prover` Capacitor plugin so the
 * pure-JS layer (isMobile guard + base64 round-trip) can be exercised
 * in jest without a real native bridge.
 */

const proveMock = jest.fn();
const isMobileMock = jest.fn(() => true);

jest.mock('@miden/native-prover', () => ({
  MidenNativeProver: {
    prove: (...args: unknown[]) => proveMock(...args)
  }
}));

jest.mock('lib/platform', () => ({
  isMobile: () => isMobileMock()
}));

import { buildNativeProverCallback } from './native-prover-mobile';

describe('buildNativeProverCallback', () => {
  beforeEach(() => {
    proveMock.mockReset();
    isMobileMock.mockReset();
    isMobileMock.mockReturnValue(true);
  });

  it('throws when called outside a mobile context', () => {
    isMobileMock.mockReturnValue(false);
    expect(() => buildNativeProverCallback()).toThrow(/outside a mobile context/);
  });

  it('returns a Uint8Array → Promise<Uint8Array> callback on mobile', () => {
    const cb = buildNativeProverCallback();
    expect(typeof cb).toBe('function');
    expect(cb.length).toBe(1);
  });

  it('round-trips bytes through base64 to the native bridge and back', async () => {
    const inputBytes = new Uint8Array([0x00, 0x01, 0xff, 0x7f, 0x80]);
    const outputBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);

    proveMock.mockImplementation(async ({ input }: { input: string }) => {
      // The plugin receives base64-encoded input bytes; verify and
      // respond with base64-encoded output bytes so the callback can
      // decode them back to a Uint8Array.
      const decoded = Uint8Array.from(atob(input), c => c.charCodeAt(0));
      expect(Array.from(decoded)).toEqual(Array.from(inputBytes));

      let binary = '';
      for (const b of outputBytes) binary += String.fromCharCode(b);
      return { output: btoa(binary), durationMs: 12.5 };
    });

    const cb = buildNativeProverCallback();
    const out = await cb(inputBytes);
    expect(Array.from(out)).toEqual(Array.from(outputBytes));
    expect(proveMock).toHaveBeenCalledTimes(1);
  });

  it('handles large inputs without stack-overflowing String.fromCharCode', async () => {
    // > 125k bytes — the spread/apply pattern would overflow on older
    // engines; the chunked accumulator avoids it. Verify a 200k-byte
    // input round-trips correctly.
    const inputBytes = new Uint8Array(200_000);
    for (let i = 0; i < inputBytes.length; i++) inputBytes[i] = i & 0xff;

    proveMock.mockImplementation(async ({ input }: { input: string }) => {
      // Decode the base64 the plugin received and confirm it matches.
      const decoded = Uint8Array.from(atob(input), c => c.charCodeAt(0));
      expect(decoded.length).toBe(inputBytes.length);
      expect(decoded[0]).toBe(inputBytes[0]);
      expect(decoded[123_456]).toBe(inputBytes[123_456]);
      // Echo a small response.
      return { output: btoa('\x01\x02\x03'), durationMs: 50 };
    });

    const cb = buildNativeProverCallback();
    const out = await cb(inputBytes);
    expect(out).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('propagates native plugin errors to the caller', async () => {
    proveMock.mockRejectedValue(new Error('native prover crashed'));
    const cb = buildNativeProverCallback();
    await expect(cb(new Uint8Array([1, 2, 3]))).rejects.toThrow(/native prover crashed/);
  });

  it('tolerates a missing durationMs in the plugin response', async () => {
    proveMock.mockResolvedValue({ output: btoa('hi') });
    const cb = buildNativeProverCallback();
    const out = await cb(new Uint8Array([1]));
    expect(out).toEqual(new Uint8Array([104, 105]));
  });
});

describe('buildNativeProverCallback / E2E prove-timing instrumentation', () => {
  // Force the MIDEN_E2E_TEST=true branch in `recordProveTiming` so the
  // logger body (console.log + __PROVE_TIMINGS__ push) gets executed at
  // least once. The flag is captured at module-load time, so we must
  // re-import via `jest.isolateModules` after mutating process.env.
  it('pushes prove-timing markers to globalThis.__PROVE_TIMINGS__ under MIDEN_E2E_TEST=true', async () => {
    const prevFlag = process.env.MIDEN_E2E_TEST;
    process.env.MIDEN_E2E_TEST = 'true';
    delete (globalThis as { __PROVE_TIMINGS__?: string[] }).__PROVE_TIMINGS__;

    proveMock.mockReset();
    proveMock.mockResolvedValue({ output: btoa('x'), durationMs: 1 });
    isMobileMock.mockReset();
    isMobileMock.mockReturnValue(true);

    try {
      let cb!: (input: Uint8Array) => Promise<Uint8Array>;
      jest.isolateModules(() => {
        const m = require('./native-prover-mobile');
        cb = m.buildNativeProverCallback();
      });
      await cb(new Uint8Array([1, 2]));

      const markers = (globalThis as { __PROVE_TIMINGS__?: string[] }).__PROVE_TIMINGS__ ?? [];
      // At minimum: "native callback invoked" + "base64 encode" + native-prove returned + base64 decode.
      expect(markers.length).toBeGreaterThanOrEqual(4);
      expect(markers.some(l => /native callback invoked/.test(l))).toBe(true);
    } finally {
      if (prevFlag === undefined) {
        delete process.env.MIDEN_E2E_TEST;
      } else {
        process.env.MIDEN_E2E_TEST = prevFlag;
      }
      delete (globalThis as { __PROVE_TIMINGS__?: string[] }).__PROVE_TIMINGS__;
    }
  });

  it('swallows globalThis.__PROVE_TIMINGS__ push errors silently', async () => {
    // Cover the catch branch in recordProveTiming — verifies the helper
    // doesn't throw when __PROVE_TIMINGS__ is frozen / non-writable
    // (the realistic case: hardened global / sealed worker context).
    const prevFlag = process.env.MIDEN_E2E_TEST;
    process.env.MIDEN_E2E_TEST = 'true';
    Object.defineProperty(globalThis, '__PROVE_TIMINGS__', {
      value: Object.freeze([]),
      writable: false,
      configurable: true
    });

    proveMock.mockReset();
    proveMock.mockResolvedValue({ output: btoa('x'), durationMs: 1 });
    isMobileMock.mockReset();
    isMobileMock.mockReturnValue(true);

    try {
      let cb!: (input: Uint8Array) => Promise<Uint8Array>;
      jest.isolateModules(() => {
        const m = require('./native-prover-mobile');
        cb = m.buildNativeProverCallback();
      });
      // Should not throw despite the frozen __PROVE_TIMINGS__.
      await expect(cb(new Uint8Array([1]))).resolves.toBeInstanceOf(Uint8Array);
    } finally {
      if (prevFlag === undefined) {
        delete process.env.MIDEN_E2E_TEST;
      } else {
        process.env.MIDEN_E2E_TEST = prevFlag;
      }
      // restore to a writable state
      Object.defineProperty(globalThis, '__PROVE_TIMINGS__', {
        value: undefined,
        writable: true,
        configurable: true
      });
      delete (globalThis as { __PROVE_TIMINGS__?: string[] }).__PROVE_TIMINGS__;
    }
  });
});
