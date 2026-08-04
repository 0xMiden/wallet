import { create } from 'zustand';

import { EMPTY_DEPOSIT_BALANCES, readDepositBalances, type DepositBalances } from './balances';
import { detectArrivals, type DepositArrival } from './detect';
import { fetchRecentDepositTxs, type DepositEvmTx } from './history';
import type { DepositTokenId } from './tokens';
import { patchWatermark, readWatermarks } from './watermarks';

export type DepositWatchStatus = 'idle' | 'watching' | 'error';
export type RecentTxsStatus = 'idle' | 'loading' | 'error';

interface DepositAddressState {
  /** Lowercase-preserved deposit address, or null when the account has none. */
  address: string | null;
  status: DepositWatchStatus;
  balances: DepositBalances;
  /** Confirmed, unacknowledged arrivals. */
  arrivals: DepositArrival[];
  /** The arrival the drawer should open for, if any. */
  pendingDrawer: DepositArrival | null;
  lastPolledAt: number | null;
  error: string | null;
  recentTxs: DepositEvmTx[];
  recentTxsStatus: RecentTxsStatus;
}

interface DepositAddressActions {
  setAddress(address: string | null | undefined): void;
  poll(): Promise<void>;
  refreshRecentTxs(): Promise<void>;
  /** Raise the watermark to the full current balance — call only after a successful submit. */
  acknowledge(token: DepositTokenId): Promise<void>;
  /** Drop the arrival from this session only; the watermark is untouched. */
  dismiss(token: DepositTokenId): void;
  markDrawerShown(token: DepositTokenId): Promise<void>;
  reset(): void;
}

export type DepositAddressStore = DepositAddressState & DepositAddressActions;

/**
 * Ticks the same raw balance must be observed for before it counts as an
 * arrival. At the watcher's 12s interval that's ~24s — enough that a balance
 * read straddling a pending tx doesn't flash a drawer for an amount that is
 * about to change.
 */
const CONFIRMATIONS_REQUIRED = 2;

/** Refresh the Blockscout list every other tick (~24s) unless a balance moved. */
const RECENT_TX_TICK_INTERVAL = 2;

const INITIAL_STATE: DepositAddressState = {
  address: null,
  status: 'idle',
  balances: EMPTY_DEPOSIT_BALANCES,
  arrivals: [],
  pendingDrawer: null,
  lastPolledAt: null,
  error: null,
  recentTxs: [],
  recentTxsStatus: 'idle'
};

// Module-local poll bookkeeping. Deliberately OUT of the store: none of it is
// rendered, and keeping it out means a stale in-flight poll can be discarded by
// generation without triggering subscriber churn.
let running = false;
let generation = 0;
let tickCount = 0;
const observed = new Map<DepositTokenId, { raw: bigint; count: number }>();

function resetPollState(): void {
  generation += 1;
  tickCount = 0;
  observed.clear();
}

/** Confirmed = the same raw balance seen on CONFIRMATIONS_REQUIRED consecutive ticks. */
function confirm(token: DepositTokenId, raw: bigint): boolean {
  const previous = observed.get(token);
  const count = previous && previous.raw === raw ? previous.count + 1 : 1;
  observed.set(token, { raw, count });
  return count >= CONFIRMATIONS_REQUIRED;
}

/** Highest-value arrival the drawer hasn't been shown for (both tokens are 18-decimal). */
function pickDrawer(arrivals: DepositArrival[]): DepositArrival | null {
  return arrivals.filter(a => !a.drawerShown).sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0))[0] ?? null;
}

export const useDepositAddressStore = create<DepositAddressStore>((set, get) => ({
  ...INITIAL_STATE,

  setAddress(address) {
    const next = address && address.trim() ? address.trim() : null;
    if (next === get().address) return;
    // Discard anything in flight for the previous account.
    resetPollState();
    set({ ...INITIAL_STATE, address: next, status: next ? 'watching' : 'idle' });
  },

  async poll() {
    const address = get().address;
    if (!address || running) return;
    if (typeof document !== 'undefined' && document.hidden) return;

    const pollGeneration = generation;
    running = true;
    try {
      const balances = await readDepositBalances(address);
      if (pollGeneration !== generation) return;
      const store = await readWatermarks();
      if (pollGeneration !== generation) return;

      const { arrivals, corrections } = detectArrivals({ address, balances, store });
      for (const correction of corrections) {
        await patchWatermark(address, correction.token, {
          acknowledged: correction.acknowledged,
          drawerShown: correction.drawerShown
        });
      }
      if (pollGeneration !== generation) return;

      const confirmed = arrivals.filter(arrival => confirm(arrival.token, arrival.balance));
      // Tokens with no arrival still need their observation reset, otherwise a
      // balance that dips and returns keeps a stale confirmation count.
      for (const [token, entry] of observed) {
        const balance = balances[token];
        if (balance === null || entry.raw !== balance) observed.delete(token);
      }

      const balanceChanged =
        get().balances.ETH !== balances.ETH || get().balances.USDC !== balances.USDC;
      set({
        balances,
        arrivals: confirmed,
        pendingDrawer: pickDrawer(confirmed),
        status: 'watching',
        error: null,
        lastPolledAt: Date.now()
      });

      tickCount += 1;
      if (balanceChanged || tickCount % RECENT_TX_TICK_INTERVAL === 0) {
        await get().refreshRecentTxs();
      }
    } catch (error) {
      // RPC failure must NOT clear already-detected arrivals: the funds are still
      // there, we just can't see them this tick.
      set({
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        lastPolledAt: Date.now()
      });
    } finally {
      running = false;
    }
  },

  async refreshRecentTxs() {
    const address = get().address;
    if (!address) return;
    const pollGeneration = generation;
    set({ recentTxsStatus: 'loading' });
    try {
      const recentTxs = await fetchRecentDepositTxs(address);
      if (pollGeneration !== generation) return;
      set({ recentTxs, recentTxsStatus: 'idle' });
    } catch (error) {
      if (pollGeneration !== generation) return;
      console.warn('[deposit-bridge] recent activity fetch failed', error);
      // Keep the last good list; only an empty list surfaces as an error.
      set({ recentTxsStatus: get().recentTxs.length > 0 ? 'idle' : 'error' });
    }
  },

  async acknowledge(token) {
    const { address, balances, arrivals, pendingDrawer } = get();
    if (!address) return;
    const balance = balances[token];
    // Raise to the FULL balance, not the bridged amount: a partial bridge must
    // not re-prompt. The remainder stays visible on the Cross-chain tab, which
    // renders from `balances`.
    if (balance !== null) {
      await patchWatermark(address, token, { acknowledged: balance, drawerShown: balance });
    }
    observed.delete(token);
    set({
      arrivals: arrivals.filter(a => a.token !== token),
      pendingDrawer: pendingDrawer?.token === token ? null : pendingDrawer
    });
  },

  dismiss(token) {
    const { arrivals, pendingDrawer } = get();
    set({
      arrivals: arrivals.filter(a => a.token !== token),
      pendingDrawer: pendingDrawer?.token === token ? null : pendingDrawer
    });
  },

  async markDrawerShown(token) {
    const { address, arrivals, pendingDrawer } = get();
    if (!address) return;
    const arrival = arrivals.find(a => a.token === token);
    if (arrival) await patchWatermark(address, token, { drawerShown: arrival.balance });
    set({
      arrivals: arrivals.map(a => (a.token === token ? { ...a, drawerShown: true } : a)),
      pendingDrawer: pendingDrawer?.token === token ? null : pendingDrawer
    });
  },

  reset() {
    resetPollState();
    set({ ...INITIAL_STATE });
  }
}));
