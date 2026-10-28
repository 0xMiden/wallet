use std::env;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;
use std::process::ExitCode;

use miden_client::account::AccountId;
use miden_client::rpc::domain::account::AccountProof;
use miden_client::rpc::generated::rpc::{EndpointLimits, GetAccountResponse, GetBlockHeaderByNumberResponse, GetLimitsResponse};
use miden_client::rpc::{RpcEndpoint, RpcLimits};
use miden_client::testing::MockChain;
use miden_client::utils::Deserializable;
use miden_client::Word;
use miden_objects::DecodeMessageExt;
use prost::Message;

const MAX_CHAIN_BYTES: u64 = 16 * 1024 * 1024;
const MAX_BLOCKS: usize = 32;
const MAX_OUTPUT_BYTES: usize = 2 * 1024 * 1024;
type Result<T> = std::result::Result<T, &'static str>;

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "input_metadata")?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err("input_bound");
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| "input_open")?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "input_read")?;
    if bytes.len() as u64 > limit {
        return Err("input_bound");
    }
    Ok(bytes)
}

fn save_new(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|_| "output_create")?;
    file.write_all(bytes).map_err(|_| "output_write")
}

fn produce(chain_path: &Path, account_path: &Path, output: &Path) -> Result<()> {
    let chain_bytes = read_bounded(chain_path, MAX_CHAIN_BYTES)?;
    let chain = MockChain::read_from_bytes(&chain_bytes).map_err(|_| "chain_decode")?;
    let account_text = read_bounded(account_path, 128)?;
    let account_text = std::str::from_utf8(&account_text).map_err(|_| "account_encoding")?;
    let account_id = AccountId::from_hex(account_text.trim()).map_err(|_| "account_decode")?;
    if !account_id.is_private() {
        return Err("private_account_required");
    }
    let tip = chain.latest_block_header();
    let block_count = tip.block_num().as_usize().checked_add(1).ok_or("chain_bound")?;
    if block_count > MAX_BLOCKS || chain.proven_blocks().len() != block_count {
        return Err("chain_bound");
    }
    let witness = chain.account_tree().open(account_id);
    // This first producer covers the genuine undeployed-account recovery branch only.
    if witness.state_commitment() != Word::empty() {
        return Err("undeployed_account_required");
    }
    if witness.clone().into_proof().compute_root() != tip.account_root() {
        return Err("account_root_binding");
    }
    let response = GetAccountResponse {
        block_num: Some(tip.block_num().into()),
        witness: Some(witness.into()),
        details: None,
    };
    let account_bytes = response.encode_to_vec();
    let decoded = GetAccountResponse::decode(account_bytes.as_slice()).map_err(|_| "account_wire")?;
    let proof = AccountProof::try_from(decoded).map_err(|_| "account_wire_domain")?;
    if proof.account_id() != account_id
        || proof.account_witness().clone().into_proof().compute_root() != tip.account_root()
    {
        return Err("account_wire_binding");
    }
    let mmr = chain.blockchain().as_mmr();
    let protocol = chain.protocol_config();
    let defaults = RpcLimits::default();
    let mut limits = GetLimitsResponse::default();
    for (endpoint, parameter, value) in [
        (RpcEndpoint::GetNotesById, "note_id", defaults.note_ids_limit),
        (RpcEndpoint::SyncNullifiers, "nullifier_prefix", defaults.nullifiers_limit),
        (RpcEndpoint::SyncTransactions, "account_id", defaults.account_ids_limit),
        (RpcEndpoint::SyncNotes, "note_tag", defaults.note_tags_limit),
    ] {
        limits.endpoints.insert(
            endpoint.proto_name().into(),
            EndpointLimits { parameters: [(parameter.into(), value)].into() },
        );
    }
    let limits_bytes = limits.encode_to_vec();
    let decoded = GetLimitsResponse::decode(limits_bytes.as_slice()).map_err(|_| "limits_wire")?;
    let readback = RpcLimits::try_from(decoded).map_err(|_| "limits_domain")?;
    if readback.note_ids_limit != defaults.note_ids_limit
        || readback.nullifiers_limit != defaults.nullifiers_limit
        || readback.account_ids_limit != defaults.account_ids_limit
        || readback.note_tags_limit != defaults.note_tags_limit
    {
        return Err("limits_wire_binding");
    }
    let mut outputs = vec![
        ("account.pb".to_owned(), account_bytes),
        ("limits.pb".to_owned(), limits_bytes),
    ];
    for height in 0..block_count {
        let header = chain.block_header(height);
        if header.protocol_config_commitment() != protocol.to_commitment() {
            return Err("protocol_rotation_unsupported");
        }
        let inclusion = mmr.open(height).map_err(|_| "header_mmr_open")?;
        if inclusion.leaf() != header.commitment() {
            return Err("header_mmr_leaf");
        }
        mmr.peaks()
            .verify(header.commitment(), inclusion.clone())
            .map_err(|_| "header_mmr_verify")?;
        let chain_length = u32::try_from(inclusion.forest().num_leaves()).map_err(|_| "mmr_bound")?;
        let response = GetBlockHeaderByNumberResponse {
            block_header: Some(header.clone().into()),
            mmr_path: Some(inclusion.merkle_path().into()),
            chain_length: Some(chain_length),
            protocol_config: Some(protocol.into()),
        };
        let bytes = response.encode_to_vec();
        let decoded = GetBlockHeaderByNumberResponse::decode(bytes.as_slice())
            .map_err(|_| "header_wire")?;
        let decoded_header = decoded
            .block_header
            .ok_or("header_wire_missing")?
            .decode_and_build_unchecked()
            .map_err(|_| "header_wire_domain")?;
        if decoded_header.commitment() != header.commitment() {
            return Err("header_wire_binding");
        }
        outputs.push((format!("header-{height}.pb"), bytes));
    }
    let output_bytes = outputs.iter().try_fold(0usize, |sum, (_, bytes)| {
        sum.checked_add(bytes.len()).ok_or("output_bound")
    })?;
    if output_bytes > MAX_OUTPUT_BYTES {
        return Err("output_bound");
    }
    // Never emit the serialized MockChain, which also contains fixture signing material.
    fs::create_dir(output).map_err(|_| "output_directory")?;
    for (name, bytes) in outputs {
        save_new(&output.join(name), &bytes)?;
    }
    let receipt = format!(
        "{{\"schema\":1,\"account_responses\":1,\"header_responses\":{block_count},\"output_bytes\":{output_bytes},\"account_absent\":true,\"account_root_bound\":true,\"headers_mmr_verified\":true,\"generated_wire_roundtrip\":true}}\n"
    );
    save_new(&output.join("receipt.json"), receipt.as_bytes())?;
    println!("PRODUCER_COMPLETE account_responses=1 header_responses={block_count}");
    Ok(())
}

fn main() -> ExitCode {
    std::panic::set_hook(Box::new(|_| eprintln!("PRODUCER_REFUSED phase=panic")));
    let args: Vec<_> = env::args_os().collect();
    let result = if args.len() == 4 {
        produce(Path::new(&args[1]), Path::new(&args[2]), Path::new(&args[3]))
    } else {
        Err("arguments")
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(phase) => {
            eprintln!("PRODUCER_REFUSED phase={phase}");
            ExitCode::FAILURE
        }
    }
}
