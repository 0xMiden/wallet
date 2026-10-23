use bread_gamecoin::distributor::{FundedClaim, claim_note, distributor_builder};
use miden_protocol::crypto::SequentialCommit;
use miden_protocol::{Word, asset::AssetId, note::NoteTag, transaction::RawOutputNote};
use miden_standards::note::TxFeeNote;
use miden_testing::{Auth, MockChain};

// Omitting the post-payment refund, or charging one claimant another's share, must fail this test.
#[tokio::test]
async fn actual_fee_and_each_refund_conserve_one_and_two_claim_budgets() -> anyhow::Result<()> {
    for n in [1usize, 2, 16] {
        let mut b = MockChain::builder().verification_base_fee(7);
        let native = miden_protocol::testing::account_id::ACCOUNT_ID_FEE_FAUCET.try_into()?;
        let domain = Word::from([17u32, 18, 19, 20]);
        let mut users = Vec::new();
        for _ in 0..n {
            users.push(b.add_existing_wallet(Auth::default())?);
        }
        let distributor = distributor_builder([42; 32], gc(), native, domain)?
            .with_assets([miden_protocol::asset::FungibleAsset::new(gc(), 1_000_000_000)?.into()])
            .build_existing()?;
        b.add_account(distributor.clone())?;
        let mut requests = Vec::new();
        for (i, user) in users.iter().enumerate() {
            let request = claim_note(&FundedClaim {
                distributor: distributor.id(),
                gc_faucet: gc(),
                native,
                distributor_code: distributor.code().commitment(),
                network: domain,
                sender: user.id(),
                week: (MockChain::TIMESTAMP_START_SECS + 259200) / 604800,
                expiry: MockChain::TIMESTAMP_START_SECS + 3600,
                reclaim_height: 100,
                receipt_tag: NoteTag::with_account_target(user.id()),
                budget: 1000 + i as u64,
                serial: Word::from([i as u32 + 1, 2, 3, 4]),
            })?;
            b.add_output_note(RawOutputNote::Full(request.clone()));
            requests.push(request);
        }
        let chain = b.build()?;
        let tx = chain
            .build_transaction(distributor.id())
            .authenticated_input_notes(requests.iter().map(|x| x.id()))
            .build()?
            .execute()
            .await?;
        let mut updated = distributor.clone();
        updated.apply_patch(tx.account_patch())?;
        assert_eq!(
            updated
                .vault()
                .get_balance(AssetId::new_fungible(gc()))?
                .as_u64(),
            1_000_000_000 - n as u64 * 10_000_000
        );
        assert_eq!(
            updated
                .vault()
                .get_balance(AssetId::new_fungible(native))?
                .as_u64(),
            0,
            "distributor retained surplus or spent reserves"
        );
        let fee: u64 = tx
            .output_notes()
            .iter()
            .filter(|x| {
                x.recipient()
                    .is_some_and(|r| r.script().root() == TxFeeNote::script_root())
            })
            .flat_map(|x| x.assets().iter_fungible())
            .map(|a| a.amount().as_u64())
            .sum();
        println!(
            "N={n} actual_fee={fee} total_cycles={} auth_cycles={}",
            tx.measurements().total_cycles(),
            tx.measurements().auth_procedure
        );
        assert!(
            fee >= 7 * (tx.measurements().total_cycles().ilog2() as u64 + 1),
            "fee underpaid final proof cycles"
        );
        assert!(fee > 0);
        assert_eq!(tx.output_notes().num_notes(), n + 1);
        for (i, receipt) in tx.output_notes().iter().take(n).enumerate() {
            assert_eq!(
                receipt
                    .assets()
                    .iter_fungible()
                    .find(|a| a.faucet_id() == gc())
                    .unwrap()
                    .amount()
                    .as_u64(),
                10000000
            );
            let refund = receipt
                .assets()
                .iter_fungible()
                .find(|a| a.faucet_id() == native)
                .map(|a| a.amount().as_u64())
                .unwrap_or(0);
            let charge = fee / n as u64 + u64::from((i as u64) < fee % n as u64);
            assert_eq!(refund, 1000 + i as u64 - charge);
            assert_eq!(
                receipt.metadata().tag(),
                NoteTag::with_account_target(users[i].id())
            );
        }
    }
    Ok(())
}

struct Fixture {
    chain: miden_testing::MockChain,
    distributor: miden_protocol::account::Account,
    users: Vec<miden_protocol::account::Account>,
    notes: Vec<miden_protocol::note::Note>,
    native: miden_protocol::account::AccountId,
}
fn fixture(
    budgets: &[u64],
    reserve: u64,
    base: u32,
    mut change: impl FnMut(usize, &mut FundedClaim),
) -> anyhow::Result<Fixture> {
    use miden_protocol::asset::{Asset, FungibleAsset};
    let mut b = MockChain::builder().verification_base_fee(base);
    let native = miden_protocol::testing::account_id::ACCOUNT_ID_FEE_FAUCET.try_into()?;
    let domain = Word::from([17u32, 18, 19, 20]);
    let mut users = Vec::new();
    for _ in budgets {
        users.push(b.add_existing_wallet_with_assets(
            Auth::default(),
            [Asset::from(FungibleAsset::new(native, 100000)?)],
        )?);
    }
    let assets = if reserve == 0 {
        vec![]
    } else {
        vec![Asset::from(FungibleAsset::new(native, reserve)?)]
    };
    let distributor = distributor_builder([42; 32], gc(), native, domain)?
        .with_assets(
            assets
                .into_iter()
                .chain([Asset::from(FungibleAsset::new(gc(), 1_000_000_000)?)]),
        )
        .build_existing()?;
    b.add_account(distributor.clone())?;
    let mut notes = Vec::new();
    for (i, user) in users.iter().enumerate() {
        let mut c = FundedClaim {
            distributor: distributor.id(),
            gc_faucet: gc(),
            native,
            distributor_code: distributor.code().commitment(),
            network: domain,
            sender: user.id(),
            week: (MockChain::TIMESTAMP_START_SECS + 259200) / 604800,
            expiry: MockChain::TIMESTAMP_START_SECS + 3600,
            reclaim_height: 3,
            receipt_tag: NoteTag::with_account_target(user.id()),
            budget: budgets[i],
            serial: Word::from([i as u32 + 1, 2, 3, 4]),
        };
        change(i, &mut c);
        let note = claim_note(&c)?;
        b.add_output_note(RawOutputNote::Full(note.clone()));
        notes.push(note);
    }
    Ok(Fixture {
        chain: b.build()?,
        distributor,
        users,
        notes,
        native,
    })
}
async fn execute(f: &Fixture) -> anyhow::Result<miden_protocol::transaction::ExecutedTransaction> {
    Ok(f.chain
        .build_transaction(f.distributor.id())
        .authenticated_input_notes(f.notes.iter().map(|x| x.id()))
        .build()?
        .execute()
        .await?)
}
fn paid_fee(tx: &miden_protocol::transaction::ExecutedTransaction) -> u64 {
    tx.output_notes()
        .iter()
        .filter(|x| {
            x.recipient()
                .is_some_and(|r| r.script().root() == TxFeeNote::script_root())
        })
        .flat_map(|x| x.assets().iter_fungible())
        .map(|a| a.amount().as_u64())
        .sum()
}

