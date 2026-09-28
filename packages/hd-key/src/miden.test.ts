/**
 * Golden vectors for the Miden account seed derivation.
 *
 * These literals are the load-bearing part: the derivation decides which keys,
 * and so which accounts, a seed phrase recovers. The `legacy` vectors are the
 * output of the `@demox-labs/aleo-hd-key` implementation the wallet shipped
 * with, copied from `src/lib/miden/sdk/derive-seed.test.ts`. The `v1` vectors
 * were generated once when the scheme was introduced. Do not recompute either
 * set from the code under test.
 *
 * This package does not import the SDK. Thus these vectors pin the seed only.
 * The keys the SDK makes from each seed are pinned in the wallet test
 * `src/lib/miden/sdk/derive-seed.keys.test.ts`.
 */
import {
  LEGACY_SEED_LABEL,
  MIDEN_COIN_TYPE,
  MIDEN_SEED_LABEL,
  MidenDerivationSpec,
  deriveMidenAccountSeed,
  midenDerivationPath,
  seedLabel
} from './miden';
import { mnemonicToSeed } from './mnemonic';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

/** `legacy` vectors keyed by walletTypeIndex, indices 0..2. */
const LEGACY_GOLDEN: Record<number, string[]> = {
  0: [
    '7303bce3fd710072aec3c0b0564f061d3771c3c10a2e023cacdedcf5d2ce6b72',
    '7932bbdd42852773ef2642e5cc65e0e19e577e433be7e9247b8ee881dfb24190',
    '48be5f28eb6461028a215f96bf880a82d8b3caa89a9c9c94197e392795f782e7'
  ],
  1: [
    '835fe3da130bac3825f5d0c9526ac400c54f9a5df8f7e9c38219b02cefc1a162',
    'd8f603ff4fdaedc4ab26fb9ce5b9012a232d7a546f90ab7d956ba3ba5d3c20eb',
    '0a4bbcdce48cd0191f21426989ba2ebba133527d859f24ba24c5b5a8fb6bfb34'
  ],
  2: [
    '355dc73d10996cfff18a140266c04b4768b27b14483b876b81c7087b4317df72',
    'ed319149e2f07ad5fd1543a8620ab3e99aa2e8a2d5cfe668ed16d6d5fc232f2d',
    '145d6c1cfc1674a9b7a841fc20eaeb621b4e6b7fbbe676c9292deccc981d166c'
  ]
};

/** `v1` vectors keyed by `${walletTypeIndex}/${authSchemeIndex}`, indices 0..2. */
const V1_GOLDEN: Record<string, string[]> = {
  '0/0': [
    '1239acb7ed4df4a96dfc775b2ee92e62563306630f442525fd41d573d765ee1f',
    'b1161c79d867c24078c3d030b954c19f4fbf4783cdb5d771e183dbdafd13b2ef',
    '5b02d2351d0d9dffe8f0e0318819f2cbab436b9e7c3cb1e5dbe6253ede82f85e'
  ],
  '0/1': [
    '694ff992013be7c9f1c8ac4ed266f549df45acc0d9c0abe803a6ef0f22f78464',
    '5f1f786df8890fe402c774a0664548cb4ae165c4349f8bb8752f0b9347d090f2',
    '9b3dad5f070d955d8591bfd1552f62b44701df255b0ecb4b3f048b9aa78c4386'
  ],
  '1/0': [
    '8f054bbfa485f9a3dc0ec67c519ddc32b821307d002cbb98c8d1d641cd369bad',
    'e720d1c819ff9aef0c55223bc1abb933e8e11d53efaad4951fd43c3805a05571',
    '1f34f6ffd05e9a6829d4020a97607365e8cd623c9b6051f451d8661f0a7dceb2'
  ],
  '1/1': [
    '993e527f5d6ce32d946044453acf5ce41d237eb04b240dd67c9798cd46a92b16',
    '830dfd9d27bdd02e3ef226ce7888704a2835eddf4a0426961666cfad71ece201',
    '59b9a15317e7403fc8f3bee42ccf661e198b0a38c5f8b5688c06ab6e8ecd7c27'
  ],
  '2/0': [
    'ebdaafb9e74ef7dd6212741ba5939828bd37f8681e0375473412c15c11e487c9',
    'bc6b9330af2edd8ef27ff109f8531a867ccf535b7df57c25aee28c91c5f4f627',
    'fd251a2ecd2b91e4375eb542160e5844a6d94c82a053ee82c5b3ca1127312e16'
  ],
  '2/1': [
    'a8ecedd7d91f0355bfa4f914044e00b1395c77db738e91ba7b6d897322ec383c',
    '4f4417ddefb3febba6034534000a4c74f04ef49bd1d90b9abe54fdfaef739f19',
    '0685ade2112882a42e9d63a57f7bc6c49c345280e136f53aacecc5f6ec6cf7c5'
  ]
};

