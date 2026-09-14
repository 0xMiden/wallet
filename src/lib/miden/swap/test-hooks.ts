import { buildSwapTag, NoteScript, NoteType } from '@miden-sdk/miden-sdk/lazy';

import { NoteExportType } from 'lib/miden/sdk/constants';
import { accountIdStringToSdk } from 'lib/miden/sdk/helpers';
import { assertWasmHoldCurrent, getMidenClient, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { remoteProver } from 'lib/miden/sdk/miden-client-interface';
import { isWasmClientPoisonedError } from 'lib/miden/sdk/wasm-client-poison';

import { _setSwapTokensForTest, type SwapToken } from './tokens';
import { TX_FEE_NOTE_TAG } from '../activity/fee-notes';

const LINEAGE_STATE = ['active', 'filled', 'reclaimed'] as const;

/**
 * E2E-only PSWAP hooks. Installed ONLY under the `MIDEN_E2E_TEST` guard, so this
 * whole module is dead-stripped from production.
 *
 * Split by context:
 *  - `installSwapTestHooks()` (PAGE, via lib/store) exposes the token-registry
 *    override the swap-create UI reads.
 *  - `installSwapConsumeHooks()` (SERVICE WORKER, via back/main)
 *    exposes the taker discovery + fill. It runs in the SW because the wallet's
 *    keys live in the SW vault and are signed SW-direct (the wallet's own tx
 *    loop is SW-owned on the extension); the page→intercom signing path yields
 *    an empty signature. The realm signer `Actions.init` installed signs (#878).
 *
 * Discovery notes:
 *  - Lineage only tracks a client's OWN orders, so the taker discovers the
 *    maker's note by its swap TAG. `buildSwapTag` does NOT reproduce the tag
 *    `pswapCreate` stamps, so the test conveys the maker's real tag (read via
 *    `__TEST_PSWAP_ORDER_INFO__`) — as a solver reads it from the mempool.
 *  - PSWAP notes surface in `notes.list()` (input notes), not
 *    `getConsumableNotes()`.
 *  - Discover on the realm's one client; the signed fill takes the WASM lock and
 *    signs with the realm's installed signer (#878), by note id resolved from
 *    the shared store.
 */

/**
 * The text an E2E hook returns for a failure. An eviction's `where` label rides
 * on the poison error's cause, never its message (a closed set, #775), so the
 * wallet-authored cause text is appended for the harness.
 */
export function describeHookError(e: unknown, withStack = false): string {
  if (!(e instanceof Error)) return String(e);
  const cause = isWasmClientPoisonedError(e) && e.cause instanceof Error ? ` (${e.cause.message})` : '';
  // The frames follow the message and its cause, so a label is never buried under them.
  const head = `${e.name}: ${e.message}`;
  const frames = withStack && e.stack ? (e.stack.startsWith(head) ? e.stack.slice(head.length) : `\n${e.stack}`) : '';
  return `${e.message}${cause}${frames}`;
}

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
  /** Preferred: the maker's exported note (Full NoteFile, hex). Deterministic
   *  handoff that avoids the reactive tag-subscription race. */
  noteFileHex?: string;
}

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

