import { buildSwapTag } from '@miden-sdk/miden-sdk/lazy';

import { accountIdStringToSdk } from 'lib/miden/sdk/helpers';
import { getMidenClient } from 'lib/miden/sdk/miden-client';

import { _setSwapTokensForTest, type SwapToken } from './tokens';

const LINEAGE_STATE = ['active', 'filled', 'reclaimed'] as const;

/**
 * E2E-only PSWAP hooks. Installed ONLY under the `MIDEN_E2E_TEST` guard, so this
 * whole module is dead-stripped from production.
 *
 * Split by context:
 *  - `installSwapTestHooks()` (PAGE, via lib/store) exposes the token-registry
 *    override the swap-create UI reads.
 *  - `installSwapConsumeHooks(signCallback)` (SERVICE WORKER, via back/main)
 *    exposes the taker discovery + fill. It runs in the SW because the wallet's
 *    keys live in the SW vault and are signed SW-direct (the wallet's own tx
 *    loop is SW-owned on the extension); the page→intercom signing path yields
 *    an empty signature. The caller injects the SW vault signer.
 *
 * Discovery notes:
 *  - Lineage only tracks a client's OWN orders, so the taker discovers the
 *    maker's note by its swap TAG. `buildSwapTag` does NOT reproduce the tag
 *    `pswapCreate` stamps, so the test conveys the maker's real tag (read via
 *    `__TEST_PSWAP_ORDER_INFO__`) — as a solver reads it from the mempool.
 *  - PSWAP notes surface in `notes.list()` (input notes), not
 *    `getConsumableNotes()`.
 *  - Discover on the DEFAULT client (synced singleton); `getMidenClient(opts)`
 *    is a fresh, unsynced client — use it only for the signed fill (by note id,
 *    resolved from the shared store).
 */

export interface PswapConsumeArgs {
  accountId: string;
  orderId: string;
  offerFaucetId: string;
  requestFaucetId: string;
  offerAmount: string;
  requestAmount: string;
  noteType?: 'public' | 'private';
  fillAmount: string;
  /** The maker note's actual tag (asU32, decimal string). Preferred over buildSwapTag. */
  tagU32?: string;
  /** All of the maker's sent-note tags — subscribe to each (a guardian maker may
   *  have several sent notes, so a single tag can miss the swap note). */
  tagsU32?: string[];
}

export type SwapSignCallback = (publicKey: Uint8Array, signingInputs: Uint8Array) => Promise<Uint8Array>;

/** Pull the `serialNum().toFelts()[1]` order id off a note record, defensively. */
function orderIdOf(record: any): string | undefined {
  try {
    const recipient = record?.details?.().recipient?.() ?? record?.recipient?.();
    const asInt = recipient?.serialNum?.().toFelts?.()?.[1]?.asInt?.();
    return asInt != null ? String(asInt) : undefined;
  } catch {
    return undefined;
  }
}

const safe = (fn: () => any) => {
  try {
    return String(fn() ?? '');
  } catch {
    return '?';
  }
};

/** PAGE hooks: the token-registry override read by the swap-create UI. */
export function installSwapTestHooks(): void {
  (globalThis as any).__TEST_SET_SWAP_TOKENS__ = (tokens: SwapToken[]) => _setSwapTokensForTest(tokens);
}