#[tokio::test]
async fn reserves_never_subsidize_underfunded_claim_or_batch_member() -> anyhow::Result<()> {
    let valid = fixture(&[1000], 50000, 7, |_, _| {})?;
    let tx = execute(&valid).await?;
    let mut a = valid.distributor.clone();
    a.apply_patch(tx.account_patch())?;
    assert_eq!(
        a.vault()
            .get_balance(AssetId::new_fungible(valid.native))?
            .as_u64(),
        50000
    );
    for budgets in [&[1u64][..], &[10000u64, 1][..], &[1u64, 10000][..]] {
        let f = fixture(budgets, 50000, 7, |_, _| {})?;
        assert!(
            execute(&f).await.is_err(),
            "old reserve or another user's budget subsidized claimant"
        );
        assert_eq!(
            f.distributor
                .vault()
                .get_balance(AssetId::new_fungible(f.native))?
                .as_u64(),
            50000
        );
    }
    Ok(())
}
#[tokio::test]
async fn exact_budget_returns_only_gc_and_zero_base_fee_returns_entire_budget() -> anyhow::Result<()>
{
    let estimate = fixture(&[1000], 0, 7, |_, _| {})?;
    let fee = paid_fee(&execute(&estimate).await?);
    let exact = fixture(&[fee], 0, 7, |_, _| {})?;
    let tx = execute(&exact).await?;
    assert_eq!(paid_fee(&tx), fee);
    assert_eq!(tx.output_notes().get_note(0).assets().num_assets(), 1);
    let zero = fixture(&[1000, 2000], 0, 0, |_, _| {})?;
    let tx = execute(&zero).await?;
    assert_eq!(paid_fee(&tx), 0);
    assert_eq!(tx.output_notes().num_notes(), 2);
    for (i, n) in tx.output_notes().iter().enumerate() {
        assert_eq!(
            n.assets()
                .iter_fungible()
                .find(|a| a.faucet_id() == zero.native)
                .unwrap()
                .amount()
                .as_u64(),
            [1000, 2000][i]
        );
    }
    Ok(())
}
#[tokio::test]
async fn wrong_code_network_week_expiry_native_or_sender_cannot_issue() -> anyhow::Result<()> {
    for label in ["code", "network", "week", "expiry", "native", "sender"] {
        let mut f = fixture(&[1000], 50000, 7, |_, c| match label {
            "code" => c.distributor_code = Word::empty(),
            "network" => c.network = Word::empty(),
            "week" => c.week += 1,
            "expiry" => c.expiry = 1,
            "native" => c.native = c.distributor,
            _ => {}
        })?;
        if label == "sender" {
            let n = &f.notes[0];
            let bad = miden_protocol::note::Note::with_attachments(
                n.assets().clone(),
                miden_protocol::note::PartialNoteMetadata::new(
                    f.distributor.id(),
                    miden_protocol::note::NoteType::Public,
                )
                .with_tag(n.metadata().tag()),
                n.recipient().clone(),
                n.attachments().clone(),
            );
            f.notes[0] = bad;
        }
        let result = if label == "sender" {
            f.chain
                .build_transaction(f.distributor.id())
                .unauthenticated_input_notes(f.notes.clone())
                .build()?
                .execute()
                .await
        } else {
            f.chain
                .build_transaction(f.distributor.id())
                .authenticated_input_notes(f.notes.iter().map(|x| x.id()))
                .build()?
                .execute()
                .await
        };
        assert!(result.is_err(), "accepted invalid {label}");
    }
    Ok(())
}

#[tokio::test]
async fn duplicate_week_rolls_back_whole_batch_and_cannot_reuse_committed_entitlement()
-> anyhow::Result<()> {
    let mut first = None;
    let f = fixture(&[1000, 1000], 0, 7, |i, c| {
        if i == 0 {
            first = Some(c.sender)
        } else {
            c.sender = first.unwrap();
            c.receipt_tag = NoteTag::with_account_target(c.sender)
        }
    })?;
    assert!(execute(&f).await.is_err());
    let tx = f
        .chain
        .build_transaction(f.distributor.id())
        .authenticated_input_note(f.notes[0].id())
        .build()?
        .execute()
        .await?;
    let mut updated = f.distributor.clone();
    updated.apply_patch(tx.account_patch())?;
    let slot =
        miden_protocol::account::StorageSlotName::new(bread_gamecoin::distributor::CLAIMS_SLOT)?;
    let key = miden_protocol::account::StorageMapKey::new(Word::from([
        f.users[0].id().suffix(),
        f.users[0].id().prefix().as_felt(),
        ((MockChain::TIMESTAMP_START_SECS + 259200) / 604800).into(),
        0u32.into(),
    ]));
    assert_eq!(
        updated.storage().get_map_item(&slot, key)?,
        Word::from([1u32, 0, 0, 0])
    );
    assert!(
        f.chain
            .build_transaction(updated)
            .authenticated_input_note(f.notes[1].id())
            .build()?
            .execute()
            .await
            .is_err()
    );
    Ok(())
}
#[tokio::test]
async fn reclaim_is_sender_only_after_height_and_never_mints() -> anyhow::Result<()> {
    let mut f = fixture(&[1000], 0, 7, |_, _| {})?;
    let (args, preimage) = miden_standards::account::auth::commit_fee_conversion_info(
        miden_standards::account::auth::FeeConversionInfo::one_to_one(f.native),
        Word::empty(),
    );
    assert!(
        f.chain
            .build_transaction(f.users[0].id())
            .authenticated_input_note(f.notes[0].id())
            .auth_args(args)
            .add_advice_map_entry(args, preimage.clone())
            .build()?
            .execute()
            .await
            .is_err()
    );
    f.chain.prove_until_block(3u32)?;
    let tx = f
        .chain
        .build_transaction(f.users[0].id())
        .authenticated_input_note(f.notes[0].id())
        .auth_args(args)
        .add_advice_map_entry(args, preimage)
        .build()?
        .execute()
        .await?;
    let mut updated = f.users[0].clone();
    updated.apply_patch(tx.account_patch())?;
    assert_eq!(
        updated
            .vault()
            .get_balance(AssetId::new_fungible(gc()))?
            .as_u64(),
        0
    );
    assert_eq!(
        updated
            .vault()
            .get_balance(AssetId::new_fungible(f.native))?
            .as_u64(),
        101000 - paid_fee(&tx)
    );
    assert!(
        execute(&f).await.is_err(),
        "distributor consumed against reference after reclaim height"
    );
    Ok(())
}
#[tokio::test]
async fn competing_distributor_and_reclaim_proofs_have_only_one_committed_winner()
-> anyhow::Result<()> {
    for distributor_wins in [true, false] {
        let mut f = fixture(&[1000], 0, 7, |_, _| {})?;
        let issue = execute(&f).await?;
        f.chain.prove_until_block(3u32)?;
        let (args, p) = miden_standards::account::auth::commit_fee_conversion_info(
            miden_standards::account::auth::FeeConversionInfo::one_to_one(f.native),
            Word::empty(),
        );
        let reclaim = f
            .chain
            .build_transaction(f.users[0].id())
            .authenticated_input_note(f.notes[0].id())
            .auth_args(args)
            .add_advice_map_entry(args, p)
            .build()?
            .execute()
            .await?;
        let (winner, loser) = if distributor_wins {
            (&issue, &reclaim)
        } else {
            (&reclaim, &issue)
        };
        f.chain.add_pending_executed_transaction(winner)?;
        f.chain.prove_next_block()?;
        assert!(f.chain.is_note_consumed(&f.notes[0].nullifier()));
        f.chain.add_pending_executed_transaction(loser)?;
        assert!(
            f.chain.prove_next_block().is_err(),
            "same note consumed twice"
        );
    }
    Ok(())
}
#[tokio::test]
async fn authenticated_sunday_reference_can_commit_monday_but_old_approval_rejects_monday_reference()
-> anyhow::Result<()> {
    let week = (MockChain::TIMESTAMP_START_SECS + 259200) / 604800;
    let monday = (week + 1) * 604800 - 259200;
    let mut f = fixture(&[1000, 1000], 0, 7, |_, c| {
        c.expiry = monday + 86400;
        c.reclaim_height = 100;
    })?;
    f.chain.prove_next_block_at(monday - 1)?;
    let sunday = f
        .chain
        .build_transaction(f.distributor.id())
        .authenticated_input_note(f.notes[0].id())
        .build()?
        .execute()
        .await?;
    f.chain.add_pending_executed_transaction(&sunday)?;
    f.chain.prove_next_block_at(monday)?;
    assert!(f.chain.is_note_consumed(&f.notes[0].nullifier()));
    assert!(
        f.chain
            .build_transaction(f.distributor.id())
            .authenticated_input_note(f.notes[1].id())
            .build()?
            .execute()
            .await
            .is_err()
    );
    Ok(())
}

