/**
 * @jest-environment node
 */
import { decodeFunctionData, getAddress, zeroAddress } from 'viem';

import { BRIDGE_ASSET_ABI, buildAgglayerDepositCalls, type AgglayerDepositParams } from './agglayer-deposit';
import { batchDigest, type BatchEnvelope } from './calibur';
import { ERC20_ABI } from './erc20';
import { batchNonceOf } from './relay';
import {
  PROTOTYPE_BUY_ENVELOPE,
  SEPOLIA_AGGLAYER_CONFIG,
  SEPOLIA_CALIBUR_PIN,
  TEST_ERC20,
  TEST_FEE_RECIPIENT,
  TEST_MIDEN_ACCOUNT_HEX
} from './testing';

const BRIDGE = SEPOLIA_AGGLAYER_CONFIG.bridgeAddress;
const DESTINATION = `0x00000000${'0a'.repeat(15)}00`;
const FEE = { recipient: TEST_FEE_RECIPIENT, amount: 5_000n };

const erc20Params: AgglayerDepositParams = {
  token: TEST_ERC20,
  amount: 10n ** 18n,
  midenAccountHex: TEST_MIDEN_ACCOUNT_HEX,
  fee: null
};
const nativeParams: AgglayerDepositParams = { ...erc20Params, token: zeroAddress, amount: 10n ** 16n };

// The envelope of the new golden vectors: the prototype envelope under the relay nonce key, sequence 7.
const RELAY_ENVELOPE: BatchEnvelope = { ...PROTOTYPE_BUY_ENVELOPE, batchNonce: batchNonceOf('agglayer-deposit', 7n) };

function decodeBridge(data: `0x${string}`) {
  const decoded = decodeFunctionData({ abi: BRIDGE_ASSET_ABI, data });
  expect(decoded.functionName).toBe('bridgeAsset');
  return decoded.args;
}

describe('buildAgglayerDepositCalls', () => {
  it('approves then bridges an ERC-20 deposit without a fee', () => {
    const [approve, bridge, ...rest] = buildAgglayerDepositCalls(SEPOLIA_AGGLAYER_CONFIG, erc20Params);
    expect(rest).toEqual([]);
    expect(approve).toMatchObject({ to: TEST_ERC20, value: 0n });
    const decodedApprove = decodeFunctionData({ abi: ERC20_ABI, data: approve?.data ?? '0x' });
    expect(decodedApprove.functionName).toBe('approve');
    expect(decodedApprove.args).toEqual([getAddress(BRIDGE), 10n ** 18n]);
    expect(bridge).toMatchObject({ to: BRIDGE, value: 0n });
    expect(decodeBridge(bridge?.data ?? '0x')).toEqual([
      73,
      getAddress(DESTINATION),
      10n ** 18n,
      getAddress(TEST_ERC20),
      true,
      '0x'
    ]);
  });

  it('pays the ERC-20 fee first, then approves and bridges the amount after the fee', () => {
    const calls = buildAgglayerDepositCalls(SEPOLIA_AGGLAYER_CONFIG, { ...erc20Params, fee: FEE });
    expect(calls).toHaveLength(3);
    const [fee, approve, bridge] = calls;
    expect(fee).toMatchObject({ to: TEST_ERC20, value: 0n });
    const decodedFee = decodeFunctionData({ abi: ERC20_ABI, data: fee?.data ?? '0x' });
    expect(decodedFee.functionName).toBe('transfer');
    expect(decodedFee.args).toEqual([getAddress(TEST_FEE_RECIPIENT), 5_000n]);
    expect(decodeFunctionData({ abi: ERC20_ABI, data: approve?.data ?? '0x' }).functionName).toBe('approve');
    expect(decodeBridge(bridge?.data ?? '0x')[2]).toBe(10n ** 18n);
  });

  it('bridges the native coin as value, with the zero token and no approve', () => {
    const calls = buildAgglayerDepositCalls(SEPOLIA_AGGLAYER_CONFIG, nativeParams);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ to: BRIDGE, value: 10n ** 16n });
    expect(decodeBridge(calls[0]?.data ?? '0x')).toEqual([
      73,
      getAddress(DESTINATION),
      10n ** 16n,
      zeroAddress,
      true,
      '0x'
    ]);
  });

  it('pays a native fee as a plain value transfer before the bridge call', () => {
    const calls = buildAgglayerDepositCalls(SEPOLIA_AGGLAYER_CONFIG, { ...nativeParams, fee: FEE });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ to: TEST_FEE_RECIPIENT, value: 5_000n, data: '0x' });
    expect(calls[1]).toMatchObject({ to: BRIDGE, value: 10n ** 16n });
  });

  it('passes the forceUpdateGlobalExitRoot and network values of the config', () => {
    const config = { ...SEPOLIA_AGGLAYER_CONFIG, midenNetworkId: 5, forceUpdateGlobalExitRoot: false };
    const [, bridge] = buildAgglayerDepositCalls(config, erc20Params);
    const args = decodeBridge(bridge?.data ?? '0x');
    expect(args[0]).toBe(5);
    expect(args[4]).toBe(false);
  });

  it.each([
    ['a zero amount', { ...erc20Params, amount: 0n }, 'deposit amount'],
    ['a negative amount', { ...erc20Params, amount: -1n }, 'deposit amount'],
    ['a short account id', { ...erc20Params, midenAccountHex: '0x1234' }, '15-byte'],
    ['an account id without 0x', { ...erc20Params, midenAccountHex: '0a'.repeat(16) }, '15-byte'],
    ['a zero fee', { ...erc20Params, fee: { ...FEE, amount: 0n } }, 'fee amount'],
    ['a zero fee recipient', { ...nativeParams, fee: { ...FEE, recipient: zeroAddress } }, 'fee recipient']
  ])('refuses %s', (_name, params, message) => {
    expect(() => buildAgglayerDepositCalls(SEPOLIA_AGGLAYER_CONFIG, params)).toThrow(message);
  });
});

describe('agglayer deposit golden digests', () => {
  it('hashes an ERC-20 deposit with a fee', () => {
    const calls = buildAgglayerDepositCalls(SEPOLIA_AGGLAYER_CONFIG, { ...erc20Params, fee: FEE });
    expect(batchDigest(SEPOLIA_CALIBUR_PIN, RELAY_ENVELOPE, calls)).toBe(
      '0x008e71be6cc86533c217f0b7aa33a10e0f5d58d41cc4ef1fcbfb470d6a2456a6'
    );
  });

  it('hashes a native deposit without a fee', () => {
    const calls = buildAgglayerDepositCalls(SEPOLIA_AGGLAYER_CONFIG, nativeParams);
    expect(batchDigest(SEPOLIA_CALIBUR_PIN, RELAY_ENVELOPE, calls)).toBe(
      '0xbc61984b09c7153758e1315c619694b5b1b803a7c3de64ba8d1429e0b62724ca'
    );
  });

  it('hashes a native deposit with a fee', () => {
    const calls = buildAgglayerDepositCalls(SEPOLIA_AGGLAYER_CONFIG, { ...nativeParams, fee: FEE });
    expect(batchDigest(SEPOLIA_CALIBUR_PIN, RELAY_ENVELOPE, calls)).toBe(
      '0xbd42bfa2f7c7fb156949a344e0d42b63c55c7cff1574a9ddfbbf7ba9ddb73b55'
    );
  });
});
