import { formatUnits } from 'viem';

import { midenAddrToEvmAddr } from 'lib/agglayer/contract';
import { fetchDeposits, isAgglayerDepositReady } from 'lib/agglayer/status';
import {
  approveErc20,
  bridgeErc20ToMiden,
  getAgglayerBridgeAddress,
  getSepoliaPublicClient,
  getVaultWalletClient,
  readErc20Allowance,
  readErc20Balance,
  readEthBalance,
  waitForReceiptSuccess
} from 'lib/agglayer/vault-evm';
import { initiateBuyTransaction, updateBuyBridgeProgress } from 'lib/miden/activity';
import { IBuyExtraInputs, ITransaction } from 'lib/miden/db/types';
import * as Repo from 'lib/miden/repo';

import { clearBuySession, peekBuyExternalId } from './buy-session';
import { BUY_TOKEN_ADDRESS, BUY_TOKEN_SYMBOL, getBuyTokenDecimals } from './buy-token';
import { fetchBuyTransactionStatus } from './moonpay';

/**
 * Fiat on-ramp (Buy) automation, driven by `runBuyTick` (mounted at the app
 * root by `BuyBridgeManager`, 20s interval, idempotent). Simple lifecycle,
 * persisted as a `buy` activity row (Dexie), mirroring the tracking-only
 * `bridged-receive` pattern:
 *
 *   1. Poll the sign server's `/tx-status` for the active buy session uuid.
 *      A `completed` MoonPay purchase inserts the `buy` row
 *      (`bridgeProgress: 'not-initiated'`).
 *   2. While a row is `not-initiated`: once the delivered token shows a
 *      balance on the derived EVM address, gas up via the local paymaster and
 *      broadcast `approve` + `bridgeAsset` of the whole balance to the user's
 *      Miden account. Broadcast OK -> `initiated` (and the session slot
 *      clears); any error -> `failed` + message.
 *
 * Delivery/confirmation is not tracked here — the AggLayer note lands and
 * auto-consume claims it like any other incoming note.
 */

const PAYMASTER_URL = 'http://localhost:5568';

const inFlight = new Set<string>();
const warnedWaiting = new Set<string>();

function isHexAddress(value: string): value is `0x${string}` {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function buyInputs(tx: ITransaction): IBuyExtraInputs {
  return tx.extraInputs;
}

async function findBuyRowByUuid(accountId: string, uuidValue: string): Promise<ITransaction | undefined> {
  return Repo.transactions
    .filter(tx => tx.type === 'buy' && tx.accountId === accountId && buyInputs(tx).uuid === uuidValue)
    .first();
}

/** Oldest `buy` row still waiting for its bridge to be initiated. */
async function findBridgeableBuyRow(accountId: string): Promise<ITransaction | undefined> {
  const rows = await Repo.transactions
    .filter(tx => tx.type === 'buy' && tx.accountId === accountId && buyInputs(tx).bridgeProgress === 'not-initiated')
    .toArray();
  rows.sort((a, b) => a.initiatedAt - b.initiatedAt);
  return rows[0];
}

/**
 * Ask the paymaster to gas up the address. Returns once the address has gas
 * (already funded, or the drip landed — /fund waits for the receipt); throws
 * when the paymaster refuses or is unreachable.
 */
async function ensureGas(evmAddress: `0x${string}`): Promise<void> {
  const gas = await readEthBalance(evmAddress);
  if (gas > 0n) return;
  const response = await fetch(`${PAYMASTER_URL}/fund`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: evmAddress })
  });
  const result: { funded?: boolean; reason?: string } = await response.json();
  if (!result.funded) {
    throw new Error(`paymaster did not fund ${evmAddress}: ${result.reason ?? response.status}`);
  }
}