fn gc() -> miden_protocol::account::AccountId {
    miden_protocol::account::AccountId::from_hex("0xe1f2c48d5bfa8d5173dfcfdc8ac977").unwrap()
}

fn deposit(f: &Fixture, amount: u64, budget: u64) -> anyhow::Result<miden_protocol::note::Note> {
    bread_gamecoin::distributor::deposit_note(&bread_gamecoin::distributor::FundedDeposit {
        distributor: f.distributor.id(),
        gc_faucet: gc(),
        native: f.native,
        distributor_code: f.distributor.code().commitment(),
        network: Word::from([17u32, 18, 19, 20]),
        sender: f.users[0].id(),
        reclaim_height: 100,
        receipt_tag: NoteTag::with_account_target(f.users[0].id()),
        amount,
        budget,
        serial: Word::from([91u32, 92, 93, 94]),
    })
}
#[tokio::test]
async fn refill_credits_inventory_returns_actual_fee_surplus_and_never_claims() -> anyhow::Result<()>
{
    let f = fixture(&[1000], 50000, 7, |_, _| {})?;
    let n = deposit(&f, 20_000_000, 1000)?;
    let tx = f
        .chain
        .build_transaction(f.distributor.id())
        .unauthenticated_input_notes([n])
        .build()?
        .execute()
        .await?;
    let mut updated = f.distributor.clone();
    updated.apply_patch(tx.account_patch())?;
    assert_eq!(
        updated
            .vault()
            .get_balance(AssetId::new_fungible(gc()))?
            .as_u64(),
        1_020_000_000
    );
    assert_eq!(
        updated
            .vault()
            .get_balance(AssetId::new_fungible(f.native))?
            .as_u64(),
        50000
    );
    let receipt = tx.output_notes().get_note(0);
    assert_eq!(receipt.assets().num_assets(), 1);
    assert_eq!(
        receipt
            .assets()
            .iter_fungible()
            .next()
            .unwrap()
            .amount()
            .as_u64(),
        1000 - paid_fee(&tx)
    );
    assert_eq!(receipt.metadata().sender(), f.distributor.id());
    f.chain
        .build_transaction(updated)
        .authenticated_input_note(f.notes[0].id())
        .build()?
        .execute()
        .await?;
    Ok(())
}
#[tokio::test]
async fn deposit_asset_descriptor_must_match_actual_canonical_gc() -> anyhow::Result<()> {
    use miden_protocol::note::{Note, NoteRecipient, NoteStorage, NoteType, PartialNoteMetadata};
    use miden_protocol::{Felt, Hasher};
    let f = fixture(&[1000], 0, 7, |_, _| {})?;
    let n = deposit(&f, 20_000_000, 1000)?;
    let mut fields = n.recipient().storage().items().to_vec();
    fields[12] = Felt::from(19_000_000u32);
    // Rebind the complete note, so rejection tests the deposit's asset contract.
    let mut elements = vec![
        Felt::from(bread_gamecoin::distributor::DEPOSIT_DOMAIN_TAG),
        Felt::from(2u32),
        Felt::ZERO,
        Felt::ZERO,
    ];
    elements.extend_from_slice(n.script().root().as_elements());
    elements.extend_from_slice(n.recipient().serial_num().as_elements());
    elements.extend_from_slice(n.metadata().to_metadata_word().as_elements());
    elements.extend_from_slice(n.metadata().attachments_commitment().as_elements());
    elements.extend_from_slice(n.assets().commitment().as_elements());
    elements.extend_from_slice(&fields[..4]);
    elements.extend_from_slice(&fields[8..]);
    fields[4..8].copy_from_slice(Hasher::hash_elements(&elements).as_elements());
    let bad = Note::with_attachments(
        n.assets().clone(),
        PartialNoteMetadata::new(n.metadata().sender(), NoteType::Public)
            .with_tag(n.metadata().tag()),
        NoteRecipient::new(
            n.recipient().serial_num(),
            n.script().clone(),
            NoteStorage::new(fields)?,
        ),
        n.attachments().clone(),
    );
    assert!(
        f.chain
            .build_transaction(f.distributor.id())
            .unauthenticated_input_notes([bad])
            .build()?
            .execute()
            .await
            .is_err(),
        "deposit descriptor mismatch accepted"
    );
    Ok(())
}
#[tokio::test]
async fn insufficient_inventory_does_not_consume_budget_or_entitlement() -> anyhow::Result<()> {
    let mut f = fixture(&[1000], 0, 7, |_, _| {})?;
    let empty = bread_gamecoin::distributor::distributor_builder(
        [42; 32],
        gc(),
        f.native,
        Word::from([17u32, 18, 19, 20]),
    )?
    .build_existing()?;
    assert_eq!(empty.id(), f.distributor.id());
    let err = f
        .chain
        .build_transaction(empty)
        .authenticated_input_note(f.notes[0].id())
        .build()?
        .execute()
        .await
        .unwrap_err();
    println!("inventory rejection: {err:#}");
    assert!(!f.chain.is_note_consumed(&f.notes[0].nullifier()));
    f.chain.prove_until_block(3u32)?;
    let (args, p) = miden_standards::account::auth::commit_fee_conversion_info(
        miden_standards::account::auth::FeeConversionInfo::one_to_one(f.native),
        Word::empty(),
    );
    f.chain
        .build_transaction(f.users[0].id())
        .authenticated_input_note(f.notes[0].id())
        .auth_args(args)
        .add_advice_map_entry(args, p)
        .build()?
        .execute()
        .await?;
    Ok(())
}

