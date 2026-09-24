/**
 * Regression gate for the HD derivation lifted out of `lib/miden/back/vault.ts`
 * so the guardian auto-detect probe can reuse it (issue #418), and for the
 * `legacy` / `v1` scheme split (issue #918).
 *
 * These vectors are the load-bearing part: the derivation decides which keys —
 * and therefore which accounts — a seed phrase recovers. Changing any byte here
 * silently orphans every existing wallet, so the `legacy` expectations are
 * pinned to the literal output of the pre-refactor `@demox-labs/aleo-hd-key`
 * implementation for the BIP-39 test mnemonic, and the `v1` expectations to
 * the output frozen when that scheme shipped. Neither set is recomputed from
 * the code under test. The same literals live in `packages/hd-key`.
 *
 * `@miden/hd-key` is mocked as a pass-through so the memoization in
 * `makeSeedDeriver` can be asserted; every value it returns is the real one.
 */
import { mnemonicToSeed } from '@miden/hd-key';
import type { AuthScheme, KeyDerivation } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

import {
  ClientSeedSpec,
  authSchemeIndex,
  deriveClientSeed,
  getMainDerivationPath,
  makeColdSeedDeriver,
  makeSeedDeriver,
  walletTypeIndex
} from './derive-seed';

jest.mock('@miden/hd-key', () => {
  const actual = jest.requireActual<typeof import('@miden/hd-key')>('@miden/hd-key');
  return { ...actual, mnemonicToSeed: jest.fn(actual.mnemonicToSeed) };
});

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

const spec = (
  keyDerivation: KeyDerivation,
  walletType: WalletType,
  hdIndex: number,
  authScheme: AuthScheme = 'ecdsa'
): ClientSeedSpec => ({ keyDerivation, walletType, authScheme, hdIndex });

/** Legacy golden vectors: `deriveClientSeed` under `legacy` as hex, indices 0..2. */
const LEGACY_GOLDEN: [WalletType, string[]][] = [
  [
    WalletType.OnChain,
    [
      '7303bce3fd710072aec3c0b0564f061d3771c3c10a2e023cacdedcf5d2ce6b72',
      '7932bbdd42852773ef2642e5cc65e0e19e577e433be7e9247b8ee881dfb24190',
      '48be5f28eb6461028a215f96bf880a82d8b3caa89a9c9c94197e392795f782e7'
    ]
  ],
  [
    WalletType.OffChain,
    [
      '835fe3da130bac3825f5d0c9526ac400c54f9a5df8f7e9c38219b02cefc1a162',
      'd8f603ff4fdaedc4ab26fb9ce5b9012a232d7a546f90ab7d956ba3ba5d3c20eb',
      '0a4bbcdce48cd0191f21426989ba2ebba133527d859f24ba24c5b5a8fb6bfb34'
    ]
  ],
  [
    WalletType.Guardian,
    [
      '355dc73d10996cfff18a140266c04b4768b27b14483b876b81c7087b4317df72',
      'ed319149e2f07ad5fd1543a8620ab3e99aa2e8a2d5cfe668ed16d6d5fc232f2d',
      '145d6c1cfc1674a9b7a841fc20eaeb621b4e6b7fbbe676c9292deccc981d166c'
    ]
  ]
];

