/**
 * The test dApp: a page on a loopback origin that loads the published wallet adapter and its own SDK client through
 * the import map `helpers/test-dapp-server.ts` writes, and answers `window.testDapp.call(command, input)` for the
 * Playwright driver (spec section 2). It reaches the wallet only through the adapter, as a real dApp does, and reads
 * the chain through its own `RpcClient`, so neither side of a check depends on the wallet's own account of it.
 */
import {
  AccountId,
  Address,
  AuthSecretKey,
  Endpoint,
  Felt,
  FungibleAsset,
  InputNote,
  MidenClient,
  Note,
  NoteAndArgs,
  NoteAndArgsArray,
  NoteArray,
  NoteAssets,
  NoteAttachment,
  NoteAttachmentScheme,
  NoteDetails,
  NoteFile,
  NoteId,
  NoteType,
  PublicKey,
  RpcClient,
  Signature,
  SigningInputs,
  TransactionRequestBuilder,
  Word,
  type TransactionRequest
} from '@miden-sdk/miden-sdk';
import {
  ConsumeTransaction,
  PrivateDataPermission,
  SendTransaction,
  Transaction,
  WalletAdapterNetwork,
  WalletReadyState,
  b64ToU8,
  u8ToB64
} from '@miden-sdk/miden-wallet-adapter-base';
import { MidenWalletAdapter, type MidenWallet } from '@miden-sdk/miden-wallet-adapter-miden';

import { guardianRequestBuilder, previewTwinSummary } from './guardian-request-builder.js';
import type {
  ConnectedView,
  DappCommandName,
  DappError,
  DappHandlers,
  DappInput,
  DappOutput,
  NoteTypeName,
  Outcome,
  SessionEvent,
  TestDappWindowApi
} from './protocol';

/** A dApp-side failure: thrown through to the driver as a harness fault, never folded into an Outcome. */
class HarnessCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessCheckError';
  }
}

/** A built custom request waits here until `submitCustom`, so a test can let the chain move in between. */
interface HeldRequest {
  request: TransactionRequest;
  /** The request's input notes and the notes it only carries, sent only when `submitCustom` asks for `importNotes`. */
  importNotes: string[];
}

const state = {
  /** The dApp's own client: its own IndexedDB store and its own sync height, moved only by a command. */
  client: undefined as MidenClient | undefined,
  rpcUrl: '',
  accountNotFound: `0x${'00'.repeat(32)}`,
  adapter: new MidenWalletAdapter({ appName: 'test-dapp' }),
  connected: undefined as ConnectedView | undefined,
  events: [] as SessionEvent[],
  requests: new Map<string, HeldRequest>(),
  nextRequest: 0,
  providerListening: false
};

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
// The wallet hands out its stored account key, which can carry a `_<suffix>` (dapp.ts:443-453); the SDK parses only the
// bech32 part, so this drops the suffix the way the wallet's own canonicalWalletAccountId does (helpers.ts:72-79).
const canonical = (address: string): string => address.split('_')[0] ?? address;
// Ids the page computes are hex; addresses the wallet and the driver pass are bech32, possibly suffixed.
const toAccountId = (id: string): AccountId =>
  id.startsWith('0x') ? AccountId.fromHex(id) : AccountId.fromBech32(canonical(id));
const noteTypeOf = (name: NoteTypeName): NoteType => (name === 'public' ? NoteType.Public : NoteType.Private);
const noteTypeName = (type: NoteType): NoteTypeName => (type === NoteType.Public ? 'public' : 'private');
// Only the live networks the suite runs on. A connect naming any other network goes through `raw` (R3), so a name
// missing here is a harness fault, not a refusal to record.
const NETWORKS: Record<string, WalletAdapterNetwork> = {
  testnet: WalletAdapterNetwork.Testnet,
  devnet: WalletAdapterNetwork.Devnet
};
const PERMISSIONS = { UponRequest: PrivateDataPermission.UponRequest, Auto: PrivateDataPermission.Auto };

// Every adapter and provider event is kept with its time, so a session check can bound how late an accountChange came;
// the log element is only for a person driving the page by hand.
function record(source: SessionEvent['source'], event: string, address: string | null): void {
  state.events.push({ at: Date.now(), source, event, address });
  const log = document.getElementById('log');
  if (log) log.textContent += `${source} ${event} ${address ?? ''}\n`;
}

