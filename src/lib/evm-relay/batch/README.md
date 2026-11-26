# EVM relay batch

This folder builds the Uniswap Calibur "signed batched call" of the deposit-address relay. The wallet signs the
batch with the key of the relay address (an EOA that delegates to Calibur through EIP-7702). A relayer (a Cloudflare
Worker) checks the batch, submits it and pays the gas. Both sides import this one module, so they build
byte-identical batches.

## Rules

- Import only `viem` (and its subpaths) and files in this folder, by RELATIVE path. Do not import `lib/...`
  aliases, Node APIs, browser globals or wallet state. A Cloudflare Worker under `services/` imports this folder by
  relative path.
- Keep it pure: no I/O, no clock, no random values, no network reads. The caller reads the chain (the sequence, the
  salt, the delegation code) and passes the values in.
- A change to the calls, the types, the domain or the nonce key changes the digest. Then the wallet and the Worker
  must ship the change together, and the golden digests in the tests change.

## Exports (`index.ts`)

### Calibur (`calibur.ts`)

- `interface BatchCall { to: Address; value: bigint; data: Hex }`: one call of a batch.
- `interface CaliburPin { address: Address; runtimeHash: Hex; domainName: string; domainVersion: string }`: the
  Calibur deployment of a chain. This module does not use `runtimeHash`; the caller compares it with the code hash on
  chain.
- `interface BatchEnvelope { chainId: number; evmAddress: Address; executor: Address; batchNonce: bigint; salt: Hex; deadline: bigint }`:
  the batch values that do not depend on the calls. `evmAddress` is the verifying contract of the domain. `salt` is
  the `salt` of the EOA's `eip712Domain()`. `deadline` is in unix seconds.
- `interface SignedBatchedCall`: the Calibur struct (`batchedCall: { calls, revertOnFailure }`, `nonce`, `keyHash`,
  `executor`, `deadline`).
- `CALIBUR_ABI`: `execute(SignedBatchedCall, bytes wrappedSignature)`, `getSeq(uint256 key)`, `eip712Domain()`.
- `BATCH_TYPES`: the EIP-712 types (`SignedBatchedCall`, `BatchedCall`, `Call`).
- `buildSignedBatch(envelope, calls): SignedBatchedCall`: `keyHash` is the zero hash (the root key) and
  `revertOnFailure` is true.
- `batchTypedData(pin, envelope, calls)`: the typed data to sign. Domain:
  `{ name: pin.domainName, version: pin.domainVersion, chainId, verifyingContract: envelope.evmAddress, salt }`.
- `batchDigest(pin, envelope, calls): Hex`: the EIP-712 digest.
- `wrapSignature(signature): Hex`: `abi.encode(bytes signature, bytes hookData)` with `hookData = 0x`.
- `encodeExecution(envelope, calls, signature): Hex`: the calldata of `execute` on the EOA.
- `recoverBatchSigner(pin, envelope, calls, signature): Promise<Address>`: the signer of the batch (viem
  `recoverTypedDataAddress`).
- `caliburDelegationCode(pin): Hex`: `0xef0100` and the Calibur address, lower case.
- `isCaliburDelegation(code, pin): boolean`: true when the account code is that delegation, in any case.

### Nonce (`nonce.ts`)

- `RELAY_NONCE_KEY: bigint`: `BigInt(keccak256(stringToHex('miden.relay'))) >> 64n`. Every relay batch of an address
  uses this one key.
- `batchNonceOf(sequence): bigint`: `(RELAY_NONCE_KEY << 64n) | sequence`. `sequence` is `getSeq(RELAY_NONCE_KEY)` of
  the EOA and must be a uint64.
- `isRelayNonce(batchNonce): boolean`: true when the key of the nonce is `RELAY_NONCE_KEY`.

### Fee (`fee.ts`)

- `interface RelayFee { token: Address; recipient: Address; amount: bigint }`: a fee to the relayer. The zero `token`
  is the native coin.
- `isNativeToken(token): boolean`: true for the zero address.
- `buildFeeCall(fee): BatchCall`: `transfer(recipient, amount)` on an ERC-20 token, or a plain transfer of the native
  coin. It throws when `amount <= 0` or the recipient is the zero address.
- `readFeeCall(call): RelayFee | null`: the fee that a call pays, or null for a call of another shape. The relayer
  uses it to check the fee of a batch.

## No bridge code

This module does not know a bridge. The caller gives the calls of a batch as `BatchCall[]`: the wallet takes them
from the transaction that a bridge flow asks it to send (the Agglayer helpers, the Epoch SDK), and the relayer takes
them from the request. A helper that builds the calls of one bridge belongs to that bridge's own folder, not here.

## Tests

`testing.ts` holds test vectors only (the Sepolia values of the onramp prototype); production code does not import
it. `calibur.test.ts` proves that this module gives the golden digests of the prototype (branch
`utkarsh/feat/onramp-offramp-integration`).
