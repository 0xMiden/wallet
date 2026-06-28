import { FungibleAsset } from '@miden-sdk/miden-sdk/lazy';
import BigNumber from 'bignumber.js';

import { getFaucetIdSetting } from 'lib/miden/assets';
import { fetchFromStorage } from 'lib/miden/front';
import { TokenBalanceData } from 'lib/miden/front/balance';
import { AssetMetadata, DEFAULT_TOKEN_METADATA, fetchTokenMetadata, MIDEN_METADATA } from 'lib/miden/metadata';
import { getBech32AddressFromAccountId } from 'lib/miden/sdk/helpers';
import { getMidenClient } from 'lib/miden/sdk/miden-client';
import { getTokenPrice, type TokenPrices } from 'lib/prices';

import { ALL_TOKENS_BASE_METADATA_STORAGE_KEY, setTokensBaseMetadata } from '../../miden/front/assets';

export interface FetchBalancesOptions {
  /** Callback to update asset metadata in the store */
  setAssetsMetadata?: (metadata: Record<string, AssetMetadata>) => void;
  /** Token prices from Binance API (symbol -> { price, change24h }) */
  tokenPrices?: TokenPrices;
}

type SdkAccount = NonNullable<Awaited<ReturnType<Awaited<ReturnType<typeof getMidenClient>>['getAccount']>>>;

/**
 * E2E-only: parse a Guardian account's on-chain auth structure (signer set +
 * procedure thresholds) with `AccountInspector` — a pure storage read, no
 * signing/load — and stash it on `globalThis.__TEST_GUARDIAN_AUTH_STRUCTURE__`
 * keyed by address, so `__TEST_GUARDIAN_AUTH__` can serve it without any WASM
 * call. No-op for non-multisig accounts. Tree-shaken from production.
 */
async function captureGuardianAuthStructureForTest(address: string, account: SdkAccount): Promise<void> {
  try {
    const { AccountInspector } = await import('@openzeppelin/miden-multisig-client');
    const config = AccountInspector.fromAccount(account);
    if (!config.signerCommitments || config.signerCommitments.length === 0) {
      // eslint-disable-next-line no-console
      console.log('[E2E] captureGuardianAuthStructure: not a multisig account (0 signers), skipping', address);
      return;
    }
    const holder = globalThis as {
      __TEST_GUARDIAN_AUTH_STRUCTURE__?: Record<
        string,
        { threshold: number; signerCommitments: string[]; procedureThresholds: Record<string, number> }
      >;
    };
    holder.__TEST_GUARDIAN_AUTH_STRUCTURE__ = {
      ...(holder.__TEST_GUARDIAN_AUTH_STRUCTURE__ ?? {}),
      [address]: {
        threshold: config.threshold,
        signerCommitments: config.signerCommitments,
        procedureThresholds: Object.fromEntries(config.procedureThresholds)
      }
    };
    // eslint-disable-next-line no-console
    console.log('[E2E] captureGuardianAuthStructure: stashed', address, 'signers=', config.signerCommitments.length);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('[E2E] captureGuardianAuthStructure failed:', e instanceof Error ? e.message : String(e));
  }
}

/**
 * Fetch all token balances for an account
 *
 * This is the single source of truth for balance fetching logic.
 * Used by both the useAllBalances hook and the Zustand store action.
 *
 * `getAccount` is an IndexedDB read on the SDK side; the SDK's internal
 * `_serializeWasmCall` chain already queues it against concurrent WASM ops,
 * so we deliberately do NOT wrap it in the wallet-side `withWasmClientLock`.
 * Stacking our mutex on top of the SDK's queue was causing the Send-flow
 * SelectToken tile to stall behind a long-running `syncState` on testnet,
 * blowing past Playwright's 10s click budget and producing `locator.click`
 * timeouts under stress. Metadata fetching uses RpcClient directly and
 * doesn't need serialization either.
 */
