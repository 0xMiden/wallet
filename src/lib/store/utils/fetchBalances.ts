import { FungibleAsset } from '@miden-sdk/miden-sdk/lazy';
import BigNumber from 'bignumber.js';

import { getFaucetIdSetting } from 'lib/miden/assets';
import { midenClientProxy } from 'lib/miden/back/miden-client-proxy';
import { fetchFromStorage } from 'lib/miden/front';
import { TokenBalanceData } from 'lib/miden/front/balance';
import { getGuardianCommitmentFromAccount } from 'lib/miden/guardian/account';
import { AssetMetadata, DEFAULT_TOKEN_METADATA, fetchTokenMetadata, MIDEN_METADATA } from 'lib/miden/metadata';
import { hasKnownScale } from 'lib/miden/metadata/scale';
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

const UNRESOLVED_RETRY_BASE_MS = 30_000;
const UNRESOLVED_RETRY_MAX_MS = 15 * 60_000;

/**
 * Faucets whose metadata could not be resolved, and the earliest time to try
 * them again.
 *
 * Two bad options meet here. Persisting the placeholder answers the question
 * forever with a guess — the skip filter below never asks again, so the wrong
 * decimals outlive whatever caused the failure. Not persisting it re-asks on
 * every refresh, and balances refresh every few seconds, so a faucet that
 * simply cannot be read turns into a permanent RPC drip.
 *
 * So neither is stored: the record stays absent, and the retry is spaced out
 * here instead. A faucet that resolves later still heals, and one that never
 * will costs a request every quarter of an hour rather than every five seconds.
 * Module-scoped because it is a rate limit, not state — losing it on reload
 * only means one more attempt.
 */
const unresolvedFaucets = new Map<string, { attempts: number; nextAttemptAt: number }>();

function shouldRetryUnresolved(assetId: string, now: number): boolean {
  const seen = unresolvedFaucets.get(assetId);
  return seen === undefined || now >= seen.nextAttemptAt;
}

function recordUnresolved(assetId: string, now: number): void {
  const attempts = (unresolvedFaucets.get(assetId)?.attempts ?? 0) + 1;
  const backoff = Math.min(UNRESOLVED_RETRY_BASE_MS * 2 ** (attempts - 1), UNRESOLVED_RETRY_MAX_MS);
  unresolvedFaucets.set(assetId, { attempts, nextAttemptAt: now + backoff });
}

/** Exported for tests: the backoff is process-wide and would otherwise leak between cases. */
export function __resetUnresolvedFaucetsForTest(): void {
  unresolvedFaucets.clear();
}

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
    const acc = await midenClientProxy.getAccount(address);

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
    const now = Date.now();
    const metadataFetchPromises = assets
      .filter(asset => {
        const assetId = getBech32AddressFromAccountId(asset.faucetId());
        return assetId !== midenFaucetId && !localMetadatas[assetId] && shouldRetryUnresolved(assetId, now);
      })
      .map(async asset => {
        const assetId = getBech32AddressFromAccountId(asset.faucetId());
        // A lookup can fail two ways, and both used to end the same: the guess
        // was written to the store as though it were the answer. It throws when
        // the RPC or the WASM client is unavailable, and it RETURNS the
        // placeholder when the faucet was reached but could not be read. The
        // second is the one that hid here — it lands on the success path, so it
        // was persisted despite `fetchTokenMetadata` deliberately not caching
        // it "so a later fetch can retry".
        //
        // Either way the placeholder is used for THIS refresh only: it goes to
        // `localMetadatas`, which keeps the token on screen, and never to
        // `fetchedMetadatas`, which is what gets persisted and published.
        try {
          const tokenMetadata = await fetchTokenMetadata(assetId);
          if (hasKnownScale(tokenMetadata.base)) {
            fetchedMetadatas[assetId] = tokenMetadata.base;
            unresolvedFaucets.delete(assetId);
          } else {
            localMetadatas[assetId] = tokenMetadata.base;
            recordUnresolved(assetId, now);
          }
        } catch (e) {
          console.warn('Failed to fetch metadata for', assetId, e);
          localMetadatas[assetId] = DEFAULT_TOKEN_METADATA;
          recordUnresolved(assetId, now);
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

    // The placeholder rather than a `continue`: an unresolved faucet is a real
    // holding, and dropping the row hides an asset the user owns. It carries
    // `scaleIsUnknown`, so the row renders as a name without a quantity instead
    // of a number derived from guessed decimals. This also keeps the token
    // visible while its lookup is in backoff, and matches what the sync path
    // (`updateBalancesFromSyncData`) already does for the same case.
    const tokenMetadata = isMiden ? MIDEN_METADATA : (localMetadatas[tokenId] ?? DEFAULT_TOKEN_METADATA);

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
