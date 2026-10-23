//! Canonical GC distribution ABI v2; legacy experimental roots remain in `funded`.
use miden_protocol::{
    Felt, Hasher, Word,
    account::{
        AccountBuilder, AccountComponent, AccountId, AccountType, StorageMap, StorageSlot,
        StorageSlotName, component::AccountComponentMetadata,
    },
    asset::{AssetId, FungibleAsset},
    note::{
        Note, NoteAssets, NoteAttachments, NoteRecipient, NoteScript, NoteStorage, NoteTag,
        NoteType, PartialNoteMetadata,
    },
};
use miden_standards::{
    account::{
        auth::{AuthNetworkAccount, SponsorshipPolicy},
        fees::{FeePolicy, FeePolicyManager},
        wallets::BasicWallet,
    },
    code_builder::CodeBuilder,
    note::{MintNoteStorage, NetworkAccountTarget, NoteExecutionHint, P2idNote},
    tx_script::ExpirationTransactionScript,
};
pub const RECEIPT_DOMAIN_TAG: u32 = 0x47435232;
pub const CLAIM_STORAGE_ITEMS: usize = 36;
pub const MAX_CLAIMS: usize = miden_protocol::MAX_OUTPUT_NOTES_PER_TX - 1;
pub const NETWORK_SLOT: &str = "bread::gc::network";
pub const CLAIMS_SLOT: &str = "bread::gc::distributor::weekly_claims";
pub struct FundedClaim {
    pub distributor: AccountId,
    pub gc_faucet: AccountId,
    pub native: AccountId,
    pub distributor_code: Word,
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
            include_str!("distributor-claim.masm")
                .replace("{RECEIPT_DOMAIN_TAG}", &RECEIPT_DOMAIN_TAG.to_string())
                .replace(
                    "{CHECKED_ROOT}",
                    &checked_code()
                        .unwrap()
                        .get_procedure_root_by_path("bread::gc::distributor::claim")
                        .unwrap()
                        .to_string(),
                ),
        )
        .expect("embedded claim script must compile")
});
pub fn claim_script() -> anyhow::Result<NoteScript> {
    Ok(CLAIM_SCRIPT.clone())
}
pub fn derived_receipt_serial(note: &Note) -> Word {
    let mut elements = vec![
        Felt::from(RECEIPT_DOMAIN_TAG),
        Felt::from(2u32),
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
/// Build a routed v2 claim that spends held canonical GC.
pub fn claim_note(c: &FundedClaim) -> anyhow::Result<Note> {
    let initial = build_note(c, Word::empty(), true)?;
    build_note(c, derived_receipt_serial(&initial), true)
}
fn build_note(c: &FundedClaim, receipt_serial: Word, routed: bool) -> anyhow::Result<Note> {
    anyhow::ensure!(
        c.reclaim_height > 0 && c.budget > 0,
        "finite reclaim height and positive budget required"
    );
    let receipt: Note = P2idNote::builder()
        .sender(c.distributor)
        .target(c.sender)
        .salt([c.week.into(), c.expiry.into()])
        .assets([FungibleAsset::new(c.gc_faucet, crate::WEEKLY_ALLOCATION)?])
        .serial_number(receipt_serial)
        .note_type(NoteType::Public)
        .build()?
        .into();
    let storage: NoteStorage = MintNoteStorage::new_public(
        receipt.recipient().clone(),
        FungibleAsset::new(c.gc_faucet, crate::WEEKLY_ALLOCATION)?,
        c.receipt_tag,
    )?
    .into();
    let mut fields = storage.items().to_vec();
    fields.extend_from_slice(c.distributor_code.as_elements());
    fields.extend([Felt::from(c.reclaim_height), Felt::from(2u32)]);
    fields.extend([c.distributor.suffix(), c.distributor.prefix().as_felt()]);
    fields.extend_from_slice(c.network.as_elements());
    let attachment = NetworkAccountTarget::new(c.distributor, NoteExecutionHint::Always)?;
    Ok(Note::with_attachments(
        NoteAssets::new(vec![FungibleAsset::new(c.native, c.budget)?.into()])?,
        PartialNoteMetadata::new(c.sender, NoteType::Public)
            .with_tag(NoteTag::with_account_target(c.distributor)),
        NoteRecipient::new(c.serial, claim_script()?, NoteStorage::new(fields)?),
        if routed {
            NoteAttachments::new(vec![attachment.into()])?
        } else {
            NoteAttachments::empty()
        },
    ))
}
/// Deposits and claims use distinct roots and cannot be mixed in one transaction.
pub struct FundedDeposit {
    pub distributor: AccountId,
    pub gc_faucet: AccountId,
    pub native: AccountId,
    pub distributor_code: Word,
    pub network: Word,
    pub sender: AccountId,
    pub reclaim_height: u32,
    pub receipt_tag: NoteTag,
    pub amount: u64,
    pub budget: u64,
    pub serial: Word,
}
pub const DEPOSIT_DOMAIN_TAG: u32 = 0x47434432;
pub fn deposit_script() -> anyhow::Result<NoteScript> {
    Ok(CodeBuilder::default().compile_note_script(
        include_str!("distributor-deposit.masm")
            .replace("{RECEIPT_DOMAIN_TAG}", &DEPOSIT_DOMAIN_TAG.to_string())
            .replace(
                "{CHECKED_ROOT}",
                &checked_code()?
                    .get_procedure_root_by_path("bread::gc::distributor::deposit")
                    .unwrap()
                    .to_string(),
            ),
    )?)
}
pub fn deposit_note(c: &FundedDeposit) -> anyhow::Result<Note> {
    build_deposit(c, true)
}
/// Nonce-zero creation only, fully bound to distributor ID, code and network.
pub fn bootstrap_deposit_note(c: &FundedDeposit) -> anyhow::Result<Note> {
    build_deposit(c, false)
}
fn build_deposit(c: &FundedDeposit, routed: bool) -> anyhow::Result<Note> {
    anyhow::ensure!(
        c.amount > 0 && c.budget > 0 && c.reclaim_height > 0,
        "positive deposit, budget and finite reclaim height required"
    );
    let template = FundedClaim {
        distributor: c.distributor,
        gc_faucet: c.gc_faucet,
        native: c.native,
        distributor_code: c.distributor_code,
        network: c.network,
        sender: c.sender,
        week: 0,
        expiry: 0,
        reclaim_height: c.reclaim_height,
        receipt_tag: c.receipt_tag,
        budget: c.budget,
        serial: c.serial,
    };
    let base = build_note(&template, Word::empty(), routed)?;
    let mut fields = base.recipient().storage().items().to_vec();
    fields[12] = Felt::new(c.amount)?;
    let assets = NoteAssets::new(vec![
        FungibleAsset::new(c.gc_faucet, c.amount)?.into(),
        FungibleAsset::new(c.native, c.budget)?.into(),
    ])?;
    let initial = Note::with_attachments(
        assets.clone(),
        PartialNoteMetadata::new(c.sender, NoteType::Public).with_tag(base.metadata().tag()),
        NoteRecipient::new(
            c.serial,
            deposit_script()?,
            NoteStorage::new(fields.clone())?,
        ),
        base.attachments().clone(),
    );
    let mut elements = vec![
        Felt::from(DEPOSIT_DOMAIN_TAG),
        Felt::from(2u32),
        Felt::ZERO,
        Felt::ZERO,
    ];
    append_binding(&mut elements, &initial);
    fields[4..8].copy_from_slice(Hasher::hash_elements(&elements).as_elements());
    Ok(Note::with_attachments(
        assets,
        PartialNoteMetadata::new(c.sender, NoteType::Public).with_tag(base.metadata().tag()),
        NoteRecipient::new(c.serial, deposit_script()?, NoteStorage::new(fields)?),
        base.attachments().clone(),
    ))
}
fn append_binding(elements: &mut Vec<Felt>, note: &Note) {
    elements.extend_from_slice(note.script().root().as_elements());
    elements.extend_from_slice(note.recipient().serial_num().as_elements());
    elements.extend_from_slice(note.metadata().to_metadata_word().as_elements());
    elements.extend_from_slice(note.metadata().attachments_commitment().as_elements());
    elements.extend_from_slice(note.assets().commitment().as_elements());
    elements.extend_from_slice(&note.recipient().storage().items()[..4]);
    elements.extend_from_slice(&note.recipient().storage().items()[8..]);
}
fn checked_code() -> anyhow::Result<miden_protocol::account::component::AccountComponentCode> {
    Ok(CodeBuilder::default().compile_component_code(
        "bread::gc::distributor",
        &include_str!("distributor.masm")
            .replace("{P2ID_ROOT}", &P2idNote::script_root().to_string()),
    )?)
}
/// Fixed-code public BasicWallet network account, without a faucet, owner or upgrade procedure.
pub fn distributor_builder(
    seed: [u8; 32],
    gc_faucet: AccountId,
    native: AccountId,
    network: Word,
) -> anyhow::Result<AccountBuilder> {
    anyhow::ensure!(
        gc_faucet != native,
        "GC and native fee assets must be distinct"
    );
    anyhow::ensure!(
        !gc_faucet.asset_callback_flag().is_enabled(),
        "callback GC assets unsupported"
    );
    FungibleAsset::new(gc_faucet, 1)?;
    FungibleAsset::new(native, 1)?;
    let claim_root = claim_script()?.root();
    let deposit_root = deposit_script()?.root();
    let fee_code = CodeBuilder::default().compile_component_code(
        "bread::gc::distributor_fee",
        &include_str!("distributor-fee.masm")
            .replace("{CLAIM_ROOT}", &claim_root.to_string())
            .replace("{DEPOSIT_ROOT}", &deposit_root.to_string()),
    )?;
    let fee_root = fee_code
        .get_procedure_root_by_path("bread::gc::distributor_fee::compute_note_fee")
        .unwrap();
    let fee = FeePolicy::custom(
        fee_root,
        [AccountComponent::new(
            fee_code,
            vec![],
            AccountComponentMetadata::new("bread::gc::distributor_fee"),
        )?],
    )?;
    let manager = FeePolicyManager::builder()
        .fee_faucet_id(native)
        .active_fee_policy(fee)
        .build();
    let standard =
        AuthNetworkAccount::custom([claim_root, deposit_root].into_iter().collect(), manager)?
            .with_allowed_tx_scripts([ExpirationTransactionScript::script_root()])
            .with_sponsorship_policy(SponsorshipPolicy::AtMostCollectedFees);
    let mut pieces = standard.into_iter();
    let original = pieces.next().unwrap();
    let auth_code = CodeBuilder::default().compile_component_code(
        "bread::gc::distributor_auth",
        &include_str!("distributor-auth.masm")
            .replace("{CLAIM_ROOT}", &claim_root.to_string())
            .replace("{DEPOSIT_ROOT}", &deposit_root.to_string())
            .replace("{MAX_CLAIMS}", &MAX_CLAIMS.to_string()),
    )?;
    let auth = AccountComponent::new(
        auth_code,
        original.storage_slots().to_vec(),
        original.metadata().clone(),
    )?;
    let checked = AccountComponent::new(
        checked_code()?,
        vec![
            StorageSlot::with_map(StorageSlotName::new(CLAIMS_SLOT)?, StorageMap::default()),
            StorageSlot::with_value(StorageSlotName::new(NETWORK_SLOT)?, network),
            StorageSlot::with_value(
                StorageSlotName::new("bread::gc::distributor::asset")?,
                Word::from(AssetId::new_fungible(gc_faucet)),
            ),
            StorageSlot::with_value(
                StorageSlotName::new("bread::gc::distributor::claim_root")?,
                claim_root.into(),
            ),
            StorageSlot::with_value(
                StorageSlotName::new("bread::gc::distributor::deposit_root")?,
                deposit_root.into(),
            ),
        ],
        AccountComponentMetadata::new("bread::gc::distributor"),
    )?;
    Ok(AccountBuilder::new(seed)
        .account_type(AccountType::Public)
        .with_component(checked)
        .with_component(miden_standards::account::inspection::CodeInspection)
        .with_component(BasicWallet)
        .with_component(auth)
        .with_components(pieces))
}

/// Metadata read from the actual account, for reviewed deployment and client binding.
#[derive(Clone, Debug)]
pub struct CanonicalDistribution {
    pub distributor: AccountId,
    pub distributor_code: Word,
    pub gc_faucet: AccountId,
    pub native: AccountId,
    pub network: Word,
    pub abi_version: u32,
    pub claim_root: miden_protocol::note::NoteScriptRoot,
    pub deposit_root: miden_protocol::note::NoteScriptRoot,
}
impl CanonicalDistribution {
    pub fn from_account(account: &miden_protocol::account::Account) -> anyhow::Result<Self> {
        let gc_asset = AssetId::try_from(
            account
                .storage()
                .get_item(&StorageSlotName::new("bread::gc::distributor::asset")?)?,
        )?;
        let native_asset = AssetId::try_from(
            account
                .storage()
                .get_item(FeePolicyManager::fee_asset_id_slot())?,
        )?;
        let claim_root = claim_script()?.root();
        let deposit_root = deposit_script()?.root();
        anyhow::ensure!(
            account
                .storage()
                .get_item(&StorageSlotName::new("bread::gc::distributor::claim_root")?)?
                == Word::from(claim_root),
            "wrong claim root"
        );
        anyhow::ensure!(
            account.storage().get_item(&StorageSlotName::new(
                "bread::gc::distributor::deposit_root"
            )?)? == Word::from(deposit_root),
            "wrong deposit root"
        );
        Ok(Self {
            distributor: account.id(),
            distributor_code: account.code().commitment(),
            gc_faucet: gc_asset.faucet_id(),
            native: native_asset.faucet_id(),
            network: account
                .storage()
                .get_item(&StorageSlotName::new(NETWORK_SLOT)?)?,
            abi_version: 2,
            claim_root,
            deposit_root,
        })
    }
}
