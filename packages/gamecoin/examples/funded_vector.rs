//! Deterministic construction vector; does not contact a network or deploy an account.
use bread_gamecoin::funded::{FundedClaim, claim_note, funded_issuer_builder};
use miden_protocol::{Word, account::AccountId, note::NoteTag, utils::serde::Serializable};
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn main() -> anyhow::Result<()> {
    let native = AccountId::from_hex("0x4cbdcaffe75f0a317482224dae6436")?;
    let sender = AccountId::from_hex("0xe4ce561e0a4caa911eaabf98018d54")?;
    let owner = AccountId::from_hex("0x3b07d521857ce8810cfef844d0a568")?;
    let network =
        Word::try_from("0x280189b64c3a22c9d8e6e6c2cd567f58c528fee3b73724a6d855066642d7e567")?;
    let issuer = funded_issuer_builder([42; 32], owner, native, network)?.build()?;
    let c = FundedClaim {
        issuer: issuer.id(),
        native,
        issuer_code: issuer.code().commitment(),
        network,
        sender,
        week: 2964,
        expiry: 1792686458,
        reclaim_height: 460800,
        receipt_tag: NoteTag::with_account_target(sender),
        budget: 210,
        serial: Word::from([1u32, 2, 3, 4]),
    };
    let note = claim_note(&c)?;
    let receipt_serial = note.recipient().storage().items()[4..8]
        .iter()
        .map(|f| format!("\"{f}\""))
        .collect::<Vec<_>>()
        .join(",");
    let fields = note
        .recipient()
        .storage()
        .items()
        .iter()
        .map(|f| format!("\"{f}\""))
        .collect::<Vec<_>>()
        .join(",");
    println!(
        "{{\"evidence\":\"construction-only; execution tests separate\",\"abiVersion\":1,\"issuer\":\"{}\",\"native\":\"{}\",\"owner\":\"{}\",\"sender\":\"{}\",\"issuerCode\":\"{}\",\"network\":\"{}\",\"week\":{},\"expiry\":{},\"reclaimHeight\":{},\"receiptTag\":{},\"budget\":\"{}\",\"serial\":[1,2,3,4],\"receiptSerial\":[{receipt_serial}],\"storage\":[{}],\"scriptRoot\":\"{}\",\"scriptBytesHex\":\"{}\",\"noteId\":\"{}\",\"recipient\":\"{}\",\"storageCommitment\":\"{}\",\"assetsCommitment\":\"{}\",\"noteBytesHex\":\"{}\"}}",
        issuer.id(),
        native,
        owner,
        sender,
        c.issuer_code,
        network,
        c.week,
        c.expiry,
        c.reclaim_height,
        u32::from(c.receipt_tag),
        c.budget,
        fields,
        note.script().root(),
        hex(&note.script().to_bytes()),
        note.id(),
        note.recipient().digest(),
        note.recipient().storage().commitment(),
        note.assets().commitment(),
        hex(&note.to_bytes())
    );
    Ok(())
}
