import { TEST_BRIDGE_CONFIG, TEST_BRIDGE_CONFIG_SNAPSHOT } from 'lib/epoch/testing/bridge-config';
import type { BridgeConfigSnapshot } from 'lib/remote-config/runtime';

import { encodeBurnWithdrawal, isUsdcxWithdrawalNetwork, UsdcxBurnError, validateUsdcxWithdrawal } from './withdrawal';

const USDCX_FAUCET_ID_BECH32 = 'mtst1native';
jest.mock('lib/miden-chain/native-asset', () => ({ getNativeAssetIdSync: () => 'mtst1native' }));

jest.mock('lib/miden/sdk/helpers', () => ({ sameWalletAccountId: (a: string, b: string) => a === b }));
// Withdrawals exist where the network's bridge config lists a destination and has the switch on.
let mockBridgeSnapshot: BridgeConfigSnapshot = TEST_BRIDGE_CONFIG_SNAPSHOT;
jest.mock('lib/remote-config/runtime', () =>
  jest
    .requireActual<typeof import('lib/epoch/testing/bridge-config')>('lib/epoch/testing/bridge-config')
    .remoteConfigRuntimeMock(() => mockBridgeSnapshot)
);
afterEach(() => {
  mockBridgeSnapshot = TEST_BRIDGE_CONFIG_SNAPSHOT;
});

const { usdcx: _usdcx, ...configWithoutUsdcx } = TEST_BRIDGE_CONFIG;
/** A network whose document has no usdcx section, as devnet's. */
const NO_USDCX: BridgeConfigSnapshot = { ...TEST_BRIDGE_CONFIG_SNAPSHOT, config: configWithoutUsdcx };
const SWITCHED_OFF: BridgeConfigSnapshot = {
  ...TEST_BRIDGE_CONFIG_SNAPSHOT,
  config: { ...TEST_BRIDGE_CONFIG, features: { ...TEST_BRIDGE_CONFIG.features, usdcxOut: false } }
};

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

  it('requires the configured faucet, a listed destination chain id, a positive amount and the switch', () => {
    // 2 USDCx, since a burn must exceed its destination's payout fee allowance (1.5 USDC on Sepolia).
    expect(() => validateUsdcxWithdrawal(USDCX_FAUCET_ID_BECH32, 5042002, 2_000_000n)).not.toThrow();
    // Sepolia, Base Sepolia and Arbitrum Sepolia are direct-payout destinations of the burn.
    expect(() => validateUsdcxWithdrawal(USDCX_FAUCET_ID_BECH32, 11155111, 2_000_000n)).not.toThrow();
    expect(() => validateUsdcxWithdrawal(USDCX_FAUCET_ID_BECH32, 84532, 2_000_000n)).not.toThrow();
    expect(() => validateUsdcxWithdrawal(USDCX_FAUCET_ID_BECH32, 421614, 2_000_000n)).not.toThrow();
    expect(() => validateUsdcxWithdrawal('another-faucet', 5042002, 1n)).toThrow('usdcxUnsupportedFaucet');
    // A mainnet chain is not a destination of the testnet document.
    expect(() => validateUsdcxWithdrawal(USDCX_FAUCET_ID_BECH32, 1, 1n)).toThrow('usdcxInvalidDestination');
    expect(() => validateUsdcxWithdrawal(USDCX_FAUCET_ID_BECH32, 0, 1n)).toThrow('usdcxInvalidDestination');
    expect(() => validateUsdcxWithdrawal(USDCX_FAUCET_ID_BECH32, 5042002, 0n)).toThrow('usdcxInvalidAmount');
    mockBridgeSnapshot = NO_USDCX;
    expect(() => validateUsdcxWithdrawal(USDCX_FAUCET_ID_BECH32, 5042002, 1n)).toThrow('usdcxUnsupportedFaucet');
    mockBridgeSnapshot = SWITCHED_OFF;
    expect(() => validateUsdcxWithdrawal(USDCX_FAUCET_ID_BECH32, 5042002, 2_000_000n)).toThrow(
      'usdcxUnsupportedFaucet'
    );
  });

  // Circle takes its payout fee from the amount: a flat ~1.0035 USDC on Ethereum, against a 1.5 USDC allowance.
  it('refuses a burn its destination fee allowance takes whole, naming the allowance and the chain', () => {
    expect(() => validateUsdcxWithdrawal(USDCX_FAUCET_ID_BECH32, 11155111, 1_500_001n)).not.toThrow();
    expect(() => validateUsdcxWithdrawal(USDCX_FAUCET_ID_BECH32, 5042002, 100_001n)).not.toThrow();
    let refusal: unknown;
    try {
      validateUsdcxWithdrawal(USDCX_FAUCET_ID_BECH32, 11155111, 1_500_000n);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(UsdcxBurnError);
    expect(refusal).toMatchObject({
      translationKey: 'usdcxSendMoreThanPayoutFee',
      values: { amount: '1.5', network: 'Sepolia' }
    });
    expect(() => validateUsdcxWithdrawal(USDCX_FAUCET_ID_BECH32, 5042002, 100_000n)).toThrow(
      'usdcxSendMoreThanPayoutFee'
    );
  });

  it('offers withdrawals where the document lists a destination and has the switch on, whatever the token', () => {
    expect(isUsdcxWithdrawalNetwork()).toBe(true);
    // The routes have no derived check: a document whose derivation is still out offers them.
    mockBridgeSnapshot = { ...TEST_BRIDGE_CONFIG_SNAPSHOT, derived: null };
    expect(isUsdcxWithdrawalNetwork()).toBe(true);
    mockBridgeSnapshot = NO_USDCX;
    expect(isUsdcxWithdrawalNetwork()).toBe(false);
    mockBridgeSnapshot = SWITCHED_OFF;
    expect(isUsdcxWithdrawalNetwork()).toBe(false);
    mockBridgeSnapshot = { ...TEST_BRIDGE_CONFIG_SNAPSHOT, config: null, derived: null };
    expect(isUsdcxWithdrawalNetwork()).toBe(false);
    mockBridgeSnapshot = { ...TEST_BRIDGE_CONFIG_SNAPSHOT, status: 'loading' };
    expect(isUsdcxWithdrawalNetwork()).toBe(false);
  });
});