const BUY_BRIDGE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function isHexTxHash(value: string): value is `0x${string}` {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

function sameHash(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/**
 * Poll `initiated` buy rows once, mirroring `reconcileAgglayerBridgedReceives`:
 * a reverted bridge tx fails the row; a deposit indexed + ready on the Miden
 * side flips it `processed`. One-shot per call — the Activity page (and the
 * app-root buy tick) drive it on an interval, so no hidden timers.
 */
export async function reconcileBuyBridges(): Promise<void> {
  const rows = await Repo.transactions
    .filter(tx => tx.type === 'buy' && buyInputs(tx).bridgeProgress === 'initiated')
    .toArray();
  if (rows.length === 0) return;
  const cutoffSec = Math.floor((Date.now() - BUY_BRIDGE_MAX_AGE_MS) / 1000);

  for (const row of rows) {
    const inputs = buyInputs(row);
    if (row.initiatedAt < cutoffSec) {
      await updateBuyBridgeProgress(row.id, 'failed', { error: 'Bridge delivery timed out.' });
      continue;
    }
    if (!inputs.evmTxHash || !isHexTxHash(inputs.evmTxHash)) continue;

    // One-shot receipt check: a still-pending tx just stays `initiated` and is
    // re-checked on the next pass.
    try {
      const receipt = await getSepoliaPublicClient().getTransactionReceipt({ hash: inputs.evmTxHash });
      if (receipt?.status === 'reverted') {
        await updateBuyBridgeProgress(row.id, 'failed', { error: 'The bridge transaction reverted.' });
        continue;
      }
      if (!receipt) continue;
    } catch {
      // Pending or RPC blip — leave the row for the next pass.
      continue;
    }

    try {
      const deposits = await fetchDeposits(midenAddrToEvmAddr(row.accountId));
      const deposit = deposits.find(candidate => sameHash(candidate.tx_hash, inputs.evmTxHash!));
      if (deposit && isAgglayerDepositReady(deposit)) {
        await updateBuyBridgeProgress(row.id, 'processed');
        console.log('[buy] bridge deposit ready on Miden', { txId: row.id, evmTxHash: inputs.evmTxHash });
      }
    } catch (err) {
      // Indexer outages are transient — retry on the next pass.
      console.warn('[buy] AggLayer status poll failed', err);
    }
  }
}

/**
 * One watcher pass for one account. Cheap when idle (one `/tx-status` GET at
 * most). Never throws — a failed pass logs and retries next tick; only a
 * failed bridge INITIATION marks the row `failed`.
 */
export async function runBuyTick(account: { publicKey: string; evmAddress: string }): Promise<void> {
  const { publicKey, evmAddress } = account;
  if (!isHexAddress(evmAddress) || inFlight.has(evmAddress)) return;
  inFlight.add(evmAddress);
  try {
    // 1. Status leg: a completed MoonPay purchase inserts the buy row.
    const uuidValue = peekBuyExternalId();
    if (uuidValue && !(await findBuyRowByUuid(publicKey, uuidValue))) {
      try {
        const statuses = await fetchBuyTransactionStatus(uuidValue);
        if (statuses.some(s => s.status === 'completed')) {
          await initiateBuyTransaction({ accountId: publicKey, uuid: uuidValue, sourceSymbol: BUY_TOKEN_SYMBOL });
          console.log('[buy] MoonPay purchase completed; will bridge', uuidValue);
        }
      } catch (err) {
        console.warn('[buy] status poll failed (will retry)', err);
      }
    }

    // 2. Delivery leg: advance initiated rows via receipt + bridge indexer.
    await reconcileBuyBridges().catch(err => console.warn('[buy] reconcile failed (will retry)', err));

    // 3. Bridge leg: only a not-initiated row acts.
    const row = await findBridgeableBuyRow(publicKey);
    if (!row) return;

    const balance = await readErc20Balance(BUY_TOKEN_ADDRESS, evmAddress);
    if (balance === 0n) {
      if (!warnedWaiting.has(row.id)) {
        warnedWaiting.add(row.id);
        console.log('[buy] waiting for the purchased token to land on', evmAddress);
      }
      return;
    }

    try {
      await ensureGas(evmAddress);

      const walletClient = getVaultWalletClient(publicKey, evmAddress);
      const bridge = getAgglayerBridgeAddress();

      // Idempotent approve: a crash after a mined approve skips straight to bridge.
      const allowance = await readErc20Allowance(BUY_TOKEN_ADDRESS, evmAddress, bridge);
      if (allowance < balance) {
        const approveTxHash = await approveErc20({
          walletClient,
          token: BUY_TOKEN_ADDRESS,
          spender: bridge,
          amount: balance
        });
        await waitForReceiptSuccess(approveTxHash);
      }

      const bridgeTxHash = await bridgeErc20ToMiden({
        walletClient,
        toMidenAddress: publicKey,
        token: BUY_TOKEN_ADDRESS,
        amount: balance
      });
      const decimals = await getBuyTokenDecimals();
      await updateBuyBridgeProgress(
        row.id,
        'initiated',
        { evmTxHash: bridgeTxHash, sourceAmount: formatUnits(balance, decimals) },
        balance
      );
      if (buyInputs(row).uuid === peekBuyExternalId()) clearBuySession();
      console.log('[buy] bridge initiated', { evmAddress, bridgeTxHash, amount: balance.toString() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await updateBuyBridgeProgress(row.id, 'failed', { error: message });
      console.warn('[buy] bridge initiation failed', message);
    }
  } catch (err) {
    console.warn('[buy] tick failed (will retry)', err);
  } finally {
    inFlight.delete(evmAddress);
  }
}