#[tokio::test]
async fn bootstrap_deposit_creates_account_then_only_routed_refills_work() -> anyhow::Result<()> {
    use bread_gamecoin::distributor::{FundedDeposit, bootstrap_deposit_note};
    let mut b = MockChain::builder().verification_base_fee(7);
    let native = miden_protocol::testing::account_id::ACCOUNT_ID_FEE_FAUCET.try_into()?;
    let user = b.add_existing_wallet(Auth::default())?;
    let domain = Word::from([17u32, 18, 19, 20]);
    let distributor = distributor_builder([42; 32], gc(), native, domain)?.build()?;
    assert!(distributor.is_new());
    assert!(distributor.seed().is_some());
    let c = FundedDeposit {
        distributor: distributor.id(),
        gc_faucet: gc(),
        native,
        distributor_code: distributor.code().commitment(),
        network: domain,
        sender: user.id(),
        reclaim_height: 100,
        receipt_tag: NoteTag::with_account_target(user.id()),
        amount: 20_000_000,
        budget: 1000,
        serial: Word::from([1u32, 2, 3, 4]),
    };
    let note = bootstrap_deposit_note(&c)?;
    b.add_output_note(RawOutputNote::Full(note.clone()));
    let mut chain = b.build()?;
    assert!(
        chain
            .get_foreign_account_inputs(distributor.clone())
            .is_err()
    );
    let tx = chain
        .build_transaction(distributor.clone())
        .authenticated_input_note(note.id())
        .build()?
        .execute()
        .await?;
    let mut created = distributor.clone();
    created.apply_patch(tx.account_patch())?;
    assert!(!created.is_new());
    assert_eq!(created.nonce(), miden_protocol::Felt::ONE);
    assert_eq!(
        created
            .vault()
            .get_balance(AssetId::new_fungible(gc()))?
            .as_u64(),
        20_000_000
    );
    assert_eq!(
        created
            .vault()
            .get_balance(AssetId::new_fungible(native))?
            .as_u64(),
        0
    );
    let err = chain
        .build_transaction(created.clone())
        .authenticated_input_note(note.id())
        .build()?
        .execute()
        .await
        .unwrap_err();
    assert!(format!("{err:#}").contains("unrouted deposit only at creation"));
    chain.add_pending_executed_transaction(&tx)?;
    chain.prove_next_block()?;
    let routed = bread_gamecoin::distributor::deposit_note(&FundedDeposit {
        serial: Word::from([5u32, 6, 7, 8]),
        ..c
    })?;
    let refill = chain
        .build_transaction(created.clone())
        .unauthenticated_input_notes([routed])
        .build()?
        .execute()
        .await?;
    created.apply_patch(refill.account_patch())?;
    assert_eq!(
        created
            .vault()
            .get_balance(AssetId::new_fungible(gc()))?
            .as_u64(),
        40_000_000
    );
    Ok(())
}

#[tokio::test]
async fn deposit_exact_budget_requires_positive_refund_and_mixed_batches_reject()
-> anyhow::Result<()> {
    let f = fixture(&[1000], 50000, 7, |_, _| {})?;
    let tx = f
        .chain
        .build_transaction(f.distributor.id())
        .unauthenticated_input_notes([deposit(&f, 20_000_000, 1000)?])
        .build()?
        .execute()
        .await?;
    let fee = paid_fee(&tx);
    let result = f
        .chain
        .build_transaction(f.distributor.id())
        .unauthenticated_input_notes([deposit(&f, 20_000_000, fee)?])
        .build()?
        .execute()
        .await;
    assert!(
        format!("{:#}", result.unwrap_err()).contains("deposit requires positive native refund")
    );
    for notes in [
        vec![f.notes[0].clone(), deposit(&f, 20_000_000, 1000)?],
        vec![deposit(&f, 20_000_000, 1000)?, f.notes[0].clone()],
    ] {
        assert!(
            f.chain
                .build_transaction(f.distributor.id())
                .unauthenticated_input_notes(notes)
                .build()?
                .execute()
                .await
                .is_err()
        );
    }
    Ok(())
}

#[test]
fn callbacks_and_equal_faucets_are_rejected_before_building() -> anyhow::Result<()> {
    use miden_protocol::{Felt, account::AccountId};
    let native = miden_protocol::testing::account_id::ACCOUNT_ID_FEE_FAUCET.try_into()?;
    let callbacks = AccountId::try_from_elements(
        gc().suffix(),
        Felt::new(gc().prefix().as_felt().as_canonical_u64() | 32)?,
    )?;
    assert!(callbacks.asset_callback_flag().is_enabled());
    assert!(distributor_builder([42; 32], callbacks, native, Word::empty()).is_err());
    assert!(distributor_builder([42; 32], gc(), gc(), Word::empty()).is_err());
    Ok(())
}

#[tokio::test]
async fn arbitrary_transaction_scripts_and_unrelated_p2id_cannot_withdraw_or_mint()
-> anyhow::Result<()> {
    let f = fixture(&[1000], 50000, 7, |_, _| {})?;
    let bypass = miden_standards::code_builder::CodeBuilder::default()
        .compile_tx_script("@transaction_script pub proc main dropw end")?;
    assert!(
        f.chain
            .build_transaction(f.distributor.id())
            .authenticated_input_note(f.notes[0].id())
            .tx_script(bypass)
            .build()?
            .execute()
            .await
            .is_err()
    );
    let unrelated: miden_protocol::note::Note = miden_standards::note::P2idNote::builder()
        .sender(f.users[0].id())
        .target(f.distributor.id())
        .serial_number(Word::from([4u32, 3, 2, 1]))
        .salt([0u32.into(), 0u32.into()])
        .assets([miden_protocol::asset::FungibleAsset::new(f.native, 1000)?])
        .note_type(miden_protocol::note::NoteType::Public)
        .build()?
        .into();
    assert!(
        f.chain
            .build_transaction(f.distributor.id())
            .unauthenticated_input_notes([unrelated])
            .build()?
            .execute()
            .await
            .is_err()
    );
    let tx = execute(&f).await?;
    let mut updated = f.distributor.clone();
    updated.apply_patch(tx.account_patch())?;
    assert_eq!(
        updated
            .vault()
            .get_balance(AssetId::new_fungible(gc()))?
            .as_u64(),
        990_000_000
    );
    assert_eq!(
        updated
            .vault()
            .get_balance(AssetId::new_fungible(f.distributor.id()))?
            .as_u64(),
        0
    );
    Ok(())
}

