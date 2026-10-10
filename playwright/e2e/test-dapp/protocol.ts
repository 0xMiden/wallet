/**
 * The command surface of `window.testDapp`, imported type-only by the page and by the Playwright driver. Results are
 * JSON: amounts and bigints are decimal strings, bytes are base64, ids are hex. Wallet and adapter errors come back
 * as `Outcome` data; a bad input or a failed self-check throws, because that is a dApp bug, not a wallet verdict, and a
 * call the node failed throws `ChainUnavailableError`, which the driver reports as infrastructure.
 */
import type { DappError } from '../helpers/dapp-cells';

export type { DappError };
export type NoteTypeName = 'public' | 'private';
export type Outcome<T> = { ok: true; value: T } | { ok: false; error: DappError };
type Empty = Record<string, never>;

export interface ConnectedView {
  /** The wallet's stored account key, which can be the composite `<address>_<suffix>` form (dapp.ts:443-453). */
  address: string;
  /** `address` without the suffix, as `canonicalWalletAccountId` reads it; every compared address uses this form. */
  addressCanonical: string;
  accountIdHex: string;
  /** The 32-byte signing commitment connect hands out, the account's first public key commitment (dapp.ts:179-195). */
  publicKeyHex: string;
  privateDataPermission: string;
  allowedPrivateData: number | null;
  /** The builder `requestGuardianInfo` picked after the connect: a real dApp knows nothing more about the account. */
  builder: 'plain' | 'guardian-twin';
}
export interface SessionEvent {
  at: number;
  source: 'adapter' | 'provider';
  event: string;
  address: string | null;
}
/** The adapter's and the provider's view side by side: the adapter never follows `accountChange`, so they can differ. */
export interface SessionView {
  adapterAddress: string | null;
  adapterConnected: boolean;
  providerAddress: string | null;
  connected: ConnectedView | null;
  events: SessionEvent[];
}
export interface GuardianInfoView {
  isGuardianAccount: boolean;
  guardianEndpoint: string | null;
  guardianProvider: string | null;
  guardianSyncStatus: string | null;
}
export interface AssetView {
  faucetId: string;
  amount: string;
}
export interface NoteView {
  noteId: string;
  nullifier: string;
  noteType: string;
  state: string;
  assets: AssetView[];
}
export interface OutputSpec {
  recipientAddress: string;
  faucetId: string;
  amount: string;
  noteType: NoteTypeName;
  /** More assets in the same note (X5f's carried note holds the native asset and TST). */
  extraAssets?: AssetView[];
}
export interface BuildCustomInput {
  /** `consume-and-pay` builds P2ID outputs; what makes it one is `inputNoteBytesB64`. */
  shape: 'p2id' | 'p2ide' | 'consume-and-pay';
  outputs: OutputSpec[];
  attachment?: { felts: string[]; scheme?: number };
  reclaimAfterBlocks?: number;
  /** Consumed by the request as unauthenticated inputs (`withInputNotes`). */
  inputNoteBytesB64?: string[];
  /** Carried in `importNotes` only, not consumed (R1, R5). */
  carryNoteBytesB64?: string[];
  /** `none` builds with a plain builder on every kind, so a Guardian request carries no multisig auth args (X7). */
  authArgs?: 'sdk' | 'none';
}
export interface BuildCustomOutput {
  /** The page keeps the built request; `submitCustom` sends it by this id. */
  requestId: string;
  requestB64: string;
  /** The dApp's own sync height when it built the request, not the wallet's. */
  boundBlockNum: number;
  outputNoteIds: string[];
  outputNoteBytesB64: string[];
  inputNoteIds: string[];
  attachmentWordsHex: string[];
  /** The self-checks the page ran before handing the request over; any false one throws instead. */
  checks: Record<string, boolean>;
}
export interface OutputNoteView {
  noteId: string;
  noteType: NoteTypeName;
  bytesB64: string;
  /** The adapter's note is an instance of the page's own `Note`, which holds only when page and adapter share one SDK. */
  isSameSdkNote: boolean;
}
export interface SignatureView {
  signatureB64: string;
  schemeTag: number;
  /** The signed payload as the wallet received it (word bytes, or serialized SigningInputs). */
  payloadB64: string;
  /** The 32 word bytes the key signed: the word itself, or the SigningInputs commitment. */
  messageB64: string;
}
export interface SelfTestView {
  publicKeyB64: string;
  signatureB64: string;
  payloadB64: string;
  messageB64: string;
}
export type RawArg = string | number | boolean | null | { bytesB64: string } | RawArg[] | { [key: string]: RawArg };
export type RawCall =
  | 'requestSend'
  | 'requestTransaction'
  | 'requestConsume'
  | 'requestAssets'
  | 'requestGuardianInfo'
  | 'signBytes'
  | 'connect'
  | 'waitForTransaction';

