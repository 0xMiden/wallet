# R0 findings — PSWAP taker discovery + SDK API (from live SDK @0.15.5 + running stack)

Resolves the `/* per R0 */` placeholders in the plan's Task 2.1.

## SDK API (confirmed from node_modules/@miden-sdk/miden-sdk/dist/mt/*.d.ts)
- Fill: `client.transactions.pswapConsume({ account: bech32, note: InputNoteRecord|noteId|Note, fillAmount: bigint, noteFillAmount? })`.
- Cancel (creator): `client.pswap.cancelByOrder({ orderId: string|bigint })` (lineage-by-order valid only for the creator).
- Tag: top-level `buildSwapTag({ type?: 'public'|'private', offer: {token,amount}, request: {token,amount} }) -> NoteTag`. Register with `client.tags.add(tag.asU32())` (add takes a NUMBER).
- Discovery: `client.getConsumableNotes(accountId?) -> ConsumableNoteRecord[]`; each `.inputNoteRecord() -> InputNoteRecord`; order id = `details().recipient().serialNum().toFelts()[1].asInt()` (bigint) — compare stringified to the maker's persisted `extraInputs.orderId`.
- The wallet's in-page client: `getMidenClient()` (lib/miden/sdk/miden-client) -> MidenClientInterface; its `.client` is the SDK resource client (`.transactions`/`.pswap`/`.tags`/`getConsumableNotes`).

## M2 ANSWERED: swap tag is PAIR-keyed, not amount-keyed
`BuildSwapTagOptions` carries offer/request Assets, but NoteTag is 32-bit, so the tag keys on the token PAIR (+ note type), not the amounts. => a partial-fill REMAINDER note (same pair) keeps the SAME tag, so no re-tag needed for the 2nd fill (plan §4.2 conditional branch is unnecessary). [To be re-confirmed empirically in the spike by comparing asU32() of two same-pair/different-amount tags.]

## Environment
- Local stack UP via docker-compose (validator/sequencer/ntx-builder/tx-prover healthy); RPC http://localhost:57291 -> 200; prover :50052 open. Guardian profile NOT needed for standard-swap R0.
- miden-client 0.15.0 on PATH (resolveCliPath uses the installed one). E2E extension builds clean.
- Open (spike): whether pswapConsume needs an explicit `prover` or uses the client's configured localhost prover; public-note propagation + payback-claim latency (set poll timeouts).
