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

### Agglayer deposit (`agglayer-deposit.ts`)

- `interface AgglayerDepositConfig { bridgeAddress: Address; midenNetworkId: number; forceUpdateGlobalExitRoot: boolean }`.
  `midenNetworkId` is the Agglayer network ID of Miden (a uint32), not an EVM chain ID.
- `interface RelayFee { recipient: Address; amount: bigint }`: the fee to the relayer, in the deposited token.
- `interface AgglayerDepositParams { token: Address; amount: bigint; midenAccountHex: string; fee: RelayFee | null }`.
  The zero `token` is the native coin. `amount` is the bridged amount after the fee. `fee: null` means sponsored.
- `BRIDGE_ASSET_ABI`: `bridgeAsset(uint32, address, uint256, address, bool, bytes)`.
- `isNativeToken(token): boolean`: true for the zero address.
- `buildAgglayerDepositCalls(config, params): BatchCall[]`: the calls, in this order:
  - ERC-20: `[transfer(fee.recipient, fee.amount) on the token]`, `approve(bridge, amount)` on the token,
    `bridgeAsset(midenNetworkId, midenDestination, amount, token, forceUpdateGlobalExitRoot, 0x)` on the bridge.
  - Native coin: `[{ to: fee.recipient, value: fee.amount, data: 0x }]`,
    `bridgeAsset(midenNetworkId, midenDestination, amount, 0x0, forceUpdateGlobalExitRoot, 0x)` on the bridge with
    `value = amount`. No approve.

  The fee call is present only when `fee` is not null. It throws when `amount <= 0`, the account hex is not valid,
  `fee.amount <= 0` or `fee.recipient` is the zero address.

### Relay kinds (`relay.ts`)

- `interface RelayKindInputs`: the config and the params of each kind. Today: `'agglayer-deposit'`.
- `type RelayKind = keyof RelayKindInputs` (`'agglayer-deposit'`).
- `nonceKeyOf(kind): bigint`: `BigInt(keccak256(stringToHex('miden.relay.' + kind))) >> 64n`.
- `batchNonceOf(kind, sequence): bigint`: `(nonceKeyOf(kind) << 64n) | sequence`. `sequence` is `getSeq(key)` of
  the EOA and must be a uint64.
- `buildRelayCalls(kind, config, params): BatchCall[]`: a `switch` on the kind. A new kind adds an entry to
  `RelayKindInputs` and a case.

### ERC-20 (`erc20.ts`)

- `ERC20_ABI`: `approve`, `transfer`, `balanceOf`, `decimals`.

### Miden account (`miden-account.ts`)

- `MIDEN_ACCOUNT_HEX_PATTERN`: `0x` and 30 hex characters (a 15-byte account ID).
- `isMidenAccountHex(value): boolean`.
- `midenAccountHexToEvmAddress(hex): Address`: 4 zero bytes, the 15-byte ID, 1 zero byte, lower case. Throws on a
  value that is not valid.

## Tests

`testing.ts` holds test vectors only (the Sepolia values of the onramp prototype); production code does not import
it. `calibur.test.ts` proves that this module gives the golden digests of the prototype (branch
`utkarsh/feat/onramp-offramp-integration`). `agglayer-deposit.test.ts` pins the golden digests of the new shapes.
