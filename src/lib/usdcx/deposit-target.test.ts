jest.mock('lib/remote-config/runtime', () => ({
  getBridgeConfigSnapshot: () =>
    jest
      .requireActual<typeof import('lib/remote-config/testing/fixture')>('lib/remote-config/testing/fixture')
      .testBridgeSnapshot()
}));

import { usdcxExpectedRemoteTokenFor, usdcxRemoteRecipientFor } from './deposit-target';

// The account and the USDCx faucet Circle named in the captured 0x370bf19a attestation (attestation.vectors.json).
const ACCOUNT_HEX = '0x8da911727d5b53916f2c221c00c091';
const FAUCET_HEX = '0x4cbdcaffe75f0a317482224dae6436';
const ACCOUNT_BECH32 = 'mtst1accountaddress0000000000000';
const FAUCET_BECH32 = 'mtst1faucetaddress00000000000000';

// The SDK parse as the wallet sees it: every form of one account resolves to the same id, and a bech32 address parses
// only without its composite suffix.
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  ...jest.requireActual('@miden-sdk/miden-sdk/lazy'),
  AccountId: { fromHex: (hex: string) => ({ toString: () => hex.toLowerCase() }) },
  Address: {
    fromBech32: (address: string) => {
      const known: Record<string, string> = {
        mtst1accountaddress0000000000000: '0x8da911727d5b53916f2c221c00c091',
        mtst1faucetaddress00000000000000: '0x4cbdcaffe75f0a317482224dae6436'
      };
      const hex = known[address];
      if (hex === undefined) throw new Error(`invalid bech32 address: ${address}`);
      return { accountId: () => ({ toString: () => hex }) };
    }
  }
}));

const ACCOUNT_RECIPIENT = '0x000000000000000000000000000000008da911727d5b53916f2c221c00c09100';
const FAUCET_TOKEN = '0x000000000000000000000000000000004cbdcaffe75f0a317482224dae643600';

describe('usdcxRemoteRecipientFor', () => {
  it.each([
    ['a bare bech32 address', ACCOUNT_BECH32],
    ['a composite wallet id', `${ACCOUNT_BECH32}_qruqqypuyph`],
    ['a hex account id', ACCOUNT_HEX],
    ['an upper-case hex account id', `0x${ACCOUNT_HEX.slice(2).toUpperCase()}`]
  ])('encodes %s as the bytes32 Circle attested', (_label, ref) => {
    expect(usdcxRemoteRecipientFor(ref)).toBe(ACCOUNT_RECIPIENT);
  });

  it('throws for a reference that is no account', () => {
    expect(() => usdcxRemoteRecipientFor('not-an-account')).toThrow('invalid bech32 address');
  });
});

describe('usdcxExpectedRemoteTokenFor', () => {
  it.each([
    ['its bech32 address', FAUCET_BECH32],
    ['its composite id', `${FAUCET_BECH32}_qruqqypuyph`],
    ['its hex id', FAUCET_HEX]
  ])('encodes the native faucet by %s as the remote token Circle names', (_label, ref) => {
    expect(usdcxExpectedRemoteTokenFor(ref)).toBe(FAUCET_TOKEN);
  });
});