const field = (value: unknown, key: string): string | undefined => {
  const found: unknown = typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
  return typeof found === 'string' ? found : undefined;
};

// Provider errors are MidenWalletError objects that implement Error without extending it, so read fields, not instanceof.
function describeError(error: unknown): DappError {
  const cause: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'error') : undefined;
  const causeName = field(cause, 'name');
  return {
    name: field(error, 'name') ?? 'NonError',
    message: field(error, 'message') ?? String(error),
    ...(causeName === undefined ? {} : { causeName, causeMessage: field(cause, 'message') ?? '' })
  };
}

// Wallet and adapter errors are the verdicts under test, so they come back as data with their exact class and text
// (spec section 2.4). A HarnessCheckError is the page's own fault and still throws.
async function outcome<T>(work: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    if (error instanceof HarnessCheckError) throw error;
    return { ok: false, error: describeError(error) };
  }
}

// Each command is a separate call from the driver, so each checks its own preconditions; a missing one is the
// driver's mistake and throws as a harness fault.
function client(): MidenClient {
  if (state.client === undefined) throw new HarnessCheckError('init has not run');
  return state.client;
}
function requireConnected(): ConnectedView {
  if (state.connected === undefined) throw new HarnessCheckError('the dApp is not connected');
  return state.connected;
}
// The adapter's MidenWallet typing has no `isAvailable` or `permission`, so those two are read with Reflect.
function provider(): MidenWallet {
  const injected: MidenWallet | undefined = Reflect.get(window, 'midenWallet');
  if (injected === undefined) throw new HarnessCheckError('window.midenWallet is not injected');
  return injected;
}
// Chain reads bypass the dApp's client store as well as the wallet: the chain's view of a write is checked on its own.
const rpc = (): RpcClient => new RpcClient(new Endpoint(state.rpcUrl));

// The adapter never subscribes to the provider's accountChange (K1), so the page listens on the provider itself to
// record what the wallet actually emitted next to what the adapter reports.
function installProviderListener(): void {
  if (state.providerListening) return;
  provider().on('accountChange', (permission: unknown) =>
    record('provider', 'accountChange', field(permission, 'address') ?? null)
  );
  state.providerListening = true;
}

// Wired at module load, so an event the adapter emits before `init` (its detection's readyStateChange) is still kept.
state.adapter.on('connect', address => record('adapter', 'connect', address));
state.adapter.on('disconnect', () => record('adapter', 'disconnect', null));
state.adapter.on('error', error => record('adapter', `error:${describeError(error).name}`, null));
state.adapter.on('readyStateChange', readyState => record('adapter', `readyState:${readyState}`, null));

// The adapter detects the injected provider by polling and only then reports Installed; connecting before that
// throws WalletNotReadyError (adapter.js:301-302), which would be a detection race, not a wallet verdict.
async function waitInstalled(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (state.adapter.readyState !== WalletReadyState.Installed) {
    if (Date.now() > deadline)
      throw new HarnessCheckError(`wallet not detected, readyState=${state.adapter.readyState}`);
    await sleep(100);
  }
}

// The version the import map actually loaded, read from the served package.json rather than assumed.
async function servedVersion(pkg: string): Promise<string> {
  const manifest: unknown = await (await fetch(`/npm/${pkg}/package.json`)).json();
  const version = field(manifest, 'version');
  if (version === undefined) throw new HarnessCheckError(`${pkg}/package.json has no version`);
  return version;
}

// A real dApp knows only what requestGuardianInfo tells it, so that picks the builder after every connect.
async function selectBuilder(): Promise<ConnectedView['builder']> {
  const info = await state.adapter.requestGuardianInfo();
  const builder = info.isGuardianAccount ? 'guardian-twin' : 'plain';
  if (state.connected !== undefined) state.connected = { ...state.connected, builder };
  return builder;
}

