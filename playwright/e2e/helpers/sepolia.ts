import { createPublicClient, http, type PublicClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

/**
 * Sepolia-side reader for the bridge E2E suite.
 *
 * The Miden->EVM "Fast" (Epoch) route is solver-fulfilled: the wallet only mints
 * a Miden P2IDE note and the hosted Epoch solver delivers USDC to the destination
 * on Sepolia. The wallet signs nothing on EVM, so the test needs NO funded EVM key
 * and NO gas — just a read-only public client to a fresh destination address to
 * prove the USDC actually arrived (i.e. that real bridging happened, end to end).
 *
 * The output token is the Epoch route's fixed Sepolia USDC (mock ERC20, 18 dp) —
 * kept in sync with `src/lib/epoch/bridgeable-token.ts`.
 */
export const SEPOLIA_USDC_ADDRESS = '0x2BB4FfD7E2c6D432b697554Efd77fA13bdbefd69' as const;

/** Public Sepolia RPC; overridable so CI can pin a higher-rate-limit endpoint. */
const SEPOLIA_RPC_URL = process.env.E2E_SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com';

const ERC20_BALANCE_OF_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }]
  }
] as const;

/** A read-only Sepolia client (HTTP transport, no account). */
export function sepoliaPublicClient(): PublicClient {
  return createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC_URL) });
}

/**
 * A fresh, never-before-used EVM address to receive the bridged USDC. Only the
 * address is used (as the destination); the private key is discarded — bridge-out
 * never signs on EVM, so the recipient needs no key, gas, or prior state.
 */
export function newEvmDestination(): `0x${string}` {
  return privateKeyToAccount(generatePrivateKey()).address;
}

/** The destination's Sepolia USDC balance in base units (18 dp). */
export async function usdcBalanceOf(client: PublicClient, address: `0x${string}`): Promise<bigint> {
  return client.readContract({
    address: SEPOLIA_USDC_ADDRESS,
    abi: ERC20_BALANCE_OF_ABI,
    functionName: 'balanceOf',
    args: [address]
  });
}

/**
 * Poll until the destination's Sepolia USDC balance rises above `from` — the
 * on-chain proof that the Epoch solver settled the bridge on the destination
 * chain. Returns the credited balance; throws on timeout.
 */
export async function waitForUsdcAbove(
  client: PublicClient,
  address: `0x${string}`,
  from: bigint,
  timeoutMs: number,
  intervalMs = 5_000
): Promise<bigint> {
  const deadline = Date.now() + timeoutMs;
  let last = from;
  for (;;) {
    last = await usdcBalanceOf(client, address).catch(() => last);
    if (last > from) return last;
    if (Date.now() > deadline) {
      throw new Error(
        `Sepolia USDC for ${address} did not rise above ${from.toString()} within ${timeoutMs}ms (last=${last.toString()}). ` +
          `The Epoch solver never settled the destination leg.`
      );
    }
    await new Promise(res => setTimeout(res, intervalMs));
  }
}