export async function fetchBalances(
  address: string,
  tokenMetadatas: Record<string, AssetMetadata>,
  options: FetchBalancesOptions = {}
): Promise<TokenBalanceData[]> {
  const cachedMetadatas =
    (await fetchFromStorage<Record<string, AssetMetadata>>(ALL_TOKENS_BASE_METADATA_STORAGE_KEY)) || {};
  const { setAssetsMetadata, tokenPrices = {} } = options;
  const balances: TokenBalanceData[] = [];

  // Local copy of metadata that we can add to during this fetch
  const localMetadatas = { ...tokenMetadatas };

  // Get midenFaucetId early so we can use it inside the lock
  const midenFaucetId = await getFaucetIdSetting();

  // `getAccount` is serialized internally by the SDK (`_serializeWasmCall`).
  // We intentionally skip `withWasmClientLock` here so balance reads aren't
  // queued behind long-running writes like `syncState`.
  const midenClient = await getMidenClient();
  const acc = await midenClient.getAccount(address);

  // E2E-only: capture a Guardian account's on-chain auth structure HERE, inside
  // the wallet's own working balance poll (which reliably completes), so the
  // `__TEST_GUARDIAN_AUTH__` test hook can read it as a plain value instead of
  // doing its own blocking-eval WASM read — which on the single-threaded iOS
  // WASM gets starved by other main-thread WASM activity and times out. The
  // structure is immutable, so a slightly-old capture is correct. Best-effort,
  // fire-and-forget; gated on MIDEN_E2E_TEST and tree-shaken from production.
  if (process.env.MIDEN_E2E_TEST === 'true' && acc) {
    // Awaited (not fire-and-forget): tie the capture to this balance fetch so it
    // is stashed before `verify_balance` passes and the auth step reads it — a
    // fire-and-forget capture loses the race against the test on the contended
    // iOS main thread. The `@openzeppelin/...` import is already warm (the
    // guardian flow loaded it), so this adds negligible latency.
    await captureGuardianAuthStructureForTest(address, acc);
  }

  let account: typeof acc | null = null;
  let assets: FungibleAsset[] = [];
  if (acc) {
    account = acc;
    assets = acc.vault().fungibleAssets() as FungibleAsset[];
  }

  // Fetch missing metadata OUTSIDE the lock — RpcClient doesn't use the WASM client
  const fetchedMetadatas: Record<string, AssetMetadata> = { ...cachedMetadatas };

  // Fetch missing metadata for non-MIDEN tokens
  {
    const metadataFetchPromises = assets
      .filter(asset => {
        const assetId = getBech32AddressFromAccountId(asset.faucetId());
        return assetId !== midenFaucetId && !localMetadatas[assetId];
      })
      .map(async asset => {
        const assetId = getBech32AddressFromAccountId(asset.faucetId());
        try {
          const tokenMetadata = await fetchTokenMetadata(assetId);
          fetchedMetadatas[assetId] = tokenMetadata.base;
        } catch (e) {
          console.warn('Failed to fetch metadata for', assetId, e);
          fetchedMetadatas[assetId] = DEFAULT_TOKEN_METADATA;
        }
      });
    await Promise.all(metadataFetchPromises);
  }

  // Handle case where account doesn't exist (outside the lock)
  if (!account) {
    console.warn(`Account not found: ${address}`);
    // Can only fabricate a "0 MIDEN" row once discovery has learned the
    // native asset ID. Until then return [] and let the UI render a skeleton.
    if (!midenFaucetId) return [];
    const midenPrice = getTokenPrice(tokenPrices, 'MIDEN');
    return [
      {
        tokenId: midenFaucetId,
        tokenSlug: 'MIDEN',
        metadata: MIDEN_METADATA,
        fiatPrice: midenPrice.price,
        change24h: midenPrice.change24h,
        balance: 0
      }
    ];
  }

  // Update metadata stores with newly fetched metadata (outside the lock)
  for (const [id, metadata] of Object.entries(fetchedMetadatas)) {
    localMetadatas[id] = metadata;
    await setTokensBaseMetadata({ [id]: metadata });
    setAssetsMetadata?.({ [id]: metadata });
  }

  // Build balance list
  let hasMiden = false;
  for (const asset of assets) {
    const tokenId = getBech32AddressFromAccountId(asset.faucetId());
    const isMiden = tokenId === midenFaucetId;

    if (isMiden) {
      hasMiden = true;
    }

    const tokenMetadata = isMiden ? MIDEN_METADATA : localMetadatas[tokenId];
    if (!tokenMetadata) {
      // Skip assets without metadata (metadata fetch failed)
      continue;
    }

    const balance = new BigNumber(asset.amount().toString()).div(10 ** tokenMetadata.decimals);
    const priceInfo = getTokenPrice(tokenPrices, tokenMetadata.symbol);

    balances.push({
      tokenId,
      tokenSlug: tokenMetadata.symbol,
      metadata: tokenMetadata,
      fiatPrice: priceInfo.price,
      change24h: priceInfo.change24h,
      balance: balance.toNumber()
    });
  }

  // Always include MIDEN token (even if balance is 0) — but only if we
  // actually know what ID the native asset is. Pre-discovery we omit the
  // placeholder row; the UI shows a skeleton until discovery resolves and a
  // re-fetch adds the correct row.
  if (!hasMiden && midenFaucetId) {
    const midenPrice = getTokenPrice(tokenPrices, 'MIDEN');
    balances.push({
      tokenId: midenFaucetId,
      tokenSlug: 'MIDEN',
      metadata: MIDEN_METADATA,
      fiatPrice: midenPrice.price,
      change24h: midenPrice.change24h,
      balance: 0
    });
  }

  return balances;
}
