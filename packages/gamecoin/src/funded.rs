//! Funded claim ABI v1. Receipt IDs include the refund determined during execution.
use miden_protocol::{
    Felt, Hasher, Word,
    account::{
        AccountBuilder, AccountComponent, AccountId, AccountType, StorageMap, StorageSlot,
        StorageSlotName, component::AccountComponentMetadata,
    },
    asset::{AssetAmount, FungibleAsset, TokenSymbol},
    note::{
        Note, NoteAssets, NoteAttachments, NoteRecipient, NoteScript, NoteStorage, NoteTag,
        NoteType, PartialNoteMetadata,
    },
};
use miden_standards::{
    account::{
        access::AccessControl,
        auth::{AuthNetworkAccount, SponsorshipPolicy},
        faucets::{FungibleFaucet, TokenName},
        fees::{FeePolicy, FeePolicyManager},
        policies::{BurnPolicy, MintPolicy, TokenPolicyManager},
        wallets::BasicWallet,
    },
    code_builder::CodeBuilder,
    note::{MintNoteStorage, NetworkAccountTarget, NoteExecutionHint, P2idNote},
    tx_script::ExpirationTransactionScript,
};
pub const RECEIPT_DOMAIN_TAG: u32 = 0x47435231;
pub const CLAIM_STORAGE_ITEMS: usize = 36;
pub const MAX_CLAIMS: usize = miden_protocol::MAX_OUTPUT_NOTES_PER_TX - 1;
pub const NETWORK_SLOT: &str = "bread::gc::network";
pub struct FundedClaim {
    pub issuer: AccountId,
    pub native: AccountId,
    pub issuer_code: Word,
    pub network: Word,
    pub sender: AccountId,
    pub week: u32,
    pub expiry: u32,
    pub reclaim_height: u32,
    pub receipt_tag: NoteTag,
    pub budget: u64,
    pub serial: Word,
}
static CLAIM_SCRIPT: std::sync::LazyLock<NoteScript> = std::sync::LazyLock::new(|| {
    CodeBuilder::default()
        .compile_note_script(
            include_str!("claim.masm")
                .replace("{RECEIPT_DOMAIN_TAG}", &RECEIPT_DOMAIN_TAG.to_string()),
        )
        .expect("embedded claim script must compile")
});
pub fn claim_script() -> anyhow::Result<NoteScript> {
    Ok(CLAIM_SCRIPT.clone())
}
pub fn derived_receipt_serial(note: &Note) -> Word {
    let mut elements = vec![
        Felt::from(RECEIPT_DOMAIN_TAG),
        Felt::ONE,
        Felt::ZERO,
        Felt::ZERO,
    ];
    elements.extend_from_slice(note.script().root().as_elements());
    elements.extend_from_slice(note.recipient().serial_num().as_elements());
    elements.extend_from_slice(note.metadata().to_metadata_word().as_elements());
    elements.extend_from_slice(note.metadata().attachments_commitment().as_elements());
    elements.extend_from_slice(note.assets().commitment().as_elements());
    elements.extend_from_slice(&note.recipient().storage().items()[..4]);
    elements.extend_from_slice(&note.recipient().storage().items()[8..]);
    Hasher::hash_elements(&elements)
}
pub fn claim_note(c: &FundedClaim) -> anyhow::Result<Note> {
    let initial = build_note(c, Word::empty(), true)?;
    build_note(c, derived_receipt_serial(&initial), true)
}
/// Unrouted, fully bound initial claim; issuer execution accepts this only at nonce zero.
pub fn bootstrap_claim_note(c: &FundedClaim) -> anyhow::Result<Note> {
    let initial = build_note(c, Word::empty(), false)?;
    build_note(c, derived_receipt_serial(&initial), false)
}
fn build_note(c: &FundedClaim, receipt_serial: Word, routed: bool) -> anyhow::Result<Note> {
    anyhow::ensure!(
        c.reclaim_height > 0 && c.budget > 0,
        "finite reclaim height and positive budget required"
    );
    let receipt: Note = P2idNote::builder()
        .sender(c.issuer)
        .target(c.sender)
        .salt([c.week.into(), c.expiry.into()])
        .assets([FungibleAsset::new(c.issuer, crate::WEEKLY_ALLOCATION)?])
        .serial_number(receipt_serial)
        .note_type(NoteType::Public)
        .build()?
        .into();
    let storage: NoteStorage = MintNoteStorage::new_public(
        receipt.recipient().clone(),
        FungibleAsset::new(c.issuer, crate::WEEKLY_ALLOCATION)?,
        c.receipt_tag,
    )?
    .into();
    let mut fields = storage.items().to_vec();
    fields.extend_from_slice(c.issuer_code.as_elements());
    fields.extend([Felt::from(c.reclaim_height), Felt::ONE]);
    fields.extend([Felt::ZERO, Felt::ZERO]);
    fields.extend_from_slice(c.network.as_elements());
    let attachment = NetworkAccountTarget::new(c.issuer, NoteExecutionHint::Always)?;
    Ok(Note::with_attachments(
        NoteAssets::new(vec![FungibleAsset::new(c.native, c.budget)?.into()])?,
        PartialNoteMetadata::new(c.sender, NoteType::Public)
            .with_tag(NoteTag::with_account_target(c.issuer)),
        NoteRecipient::new(c.serial, claim_script()?, NoteStorage::new(fields)?),
        if routed {
            NoteAttachments::new(vec![attachment.into()])?
        } else {
            NoteAttachments::empty()
        },
    ))
}
pub fn funded_issuer_builder(
    seed: [u8; 32],
    owner: AccountId,
    native: AccountId,
    network: Word,
) -> anyhow::Result<AccountBuilder> {
    let claim_root = claim_script()?.root();
    let fee_code = CodeBuilder::default().compile_component_code(
        "bread::gc::funded_fee",
        &include_str!("funded-fee.masm")
            .replace("{CLAIM_ROOT}", &claim_root.to_string())
            .replace("{P2ID_ROOT}", &P2idNote::script_root().to_string()),
    )?;
    let fee_root = fee_code
        .get_procedure_root_by_path("bread::gc::funded_fee::compute_note_fee")
        .unwrap();
    let fee = FeePolicy::custom(
        fee_root,
        [AccountComponent::new(
            fee_code,
            vec![],
            AccountComponentMetadata::new("bread::gc::funded_fee"),
        )?],
    )?;
    let manager = FeePolicyManager::builder()
        .fee_faucet_id(native)
        .active_fee_policy(fee)
        .build();
    let standard = AuthNetworkAccount::custom([claim_root].into_iter().collect(), manager)?
        .with_allowed_tx_scripts([ExpirationTransactionScript::script_root()])
        .with_sponsorship_policy(SponsorshipPolicy::AtMostCollectedFees);
    let mut pieces = standard.into_iter();
    let original = pieces.next().unwrap();
    let auth_code = CodeBuilder::default().compile_component_code(
        "bread::gc::funded_auth",
        &include_str!("funded-auth.masm")
            .replace("{CLAIM_ROOT}", &claim_root.to_string())
            .replace("{MAX_CLAIMS}", &MAX_CLAIMS.to_string()),
    )?;
    let auth = AccountComponent::new(
        auth_code,
        original.storage_slots().to_vec(),
        original.metadata().clone(),
    )?;
    let weekly_code = CodeBuilder::default().compile_component_code(
        "bread::gc::funded_weekly",
        &include_str!("funded-weekly.masm")
            .replace("{CLAIM_ROOT}", &claim_root.to_string())
            .replace("{P2ID_ROOT}", &P2idNote::script_root().to_string()),
    )?;
    let weekly_root = weekly_code
        .get_procedure_root_by_path("bread::gc::funded_weekly::check_policy")
        .unwrap();
    let weekly = MintPolicy::custom(
        weekly_root,
        [AccountComponent::new(
            weekly_code,
            vec![
                StorageSlot::with_map(
                    StorageSlotName::new(crate::CLAIMS_SLOT)?,
                    StorageMap::default(),
                ),
                StorageSlot::with_value(StorageSlotName::new(NETWORK_SLOT)?, network),
            ],
            AccountComponentMetadata::new("bread::gc::funded_weekly"),
        )?],
    )?;
    let policies = TokenPolicyManager::builder()
        .active_mint_policy(weekly)
        .active_burn_policy(BurnPolicy::allow_all())
        .build();
    let faucet = FungibleFaucet::builder()
        .name(TokenName::new("Game Coin")?)
        .symbol(TokenSymbol::new("GC")?)
        .decimals(6)
        .max_supply(AssetAmount::new(1000000000000)?)
        .build()?;
    Ok(AccountBuilder::new(seed)
        .account_type(AccountType::Public)
        .with_component(faucet)
        .with_components(AccessControl::Ownable2Step { owner })
        .with_components(policies)
        .with_component(miden_standards::account::access::Pausable::unpaused())
        .with_component(miden_standards::account::access::PausableManager)
        .with_component(miden_standards::account::inspection::CodeInspection)
        .with_component(BasicWallet)
        .with_component(auth)
        .with_components(pieces))
}
