/**
 * The React test dApp (spec section 4): the published `@miden-sdk/miden-wallet-adapter-react` providers over the
 * adapter the plain page drives, with React 18.2 loaded from its UMD build through the shims test-dapp-server.ts
 * generates. `WalletProvider` and `MidenFiSignerProvider` (over `MidenProvider`) render side by side, each with its
 * own adapter and storage key; a probe under each records every context value it commits, and a command calls the
 * context the probe committed last, never a closure from an earlier render.
 *
 * Written with `createElement`: the server transpiles `.ts` with no JSX option and refuses a module that does not
 * parse (test-dapp-server.ts).
 */
import { createElement as h, useContext, useEffect } from 'react';

import { Felt, SigningInputs, Word } from '@miden-sdk/miden-sdk';
import {
  PrivateDataPermission,
  SendTransaction,
  u8ToB64,
  WalletAdapterNetwork,
  type WalletError
} from '@miden-sdk/miden-wallet-adapter-base';
import { MidenWalletAdapter } from '@miden-sdk/miden-wallet-adapter-miden';
import {
  MidenFiSignerProvider,
  useMidenFiWallet,
  useWallet,
  WalletContext,
  WalletProvider,
  type MidenFiWalletContextState
} from '@miden-sdk/miden-wallet-adapter-react';
import { MidenProvider, useMiden, useSigner, type SignerContextValue } from '@miden-sdk/react';
import { createRoot } from 'react-dom/client';

import { canonical, describeError, fromNode, HarnessCheckError, outcome, outputNoteView } from './page-common.js';
import type {
  ReactCommandName,
  ReactDappWindowApi,
  ReactEvent,
  ReactHandlers,
  ReactInput,
  ReactOutput,
  ReactSnapshot,
  ReactTree
} from './react-protocol';

type WalletState = ReturnType<typeof useWallet>;
type MidenState = ReturnType<typeof useMiden>;

// The run's network and node come in the URL, so every provider prop is fixed for the life of the page.
const params = new URLSearchParams(window.location.search);
const NETWORK = params.get('network') === 'devnet' ? WalletAdapterNetwork.Devnet : WalletAdapterNetwork.Testnet;
const AUTO_CONNECT = params.get('autoConnect') === '1';
// One object for the page's life: MidenProvider starts its client again whenever its config changes identity.
const MIDEN_CONFIG = {
  rpcUrl: params.get('rpcUrl') ?? 'testnet',
  feeFaucetId: params.get('feeFaucetId') ?? undefined,
  autoSyncInterval: 0,
  useWorker: false
};
// Both providers default to `walletName`; shared, MidenFi's auto-select would select WalletProvider's wallet too.
const STORAGE_KEYS: Record<ReactTree, string> = { wallet: 'react-dapp-wallet', midenfi: 'react-dapp-midenfi' };
// At module scope, once: a provider whose adapter changes runs its cleanup `disconnect()`, which removes the wallet
// session (WalletProvider.tsx:203-207, src/lib/miden/back/dapp.ts:289-304) and would read as a wallet bug.
// StrictMode's remount runs the same cleanup, so the root renders without it.
const ADAPTERS: Record<ReactTree, MidenWalletAdapter> = {
  wallet: new MidenWalletAdapter({ appName: 'react-dapp' }),
  midenfi: new MidenWalletAdapter({ appName: 'react-dapp' })
};
const WALLETS: Record<ReactTree, MidenWalletAdapter[]> = { wallet: [ADAPTERS.wallet], midenfi: [ADAPTERS.midenfi] };
const REQUEST_FUNCTIONS = [
  'requestTransaction',
  'requestAssets',
  'requestGuardianInfo',
  'requestPrivateNotes',
  'signBytes',
  'importPrivateNote',
  'requestConsumableNotes',
  'waitForTransaction',
  'requestSend',
  'requestConsume',
  'createAccount'
];

const snapshots: ReactSnapshot[] = [];
const events: ReactEvent[] = [];
const pageErrors: string[] = [];
const latest: {
  wallet?: WalletState;
  midenfi?: MidenFiWalletContextState;
  signer?: SignerContextValue | null;
  miden?: MidenState;
} = {};

function record(entry: Omit<ReactEvent, 'at'>): void {
  events.push({ at: Date.now(), ...entry });
  const log = document.getElementById('log');
  if (log) log.textContent += `${entry.tree} ${entry.source} ${entry.event} ${entry.address ?? ''}\n`;
}

// A provider that throws out of an effect or a handler shows here, never as a silent stop (WP4: "never throws").
window.addEventListener('error', event => pageErrors.push(`error: ${event.message}`));
window.addEventListener('unhandledrejection', event => {
  const { name, message } = describeError(event.reason);
  pageErrors.push(`unhandledrejection: ${name}: ${message}`);
});

