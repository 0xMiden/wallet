//! Offline GC issuer architecture research. Deployment and wallet activation are disabled.
//! The fee surplus refund and inclusion-time clock limitations described in README.md remain open.
use miden_protocol::{
    account::{AccountBuilder, AccountId, AccountType},
    asset::{AssetAmount, TokenSymbol},
};
use miden_standards::{
    account::{
        access::{AccessControl, Pausable, PausableManager},
        auth::{AuthNetworkAccount, SponsorshipPolicy},
        faucets::{FungibleFaucet, TokenName},
        fees::FeePolicyManager,
        policies::{BurnPolicy, TokenPolicyManager},
    },
    note::MintNote,
};

pub const GC_DECIMALS: u8 = 6;
pub const WEEKLY_ALLOCATION: u64 = 10_000_000;
pub const CLAIMS_SLOT: &str = "bread::gc::weekly_claims";

/// Construct the reviewed primitives for local tests; this does not deploy an issuer.
/// Owner can manage registered policies, but only this custom mint policy is registered.
pub fn issuer_builder(
    seed: [u8; 32],
    owner: AccountId,
    fee_faucet: AccountId,
) -> anyhow::Result<AccountBuilder> {
    let faucet = FungibleFaucet::builder()
        .name(TokenName::new("Game Coin")?)
        .symbol(TokenSymbol::new("GC")?)
        .decimals(GC_DECIMALS)
        .max_supply(AssetAmount::new(1_000_000_000_000)?)
        .build()?;
    let policies = TokenPolicyManager::builder()
        .active_mint_policy(weekly_policy()?)
        .active_burn_policy(BurnPolicy::allow_all())
        .build();
    let manager = FeePolicyManager::builder()
        .fee_faucet_id(fee_faucet)
        .active_fee_policy(fee_policy()?)
        .build();
    let auth = AuthNetworkAccount::new([MintNote::script_root()].into_iter().collect(), manager)?
        .with_sponsorship_policy(SponsorshipPolicy::AtMostCollectedFees);
    Ok(AccountBuilder::new(seed)
        .account_type(AccountType::Public)
        .with_component(faucet)
        .with_components(AccessControl::Ownable2Step { owner })
        .with_components(policies)
        .with_component(Pausable::unpaused())
        .with_component(PausableManager)
        .with_components(auth))
}

fn weekly_policy() -> anyhow::Result<miden_standards::account::policies::MintPolicy> {
    use miden_protocol::account::component::AccountComponentMetadata;
    use miden_protocol::account::{AccountComponent, StorageMap, StorageSlot, StorageSlotName};
    let code = miden_standards::code_builder::CodeBuilder::default().compile_component_code(
        "bread::gc",
        &include_str!("weekly.masm")
            .replace(
                "{MINT_ROOT}",
                &miden_standards::note::MintNote::script_root().to_string(),
            )
            .replace(
                "{P2ID_ROOT}",
                &miden_standards::note::P2idNote::script_root().to_string(),
            ),
    )?;
    let root = code
        .get_procedure_root_by_path("bread::gc::check_policy")
        .ok_or_else(|| anyhow::anyhow!("missing policy"))?;
    let slot = StorageSlot::with_map(
        StorageSlotName::new("bread::gc::weekly_claims")?,
        StorageMap::default(),
    );
    let component =
        AccountComponent::new(code, vec![slot], AccountComponentMetadata::new("bread::gc"))?;
    Ok(miden_standards::account::policies::MintPolicy::custom(
        root,
        [component],
    )?)
}

fn fee_policy() -> anyhow::Result<miden_standards::account::fees::FeePolicy> {
    use miden_protocol::account::{AccountComponent, component::AccountComponentMetadata};
    let code = miden_standards::code_builder::CodeBuilder::default()
        .compile_component_code("bread::gc::fees", include_str!("fee.masm"))?;
    let root = code
        .get_procedure_root_by_path("bread::gc::fees::compute_note_fee")
        .ok_or_else(|| anyhow::anyhow!("missing fee policy"))?;
    let component = AccountComponent::new(
        code,
        vec![],
        AccountComponentMetadata::new("bread::gc::fees"),
    )?;
    Ok(miden_standards::account::fees::FeePolicy::custom(
        root,
        [component],
    )?)
}

pub mod funded;
