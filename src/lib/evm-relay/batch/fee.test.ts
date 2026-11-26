/**
 * @jest-environment node
 */
import { encodeFunctionData, erc20Abi, zeroAddress } from 'viem';

import { buildFeeCall, isNativeToken, readFeeCall } from './fee';
import { TEST_ERC20, TEST_FEE_RECIPIENT, TEST_TARGET } from './testing';

describe('relay fee call', () => {
  it('pays an ERC-20 fee with a transfer on the token', () => {
    const call = buildFeeCall({ token: TEST_ERC20, recipient: TEST_FEE_RECIPIENT, amount: 250n });
    expect(call).toEqual({
      to: TEST_ERC20,
      value: 0n,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [TEST_FEE_RECIPIENT, 250n] })
    });
  });

  it('pays a native fee with a plain transfer to the recipient', () => {
    expect(buildFeeCall({ token: zeroAddress, recipient: TEST_FEE_RECIPIENT, amount: 9n })).toEqual({
      to: TEST_FEE_RECIPIENT,
      value: 9n,
      data: '0x'
    });
  });

  it('refuses a fee of zero and a zero recipient', () => {
    expect(() => buildFeeCall({ token: TEST_ERC20, recipient: TEST_FEE_RECIPIENT, amount: 0n })).toThrow(
      'The fee amount must be above 0'
    );
    expect(() => buildFeeCall({ token: TEST_ERC20, recipient: zeroAddress, amount: 1n })).toThrow(
      'The fee recipient must not be the zero address'
    );
  });

  it('reads back the fee of each call it builds', () => {
    const erc20Fee = { token: TEST_ERC20, recipient: TEST_FEE_RECIPIENT, amount: 250n };
    const nativeFee = { token: zeroAddress, recipient: TEST_FEE_RECIPIENT, amount: 9n };
    expect(readFeeCall(buildFeeCall(erc20Fee))).toEqual({ ...erc20Fee, recipient: expect.any(String) });
    expect(readFeeCall(buildFeeCall(erc20Fee))?.recipient.toLowerCase()).toBe(TEST_FEE_RECIPIENT);
    expect(readFeeCall(buildFeeCall(nativeFee))).toEqual(nativeFee);
  });

  it('reads no fee from a call of another shape', () => {
    const approve = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [TEST_TARGET, 5n] });
    const transfer = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [TEST_FEE_RECIPIENT, 5n] });
    expect(readFeeCall({ to: TEST_ERC20, value: 0n, data: approve })).toBeNull();
    expect(readFeeCall({ to: TEST_ERC20, value: 1n, data: transfer })).toBeNull();
    expect(readFeeCall({ to: TEST_TARGET, value: 0n, data: '0x' })).toBeNull();
    expect(readFeeCall({ to: TEST_TARGET, value: 0n, data: '0xdeadbeef' })).toBeNull();
  });

  it('names the native coin by the zero address', () => {
    expect(isNativeToken(zeroAddress)).toBe(true);
    expect(isNativeToken(TEST_ERC20)).toBe(false);
  });
});
