import { address, createSolanaRpc, getBase64Encoder } from '@solana/kit';
import { AccountState, findAssociatedTokenPda, getTokenDecoder, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';

import { getSolanaNetwork } from 'lib/chain/solana';
import type { SolanaNetworkId } from 'lib/chain/types';

import { UsdcxBurnError } from './errors';

/** Derive the USDC token account from the wallet address without changing its case. */
export async function solanaUsdcAccount(owner: string, mint: string): Promise<string> {
  const [account] = await findAssociatedTokenPda({
    owner: address(owner.trim()),
    mint: address(mint),
    tokenProgram: TOKEN_PROGRAM_ADDRESS
  });
  return account;
}

/** Read and check the token account at one finalized slot before the Miden burn. */
export async function readSolanaUsdcBalance(
  networkId: SolanaNetworkId,
  owner: string,
  mint: string,
  timeoutMs: number
): Promise<{ balance: string; blockNumber: string }> {
  const network = getSolanaNetwork(networkId);
  if (!network || mint !== network.usdcMint) throw new UsdcxBurnError('usdcxInvalidDestination');
  const account = await solanaUsdcAccount(owner, mint);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, timeoutMs));
  try {
    const response = await createSolanaRpc(network.rpcUrl)
      .getAccountInfo(address(account), { encoding: 'base64', commitment: 'finalized' })
      .send({ abortSignal: controller.signal });
    const value = response.value;
    if (!value) throw new UsdcxBurnError('usdcxSolanaAccountMissing');
    if (value.owner !== TOKEN_PROGRAM_ADDRESS || value.executable) {
      throw new UsdcxBurnError('usdcxInvalidDestination');
    }
    const data = getBase64Encoder().encode(value.data[0]);
    const token = getTokenDecoder().decode(data);
    if (data.length !== 165 || token.mint !== mint || token.owner !== owner.trim()) {
      throw new UsdcxBurnError('usdcxInvalidDestination');
    }
    if (token.state !== AccountState.Initialized) throw new UsdcxBurnError('usdcxSolanaAccountUnavailable');
    return { balance: token.amount.toString(), blockNumber: response.context.slot.toString() };
  } finally {
    clearTimeout(timer);
  }
}
