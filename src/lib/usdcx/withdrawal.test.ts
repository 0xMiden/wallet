import { encodeBurnWithdrawal, validateUsdcxWithdrawal } from './withdrawal';

const USDCX_FAUCET_ID_BECH32 = 'mtst1native';
jest.mock('lib/miden-chain/native-asset', () => ({ getNativeAssetIdSync: () => 'mtst1native' }));

jest.mock('lib/miden/sdk/helpers', () => ({ sameWalletAccountId: (a: string, b: string) => a === b }));
let network = 'testnet';
jest.mock('lib/miden-chain/effective-endpoints', () => ({ getEffectiveNetworkName: () => network }));

describe('USDCx withdrawal encoding', () => {
  // The miden-usdcx 0.17 layout: word 0 is [domain, 0, 0, 0]; words 1 and 2 are the recipient.
  it('encodes Arc domain 26 in a zero-padded word, then the bytes32 recipient as unsigned little-endian limbs', () => {
    expect(encodeBurnWithdrawal('0x112233445566778899aabbccddeeff0011223344', 26)).toEqual([
      26n,
      0n,
      0n,
      0n,
      0n,
      0n,
      0n,
      0x44332211n,
      0x88776655n,
      0xccbbaa99n,
      0x00ffeeddn,
      0x44332211n
    ]);
  });

  it('does not sign-extend high recipient limbs or the domain', () => {
    expect(encodeBurnWithdrawal(`0x${'ff'.repeat(20)}`, 0xffffffff)).toEqual([
      0xffffffffn,
      0n,
      0n,
      0n,
      0n,
      0n,
      0n,
      0xffffffffn,
      0xffffffffn,
      0xffffffffn,
      0xffffffffn,
      0xffffffffn
    ]);
  });

  it.each([-1, 0x100000000, 1.5, NaN])('rejects invalid domain %s', domain => {
    expect(() => encodeBurnWithdrawal(`0x${'11'.repeat(20)}`, domain)).toThrow('usdcxInvalidDestination');
  });

  it.each(['0x1234', 'mtst1recipient', `0x${'11'.repeat(32)}`, `0x${'zz'.repeat(20)}`])(
    'rejects recipient %s',
    address => {
      expect(() => encodeBurnWithdrawal(address, 0)).toThrow('usdcxInvalidDestination');
    }
  );

  it('requires the configured faucet, testnet, positive amount, and Arc Testnet chain id', () => {
    expect(() => validateUsdcxWithdrawal(USDCX_FAUCET_ID_BECH32, 5042002, 1n)).not.toThrow();
    expect(() => validateUsdcxWithdrawal('another-faucet', 5042002, 1n)).toThrow('usdcxUnsupportedFaucet');
    expect(() => validateUsdcxWithdrawal(USDCX_FAUCET_ID_BECH32, 11155111, 1n)).toThrow('usdcxInvalidDestination');
    expect(() => validateUsdcxWithdrawal(USDCX_FAUCET_ID_BECH32, 0, 1n)).toThrow('usdcxInvalidDestination');
    expect(() => validateUsdcxWithdrawal(USDCX_FAUCET_ID_BECH32, 5042002, 0n)).toThrow('usdcxInvalidAmount');
    network = 'devnet';
    expect(() => validateUsdcxWithdrawal(USDCX_FAUCET_ID_BECH32, 5042002, 1n)).toThrow('usdcxUnsupportedFaucet');
    network = 'testnet';
  });
});