for (const tree of ['wallet', 'midenfi'] as const) {
  const adapter = ADAPTERS[tree];
  adapter.on('connect', address => record({ tree, source: 'adapter', event: 'connect', address }));
  adapter.on('disconnect', () => record({ tree, source: 'adapter', event: 'disconnect', address: null }));
  adapter.on('error', error =>
    record({
      tree,
      source: 'adapter',
      event: `error:${describeError(error).name}`,
      address: null,
      error: describeError(error)
    })
  );
  adapter.on('readyStateChange', readyState =>
    record({ tree, source: 'adapter', event: `readyState:${readyState}`, address: null })
  );
}
// One identity for the page's life: the providers re-subscribe their adapter listeners when `onError` changes.
const ON_ERROR: Record<ReactTree, (error: WalletError) => void> = {
  wallet: error =>
    record({
      tree: 'wallet',
      source: 'onError',
      event: describeError(error).name,
      address: null,
      error: describeError(error)
    }),
  midenfi: error =>
    record({
      tree: 'midenfi',
      source: 'onError',
      event: describeError(error).name,
      address: null,
      error: describeError(error)
    })
};

// The adapter copies the wallet's key as given (adapter-miden adapter.js:312), so one that is not a Word is the
// wallet's verdict: it is recorded in the snapshot, never thrown out of the probe.
function keyHex(publicKey: Uint8Array | null): Pick<ReactSnapshot, 'publicKeyHex' | 'publicKeyError'> {
  if (publicKey === null) return { publicKeyHex: null };
  try {
    return { publicKeyHex: Word.deserialize(publicKey).toHex() };
  } catch (error) {
    const { name, message } = describeError(error);
    return { publicKeyHex: null, publicKeyError: `${name}: ${message}` };
  }
}

function snapshotOf(tree: ReactTree, ctx: WalletState | MidenFiWalletContextState): ReactSnapshot {
  return {
    at: Date.now(),
    tree,
    autoConnect: ctx.autoConnect,
    connected: ctx.connected,
    connecting: ctx.connecting,
    disconnecting: ctx.disconnecting,
    address: ctx.address,
    ...keyHex(ctx.publicKey),
    selected: ctx.wallet?.adapter.name ?? null,
    readyStates: ctx.wallets.map(wallet => String(wallet.readyState)),
    requestFunctions: REQUEST_FUNCTIONS.filter(name => typeof Reflect.get(ctx, name) === 'function')
  };
}

// An effect that throws unmounts the whole root, and both providers' cleanup `disconnect()` then removes the wallet
// session (WalletProvider.tsx:203-207): a probe's own fault becomes a page error and the trees stay up.
function commitProbe(tree: ReactTree, commit: () => void): void {
  try {
    commit();
  } catch (error) {
    const { name, message } = describeError(error);
    pageErrors.push(`probe ${tree}: ${name}: ${message}`);
  }
}

function WalletProbe(): null {
  const ctx = useWallet();
  // The package entry exports MidenFi's own context under this name (index.ts:7-16), not the one WalletProvider fills.
  const exported = useContext(WalletContext);
  useEffect(() =>
    commitProbe('wallet', () => {
      latest.wallet = ctx;
      const connected: unknown = Reflect.get(exported, 'connected');
      const address: unknown = Reflect.get(exported, 'address');
      snapshots.push({
        ...snapshotOf('wallet', ctx),
        exported: {
          connected: typeof connected === 'boolean' ? connected : null,
          address: typeof address === 'string' ? address : null
        }
      });
    })
  );
  return null;
}

function MidenFiProbe(): null {
  const ctx = useMidenFiWallet();
  const signer = useSigner();
  const miden = useMiden();
  useEffect(() =>
    commitProbe('midenfi', () => {
      latest.midenfi = ctx;
      latest.signer = signer;
      latest.miden = miden;
      snapshots.push({
        ...snapshotOf('midenfi', ctx),
        ...(signer === null
          ? {}
          : {
              signer: {
                isConnected: signer.isConnected,
                storeName: signer.storeName,
                importAccountId: signer.isConnected ? (signer.accountConfig.importAccountId ?? null) : null
              }
            }),
        miden: {
          isReady: miden.isReady,
          isInitializing: miden.isInitializing,
          error: miden.error === null ? null : `${miden.error.name}: ${miden.error.message}`,
          signerAccountId: miden.signerAccountId
        }
      });
    })
  );
  return null;
}

const App = () =>
  h(
    'div',
    null,
    h(WalletProvider, {
      wallets: WALLETS.wallet,
      network: NETWORK,
      autoConnect: AUTO_CONNECT,
      onError: ON_ERROR.wallet,
      localStorageKey: STORAGE_KEYS.wallet,
      children: h(WalletProbe)
    }),
    h(MidenFiSignerProvider, {
      wallets: WALLETS.midenfi,
      network: NETWORK,
      onError: ON_ERROR.midenfi,
      localStorageKey: STORAGE_KEYS.midenfi,
      children: h(MidenProvider, { config: MIDEN_CONFIG, children: h(MidenFiProbe) })
    })
  );

