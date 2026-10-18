import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';

import { deriveLoginKeyScalar, loginKeyDomain, type LoginKeySource } from './derive';

const EVM_A = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const EVM_B = '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const SECP256K1_ORDER = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141';
// The pinned v1 scalars were computed with plain HKDF-SHA256 (RFC 5869). A failing one means every account's login key
// changed on every site, so it is never fixed by updating the value.
const PINNED_SCALAR = '607827d898bffa220a2942a4bc23457f485826ce30694b6bd193d4b6ef6120cd';

const scalarHex = (root: string, source: LoginKeySource, domain: string): string =>
  bytesToHex(deriveLoginKeyScalar(hexToBytes(root), source, domain));

describe('login key derivation', () => {
  it('derives the pinned v1 scalar for an EVM root', () => {
    expect(scalarHex(EVM_A, 'evm', 'example.org')).toBe(PINNED_SCALAR);
  });

  it('gives each domain its own scalar', () => {
    expect(scalarHex(EVM_A, 'evm', 'example.com')).toBe(
      '6242d05d8449dc0f6ea438cf0c8f127390e6fa3927320a675575daceedbe80ff'
    );
  });

  it('gives each root its own scalar', () => {
    expect(scalarHex(EVM_B, 'evm', 'example.org')).toBe(
      'db78b03edcac22ab6005d12304cf939d2166682409c3fff5fac11e5be04a3cee'
    );
  });

  it('separates EVM roots from single-key roots', () => {
    expect(scalarHex(EVM_A, 'auth', 'example.org')).toBe(
      '13e56d3c6b31646c46723c78ae86c4ec7b079a2ce4759d0425104e57f8dbf4f2'
    );
  });

  it('uses the whole host where there is no registrable domain', () => {
    expect(scalarHex(EVM_A, 'evm', 'localhost')).toBe(
      'dfdd85ac20ee8139d9092849f1c4f7263bf5e563961c77fc2bd13d9a1f8cf699'
    );
    expect(loginKeyDomain('http://localhost:5198')).toBe('localhost');
    expect(loginKeyDomain('http://127.0.0.1:5198')).toBe('127.0.0.1');
    expect(loginKeyDomain('http://[::1]:3000')).toBe('[::1]');
  });

  it('shares one key between www and the bare domain', () => {
    expect(loginKeyDomain('https://www.example.org')).toBe('example.org');
    expect(loginKeyDomain('https://example.org:443')).toBe('example.org');
    expect(loginKeyDomain('https://WWW.Example.ORG')).toBe('example.org');
  });

  it('keeps sites on a shared hosting suffix apart', () => {
    expect(loginKeyDomain('https://alpha.github.io')).toBe('alpha.github.io');
    expect(loginKeyDomain('https://beta.github.io')).toBe('beta.github.io');
  });

  it('refuses pages that are not https', () => {
    expect(() => loginKeyDomain('http://example.org')).toThrow('INVALID_PARAMS: login keys need an https page');
    expect(() => loginKeyDomain('http://localhost.example.com')).toThrow(
      'INVALID_PARAMS: login keys need an https page'
    );
    expect(() => loginKeyDomain('null')).toThrow('INVALID_PARAMS: not an origin');
    expect(() => loginKeyDomain('file:///tmp/x')).toThrow('INVALID_PARAMS: login keys need an https page');
    expect(() => loginKeyDomain('chrome-extension://abc')).toThrow('INVALID_PARAMS: login keys need an https page');
  });

  it('allows http on a *.localhost name', () => {
    expect(loginKeyDomain('http://app.localhost:5198')).toBe('app.localhost');
  });

  it('retries past a value outside the curve order', () => {
    const expand = jest
      .fn<Uint8Array, [Uint8Array]>()
      .mockReturnValueOnce(hexToBytes(SECP256K1_ORDER))
      .mockReturnValueOnce(hexToBytes(PINNED_SCALAR));
    const scalar = deriveLoginKeyScalar(hexToBytes(EVM_A), 'evm', 'example.org', expand);
    expect(bytesToHex(scalar)).toBe(PINNED_SCALAR);
    const prefix = Array.from(utf8ToBytes('v1\0evm\0example.org\0'));
    expect(expand.mock.calls.map(([info]) => Array.from(info))).toEqual([
      [...prefix, 0x00],
      [...prefix, 0x01]
    ]);
  });

  it('refuses after 256 values outside the order', () => {
    const expand = jest.fn<Uint8Array, [Uint8Array]>(() => new Uint8Array(32));
    expect(() => deriveLoginKeyScalar(hexToBytes(EVM_A), 'evm', 'example.org', expand)).toThrow(
      'LOGIN_KEY_UNAVAILABLE: no valid login key'
    );
    expect(expand.mock.calls.map(([info]) => info.at(-1))).toEqual(
      Array.from({ length: 256 }, (_, counter) => counter)
    );
  });
});
