import { expect } from '@playwright/test';
import { createPublicClient, http, type Hex } from 'viem';

import { vaultBalanceByFaucetId, walletDiscoveredBaseFee, walletDiscoveredNativeFaucetId } from './balance-truth';
import { feePrecheckProblem, landedVaultSample, UNLANDED_VAULT_SAMPLE } from './mainnet-bridge-plan';
import { mainnetChain, mainnetRpc, type MainnetUsdcxDocument } from './mainnet-bridge-sources';
import { accountHex } from './usdcx-miden';
import type { GuardianAwareWalletPage } from '../fixtures/two-wallets';

const CONFIG_URL = 'https://raw.githubusercontent.com/0xMiden/wallet-config/main/mainnet.json';
export const AGGLAYER_BRIDGE = '0x2a3dd3eb832af982ec71669e178424b10dca2ede';
export const AGGLAYER_INDEXER = 'https://bridge-mainnet-miden.eu-north-3.gateway.fm/api';

/** The nightly's Ethereum key, shared by every EVM chain it bridges on. */
export function mainnetEvmKey(): Hex {
  const raw = (process.env.E2E_MAINNET_EVM_KEY ?? '').trim();
  return raw.startsWith('0x') ? `0x${raw.slice(2)}` : `0x${raw}`;
}

function isFetchTimeout(error: unknown): error is Error {
  return error instanceof Error && error.name === 'TimeoutError';
}

export async function loadMainnetDocument(): Promise<MainnetUsdcxDocument> {
  try {
    const response = await fetch(CONFIG_URL, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`the mainnet config answered ${response.status}`);
    const doc: MainnetUsdcxDocument = await response.json();
    return doc;
  } catch (error) {
    if (!isFetchTimeout(error)) throw error;
    throw new Error('the mainnet config was not read within 15s', { cause: error });
  }
}

export async function readEthereumFunds(address: `0x${string}`): Promise<{ wei: bigint; maxFeePerGas: bigint }> {
  const client = createPublicClient({ chain: mainnetChain(1), transport: http(mainnetRpc(1)) });
  const fees = await client.estimateFeesPerGas();
  return { wei: await client.getBalance({ address }), maxFeePerGas: fees.maxFeePerGas };
}

/**
 * Restore the plain mainnet account and consume its notes before anything reads its vault. The Guardian account is
 * consumed in the round trip, which the main job runs first.
 */
export async function openPlainAccount(
  wallet: GuardianAwareWalletPage
): Promise<{ address: string; accountId: string }> {
  const seed = process.env.E2E_MAINNET_PLAIN_SEED;
  if (!seed) throw new Error('E2E_MAINNET_PLAIN_SEED is unset');
  const imported = await wallet.importOnChainWallet(seed.trim().split(/\s+/));
  const accountId = await accountHex(imported.address);
  await wallet.triggerSync(true);
  await wallet.claimAllNotes(600_000);
  return { address: imported.address, accountId };
}

/**
 * Why the plain account cannot pay two nights of its Miden fees, or undefined when it can. `reserve` turns the
 * discovered base fee into the native base units the caller's loops need.
 */
export async function midenFeeProblem(
  wallet: GuardianAwareWalletPage,
  address: string,
  reserve: (baseFee: bigint) => bigint
): Promise<string | undefined> {
  const baseFee = await walletDiscoveredBaseFee(wallet.page);
  const nativeId = await walletDiscoveredNativeFaucetId(wallet.page);
  if (baseFee === null || baseFee < 1 || !nativeId) return 'the Miden account has not discovered its fee';
  // Same in-flight balance read as the round trip: one refresh can still see the pre-claim vault.
  // A non-land resolves the sentinel so this poll continues.
  const need = reserve(BigInt(baseFee));
  let held: bigint | undefined;
  try {
    await expect
      .poll(
        async () => {
          const sample = await landedVaultSample(
            () => wallet.refreshBalances(),
            () => vaultBalanceByFaucetId(wallet.page, nativeId)
          );
          if (sample !== UNLANDED_VAULT_SAMPLE) held = sample;
          return sample;
        },
        { timeout: 60_000 }
      )
      .toBeGreaterThanOrEqual(need);
    return undefined;
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if ((held !== undefined && held >= need) || (!text.includes('Timeout') && !text.includes('toBeGreaterThanOrEqual'))) {
      throw error;
    }
    return feePrecheckProblem(address, need, held);
  }
}