fn edited_note(
    n: &miden_protocol::note::Note,
    index: usize,
    value: miden_protocol::Felt,
) -> anyhow::Result<miden_protocol::note::Note> {
    use miden_protocol::{
        Felt, Hasher,
        note::{Note, NoteRecipient, NoteStorage, NoteType, PartialNoteMetadata},
    };
    let mut fields = n.recipient().storage().items().to_vec();
    fields[index] = value;
    let domain = if n.script().root() == bread_gamecoin::distributor::claim_script()?.root() {
        bread_gamecoin::distributor::RECEIPT_DOMAIN_TAG
    } else {
        bread_gamecoin::distributor::DEPOSIT_DOMAIN_TAG
    };
    let mut elements = vec![Felt::from(domain), Felt::from(2u32), Felt::ZERO, Felt::ZERO];
    elements.extend_from_slice(n.script().root().as_elements());
    elements.extend_from_slice(n.recipient().serial_num().as_elements());
    elements.extend_from_slice(n.metadata().to_metadata_word().as_elements());
    elements.extend_from_slice(n.metadata().attachments_commitment().as_elements());
    elements.extend_from_slice(n.assets().commitment().as_elements());
    elements.extend_from_slice(&fields[..4]);
    elements.extend_from_slice(&fields[8..]);
    fields[4..8].copy_from_slice(Hasher::hash_elements(&elements).as_elements());
    Ok(Note::with_attachments(
        n.assets().clone(),
        PartialNoteMetadata::new(n.metadata().sender(), NoteType::Public)
            .with_tag(n.metadata().tag()),
        NoteRecipient::new(
            n.recipient().serial_num(),
            n.script().clone(),
            NoteStorage::new(fields)?,
        ),
        n.attachments().clone(),
    ))
}
#[tokio::test]
async fn v2_rejects_wrong_faucet_receiver_version_allocation_and_deposit_network_code()
-> anyhow::Result<()> {
    use miden_protocol::Felt;
    let f = fixture(&[1000], 0, 7, |_, _| {})?;
    for base in [f.notes[0].clone(), deposit(&f, 20_000_000, 1000)?] {
        for index in [8usize, 12, 20, 24, 29, 30, 31, 32] {
            let value = base.recipient().storage().items()[index] + Felt::ONE;
            let bad = edited_note(&base, index, value)?;
            let error = f
                .chain
                .build_transaction(f.distributor.id())
                .unauthenticated_input_notes([bad])
                .build()?
                .execute()
                .await
                .unwrap_err();
            println!("rejected field {index}: {error:#}");
        }
    }
    Ok(())
}
#[tokio::test]
async fn signed_sender_creation_quotes_zero_for_routed_claim_and_unrouted_bootstrap_deposit()
-> anyhow::Result<()> {
    use bread_gamecoin::distributor::{FundedDeposit, bootstrap_deposit_note};
    use miden_protocol::{
        asset::FungibleAsset,
        note::{NoteType, PartialNote},
    };
    use miden_standards::{
        account::auth::{FeeConversionInfo, NetworkAccount, commit_fee_conversion_info},
        tx_script::SendNotesTransactionScript,
    };
    for routed in [true, false] {
        let mut b = MockChain::builder().verification_base_fee(7);
        let native = miden_protocol::testing::account_id::ACCOUNT_ID_FEE_FAUCET.try_into()?;
        let sender = b.add_existing_wallet_with_assets(
            Auth::basic_ecdsa(),
            [
                FungibleAsset::new(native, 100000)?.into(),
                FungibleAsset::new(gc(), 30_000_000)?.into(),
            ],
        )?;
        let domain = Word::from([17u32, 18, 19, 20]);
        let builder = distributor_builder([42; 32], gc(), native, domain)?;
        let distributor = if routed {
            builder.build_existing()?
        } else {
            builder.build()?
        };
        NetworkAccount::new(distributor.clone())?;
        if routed {
            b.add_account(distributor.clone())?;
        }
        let note = if routed {
            claim_note(&FundedClaim {
                distributor: distributor.id(),
                gc_faucet: gc(),
                native,
                distributor_code: distributor.code().commitment(),
                network: domain,
                sender: sender.id(),
                week: (MockChain::TIMESTAMP_START_SECS + 259200) / 604800,
                expiry: MockChain::TIMESTAMP_START_SECS + 3600,
                reclaim_height: 100,
                receipt_tag: NoteTag::with_account_target(sender.id()),
                budget: 1000,
                serial: Word::from([1u32, 2, 3, 4]),
            })?
        } else {
            bootstrap_deposit_note(&FundedDeposit {
                distributor: distributor.id(),
                gc_faucet: gc(),
                native,
                distributor_code: distributor.code().commitment(),
                network: domain,
                sender: sender.id(),
                reclaim_height: 100,
                receipt_tag: NoteTag::with_account_target(sender.id()),
                amount: 20_000_000,
                budget: 1000,
                serial: Word::from([1u32, 2, 3, 4]),
            })?
        };
        assert_eq!(note.metadata().note_type(), NoteType::Public);
        let script = SendNotesTransactionScript::new(
            &sender.code().interface(sender.id()),
            &[PartialNote::from(note.clone())],
        )?;
        let chain = b.build()?;
        let (args, p) =
            commit_fee_conversion_info(FeeConversionInfo::one_to_one(native), Word::empty());
        let tb = chain.build_transaction(sender.id());
        let tb = if routed {
            tb.foreign_accounts([chain.get_foreign_account_inputs(distributor.id())?])
        } else {
            tb
        };
        let tx = tb
            .send_notes_script(&script)
            .expected_output_note(RawOutputNote::Full(note.clone()))
            .auth_args(args)
            .add_advice_map_entry(args, p)
            .build()?
            .execute()
            .await?;
        assert_eq!(tx.output_notes().num_notes(), 2);
        assert_eq!(tx.output_notes().get_note(0).id(), note.id());
        let mut updated = sender;
        updated.apply_patch(tx.account_patch())?;
        assert_eq!(
            updated
                .vault()
                .get_balance(AssetId::new_fungible(native))?
                .as_u64(),
            100000 - 1000 - paid_fee(&tx)
        );
        assert_eq!(
            updated
                .vault()
                .get_balance(AssetId::new_fungible(gc()))?
                .as_u64(),
            if routed { 30_000_000 } else { 10_000_000 }
        );
    }
    Ok(())
}

