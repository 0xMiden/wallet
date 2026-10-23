import {
  AccountId,
  AccountStorageRequirements,
  Felt,
  FeltArray,
  ForeignAccount,
  ForeignAccountArray,
  FungibleAsset,
  NetworkAccountTarget,
  Note,
  NoteArray,
  NoteAssets,
  NoteMetadata,
  NoteRecipient,
  NoteScript,
  NoteStorage,
  NoteTag,
  NoteType,
  Poseidon2,
  TransactionRequestBuilder,
  Word
} from '@miden-sdk/miden-sdk/lazy';

import type { CanonicalGcDistribution } from './gc-claim-operation';

const FIELD_MODULUS = 0xffffffff00000001n;
const MAX_ASSET_AMOUNT = (1n << 63n) - (1n << 31n);

export interface FundedGcClaimInput {
  distribution?: CanonicalGcDistribution;
  issuerId: string;
  nativeAssetId: string;
  issuerCodeCommitment: string;
  genesisCommitment: string;
  accountId: string;
  approvedWeek: number;
  approvalExpiresAt: number;
  reclaimHeight: number;
  receiptTag: number;
  nativeBudget: bigint;
  serial: readonly bigint[];
  claimScriptBytes: Uint8Array;
  claimScriptRoot: string;
}

export interface FundedGcClaimRequest {
  requestNoteId: string;
  requestNullifier: string;
  receiptRecipientCommitment: string;
  requestBytes: Uint8Array;
  noteBytes: Uint8Array;
}

/** Construct only; signing, fee approval and dispatch belong to the existing wallet pipeline. */
export function buildFundedGcClaimRequest(input: FundedGcClaimInput): FundedGcClaimRequest {
  for (const value of [input.approvedWeek, input.approvalExpiresAt, input.reclaimHeight, input.receiptTag]) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error('Invalid GC claim u32');
  }
  for (const serial of [input.serial]) {
    if (
      serial.length !== 4 ||
      serial.some(value => typeof value !== 'bigint' || value < 0n || value >= FIELD_MODULUS)
    ) {
      throw new Error('Invalid GC claim serial');
    }
  }
  if (
    input.reclaimHeight === 0 ||
    typeof input.nativeBudget !== 'bigint' ||
    input.nativeBudget <= 0n ||
    input.nativeBudget > MAX_ASSET_AMOUNT
  ) {
    throw new Error('Invalid GC claim budget or reclaim height');
  }
  const distribution = input.distribution;
  if (
    distribution !== undefined &&
    (distribution.protocolVersion !== 2 ||
      !distribution.distributorId ||
      !distribution.gcFaucetId ||
      distribution.weeklyClaimsSlot !== 'bread::gc::distributor::weekly_claims' ||
      distribution.distributorId !== input.issuerId ||
      distribution.distributorCodeCommitment !== input.issuerCodeCommitment ||
      distribution.gcFaucetId === distribution.distributorId ||
      distribution.gcFaucetId === input.nativeAssetId)
  )
    throw new Error('Invalid canonical GC distribution');
  const version = distribution?.protocolVersion ?? 1;
  const script = NoteScript.deserialize(input.claimScriptBytes);
  if (script.root().toHex() !== input.claimScriptRoot) throw new Error('GC claim script differs from deployment');
  const account = AccountId.fromHex(input.accountId);
  const issuer = AccountId.fromHex(input.issuerId);
  if (!issuer.isPublic() || input.issuerId === input.nativeAssetId) throw new Error('Invalid GC issuer');
  const receiptFields = [
    account.suffix().asInt(),
    account.prefix().asInt(),
    BigInt(input.approvedWeek),
    BigInt(input.approvalExpiresAt)
  ];
  const storage = (values: bigint[]) => new NoteStorage(new FeltArray(values.map(value => new Felt(value))));
  const gc = new FungibleAsset(AccountId.fromHex(distribution?.gcFaucetId ?? input.issuerId), 10_000_000n);
  // ABI v1 remains recoverable; v2 binds its distinct distributor and canonical asset.
  const fields = [
    ...NoteScript.p2id().root().toU64s(),
    0n,
    0n,
    0n,
    0n,
    ...gc.vaultKey().toU64s(),
    ...gc.intoWord().toU64s(),
    BigInt(input.receiptTag),
    0n,
    0n,
    0n,
    ...receiptFields,
    ...Word.fromHex(input.issuerCodeCommitment).toU64s(),
    BigInt(input.reclaimHeight),
    BigInt(version),
    distribution === undefined ? 0n : issuer.suffix().asInt(),
    distribution === undefined ? 0n : issuer.prefix().asInt(),
    ...Word.fromHex(input.genesisCommitment).toU64s()
  ];
  const attachment = new NetworkAccountTarget(AccountId.fromHex(input.issuerId)).toAttachment();
  const hash = (values: Iterable<bigint>) =>
    Poseidon2.hashElements(new FeltArray(Array.from(values, value => new Felt(value))));
  // Protocol metadata v1: public flag at bit 6; sole NetworkAccountTarget scheme=2.
  // Derive the receipt salt from every approved semantic field and the complete outer note
  // identity. Recovery can then match a public receipt to exactly one request preimage.
  const receiptSerial = hash([
    version === 2 ? 0x47435232n : 0x47435231n,
    BigInt(version),
    0n,
    0n,
    ...script.root().toU64s(),
    ...input.serial,
    account.suffix().asInt() | 65n,
    account.prefix().asInt(),
    BigInt(NoteTag.withAccountTarget(AccountId.fromHex(input.issuerId)).asU32()),
    2n,
    ...hash(hash(attachment.toWords().flatMap(word => [...word.toU64s()])).toU64s()).toU64s(),
    ...hash([
      ...new FungibleAsset(AccountId.fromHex(input.nativeAssetId), input.nativeBudget).vaultKey().toU64s(),
      ...new FungibleAsset(AccountId.fromHex(input.nativeAssetId), input.nativeBudget).intoWord().toU64s()
    ]).toU64s(),
    ...fields.slice(0, 4),
    ...fields.slice(8)
  ]);
  fields.splice(4, 4, ...receiptSerial.toU64s());
  const receiptRecipientCommitment = new NoteRecipient(receiptSerial, NoteScript.p2id(), storage(receiptFields))
    .digest()
    .toHex();
  const note = Note.withAttachments(
    new NoteAssets([new FungibleAsset(AccountId.fromHex(input.nativeAssetId), input.nativeBudget)]),
    new NoteMetadata(
      AccountId.fromHex(input.accountId),
      NoteType.Public,
      NoteTag.withAccountTarget(AccountId.fromHex(input.issuerId))
    ),
    new NoteRecipient(new Word(new BigUint64Array(input.serial)), script, storage(fields)),
    [attachment]
  );
  const requestNoteId = note.id().toString();
  const requestNullifier = note.nullifier().toHex();
  const noteBytes = note.serialize();
  const request = new TransactionRequestBuilder()
    .withOwnOutputNotes(new NoteArray([note]))
    .withForeignAccounts(
      new ForeignAccountArray([
        ForeignAccount.public(AccountId.fromHex(input.issuerId), new AccountStorageRequirements())
      ])
    )
    .build();
  return { requestNoteId, requestNullifier, receiptRecipientCommitment, requestBytes: request.serialize(), noteBytes };
}