// The adapter keeps the address and the 32-byte key, but its privateDataPermission echoes what the dApp asked for
// (adapter.js:318). What the wallet granted, which a reconnect must not widen (S14), is read from the provider.
async function afterConnect(): Promise<ConnectedView> {
  const address = state.adapter.address;
  const publicKey = state.adapter.publicKey;
  if (!address || !publicKey) throw new HarnessCheckError('the adapter connected without an address or a key');
  const addressCanonical = canonical(address);
  const permission: unknown = Reflect.get(provider(), 'permission');
  const allowed: unknown =
    typeof permission === 'object' && permission !== null ? Reflect.get(permission, 'allowedPrivateData') : undefined;
  state.connected = {
    address,
    addressCanonical,
    accountIdHex: Address.fromBech32(addressCanonical).accountId().toString(),
    publicKeyHex: Word.deserialize(publicKey).toHex(),
    privateDataPermission: field(permission, 'privateDataPermission') ?? 'unknown',
    allowedPrivateData: typeof allowed === 'number' ? allowed : null,
    builder: 'plain'
  };
  await selectBuilder();
  return requireConnected();
}

// No scheme is the none scheme over the felts; a scheme wraps the same words, so X2 and X3 differ only in the scheme.
function attachmentOf(spec: { felts: string[]; scheme?: number }): NoteAttachment {
  const plain = new NoteAttachment(BigUint64Array.from(spec.felts, felt => BigInt(felt)));
  return spec.scheme === undefined
    ? plain
    : NoteAttachment.fromWords(new NoteAttachmentScheme(spec.scheme), plain.toWords());
}

