import { buildSwapTag } from '@miden-sdk/miden-sdk/lazy';

import { getMidenClient } from 'lib/miden/sdk/miden-client';

import { _setSwapTokensForTest, type SwapToken } from './tokens';

/**
 * E2E-only PSWAP hooks. Installed ONLY under the `MIDEN_E2E_TEST` guard (see
 * `lib/store/index.ts`), so this whole module is dead-stripped from production.
 *
 * The wallet UI can only CREATE swap orders; the counterparty fill is done here
 * via the SDK so an E2E test can drive "wallet B takes wallet A's order". A note
 * is discovered by its swap tag (a client only tracks lineage for its OWN
 * orders, so lineage-by-order can't resolve a counterparty's note), then the
 * specific order is selected by `serialNum().toFelts()[1] === orderId`.
 */

interface PswapConsumeArgs {
  /** Consumer (taker) account, bech32. */
  accountId: string;
  /** Decimal-string order id (from the maker's persisted `extraInputs.orderId`). */
  orderId: string;
  /** Offered/requested faucets (bech32) + amounts (base-unit decimal strings) — used to build the swap tag. */
  offerFaucetId: string;
  requestFaucetId: string;
  offerAmount: string;
  requestAmount: string;
  noteType?: 'public' | 'private';
  /** Requested-asset amount the taker supplies (base units, decimal string). */
  fillAmount: string;
}

/** Pull the `serialNum().toFelts()[1]` order id off a consumable/input note record, defensively. */
function orderIdOf(record: any): string | undefined {
  try {
    const recipient = record?.details?.().recipient?.() ?? record?.recipient?.();
    const felts = recipient?.serialNum?.().toFelts?.();
    const felt = felts?.[1];
    const asInt = felt?.asInt?.();
    return asInt != null ? String(asInt) : undefined;
  } catch {
    return undefined;
  }
}

export function installSwapTestHooks(): void {
  (globalThis as any).__TEST_SET_SWAP_TOKENS__ = (tokens: SwapToken[]) => _setSwapTokensForTest(tokens);

  (globalThis as any).__TEST_PSWAP_CONSUME__ = async (a: PswapConsumeArgs) => {
    try {
      const mc = await getMidenClient();
      const client = (mc as unknown as { client: any }).client;

      // 1. Subscribe to the swap pair tag and sync so the public PSWAP note is
      //    imported into this (taker) client's store.
      const tag = buildSwapTag({
        type: a.noteType ?? 'public',
        offer: { token: a.offerFaucetId, amount: BigInt(a.offerAmount) },
        request: { token: a.requestFaucetId, amount: BigInt(a.requestAmount) }
      });
      await client.tags.add(tag.asU32());
      await mc.syncState();

      // 2. Locate the maker's note among this client's consumable notes.
      const consumable: any[] = (await client.getConsumableNotes?.()) ?? [];
      let note: any;
      for (const c of consumable) {
        const rec = typeof c?.inputNoteRecord === 'function' ? c.inputNoteRecord() : c;
        if (orderIdOf(rec) === a.orderId) {
          note = rec;
          break;
        }
      }
      if (!note) {
        return {
          ok: false,
          error: `PSWAP note not found for order ${a.orderId} (scanned ${consumable.length} consumable)`
        };
      }

      // 3. Take (fill) it from the taker's own vault.
      const result = await client.transactions.pswapConsume({
        account: a.accountId,
        note,
        fillAmount: BigInt(a.fillAmount)
      });
      return { ok: true, txId: String(result?.id?.() ?? result ?? '') };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.stack || e.message : String(e) };
    }
  };

  (globalThis as any).__TEST_PSWAP_CANCEL__ = async (a: { orderId: string }) => {
    try {
      const mc = await getMidenClient();
      const client = (mc as unknown as { client: any }).client;
      const result = await client.pswap.cancelByOrder({ orderId: a.orderId });
      return { ok: true, txId: String(result?.id?.() ?? result ?? '') };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.stack || e.message : String(e) };
    }
  };
}
