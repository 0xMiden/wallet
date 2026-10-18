/**
 * The command surface of the React test dApp's `window.testDapp` (spec section 4), imported type-only by the page and
 * the driver. The contract is protocol.ts's: results are JSON, wallet and adapter errors come back as `Outcome` data,
 * and the page's own fault and the node's failure throw under their own names.
 */
import type { DappError, NoteTypeName, Outcome, OutputNoteView, SignatureView } from './protocol';

/** `wallet` is the WalletProvider tree, `midenfi` the MidenFiSignerProvider tree; each has its own adapter. */
export type ReactTree = 'wallet' | 'midenfi';
type Empty = Record<string, never>;

/** One commit of a probe: the values its provider's context held, stamped when React committed them. */
export interface ReactSnapshot {
  at: number;
  tree: ReactTree;
  autoConnect: boolean;
  connected: boolean;
  connecting: boolean;
  disconnecting: boolean;
  address: string | null;
  publicKeyHex: string | null;
  /** Why the context's key is not a Word, which leaves `publicKeyHex` null: the wallet's verdict, kept as data. */
  publicKeyError?: string;
  /** The selected wallet's adapter name; null while none is selected. */
  selected: string | null;
  readyStates: string[];
  /** The request functions the context offers; none while no adapter is selected. */
  requestFunctions: string[];
  /** WalletProvider tree: what `useContext(WalletContext)` from the package entry reads there (WP9). */
  exported?: { connected: boolean | null; address: string | null };
  /** MidenFi tree: the signer context MidenFiSignerProvider hands MidenProvider. */
  signer?: { isConnected: boolean; storeName: string; importAccountId: string | null };
  /** MidenFi tree: MidenProvider's own state. */
  miden?: { isReady: boolean; isInitializing: boolean; error: string | null; signerAccountId: string | null };
}

export interface ReactEvent {
  at: number;
  tree: ReactTree;
  /** `adapter` is an event of the tree's adapter; `onError` a call of the provider's `onError` prop. */
  source: 'adapter' | 'onError';
  event: string;
  address: string | null;
  error?: DappError;
}

export interface ReactPageView {
  /** The page's clock when it answered, so the driver can tell how long a snapshot has stood. */
  now: number;
  /** The one wallet both trees list, which MidenFi selects on its own (MF1). */
  adapterName: string;
  /** Every probe commit since the page loaded, oldest first. */
  snapshots: ReactSnapshot[];
  events: ReactEvent[];
  /** What `window.midenWallet` holds: K1 compares it with the React context. */
  providerAddress: string | null;
  storedNames: Record<ReactTree, string | null>;
  /** Uncaught errors, unhandled rejections and a probe's own throws since the page loaded. */
  pageErrors: string[];
}

export interface ReactDappCommands {
  view: { input: Empty; output: ReactPageView };
  select: { input: { tree: ReactTree }; output: { selected: string } };
  connect: { input: { tree: ReactTree }; output: Outcome<null> };
  disconnect: { input: { tree: ReactTree }; output: Outcome<null> };
  /** `useWallet().requestSend`, sent as the context's own address. */
  send: {
    input: { recipientAddress: string; faucetId: string; amount: string; noteType: NoteTypeName };
    output: Outcome<{ txId: string }>;
  };
  waitForTransaction: { input: { txId: string }; output: Outcome<{ txHash: string; outputNotes: OutputNoteView[] }> };
  createAccount: { input: Empty; output: Outcome<string> };
  /** The signer context's `signCb` over `SigningInputs.newArbitrary(felts)`, as MidenProvider calls it. */
  signerSign: { input: { felts: string[] }; output: Outcome<SignatureView> };
  /** One sync of MidenProvider's own client under its lock: the height it reached. */
  signerSync: { input: Empty; output: { height: number } };
}

export type ReactCommandName = keyof ReactDappCommands;
export type ReactInput<K extends ReactCommandName> = ReactDappCommands[K]['input'];
export type ReactOutput<K extends ReactCommandName> = ReactDappCommands[K]['output'];
export type ReactHandlers = { [K in ReactCommandName]: (input: ReactInput<K>) => Promise<ReactOutput<K>> };

export interface ReactDappWindowApi {
  readonly ready: true;
  call<K extends ReactCommandName>(command: K, input: ReactInput<K>): Promise<ReactOutput<K>>;
}
