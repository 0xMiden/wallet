/** @jest-environment node */
import { address, getBase64Decoder } from '@solana/kit';
import { AccountState, getTokenEncoder, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';

import { readSolanaUsdcBalance, solanaUsdcAccount } from './solana';

const OWNER = '9fYLFVoVqwH37C3dyPi6cpeobfbQ2jtLpN5HgAYDDdkm';
const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const ATA = '4YnRS2RAFHtVCdeywZiDAkoWwJBaqYxFXe3FZf2Ay7PV';
const mockSend = jest.fn();
const mockAccountInfo = jest.fn(() => ({ send: mockSend }));
jest.mock('@solana/kit', () => ({
  ...jest.requireActual<typeof import('@solana/kit')>('@solana/kit'),
  createSolanaRpc: () => ({ getAccountInfo: mockAccountInfo })
}));

function tokenResponse(state = AccountState.Initialized, mint = MINT, owner = OWNER) {
  const data = getTokenEncoder().encode({
    mint: address(mint),
    owner: address(owner),
    amount: 3_000_000n,
    state,
    delegate: null,
    delegatedAmount: 0n,
    isNative: null,
    closeAuthority: null
  });
  return {
    context: { slot: 123n },
    value: { owner: TOKEN_PROGRAM_ADDRESS, executable: false, data: [getBase64Decoder().decode(data), 'base64'] }
  };
}

beforeEach(() => jest.clearAllMocks());

it('derives a different USDC token account for each network', async () => {
  await expect(solanaUsdcAccount(OWNER, MINT)).resolves.toBe(ATA);
  await expect(solanaUsdcAccount(OWNER, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).resolves.toBe(
    '5DMGH4bkaN4ZYBHrF7DVaNo3bkp5QagP1tfVUjPu7UAY'
  );
});

it('reads the derived account at a finalized slot', async () => {
  mockSend.mockResolvedValueOnce(tokenResponse());
  await expect(readSolanaUsdcBalance('solana-devnet', OWNER, MINT, 1000)).resolves.toEqual({
    balance: '3000000',
    blockNumber: '123'
  });
  expect(mockAccountInfo).toHaveBeenCalledWith(ATA, { encoding: 'base64', commitment: 'finalized' });
});

it('rejects an account that does not exist', async () => {
  mockSend.mockResolvedValueOnce({ context: { slot: 123n }, value: null });
  await expect(readSolanaUsdcBalance('solana-devnet', OWNER, MINT, 1000)).rejects.toThrow('usdcxSolanaAccountMissing');
});

it.each([AccountState.Frozen, AccountState.Uninitialized])('rejects token account state %s', async state => {
  mockSend.mockResolvedValueOnce(tokenResponse(state));
  await expect(readSolanaUsdcBalance('solana-devnet', OWNER, MINT, 1000)).rejects.toThrow(
    'usdcxSolanaAccountUnavailable'
  );
});

it.each([
  [OWNER, OWNER],
  [MINT, MINT]
])('rejects the wrong mint or wallet owner', async (mint, owner) => {
  mockSend.mockResolvedValueOnce(tokenResponse(AccountState.Initialized, mint, owner));
  await expect(readSolanaUsdcBalance('solana-devnet', OWNER, MINT, 1000)).rejects.toThrow('usdcxInvalidDestination');
});

it('rejects the wrong token program', async () => {
  const response = tokenResponse();
  mockSend.mockResolvedValueOnce({ ...response, value: { ...response.value, owner: OWNER } });
  await expect(readSolanaUsdcBalance('solana-devnet', OWNER, MINT, 1000)).rejects.toThrow('usdcxInvalidDestination');
});

it('rejects a mint from the other network without an RPC request', async () => {
  await expect(readSolanaUsdcBalance('solana', OWNER, MINT, 1000)).rejects.toThrow('usdcxInvalidDestination');
  expect(mockAccountInfo).not.toHaveBeenCalled();
});

it('propagates an RPC failure so confirmation can try again', async () => {
  mockSend.mockRejectedValueOnce(new Error('RPC unavailable'));
  await expect(readSolanaUsdcBalance('solana-devnet', OWNER, MINT, 1000)).rejects.toThrow('RPC unavailable');
});
