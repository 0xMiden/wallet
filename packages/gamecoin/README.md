# Funded GC claims (replacement protocol, offline proof)

`funded::funded_issuer_builder` builds a **new issuer** with atomic actual-fee refunds. A replacement issuer from commit `13ba2a1f3601b64fd37829c4d7923dab6bc100d1` is deployed on Testnet; CLI receipt/refund and failed-request reclaim are confirmed. Native automatic-claim acceptance remains separate. The older canonical-MINT probe below is retained as a comparison; its retained-surplus limitation does not describe the funded module.

Pinned protocol/standards/testing/transaction executor: **0.17.1**; Rust **1.98.1**. Run `cargo test --locked -- --nocapture`. No credentials or network writes are used. Public construction vectors are emitted by `cargo run --locked --example funded_vector`; the committed fixture is `fixtures/funded-claim.json`.

## Testnet acceptance identity

- Issuer: `0x97924b9a77ed54917ff6d6364ae661`; bare faucet `mtst1azteyju6wlk4fytl7mtrvjhxvy08nme2`.
- Code: `0x2898ac7fc97bcd7605db86fa839f2e0d8c96c74ed238769b76716dbcd22e47d5`.
- Genesis: `0x280189b64c3a22c9d8e6e6c2cd567f58c528fee3b73724a6d855066642d7e567`.
- Deployment committed at block 461926, transaction `0x5a870b9cb8cf435fcd10302bdf00a0b147a5e96701e2e967579484035a59d85a`.
- The first receipt contains 10 GC and 91 native units from a 210-unit budget after the actual 119-unit issuer fee; issuer reserves remain zero. Receipt consumption committed at block 461977. A duplicate request was rejected, then its 210-unit budget reclaimed at block 462014 with a separate 119-unit reclaim fee and no additional GC.
- Verification is proposed in [token-list #4](https://github.com/0xMiden/token-list/pull/4), not yet published. This identity is distinct from the older experimental GC asset. Construction fixtures use deterministic dummy accounts and are not deployment manifests.

## Funded request and exact accounting

A public `GC_CLAIM` note contains one native asset budget B and the claimant's immutable approval. Normal requests carry `NetworkAccountTarget(issuer, Always)`. Standard single-sig and GuardedMultisig senders execute the issuer fee-policy FPI; its zero quote means no additional fee-sponsorship note is emitted. The sender independently pays its own request transaction fee.

The issuer credits each request budget, validates the approved issuer code, network domain, authenticated sender, week, expiry and height, then atomically writes `bread::gc::weekly_claims[sender_suffix, sender_prefix, week, 0] = [1,0,0,0]` and creates a public canonical P2ID receipt with exactly **10,000,000 GC units (10 GC, six decimals)**. Custom authentication preserves canonical network note/script allowlists, effect, native payment, sponsorship conservation and nonce checks. Only funded claims and the canonical expiration transaction script are admitted.

After standard `fee::pay_fee` produces the actual native TX_FEE amount F, n requests divide it deterministically: q=floor(F/n), r=F mod n; input indices below r pay q+1 and the rest q. Every budget must independently cover its share. Each existing GC receipt receives exactly its own B-share native change. Initial issuer native reserves remain unchanged; no balance subsidizes another claim and no surplus is retained. A failed budget check rolls back the entire transaction and weekly entries. Request creation, receipt consumption and any reclaim transactions remain user-paid transactions with their own displayed fees.

Admission uses the intrinsic output bound `MAX_OUTPUT_NOTES_PER_TX-1` (one possible TX_FEE output). There is no arbitrary single-claim or small batch limit. Local 1, 2 and 16 claim transactions execute and conserve all budgets. A theoretical 1,023 claim transaction encounters the protocol's global 16 MiB advice limit; it is not a supported resource promise. Post-payment settlement has a checked allowance of `4096 + 16384*n` cycles passed into standard fee computation; tests also assert the paid fee covers the final measured transaction cycle tier. Node batching remains subject to normal protocol resource limits.

## One-time deployment bootstrap

`bootstrap_claim_note` constructs the same fully bound request with no attachments. Canonical single-sig funding therefore performs no foreign-account quote against an issuer that does not yet exist. The first manually submitted issuer execution accepts this shape only at initial nonce zero. All ordinary weekly, code, network, amount, fee and refund checks still apply. Once the issuer nonce is nonzero, an unrouted claim rejects before entitlement mutation; subsequent requests require the normal network-target attachment.

Bootstrap is permissionless: a front runner can only pay their own budget and receive their own normal weekly allocation. It cannot change owner, code or policy. The owner can remain a Bread account while a separate funded CLI claimant bootstraps without sharing Bread credentials. The local new-account test verifies missing foreign inclusion witness, nonce-zero success, nonce-one rejection and wrong issuer/code/network rejection. Deployment and node admission still require independent review and live evidence.

## Approval binding, clock and recovery

Storage has 36 felts: P2ID script root[0..4], derived receipt serial[4..8], GC asset ID[8..12], value[12..16], receipt tag[16], zero padding[17..20], claimant suffix/prefix[20..22], Monday week[22], expiry seconds[23], issuer code commitment[24..28], reclaim height[28], ABI version1[29], zero padding[30..32], network domain Word[32..36].

The receipt serial is Poseidon2 `hash_elements` of 56 felts: `[0x47435231,1,0,0] || claim_script_root || request_serial || metadata_word || attachments_commitment || initial_assets_commitment || storage[0..4] || storage[8..36]`. Both Rust construction and the VM recompute it. This binds budget, routing, full outer metadata, all attachments and every semantic approval field without circularly hashing the receipt serial. Changing any bound field requires a new receipt preimage; reclaiming one request cannot masquerade as another request's receipt.

Eligibility uses the reference timestamp and `floor((timestamp+259200)/604800)`. Approved semantics permit an authenticated Sunday-reference claim to commit Monday while consuming Sunday's allocation. A fresh Monday reference rejects that old approval; Monday requires a separately approved new week. Expiry also uses the reference clock. Protocol transaction expiration bounds reference-block staleness, not exact UTC inclusion time.

Before finite reclaim height H, only issuer execution may issue GC. At reference height>=H, only the authenticated original sender can reclaim the native budget, paying its own transaction fee and minting no GC. Existing issuer and reclaim proofs can overlap across reference heights; the same request nullifier prevents both committing. These are real local MockChain execution/commit tests, not live node scheduling evidence.

The public weekly map is the entitlement authority. Wallet recovery must pin network/genesis, issuer code and domain, obtain current public map proofs, and reconcile exact request nullifiers against the derived public receipt. No operator ledger or relay is an authority. Unsupported notes, extra outputs, wrong network/code/week/sender/asset and underfunded batch members fail closed. This issuer exposes no admitted administrative upgrade/configuration note; the earlier deployed issuer cannot be upgraded into this protocol.

## Verification boundary

Focused tests cover exact fee/refund accounting with zero and pre-existing reserves; zero fee and exact budget; duplicate rollback; wrong approval fields; sender-only reclaim; issuer/reclaim races; approved Sunday/Monday behavior; full request-to-receipt binding; real owner+Guardian funding approval; and standard FPI zero-quote behavior. Nonce-zero bootstrap and signed creation without a foreign issuer witness are covered locally. Real node automatic execution, SDK/mobile integration and deployment require separate evidence. Wallet activation stays disabled until those checks and independent review pass.

---

# Original canonical-MINT comparison probe

**Offline research only. No deployed asset, service, wallet activation, or Testnet acceptance.**

This crate proves a controlled public fungible issuer can atomically enforce a weekly allocation in its own storage while collecting user-funded native assets through standard fee sponsorship. It deliberately preserves canonical `AuthNetworkAccount`; no operator mint API, local cooldown, durable issuer ledger, or custom authentication fork is involved.

**Two product gates remain:** surplus sponsorship is retained by standard network authentication rather than refunded, and the clock is the transaction's reference block rather than its inclusion block. Do not enable Claim from this probe.

## Pinned surface

- `miden-protocol`, `miden-standards`, `miden-testing`: **0.17.1**.
- Official Rust **1.98.1**, minimal profile. `Cargo.lock` pins the remaining graph.
- Wallet SDK surface inspected separately: published `@miden-sdk/miden-sdk` **0.17.5**. The local protocol/web-sdk checkouts were older; they were not used as version evidence.

Run:

```sh
cargo test --locked -- --nocapture
```

No credentials or RPC endpoint are used. The test funds fixture accounts/notes in genesis, then executes real protocol transactions. These are local proofs, not network transactions.

## Issuer and claims

`issuer_builder(seed, owner, fee_faucet)` returns an account builder without deploying it. The caller must supply the chain's native fee faucet. Configuration is illustrative and requires deployment review: symbol GC, six decimals, allocation **10,000,000 base units = 10 GC**, maximum supply 1,000,000 GC. The only registered mint policy is this crate's weekly policy. Owner configuration uses `Ownable2Step`; deployment key/owner custody is outside this crate. Send/receive transfer policies are omitted, so the asset has ordinary callback-free fungible transfers. Transfer execution is not tested here.

A public canonical MINT note commits to the complete public P2ID receipt preimage. P2ID storage is `[recipient_suffix, recipient_prefix, salt_0, salt_1]`; its salt does not alter who may consume it. This probe uses the immutable salt fields as `[target_week, approval_expiry_unix_seconds]`.

The custom mint policy checks:

1. Active request script is canonical MINT and its public storage has exactly 24 elements.
2. Receipt script is canonical P2ID and receipt account equals the authenticated MINT note sender.
3. Reference timestamp is no later than the approved expiry and `floor((timestamp + 259200) / 604800)` equals the signed target week.
4. Mint amount is exactly 10,000,000 base units.
5. `bread::gc::weekly_claims[sender_suffix, sender_prefix, week, 0]` is empty; writes `[1, 0, 0, 0]` before minting.

Storage update, issuance and fee collection occur in one issuer transaction. If any assertion fails, no account patch is accepted. Concurrent issuer transactions still require normal node state-conflict handling; the public map is the entitlement authority. The asset/issuer and blockchain context provide network separation; wallets must bind approval/configuration to the intended network and issuer. No deployed issuer identity is invented here.

## Fees: proven funding and unresolved surplus

The user creates a MINT request and a `FeeSponsorshipNote` bound to that exact request NoteId. Standard sponsorship refuses collection without that request; standard network authentication requires the sponsorship to cover its current fee-policy quote. Top-ups can use another sponsorship bound to the same request.

The custom fee policy uses the current reference block's kernel fee computation to derive a conservative maximum. Protocol transactions are bounded at 2^29 execution cycles, so network fees are at most 30 times the reference verification base fee. Adding 2^28 cycles to `tx::compute_fee` produces 29 base-fee units for the bounded normal execution range; division by 29 must fit a u32 and multiplication by 30 produces the maximum fee budget. Above the bounded range the kernel computation or quotient check aborts. This is a research fee bound, not a quote of actual consumed fees.

A real canonical `AuthNetworkAccount::estimate_note_fee` FPI from another signed account successfully returns 3,000 at verification base fee 100. The network mint transaction accepts 10,000 sponsored native units, emits a 1,600-unit TX_FEE note, and retains 8,400. The issuer starts with **zero** native assets. A later request sponsoring only 100 fails even with that 8,400-unit reserve, because current per-request coverage is enforced.

`AtMostCollectedFees` alone only limits sponsorship of downstream network notes; it does not prevent paying the issuer's own fees from reserves. The custom fee floor is what closes that particular underfunding path in this probe.

Full accounting required for an accepted feature:

| Transaction | Technical payer | Funding / status |
| --- | --- | --- |
| User creates request and sponsorship | User account | User native vault; SDK request/sign/prove path still needs an integrated test |
| Issuer consumes request and mints receipt | Issuer account | Bound user sponsorship enters vault before authentication pays TX_FEE; proven from zero issuer balance |
| User consumes GC receipt | User account | User native vault or separately user-funded native note; generic receive probe proves 100,000 incoming native units can pay 1,700 receipt fee and leave 98,300 |
| Reclaim failed/duplicate/expired sponsorship | Reclaimer's account | User pays reclaim transaction fee; sponsorship supports `reclaim_height`, but reclaim execution is not covered by these tests |
| Refund unused successful-claim budget | **Unimplemented** | Standard auth retains surplus; a fee-policy hook has no post-payment refund callback |

The 8,400-unit surplus is not an actual network fee and must not be presented as one or silently donated. Exact actual-fee refund, including its own costs and atomic recovery, remains unproven. No production payment design is selected.

## Clock and recovery

The authoritative timestamp is `tx::get_block_timestamp`: seconds since UNIX epoch for the **reference block**. The Monday formula is correct for that timestamp.

The test proves a specific limitation: MINT and sponsorship notes already committed in a pre-Monday genesis block are consumed with authenticated inputs by a transaction referencing that block; that transaction is then proved/applied in a block timestamped Monday. The prior-week allocation survives late inclusion. This does **not** demonstrate creating an authenticated new Monday request against a Sunday reference block. Fresh Monday references reject old-week approvals and accept a new explicit approval. Standard network transaction expiration is 20 blocks; this is a block-count limit, not an exact UTC duration.

Decide whether delayed already-funded pre-Monday approvals may complete after Monday. Strict inclusion-time expiry is not supplied by this reference-clock policy. Reusing an old approval for the new week is never allowed.

After recovery/reinstall, the canonical eligibility read is a fresh public account storage proof for the named map and `[sender_suffix, sender_prefix, week, 0]`; unknown/offline remains unknown. SDK 0.17.5 exposes `RpcClient.getAccountProof`, `AccountStorageRequirements`, map-key requirements and `AccountProof.getStorageMapEntries`; local `AccountStorage.getMapItem` is only as fresh as its sync.

Pending requests require public MINT-note discovery under the issuer's account-target tag, exact sender/issuer/script/storage filtering, and note/nullifier reconciliation. SDK `syncNotes` / `getNotesById` provide underlying public reads. A wallet's ordinary recipient-tag sync does not automatically rediscover its old outgoing issuer-targeted MINT notes. A restart-safe index/history service or explicit issuer-tag rescan is still implementation work; it is not an entitlement authority. Replayed or duplicate requests cannot mint again, but their unconsumed sponsorships still need reclaim handling.

## SDK 0.17.5 construction surface

The published typings expose all pieces needed to construct the intended note preimages:

- `new NoteStorage(new FeltArray([...]))` and `new NoteRecipient(serial, NoteScript.p2id(), storage)` allow explicit P2ID salts.
- `NoteScript.mint()` plus the canonical public 24-element MINT storage layout constructs the outer recipient. There is no dedicated JS `MintNote` builder in this published surface.
- `client.transactions.createNetworkNote({ account, target: issuer, recipient })` builds a Public network-targeted output; its JS source calls `TransactionRequestBuilder.withOwnOutputNotes` and includes the target as a foreign account.
- `AccountComponent.createNetworkAuthComponents`, `NoteScriptFee`, `withOwnOutputNotes`, `withForeignAccounts`, and existing SDK fee-aware auth facilities are available.

These JS construction paths were inspected in the exact published package; they have not been executed in Bread or submitted to Testnet. The Rust FPI quote test proves the protocol hook, not a complete SDK/browser/mobile request.

## Evidence covered

The integration test asserts initial and final native balances, exact GC receipt assets/recipient/target tag, TX_FEE amount, native conservation, and the written weekly map entry. It executes: signed receipt funding; canonical foreign fee quote; controlled 10-GC mint with six decimals, zero initial issuer fee assets, and atomic weekly map update; duplicate week; other recipient; previous/future/u32-max week; expired approval; wrong amount; underfunding despite existing issuer reserves; a successful retry proving failed checks did not reserve entitlement; canonical authentication rejecting arbitrary transaction scripts; authenticated pre-Monday request included Monday; fresh next-week approval; stale approval rejection at a fresh Monday reference.

Not covered: actual user request creation/sponsorship generation, issuer deployment/registration costs, same-account concurrent node submission, network executor scheduling, historical public-note discovery, reclaim, exact fee refunds, ordinary GC transfer, real wallet proving, or Testnet acceptance. This draft is a reproducible architecture test, not a completed claim service.
