# Native recovery response fixture producer

This CI-only prerequisite uses the exact SDK fd52477d7c7d5d475dc14987ebbd7a36dbb703da lock and native revision 9a9b58a598a71801199d69309e1fb8e4ef27293c. It does not open a wallet database, run recovery, or implement a service.

The binary accepts three paths: a disposable browser MockChain serialization, a file containing the intended private account ID, and a new output directory. Inputs must stay inside the disposable CI job. Never upload the chain or account input, or log their content. The chain serialization includes signing material. Output consists only of generated RPC protobuf account/header responses and a count/boolean receipt. A transport must still bind requests to these fixtures.

The first scope is one undeployed private account at the chain tip. The account must have a zero state commitment in the real MockChain account tree. Its real SMT witness is checked against the tip account root before and after generated protobuf roundtrip. Every header, including genesis, is accompanied by a real MMR opening verified against that chain. The producer refuses protocol-configuration rotation, more than 32 blocks, input above 16 MiB, and aggregate response bytes above 2 MiB. Generated response construction uses public conversions, with no handwritten protobuf or Merkle proofs.

CI setup, owned by the controller:

1. Use Rust 1.98.1 and Python 3.11 or later. Set CARGO_BUILD_JOBS=2 and RAYON_NUM_THREADS=2. Keep the original bounded CI timeout.
2. In a disposable copy of this proof directory, copy pinned-sdk.Cargo.lock to Cargo.lock, then run cargo update --workspace. This permits the new local root to enter the lock while retaining existing dependency selections.
3. Run python3 verify-lock.py before compilation. Any package/version/source/checksum absent from the exact SDK lock refuses the run. Do not accept or refresh a drifting graph.
4. Run cargo build --locked --jobs 2. No local compilation is authorized. Save the dependency receipt, binary hash and compiler version.
5. Feed input produced by the exact fd browser MockChain. Run the binary with the three private paths; capture only its closed phase/count output. Bind input hashes privately and upload only generated public responses plus safe receipts.

The pinned lock is a public source dependency, not a claim that this standalone crate has compiled. Source APIs have been inspected; dependency resolution, compilation, browser-to-native codec compatibility, HTTP/gRPC transport, Guardian request authentication and actual Vault missing-account recovery are still unexecuted. No healthy recovery or submission result is implied.