#[tokio::test]
async fn receipt_must_use_standard_p2id_script_even_with_rebound_serial() -> anyhow::Result<()> {
    let f = fixture(&[1000], 0, 7, |_, _| {})?;
    for base in [f.notes[0].clone(), deposit(&f, 20_000_000, 1000)?] {
        let bad = edited_note(
            &base,
            0,
            base.recipient().storage().items()[0] + miden_protocol::Felt::ONE,
        )?;
        let result = f
            .chain
            .build_transaction(f.distributor.id())
            .unauthenticated_input_notes([bad])
            .build()?
            .execute()
            .await;
        assert!(
            format!("{:#}", result.unwrap_err()).contains("P2ID receipt required"),
            "non-P2ID receipt was not rejected by the checked payout"
        );
    }
    Ok(())
}
#[tokio::test]
async fn guardian_and_owner_sign_same_funded_claim_without_extra_sponsorship() -> anyhow::Result<()>
{
    use miden_protocol::{
        account::auth::{AuthScheme, AuthSecretKey},
        asset::FungibleAsset,
        note::PartialNote,
    };
    use miden_standards::{
        account::auth::{
            Approver, ApproverSet, FeeConversionInfo, GuardianConfig, MultisigAuthArgs,
        },
        note::FeeSponsorshipNote,
        tx_script::SendNotesTransactionScript,
    };
    use miden_tx::auth::{BasicAuthenticator, SigningInputs, TransactionAuthenticator};
    let owner = AuthSecretKey::new_ecdsa_k256_keccak();
    let guardian = AuthSecretKey::new_ecdsa_k256_keccak();
    let op = owner.public_key().to_commitment();
    let gp = guardian.public_key().to_commitment();
    let approver_set = ApproverSet::new(vec![Approver::new(op, AuthScheme::EcdsaK256Keccak)], 1)?;
    let guardian_config = GuardianConfig::new(Approver::new(gp, AuthScheme::EcdsaK256Keccak));
    let mut b = MockChain::builder().verification_base_fee(7);
    let native = miden_protocol::testing::account_id::ACCOUNT_ID_FEE_FAUCET.try_into()?;
    let sender = b.add_existing_wallet_with_assets(
        Auth::GuardedMultisig {
            approver_set,
            guardian_config,
            proc_threshold_map: vec![],
        },
        [FungibleAsset::new(native, 100000)?.into()],
    )?;
    let domain = Word::from([17u32, 18, 19, 20]);
    let distributor = distributor_builder([42; 32], gc(), native, domain)?
        .with_assets([FungibleAsset::new(gc(), 20_000_000)?.into()])
        .build_existing()?;
    b.add_account(distributor.clone())?;
    let claim = claim_note(&FundedClaim {
        distributor: distributor.id(),
        gc_faucet: gc(),
        native,
        distributor_code: distributor.code().commitment(),
        network: domain,
        sender: sender.id(),
        week: (MockChain::TIMESTAMP_START_SECS + 259200) / 604800,
        expiry: MockChain::TIMESTAMP_START_SECS + 3600,
        reclaim_height: 100,
        receipt_tag: NoteTag::with_account_target(sender.id()),
        budget: 1000,
        serial: Word::from([1u32, 2, 3, 4]),
    })?;
    let script = SendNotesTransactionScript::new(
        &sender.code().interface(sender.id()),
        &[PartialNote::from(claim.clone())],
    )?;
    let chain = b.build()?;
    let args = MultisigAuthArgs::new(
        chain.latest_block_header().block_num(),
        Word::from([9u32, 8, 7, 6]),
    )
    .with_conversion_info(FeeConversionInfo::one_to_one(native));
    let key = args.to_commitment();
    let builder = chain
        .build_transaction(sender.id())
        .foreign_accounts([chain.get_foreign_account_inputs(distributor.id())?])
        .send_notes_script(&script)
        .expected_output_note(RawOutputNote::Full(claim.clone()))
        .auth_args(key)
        .add_advice_map_entry(key, args.to_elements())
        .required_block(args.bound_block_num());
    let summary = builder
        .clone()
        .build()?
        .execute()
        .await
        .unwrap_err()
        .unwrap_unauthorized_err();
    let msg = summary.as_ref().to_commitment();
    let signing = SigningInputs::TransactionSummary(summary);
    let os = BasicAuthenticator::new(&[owner])
        .get_signature(op, &signing)
        .await?;
    let gs = BasicAuthenticator::new(&[guardian])
        .get_signature(gp, &signing)
        .await?;
    let guarded = builder
        .clone()
        .add_signature(op, msg, os.clone())
        .build()?
        .execute()
        .await
        .unwrap_err()
        .unwrap_unauthorized_err();
    assert_eq!(guarded.as_ref().to_commitment(), msg);
    let tx = builder
        .add_signature(op, msg, os)
        .add_signature(gp, msg, gs)
        .build()?
        .execute()
        .await?;
    assert_eq!(tx.output_notes().num_notes(), 2);
    assert_eq!(tx.output_notes().get_note(0).id(), claim.id());
    assert!(tx.output_notes().iter().all(|n| {
        n.recipient()
            .is_none_or(|r| r.script().root() != FeeSponsorshipNote::script_root())
    }));
    let mut updated = sender;
    updated.apply_patch(tx.account_patch())?;
    assert_eq!(
        updated
            .vault()
            .get_balance(AssetId::new_fungible(native))?
            .as_u64(),
        100000 - 1000 - paid_fee(&tx)
    );
    Ok(())
}

#[tokio::test]
async fn refill_batches_charge_only_each_depositor_and_zero_base_fee_returns_all_budget()
-> anyhow::Result<()> {
    use bread_gamecoin::distributor::{FundedDeposit, deposit_note};
    for base in [0, 7] {
        let f = fixture(&[1000, 1000], 50000, base, |_, _| {})?;
        for budgets in [[1000u64, 2000], [10000, 1]] {
            let mut notes = Vec::new();
            for i in 0..2 {
                notes.push(deposit_note(&FundedDeposit {
                    distributor: f.distributor.id(),
                    gc_faucet: gc(),
                    native: f.native,
                    distributor_code: f.distributor.code().commitment(),
                    network: Word::from([17u32, 18, 19, 20]),
                    sender: f.users[i].id(),
                    reclaim_height: 100,
                    receipt_tag: NoteTag::with_account_target(f.users[i].id()),
                    amount: 20_000_000,
                    budget: budgets[i],
                    serial: Word::from([i as u32 + 1, 99, 98, 97]),
                })?);
            }
            let result = f
                .chain
                .build_transaction(f.distributor.id())
                .unauthenticated_input_notes(notes)
                .build()?
                .execute()
                .await;
            if base > 0 && budgets[1] == 1 {
                assert!(result.is_err());
                continue;
            }
            let tx = result?;
            let fee = paid_fee(&tx);
            let mut updated = f.distributor.clone();
            updated.apply_patch(tx.account_patch())?;
            assert_eq!(
                updated
                    .vault()
                    .get_balance(AssetId::new_fungible(gc()))?
                    .as_u64(),
                1_040_000_000
            );
            assert_eq!(
                updated
                    .vault()
                    .get_balance(AssetId::new_fungible(f.native))?
                    .as_u64(),
                50000
            );
            for (i, note) in tx.output_notes().iter().take(2).enumerate() {
                assert_eq!(
                    note.assets()
                        .iter_fungible()
                        .next()
                        .unwrap()
                        .amount()
                        .as_u64(),
                    budgets[i] - fee / 2 - u64::from((i as u64) < fee % 2)
                );
            }
        }
    }
    Ok(())
}
#[test]
fn deployment_metadata_separates_distributor_and_canonical_gc() -> anyhow::Result<()> {
    let native = miden_protocol::testing::account_id::ACCOUNT_ID_FEE_FAUCET.try_into()?;
    let network = Word::from([17u32, 18, 19, 20]);
    let account = distributor_builder([42; 32], gc(), native, network)?.build()?;
    let config = bread_gamecoin::distributor::CanonicalDistribution::from_account(&account)?;
    assert_eq!(config.distributor, account.id());
    assert_ne!(config.distributor, gc());
    assert_eq!(config.gc_faucet, gc());
    assert_eq!(config.native, native);
    assert_eq!(config.network, network);
    assert_eq!(config.abi_version, 2);
    assert_eq!(
        config.claim_root,
        bread_gamecoin::distributor::claim_script()?.root()
    );
    assert_eq!(
        config.deposit_root,
        bread_gamecoin::distributor::deposit_script()?.root()
    );
    assert!(
        !account
            .code()
            .procedures()
            .contains(&miden_standards::account::faucets::FungibleFaucet::mint_and_send_root())
    );
    Ok(())
}