const requireWallet = (): WalletState => {
  if (latest.wallet === undefined) throw new HarnessCheckError('the WalletProvider probe has not committed');
  return latest.wallet;
};
const requireMidenFi = (): MidenFiWalletContextState => {
  if (latest.midenfi === undefined) throw new HarnessCheckError('the MidenFi probe has not committed');
  return latest.midenfi;
};
const contextOf = (tree: ReactTree): WalletState | MidenFiWalletContextState =>
  tree === 'wallet' ? requireWallet() : requireMidenFi();

function providerAddress(): string | null {
  const injected: unknown = Reflect.get(window, 'midenWallet');
  const address: unknown = typeof injected === 'object' && injected !== null ? Reflect.get(injected, 'address') : null;
  return typeof address === 'string' ? address : null;
}

// useLocalStorage keeps the name JSON-encoded (useLocalStorage.ts:8-39).
function storedName(tree: ReactTree): string | null {
  const raw = localStorage.getItem(STORAGE_KEYS[tree]);
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'string' ? value : raw;
  } catch {
    return raw;
  }
}

const handlers: ReactHandlers = {
  view: async () => ({
    now: Date.now(),
    adapterName: ADAPTERS.wallet.name,
    snapshots: [...snapshots],
    events: [...events],
    providerAddress: providerAddress(),
    storedNames: { wallet: storedName('wallet'), midenfi: storedName('midenfi') },
    pageErrors: [...pageErrors]
  }),

  select: async ({ tree }) => {
    contextOf(tree).select(ADAPTERS[tree].name);
    return { selected: ADAPTERS[tree].name };
  },

  // WalletProvider's connect ignores its arguments and takes the provider's props (WalletProvider.tsx:244-293); they
  // are passed only because the context type declares them.
  connect: ({ tree }) =>
    outcome(async () => {
      if (tree === 'wallet') await requireWallet().connect(PrivateDataPermission.UponRequest, NETWORK);
      else await requireMidenFi().connect();
      return null;
    }),

  disconnect: ({ tree }) =>
    outcome(async () => {
      await contextOf(tree).disconnect();
      return null;
    }),

  // A context with no adapter selected offers no requestSend at all: calling it then is the driver's mistake.
  send: input =>
    outcome(async () => {
      const ctx = requireWallet();
      const requestSend = ctx.requestSend;
      if (requestSend === undefined)
        throw new HarnessCheckError('WalletProvider offers no requestSend: nothing selected');
      const sender = canonical(ctx.address ?? '');
      const tx = new SendTransaction(
        sender,
        input.recipientAddress,
        input.faucetId,
        input.noteType,
        Number(input.amount)
      );
      return { txId: await requestSend(tx) };
    }),

  waitForTransaction: ({ txId }) =>
    outcome(async () => {
      const wait = requireWallet().waitForTransaction;
      if (wait === undefined)
        throw new HarnessCheckError('WalletProvider offers no waitForTransaction: nothing selected');
      const result = await wait(txId);
      return { txHash: result.txHash, outputNotes: result.outputNotes.map(outputNoteView) };
    }),

  createAccount: () =>
    outcome(async () => {
      const create = requireMidenFi().createAccount;
      if (create === undefined) throw new HarnessCheckError('MidenFiSignerProvider offers no createAccount');
      return create();
    }),

  // MidenProvider's sign callback: it signs the serialized SigningInputs (MidenFiSignerProvider.tsx:686-692).
  signerSign: async ({ felts }) => {
    const signer = latest.signer;
    if (!signer?.isConnected) throw new HarnessCheckError('the MidenFi signer context is not connected');
    return outcome(async () => {
      const inputs = SigningInputs.newArbitrary(felts.map(felt => new Felt(BigInt(felt))));
      const payload = inputs.serialize();
      const message = inputs.toCommitment().serialize();
      const signature = await signer.signCb(signer.accountConfig.publicKeyCommitment, payload);
      return {
        signatureB64: u8ToB64(signature),
        schemeTag: signature[0] ?? -1,
        payloadB64: u8ToB64(payload),
        messageB64: u8ToB64(message)
      };
    });
  },

  signerSync: async () => {
    const miden = latest.miden;
    const client = miden?.client;
    if (miden === undefined || !miden.isReady || client === undefined || client === null) {
      throw new HarnessCheckError('MidenProvider has no ready client');
    }
    const height = await miden.runExclusive(() =>
      fromNode('syncState', async () => (await client.syncState()).blockNum())
    );
    return { height };
  }
};

async function call<K extends ReactCommandName>(command: K, input: ReactInput<K>): Promise<ReactOutput<K>> {
  return handlers[command](input);
}

const root = document.getElementById('root');
if (root === null) throw new HarnessCheckError('react-dapp.html has no #root');
createRoot(root).render(h(App));

// Published once every handler exists, so a driver that waits for `ready` never calls a half-loaded page.
const api: ReactDappWindowApi = { ready: true, call };
Reflect.set(window, 'testDapp', api);