const handlers: Partial<DappHandlers> = {
  // `autoSync: false` keeps the dApp's height its own, so a request binds the block the dApp saw, not the wallet's
  // (spec section 2.2). The fee faucet is passed because MidenClient.create says a non-mock client must name it. A
  // second init on the same page keeps the first client and its store.
  init: async input => {
    installProviderListener();
    state.client ??= await MidenClient.create({
      rpcUrl: input.rpcUrl,
      autoSync: false,
      useWorker: false,
      storeName: input.storeName,
      ...(input.feeFaucetId === undefined ? {} : { feeFaucetId: input.feeFaucetId })
    });
    state.rpcUrl = input.rpcUrl;
    state.accountNotFound = input.accountNotFound ?? state.accountNotFound;
    await state.client.syncChain();
    const [sdkVersion, adapterVersion] = await Promise.all([
      servedVersion('@miden-sdk/miden-sdk'),
      servedVersion('@miden-sdk/miden-wallet-adapter-miden')
    ]);
    return {
      syncHeight: await state.client.getSyncHeight(),
      feeFaucetIdHex: (await state.client.feeFaucetId()).toString(),
      sdkVersion,
      adapterVersion
    };
  },

  // Answers whatever state detection reached: S1 asserts the values, so a timeout here is not an error.
  detect: async ({ timeoutMs }) => {
    await waitInstalled(timeoutMs).catch(() => undefined);
    const isAvailable: unknown = Reflect.get(provider(), 'isAvailable');
    return {
      readyState: String(state.adapter.readyState),
      isAvailable: typeof isAvailable === 'function' ? Boolean(await Reflect.apply(isAvailable, provider(), [])) : false
    };
  },

  connect: input =>
    outcome(async () => {
      await waitInstalled(30_000);
      const network = NETWORKS[input.network];
      if (network === undefined)
        throw new HarnessCheckError(`unknown network ${input.network}; use raw connect for R3`);
      await state.adapter.connect(PERMISSIONS[input.permission], network, input.allowedPrivateData);
      return afterConnect();
    }),

  // Forgetting the connected view makes every later write command fail as a harness fault until a new connect.
  disconnect: async () => {
    await state.adapter.disconnect();
    state.connected = undefined;
    return { adapterAddress: state.adapter.address ?? null };
  },

  // The provider's address comes straight from window.midenWallet: K1's signature compares it with the adapter's.
  session: async () => ({
    adapterAddress: state.adapter.address ?? null,
    adapterConnected: state.adapter.connected,
    providerAddress: provider().address ?? null,
    connected: state.connected ?? null,
    events: [...state.events]
  }),

  // Re-selects the builder as well, as a dApp would after reconnecting to an account of the other kind (M8).
  guardianInfo: () =>
    outcome(async () => {
      const info = await state.adapter.requestGuardianInfo();
      if (state.connected !== undefined) {
        state.connected = { ...state.connected, builder: info.isGuardianAccount ? 'guardian-twin' : 'plain' };
      }
      return { ...info };
    }),

  syncHeight: async () => {
    await client().syncChain();
    return { height: await client().getSyncHeight() };
  },

  // `reachedAtMs` is when the dApp first saw the target: the wallet's sync stamps must be later than this before the
  // request goes out (spec section 6, the "wallet synced past N" gate).
  waitForHeight: async ({ target, timeoutMs }) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await client().syncChain();
      const height = await client().getSyncHeight();
      if (height >= target) return { height, reachedAtMs: Date.now() };
      if (Date.now() > deadline) throw new HarnessCheckError(`chain stuck at ${height}, wanted ${target}`);
      // One sync a second: testnet blocks come about every 3 s (the spike's measured cadence), so a finer poll only
      // adds load on the public RPC.
      await sleep(1_000);
    }
  },

  // The adapter's transaction classes type the amount as a number, so the decimal string is converted at the boundary.
  // `via: 'requestTransaction'` still reaches the wallet's requestSend: the adapter routes a send or consume Transaction
  // to the dedicated endpoint client-side (adapter.js:118-124), so only `raw` exercises the wallet's own routing (W3).
  send: input =>
    outcome(async () => {
      const sender = requireConnected().addressCanonical;
      const amount = Number(input.amount);
      const txId =
        input.via === 'requestSend'
          ? await state.adapter.requestSend(
              new SendTransaction(
                sender,
                input.recipientAddress,
                input.faucetId,
                input.noteType,
                amount,
                input.recallBlocks
              )
            )
          : await state.adapter.requestTransaction(
              Transaction.createSendTransaction(
                sender,
                input.recipientAddress,
                input.faucetId,
                input.noteType,
                amount,
                input.recallBlocks
              )
            );
      return { txId };
    }),

  // The declared faucet and amount go to the wallet as given and may differ from the note's on purpose (W4, W5): the
  // wallet resolves the note itself and shows what it really holds (dapp.ts:2655-2668).
  consume: input =>
    outcome(async () => {
      const bytes = input.noteBytesB64 === undefined ? undefined : b64ToU8(input.noteBytesB64);
      const amount = Number(input.amount);
      const txId =
        input.via === 'requestConsume'
          ? await state.adapter.requestConsume(
              new ConsumeTransaction(input.faucetId, input.noteId, input.noteType, amount, bytes)
            )
          : await state.adapter.requestTransaction(
              Transaction.createConsumeTransaction(input.faucetId, input.noteId, input.noteType, amount, bytes)
            );
      return { txId };
    }),

  // The id and nullifier of a note, without importing it into the dApp's client as makeNoteFile does.
  noteFacts: async ({ noteBytesB64 }) => {
    const note = Note.deserialize(b64ToU8(noteBytesB64));
    return { noteId: note.id().toString(), nullifierHex: note.nullifier().toHex() };
  },

  makeNoteFile: async ({ noteBytesB64, format }) => {
    const note = Note.deserialize(b64ToU8(noteBytesB64));
    const noteId = note.id().toString();
    const nullifierHex = note.nullifier().toHex();
    const [fetched] = await rpc().getNotesById([NoteId.fromHex(noteId)]);
    if (fetched === undefined) throw new HarnessCheckError(`note ${noteId} is not on chain yet`);
    const afterBlock = Math.max(0, fetched.inclusionProof.location().blockNum() - 1);
    // The note's real tag and a block before its inclusion: what lets an expected note commit. fromNoteDetails would
    // use tag 0 and block 0, which never commits (miden-client-interface.ts:330-346). Details are rebuilt per use, and
    // the proof file gets its own copy of the note, because the browser build consumes a handle passed by value.
    const expected = (): NoteFile =>
      NoteFile.fromExpectedNote(new NoteDetails(note.assets(), note.recipient()), note.metadata().tag(), afterBlock);
    const bytes =
      format === 'bare'
        ? note.serialize()
        : format === 'details'
          ? expected().serialize()
          : NoteFile.fromInputNote(
              InputNote.authenticated(Note.deserialize(b64ToU8(noteBytesB64)), fetched.inclusionProof)
            ).serialize();
    // There is no public accessor for a note's details commitment; the dApp's own client returns it for a
    // details-only import (api-types.d.ts:1638-1641), the id the wallet reports for `details` and `bare`.
    const detailsCommitmentHex = await client().notes.import(expected());
    return { bytesB64: u8ToB64(bytes), noteId, detailsCommitmentHex, nullifierHex };
  },

  // Returns the id the wallet reports: the note id for a file with an inclusion proof, the details commitment for a
  // details-only file or a bare note (dapp.ts:1485-1490). The spike found the wallet then refuses a consume by that
  // commitment before any popup, while the same note consumes by its own id: a cell that consumes by the returned id
  // (W5b, W5c) meets that refusal.
  importNote: ({ noteBytesB64 }) =>
    outcome(async () => ({ noteId: await state.adapter.importPrivateNote(b64ToU8(noteBytesB64)) })),

  // Syncs first, so the bound block N is the dApp's own height at build time. A Guardian request takes its auth args
  // from the shape twin (spec section 4); `authArgs: 'none'` and single-sig accounts use a plain builder.
  buildCustom: async input => {
    const me = requireConnected();
    await client().syncChain();
    const height = await client().getSyncHeight();
    // The browser build consumes a WASM handle passed by value, so ids and bytes are read before handover.
    const outputs = input.outputs.map(output => {
      const assets = new NoteAssets(
        [{ faucetId: output.faucetId, amount: output.amount }, ...(output.extraAssets ?? [])].map(
          asset => new FungibleAsset(toAccountId(asset.faucetId), BigInt(asset.amount))
        )
      );
      const attachment = input.attachment === undefined ? new NoteAttachment() : attachmentOf(input.attachment);
      // The sender is the connected account, never the twin: a request carries no executing account id, so the wallet
      // runs it for its own account and the notes must already name that account (spec section 4, step 4).
      return input.shape === 'p2ide'
        ? Note.createP2IDENote(
            AccountId.fromHex(me.accountIdHex),
            toAccountId(output.recipientAddress),
            assets,
            height + (input.reclaimAfterBlocks ?? 1_000),
            null,
            noteTypeOf(output.noteType),
            attachment
          )
        : Note.createP2IDNote(
            AccountId.fromHex(me.accountIdHex),
            toAccountId(output.recipientAddress),
            assets,
            noteTypeOf(output.noteType),
            attachment
          );
    });
    const outputNoteIds = outputs.map(note => note.id().toString());
    const outputNoteBytesB64 = outputs.map(note => u8ToB64(note.serialize()));
    // Attachment cells build a single output, so the first note's words are the ones compared with the chain's.
    const attachmentWordsHex = outputs[0]?.attachments().flatMap(a => a.toWords().map(word => word.toHex())) ?? [];
    // Unauthenticated inputs: notes the wallet may not hold, consumed in the same transaction (X5).
    const inputs = (input.inputNoteBytesB64 ?? []).map(bytes => Note.deserialize(b64ToU8(bytes)));
    const inputNoteIds = inputs.map(note => note.id().toString());

    const twin = input.authArgs !== 'none' && me.builder === 'guardian-twin';
    const builder = twin ? await guardianRequestBuilder(client(), height) : new TransactionRequestBuilder();
    const withOutputs = builder.withOwnOutputNotes(new NoteArray(outputs));
    const request = (
      inputs.length > 0
        ? withOutputs.withInputNotes(new NoteAndArgsArray(inputs.map(note => new NoteAndArgs(note))))
        : withOutputs
    ).build();

    // Checked through SDK accessors only, never a layout constant: the built request holds exactly the notes whose ids
    // the driver will look for on chain, all sent by the connected account; a twin request committed its auth arg (the
    // twin was classified as a multisig) and declares N; an `authArgs: 'none'` request really carries no auth arg.
    const own = request.expectedOutputOwnNotes();
    const checks: Record<string, boolean> = {
      outputIdsMatch:
        own
          .map(note => note.id().toString())
          .sort()
          .join() === [...outputNoteIds].sort().join(),
      senderIsConnected: own.every(note => note.metadata().sender().toString() === me.accountIdHex),
      ...(twin
        ? {
            authArgCommitted: request.authArg() !== undefined,
            declaresBoundBlock: request.blockNumbers().includes(height)
          }
        : {}),
      ...(input.authArgs === 'none' ? { noAuthArg: request.authArg() === undefined } : {})
    };
    const failed = Object.entries(checks)
      .filter(([, ok]) => !ok)
      .map(([name]) => name);
    if (failed.length > 0) throw new HarnessCheckError(`request self-check failed: ${failed.join(', ')}`);

    // The request object itself is held, not its bytes, so the request the wallet receives is the one checked above.
    const requestId = `r${(state.nextRequest += 1)}`;
    state.requests.set(requestId, {
      request,
      importNotes: [...(input.inputNoteBytesB64 ?? []), ...(input.carryNoteBytesB64 ?? [])]
    });
    return {
      requestId,
      requestB64: u8ToB64(request.serialize()),
      boundBlockNum: height,
      outputNoteIds,
      outputNoteBytesB64,
      inputNoteIds,
      attachmentWordsHex,
      checks
    };
  },

  // The sender is always the connected account: a custom request from any other address is refused before any popup
  // (R3), which a test drives through `raw` instead.
  submitCustom: input =>
    outcome(async () => {
      const held = state.requests.get(input.requestId);
      if (held === undefined) throw new HarnessCheckError(`no built request ${input.requestId}`);
      const tx = Transaction.createCustomTransaction(
        requireConnected().addressCanonical,
        input.recipientAddress,
        held.request,
        input.inputNoteIds ?? [],
        input.importNotes ? held.importNotes.map(bytes => b64ToU8(bytes)) : []
      );
      return { txId: await state.adapter.requestTransaction(tx) };
    }),

  waitForTransaction: ({ txId }) =>
    outcome(async () => {
      const result = await state.adapter.waitForTransaction(txId);
      return {
        txHash: result.txHash,
        outputNotes: result.outputNotes.map(note => ({
          noteId: note.id().toString(),
          noteType: noteTypeName(note.metadata().noteType()),
          bytesB64: u8ToB64(note.serialize()),
          // The adapter deserializes with the bare specifier, so one import map means one SDK instance.
          isSameSdkNote: note instanceof Note
        }))
      };
    }),

  // The scheme tag is the serialized signature's first byte (ECDSA is 0x01); for a word the signed message is the word.
  signWord: ({ wordHex }) =>
    outcome(async () => {
      const payload = Word.fromHex(wordHex).serialize();
      const signature = await state.adapter.signBytes(payload, 'word');
      return {
        signatureB64: u8ToB64(signature),
        schemeTag: signature[0] ?? -1,
        payloadB64: u8ToB64(payload),
        messageB64: u8ToB64(payload)
      };
    }),

  signSigningInputs: input =>
    outcome(async () => {
      // A summary moving no asset would give G2b no row to find in the popup. The summary comes from a preview on the
      // shape twin, because a dApp cannot execute for the wallet's private account.
      if (input.variant === 'summary' && (input.faucetId === undefined || input.amount === undefined)) {
        throw new HarnessCheckError('a summary to sign needs the faucet and amount it moves');
      }
      const inputs =
        input.variant === 'arbitrary'
          ? SigningInputs.newArbitrary((input.felts ?? ['1', '2', '3']).map(felt => new Felt(BigInt(felt))))
          : input.variant === 'blind'
            ? SigningInputs.newBlind(Word.fromHex(input.wordHex ?? `0x${'11'.repeat(32)}`))
            : SigningInputs.newTransactionSummary(
                await previewTwinSummary(client(), {
                  sender: AccountId.fromHex(requireConnected().accountIdHex),
                  faucet: toAccountId(input.faucetId ?? ''),
                  amount: BigInt(input.amount ?? '0')
                })
              );
      // The key signs the SigningInputs commitment, so that is the message the driver recovers the key from.
      const payload = inputs.serialize();
      const message = inputs.toCommitment().serialize();
      const signature = await state.adapter.signBytes(payload, 'signingInputs');
      return {
        signatureB64: u8ToB64(signature),
        schemeTag: signature[0] ?? -1,
        payloadB64: u8ToB64(payload),
        messageB64: u8ToB64(message)
      };
    }),

  // The SDK cannot recover an ECDSA key (`recoverFrom` is Falcon-only), so the driver recovers it and hands it back;
  // the verification and the commitment compared with the connect key are the SDK's own (spec section 2.4).
  verifySignature: async input => {
    const publicKey = PublicKey.deserialize(b64ToU8(input.publicKeyB64));
    const signature = Signature.deserialize(b64ToU8(input.signatureB64));
    const verifies =
      input.kind === 'word'
        ? publicKey.verify(Word.deserialize(b64ToU8(input.payloadB64)), signature)
        : publicKey.verifyData(SigningInputs.deserialize(b64ToU8(input.payloadB64)), signature);
    return { verifies, commitmentHex: publicKey.toCommitment().toHex() };
  },

  // A key the page owns signs fixed inputs: the control that proves the driver's recovery before it judges a wallet
  // signature.
  selfTestSignature: async ({ kind }) => {
    const secret = AuthSecretKey.ecdsaWithRNG();
    const publicKeyB64 = u8ToB64(secret.publicKey().serialize());
    if (kind === 'word') {
      const payload = Word.newFromFelts([new Felt(11n), new Felt(22n), new Felt(33n), new Felt(44n)]).serialize();
      const signature = secret.sign(Word.deserialize(payload));
      return {
        publicKeyB64,
        signatureB64: u8ToB64(signature.serialize()),
        payloadB64: u8ToB64(payload),
        messageB64: u8ToB64(payload)
      };
    }
    const payload = SigningInputs.newArbitrary([new Felt(1n), new Felt(2n), new Felt(3n)]).serialize();
    const message = SigningInputs.deserialize(payload).toCommitment().serialize();
    const signature = secret.signData(SigningInputs.deserialize(payload));
    return {
      publicKeyB64,
      signatureB64: u8ToB64(signature.serialize()),
      payloadB64: u8ToB64(payload),
      messageB64: u8ToB64(message)
    };
  },

  // A private note's body is not on chain, so `note` is absent and only the metadata and the proof are read.
  chainNote: async ({ noteId }) => {
    const [fetched] = await rpc().getNotesById([NoteId.fromHex(noteId)]);
    if (fetched === undefined) return { found: false };
    const note = fetched.note;
    return {
      found: true,
      // The inclusion block: a dApp-built request's notes must land at N + k or later (spec section 5).
      blockNum: fetched.inclusionProof.location().blockNum(),
      senderHex: fetched.metadata.sender().toString(),
      noteType: noteTypeName(fetched.noteType),
      attachmentWordsHex: fetched.attachments.flatMap(a => a.toWords().map(word => word.toHex())),
      ...(note === undefined ? {} : { noteBytesB64: u8ToB64(note.serialize()), nullifierHex: note.nullifier().toHex() })
    };
  },

  // Searched from block 0, so a nullifier committed at any height is found.
  chainNullifier: async ({ nullifierHex }) => ({
    committedAt: (await rpc().getNullifierCommitHeight(Word.fromHex(nullifierHex), 0)) ?? null
  }),

  chainAccount: async ({ accountId }) => {
    // The node answers an account it has never seen with this commitment rather than an error (dapp-pinned.json
    // `accountNotFound`, handed over in `init`), so a thrown read stays a harness fault, never "not deployed".
    const fetched = await rpc().getAccountDetails(toAccountId(accountId));
    const commitmentHex = fetched.commitment().toHex();
    if (commitmentHex.toLowerCase() === state.accountNotFound.toLowerCase()) return { found: false };
    return { found: true, commitmentHex, lastBlockNum: fetched.lastBlockNum() };
  }
};

