import { FungibleAsset } from '@miden-sdk/miden-sdk/lazy';
import BigNumber from 'bignumber.js';

import { getFaucetIdSetting } from 'lib/miden/assets';
import { fetchFromStorage } from 'lib/miden/front';
import { TokenBalanceData } from 'lib/miden/front/balance';
import { getGuardianCommitmentFromAccount } from 'lib/miden/guardian/account';
import { AssetMetadata, DEFAULT_TOKEN_METADATA, fetchTokenMetadata, MIDEN_METADATA } from 'lib/miden/metadata';
import { getBech32AddressFromAccountId } from 'lib/miden/sdk/helpers';
import { getMidenClient, tryWithWasmClientLock } from 'lib/miden/sdk/miden-client';
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
 *
 * Also stashes the active guardian-operator commitment via
 * `getGuardianCommitmentFromAccount` — a SEPARATE storage slot
 * (`GUARDIAN_SLOT_NAMES.PUBLIC_KEY`) from the multisig `signerCommitments`
 * (`[hot, cold]`) that `AccountInspector` reads. A guardian switch changes
 * this commitment while the signer set / `update_guardian` threshold stay
 * put, so verifying a switch requires this field, not `signerCommitments`.
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
        {
          threshold: number;
          signerCommitments: string[];
          procedureThresholds: Record<string, number>;
          guardianCommitment?: string;
        }
      >;
    };
    holder.__TEST_GUARDIAN_AUTH_STRUCTURE__ = {
      ...(holder.__TEST_GUARDIAN_AUTH_STRUCTURE__ ?? {}),
      [address]: {
        threshold: config.threshold,
        signerCommitments: config.signerCommitments,
        procedureThresholds: Object.fromEntries(config.procedureThresholds),
        guardianCommitment: getGuardianCommitmentFromAccount(account)
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
 * The `getAccount` WASM read runs under a NON-BLOCKING attempt on the wallet
 * WASM mutex (`tryWithWasmClientLock`): it must not stall behind long writes
 * like `syncState` (stacking a blocking mutex on top of the SDK's queue used to
 * hang the Send-flow SelectToken tile past Playwright's 10s click budget), but
 * it also must not run un-serialized while a transaction holds the lock — during
 * a transaction's `_withInnerWebClient` window the SDK runs an un-locked read
 * inline and double-borrows the WASM RefCell, trapping the client. If the lock
 * is busy this returns `null` (skip this refresh; the caller keeps its prior
 * balances and retries next cycle). Metadata fetching uses RpcClient directly
 * and doesn't touch the WASM client, so it stays outside the lock.
 */
export async function fetchBalances(
  address: string,
  tokenMetadatas: Record<string, AssetMetadata>,
  options: FetchBalancesOptions = {}
): Promise<TokenBalanceData[] | null> {
  const cachedMetadatas =
    (await fetchFromStorage<Record<string, AssetMetadata>>(ALL_TOKENS_BASE_METADATA_STORAGE_KEY)) || {};
  const { setAssetsMetadata, tokenPrices = {} } = options;
  const balances: TokenBalanceData[] = [];

  // Local copy of metadata that we can add to during this fetch
  const localMetadatas = { ...tokenMetadatas };

  // Get midenFaucetId early so we can use it inside the lock
  const midenFaucetId = await getFaucetIdSetting();

  // Read the account under a NON-BLOCKING attempt on the wallet WASM mutex.
  // `getAccount` borrows the WebClient's single RefCell; while a transaction is
  // mid-`_withInnerWebClient` (or a `syncState` runs) an un-locked read would
  // run inline / double-borrow and trap the client. Acquiring the lock around
  // the read closes that window; the non-blocking try means we skip (not queue)
  // when the lock is busy, so we never stall behind long writes.
  const read = await tryWithWasmClientLock(async () => {
    const midenClient = await getMidenClient();
    const acc = await midenClient.getAccount(address);

    // E2E-only: capture a Guardian account's on-chain auth structure while we
    // already hold the account, so `__TEST_GUARDIAN_AUTH__` can read it as a
    // plain value instead of its own blocking-eval WASM read (which gets starved
    // on the single-threaded iOS main thread). The structure is immutable, so a
    // slightly-old capture is correct. Gated on MIDEN_E2E_TEST, tree-shaken from
    // production.
    if (process.env.MIDEN_E2E_TEST === 'true' && acc) {
      await captureGuardianAuthStructureForTest(address, acc);
    }

    // `fungibleAssets()` is on the Account object (not the shared WebClient
    // RefCell); extract it here so the rest of the fn works off plain values.
    const acctAssets = acc ? (acc.vault().fungibleAssets() as FungibleAsset[]) : [];
    return { account: (acc ?? null) as typeof acc | null, assets: acctAssets };
  });

  if (!read.ran) {
    // A `withWasmClientLock` op (a transaction or sync) holds the client — skip
    // this refresh so we neither stall behind it nor race its inner window.
    return null;
  }
  const { account, assets } = read.value;

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
