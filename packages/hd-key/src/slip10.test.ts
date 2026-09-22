/**
 * SLIP-0010 conformance. The vectors are the official ed25519 test vectors
 * 1 and 2 from https://github.com/satoshilabs/slips/blob/master/slip-0010.md,
 * run with the standard `ed25519 seed` label. The wallet never uses that
 * label; the vectors prove the algorithm, `miden.test.ts` freezes the labels.
 */
import {
  HARDENED_OFFSET,
  deriveHardenedChild,
  deriveHardenedPath,
  masterKeyFromSeed,
  parseHardenedPath
} from './slip10';

const ED25519_LABEL = 'ed25519 seed';

const hexToBytes = (hex: string): Uint8Array => {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
};

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

interface Vector {
  path: string;
  chainCode: string;
  secret: string;
}

const VECTOR_1_SEED = '000102030405060708090a0b0c0d0e0f';
const VECTOR_1: Vector[] = [
  {
    path: 'm',
    chainCode: '90046a93de5380a72b5e45010748567d5ea02bbf6522f979e05c0d8d8ca9fffb',
    secret: '2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7'
  },
  {
    path: "m/0'",
    chainCode: '8b59aa11380b624e81507a27fedda59fea6d0b779a778918a2fd3590e16e9c69',
    secret: '68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3'
  },
  {
    path: "m/0'/1'",
    chainCode: 'a320425f77d1b5c2505a6b1b27382b37368ee640e3557c315416801243552f14',
    secret: 'b1d0bad404bf35da785a64ca1ac54b2617211d2777696fbffaf208f746ae84f2'
  },
  {
    path: "m/0'/1'/2'",
    chainCode: '2e69929e00b5ab250f49c3fb1c12f252de4fed2c1db88387094a0f8c4c9ccd6c',
    secret: '92a5b23c0b8a99e37d07df3fb9966917f5d06e02ddbd909c7e184371463e9fc9'
  },
  {
    path: "m/0'/1'/2'/2'",
    chainCode: '8f6d87f93d750e0efccda017d662a1b31a266e4a6f5993b15f5c1f07f74dd5cc',
    secret: '30d1dc7e5fc04c31219ab25a27ae00b50f6fd66622f6e9c913253d6511d1e662'
  },
  {
    path: "m/0'/1'/2'/2'/1000000000'",
    chainCode: '68789923a0cac2cd5a29172a475fe9e0fb14cd6adb5ad98a3fa70333e7afa230',
    secret: '8f94d394a8e8fd6b1bc2f3f49f5c47e385281d5c17e65324b0f62483e37e8793'
  }
];

const VECTOR_2_SEED =
  'fffcf9f6f3f0edeae7e4e1dedbd8d5d2cfccc9c6c3c0bdbab7b4b1aeaba8a5a29f9c999693908d8a8784817e7b7875726f6c696663605d5a5754514e4b484542';
const VECTOR_2: Vector[] = [
  {
    path: 'm',
    chainCode: 'ef70a74db9c3a5af931b5fe73ed8e1a53464133654fd55e7a66f8570b8e33c3b',
    secret: '171cb88b1b3c1db25add599712e36245d75bc65a1a5c9e18d76f9f2b1eab4012'
  },
  {
    path: "m/0'",
    chainCode: '0b78a3226f915c082bf118f83618a618ab6dec793752624cbeb622acb562862d',
    secret: '1559eb2bbec5790b0c65d8693e4d0875b1747f4970ae8b650486ed7470845635'
  },
  {
    path: "m/0'/2147483647'",
    chainCode: '138f0b2551bcafeca6ff2aa88ba8ed0ed8de070841f0c4ef0165df8181eaad7f',
    secret: 'ea4f5bfe8694d8bb74b7b59404632fd5968b774ed545e810de9c32a4fb4192f4'
  },
  {
    path: "m/0'/2147483647'/1'",
    chainCode: '73bd9fff1cfbde33a1b846c27085f711c0fe2d66fd32e139d3ebc28e5a4a6b90',
    secret: '3757c7577170179c7868353ada796c839135b3d30554bbb74a4b1e4a5a58505c'
  },
  {
    path: "m/0'/2147483647'/1'/2147483646'",
    chainCode: '0902fe8a29f9140480a00ef244bd183e8a13288e4412d8389d140aac1794825a',
    secret: '5837736c89570de861ebc173b1086da4f505d4adb387c6a1b1342d5e4ac9ec72'
  },
  {
    path: "m/0'/2147483647'/1'/2147483646'/2'",
    chainCode: '5d70af781f3a37b829f0d060924d5e960bdc02e85423494afc0b1a41bbe196d4',
    secret: '551d333177df541ad876a60ea71f00447931c0a9da16f227c11ea080d7391b8d'
  }
];

