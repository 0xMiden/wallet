/**
 * Normalization + deserialization of a pasted hot key.
 *
 * The SDK is mocked (jest maps `@miden-sdk/miden-sdk/lazy` to `wasmMock.js`),
 * so the scheme TAG byte is scripted here — deliberately NOT 0x01 — to prove
 * the code reads the tag off a serialized key rather than assuming the
 * signature tag. The real-SDK round trip (revealHotKey's 64-hex scalar back
 * into a working key) is covered by the guardian-recovery E2E hot-key import
 * spec, which pastes an actually revealed key into a real build.
 */
import { AuthSecretKey } from '@miden-sdk/miden-sdk/lazy';
import { Buffer } from 'buffer';

import {
  deserializeHotSecretKey,
  ecdsaSecretKeyTagHex,
  HOT_KEY_SCALAR_HEX_LEN,
  HOT_KEY_SERIALIZED_HEX_LEN,
  normalizeHotSecretKeyHex
} from './hot-key-import';

const SCALAR_HEX = 'ab'.repeat(32);
const TAG_BYTE = 0x07;

const mockedAuthSecretKey = AuthSecretKey as unknown as jest.Mock & {
  ecdsaWithRNG: jest.Mock;
  deserialize: jest.Mock;
};

beforeEach(() => {
  mockedAuthSecretKey.ecdsaWithRNG = jest.fn(() => ({
    serialize: () => Uint8Array.from([TAG_BYTE, ...Buffer.from(SCALAR_HEX, 'hex')]),
    free: jest.fn()
  }));
  mockedAuthSecretKey.deserialize = jest.fn((bytes: Uint8Array) => ({
    bytes,
    free: jest.fn()
  }));
});

describe('normalizeHotSecretKeyHex', () => {
  it('accepts the 64-hex raw scalar, lowercased and trimmed', () => {
    expect(normalizeHotSecretKeyHex(`  ${SCALAR_HEX.toUpperCase()}  `)).toBe(SCALAR_HEX);
    expect(SCALAR_HEX).toHaveLength(HOT_KEY_SCALAR_HEX_LEN);
  });

  it('accepts the 66-hex serialized form and strips a 0x prefix', () => {
    const serialized = `07${SCALAR_HEX}`;
    expect(serialized).toHaveLength(HOT_KEY_SERIALIZED_HEX_LEN);
    expect(normalizeHotSecretKeyHex(`0x${serialized}`)).toBe(serialized);
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['non-hex characters', 'zz'.repeat(32)],
    ['odd prefix remainder', `0x${'ab'.repeat(31)}a`],
    ['too short', 'ab'.repeat(31)],
    ['between the two accepted lengths', `${'ab'.repeat(32)}a`],
    ['too long', 'ab'.repeat(34)],
    [
      'a 12-word phrase',
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    ]
  ])('rejects %s', (_label, input) => {
    expect(normalizeHotSecretKeyHex(input)).toBeNull();
  });
});

