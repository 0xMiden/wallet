/**
 * `resolveBuildTimeFeeAuth` — the fee conversion info a request must be BUILT with.
 *
 * This module makes no SDK calls of its own: it reads two chain parameters, converts the
 * faucet id, and delegates the commitment to the guardian package. So the fakes below stand
 * in for collaborators whose behaviour is asserted elsewhere, and this file asserts only the
 * module's own decisions — which branch it takes, and what it hands the resolver.
 *
 * The bech32-to-hex conversion is the one that has bitten: `getNativeAssetId` returns bech32,
 * `resolveAuthArg` parses hex, and passing the former straight through typechecks and then
 * throws at runtime. `passes the faucet id to the resolver as hex` is the guard for that.
 */
import { resolveAuthArg } from '@openzeppelin/miden-multisig-client';

import { resolveBuildTimeFeeAuth } from './guardian-fee-auth';
import { getNativeAssetId, getVerificationBaseFee } from '../../miden-chain/native-asset';

jest.mock('../../miden-chain/native-asset', () => ({
  getNativeAssetId: jest.fn(),
  getVerificationBaseFee: jest.fn()
}));

jest.mock('@openzeppelin/miden-multisig-client', () => ({
  resolveAuthArg: jest.fn(() => ({ authArg: { tag: 'commitment' }, adviceMap: { tag: 'preimage' } }))
}));

jest.mock('../sdk/helpers', () => ({
  // Mirrors the real helper's contract: takes any account ref, re-emits HEX.
  accountRefToSdk: jest.fn((ref: string) => ({ toString: () => `0xhex(${ref})` })),
  randomFeeSalt: jest.fn(() => ({ tag: 'salt' }))
}));

const mockFee = getVerificationBaseFee as jest.MockedFunction<typeof getVerificationBaseFee>;
const mockFaucet = getNativeAssetId as jest.MockedFunction<typeof getNativeAssetId>;
const mockResolve = resolveAuthArg as jest.MockedFunction<typeof resolveAuthArg>;

describe('resolveBuildTimeFeeAuth', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFaucet.mockResolvedValue('mtst1qqfaucet');
  });

  it('returns nothing on a chain that charges no fee', async () => {
    mockFee.mockResolvedValue(0);
    await expect(resolveBuildTimeFeeAuth()).resolves.toBeUndefined();
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('still attaches when the fee is not yet discovered, so a cold start fails open', async () => {
    // `null` is "unknown", NOT zero. The commitment is inert on a zero-fee chain but
    // load-bearing on a charging one, so the unknown case must attach.
    mockFee.mockResolvedValue(null);
    await expect(resolveBuildTimeFeeAuth()).resolves.toEqual({
      authArg: { tag: 'commitment' },
      adviceMap: { tag: 'preimage' }
    });
  });

  it('passes the faucet id to the resolver as hex, not the bech32 it was read as', async () => {
    mockFee.mockResolvedValue(10000);
    await resolveBuildTimeFeeAuth();
    expect(mockResolve).toHaveBeenCalledWith({ tag: 'salt' }, '0xhex(mtst1qqfaucet)');
  });

  it('degrades to no fee auth when the chain reads fail, rather than failing the transaction', async () => {
    mockFee.mockRejectedValue(new Error('rpc blip'));
    await expect(resolveBuildTimeFeeAuth()).resolves.toBeUndefined();
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('degrades the same way when the faucet lookup is the read that fails', async () => {
    mockFee.mockResolvedValue(10000);
    mockFaucet.mockRejectedValue(new Error('rpc blip'));
    await expect(resolveBuildTimeFeeAuth()).resolves.toBeUndefined();
  });
});