#[test]
fn actual_testnet_native_configuration_can_build_offline_deposit_vectors() -> anyhow::Result<()> {
    let native = miden_protocol::account::AccountId::from_hex("0x4cbdcaffe75f0a317482224dae6436")?;
    assert!(native.asset_callback_flag().is_enabled());
    let account =
        distributor_builder([42; 32], gc(), native, Word::from([17u32, 18, 19, 20]))?.build()?;
    let config = bread_gamecoin::distributor::CanonicalDistribution::from_account(&account)?;
    assert_eq!(config.native, native);
    assert_eq!(config.gc_faucet, gc());
    let sender = miden_protocol::account::AccountId::from_hex("0xe4ce561e0a4caa911eaabf98018d54")?;
    let n = bread_gamecoin::distributor::bootstrap_deposit_note(
        &bread_gamecoin::distributor::FundedDeposit {
            distributor: account.id(),
            gc_faucet: gc(),
            native,
            distributor_code: account.code().commitment(),
            network: config.network,
            sender,
            reclaim_height: 100,
            receipt_tag: NoteTag::with_account_target(sender),
            amount: 20_000_000,
            budget: 1000,
            serial: Word::from([1u32, 2, 3, 4]),
        },
    )?;
    assert_eq!(n.assets().num_assets(), 2);
    assert!(n.attachments().is_empty());
    Ok(())
}

#[tokio::test]
async fn callback_enabled_native_asset_conserves_claim_and_deposit_fees() -> anyhow::Result<()> {
    use bread_gamecoin::distributor::{FundedDeposit, deposit_note};
    use miden_standards::account::policies::MintPolicy;
    let mut b = MockChain::builder().verification_base_fee(7);
    let user = b.add_existing_wallet(Auth::default())?;
    let faucet = b.add_existing_network_faucet(
        "NATIVE",
        1_000_000_000,
        user.id(),
        None,
        MintPolicy::allow_all(),
        [],
    )?;
    assert!(faucet.id().asset_callback_flag().is_enabled());
    let native = faucet.id();
    b = b.fee_faucet_id(native);
    let network = Word::from([17u32, 18, 19, 20]);
    let distributor = distributor_builder([42; 32], gc(), native, network)?
        .with_assets([
            miden_protocol::asset::FungibleAsset::new(gc(), 20_000_000)?.into(),
            miden_protocol::asset::FungibleAsset::new(native, 50000)?.into(),
        ])
        .build_existing()?;
    b.add_account(distributor.clone())?;
    let chain = b.build()?;
    for refill in [false, true] {
        let note = if refill {
            deposit_note(&FundedDeposit {
                distributor: distributor.id(),
                gc_faucet: gc(),
                native,
                distributor_code: distributor.code().commitment(),
                network,
                sender: user.id(),
                reclaim_height: 100,
                receipt_tag: NoteTag::with_account_target(user.id()),
                amount: 20_000_000,
                budget: 1000,
                serial: Word::from([5u32, 6, 7, 8]),
            })?
        } else {
            claim_note(&FundedClaim {
                distributor: distributor.id(),
                gc_faucet: gc(),
                native,
                distributor_code: distributor.code().commitment(),
                network,
                sender: user.id(),
                week: (MockChain::TIMESTAMP_START_SECS + 259200) / 604800,
                expiry: MockChain::TIMESTAMP_START_SECS + 3600,
                reclaim_height: 100,
                receipt_tag: NoteTag::with_account_target(user.id()),
                budget: 1000,
                serial: Word::from([1u32, 2, 3, 4]),
            })?
        };
        let tx = chain
            .build_transaction(distributor.id())
            .foreign_accounts([chain.get_foreign_account_inputs(native)?])
            .unauthenticated_input_notes([note])
            .build()?
            .execute()
            .await?;
        let mut updated = distributor.clone();
        updated.apply_patch(tx.account_patch())?;
        assert_eq!(
            updated
                .vault()
                .get_balance(AssetId::new_fungible(native))?
                .as_u64(),
            50000
        );
        let receipt = tx.output_notes().get_note(0);
        let refund = receipt
            .assets()
            .iter_fungible()
            .find(|a| a.faucet_id() == native)
            .unwrap()
            .amount()
            .as_u64();
        assert_eq!(refund + paid_fee(&tx), 1000);
        assert_eq!(
            updated
                .vault()
                .get_balance(AssetId::new_fungible(gc()))?
                .as_u64(),
            if refill { 40_000_000 } else { 10_000_000 }
        );
    }
    Ok(())
}

#[tokio::test]
async fn malformed_storage_or_changed_metadata_and_budget_cannot_consume() -> anyhow::Result<()> {
    use miden_protocol::{
        Felt,
        asset::FungibleAsset,
        note::{Note, NoteAssets, NoteRecipient, NoteStorage, NoteType, PartialNoteMetadata},
    };
    let f = fixture(&[1000], 0, 7, |_, _| {})?;
    let original = &f.notes[0];
    for change in ["short", "long", "budget", "metadata", "private"] {
        let mut fields = original.recipient().storage().items().to_vec();
        if change == "short" {
            fields.pop();
        }
        if change == "long" {
            fields.push(Felt::ZERO);
        }
        let assets = if change == "budget" {
            NoteAssets::new(vec![FungibleAsset::new(f.native, 1001)?.into()])?
        } else {
            original.assets().clone()
        };
        let tag = if change == "metadata" {
            NoteTag::default()
        } else {
            original.metadata().tag()
        };
        let typ = if change == "private" {
            NoteType::Private
        } else {
            NoteType::Public
        };
        let bad = Note::with_attachments(
            assets,
            PartialNoteMetadata::new(original.metadata().sender(), typ).with_tag(tag),
            NoteRecipient::new(
                original.recipient().serial_num(),
                original.script().clone(),
                NoteStorage::new(fields)?,
            ),
            original.attachments().clone(),
        );
        assert!(
            f.chain
                .build_transaction(f.distributor.id())
                .unauthenticated_input_notes([bad])
                .build()?
                .execute()
                .await
                .is_err(),
            "accepted malformed {change}"
        );
    }
    execute(&f).await?;
    Ok(())
}