/** v1 golden vectors: `deriveClientSeed` under `v1` as hex, indices 0..2, per auth scheme. */
const V1_GOLDEN: [WalletType, AuthScheme, string[]][] = [
  [
    WalletType.OnChain,
    'falcon',
    [
      '1239acb7ed4df4a96dfc775b2ee92e62563306630f442525fd41d573d765ee1f',
      'b1161c79d867c24078c3d030b954c19f4fbf4783cdb5d771e183dbdafd13b2ef',
      '5b02d2351d0d9dffe8f0e0318819f2cbab436b9e7c3cb1e5dbe6253ede82f85e'
    ]
  ],
  [
    WalletType.OnChain,
    'ecdsa',
    [
      '694ff992013be7c9f1c8ac4ed266f549df45acc0d9c0abe803a6ef0f22f78464',
      '5f1f786df8890fe402c774a0664548cb4ae165c4349f8bb8752f0b9347d090f2',
      '9b3dad5f070d955d8591bfd1552f62b44701df255b0ecb4b3f048b9aa78c4386'
    ]
  ],
  [
    WalletType.OffChain,
    'falcon',
    [
      '8f054bbfa485f9a3dc0ec67c519ddc32b821307d002cbb98c8d1d641cd369bad',
      'e720d1c819ff9aef0c55223bc1abb933e8e11d53efaad4951fd43c3805a05571',
      '1f34f6ffd05e9a6829d4020a97607365e8cd623c9b6051f451d8661f0a7dceb2'
    ]
  ],
  [
    WalletType.OffChain,
    'ecdsa',
    [
      '993e527f5d6ce32d946044453acf5ce41d237eb04b240dd67c9798cd46a92b16',
      '830dfd9d27bdd02e3ef226ce7888704a2835eddf4a0426961666cfad71ece201',
      '59b9a15317e7403fc8f3bee42ccf661e198b0a38c5f8b5688c06ab6e8ecd7c27'
    ]
  ],
  [
    WalletType.Guardian,
    'falcon',
    [
      'ebdaafb9e74ef7dd6212741ba5939828bd37f8681e0375473412c15c11e487c9',
      'bc6b9330af2edd8ef27ff109f8531a867ccf535b7df57c25aee28c91c5f4f627',
      'fd251a2ecd2b91e4375eb542160e5844a6d94c82a053ee82c5b3ca1127312e16'
    ]
  ],
  [
    WalletType.Guardian,
    'ecdsa',
    [
      'a8ecedd7d91f0355bfa4f914044e00b1395c77db738e91ba7b6d897322ec383c',
      '4f4417ddefb3febba6034534000a4c74f04ef49bd1d90b9abe54fdfaef739f19',
      '0685ade2112882a42e9d63a57f7bc6c49c345280e136f53aacecc5f6ec6cf7c5'
    ]
  ]
];

const legacyGoldenFor = (walletType: WalletType): string[] => LEGACY_GOLDEN.find(([type]) => type === walletType)![1];
const v1GoldenFor = (walletType: WalletType, authScheme: AuthScheme): string[] =>
  V1_GOLDEN.find(([type, scheme]) => type === walletType && scheme === authScheme)![2];

/**
 * Launder a raw string into an enum position without a type assertion, so the
 * "unknown value" guards stay reachable from a test even though the typed API
 * can never produce that value.
 */
const asRuntimeValue = <T>(raw: string): T => JSON.parse(JSON.stringify(raw));

beforeEach(() => {
  jest.mocked(mnemonicToSeed).mockClear();
});

describe('walletTypeIndex', () => {
  it('namespaces each wallet type to its own BIP-44 account branch', () => {
    expect(walletTypeIndex(WalletType.OnChain)).toBe(0);
    expect(walletTypeIndex(WalletType.OffChain)).toBe(1);
    expect(walletTypeIndex(WalletType.Guardian)).toBe(2);
  });

  it('throws on an unknown wallet type rather than silently deriving branch 0', () => {
    expect(() => walletTypeIndex(asRuntimeValue<WalletType>('not-a-wallet-type'))).toThrow('Invalid wallet type');
  });
});

describe('authSchemeIndex', () => {
  it('gives each auth scheme its own v1 path level', () => {
    expect(authSchemeIndex('falcon')).toBe(0);
    expect(authSchemeIndex('ecdsa')).toBe(1);
  });

  it('throws on an unknown auth scheme rather than silently deriving level 0', () => {
    expect(() => authSchemeIndex(asRuntimeValue<AuthScheme>('rsa'))).toThrow('Invalid auth scheme');
  });
});

describe('getMainDerivationPath', () => {
  it('builds the legacy hardened BIP-44 path namespaced by wallet type only', () => {
    expect(getMainDerivationPath(spec('legacy', WalletType.Guardian, 0))).toBe("m/44'/0'/2'/0'");
    expect(getMainDerivationPath(spec('legacy', WalletType.OnChain, 5, 'falcon'))).toBe("m/44'/0'/0'/5'");
  });

  it('builds the v1 path with the Miden coin type and the auth-scheme level', () => {
    expect(getMainDerivationPath(spec('v1', WalletType.Guardian, 0))).toBe("m/44'/5063758'/2'/1'/0'");
    expect(getMainDerivationPath(spec('v1', WalletType.OnChain, 5, 'falcon'))).toBe("m/44'/5063758'/0'/0'/5'");
  });
});

