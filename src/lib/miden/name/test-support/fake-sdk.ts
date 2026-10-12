/**
 * Small fake of the `@miden-sdk/miden-sdk/lazy` classes that the Miden Name
 * modules use. Tests install it with:
 *
 *   jest.mock('@miden-sdk/miden-sdk/lazy', () => jest.requireActual('lib/miden/name/test-support/fake-sdk'));
 *
 * Words are plain bigint tuples. `Poseidon2.hashElements` is a deterministic
 * mix of the input, so different preimages give different keys.
 */

export class Felt {
  readonly value: bigint;

  constructor(value: bigint) {
    this.value = value;
  }

  asInt(): bigint {
    return this.value;
  }
}

export class FeltArray {
  readonly elements: Felt[];

  constructor(elements?: Felt[] | null) {
    this.elements = elements ?? [];
  }
}

export class Word {
  readonly felts: bigint[];

  constructor(u64s: BigUint64Array) {
    this.felts = Array.from(u64s);
  }

  static fromHex(hex: string): Word {
    const felts = ROOT_WORDS.get(hex.toLowerCase()) ?? [0n, 0n, 0n, 0n];
    return new Word(BigUint64Array.from(felts));
  }

  static newFromFelts(felts: Felt[]): Word {
    return new Word(BigUint64Array.from(felts.map(felt => felt.value)));
  }

  toU64s(): BigUint64Array {
    return BigUint64Array.from(this.felts);
  }

  toHex(): string {
    return `0x${this.felts.map(felt => felt.toString(16).padStart(16, '0')).join('')}`;
  }
}

/** Words that `Word.fromHex` knows. Tests add the script root here. */
export const ROOT_WORDS = new Map<string, bigint[]>();

export const MASK_64 = (1n << 64n) - 1n;

export const Poseidon2 = {
  hashElements: jest.fn((array: FeltArray): Word => {
    let a = 0n;
    let b = 0n;
    array.elements.forEach((felt, index) => {
      a = (a * 31n + felt.value + BigInt(index)) & MASK_64;
      b = (b * 131n + felt.value * 7n + 1n) & MASK_64;
    });
    return new Word(BigUint64Array.from([a, b, a ^ b, 42n]));
  })
};

export class AccountId {
  readonly hex: string;
  readonly prefixValue: bigint;
  readonly suffixValue: bigint;

  constructor(hex: string, prefix: bigint, suffix: bigint) {
    this.hex = hex;
    this.prefixValue = prefix;
    this.suffixValue = suffix;
  }

  static fromHex(hex: string): AccountId {
    const known = KNOWN_ACCOUNTS.get(hex.toLowerCase());
    if (!known) throw new Error(`unknown account hex ${hex}`);
    return new AccountId(hex.toLowerCase(), known.prefix, known.suffix);
  }

  static fromPrefixSuffix(prefix: Felt, suffix: Felt): AccountId {
    if (prefix.value === 0n) throw new Error('invalid account id');
    return new AccountId(`0xacc${prefix.value.toString(16)}`, prefix.value, suffix.value);
  }

  prefix(): Felt {
    return new Felt(this.prefixValue);
  }

  suffix(): Felt {
    return new Felt(this.suffixValue);
  }

  toString(): string {
    return this.hex;
  }

  isPublic(): boolean {
    return !NON_PUBLIC_ACCOUNTS.has(this.hex);
  }
}

/** Accounts (lowercase hex) for which `isPublic()` is false. */
export const NON_PUBLIC_ACCOUNTS = new Set<string>();

/** Accounts that `AccountId.fromHex` knows, by lowercase hex. */
export const KNOWN_ACCOUNTS = new Map<string, { prefix: bigint; suffix: bigint }>();

export class SlotAndKeys {
  readonly slot: string;
  readonly keys: Word[];

  constructor(slot: string, keys: Word[]) {
    this.slot = slot;
    this.keys = keys;
  }
}

export class AccountStorageRequirements {
  readonly slots: SlotAndKeys[];

  constructor(slots: SlotAndKeys[] = []) {
    this.slots = slots;
  }

  static fromSlotAndKeysArray(slots: SlotAndKeys[]): AccountStorageRequirements {
    return new AccountStorageRequirements(slots);
  }
}

export class NoteId {
  readonly hex: string;

  constructor(hex: string) {
    this.hex = hex;
  }

  static fromHex(hex: string): NoteId {
    return new NoteId(hex);
  }

  toString(): string {
    return this.hex;
  }
}

export class NoteTag {
  readonly account: AccountId;

  constructor(account: AccountId) {
    this.account = account;
  }

  static withAccountTarget(account: AccountId): NoteTag {
    return new NoteTag(account);
  }
}

export const NoteScript = {
  deserialize: jest.fn<unknown, [Uint8Array]>()
};