#[tokio::test]
async fn explicit_receipt_collection_credits_canonical_balance_and_allows_normal_transfer()
-> anyhow::Result<()> {
    use miden_protocol::{
        asset::FungibleAsset,
        note::{NoteType, PartialNote},
    };
    use miden_standards::{
        account::auth::{FeeConversionInfo, commit_fee_conversion_info},
        note::P2idNote,
        tx_script::SendNotesTransactionScript,
    };
    let mut f = fixture(&[1000, 1000], 0, 7, |_, _| {})?;
    let claim = f
        .chain
        .build_transaction(f.distributor.id())
        .authenticated_input_note(f.notes[0].id())
        .build()?
        .execute()
        .await?;
    let receipt_id = claim.output_notes().get_note(0).id();
    let refund = claim
        .output_notes()
        .get_note(0)
        .assets()
        .iter_fungible()
        .find(|a| a.faucet_id() == f.native)
        .unwrap()
        .amount()
        .as_u64();
    f.chain.add_pending_executed_transaction(&claim)?;
    f.chain.prove_next_block()?;
    assert_eq!(
        f.users[0]
            .vault()
            .get_balance(AssetId::new_fungible(gc()))?
            .as_u64(),
        0
    );
    let (args, p) =
        commit_fee_conversion_info(FeeConversionInfo::one_to_one(f.native), Word::empty());
    let collect = f
        .chain
        .build_transaction(f.users[0].id())
        .authenticated_input_note(receipt_id)
        .auth_args(args)
        .add_advice_map_entry(args, p.clone())
        .build()?
        .execute()
        .await?;
    let mut user = f.users[0].clone();
    user.apply_patch(collect.account_patch())?;
    assert_eq!(
        user.vault()
            .get_balance(AssetId::new_fungible(gc()))?
            .as_u64(),
        10_000_000
    );
    assert_eq!(
        user.vault()
            .get_balance(AssetId::new_fungible(f.native))?
            .as_u64(),
        100000 + refund - paid_fee(&collect)
    );
    f.chain.add_pending_executed_transaction(&collect)?;
    f.chain.prove_next_block()?;
    let transfer: miden_protocol::note::Note = P2idNote::builder()
        .sender(user.id())
        .target(f.users[1].id())
        .salt([0u32.into(), 0u32.into()])
        .serial_number(Word::from([9u32, 8, 7, 6]))
        .assets([FungibleAsset::new(gc(), 1_000_000)?])
        .note_type(NoteType::Public)
        .build()?
        .into();
    let script = SendNotesTransactionScript::new(
        &user.code().interface(user.id()),
        &[PartialNote::from(transfer.clone())],
    )?;
    let sent = f
        .chain
        .build_transaction(user.clone())
        .send_notes_script(&script)
        .expected_output_note(RawOutputNote::Full(transfer.clone()))
        .auth_args(args)
        .add_advice_map_entry(args, p)
        .build()?
        .execute()
        .await?;
    user.apply_patch(sent.account_patch())?;
    assert_eq!(
        user.vault()
            .get_balance(AssetId::new_fungible(gc()))?
            .as_u64(),
        9_000_000
    );
    assert_eq!(sent.output_notes().get_note(0).id(), transfer.id());
    Ok(())
}

#[tokio::test]
async fn rejected_refill_remains_sender_reclaimable_with_both_assets() -> anyhow::Result<()> {
    let mut f = fixture(&[1000], 0, 7, |_, _| {})?;
    let note = edited_note(&deposit(&f, 20_000_000, 1)?, 28, 3u32.into())?;
    assert!(
        f.chain
            .build_transaction(f.distributor.id())
            .unauthenticated_input_notes([note.clone()])
            .build()?
            .execute()
            .await
            .is_err()
    );
    let (args, p) = miden_standards::account::auth::commit_fee_conversion_info(
        miden_standards::account::auth::FeeConversionInfo::one_to_one(f.native),
        Word::empty(),
    );
    assert!(
        f.chain
            .build_transaction(f.users[0].id())
            .unauthenticated_input_notes([note.clone()])
            .auth_args(args)
            .add_advice_map_entry(args, p.clone())
            .build()?
            .execute()
            .await
            .is_err()
    );
    f.chain.prove_until_block(3u32)?;
    let tx = f
        .chain
        .build_transaction(f.users[0].id())
        .unauthenticated_input_notes([note.clone()])
        .auth_args(args)
        .add_advice_map_entry(args, p)
        .build()?
        .execute()
        .await?;
    let mut user = f.users[0].clone();
    user.apply_patch(tx.account_patch())?;
    assert_eq!(
        user.vault()
            .get_balance(AssetId::new_fungible(gc()))?
            .as_u64(),
        20_000_000
    );
    assert_eq!(
        user.vault()
            .get_balance(AssetId::new_fungible(f.native))?
            .as_u64(),
        100001 - paid_fee(&tx)
    );
    assert!(
        f.chain
            .build_transaction(f.distributor.id())
            .unauthenticated_input_notes([note])
            .build()?
            .execute()
            .await
            .is_err()
    );
    Ok(())
}
#[tokio::test]
async fn preexisting_claimant_gc_balance_does_not_reduce_allowance() -> anyhow::Result<()> {
    use miden_protocol::asset::FungibleAsset;
    let mut b = MockChain::builder().verification_base_fee(7);
    let native = miden_protocol::testing::account_id::ACCOUNT_ID_FEE_FAUCET.try_into()?;
    let user = b.add_existing_wallet_with_assets(
        Auth::default(),
        [
            FungibleAsset::new(gc(), 25_000_000)?.into(),
            FungibleAsset::new(native, 100000)?.into(),
        ],
    )?;
    let network = Word::from([17u32, 18, 19, 20]);
    let distributor = distributor_builder([42; 32], gc(), native, network)?
        .with_assets([FungibleAsset::new(gc(), 20_000_000)?.into()])
        .build_existing()?;
    b.add_account(distributor.clone())?;
    let note = claim_note(&FundedClaim {
        distributor: distributor.id(),
        gc_faucet: gc(),
        native,
        distributor_code: distributor.code().commitment(),
        network,
        sender: user.id(),
        week: (MockChain::TIMESTAMP_START_SECS + 259200) / 604800,
        expiry: MockChain::TIMESTAMP_START_SECS + 3600,
        reclaim_height: 100,
        receipt_tag: NoteTag::with_account_target(user.id()),
        budget: 1000,
        serial: Word::from([1u32, 2, 3, 4]),
    })?;
    let chain = b.build()?;
    let tx = chain
        .build_transaction(distributor.id())
        .unauthenticated_input_notes([note])
        .build()?
        .execute()
        .await?;
    assert_eq!(
        tx.output_notes()
            .get_note(0)
            .assets()
            .iter_fungible()
            .find(|a| a.faucet_id() == gc())
            .unwrap()
            .amount()
            .as_u64(),
        10_000_000
    );
    assert_eq!(
        user.vault()
            .get_balance(AssetId::new_fungible(gc()))?
            .as_u64(),
        25_000_000
    );
    Ok(())
}
