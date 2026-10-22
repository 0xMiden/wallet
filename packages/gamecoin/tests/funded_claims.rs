use bread_gamecoin::funded::{FundedClaim, claim_note, funded_issuer_builder};
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
        let issuer =
            funded_issuer_builder([42; 32], users[0].id(), native, domain)?.build_existing()?;
        b.add_account(issuer.clone())?;
        let mut requests = Vec::new();
        for (i, user) in users.iter().enumerate() {
            let request = claim_note(&FundedClaim {
                issuer: issuer.id(),
                native,
                issuer_code: issuer.code().commitment(),
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
            .build_transaction(issuer.id())
            .authenticated_input_notes(requests.iter().map(|x| x.id()))
            .build()?
            .execute()
            .await?;
        let mut updated = issuer.clone();
        updated.apply_patch(tx.account_patch())?;
        assert_eq!(
            updated
                .vault()
                .get_balance(AssetId::new_fungible(native))?
                .as_u64(),
            0,
            "issuer retained surplus or spent reserves"
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
                    .find(|a| a.faucet_id() == issuer.id())
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
    issuer: miden_protocol::account::Account,
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
    let issuer = funded_issuer_builder([42; 32], users[0].id(), native, domain)?
        .with_assets(assets)
        .build_existing()?;
    b.add_account(issuer.clone())?;
    let mut notes = Vec::new();
    for (i, user) in users.iter().enumerate() {
        let mut c = FundedClaim {
            issuer: issuer.id(),
            native,
            issuer_code: issuer.code().commitment(),
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
        issuer,
        users,
        notes,
        native,
    })
}
async fn execute(f: &Fixture) -> anyhow::Result<miden_protocol::transaction::ExecutedTransaction> {
    Ok(f.chain
        .build_transaction(f.issuer.id())
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
    let mut a = valid.issuer.clone();
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
            f.issuer
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
            "code" => c.issuer_code = Word::empty(),
            "network" => c.network = Word::empty(),
            "week" => c.week += 1,
            "expiry" => c.expiry = 1,
            "native" => c.native = c.issuer,
            _ => {}
        })?;
        if label == "sender" {
            let n = &f.notes[0];
            let bad = miden_protocol::note::Note::with_attachments(
                n.assets().clone(),
                miden_protocol::note::PartialNoteMetadata::new(
                    f.issuer.id(),
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
                .build_transaction(f.issuer.id())
                .unauthenticated_input_notes(f.notes.clone())
                .build()?
                .execute()
                .await
        } else {
            f.chain
                .build_transaction(f.issuer.id())
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
        .build_transaction(f.issuer.id())
        .authenticated_input_note(f.notes[0].id())
        .build()?
        .execute()
        .await?;
    let mut updated = f.issuer.clone();
    updated.apply_patch(tx.account_patch())?;
    let slot = miden_protocol::account::StorageSlotName::new(bread_gamecoin::CLAIMS_SLOT)?;
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
            .get_balance(AssetId::new_fungible(f.issuer.id()))?
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
        "issuer consumed against reference after reclaim height"
    );
    Ok(())
}
#[tokio::test]
async fn competing_issuer_and_reclaim_proofs_have_only_one_committed_winner() -> anyhow::Result<()>
{
    for issuer_wins in [true, false] {
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
        let (winner, loser) = if issuer_wins {
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
        .build_transaction(f.issuer.id())
        .authenticated_input_note(f.notes[0].id())
        .build()?
        .execute()
        .await?;
    f.chain.add_pending_executed_transaction(&sunday)?;
    f.chain.prove_next_block_at(monday)?;
    assert!(f.chain.is_note_consumed(&f.notes[0].nullifier()));
    assert!(
        f.chain
            .build_transaction(f.issuer.id())
            .authenticated_input_note(f.notes[1].id())
            .build()?
            .execute()
            .await
            .is_err()
    );
    Ok(())
}
#[tokio::test]
async fn signed_sender_fpi_zero_quote_creates_claim_and_fee_without_companion() -> anyhow::Result<()>
{
    use miden_protocol::{
        asset::{Asset, FungibleAsset},
        note::{Note, NoteType, PartialNote},
    };
    use miden_standards::{
        account::auth::{FeeConversionInfo, NetworkAccount, commit_fee_conversion_info},
        note::FeeSponsorshipNote,
        tx_script::SendNotesTransactionScript,
    };
    for routed in [true, false] {
        let mut b = MockChain::builder().verification_base_fee(7);
        let native = miden_protocol::testing::account_id::ACCOUNT_ID_FEE_FAUCET.try_into()?;
        let sender = b.add_existing_wallet_with_assets(
            Auth::basic_ecdsa(),
            [Asset::from(FungibleAsset::new(native, 100000)?)],
        )?;
        let domain = Word::from([17u32, 18, 19, 20]);
        let ib = funded_issuer_builder([42; 32], sender.id(), native, domain)?;
        let issuer = if routed {
            ib.build_existing()?
        } else {
            ib.build()?
        };
        NetworkAccount::new(issuer.clone())?;
        if routed {
            b.add_account(issuer.clone())?;
        }
        let c = FundedClaim {
            issuer: issuer.id(),
            native,
            issuer_code: issuer.code().commitment(),
            network: domain,
            sender: sender.id(),
            week: (MockChain::TIMESTAMP_START_SECS + 259200) / 604800,
            expiry: MockChain::TIMESTAMP_START_SECS + 3600,
            reclaim_height: 100,
            receipt_tag: NoteTag::with_account_target(sender.id()),
            budget: 1000,
            serial: Word::from([1u32, 2, 3, 4]),
        };
        let claim: Note = if routed {
            claim_note(&c)?
        } else {
            bread_gamecoin::funded::bootstrap_claim_note(&c)?
        };
        assert_eq!(claim.metadata().note_type(), NoteType::Public);
        let script = SendNotesTransactionScript::new(
            &sender.code().interface(sender.id()),
            &[PartialNote::from(claim.clone())],
        )?;
        let chain = b.build()?;
        let (args, p) =
            commit_fee_conversion_info(FeeConversionInfo::one_to_one(native), Word::empty());
        let builder = chain.build_transaction(sender.id());
        let builder = if routed {
            builder.foreign_accounts([chain.get_foreign_account_inputs(issuer.id())?])
        } else {
            builder
        };
        let tx = builder
            .send_notes_script(&script)
            .expected_output_note(RawOutputNote::Full(claim.clone()))
            .auth_args(args)
            .add_advice_map_entry(args, p)
            .build()?
            .execute()
            .await?;
        assert_eq!(tx.output_notes().num_notes(), 2);
        assert!(tx.output_notes().iter().all(|n| {
            n.recipient()
                .is_none_or(|r| r.script().root() != FeeSponsorshipNote::script_root())
        }));
        assert_eq!(tx.output_notes().get_note(0).id(), claim.id());
        let mut updated = sender;
        updated.apply_patch(tx.account_patch())?;
        assert_eq!(
            updated
                .vault()
                .get_balance(AssetId::new_fungible(native))?
                .as_u64(),
            100000 - 1000 - paid_fee(&tx)
        );
    }
    Ok(())
}
#[tokio::test]
async fn maximum_intrinsic_batch_obeys_protocol_advice_resource_limit() -> anyhow::Result<()> {
    use miden_protocol::{Felt, account::AccountId};
    let mut b = MockChain::builder().verification_base_fee(7);
    let native = miden_protocol::testing::account_id::ACCOUNT_ID_FEE_FAUCET.try_into()?;
    let owner = b.add_existing_wallet(Auth::default())?;
    let domain = Word::from([17u32, 18, 19, 20]);
    let issuer = funded_issuer_builder([42; 32], owner.id(), native, domain)?.build_existing()?;
    b.add_account(issuer.clone())?;
    let n = bread_gamecoin::funded::MAX_CLAIMS;
    let mut notes = Vec::new();
    for i in 0..n {
        let sender = AccountId::try_from_elements(
            Felt::from((i as u32 + 1) * 256),
            owner.id().prefix().as_felt(),
        )?;
        let note = claim_note(&FundedClaim {
            issuer: issuer.id(),
            native,
            issuer_code: issuer.code().commitment(),
            network: domain,
            sender,
            week: (MockChain::TIMESTAMP_START_SECS + 259200) / 604800,
            expiry: MockChain::TIMESTAMP_START_SECS + 3600,
            reclaim_height: 100,
            receipt_tag: NoteTag::with_account_target(sender),
            budget: 1000,
            serial: Word::from([i as u32 + 1, 2, 3, 4]),
        })?;
        b.add_output_note(RawOutputNote::Full(note.clone()));
        notes.push(note);
    }
    let chain = b.build()?;
    let error = chain
        .build_transaction(issuer.id())
        .authenticated_input_notes(notes.iter().map(|x| x.id()))
        .build()?
        .execute()
        .await
        .unwrap_err();
    assert!(
        format!("{error:#}").contains("advice provider size budget exceeded"),
        "unexpected intrinsic resource rejection: {error:#}"
    );
    // This is the protocol's global 16 MiB advice cap, not an artificial issuer batch limit.
    assert_eq!(
        bread_gamecoin::funded::MAX_CLAIMS,
        miden_protocol::MAX_OUTPUT_NOTES_PER_TX - 1
    );

    Ok(())
}
#[tokio::test]
async fn same_author_serial_with_different_budget_or_reclaim_height_has_distinct_receipt()
-> anyhow::Result<()> {
    let mut sender = None;
    let f = fixture(&[1000, 1001, 1000], 0, 7, |i, c| {
        if i == 0 {
            sender = Some(c.sender)
        }
        c.sender = sender.unwrap();
        c.receipt_tag = NoteTag::with_account_target(c.sender);
        c.serial = Word::from([1u32, 2, 3, 4]);
        if i == 2 {
            c.reclaim_height += 1;
        }
    })?;
    let serials: Vec<_> = f
        .notes
        .iter()
        .map(|n| &n.recipient().storage().items()[4..8])
        .collect();
    assert_ne!(serials[0], serials[1], "native budget must affect receipt");
    assert_ne!(serials[0], serials[2], "reclaim height must affect receipt");
    Ok(())
}
#[tokio::test]
async fn changing_outer_metadata_or_budget_without_rebinding_receipt_cannot_mint()
-> anyhow::Result<()> {
    use miden_protocol::{
        asset::FungibleAsset,
        note::{Note, NoteAssets, NoteType, PartialNoteMetadata},
    };
    for change in ["budget", "tag"] {
        let f = fixture(&[1000], 0, 7, |_, _| {})?;
        let n = &f.notes[0];
        let assets = if change == "budget" {
            NoteAssets::new(vec![FungibleAsset::new(f.native, 1001)?.into()])?
        } else {
            n.assets().clone()
        };
        let tag = if change == "tag" {
            NoteTag::default()
        } else {
            n.metadata().tag()
        };
        let bad = Note::with_attachments(
            assets,
            PartialNoteMetadata::new(n.metadata().sender(), NoteType::Public).with_tag(tag),
            n.recipient().clone(),
            n.attachments().clone(),
        );
        assert!(
            f.chain
                .build_transaction(f.issuer.id())
                .unauthenticated_input_notes([bad])
                .build()?
                .execute()
                .await
                .is_err(),
            "accepted changed {change} with old receipt binding"
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
    let issuer = funded_issuer_builder([42; 32], sender.id(), native, domain)?.build_existing()?;
    b.add_account(issuer.clone())?;
    let claim = claim_note(&FundedClaim {
        issuer: issuer.id(),
        native,
        issuer_code: issuer.code().commitment(),
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
        .foreign_accounts([chain.get_foreign_account_inputs(issuer.id())?])
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
async fn unrouted_bootstrap_is_only_first_transaction_and_uses_same_policy() -> anyhow::Result<()> {
    use bread_gamecoin::funded::bootstrap_claim_note;
    for bad in ["none", "code", "network", "issuer"] {
        let mut b = MockChain::builder().verification_base_fee(7);
        let native = miden_protocol::testing::account_id::ACCOUNT_ID_FEE_FAUCET.try_into()?;
        let sender = b.add_existing_wallet(Auth::default())?;
        let domain = Word::from([17u32, 18, 19, 20]);
        let issuer = funded_issuer_builder([42; 32], sender.id(), native, domain)?.build()?;
        let mut c = FundedClaim {
            issuer: issuer.id(),
            native,
            issuer_code: issuer.code().commitment(),
            network: domain,
            sender: sender.id(),
            week: (MockChain::TIMESTAMP_START_SECS + 259200) / 604800,
            expiry: MockChain::TIMESTAMP_START_SECS + 3600,
            reclaim_height: 100,
            receipt_tag: NoteTag::with_account_target(sender.id()),
            budget: 1000,
            serial: Word::from([1u32, 2, 3, 4]),
        };
        match bad {
            "code" => c.issuer_code = Word::empty(),
            "network" => c.network = Word::empty(),
            "issuer" => c.issuer = native,
            _ => {}
        }
        let note = bootstrap_claim_note(&c)?;
        assert!(note.attachments().is_empty());
        b.add_output_note(RawOutputNote::Full(note.clone()));
        let chain = b.build()?;
        assert!(
            chain.get_foreign_account_inputs(issuer.clone()).is_err(),
            "uncreated issuer unexpectedly has FPI state inclusion witness"
        );
        let result = chain
            .build_transaction(issuer.clone())
            .authenticated_input_note(note.id())
            .build()?
            .execute()
            .await;
        if bad != "none" {
            assert!(result.is_err(), "bootstrap accepted {bad}");
            continue;
        }
        let tx = result?;
        assert_eq!(tx.output_notes().num_notes(), 2);
        assert_eq!(
            tx.output_notes()
                .get_note(0)
                .assets()
                .iter_fungible()
                .find(|a| a.faucet_id() == issuer.id())
                .unwrap()
                .amount()
                .as_u64(),
            10000000
        );
        let mut updated = issuer;
        updated.apply_patch(tx.account_patch())?;
        assert_eq!(updated.nonce(), miden_protocol::Felt::ONE);
        assert_eq!(
            updated
                .vault()
                .get_balance(AssetId::new_fungible(native))?
                .as_u64(),
            0
        );
        // Existing issuer cannot admit any new unrouted claim, even for another claimant/week.
        let late = chain
            .build_transaction(updated)
            .authenticated_input_note(note.id())
            .build()?
            .execute()
            .await
            .unwrap_err();
        assert!(format!("{late:#}").contains("unrouted claim only at issuer creation"));
    }
    Ok(())
}

#[tokio::test]
async fn reclaim_a_and_mint_b_cannot_share_receipt_identity() -> anyhow::Result<()> {
    let mut sender = None;
    let mut f = fixture(&[1000, 1001], 0, 7, |i, c| {
        if i == 0 {
            sender = Some(c.sender)
        }
        c.sender = sender.unwrap();
        c.receipt_tag = NoteTag::with_account_target(c.sender);
        c.serial = Word::from([1u32, 2, 3, 4]);
        if i == 1 {
            c.reclaim_height = 4;
        }
    })?;
    assert_ne!(
        f.notes[0].recipient().storage().items()[4..8],
        f.notes[1].recipient().storage().items()[4..8]
    );
    let mint = f
        .chain
        .build_transaction(f.issuer.id())
        .authenticated_input_note(f.notes[1].id())
        .build()?
        .execute()
        .await?;
    let receipt = mint.output_notes().get_note(0).recipient().unwrap();
    assert_eq!(
        receipt.serial_num().as_elements(),
        &f.notes[1].recipient().storage().items()[4..8]
    );
    assert_ne!(
        receipt.serial_num().as_elements(),
        &f.notes[0].recipient().storage().items()[4..8]
    );
    f.chain.add_pending_executed_transaction(&mint)?;
    f.chain.prove_next_block()?;
    f.chain.prove_until_block(3u32)?;
    let (key, p) = miden_standards::account::auth::commit_fee_conversion_info(
        miden_standards::account::auth::FeeConversionInfo::one_to_one(f.native),
        Word::empty(),
    );
    let reclaim = f
        .chain
        .build_transaction(f.users[0].id())
        .authenticated_input_note(f.notes[0].id())
        .auth_args(key)
        .add_advice_map_entry(key, p)
        .build()?
        .execute()
        .await?;
    assert!(
        reclaim
            .output_notes()
            .iter()
            .flat_map(|n| n.assets().iter_fungible())
            .all(|a| a.faucet_id() != f.issuer.id())
    );
    f.chain.add_pending_executed_transaction(&reclaim)?;
    f.chain.prove_next_block()?;
    assert!(f.chain.is_note_consumed(&f.notes[0].nullifier()));
    assert!(f.chain.is_note_consumed(&f.notes[1].nullifier()));
    Ok(())
}

#[tokio::test]
async fn unsupported_notes_and_transaction_scripts_cannot_spend_reserves() -> anyhow::Result<()> {
    let f = fixture(&[1000], 50000, 7, |_, _| {})?;
    let bypass = miden_standards::code_builder::CodeBuilder::default()
        .compile_tx_script("@transaction_script pub proc main dropw end")?;
    let error = f
        .chain
        .build_transaction(f.issuer.id())
        .authenticated_input_note(f.notes[0].id())
        .tx_script(bypass)
        .build()?
        .execute()
        .await
        .unwrap_err();
    assert!(format!("{error:#}").contains("script"));
    let unrelated: miden_protocol::note::Note = miden_standards::note::P2idNote::builder()
        .sender(f.users[0].id())
        .target(f.issuer.id())
        .serial_number(Word::from([99u32, 98, 97, 96]))
        .salt([0u32.into(), 0u32.into()])
        .assets([miden_protocol::asset::FungibleAsset::new(f.native, 1000)?])
        .note_type(miden_protocol::note::NoteType::Public)
        .build()?
        .into();
    assert!(
        f.chain
            .build_transaction(f.issuer.id())
            .unauthenticated_input_notes([unrelated])
            .build()?
            .execute()
            .await
            .is_err()
    );
    assert_eq!(
        f.issuer
            .vault()
            .get_balance(AssetId::new_fungible(f.native))?
            .as_u64(),
        50000
    );
    // Neither failed attempt applied state or reserved entitlement.
    execute(&f).await?;
    Ok(())
}
