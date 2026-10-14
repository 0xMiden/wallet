import {
  AccountBuilder,
  AccountId,
  AccountStorageMode,
  AuthGuardedMultisigConfig,
  Felt,
  FungibleAsset,
  MidenClient,
  Note,
  NoteAndArgs,
  NoteAndArgsArray,
  NoteAssets,
  NoteAttachment,
  NoteType,
  Word,
  createAuthGuardedMultisig,
  type TransactionRequestBuilder,
  type TransactionSummary
} from '@miden-sdk/miden-sdk';

/**
 * `AuthEcdsaK256Keccak` of the WASM `AuthScheme` enum (miden_client_web.d.ts:1151-1154). The package root exports
 * the friendly `AuthScheme` constant and hides the enum (dist/st/index.d.ts:7-9), so the value is named here; a
 * rename of the enum or the config fails `yarn ts` on this line.
 */
export const GUARDED_MULTISIG_SCHEME_ECDSA: ConstructorParameters<typeof AuthGuardedMultisigConfig>[3] = 1;

const randomWord = (): Word => {
  const values = new BigUint64Array(4);
  crypto.getRandomValues(values);
  // 63-bit values stay below the Goldilocks modulus.
  return Word.newFromFelts(Array.from(values, value => new Felt(value & 0x7fff_ffff_ffff_ffffn)));
};

const twins = new WeakMap<MidenClient, string>();

/**
 * A never-deployed local account with the standard guarded-multisig component. A wallet Guardian account is
 * private, so a dApp cannot load it, and `feeAwareTransactionRequestBuilder` returns an untouched builder for an
 * account its store cannot classify. The auth args depend on the component kind, the bound block, the salt and the
 * fee faucet, none of which the twin's random keys change, so the twin's builder emits the real account's bytes.
 */
export async function ensureShapeTwin(client: MidenClient): Promise<string> {
  const known = twins.get(client);
  if (known !== undefined) return known;
  const config = new AuthGuardedMultisigConfig(
    [randomWord(), randomWord()],
    1,
    randomWord(),
    GUARDED_MULTISIG_SCHEME_ECDSA
  );
  const { account } = new AccountBuilder(crypto.getRandomValues(new Uint8Array(32)))
    .storageMode(AccountStorageMode.private())
    .withAuthComponent(createAuthGuardedMultisig(config))
    .withBasicWalletComponent()
    .build();
  const idHex = account.id().toString();
  await client.accounts.insert({ account });
  twins.set(client, idHex);
  return idHex;
}

/** The fee-aware builder for the twin: a fresh salt, the bound block (the store's sync height unless given). */
export async function guardianRequestBuilder(
  client: MidenClient,
  boundBlockNum?: number
): Promise<TransactionRequestBuilder> {
  const twin = AccountId.fromHex(await ensureShapeTwin(client));
  return client.feeAwareTransactionRequestBuilder(twin, boundBlockNum === undefined ? undefined : { boundBlockNum });
}

/** Native tokens the twin's incoming note carries, so its auth procedure can pay the fee from an empty vault. */
const TWIN_FEE_HEADROOM = 5_000_000n;

/**
 * A real TransactionSummary for G2b. A dApp cannot execute for the wallet's private account, so it previews a request
 * on an account it owns. The twin consumes an unauthenticated P2ID note carrying `amount` of `faucet` and the fee
 * headroom, so the summary moves an asset the popup renders as a row (spec G2b), and the auth procedure, which pays
 * the fee, finds native tokens in the vault. It stops at its unauthorized event and the preview returns the summary.
 * The spike (task 4, row 8) proves this executes; the note never goes on chain.
 */
export async function previewTwinSummary(
  client: MidenClient,
  input: { sender: AccountId; faucet: AccountId; amount: bigint }
): Promise<TransactionSummary> {
  const twinHex = await ensureShapeTwin(client);
  const builder = await client.feeAwareTransactionRequestBuilder(AccountId.fromHex(twinHex));
  const incoming = Note.createP2IDNote(
    input.sender,
    AccountId.fromHex(twinHex),
    new NoteAssets([
      new FungibleAsset(input.faucet, input.amount),
      new FungibleAsset(await client.feeFaucetId(), TWIN_FEE_HEADROOM)
    ]),
    NoteType.Public,
    new NoteAttachment()
  );
  const request = builder.withInputNotes(new NoteAndArgsArray([new NoteAndArgs(incoming)])).build();
  return client.transactions.preview({ operation: 'custom', account: AccountId.fromHex(twinHex), request });
}