/** SERVICE-WORKER hooks: taker discovery + fill, signed by the realm signer (#878). */
export function installSwapConsumeHooks(): void {
  // Report this client's sent (output) notes with their tags (maker reads its own note tag).
  (globalThis as any).__TEST_PSWAP_ORDER_INFO__ = async () => {
    try {
      return await withWasmClientLock(
        async hold => {
          const mc = await getMidenClient();
          assertWasmHoldCurrent(hold, 'pswap-order-info after the client build');
          const client = (mc as unknown as { client: any }).client;
          await mc.syncState();
          assertWasmHoldCurrent(hold, 'pswap-order-info after sync');
          const sent: any[] = (await client.notes?.listSent?.().catch(() => [])) ?? [];
          assertWasmHoldCurrent(hold, 'pswap-order-info before the sent-record reads');
          return {
            ok: true,
            sent: sent.map((r: any) => ({
              id: safe(() => r.id().toString()).slice(0, 14),
              fullId: safe(() => r.id().toString()),
              tag: safe(() => r.metadata().tag().asU32()),
              // Labelled at the PRODUCER because the harness cannot reach `partitionFeeNote`:
              // `__TEST_PSWAP_ORDER_INFO__` flattens the SDK records into plain JSON inside the
              // service worker, so by the time playwright sees them the note objects are gone.
              // Without this, every helper that returns ONE note is guessing on a fee chain.
              isFee: safe(() => r.metadata().tag().asU32()) === String(TX_FEE_NOTE_TAG),
              noteType: safe(() => r.metadata().noteType()),
              // The PSWAP order id, so a caller can tell the swap note apart from
              // the fee note the account also emits on a fee-charging chain.
              orderId: orderIdOf(r)
            }))
          };
        },
        { label: 'pswap-order-info' }
      );
    } catch (e) {
      return { ok: false, error: describeHookError(e) };
    }
  };

  // Inspect a committed SENT note's visibility + script kind. The Epoch bridge
  // collateral note MUST be a PUBLIC recallable P2IDE: a private note is "not
  // found on-chain" by the allocator, and a plain P2ID has no recall window for
  // it to validate. This is the on-chain guard for the guardian bridged-send
  // P2IDE path (the multisig send proposal used to mint a private P2ID — #439).
  (globalThis as any).__TEST_INSPECT_SENT_NOTE__ = async (noteId: string) => {
    try {
      return await withWasmClientLock(
        async hold => {
          const mc = await getMidenClient();
          assertWasmHoldCurrent(hold, 'pswap-inspect-sent-note after the client build');
          await mc.syncState();
          assertWasmHoldCurrent(hold, 'pswap-inspect-sent-note after sync');
          const client = (mc as unknown as { client: any }).client;
          const sent: any[] = (await client.notes?.listSent?.().catch(() => [])) ?? [];
          assertWasmHoldCurrent(hold, 'pswap-inspect-sent-note before the sent-record reads');
          const record = sent.find((r: any) => safe(() => r.id().toString()) === noteId);
          if (!record) {
            return { ok: false, error: `sent note ${noteId} not found among ${sent.length} sent notes` };
          }
          let noteTypeRaw: number | null = null;
          try {
            noteTypeRaw = record.metadata().noteType();
          } catch {
            noteTypeRaw = null;
          }
          const scriptRoot = safe(() => record.recipient().script().root().toHex());
          return {
            ok: true,
            // NoteType is a numeric enum (Private=0, Public=1) — expose both the raw
            // value and a resolved boolean so the assertion doesn't depend on stringed enums.
            noteType: noteTypeRaw,
            isPublic: noteTypeRaw === NoteType.Public,
            scriptRoot,
            isP2id: scriptRoot !== '?' && scriptRoot === safe(() => NoteScript.p2id().root().toHex()),
            isP2ide: scriptRoot !== '?' && scriptRoot === safe(() => NoteScript.p2ide().root().toHex())
          };
        },
        { label: 'pswap-inspect-sent-note' }
      );
    } catch (e) {
      return { ok: false, error: describeHookError(e) };
    }
  };

  // Maker-side: export an output note as a Full NoteFile (hex) for a deterministic
  // handoff to the taker (bypasses reactive tag discovery).
  (globalThis as any).__TEST_EXPORT_NOTE__ = async (noteId: string) => {
    try {
      return await withWasmClientLock(
        async hold => {
          const mc = await getMidenClient();
          assertWasmHoldCurrent(hold, 'pswap-export-note after the client build');
          await mc.syncState();
          assertWasmHoldCurrent(hold, 'pswap-export-note after sync');
          // The wrapper serializes after its own await: its seam carries this hold's check.
          const bytes = await mc.exportNote(noteId, NoteExportType.FULL, step =>
            assertWasmHoldCurrent(hold, 'pswap-export-note inside the export', step)
          );
          return { ok: true, hex: Buffer.from(bytes).toString('hex') };
        },
        { label: 'pswap-export-note' }
      );
    } catch (e) {
      return { ok: false, error: describeHookError(e) };
    }
  };

  (globalThis as any).__TEST_PSWAP_CONSUME__ = async (a: PswapConsumeArgs) => {
    try {
      // Preferred path: deterministic maker->taker handoff. Import the maker's
      // exported note, then consume by its id. This avoids the tag race — the
      // wallet SDK does NOT back-fill a public note already committed in a past
      // block when a tag is subscribed after the fact (a reactive taker misses
      // notes that commit before it subscribes; a live solver subscribes ahead).
      if (a.noteFileHex) {
        return await withWasmClientLock(
          async hold => {
            const signMc = await getMidenClient();
            assertWasmHoldCurrent(hold, 'pswap-fill-handoff after the client build');
            await signMc.syncState();
            assertWasmHoldCurrent(hold, 'pswap-fill-handoff after the first sync');
            const importedId = await signMc.importNoteBytes(Buffer.from(a.noteFileHex!, 'hex'));
            assertWasmHoldCurrent(hold, 'pswap-fill-handoff after the import');
            await signMc.syncState();
            assertWasmHoldCurrent(hold, 'pswap-fill-handoff after the second sync');
            const result = await (signMc as unknown as { client: any }).client.transactions.pswapConsume({
              account: a.accountId,
              note: importedId,
              fillAmount: BigInt(a.fillAmount),
              // Omitting `prover` takes the SDK's default remote prover, whose gRPC
              // deadline is ~10s — shorter than a fill proof takes on a 2-core CI
              // runner, so the fill dies with `DeadlineExceeded`. `remoteProver()`
              // carries `DELEGATED_PROVE_TIMEOUT_MS` instead. Build a fresh one per
              // call: the SDK consumes a prover, and a reused one silently reverts
              // to the default.
              prover: remoteProver()
            });
            return { ok: true, txId: String(result?.id?.() ?? result ?? ''), noteId: importedId };
          },
          { label: 'pswap-fill-handoff' }
        );
      }

      // 1. Discover on the shared realm client: subscribe to the maker's tag,
      //    sync, and locate the note by orderId in the input-note list.
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
      for (const t of tags) {
        await withWasmClientLock(
          async hold => {
            const mc = await getMidenClient();
            assertWasmHoldCurrent(hold, 'pswap-discovery-tag after the client build');
            return (mc as unknown as { client: any }).client.tags.add(t);
          },
          { label: 'pswap-discovery-tag' }
        );
      }

      let noteId: string | undefined;
      let counts = '';
      // ~120s window: standard-account notes appear in the first few rounds
      // (early exit); a guardian maker's note commits later via guardian
      // canonicalization, so the loop must outlast that latency.
      for (let i = 0; i < 40 && !noteId; i++) {
        // One hold per round, from the sync through every read of the records it
        // returned (borrowed from the client's RefCell), released across the wait:
        // reads and writes share this one client now (#878).
        const round = await withWasmClientLock(
          async hold => {
            // Resolved inside the hold: a round after a replacement never calls a corpse.
            const disc = await getMidenClient();
            assertWasmHoldCurrent(hold, 'pswap-discovery after the client build');
            const dclient = (disc as unknown as { client: any }).client;
            await disc.syncState();
            assertWasmHoldCurrent(hold, 'pswap-discovery after sync');
            const list: any[] = (await dclient.notes?.list?.().catch(() => [])) ?? [];
            assertWasmHoldCurrent(hold, 'pswap-discovery before the record reads');
            let found: string | undefined;
            for (const rec of list) {
              const r = typeof rec?.inputNoteRecord === 'function' ? rec.inputNoteRecord() : rec;
              if (orderIdOf(r) === a.orderId) {
                found = String(r.id().toString());
                break;
              }
            }
            return { found, listLength: list.length };
          },
          { label: 'pswap-discovery' }
        );
        counts = `list=${round.listLength}`;
        noteId = round.found;
        if (!noteId) await new Promise(r => setTimeout(r, 3000));
      }
      if (!noteId) {
        return {
          ok: false,
          error: `PSWAP note not found for order ${a.orderId} (tags=[${tags.join(',')}], ${counts})`
        };
      }

      // 2. Fill under a hold, signed by the realm signer, by note id (resolved from the shared store).
      return await withWasmClientLock(
        async hold => {
          const signMc = await getMidenClient();
          assertWasmHoldCurrent(hold, 'pswap-fill after the client build');
          await signMc.syncState();
          assertWasmHoldCurrent(hold, 'pswap-fill after sync');
          const result = await (signMc as unknown as { client: any }).client.transactions.pswapConsume({
            account: a.accountId,
            note: noteId,
            fillAmount: BigInt(a.fillAmount),
            // Fresh explicit prover, same reason as the deterministic-handoff path above.
            prover: remoteProver()
          });
          return { ok: true, txId: String(result?.id?.() ?? result ?? ''), noteId };
        },
        { label: 'pswap-fill' }
      );
    } catch (e) {
      return { ok: false, error: describeHookError(e, true) };
    }
  };

  // Read the on-chain lineage of an order (settlement assertion). Sync first so
  // the maker's client sees the fill.
  (globalThis as any).__TEST_PSWAP_LINEAGE__ = async (orderId: string) => {
    try {
      return await withWasmClientLock(
        async hold => {
          const mc = await getMidenClient();
          assertWasmHoldCurrent(hold, 'pswap-lineage after the client build');
          await mc.syncState();
          assertWasmHoldCurrent(hold, 'pswap-lineage after sync');
          const rec = await (mc as unknown as { client: any }).client.pswap.lineage(orderId);
          assertWasmHoldCurrent(hold, 'pswap-lineage before the record read');
          if (!rec) return { ok: true, state: null };
          return {
            ok: true,
            state: LINEAGE_STATE[rec.state()] ?? String(rec.state()),
            remainingOffered: String(rec.remainingOffered()),
            remainingRequested: String(rec.remainingRequested())
          };
        },
        { label: 'pswap-lineage' }
      );
    } catch (e) {
      return { ok: false, error: describeHookError(e) };
    }
  };

  // Read an account's on-chain balance for a faucet (base units, decimal string).
  // Goes through the wallet wrapper's `getAccount` -> `vault()` (the same path
  // sync-manager uses); the resource client has no flat getAccountVault.
  (globalThis as any).__TEST_TOKEN_BALANCE__ = async (a: { accountId: string; faucetId: string }) => {
    try {
      return await withWasmClientLock(
        async hold => {
          const mc = await getMidenClient();
          assertWasmHoldCurrent(hold, 'pswap-token-balance after the client build');
          await mc.syncState();
          assertWasmHoldCurrent(hold, 'pswap-token-balance after sync');
          const account = await mc.getAccount(a.accountId);
          assertWasmHoldCurrent(hold, 'pswap-token-balance before the account read');
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
        },
        { label: 'pswap-token-balance' }
      );
    } catch (e) {
      return { ok: false, error: describeHookError(e) };
    }
  };

  (globalThis as any).__TEST_PSWAP_CANCEL__ = async (a: { orderId: string }) => {
    try {
      return await withWasmClientLock(
        async hold => {
          const signMc = await getMidenClient();
          assertWasmHoldCurrent(hold, 'pswap-cancel after the client build');
          await signMc.syncState();
          assertWasmHoldCurrent(hold, 'pswap-cancel after sync');
          const result = await (signMc as unknown as { client: any }).client.pswap.cancelByOrder({
            orderId: a.orderId
          });
          return { ok: true, txId: String(result?.id?.() ?? result ?? '') };
        },
        { label: 'pswap-cancel' }
      );
    } catch (e) {
      return { ok: false, error: describeHookError(e, true) };
    }
  };
}