/** SERVICE-WORKER hooks: taker discovery + fill, signed via the injected vault signer. */
export function installSwapConsumeHooks(signCallback: SwapSignCallback): void {
  // Report this client's sent (output) notes with their tags (maker reads its own note tag).
  (globalThis as any).__TEST_PSWAP_ORDER_INFO__ = async () => {
    try {
      const mc = await getMidenClient();
      const client = (mc as unknown as { client: any }).client;
      await mc.syncState();
      const sent: any[] = (await client.notes?.listSent?.().catch(() => [])) ?? [];
      return {
        ok: true,
        sent: sent.map((r: any) => ({
          id: safe(() => r.id().toString()).slice(0, 14),
          tag: safe(() => r.metadata().tag().asU32()),
          noteType: safe(() => r.metadata().noteType())
        }))
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };

  (globalThis as any).__TEST_PSWAP_CONSUME__ = async (a: PswapConsumeArgs) => {
    try {
      // 1. Discover on the synced DEFAULT client: subscribe to the maker's tag,
      //    sync, and locate the note by orderId in the input-note list.
      const disc = await getMidenClient();
      const dclient = (disc as unknown as { client: any }).client;
      const tags: number[] = (
        a.tagsU32?.length
          ? a.tagsU32.map(Number)
          : [
              a.tagU32
                ? Number(a.tagU32)
                : buildSwapTag({
                    type: a.noteType ?? 'public',
                    offer: { token: a.offerFaucetId, amount: BigInt(a.offerAmount) },
                    request: { token: a.requestFaucetId, amount: BigInt(a.requestAmount) }
                  }).asU32()
            ]
      ).filter((n, i, arr) => Number.isFinite(n) && arr.indexOf(n) === i);
      for (const t of tags) await dclient.tags.add(t);

      let note: any;
      let counts = '';
      // ~120s window: standard-account notes appear in the first few rounds
      // (early exit); a guardian maker's note commits later via guardian
      // canonicalization, so the loop must outlast that latency.
      for (let i = 0; i < 40 && !note; i++) {
        await disc.syncState();
        const list: any[] = (await dclient.notes?.list?.().catch(() => [])) ?? [];
        counts = `list=${list.length}`;
        for (const rec of list) {
          const r = typeof rec?.inputNoteRecord === 'function' ? rec.inputNoteRecord() : rec;
          if (orderIdOf(r) === a.orderId) {
            note = r;
            break;
          }
        }
        if (!note) await new Promise(r => setTimeout(r, 3000));
      }
      if (!note) {
        return {
          ok: false,
          error: `PSWAP note not found for order ${a.orderId} (tags=[${tags.join(',')}], ${counts})`
        };
      }
      const noteId = String(note.id().toString());

      // 2. Fill on the vault-signing client, by note id (resolved from the shared store).
      const signMc = await getMidenClient({ signCallback } as any);
      await signMc.syncState();
      const result = await (signMc as unknown as { client: any }).client.transactions.pswapConsume({
        account: a.accountId,
        note: noteId,
        fillAmount: BigInt(a.fillAmount)
      });
      return { ok: true, txId: String(result?.id?.() ?? result ?? ''), noteId };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.stack || e.message : String(e) };
    }
  };

  // Read the on-chain lineage of an order (settlement assertion). Sync first so
  // the maker's client sees the fill.
  (globalThis as any).__TEST_PSWAP_LINEAGE__ = async (orderId: string) => {
    try {
      const mc = await getMidenClient();
      await mc.syncState();
      const rec = await (mc as unknown as { client: any }).client.pswap.lineage(orderId);
      if (!rec) return { ok: true, state: null };
      return {
        ok: true,
        state: LINEAGE_STATE[rec.state()] ?? String(rec.state()),
        remainingOffered: String(rec.remainingOffered()),
        remainingRequested: String(rec.remainingRequested())
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };

  // Read an account's on-chain balance for a faucet (base units, decimal string).
  // Goes through the wallet wrapper's `getAccount` -> `vault()` (the same path
  // sync-manager uses); the resource client has no flat getAccountVault.
  (globalThis as any).__TEST_TOKEN_BALANCE__ = async (a: { accountId: string; faucetId: string }) => {
    try {
      const mc = await getMidenClient();
      await mc.syncState();
      const account = await mc.getAccount(a.accountId);
      if (!account) return { ok: true, balance: '0' };
      const vault = account.vault();
      const faucet = accountIdStringToSdk(a.faucetId);
      let bal: bigint;
      try {
        bal = vault.getBalance(faucet);
      } catch {
        const fid = faucet.toString();
        const fa = vault.fungibleAssets().find((x: any) => safe(() => x.faucetId().toString()) === fid);
        bal = fa ? fa.amount() : 0n;
      }
      return { ok: true, balance: String(bal) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };

  (globalThis as any).__TEST_PSWAP_CANCEL__ = async (a: { orderId: string }) => {
    try {
      const signMc = await getMidenClient({ signCallback } as any);
      await signMc.syncState();
      const result = await (signMc as unknown as { client: any }).client.pswap.cancelByOrder({ orderId: a.orderId });
      return { ok: true, txId: String(result?.id?.() ?? result ?? '') };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.stack || e.message : String(e) };
    }
  };
}
