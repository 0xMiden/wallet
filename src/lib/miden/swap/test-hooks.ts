import { buildSwapTag } from '@miden-sdk/miden-sdk/lazy';

import { getMidenClient } from 'lib/miden/sdk/miden-client';

import { _setSwapTokensForTest, type SwapToken } from './tokens';

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
      const tagU32 = a.tagU32
        ? Number(a.tagU32)
        : buildSwapTag({
            type: a.noteType ?? 'public',
            offer: { token: a.offerFaucetId, amount: BigInt(a.offerAmount) },
            request: { token: a.requestFaucetId, amount: BigInt(a.requestAmount) }
          }).asU32();
      await dclient.tags.add(tagU32);

      let note: any;
      let counts = '';
      for (let i = 0; i < 12 && !note; i++) {
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
        return { ok: false, error: `PSWAP note not found for order ${a.orderId} (tag=${tagU32}, ${counts})` };
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
