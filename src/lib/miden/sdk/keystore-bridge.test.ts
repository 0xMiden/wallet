import {
  callGetKey,
  callInsertKey,
  callSign,
  resetBridgeStateForTests,
  setActiveInsertKey,
  setActiveSignCallback
} from './keystore-bridge';

describe('keystore-bridge', () => {
  beforeEach(() => {
    resetBridgeStateForTests();
  });

  describe('setActiveInsertKey + callInsertKey', () => {
    it('throws when no callback is wired', async () => {
      await expect(callInsertKey(new Uint8Array([1]), new Uint8Array([2]))).rejects.toThrow(
        'insert-key callback not wired'
      );
    });

    it('forwards to the wired callback', async () => {
      const recorded: Array<{ key: Uint8Array; secret: Uint8Array }> = [];
      setActiveInsertKey(async (key, secret) => {
        recorded.push({ key, secret });
      });

      const k = new Uint8Array([1, 2, 3]);
      const s = new Uint8Array([4, 5, 6]);
      await callInsertKey(k, s);

      expect(recorded).toHaveLength(1);
      expect(Array.from(recorded[0]!.key)).toEqual([1, 2, 3]);
      expect(Array.from(recorded[0]!.secret)).toEqual([4, 5, 6]);
    });

    it('overwrites the previous callback (no concurrent-set guard)', async () => {
      let invoked: 'first' | 'second' | null = null;
      setActiveInsertKey(async () => {
        invoked = 'first';
      });
      setActiveInsertKey(async () => {
        invoked = 'second';
      });

      await callInsertKey(new Uint8Array(), new Uint8Array());
      expect(invoked).toBe('second');
    });

    it('clears via null', async () => {
      setActiveInsertKey(async () => {});
      setActiveInsertKey(null);

      await expect(callInsertKey(new Uint8Array(), new Uint8Array())).rejects.toThrow('insert-key callback not wired');
    });
  });

  describe('setActiveSignCallback + callSign', () => {
    it('throws when no callback is wired', async () => {
      await expect(callSign(new Uint8Array([1]), new Uint8Array([2]))).rejects.toThrow('no active sign session');
    });

    it('forwards to the wired callback', async () => {
      setActiveSignCallback(async (_pk, inputs) => {
        const out = new Uint8Array(inputs.length);
        out.set(inputs);
        return out;
      });

      const result = await callSign(new Uint8Array([0]), new Uint8Array([7, 8]));
      expect(Array.from(result)).toEqual([7, 8]);
    });

    it('truth table — (cb, current=null) sets, OK', () => {
      expect(() => setActiveSignCallback(async () => new Uint8Array())).not.toThrow();
    });

    it('truth table — (null, current=cb) clears, OK', () => {
      setActiveSignCallback(async () => new Uint8Array());
      expect(() => setActiveSignCallback(null)).not.toThrow();
    });

    it('truth table — (null, current=null) no-op, OK', () => {
      expect(() => setActiveSignCallback(null)).not.toThrow();
    });

    it('truth table — (cb1, current=cb2) THROWS (concurrent sign session)', () => {
      setActiveSignCallback(async () => new Uint8Array());
      expect(() => setActiveSignCallback(async () => new Uint8Array())).toThrow('concurrent sign session');
    });
  });

  describe('callGetKey', () => {
    it('always returns null (wallet uses internal storage; SDK falls through)', async () => {
      await expect(callGetKey(new Uint8Array([1, 2, 3]))).resolves.toBeNull();
    });
  });

  describe('resetBridgeStateForTests', () => {
    it('clears both slots', async () => {
      setActiveInsertKey(async () => {});
      setActiveSignCallback(async () => new Uint8Array());

      resetBridgeStateForTests();

      await expect(callInsertKey(new Uint8Array(), new Uint8Array())).rejects.toThrow();
      await expect(callSign(new Uint8Array(), new Uint8Array())).rejects.toThrow();
    });
  });
});
