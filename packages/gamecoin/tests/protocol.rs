use miden_protocol::{
    asset::{Asset, FungibleAsset},
    note::NoteType,
};
use miden_testing::{Auth, MockChain};
#[tokio::test]
async fn protocol_claim_boundaries() -> anyhow::Result<()> {
    let mut builder = MockChain::builder().verification_base_fee(100);
    let payer = builder.add_existing_wallet(Auth::default())?;
    let receiver = builder.add_existing_wallet(Auth::default())?;
    let native = miden_protocol::testing::account_id::ACCOUNT_ID_FEE_FAUCET.try_into()?;
    let funding = Asset::from(FungibleAsset::new(native, 100_000)?);
    let note = builder.add_p2id_note(payer.id(), receiver.id(), &[funding], NoteType::Public)?;
    let chain = builder.build()?;
    let (auth_args, auth_preimage) = miden_standards::account::auth::commit_fee_conversion_info(
        miden_standards::account::auth::FeeConversionInfo::one_to_one(native),
        miden_protocol::Word::empty(),
    );
    let tx = chain
        .build_transaction(receiver.id())
        .authenticated_input_note(note.id())
        .auth_args(auth_args)
        .add_advice_map_entry(auth_args, auth_preimage)
        .build()?
        .execute()
        .await?;
    let mut updated = receiver.clone();
    updated.apply_patch(tx.account_patch())?;
    assert_eq!(
        updated
            .vault()
            .get_balance(miden_protocol::asset::AssetId::new_fungible(native))?
            .as_u64(),
        98_300
    );
    println!(
        "receipt success id={} native_remaining={:?}",
        tx.id(),
        updated
            .vault()
            .get(miden_protocol::asset::AssetId::new_fungible(native))
    );
    network_mint_probe().await?;
    Ok(())
}