describe('ecdsaSecretKeyTagHex', () => {
  it('reads the tag off a serialized throwaway key and caches it', () => {
    expect(ecdsaSecretKeyTagHex()).toBe('07');
    expect(ecdsaSecretKeyTagHex()).toBe('07');
    // Second call must come from the cache, not a second WASM key build.
    // (The cache is module-scoped, so the count only holds for the first
    // test that populates it — which is why this assertion lives here and
    // the deserialize tests below don't repeat it.)
    expect(mockedAuthSecretKey.ecdsaWithRNG.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

describe('deserializeHotSecretKey', () => {
  it('prepends the probed tag to a 64-hex scalar', () => {
    deserializeHotSecretKey(SCALAR_HEX.toUpperCase());
    const bytes = mockedAuthSecretKey.deserialize.mock.calls[0]![0] as Uint8Array;
    expect(bytes[0]).toBe(TAG_BYTE);
    expect(Buffer.from(bytes.slice(1)).toString('hex')).toBe(SCALAR_HEX);
  });

  it('passes a 66-hex serialized key through unchanged, whatever its tag', () => {
    deserializeHotSecretKey(`0x03${SCALAR_HEX}`);
    const bytes = mockedAuthSecretKey.deserialize.mock.calls[0]![0] as Uint8Array;
    expect(Buffer.from(bytes).toString('hex')).toBe(`03${SCALAR_HEX}`);
  });

  it('throws on input the normalizer rejects, before touching the SDK', () => {
    expect(() => deserializeHotSecretKey('not-a-key')).toThrow();
    expect(mockedAuthSecretKey.deserialize).not.toHaveBeenCalled();
  });
});

describe('the tag probe on a fresh module', () => {
  type ProbeKey = { serialize: jest.Mock; free: jest.Mock };
  type FreshModule = typeof import('./hot-key-import');

  // The tag cache is module-scoped, so each case loads its own copy of the module and of the SDK mock it reads.
  const freshModule = (probe: () => ProbeKey) => {
    let loaded: FreshModule | undefined;
    let sdk: { ecdsaWithRNG: jest.Mock; deserialize: jest.Mock } | undefined;
    jest.isolateModules(() => {
      const { AuthSecretKey: isolated } = require('@miden-sdk/miden-sdk/lazy');
      isolated.ecdsaWithRNG = jest.fn(probe);
      isolated.deserialize = jest.fn((bytes: Uint8Array) => ({ bytes, free: jest.fn() }));
      sdk = isolated;
      loaded = require('./hot-key-import');
    });
    if (!loaded || !sdk) throw new Error('hot-key-import did not load');
    return { module: loaded, sdk };
  };

  const thrownBy = (call: () => unknown): unknown => {
    try {
      call();
    } catch (error) {
      return error;
    }
    throw new Error('expected a throw');
  };

  it('lets a trap from serializing the tag probe reach the caller without freeing it', () => {
    const trap = new WebAssembly.RuntimeError('unreachable');
    const free = jest.fn(() => {
      throw new Error('freed after the trap');
    });
    const { module, sdk } = freshModule(() => ({
      serialize: jest.fn(() => {
        throw trap;
      }),
      free
    }));

    expect(thrownBy(() => module.deserializeHotSecretKey(SCALAR_HEX))).toBe(trap);
    expect(free).not.toHaveBeenCalled();
    expect(sdk.deserialize).not.toHaveBeenCalled();
    expect(thrownBy(() => module.deserializeHotSecretKey(SCALAR_HEX))).toBe(trap);
    expect(sdk.ecdsaWithRNG).toHaveBeenCalledTimes(2);
  });

  it('lets a trap from freeing the tag probe reach the caller without caching the tag', () => {
    const trap = new WebAssembly.RuntimeError('unreachable');
    const { module, sdk } = freshModule(() => ({
      serialize: jest.fn(() => Uint8Array.from([TAG_BYTE])),
      free: jest.fn(() => {
        throw trap;
      })
    }));

    expect(thrownBy(() => module.deserializeHotSecretKey(SCALAR_HEX))).toBe(trap);
    expect(sdk.deserialize).not.toHaveBeenCalled();
    expect(thrownBy(() => module.deserializeHotSecretKey(SCALAR_HEX))).toBe(trap);
    expect(sdk.ecdsaWithRNG).toHaveBeenCalledTimes(2);
  });

  it('lets a killed free of the tag probe reach the caller', () => {
    const { WasmClientPoisonedError } = require('../sdk/wasm-client-poison');
    const poison = new WasmClientPoisonedError('watchdog', new Error('evicted'));
    const { module, sdk } = freshModule(() => ({
      serialize: jest.fn(() => Uint8Array.from([TAG_BYTE])),
      free: jest.fn(() => {
        throw poison;
      })
    }));

    expect(thrownBy(() => module.ecdsaSecretKeyTagHex())).toBe(poison);
    expect(thrownBy(() => module.ecdsaSecretKeyTagHex())).toBe(poison);
    expect(sdk.ecdsaWithRNG).toHaveBeenCalledTimes(2);
  });

  it('still caches the tag when freeing the probe fails with an ordinary error', () => {
    const { module, sdk } = freshModule(() => ({
      serialize: jest.fn(() => Uint8Array.from([TAG_BYTE])),
      free: jest.fn(() => {
        throw new Error('already freed');
      })
    }));

    module.deserializeHotSecretKey(SCALAR_HEX);
    expect(sdk.deserialize).toHaveBeenCalledTimes(1);
    expect((sdk.deserialize.mock.calls[0]![0] as Uint8Array)[0]).toBe(TAG_BYTE);
    expect(module.ecdsaSecretKeyTagHex()).toBe('07');
    expect(sdk.ecdsaWithRNG).toHaveBeenCalledTimes(1);
  });

  it('frees the probe and probes again after an ordinary serialize failure', () => {
    const failure = new Error('bad serialize');
    const free = jest.fn();
    const { module, sdk } = freshModule(() => ({
      serialize: jest.fn(() => {
        throw failure;
      }),
      free
    }));

    expect(thrownBy(() => module.deserializeHotSecretKey(SCALAR_HEX))).toBe(failure);
    expect(free).toHaveBeenCalledTimes(1);
    expect(sdk.deserialize).not.toHaveBeenCalled();
    expect(thrownBy(() => module.ecdsaSecretKeyTagHex())).toBe(failure);
    expect(sdk.ecdsaWithRNG).toHaveBeenCalledTimes(2);
  });

  it('does not probe for a 66-hex serialized key', () => {
    const { module, sdk } = freshModule(() => ({ serialize: jest.fn(), free: jest.fn() }));

    module.deserializeHotSecretKey(`03${SCALAR_HEX}`);
    expect(sdk.ecdsaWithRNG).not.toHaveBeenCalled();
  });
});