describe('deriveClientSeed', () => {
  it.each(LEGACY_GOLDEN)('matches the pre-refactor legacy golden vectors for %s', (walletType, expectedPerIndex) => {
    expectedPerIndex.forEach((expected, hdIndex) => {
      expect(toHex(deriveClientSeed(MNEMONIC, spec('legacy', walletType, hdIndex)))).toBe(expected);
    });
  });

  it('ignores the auth scheme under legacy, because that scheme has no scheme level', () => {
    expect(toHex(deriveClientSeed(MNEMONIC, spec('legacy', WalletType.OnChain, 0, 'falcon')))).toBe(
      legacyGoldenFor(WalletType.OnChain)[0]
    );
  });

  it.each(V1_GOLDEN)('matches the frozen v1 golden vectors for %s %s', (walletType, authScheme, expectedPerIndex) => {
    expectedPerIndex.forEach((expected, hdIndex) => {
      expect(toHex(deriveClientSeed(MNEMONIC, spec('v1', walletType, hdIndex, authScheme)))).toBe(expected);
    });
  });

  it('returns 32 bytes', () => {
    expect(deriveClientSeed(MNEMONIC, spec('legacy', WalletType.Guardian, 0))).toHaveLength(32);
    expect(deriveClientSeed(MNEMONIC, spec('v1', WalletType.Guardian, 0))).toHaveLength(32);
  });

  it('refuses a negative HD index instead of deriving a key for an imported account', () => {
    expect(() => deriveClientSeed(MNEMONIC, spec('legacy', WalletType.OnChain, -1))).toThrow('Invalid derivation path');
    expect(() => deriveClientSeed(MNEMONIC, spec('v1', WalletType.OnChain, -1))).toThrow('Invalid derivation path');
  });
});

describe('makeSeedDeriver', () => {
  it('is byte-identical to deriveClientSeed across specs', () => {
    const derive = makeSeedDeriver(MNEMONIC);
    for (let hdIndex = 0; hdIndex < 3; hdIndex++) {
      expect(toHex(derive(spec('legacy', WalletType.OnChain, hdIndex)))).toBe(
        legacyGoldenFor(WalletType.OnChain)[hdIndex]
      );
      expect(toHex(derive(spec('v1', WalletType.OnChain, hdIndex)))).toBe(
        v1GoldenFor(WalletType.OnChain, 'ecdsa')[hdIndex]
      );
    }
  });

  it('pays the PBKDF2 cost once across schemes and indices, and only on first use', () => {
    const derive = makeSeedDeriver(MNEMONIC);
    expect(jest.mocked(mnemonicToSeed)).not.toHaveBeenCalled();

    derive(spec('v1', WalletType.OnChain, 0));
    derive(spec('legacy', WalletType.OnChain, 0));
    derive(spec('v1', WalletType.Guardian, 7, 'falcon'));

    expect(jest.mocked(mnemonicToSeed)).toHaveBeenCalledTimes(1);
  });
});

describe('makeColdSeedDeriver', () => {
  it('is byte-identical to the ecdsa deriveClientSeed under both schemes', () => {
    const derive = makeColdSeedDeriver(MNEMONIC);
    for (let hdIndex = 0; hdIndex < 3; hdIndex++) {
      expect(toHex(derive(hdIndex, 'legacy'))).toBe(legacyGoldenFor(WalletType.Guardian)[hdIndex]);
      expect(toHex(derive(hdIndex, 'v1'))).toBe(v1GoldenFor(WalletType.Guardian, 'ecdsa')[hdIndex]);
    }
  });

  it('defaults to the Guardian branch and honours an explicit wallet type', () => {
    expect(toHex(makeColdSeedDeriver(MNEMONIC)(0, 'legacy'))).toBe(legacyGoldenFor(WalletType.Guardian)[0]);
    expect(toHex(makeColdSeedDeriver(MNEMONIC, WalletType.OnChain)(0, 'legacy'))).toBe(
      legacyGoldenFor(WalletType.OnChain)[0]
    );
  });

  it('pays the PBKDF2 cost once, not once per index or scheme', () => {
    const derive = makeColdSeedDeriver(MNEMONIC);
    derive(0, 'v1');
    derive(1, 'v1');
    derive(0, 'legacy');
    expect(jest.mocked(mnemonicToSeed)).toHaveBeenCalledTimes(1);
  });
});
