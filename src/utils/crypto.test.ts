import { ONE_MB_IN_BYTES, getRandomBytesWithMaxSize } from './crypto';

describe('crypto utils', () => {
  describe('ONE_MB_IN_BYTES', () => {
    it('equals 1 MiB (1024 * 1024) bytes', () => {
      expect(ONE_MB_IN_BYTES).toBe(1024 * 1024);
      expect(ONE_MB_IN_BYTES).toBe(1_048_576);
    });
  });

  describe('getRandomBytesWithMaxSize', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('returns a Uint8Array', () => {
      const result = getRandomBytesWithMaxSize(10);
      expect(result).toBeInstanceOf(Uint8Array);
    });

    it('fills each byte deterministically from Math.random (populated path)', () => {
      const spy = jest.spyOn(Math, 'random');
      // First call sizes the array: floor(0.35 * 10) = 3.
      // Remaining calls produce the individual byte values.
      spy
        .mockReturnValueOnce(0.35) // size = 3
        .mockReturnValueOnce(0) // byte[0] = floor(0 * 256)     = 0
        .mockReturnValueOnce(0.5) // byte[1] = floor(0.5 * 256)   = 128
        .mockReturnValueOnce(0.999); // byte[2] = floor(0.999 * 256) = 255

      const result = getRandomBytesWithMaxSize(10);

      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(3);
      expect(Array.from(result)).toEqual([0, 128, 255]);
      // 1 sizing call + 3 byte-fill calls.
      expect(spy).toHaveBeenCalledTimes(4);
    });

    it('returns an empty array when the computed size is 0 (loop body not entered)', () => {
      const spy = jest.spyOn(Math, 'random').mockReturnValue(0); // size = floor(0 * n) = 0

      const result = getRandomBytesWithMaxSize(10);

      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(0);
      expect(Array.from(result)).toEqual([]);
      // Only the sizing call happens; the fill loop never runs.
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('uses ONE_MB_IN_BYTES as the default max size when no argument is given', () => {
      const spy = jest.spyOn(Math, 'random');
      // Size derives from the default cap; make all fill bytes deterministic.
      spy.mockReturnValueOnce(0.001); // size = floor(0.001 * ONE_MB_IN_BYTES)
      spy.mockReturnValue(0); // every byte = 0

      const result = getRandomBytesWithMaxSize();

      const expectedSize = Math.floor(0.001 * ONE_MB_IN_BYTES);
      expect(expectedSize).toBeGreaterThan(0); // guard: default cap is being applied
      expect(result.length).toBe(expectedSize);
      expect(result.every((b) => b === 0)).toBe(true);
    });

    it('respects an explicit smaller max size argument', () => {
      const spy = jest.spyOn(Math, 'random');
      spy.mockReturnValueOnce(0.99); // size = floor(0.99 * 4) = 3
      spy.mockReturnValue(0.5); // every byte = 128

      const result = getRandomBytesWithMaxSize(4);

      expect(result.length).toBe(3);
      expect(Array.from(result)).toEqual([128, 128, 128]);
    });

    it('produces in-range bytes and a bounded length with real randomness', () => {
      const maxSize = 256;
      const result = getRandomBytesWithMaxSize(maxSize);

      expect(result).toBeInstanceOf(Uint8Array);
      // Math.floor(Math.random() * maxSize) is in [0, maxSize - 1].
      expect(result.length).toBeGreaterThanOrEqual(0);
      expect(result.length).toBeLessThan(maxSize);
      for (const byte of result) {
        expect(byte).toBeGreaterThanOrEqual(0);
        expect(byte).toBeLessThanOrEqual(255);
        expect(Number.isInteger(byte)).toBe(true);
      }
    });
  });
});