#[allow(dead_code)]
async fn network_mint_probe() -> anyhow::Result<()> {
    use miden_protocol::{
        Word,
        block::BlockNumber,
        note::{Note, NoteTag},
    };
    use miden_standards::note::{FeeSponsorshipNote, MintNote, MintNoteStorage, P2idNote};
    let mut b = MockChain::builder().verification_base_fee(100);
    let native_fee = miden_protocol::testing::account_id::ACCOUNT_ID_FEE_FAUCET.try_into()?;
    let claimant = b.add_existing_wallet_with_assets(
        Auth::default(),
        [Asset::from(FungibleAsset::new(native_fee, 100_000)?)],
    )?;
    let issuer = issuer_account(&mut b, claimant.id())?;
    let other = b.add_existing_wallet(Auth::default())?;
    let native = miden_protocol::testing::account_id::ACCOUNT_ID_FEE_FAUCET.try_into()?;
    let receipt: Note = P2idNote::builder()
        .sender(issuer.id())
        .target(claimant.id())
        .salt([
            miden_protocol::Felt::from((MockChain::TIMESTAMP_START_SECS + 259200) / 604800),
            miden_protocol::Felt::from(MockChain::TIMESTAMP_START_SECS + 86400),
        ])
        .assets([Asset::from(FungibleAsset::new(issuer.id(), 10_000_000)?)])
        .serial_number(Word::from([1u32, 2, 3, 4]))
        .build()?
        .into();
    let request: Note = MintNote::builder()
        .sender(claimant.id())
        .serial_number(Word::from([11u32, 12, 13, 14]))
        .mint_storage(MintNoteStorage::new_public(
            receipt.recipient().clone(),
            FungibleAsset::new(issuer.id(), 10_000_000)?,
            NoteTag::with_account_target(claimant.id()),
        )?)
        .build()?
        .into();
    let fee: Note = FeeSponsorshipNote::builder()
        .sender(claimant.id())
        .target_account(issuer.id())
        .feature_note_id(request.id())
        .reclaimer(claimant.id())
        .reclaim_height(BlockNumber::from(100u32))
        .serial_number(Word::from([21u32, 22, 23, 24]))
        .asset(FungibleAsset::new(native, 10000)?)
        .build()?
        .into();
    b.add_output_note(miden_protocol::transaction::RawOutputNote::Full(
        request.clone(),
    ));
    b.add_output_note(miden_protocol::transaction::RawOutputNote::Full(
        fee.clone(),
    ));
    let mut chain = b.build()?;

    let quote_code = format!(
        r#"
       use miden::protocol::tx
       use miden::core::sys
       @transaction_script
       pub proc main
          dropw
          push.{root} push.{prefix} push.{suffix}
          exec.tx::execute_foreign_procedure
          dropw eq.3000 assert.err="foreign quote must equal current max fee"
          exec.sys::truncate_stack
       end
    "#,
        root = miden_standards::account::auth::AuthNetworkAccount::estimate_note_fee_root(),
        prefix = issuer.id().prefix().as_felt(),
        suffix = issuer.id().suffix()
    );
    let quote_script =
        miden_standards::code_builder::CodeBuilder::default().compile_tx_script(quote_code)?;
    let (qa, qv) = miden_standards::account::auth::commit_fee_conversion_info(
        miden_standards::account::auth::FeeConversionInfo::one_to_one(native),
        Word::empty(),
    );
    chain
        .build_transaction(claimant.id())
        .foreign_accounts([chain.get_foreign_account_inputs(issuer.id())?])
        .tx_script(quote_script)
        .auth_args(qa)
        .add_advice_map_entry(qa, qv)
        .build()?
        .execute()
        .await?;
    println!("PASS canonical AuthNetworkAccount FPI fee quote returns3000 at base100");

    let native_id = miden_protocol::asset::AssetId::new_fungible(native);
    assert_eq!(issuer.vault().get_balance(native_id)?.as_u64(), 0);
    let tx = chain
        .build_transaction(issuer.id())
        .authenticated_input_notes([request.id(), fee.id()])
        .build()?
        .execute()
        .await?;
    let mut updated = issuer.clone();
    updated.apply_patch(tx.account_patch())?;
    println!(
        "network mint success tx={} outputs={} native_remaining={:?}",
        tx.id(),
        tx.output_notes().num_notes(),
        updated
            .vault()
            .get(miden_protocol::asset::AssetId::new_fungible(native))
    );
    assert_eq!(updated.vault().get_balance(native_id)?.as_u64(), 8_400);
    let gc_id = miden_protocol::asset::AssetId::new_fungible(issuer.id());
    let gc_note = tx
        .output_notes()
        .iter()
        .find(|n| n.assets().iter().any(|a| a.id() == gc_id))
        .expect("GC receipt");
    assert_eq!(
        gc_note.assets().as_slice(),
        [Asset::from(FungibleAsset::new(issuer.id(), 10_000_000)?)]
    );
    assert_eq!(gc_note.recipient_digest(), receipt.recipient().digest());
    assert_eq!(
        gc_note.metadata().tag(),
        NoteTag::with_account_target(claimant.id())
    );
    let fee_sum: u64 = tx
        .output_notes()
        .iter()
        .filter(|n| {
            n.recipient().is_some_and(|r| {
                r.script().root() == miden_standards::note::TxFeeNote::script_root()
            })
        })
        .flat_map(|n| n.assets().iter_fungible())
        .filter(|a| a.faucet_id() == native)
        .map(|a| a.amount().as_u64())
        .sum();
    assert_eq!(fee_sum, 1_600);
    assert_eq!(
        fee_sum + updated.vault().get_balance(native_id)?.as_u64(),
        10_000
    );
    let week = (MockChain::TIMESTAMP_START_SECS + 259200) / 604800;
    let expiry = MockChain::TIMESTAMP_START_SECS + 86400;
    let slot = miden_protocol::account::StorageSlotName::new(bread_gamecoin::CLAIMS_SLOT)?;
    let claim_key = Word::from([
        claimant.id().suffix(),
        claimant.id().prefix().as_felt(),
        miden_protocol::Felt::from(week),
        miden_protocol::Felt::ZERO,
    ]);
    assert_eq!(
        updated.storage().get_map_item(
            &slot,
            miden_protocol::account::StorageMapKey::new(claim_key)
        )?,
        Word::from([1u32, 0, 0, 0])
    );

    for (i, (label, sender, recipient, target_week, deadline, amount, funding, expected)) in [
        (
            "duplicate week",
            claimant.id(),
            claimant.id(),
            week,
            expiry,
            10_000_000,
            10000,
            "already claimed this week",
        ),
        (
            "wrong recipient",
            other.id(),
            claimant.id(),
            week,
            expiry,
            10_000_000,
            10000,
            "recipient suffix mismatch",
        ),
        (
            "previous week",
            other.id(),
            other.id(),
            week - 1,
            expiry,
            10_000_000,
            10000,
            "approval week mismatch",
        ),
        (
            "future week",
            other.id(),
            other.id(),
            week + 1,
            expiry,
            10_000_000,
            10000,
            "approval week mismatch",
        ),
        (
            "week wraparound",
            other.id(),
            other.id(),
            u32::MAX,
            expiry,
            10_000_000,
            10000,
            "approval week mismatch",
        ),
        (
            "expired",
            other.id(),
            other.id(),
            week,
            MockChain::TIMESTAMP_START_SECS - 1,
            10_000_000,
            10000,
            "claim approval expired",
        ),
        (
            "wrong amount",
            other.id(),
            other.id(),
            week,
            expiry,
            11_000_000,
            10000,
            "allocation must be ten GC",
        ),
        (
            "underfunded with issuer reserves",
            other.id(),
            other.id(),
            week,
            expiry,
            10_000_000,
            100,
            "do not cover its required fee",
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let notes = claim_notes(
            sender,
            recipient,
            issuer.id(),
            target_week,
            deadline,
            amount,
            funding,
            50 + i as u32,
        )?;
        let result = chain
            .build_transaction(updated.clone())
            .unauthenticated_input_notes(notes)
            .build()?
            .execute()
            .await;
        let err = match result {
            Err(e) => format!("{e:#}"),
            Ok(_) => anyhow::bail!("negative case passed: {label}"),
        };
        if !err.contains(expected) {
            anyhow::bail!("unexpected failure for {label}: {err}");
        }
        println!("PASS reject {label}");
    }
    let valid_after_failures = claim_notes(
        other.id(),
        other.id(),
        issuer.id(),
        week,
        expiry,
        10_000_000,
        10000,
        89,
    )?;
    chain
        .build_transaction(updated.clone())
        .unauthenticated_input_notes(valid_after_failures)
        .build()?
        .execute()
        .await?;
    println!("PASS failed mint/fee checks do not reserve entitlement");
    let bypass_script = miden_standards::code_builder::CodeBuilder::default()
        .compile_tx_script("@transaction_script pub proc main dropw end")?;
    let bypass = chain
        .build_transaction(updated.clone())
        .tx_script(bypass_script)
        .build()?
        .execute()
        .await;
    let bypass_error = match bypass {
        Ok(_) => anyhow::bail!("unallowlisted transaction script accepted"),
        Err(e) => format!("{e:#}"),
    };
    assert!(
        bypass_error.contains("transaction script") || bypass_error.contains("tx script"),
        "{bypass_error}"
    );
    println!("PASS arbitrary transaction script blocked by canonical network auth");
    let next_monday = (week + 1) * 604800 - 259200;
    chain.add_pending_executed_transaction(&tx)?;
    chain.prove_next_block_at(next_monday)?;
    println!("PASS prior-week-reference claim can be included in Monday block (clock limitation)");
    let monday_notes = claim_notes(
        claimant.id(),
        claimant.id(),
        issuer.id(),
        week + 1,
        next_monday + 86400,
        10_000_000,
        10000,
        90,
    )?;
    chain
        .build_transaction(issuer.id())
        .unauthenticated_input_notes(monday_notes)
        .build()?
        .execute()
        .await?;
    println!("PASS fresh explicit next-week claim after Monday");
    let old_notes = claim_notes(
        other.id(),
        other.id(),
        issuer.id(),
        week,
        expiry,
        10_000_000,
        10000,
        91,
    )?;
    let old_result = chain
        .build_transaction(issuer.id())
        .unauthenticated_input_notes(old_notes)
        .build()?
        .execute()
        .await;
    assert!(
        old_result.is_err(),
        "old-week approval must fail at fresh Monday reference"
    );
    println!("PASS stale prior-week approval rejected at fresh Monday reference");

    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn claim_notes(
    sender: miden_protocol::account::AccountId,
    recipient: miden_protocol::account::AccountId,
    issuer: miden_protocol::account::AccountId,
    week: u32,
    expiry: u32,
    amount: u64,
    funding: u64,
    serial: u32,
) -> anyhow::Result<[miden_protocol::note::Note; 2]> {
    use miden_protocol::{
        Felt, Word,
        block::BlockNumber,
        note::{Note, NoteTag},
    };
    use miden_standards::note::{FeeSponsorshipNote, MintNote, MintNoteStorage, P2idNote};
    let native = miden_protocol::testing::account_id::ACCOUNT_ID_FEE_FAUCET.try_into()?;
    let receipt: Note = P2idNote::builder()
        .sender(issuer)
        .target(recipient)
        .salt([Felt::from(week), Felt::from(expiry)])
        .assets([Asset::from(FungibleAsset::new(issuer, amount)?)])
        .serial_number(Word::from([serial, 1, 2, 3]))
        .build()?
        .into();
    let request: Note = MintNote::builder()
        .sender(sender)
        .serial_number(Word::from([serial, 4, 5, 6]))
        .mint_storage(MintNoteStorage::new_public(
            receipt.recipient().clone(),
            FungibleAsset::new(issuer, amount)?,
            NoteTag::with_account_target(recipient),
        )?)
        .build()?
        .into();
    let fee: Note = FeeSponsorshipNote::builder()
        .sender(sender)
        .target_account(issuer)
        .feature_note_id(request.id())
        .reclaimer(sender)
        .reclaim_height(BlockNumber::from(100u32))
        .serial_number(Word::from([serial, 7, 8, 9]))
        .asset(FungibleAsset::new(native, funding)?)
        .build()?
        .into();
    Ok([request, fee])
}

fn issuer_account(
    b: &mut miden_testing::MockChainBuilder,
    owner: miden_protocol::account::AccountId,
) -> anyhow::Result<miden_protocol::account::Account> {
    let native = miden_protocol::testing::account_id::ACCOUNT_ID_FEE_FAUCET.try_into()?;
    let issuer = bread_gamecoin::issuer_builder([8; 32], owner, native)?.build_existing()?;
    b.add_account(issuer.clone())?;
    Ok(issuer)
}