export interface DappCommands {
  init: {
    /** `accountNotFound`: the commitment the node reports for a never-deployed account, pinned by the spike (dapp-pinned.json). */
    input: { rpcUrl: string; storeName: string; feeFaucetId?: string; accountNotFound?: string };
    output: { syncHeight: number; feeFaucetIdHex: string; sdkVersion: string; adapterVersion: string };
  };
  detect: { input: { timeoutMs: number }; output: { readyState: string; isAvailable: boolean } };
  connect: {
    input: { permission: 'UponRequest' | 'Auto'; network: string; allowedPrivateData?: number };
    output: Outcome<ConnectedView>;
  };
  disconnect: { input: Empty; output: { adapterAddress: string | null } };
  session: { input: Empty; output: SessionView };
  guardianInfo: { input: Empty; output: Outcome<GuardianInfoView> };
  assets: { input: Empty; output: Outcome<AssetView[]> };
  consumableNotes: { input: Empty; output: Outcome<NoteView[]> };
  privateNotes: {
    input: { filter: 'All' | 'List' | 'Committed' | 'Expected'; noteIds?: string[] };
    output: Outcome<NoteView[]>;
  };
  conformance: { input: Empty; output: { passed: string[]; failed: { name: string; error: string }[] } };
  syncHeight: { input: Empty; output: { height: number } };
  waitForHeight: { input: { target: number; timeoutMs: number }; output: { height: number; reachedAtMs: number } };
  send: {
    input: {
      recipientAddress: string;
      faucetId: string;
      amount: string;
      noteType: NoteTypeName;
      recallBlocks?: number;
      via: 'requestSend' | 'requestTransaction';
    };
    output: Outcome<{ txId: string }>;
  };
  consume: {
    input: {
      noteId: string;
      faucetId: string;
      amount: string;
      noteType: NoteTypeName;
      noteBytesB64?: string;
      via: 'requestConsume' | 'requestTransaction';
    };
    output: Outcome<{ txId: string }>;
  };
  makeNoteFile: {
    input: { noteBytesB64: string; format: 'withProof' | 'details' | 'bare' };
    /**
     * `detailsCommitmentHex` is what the dApp's own client returns for a details-only import of the same note: the
     * id the wallet reports for the `details` and `bare` formats (api-types.d.ts:1638-1641). Call it once per note
     * and store, since it imports into the dApp's client.
     */
    output: { bytesB64: string; noteId: string; detailsCommitmentHex: string; nullifierHex: string };
  };
  noteFacts: { input: { noteBytesB64: string }; output: { noteId: string; nullifierHex: string } };
  importNote: { input: { noteBytesB64: string }; output: Outcome<{ noteId: string }> };
  buildCustom: { input: BuildCustomInput; output: BuildCustomOutput };
  submitCustom: {
    /** `recipientAddress: ''` is no recipient: the wallet reads an empty string as none (dapp.ts:1951). */
    input: { requestId: string; recipientAddress: string; importNotes: boolean; inputNoteIds?: string[] };
    output: Outcome<{ txId: string }>;
  };
  waitForTransaction: { input: { txId: string }; output: Outcome<{ txHash: string; outputNotes: OutputNoteView[] }> };
  signWord: { input: { wordHex: string }; output: Outcome<SignatureView> };
  signSigningInputs: {
    /** `summary`: the twin's summary receives `amount` of `faucetId` (G2b's asset row). */
    input: {
      variant: 'arbitrary' | 'summary' | 'blind';
      felts?: string[];
      wordHex?: string;
      faucetId?: string;
      amount?: string;
    };
    output: Outcome<SignatureView>;
  };
  verifySignature: {
    input: { kind: 'word' | 'signingInputs'; payloadB64: string; signatureB64: string; publicKeyB64: string };
    output: { verifies: boolean; commitmentHex: string };
  };
  selfTestSignature: { input: { kind: 'word' | 'signingInputs' }; output: SelfTestView };
  /** Chain reads go through the page's own `RpcClient`, never through the wallet. */
  chainNote: {
    input: { noteId: string };
    output: {
      found: boolean;
      blockNum?: number;
      senderHex?: string;
      noteType?: NoteTypeName;
      attachmentWordsHex?: string[];
      noteBytesB64?: string;
      nullifierHex?: string;
    };
  };
  chainNullifier: { input: { nullifierHex: string }; output: { committedAt: number | null } };
  chainAccount: {
    input: { accountId: string };
    output: { found: boolean; commitmentHex?: string; lastBlockNum?: number };
  };
  /** Calls `window.midenWallet` directly, for refusals the adapter would stop client-side or cannot express. */
  raw: {
    input: { call: RawCall; args: RawArg[]; asAddress?: string; asPublicKeyHex?: string };
    output: Outcome<RawArg>;
  };
}

export type DappCommandName = keyof DappCommands;
export type DappInput<K extends DappCommandName> = DappCommands[K]['input'];
export type DappOutput<K extends DappCommandName> = DappCommands[K]['output'];
export type DappHandlers = { [K in DappCommandName]: (input: DappInput<K>) => Promise<DappOutput<K>> };

export interface TestDappWindowApi {
  readonly ready: true;
  call<K extends DappCommandName>(command: K, input: DappInput<K>): Promise<DappOutput<K>>;
}