describe('labels and constants', () => {
  it('freezes the literal labels and the coin type', () => {
    expect(LEGACY_SEED_LABEL).toBe('bls12_377 seed');
    expect(MIDEN_SEED_LABEL).toBe('miden seed');
    expect(MIDEN_COIN_TYPE).toBe(5063758);
    expect(seedLabel('legacy')).toBe('bls12_377 seed');
    expect(seedLabel('v1')).toBe('miden seed');
  });
});

describe('midenDerivationPath', () => {
  it('builds the legacy path without a scheme level', () => {
    expect(
      midenDerivationPath({ keyDerivation: 'legacy', walletTypeIndex: 2, authSchemeIndex: 1, accountIndex: 0 })
    ).toBe("m/44'/0'/2'/0'");
    expect(
      midenDerivationPath({ keyDerivation: 'legacy', walletTypeIndex: 0, authSchemeIndex: 0, accountIndex: 5 })
    ).toBe("m/44'/0'/0'/5'");
  });

  it('builds the v1 path with the Miden coin type and the scheme level', () => {
    expect(midenDerivationPath({ keyDerivation: 'v1', walletTypeIndex: 2, authSchemeIndex: 1, accountIndex: 0 })).toBe(
      "m/44'/5063758'/2'/1'/0'"
    );
    expect(midenDerivationPath({ keyDerivation: 'v1', walletTypeIndex: 0, authSchemeIndex: 0, accountIndex: 5 })).toBe(
      "m/44'/5063758'/0'/0'/5'"
    );
  });
});

describe('deriveMidenAccountSeed', () => {
  const masterSeed = mnemonicToSeed(MNEMONIC);

  it('produces a 64-byte master seed from the mnemonic', () => {
    expect(masterSeed).toHaveLength(64);
  });

  describe.each([0, 1, 2])('legacy, walletTypeIndex %i', walletTypeIndex => {
    it.each([0, 1, 2])('matches the pre-package output at index %i', accountIndex => {
      const seed = deriveMidenAccountSeed(masterSeed, {
        keyDerivation: 'legacy',
        walletTypeIndex,
        authSchemeIndex: 1,
        accountIndex
      });
      expect(seed).toHaveLength(32);
      expect(bytesToHex(seed)).toBe(LEGACY_GOLDEN[walletTypeIndex]![accountIndex]);
    });
  });

  it('ignores the auth scheme under legacy', () => {
    const spec: Omit<MidenDerivationSpec, 'authSchemeIndex'> = {
      keyDerivation: 'legacy',
      walletTypeIndex: 0,
      accountIndex: 0
    };
    expect(deriveMidenAccountSeed(masterSeed, { ...spec, authSchemeIndex: 0 })).toEqual(
      deriveMidenAccountSeed(masterSeed, { ...spec, authSchemeIndex: 1 })
    );
  });

  describe.each([0, 1, 2])('v1, walletTypeIndex %i', walletTypeIndex => {
    describe.each([0, 1])('authSchemeIndex %i', authSchemeIndex => {
      it.each([0, 1, 2])('matches the frozen vector at index %i', accountIndex => {
        const seed = deriveMidenAccountSeed(masterSeed, {
          keyDerivation: 'v1',
          walletTypeIndex,
          authSchemeIndex,
          accountIndex
        });
        expect(seed).toHaveLength(32);
        expect(bytesToHex(seed)).toBe(V1_GOLDEN[`${walletTypeIndex}/${authSchemeIndex}`]![accountIndex]);
      });
    });
  });

  it('separates falcon and ecdsa seeds at the same index under v1', () => {
    const spec: Omit<MidenDerivationSpec, 'authSchemeIndex'> = {
      keyDerivation: 'v1',
      walletTypeIndex: 0,
      accountIndex: 0
    };
    expect(deriveMidenAccountSeed(masterSeed, { ...spec, authSchemeIndex: 0 })).not.toEqual(
      deriveMidenAccountSeed(masterSeed, { ...spec, authSchemeIndex: 1 })
    );
  });

  it('rejects a negative account index', () => {
    expect(() =>
      deriveMidenAccountSeed(masterSeed, {
        keyDerivation: 'v1',
        walletTypeIndex: 0,
        authSchemeIndex: 1,
        accountIndex: -1
      })
    ).toThrow('Invalid derivation path');
    expect(() =>
      deriveMidenAccountSeed(masterSeed, {
        keyDerivation: 'legacy',
        walletTypeIndex: 0,
        authSchemeIndex: 1,
        accountIndex: -1
      })
    ).toThrow('Invalid derivation path');
  });
});