async function call<K extends DappCommandName>(command: K, input: DappInput<K>): Promise<DappOutput<K>> {
  const handler = handlers[command];
  if (handler === undefined) throw new HarnessCheckError(`command ${command} is not implemented`);
  return handler(input);
}

// Published only once every handler above exists, so a driver that waits for `ready` never calls a half-loaded page.
const api: TestDappWindowApi = { ready: true, call };
Reflect.set(window, 'testDapp', api);

// Inputs for the buttons in index.html, for a person driving the page by hand; tests never use them.
const MANUAL_INPUTS: Partial<{ [K in DappCommandName]: DappInput<K> }> = {
  init: { rpcUrl: 'https://rpc.testnet.miden.io', storeName: `test-dapp-manual-${window.location.host}` },
  connect: { permission: 'UponRequest', network: 'testnet' },
  guardianInfo: {},
  syncHeight: {},
  session: {},
  disconnect: {}
};
for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-command]')) {
  button.addEventListener('click', () => {
    const command = button.dataset.command;
    const input = command === undefined ? undefined : Reflect.get(MANUAL_INPUTS, command);
    if (command === undefined || input === undefined) return;
    // The command name comes from the DOM, so the typed `call` cannot check it statically; the input map does.
    Reflect.apply(call, undefined, [command, input])
      .then((result: unknown) => record('adapter', `manual:${command}`, JSON.stringify(result).slice(0, 300)))
      .catch((error: unknown) => record('adapter', `manual:${command}:error`, describeError(error).message));
  });
}
