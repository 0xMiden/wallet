import { Address } from '@miden-sdk/miden-sdk/lazy';

import { MIDEN_NETWORK_NAME } from 'lib/miden-chain/constants';

import {
  detectAddressChain,
  isHexAddress,
  isValidEthereumAddress,
  isValidMidenAddress,
  isValidRecipientAddress,
  MidenAddressError
} from './miden';

// The network the validator compares an address against. Jest builds default to
// testnet; a test flips it to mimic a localnet build / dev-settings override.
let mockEffectiveNetwork = MIDEN_NETWORK_NAME.TESTNET;

jest.mock('lib/miden-chain/effective-endpoints', () => ({
  ...jest.requireActual('lib/miden-chain/effective-endpoints'),
  getEffectiveNetworkName: () => mockEffectiveNetwork
}));

afterEach(() => {
  mockEffectiveNetwork = MIDEN_NETWORK_NAME.TESTNET;
});

// Addresses that pass the wasm mock's loose bech32 decode (known HRP, bech32
// charset, plausible length). The effective network defaults to testnet, as
// jest builds do (DEFAULT_NETWORK = testnet).
const TESTNET_ADDRESS = 'mtst1aplqzwh6s4gvcyzsvx726y6xvsgt5qv5qruqqypuyph';
const TESTNET_ADDRESS_WITH_ROUTING = 'mtst1ap2autzy2mgkuqt6hx3qscrkd5hsxefv_qr7qqq9wr6w';
const MAINNET_ADDRESS = 'mm1qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const DEVNET_ADDRESS = 'mdev1qpzry9x8gf2tvdw0s3jn54khce6mua7l';
// A localnet address uses the SDK's 'mlcl' HRP (#599). It must decode and be
// treated as wrong-network on a testnet build, not rejected at the prefix gate.
const LOCALNET_ADDRESS = 'mlcl1qpzry9x8gf2tvdw0s3jn54khce6mua7l';

const reasonOf = (address: string): string => {
  try {
    isValidMidenAddress(address);
    return 'valid';
  } catch (error) {
    if (error instanceof MidenAddressError) return error.reason;
    throw error;
  }
};

describe('Miden and Ethereum address utilities', () => {
  it('accepts a decodable address for the current network, with or without routing params', () => {
    expect(isValidMidenAddress(TESTNET_ADDRESS)).toBe(true);
    expect(isValidMidenAddress(TESTNET_ADDRESS_WITH_ROUTING)).toBe(true);
    expect(isValidMidenAddress(`  ${TESTNET_ADDRESS}  `)).toBe(true);
  });

  it('throws wrong-network for a well-formed address of another Miden network', () => {
    expect(reasonOf(MAINNET_ADDRESS)).toBe('wrong-network');
    expect(reasonOf(DEVNET_ADDRESS)).toBe('wrong-network');
    // Localnet ('mlcl1') is a real, decodable Miden address — wrong-network on a
    // testnet build, NOT 'invalid' at the prefix gate (#599).
    expect(reasonOf(LOCALNET_ADDRESS)).toBe('wrong-network');
  });

  it('throws invalid for addresses that fail the SDK bech32 decode', () => {
    // Known prefix but the decode throws (typo'd / truncated payload).
    expect(reasonOf('mtst1account')).toBe('invalid');
    expect(reasonOf(`mtst1${'a'.repeat(120)}`)).toBe('invalid');
    expect(reasonOf('unknown1account')).toBe('invalid');
  });

  it('throws invalid when the SDK decoder throws', () => {
    (Address.fromBech32 as jest.Mock).mockImplementationOnce(() => {
      throw new Error('checksum mismatch');
    });
    expect(reasonOf(TESTNET_ADDRESS)).toBe('invalid');
  });

  it('treats the localnet prefix as correct-network while the wallet targets localnet', () => {
    // Localnet encodes with the 'mlcl' HRP (getNetworkId -> NetworkId.custom),
    // including under a dev-settings localhost override, so an 'mlcl1…' recipient
    // is the correct-network form there — otherwise the send flow's Confirm
    // button never enables on a localnet network.
    mockEffectiveNetwork = MIDEN_NETWORK_NAME.LOCALNET;
    expect(isValidMidenAddress(LOCALNET_ADDRESS)).toBe(true);
    expect(isValidRecipientAddress(LOCALNET_ADDRESS)).toBe(true);
    expect(reasonOf(TESTNET_ADDRESS)).toBe('wrong-network');
  });

  it('validates complete uniform-case Ethereum addresses after trimming whitespace', () => {
    const address = `0x${'a1'.repeat(20)}`;
    expect(isValidEthereumAddress(`  ${address}  `)).toBe(true);
    expect(isValidEthereumAddress(`0x${'A1'.repeat(20)}`)).toBe(true);
    expect(isValidEthereumAddress('0x1234')).toBe(false);
    expect(isValidEthereumAddress(`0x${'z'.repeat(40)}`)).toBe(false);
  });

  it('requires a valid EIP-55 checksum for mixed-case Ethereum addresses', () => {
    expect(isValidEthereumAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')).toBe(true);
    expect(isValidEthereumAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD')).toBe(false);
  });

  it('routes recipient validity by detected chain without throwing', () => {
    expect(isValidRecipientAddress(TESTNET_ADDRESS)).toBe(true);
    expect(isValidRecipientAddress(`0x${'12'.repeat(20)}`)).toBe(true);
    expect(isValidRecipientAddress(MAINNET_ADDRESS)).toBe(false);
    expect(isValidRecipientAddress('not-an-address')).toBe(false);
  });

  it('detects Ethereum recipients from the hex prefix and defaults to Miden', () => {
    expect(isHexAddress('0xabc')).toBe(true);
    expect(isHexAddress('mtst1abc')).toBe(false);
    expect(detectAddressChain('  0xabc')).toBe('ethereum');
    expect(detectAddressChain('')).toBe('miden');
    expect(detectAddressChain('mtst1abc')).toBe('miden');
  });
});