export const RpcClient = jest.fn();

export class Endpoint {
  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }
}

export const MidenClient = { ready: jest.fn(async () => undefined) };

export const NetworkId = {
  testnet: jest.fn(() => 'testnet'),
  devnet: jest.fn(() => 'devnet'),
  mainnet: jest.fn(() => 'mainnet'),
  custom: jest.fn((prefix: string) => prefix)
};

export const Address = {
  fromAccountId: jest.fn(),
  fromBech32: jest.fn()
};

// ---- Note building (register note) ----

/** Order of the note-building calls. Tests read and clear it. */
export const NOTE_BUILD_LOG: string[] = [];

export const NoteType = { Public: 1, Private: 2 };

export class NoteStorage {
  readonly felts: FeltArray;

  constructor(felts: FeltArray) {
    this.felts = felts;
  }
}

export class NoteRecipient {
  readonly serialNum: Word;
  readonly script: object;
  readonly storage: NoteStorage;

  constructor(serialNum: Word, script: object, storage: NoteStorage) {
    this.serialNum = serialNum;
    this.script = script;
    this.storage = storage;
  }
}

export class NoteAssets {
  readonly assets: object[];

  constructor(assets: object[] = []) {
    this.assets = assets;
  }
}

export class NoteMetadata {
  readonly sender: AccountId;
  readonly noteType: number;
  readonly tag: NoteTag;

  constructor(sender: AccountId, noteType: number, tag: NoteTag) {
    this.sender = sender;
    this.noteType = noteType;
    this.tag = tag;
  }
}

export class NoteAttachment {
  readonly target: AccountId;

  constructor(target: AccountId) {
    this.target = target;
  }
}

export class NetworkAccountTarget {
  readonly account: AccountId;

  constructor(account: AccountId) {
    this.account = account;
  }

  toAttachment(): NoteAttachment {
    return new NoteAttachment(this.account);
  }
}

export class Note {
  readonly assets: NoteAssets;
  readonly metadata: NoteMetadata;
  readonly recipient: NoteRecipient;
  readonly attachments: NoteAttachment[];

  constructor(assets: NoteAssets, metadata: NoteMetadata, recipient: NoteRecipient, attachments: NoteAttachment[]) {
    this.assets = assets;
    this.metadata = metadata;
    this.recipient = recipient;
    this.attachments = attachments;
  }

  static withAttachments(
    assets: NoteAssets,
    metadata: NoteMetadata,
    recipient: NoteRecipient,
    attachments: NoteAttachment[]
  ): Note {
    NOTE_BUILD_LOG.push('Note.withAttachments');
    return new Note(assets, metadata, recipient, attachments);
  }

  id(): NoteId {
    NOTE_BUILD_LOG.push('note.id');
    return new NoteId('0xregister-note');
  }
}

export class NoteArray {
  readonly notes: Note[];

  constructor(notes: Note[] = []) {
    NOTE_BUILD_LOG.push('NoteArray');
    this.notes = notes;
  }
}

// ---- Account vault (name NFAs) ----

/** A non-fungible asset with a faucet and a vault key. `freed` counts the `free()` calls. */
export class NonFungibleAsset {
  readonly faucet: AccountId;
  readonly key: bigint[];
  freed = 0;

  constructor(faucet: AccountId, key: bigint[]) {
    this.faucet = faucet;
    this.key = key;
  }

  faucetId(): AccountId {
    return this.faucet;
  }

  vaultKey(): Word {
    return new Word(BigUint64Array.from(this.key));
  }

  free(): void {
    this.freed += 1;
  }
}

export class AssetVault {
  readonly nfas: NonFungibleAsset[];

  constructor(nfas: NonFungibleAsset[] = []) {
    this.nfas = nfas;
  }

  nonFungibleAssets(): NonFungibleAsset[] {
    return [...this.nfas];
  }
}

export class Account {
  readonly assetVault: AssetVault;

  constructor(assetVault: AssetVault) {
    this.assetVault = assetVault;
  }

  vault(): AssetVault {
    return this.assetVault;
  }
}

export class TransactionRequestBuilder {
  /** The last builder that `build()` finished. */
  static lastBuilt: TransactionRequestBuilder | undefined;

  ownOutputNotes: NoteArray | undefined;
  feeSalt: Word | undefined;

  withOwnOutputNotes(notes: NoteArray): TransactionRequestBuilder {
    this.ownOutputNotes = notes;
    return this;
  }

  withFeeConversionSalt(salt: Word): TransactionRequestBuilder {
    this.feeSalt = salt;
    return this;
  }

  build(): { serialize: () => Uint8Array } {
    TransactionRequestBuilder.lastBuilt = this;
    return { serialize: () => new Uint8Array([1, 2, 3]) };
  }
}
