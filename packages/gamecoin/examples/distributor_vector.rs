//! Offline construction only. Does not connect, sign, mint, fund or deploy.
use bread_gamecoin::distributor::{
    CanonicalDistribution, FundedClaim, FundedDeposit, bootstrap_deposit_note, claim_note,
    deposit_note, distributor_builder,
};
use miden_protocol::{
    Word,
    account::AccountId,
    note::{Note, NoteTag},
    utils::serde::Serializable,
};
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn vector(label: &str, note: &Note) {
    let fields = note
        .recipient()
        .storage()
        .items()
        .iter()
        .map(|f| format!("\"{f}\""))
        .collect::<Vec<_>>()
        .join(",");
    println!(
        "\"{label}\":{{\"scriptRoot\":\"{}\",\"scriptBytesHex\":\"{}\",\"noteId\":\"{}\",\"storage\":[{fields}],\"recipient\":\"{}\",\"storageCommitment\":\"{}\",\"assetsCommitment\":\"{}\",\"noteBytesHex\":\"{}\"}}",
        note.script().root(),
        hex(&note.script().to_bytes()),
        note.id(),
        note.recipient().digest(),
        note.recipient().storage().commitment(),
        note.assets().commitment(),
        hex(&note.to_bytes())
    );
}
fn main() -> anyhow::Result<()> {
    let gc = AccountId::from_hex("0xe1f2c48d5bfa8d5173dfcfdc8ac977")?;
    let native = AccountId::from_hex("0x4cbdcaffe75f0a317482224dae6436")?;
    let sender = AccountId::from_hex("0xe4ce561e0a4caa911eaabf98018d54")?;
    let network =
        Word::try_from("0x280189b64c3a22c9d8e6e6c2cd567f58c528fee3b73724a6d855066642d7e567")?;
    let account = distributor_builder([42; 32], gc, native, network)?.build()?;
    let config = CanonicalDistribution::from_account(&account)?;
    println!(
        "{{\"evidence\":\"construction-only, not deployed; deterministic fixture seed [42;32]\",\"abiVersion\":2,\"distributor\":\"{}\",\"distributorCode\":\"{}\",\"gcFaucet\":\"{}\",\"native\":\"{}\",\"network\":\"{}\",\"claimRoot\":\"{}\",\"depositRoot\":\"{}\",\"accountSeed\":\"{}\",\"accountBytesHex\":\"{}\",",
        config.distributor,
        config.distributor_code,
        gc,
        native,
        network,
        config.claim_root,
        config.deposit_root,
        account.seed().unwrap(),
        hex(&account.to_bytes())
    );
    let claim = claim_note(&FundedClaim {
        distributor: account.id(),
        gc_faucet: gc,
        native,
        distributor_code: account.code().commitment(),
        network,
        sender,
        week: 2964,
        expiry: 1792686458,
        reclaim_height: 460800,
        receipt_tag: NoteTag::with_account_target(sender),
        budget: 1000,
        serial: Word::from([1u32, 2, 3, 4]),
    })?;
    vector("claim", &claim);
    println!(",");
    let deposit = FundedDeposit {
        distributor: account.id(),
        gc_faucet: gc,
        native,
        distributor_code: account.code().commitment(),
        network,
        sender,
        reclaim_height: 460800,
        receipt_tag: NoteTag::with_account_target(sender),
        amount: 20_000_000,
        budget: 1000,
        serial: Word::from([5u32, 6, 7, 8]),
    };
    vector("deposit", &deposit_note(&deposit)?);
    println!(",");
    vector("bootstrapDeposit", &bootstrap_deposit_note(&deposit)?);
    println!("}}");
    Ok(())
}