describe.each([
  ['vector 1', VECTOR_1_SEED, VECTOR_1],
  ['vector 2', VECTOR_2_SEED, VECTOR_2]
])('SLIP-0010 ed25519 test %s', (_name, seedHex, vectors) => {
  it.each(vectors)('derives $path', ({ path, chainCode, secret }) => {
    const node = deriveHardenedPath(hexToBytes(seedHex), ED25519_LABEL, path);
    expect(bytesToHex(node.secret)).toBe(secret);
    expect(bytesToHex(node.chainCode)).toBe(chainCode);
  });

  it('derives the same leaf one child at a time', () => {
    const last = vectors[vectors.length - 1]!;
    let node = masterKeyFromSeed(hexToBytes(seedHex), ED25519_LABEL);
    for (const index of parseHardenedPath(last.path)) {
      node = deriveHardenedChild(node, index);
    }
    expect(bytesToHex(node.secret)).toBe(last.secret);
  });
});

describe('masterKeyFromSeed', () => {
  it('rejects a seed shorter than 16 bytes or longer than 64 bytes', () => {
    expect(() => masterKeyFromSeed(new Uint8Array(15), ED25519_LABEL)).toThrow('between 16 and 64 bytes');
    expect(() => masterKeyFromSeed(new Uint8Array(65), ED25519_LABEL)).toThrow('between 16 and 64 bytes');
    expect(() => masterKeyFromSeed(new Uint8Array(16), ED25519_LABEL)).not.toThrow();
    expect(() => masterKeyFromSeed(new Uint8Array(64), ED25519_LABEL)).not.toThrow();
  });

  it('rejects an empty label', () => {
    expect(() => masterKeyFromSeed(new Uint8Array(32), '')).toThrow('label must not be empty');
  });

  it('uses the label as the HMAC key, so two labels give disjoint trees', () => {
    const seed = hexToBytes(VECTOR_1_SEED);
    const a = masterKeyFromSeed(seed, ED25519_LABEL);
    const b = masterKeyFromSeed(seed, 'miden seed');
    expect(bytesToHex(a.secret)).not.toBe(bytesToHex(b.secret));
    expect(bytesToHex(a.chainCode)).not.toBe(bytesToHex(b.chainCode));
  });

  it('returns 32-byte frozen output and accepts an all-zero seed', () => {
    const node = masterKeyFromSeed(new Uint8Array(32), ED25519_LABEL);
    expect(node.secret).toHaveLength(32);
    expect(node.chainCode).toHaveLength(32);
    expect(Object.isFrozen(node)).toBe(true);
  });
});

describe('deriveHardenedChild', () => {
  const parent = masterKeyFromSeed(hexToBytes(VECTOR_1_SEED), ED25519_LABEL);

  it.each([-1, 1.5, HARDENED_OFFSET, Number.NaN, Number.MAX_SAFE_INTEGER + 1])('rejects index %p', index => {
    expect(() => deriveHardenedChild(parent, index)).toThrow('Invalid index');
  });

  it('accepts the highest hardened index', () => {
    expect(() => deriveHardenedChild(parent, HARDENED_OFFSET - 1)).not.toThrow();
  });

  it('rejects a parent with a secret or chain code of the wrong length', () => {
    expect(() => deriveHardenedChild({ secret: new Uint8Array(31), chainCode: parent.chainCode }, 0)).toThrow(
      'secret must be 32 bytes'
    );
    expect(() => deriveHardenedChild({ secret: parent.secret, chainCode: new Uint8Array(33) }, 0)).toThrow(
      'chain code must be 32 bytes'
    );
  });

  it('does not change the parent', () => {
    const before = bytesToHex(parent.secret) + bytesToHex(parent.chainCode);
    deriveHardenedChild(parent, 7);
    expect(bytesToHex(parent.secret) + bytesToHex(parent.chainCode)).toBe(before);
  });
});

describe('parseHardenedPath', () => {
  it('parses hardened segments and the bare master path', () => {
    expect(parseHardenedPath("m/44'/0'/2'/5'")).toEqual([44, 0, 2, 5]);
    expect(parseHardenedPath('m')).toEqual([]);
  });

  it.each(["m/44'/0", "m/44/0'", "44'/0'", "m/-1'", "m/44'/", "m//0'", "m/0x1'", ''])('rejects %p', path => {
    expect(() => parseHardenedPath(path)).toThrow('Invalid derivation path');
  });

  it('rejects a leading zero', () => {
    expect(() => parseHardenedPath("m/0012'")).toThrow('leading zero');
    expect(parseHardenedPath("m/0'")).toEqual([0]);
  });

  it('rejects an index at or above the hardened offset', () => {
    expect(() => parseHardenedPath(`m/${HARDENED_OFFSET}'`)).toThrow(`below ${HARDENED_OFFSET}`);
    expect(() => parseHardenedPath("m/99999999999999999999'")).toThrow(`below ${HARDENED_OFFSET}`);
    expect(parseHardenedPath(`m/${HARDENED_OFFSET - 1}'`)).toEqual([HARDENED_OFFSET - 1]);
  });
});

describe('deriveHardenedPath', () => {
  it('returns the master key for the bare path', () => {
    const seed = hexToBytes(VECTOR_1_SEED);
    expect(bytesToHex(deriveHardenedPath(seed, ED25519_LABEL, 'm').secret)).toBe(VECTOR_1[0]!.secret);
  });

  it('does not change the seed', () => {
    const seed = hexToBytes(VECTOR_1_SEED);
    deriveHardenedPath(seed, ED25519_LABEL, "m/0'/1'");
    expect(bytesToHex(seed)).toBe(VECTOR_1_SEED);
  });
});
