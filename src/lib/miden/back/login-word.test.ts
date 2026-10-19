import { isFieldWord } from './login-word';

function wordBytes(limbs: bigint[]): Uint8Array {
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  limbs.forEach((limb, index) => view.setBigUint64(index * 8, limb, true));
  return bytes;
}

describe('isFieldWord', () => {
  it('accepts four zero elements', () => {
    expect(isFieldWord(new Uint8Array(32))).toBe(true);
  });

  it('accepts every limb at the largest field element', () => {
    expect(
      isFieldWord(wordBytes([0xffffffff00000000n, 0xffffffff00000000n, 0xffffffff00000000n, 0xffffffff00000000n]))
    ).toBe(true);
  });

  it.each([0, 1, 2, 3])('refuses the modulus in limb %i', index => {
    const limbs = [0n, 0n, 0n, 0n];
    limbs[index] = 0xffffffff00000001n;
    expect(isFieldWord(wordBytes(limbs))).toBe(false);
  });

  it('refuses the largest u64', () => {
    expect(isFieldWord(wordBytes([0xffffffffffffffffn, 0n, 0n, 0n]))).toBe(false);
  });

  it.each([31, 33])('refuses %i bytes', length => {
    expect(isFieldWord(new Uint8Array(length))).toBe(false);
  });

  it('reads the modulus bytes in little-endian order', () => {
    const bytes = new Uint8Array(32);
    bytes.set([0x01, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff]);
    expect(isFieldWord(bytes)).toBe(false);
  });

  it('accepts the reversed modulus bytes as 0x01000000ffffffff', () => {
    const bytes = new Uint8Array(32);
    bytes.set([0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x01]);
    expect(isFieldWord(bytes)).toBe(true);
  });
});
