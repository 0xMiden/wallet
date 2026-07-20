import { buildSwapTag } from '@miden-sdk/miden-sdk/lazy';

import { getMidenClient } from 'lib/miden/sdk/miden-client';

import { _setSwapTokensForTest, type SwapToken } from './tokens';

/**
 * E2E-only PSWAP hooks. Installed ONLY under the `MIDEN_E2E_TEST` guard (see
 * `lib/store/index.ts`), so this whole module is dead-stripped from production.
 *
 * The wallet UI can only CREATE swap orders; the counterparty fill is done here
 * via the SDK so an E2E test can drive "wallet B takes wallet A's order".
 *
 * Two SDK-client facts drive the shape below:
 *  - Discovery/reads use the DEFAULT client (`getMidenClient()`), the wallet's
 *    already-synced singleton. `getMidenClient(options)` disposes+recreates a
 *    FRESH, unsynced client, which can't find the note in time.
 *  - Signing uses the vault: the wallet's keys live in the SW vault, not the SDK
 *    keystore, so the fill tx is signed via a client built with a `signCallback`
 *    routed through the store's `signTransaction` (the wallet's own tx path).
 *  - A note is discovered by its swap TAG (lineage only tracks a client's OWN
 *    orders). buildSwapTag does NOT reproduce the tag pswapCreate stamps, so the
 *    test conveys the maker's real tag (as a solver reads it from the mempool).
 */

interface PswapConsumeArgs {
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

const bytesToHex = (u: Uint8Array): string =>
  Array.from(u)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

/** A vault-routed client (signs via the store's signTransaction → SW vault). */
async function getSigningClient() {
  const store = (globalThis as any).__TEST_STORE__;
  const signTransaction = store?.getState?.().signTransaction;
  const options = signTransaction
    ? {
        signCallback: async (publicKey: Uint8Array, signingInputs: Uint8Array) =>
          signTransaction(bytesToHex(publicKey), bytesToHex(signingInputs))
      }
    : undefined;
  return getMidenClient(options as any);
}

/** Pull the `serialNum().toFelts()[1]` order id off a note record, defensively. */
function orderIdOf(record: any): string | undefined {
  try {
    const recipient = record?.details?.().recipient?.() ?? record?.recipient?.();
    const felts = recipient?.serialNum?.().toFelts?.();
    const asInt = felts?.[1]?.asInt?.();
    return asInt != null ? String(asInt) : undefined;
  } catch {
    return undefined;
  }
}

export function installSwapTestHooks(): void {
  (globalThis as any).__TEST_SET_SWAP_TOKENS__ = (tokens: SwapToken[]) => _setSwapTokensForTest(tokens);

  // Report this client's sent (output) notes with their tags, so the test can
  // read the maker's real note tag.
  (globalThis as any).__TEST_PSWAP_ORDER_INFO__ = async () => {
    try {
      const mc = await getMidenClient();
      const client = (mc as unknown as { client: any }).client;
      await mc.syncState();
      const sent: any[] = (await client.notes?.listSent?.().catch(() => [])) ?? [];
      const safe = (fn: () => any) => {
        try {
          return String(fn() ?? '');
        } catch {
          return '?';
        }
      };
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
      //    sync, and locate the note by orderId (scan the input-note list — a
      //    PSWAP note imports there but isn't flagged "consumable").
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

      // 2. Fill on the vault-signing client, by note id (resolved from the
      //    shared IndexedDB store the default client just synced).
      const signMc = await getSigningClient();
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
      const signMc = await getSigningClient();
      await signMc.syncState();
      const result = await (signMc as unknown as { client: any }).client.pswap.cancelByOrder({ orderId: a.orderId });
      return { ok: true, txId: String(result?.id?.() ?? result ?? '') };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.stack || e.message : String(e) };
    }
  };
}
